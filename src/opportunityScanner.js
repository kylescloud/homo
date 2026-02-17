const { ethers } = require('ethers');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const aggregatorService = require('./aggregatorService');
const dexService = require('./dexService');
const { calculateNetProfit, isProfitable, simulateTransaction, estimateGasCost } = require('./profitCalculator');
const provider = require('./provider');

// DEX type constants matching the smart contract
const DEX_GENERIC = 0;
const DEX_UNISWAP_V3 = 1;
const DEX_AERODROME = 2;
const DEX_PANCAKESWAP_V3 = 3;

const AERODROME_ROUTER = config.dexAddresses?.aerodrome?.router || '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERODROME_FACTORY = config.dexAddresses?.aerodrome?.defaultFactory || '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const UNISWAP_V3_ROUTER = config.dexAddresses?.uniswapV3?.swapRouter02 || '0x2626664c2603336E57B271c5C0b26F421741e481';

/**
 * Gets the best quote for a single hop from all available DEXs and aggregators.
 * Returns both the quote and the metadata needed to build a typed SwapStep.
 */
async function getBestHopQuote(fromToken, toToken, amountIn, preferredDex) {
    const quotes = [];

    // Always try direct DEX quotes for speed
    if (!preferredDex || preferredDex === 'uniswap') {
        const uniQuote = await dexService.getUniswapQuote(fromToken, toToken, amountIn);
        if (uniQuote) quotes.push(uniQuote);
    }

    if (!preferredDex || preferredDex === 'aerodrome') {
        const aeroQuote = await dexService.getAerodromeQuote(fromToken, toToken, amountIn);
        if (aeroQuote) quotes.push(aeroQuote);
    }

    // Always try Odos aggregator (covers all Base DEXes)
    const odosQuote = await aggregatorService.getOdosQuote(fromToken, toToken, amountIn);
    if (odosQuote) quotes.push(odosQuote);

    const validQuotes = quotes.filter(q => q && q.toTokenAmount && BigInt(q.toTokenAmount) > 0n);
    if (validQuotes.length === 0) return null;

    return validQuotes.reduce((best, current) =>
        BigInt(current.toTokenAmount) > BigInt(best.toTokenAmount) ? current : best
    );
}

/**
 * Builds a typed SwapStep struct for the smart contract based on the quote source.
 * Returns the step object matching the contract's SwapStep struct.
 */
async function buildSwapStep(quote, fromToken, toToken, amountIn) {
    const slippageFactor = BigInt(Math.round((1 - (config.slippageBuffer || 0.003)) * 10000));
    const amountOutMin = (BigInt(quote.toTokenAmount) * slippageFactor) / 10000n;

    if (quote.dex === 'uniswap') {
        // Typed Uniswap V3 swap - contract calls exactInputSingle natively
        return {
            dexType: DEX_UNISWAP_V3,
            router: UNISWAP_V3_ROUTER,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: quote.fee || 3000,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: amountOutMin.toString(),
            data: '0x', // Not needed for typed swaps
        };
    }

    if (quote.dex === 'aerodrome') {
        // Typed Aerodrome swap - contract calls swapExactTokensForTokens with Route struct
        return {
            dexType: DEX_AERODROME,
            router: AERODROME_ROUTER,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: 0,
            stable: quote.stable || false,
            factory: AERODROME_FACTORY,
            amountOutMin: amountOutMin.toString(),
            data: '0x',
        };
    }

    if (quote.aggregator === 'odos') {
        // Generic swap via Odos aggregator - contract calls router.call(data)
        const assembled = await aggregatorService.getOdosAssemble(quote);
        if (!assembled || !assembled.to || !assembled.data) {
            log('Failed to assemble Odos swap data');
            return null;
        }

        return {
            dexType: DEX_GENERIC,
            router: assembled.to,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: 0,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: amountOutMin.toString(),
            data: assembled.data,
        };
    }

    return null;
}

/**
 * Evaluates a multi-hop arbitrage path for profitability.
 * Builds typed SwapStep[] for the contract to execute atomically.
 */
