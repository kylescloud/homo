const { ethers } = require('ethers');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const provider = require('./provider');
const { wallet } = require('./wallet');
const { waitForFlashblockConfirmation, isFlashblocksEnabled } = require('./provider');

/**
 * MEV Protection for Base Chain with Flashblocks Support
 *
 * Base uses a centralized sequencer with NO public mempool:
 * - No front-running from public mempool searchers
 * - Standard transaction submission is sufficient
 *
 * With Flashblocks (200ms sub-blocks):
 * - Transactions get preconfirmed in ~200ms instead of ~2s
 * - Faster feedback loop = faster re-entry for next opportunity
 * - Poll aggressively for confirmation
 */

let nonce = null;

async function getNextNonce() {
    if (nonce === null) {
        nonce = await wallet.getNonce();
    }
    return nonce++;
}

async function resetNonce() {
    nonce = await wallet.getNonce();
}

/**
 * Sends a transaction on Base chain with Flashblocks-aware confirmation.
 */
const sendPrivateTransaction = async (tx) => {
    const fbStatus = isFlashblocksEnabled() ? 'Flashblocks (200ms)' : 'Standard (2s)';
    log(`Preparing transaction [${fbStatus}]...`);

    try {
        // Get current fee data
        const feeData = await provider.getFeeData();

        // Check gas price against configured maximum
        const maxGasGwei = config.maxGasPriceGwei || 0.1;
        const maxGasWei = ethers.parseUnits(maxGasGwei.toString(), 'gwei');
        const currentGas = feeData.maxFeePerGas || feeData.gasPrice;

        if (currentGas > maxGasWei) {
            log(`Gas price ${ethers.formatUnits(currentGas, 'gwei')} gwei exceeds max ${maxGasGwei} gwei. Skipping.`);
            return null;
        }

        // EIP-1559 gas parameters
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        tx.nonce = await getNextNonce();
        tx.chainId = 8453;
        tx.type = 2;

        // Gas limit with buffer
        if (!tx.gasLimit) {
            const gasEstimate = await provider.estimateGas(tx);
            tx.gasLimit = (gasEstimate * 130n) / 100n;
        }

        log(`Sending TX (nonce: ${tx.nonce}, gas: ${ethers.formatUnits(tx.maxFeePerGas, 'gwei')} gwei)`);
        const txResponse = await wallet.sendTransaction(tx);
        log(`TX broadcast: ${txResponse.hash}`);

        return txResponse;
    } catch (error) {
        log(`Transaction failed: ${error.message}`);
        await resetNonce();
        return null;
    }
};

/**
 * Sends a transaction and waits for Flashblocks preconfirmation (~200ms).
 * Falls back to standard confirmation if Flashblocks isn't enabled.
 */
const sendAndConfirm = async (tx) => {
    const txResponse = await sendPrivateTransaction(tx);
    if (!txResponse) return null;

    try {
        // Use Flashblocks-aware confirmation (200ms vs 2s)
        const receipt = await waitForFlashblockConfirmation(txResponse.hash, 10000);

        if (receipt && receipt.status === 1) {
            log(`CONFIRMED in block ${receipt.blockNumber} [${isFlashblocksEnabled() ? '~200ms flashblock' : 'standard'}]`);
            return { ...receipt, txHash: txResponse.hash };
        } else if (receipt) {
            log('Transaction REVERTED on-chain.');
            return null;
        }
    } catch (error) {
        log(`Confirmation error: ${error.message}`);
    }

    return null;
};

module.exports = {
    sendPrivateTransaction: withErrorHandling(sendPrivateTransaction),
    sendAndConfirm: withErrorHandling(sendAndConfirm),
    resetNonce,
};
