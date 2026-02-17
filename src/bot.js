const { ethers } = require('ethers');
const fs = require('fs/promises');
const path = require('path');
const config = require('./config');
const { wallet } = require('./wallet');
const { log, sleep, withErrorHandling } = require('./utils');
const { getFlashLoanableAssets } = require('./aaveService');
const { fetchAllPairs } = require('./dexScreenerService');
const { generateAndCachePaths } = require('./pathGenerator');
const { scanAllPaths, DEX_GENERIC, DEX_UNISWAP_V3, DEX_AERODROME, DEX_PANCAKESWAP_V3 } = require('./opportunityScanner');
const { sendPrivateTransaction } = require('./mevProtection');

const SCAN_INTERVAL = config.scanIntervalMs || 4000;
let scanCount = 0;
let isRunning = false;

// New contract ABI with typed SwapStep struct
const CONTRACT_ABI = [
    'function executeArb(address asset, uint256 amount, tuple(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 fee, bool stable, address factory, uint256 amountOutMin, bytes data)[] steps)',
    'function setRouterWhitelist(address router, bool status)',
    'function setRouterWhitelistBatch(address[] routers, bool status)',
    'function whitelistedRouters(address) view returns (bool)',
    'function withdraw(address token)',
    'function pause()',
    'function unpause()',
    'function owner() view returns (address)',
    'event ArbExecuted(address indexed asset, uint256 amount, uint256 profit)',
    'event SwapExecuted(uint256 indexed stepIndex, uint8 dexType, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
];

/**
 * Handles a profitable opportunity by executing the multi-hop arb via the contract.
 */
async function handleOpportunity(opportunity) {
    log(`=== EXECUTING OPPORTUNITY ===`);
    log(`Path: ${opportunity.pathDescription || 'multi-hop'}`);
    log(`Steps: ${opportunity.swapSteps.length} hops across multiple DEXes`);
    log(`Estimated profit: ${ethers.formatUnits(opportunity.netProfit, 18)} ETH`);

    const { asset, swapSteps, initialAmount } = opportunity;

    if (!asset || !swapSteps || !initialAmount) {
        log('Invalid opportunity data.');
        return null;
    }

    const contractAddress = config.contractAddress[config.network];
    if (!contractAddress) {
        log('ERROR: Contract address not set. Cannot execute trade.');
        return null;
    }

    try {
        const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, wallet);

        // Build the transaction
        const tx = await contract.executeArb.populateTransaction(
            asset,
            initialAmount,
            swapSteps
        );

        // Estimate gas with safety buffer
        try {
            const gasEstimate = await wallet.provider.estimateGas({
                ...tx,
                from: wallet.address,
            });
            tx.gasLimit = (gasEstimate * 130n) / 100n;
        } catch (gasError) {
            log(`Gas estimation failed: ${gasError.message}. Using safe default.`);
            tx.gasLimit = 800000n; // Higher default for multi-hop
        }

        log(`Sending ${swapSteps.length}-hop arb transaction...`);
        const txResponse = await sendPrivateTransaction(tx);

        if (txResponse) {
            log(`TX Hash: ${txResponse.hash}`);
            log('Waiting for confirmation...');

            const receipt = await txResponse.wait(1);
            if (receipt && receipt.status === 1) {
                log(`CONFIRMED in block ${receipt.blockNumber}!`);
                log(`Gas used: ${receipt.gasUsed.toString()}`);

                // Parse events for detailed execution info
                const iface = new ethers.Interface(CONTRACT_ABI);
                for (const eventLog of receipt.logs) {
                    try {
                        const parsed = iface.parseLog(eventLog);
                        if (parsed.name === 'SwapExecuted') {
                            log(`  Step ${parsed.args.stepIndex}: ${parsed.args.tokenIn.slice(0, 10)}... -> ${parsed.args.tokenOut.slice(0, 10)}... | In: ${parsed.args.amountIn} Out: ${parsed.args.amountOut}`);
                        }
                        if (parsed.name === 'ArbExecuted') {
                            log(`  Profit: ${ethers.formatUnits(parsed.args.profit, 18)} ETH`);
                        }
                    } catch (e) { /* not our event */ }
                }

                return {
                    success: true,
                    txHash: txResponse.hash,
                    blockNumber: receipt.blockNumber,
                    gasUsed: receipt.gasUsed.toString(),
                };
            } else {
                log('Transaction REVERTED on-chain.');
                return { success: false, txHash: txResponse.hash, reason: 'reverted' };
            }
        }
    } catch (error) {
        log(`Execution error: ${error.message}`);
        return { success: false, reason: error.message };
    }

    return null;
}

