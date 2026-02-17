const { ethers } = require('ethers');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const aggregatorService = require('./aggregatorService');
const dexService = require('./dexService');
const { calculateNetProfit, isProfitable, simulateTransaction } = require('./profitCalculator');
const provider = require('./provider');

// DEX type constants matching smart contract
const {
    DEX_GENERIC, DEX_UNISWAP_V3, DEX_AERODROME, DEX_PANCAKESWAP_V3, DEX_UNISWAP_V2,
    UNISWAP_V2_ROUTER, UNISWAP_V3_SWAP_ROUTER_02, AERODROME_ROUTER,
    AERODROME_DEFAULT_FACTORY, PANCAKESWAP_V3_SMART_ROUTER, BASESWAP_ROUTER,
} = dexService;

/**
 * Gets the best quote for a single hop by querying ALL configured DEXes.
 * Queries: Uniswap V2, Uniswap V3, Aerodrome, PancakeSwap V3, BaseSwap, Odos
 */
async function getBestHopQuote(fromToken, toToken, amountIn, preferredDex) {
    const quotePromises = [];

    // Direct DEX quotes (fast, on-chain)
    if (!preferredDex || preferredDex === 'uniswapV2' || preferredDex === 'uniswap') {
        quotePromises.push(dexService.getUniswapV2Quote(fromToken, toToken, amountIn));
    }
    if (!preferredDex || preferredDex === 'uniswapV3' || preferredDex === 'uniswap') {
        quotePromises.push(dexService.getUniswapV3Quote(fromToken, toToken, amountIn));
    }
    if (!preferredDex || preferredDex === 'aerodrome') {
        quotePromises.push(dexService.getAerodromeQuote(fromToken, toToken, amountIn));
    }
    if (!preferredDex || preferredDex === 'pancakeswap' || preferredDex === 'pancakeswapV3') {
        quotePromises.push(dexService.getPancakeSwapV3Quote(fromToken, toToken, amountIn));
    }
    if (!preferredDex || preferredDex === 'baseswap') {
        quotePromises.push(dexService.getBaseSwapQuote(fromToken, toToken, amountIn));
    }

    // Odos aggregator (covers SushiSwap V3 + all other Base DEXes)
    quotePromises.push(aggregatorService.getOdosQuote(fromToken, toToken, amountIn));

    const results = await Promise.allSettled(quotePromises);
    const validQuotes = results
        .filter(r => r.status === 'fulfilled' && r.value && r.value.toTokenAmount)
        .map(r => r.value)
        .filter(q => BigInt(q.toTokenAmount) > 0n);

    if (validQuotes.length === 0) return null;

    // Return the quote with the highest output
    return validQuotes.reduce((best, current) =>
        BigInt(current.toTokenAmount) > BigInt(best.toTokenAmount) ? current : best
    );
}

/**
 * Builds a typed SwapStep struct for the smart contract based on the quote source.
 * Each DEX gets its proper typed execution path in the contract.
 */