async function evaluatePath(pathHops, initialAmount, tokenDatabase) {
    const pathSymbols = pathHops.map(hop =>
        tokenDatabase[hop.from]?.symbol || hop.from.slice(0, 8)
    ).join(' -> ') + ` -> ${tokenDatabase[pathHops[pathHops.length - 1].to]?.symbol || pathHops[pathHops.length - 1].to.slice(0, 8)}`;

    log(`Scanning: ${pathSymbols}`);

    let currentAmount = BigInt(initialAmount);
    const swapSteps = [];
    const tokens = [pathHops[0].from];

    for (const hop of pathHops) {
        const quote = await getBestHopQuote(hop.from, hop.to, currentAmount.toString(), hop.dex);
        if (!quote) return null;

        const step = await buildSwapStep(quote, hop.from, hop.to, currentAmount);
        if (!step) return null;

        swapSteps.push(step);
        tokens.push(hop.to);
        currentAmount = BigInt(quote.toTokenAmount);
    }

    const finalAmount = currentAmount;
    const borrowedAmount = BigInt(initialAmount);

    const gasCostEstimate = ethers.parseUnits('0.0005', 'ether');
    const { netProfit, profitPercent } = calculateNetProfit(finalAmount, borrowedAmount, gasCostEstimate);

    const startSymbol = tokenDatabase[tokens[0]]?.symbol || tokens[0].slice(0, 8);
    log(`Result: ${ethers.formatUnits(netProfit, 18)} ${startSymbol} (${profitPercent.toFixed(2)}%)`);

    if (await isProfitable(netProfit, `${tokens[0]}/${tokens[tokens.length - 1]}`)) {
        // Simulate before committing
        const contractAddr = config.contractAddress[config.network];
        if (contractAddr) {
            const ABI = [
                'function executeArb(address asset, uint256 amount, tuple(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 fee, bool stable, address factory, uint256 amountOutMin, bytes data)[] steps)'
            ];
            const iface = new ethers.Interface(ABI);
            const calldata = iface.encodeFunctionData('executeArb', [
                tokens[0], // asset (borrow token)
                initialAmount,
                swapSteps
            ]);

            const simSuccess = await simulateTransaction(contractAddr, calldata);
            if (!simSuccess) {
                log('Simulation failed. Skipping opportunity.');
                return null;
            }
        }

        return {
            netProfit,
            profitPercent,
            initialAmount: initialAmount.toString(),
            finalAmount: finalAmount.toString(),
            asset: tokens[0],
            swapSteps,
            pathDescription: pathSymbols,
        };
    }

    return null;
}

/**
 * Scans all cached arbitrage paths for profitable opportunities.
 */
async function scanAllPaths(paths, tokenDatabase) {
    log(`Scanning ${paths.length} paths for arbitrage...`);
    const opportunities = [];

    try {
        const scanAmountStr = config.scanAmount || '1';
        const initialAmount = ethers.parseUnits(scanAmountStr, 'ether').toString();

        const batchSize = 5;
        for (let i = 0; i < paths.length; i += batchSize) {
            const batch = paths.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(p => {
                    if (!p || p.length === 0) return Promise.resolve(null);
                    return evaluatePath(p, initialAmount, tokenDatabase);
                })
            );

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    opportunities.push(result.value);
                    log(`PROFITABLE: ${result.value.pathDescription} | ${ethers.formatUnits(result.value.netProfit, 18)} ETH`);
                }
            }
        }
    } catch (error) {
        log(`Error scanning paths: ${error.message}`);
    }

    log(`Found ${opportunities.length} profitable opportunities out of ${paths.length} paths.`);
    return opportunities;
}

module.exports = {
    scanAllPaths: withErrorHandling(scanAllPaths),
    getBestHopQuote: withErrorHandling(getBestHopQuote),
    DEX_GENERIC,
    DEX_UNISWAP_V3,
    DEX_AERODROME,
    DEX_PANCAKESWAP_V3,
};
