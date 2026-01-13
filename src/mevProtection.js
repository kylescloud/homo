const { ethers } = require('ethers');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const { loadBalancer } = require('./provider');
const { wallet } = require('./wallet');

const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');

let flashbotsProvider;

// Initialize Flashbots provider
(async () => {
    const provider = loadBalancer.getNextProvider();
    flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        new ethers.Wallet(config.auth.privateKey), // Flashbots wallet for signing bundles
        config.mevProtection.flashbots
    );
})();

/**
 * Sends a private transaction using a specified MEV protection service.
 * @param {ethers.TransactionRequest} tx The transaction to send.
 * @param {'flashbots' | 'mevShare' | 'bloXroute'} service The MEV protection service to use.
 * @returns {Promise<ethers.TransactionResponse>} The transaction response.
 */
const sendPrivateTransaction = async (tx) => {
    log('Sending private transaction via Flashbots...');
    try {
        const signedTx = await wallet.signTransaction(tx);
        const bundle = [{ signedTransaction: signedTx }];
        const blockNumber = await provider.getBlockNumber();
        const simulation = await flashbotsProvider.simulate(bundle, blockNumber);

        if ('error' in simulation) {
            throw new Error(`Flashbots simulation error: ${simulation.error.message}`);
        }

        const flashbotsResponse = await flashbotsProvider.sendRawBundle(
            bundle,
            blockNumber + 1
        );

        if ('error' in flashbotsResponse) {
            throw new Error(`Flashbots submission error: ${flashbotsResponse.error.message}`);
        }

        return flashbotsResponse.bundleTransactions[0].response;
    } catch (error) {
        log(`Flashbots transaction failed: ${error.message}`);
        log('Falling back to standard broadcast...');
        return await wallet.sendTransaction(tx);
    }
};

module.exports = {
    sendPrivateTransaction: withErrorHandling(sendPrivateTransaction),
};