async function buildSwapStep(quote, fromToken, toToken, amountIn) {
    const slippageFactor = BigInt(Math.round((1 - (config.slippageBuffer || 0.003)) * 10000));
    const amountOutMin = (BigInt(quote.toTokenAmount) * slippageFactor) / 10000n;

    // Uniswap V2 / BaseSwap (standard V2 AMM - contract calls swapExactTokensForTokens with path[])
    if (quote.dexType === DEX_UNISWAP_V2) {
        return {
            dexType: DEX_UNISWAP_V2,
            router: quote.router, // Either UNISWAP_V2_ROUTER or BASESWAP_ROUTER
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: 0,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: amountOutMin.toString(),
            data: '0x',
        };
    }

    // Uniswap V3 (contract calls exactInputSingle natively)
    if (quote.dexType === DEX_UNISWAP_V3) {
        return {
            dexType: DEX_UNISWAP_V3,
            router: UNISWAP_V3_SWAP_ROUTER_02,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: quote.fee || 3000,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: amountOutMin.toString(),
            data: '0x',
        };
    }

    // Aerodrome (contract calls swapExactTokensForTokens with Route struct)
    if (quote.dexType === DEX_AERODROME) {
        return {
            dexType: DEX_AERODROME,
            router: AERODROME_ROUTER,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: 0,
            stable: quote.stable || false,
            factory: AERODROME_DEFAULT_FACTORY,
            amountOutMin: amountOutMin.toString(),
            data: '0x',
        };
    }

    // PancakeSwap V3 (contract calls exactInputSingle - same as UniV3 interface)
    if (quote.dexType === DEX_PANCAKESWAP_V3) {
        return {
            dexType: DEX_PANCAKESWAP_V3,
            router: PANCAKESWAP_V3_SMART_ROUTER,
            tokenIn: fromToken,
            tokenOut: toToken,
            fee: quote.fee || 2500,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: amountOutMin.toString(),
            data: '0x',
        };
    }

    // Odos aggregator or SushiSwap RouteProcessor (generic calldata)
    if (quote.aggregator === 'odos') {
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
 * Evaluates a multi-hop arbitrage path for profitability across all DEXes.
 */
async function evaluatePath(pathHops, initialAmount, tokenDatabase) {
    const pathSymbols = pathHops.map(hop =>
        tokenDatabase[hop.from]?.symbol || hop.from.slice(0, 8)
    ).join(' -> ') + ` -> ${tokenDatabase[pathHops[pathHops.length - 1].to]?.symbol || pathHops[pathHops.length - 1].to.slice(0, 8)}`;

    log(`Scanning: ${pathSymbols}`);

    let currentAmount = BigInt(initialAmount);
    const swapSteps = [];
    const dexNames = [];

    for (const hop of pathHops) {
        const quote = await getBestHopQuote(hop.from, hop.to, currentAmount.toString(), hop.dex);
        if (!quote) return null;

        const step = await buildSwapStep(quote, hop.from, hop.to, currentAmount);
        if (!step) return null;

        swapSteps.push(step);
        dexNames.push(quote.dex || quote.aggregator || 'unknown');
        currentAmount = BigInt(quote.toTokenAmount);
    }

    const finalAmount = currentAmount;
    const borrowedAmount = BigInt(initialAmount);
    const gasCostEstimate = ethers.parseUnits('0.0005', 'ether');
    const { netProfit, profitPercent } = calculateNetProfit(finalAmount, borrowedAmount, gasCostEstimate);

    const startSymbol = tokenDatabase[pathHops[0].from]?.symbol || pathHops[0].from.slice(0, 8);
    log(`Result: ${ethers.formatUnits(netProfit, 18)} ${startSymbol} (${profitPercent.toFixed(2)}%) via ${dexNames.join(' -> ')}`);

    if (await isProfitable(netProfit, `${pathHops[0].from}/${pathHops[pathHops.length - 1].to}`)) {
        const contractAddr = config.contractAddress[config.network];
        if (contractAddr) {
            const ABI = [
                'function executeArb(address asset, uint256 amount, tuple(uint8 dexType, address router, address tokenIn, address tokenOut, uint24 fee, bool stable, address factory, uint256 amountOutMin, bytes data)[] steps)'
            ];
            const iface = new ethers.Interface(ABI);
            const calldata = iface.encodeFunctionData('executeArb', [
                pathHops[0].from,
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
            asset: pathHops[0].from,
            swapSteps,
            pathDescription: pathSymbols,
            dexRoute: dexNames.join(' -> '),
        };
    }

    return null;
}

/**
 * Scans all arbitrage paths across all configured DEXes.
 */
async function scanAllPaths(paths, tokenDatabase) {
    log(`Scanning ${paths.length} paths across UniV2, UniV3, Aerodrome, PancakeSwap, BaseSwap, SushiSwap, Odos...`);
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
                    log(`PROFITABLE: ${result.value.pathDescription} | ${result.value.dexRoute} | ${ethers.formatUnits(result.value.netProfit, 18)} ETH`);
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
    DEX_UNISWAP_V2,
};
