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
const { sendAndConfirm } = require('./mevProtection');
const provider = require('./provider');
const { initFlashblocks, onFlashblock, getEffectiveScanInterval, isFlashblocksEnabled } = require('./provider');

let scanCount = 0;
let isRunning = false;

// Contract ABI with typed SwapStep struct
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

        const tx = await contract.executeArb.populateTransaction(
            asset,
            initialAmount,
            swapSteps
        );

        // Estimate gas
        try {
            const gasEstimate = await wallet.provider.estimateGas({
                ...tx,
                from: wallet.address,
            });
            tx.gasLimit = (gasEstimate * 130n) / 100n;
        } catch (gasError) {
            log(`Gas estimation failed: ${gasError.message}. Using safe default.`);
            tx.gasLimit = 800000n;
        }

        log(`Sending ${swapSteps.length}-hop arb transaction...`);

        // Use Flashblocks-aware send + confirm (200ms preconfirmation)
        const receipt = await sendAndConfirm(tx);

        if (receipt) {
            log(`TX Hash: ${receipt.txHash || receipt.hash}`);
            log(`Gas used: ${receipt.gasUsed?.toString() || 'unknown'}`);

            // Parse events
            const iface = new ethers.Interface(CONTRACT_ABI);
            for (const eventLog of (receipt.logs || [])) {
                try {
                    const parsed = iface.parseLog(eventLog);
                    if (parsed.name === 'SwapExecuted') {
                        log(`  Step ${parsed.args.stepIndex}: In: ${parsed.args.amountIn} Out: ${parsed.args.amountOut}`);
                    }
                    if (parsed.name === 'ArbExecuted') {
                        log(`  Profit: ${ethers.formatUnits(parsed.args.profit, 18)} ETH`);
                    }
                } catch (e) { /* not our event */ }
            }

            return { success: true, txHash: receipt.txHash || receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed?.toString() };
        } else {
            return { success: false, reason: 'confirmation failed' };
        }
    } catch (error) {
        log(`Execution error: ${error.message}`);
        return { success: false, reason: error.message };
    }
}

/**
 * Main scanning loop with Flashblocks support.
 * With Flashblocks: scans every ~200ms on each sub-block
 * Without Flashblocks: scans at configured interval (default 4s)
 */
async function startScanning(paths, tokenDatabase) {
    const scanInterval = getEffectiveScanInterval();
    const mode = isFlashblocksEnabled() ? 'FLASHBLOCKS (200ms)' : `STANDARD (${scanInterval}ms)`;
    log(`Starting scanner | Mode: ${mode} | Paths: ${paths.length}`);
    isRunning = true;

    if (isFlashblocksEnabled()) {
        // Event-driven scanning on each flashblock (200ms sub-blocks)
        log('[FLASHBLOCKS] Using event-driven scanning on each sub-block...');
        let scanning = false;

        onFlashblock(async (flashblock) => {
            if (!isRunning || scanning) return;
            scanning = true;

            scanCount++;
            try {
                if (scanCount % 50 === 0) { // Log every 50th scan (every 10s)
                    log(`--- Flashblock Scan #${scanCount} ---`);
                }

                const opportunities = await scanAllPaths(paths, tokenDatabase);
                if (opportunities && opportunities.length > 0) {
                    opportunities.sort((a, b) => {
                        const profitA = BigInt(a.netProfit?.toString() || '0');
                        const profitB = BigInt(b.netProfit?.toString() || '0');
                        return profitB > profitA ? 1 : profitB < profitA ? -1 : 0;
                    });

                    log(`FOUND ${opportunities.length} profitable opportunities!`);
                    const result = await handleOpportunity(opportunities[0]);
                    if (result?.success) {
                        log(`Trade successful! TX: ${result.txHash}`);
                    }
                }
            } catch (error) {
                log(`Flashblock scan error: ${error.message}`);
            }
            scanning = false;
        });

        // Keep the process alive
        while (isRunning) {
            await sleep(1000);
        }
    } else {
        // Standard polling-based scanning
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

            await sleep(scanInterval);
        }
    }
}

/**
 * Main entry point.
 */
async function main() {
    log('==========================================');
    log('  BaseAlphaBot - AAVE V3 Flash Loan Arb');
    log('  Network: Base Mainnet (Chain ID: 8453)');
    log('  Contract: Typed Multi-DEX SwapSteps');
    log('==========================================');

    // Wallet check
    if (!config.auth.privateKey || config.auth.privateKey === 'YOUR_WALLET_PRIVATE_KEY_HERE') {
        log('WARNING: No private key configured. Running in SCAN-ONLY mode.');
    } else {
        log(`Wallet: ${wallet.address}`);
        try {
            const balance = await wallet.provider.getBalance(wallet.address);
            log(`Balance: ${ethers.formatEther(balance)} ETH`);
        } catch (e) {
            log('Could not fetch wallet balance.');
        }
    }

    // Initialize Flashblocks (optional, uses FLASHBLOCKS_WS_URL from .env)
    log('Initializing Flashblocks...');
    const fbEnabled = await initFlashblocks();
    if (fbEnabled) {
        log('Flashblocks ACTIVE - 200ms preconfirmations enabled');
        log('Bot will scan on every sub-block for maximum speed');
    } else {
        log('Flashblocks not configured - using standard 2-second block times');
        log('Tip: Set FLASHBLOCKS_WS_URL in .env for 10x faster execution');
    }

    // Fetch flash loanable assets
    log('Fetching Aave V3 flash loanable assets...');
    config.hubAssets = await getFlashLoanableAssets();
    if (!config.hubAssets || config.hubAssets.length === 0) {
        log('WARNING: Using common tokens as fallback.');
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
        log('WARNING: Contract not deployed. Run: npx hardhat run scripts/deploy.js --network base');
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