/**
 * The main scanning loop.
 */
async function startScanning(paths, tokenDatabase) {
    log(`Starting scanner with ${paths.length} paths...`);
    isRunning = true;

    while (isRunning) {
        scanCount++;
        log(`--- Scan #${scanCount} ---`);

        try {
            const opportunities = await scanAllPaths(paths, tokenDatabase);

            if (opportunities && opportunities.length > 0) {
                opportunities.sort((a, b) => {
                    const profitA = BigInt(a.netProfit?.toString() || '0');
                    const profitB = BigInt(b.netProfit?.toString() || '0');
                    return profitB > profitA ? 1 : profitB < profitA ? -1 : 0;
                });

                log(`Found ${opportunities.length} profitable opportunities. Best: ${opportunities[0].pathDescription}`);
                const result = await handleOpportunity(opportunities[0]);
                if (result?.success) {
                    log(`Trade successful! TX: ${result.txHash}`);
                }
            } else {
                log('No profitable opportunities found this scan.');
            }
        } catch (error) {
            log(`Scan error: ${error.message}`);
        }

        await sleep(SCAN_INTERVAL);
    }
}

/**
 * The main entry point for the bot.
 */
async function main() {
    log('==========================================');
    log('  BaseAlphaBot - AAVE V3 Flash Loan Arb');
    log('  Network: Base Mainnet (Chain ID: 8453)');
    log('  Contract: Typed Multi-DEX SwapSteps');
    log('==========================================');

    if (!config.auth.privateKey || config.auth.privateKey === 'YOUR_WALLET_PRIVATE_KEY_HERE') {
        log('WARNING: No private key configured. Running in SCAN-ONLY mode.');
        log('Set PRIVATE_KEY in .env to enable trade execution.');
    } else {
        log(`Wallet: ${wallet.address}`);
        try {
            const balance = await wallet.provider.getBalance(wallet.address);
            log(`Balance: ${ethers.formatEther(balance)} ETH`);
        } catch (e) {
            log('Could not fetch wallet balance.');
        }
    }

    // Fetch flash loanable assets from Aave V3
    log('Fetching Aave V3 flash loanable assets...');
    config.hubAssets = await getFlashLoanableAssets();
    if (!config.hubAssets || config.hubAssets.length === 0) {
        log('WARNING: No flash loanable assets found. Using common tokens as fallback.');
        config.hubAssets = Object.values(config.commonTokens || {});
    }
    log(`Hub assets: ${config.hubAssets.length}`);

    // Build token database
    const tokenDbPath = path.join(__dirname, '../config/tokenDatabase.json');
    let tokenDatabase;
    try {
        const dbData = await fs.readFile(tokenDbPath, 'utf-8');
        tokenDatabase = JSON.parse(dbData);
        log(`Token database loaded: ${Object.keys(tokenDatabase).length} tokens`);
    } catch (error) {
        log('Building token database from DexScreener...');
        const dexIds = ['aerodrome', 'uniswap', 'pancakeswap'];
        tokenDatabase = await fetchAllPairs(dexIds);
        if (tokenDatabase && Object.keys(tokenDatabase).length > 0) {
            await fs.writeFile(tokenDbPath, JSON.stringify(tokenDatabase, null, 2));
            log(`Token database saved: ${Object.keys(tokenDatabase).length} tokens`);
        } else {
            log('ERROR: Failed to build token database.');
            return;
        }
    }

    // Generate arbitrage paths
    const pathsPath = path.join(__dirname, '../config/paths.json');
    let needsUpdate = true;
    try {
        const stats = await fs.stat(pathsPath);
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        if (stats.mtime.getTime() > oneDayAgo) needsUpdate = false;
    } catch (error) { /* File doesn't exist */ }

    if (needsUpdate) {
        log('Generating arbitrage paths...');
        await generateAndCachePaths(config, tokenDatabase);
    }

    let paths;
    try {
        const pathsData = await fs.readFile(pathsPath, 'utf-8');
        paths = JSON.parse(pathsData);
    } catch (error) {
        log('ERROR: Could not load arbitrage paths.');
        return;
    }

    log(`Loaded ${paths.length} arbitrage paths.`);

    if (!config.contractAddress[config.network]) {
        log('WARNING: Contract not deployed. Deploy with: npx hardhat run scripts/deploy.js --network base');
    }

    // Graceful shutdown
    const shutdown = () => {
        log('Shutting down gracefully...');
        isRunning = false;
        process.exit();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await startScanning(paths, tokenDatabase);
    } catch (error) {
        log(`Fatal error: ${error.message}`);
        log('Restarting in 10 seconds...');
        await sleep(10000);
        main();
    }
}

main();
