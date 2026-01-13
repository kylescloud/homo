const { ethers } = require('ethers');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const { loadBalancer } = require('./provider');

const UNISWAP_V3_ROUTER = "0x198EF79F1F515F02dFE9e3115eD9fC07183f02fC";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Universal Quoter

const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

const PANCAKESWAP_V3_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const PANCAKESWAP_V3_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";

// ABIs for Uniswap V3 Quoter and Router
const UNISWAP_V3_QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)"
];
const UNISWAP_V3_ROUTER_ABI = [
    "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

const provider = loadBalancer.getNextProvider();

const uniswapV3Quoter = new ethers.Contract(UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
const AERODROME_ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
];

const PANCAKESWAP_V3_QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)"
];
const PANCAKESWAP_V3_ROUTER_ABI = [
    "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];
const pancakeSwapV3Router = new ethers.Contract(PANCAKESWAP_V3_ROUTER, PANCAKESWAP_V3_ROUTER_ABI, provider);

async function getPancakeSwapSwapData(tokenIn, tokenOut, amountIn, amountOutMinimum, fee) {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from the current Unix time

    const params = {
        tokenIn,
        tokenOut,
        fee,
        recipient: config.contractAddress[config.network],
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
    };

    try {
        const tx = await pancakeSwapV3Router.populateTransaction.exactInputSingle(params);
        return {
            to: PANCAKESWAP_V3_ROUTER,
            data: tx.data,
        };
    } catch (error) {
        log(`Failed to get PancakeSwap swap data: ${error.message}`);
        return null;
    }
}

const pancakeSwapV3Quoter = new ethers.Contract(PANCAKESWAP_V3_QUOTER, PANCAKESWAP_V3_QUOTER_ABI, provider);

async function getPancakeSwapQuote(tokenIn, tokenOut, amountIn) {
    const fees = [500, 2500, 10000]; // Most popular fee tiers for PancakeSwap
    let bestQuote = 0n;

    for (const fee of fees) {
        try {
            const quote = await pancakeSwapV3Quoter.quoteExactInputSingle(
                tokenIn,
                tokenOut,
                fee,
                amountIn,
                0
            );
            if (quote > bestQuote) {
                bestQuote = quote;
            }
        } catch (error) {
            // Ignore errors for fee tiers that don't exist
        }
    }

    if (bestQuote > 0n) {
        // Find the fee that produced the best quote
        for (const fee of fees) {
            try {
                const quote = await pancakeSwapV3Quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
                if (quote === bestQuote) {
                    return {
                        dex: 'pancakeswap',
                        toTokenAmount: bestQuote.toString(),
                        fee: fee,
                    };
                }
            } catch (e) { /* ignore */ }
        }
    }
    return null;
}

const aerodromeRouter = new ethers.Contract(AERODROME_ROUTER, AERODROME_ROUTER_ABI, provider);


async function getAerodromeQuote(tokenIn, tokenOut, amountIn) {
    try {
        const amounts = await aerodromeRouter.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        const amountOut = amounts[1];
        if (amountOut > 0n) {
            return {
                dex: 'aerodrome',
                toTokenAmount: amountOut.toString(),
            };
        }
    } catch (error) {
        // Ignore errors for pairs that don't exist
    }
    return null;
}

const uniswapV3Router = new ethers.Contract(UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, provider);

async function getUniswapQuote(tokenIn, tokenOut, amountIn) {
    const fees = [500, 3000, 10000]; // Most popular fee tiers
    let bestQuote = 0n;

    for (const fee of fees) {
        try {
            const quote = await uniswapV3Quoter.quoteExactInputSingle(
                tokenIn,
                tokenOut,
                fee,
                amountIn,
                0
            );
            if (quote > bestQuote) {
                bestQuote = quote;
            }
        } catch (error) {
            // Ignore errors for fee tiers that don't exist
        }
    }

    if (bestQuote > 0n) {
        // Find the fee that produced the best quote
        for (const fee of fees) {
            try {
                const quote = await uniswapV3Quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
                if (quote === bestQuote) {
                    return {
                        dex: 'uniswap',
                        toTokenAmount: bestQuote.toString(),
                        fee: fee,
                    };
                }
            } catch (e) { /* ignore */ }
        }
    }
    return null;
}

async function getUniswapSwapData(tokenIn, tokenOut, amountIn, amountOutMinimum, fee) {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from the current Unix time

    const params = {
        tokenIn,
        tokenOut,
        fee,
        recipient: config.contractAddress[config.network],
        deadline,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
    };

    try {
        const tx = await uniswapV3Router.populateTransaction.exactInputSingle(params);
        return {
            to: UNISWAP_V3_ROUTER,
            data: tx.data,
        };
    } catch (error) {
        log(`Failed to get Uniswap swap data: ${error.message}`);
        return null;
    }
}

async function getAerodromeSwapData(tokenIn, tokenOut, amountIn, amountOutMinimum) {
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from the current Unix time
    const path = [tokenIn, tokenOut];

    try {
        const tx = await aerodromeRouter.populateTransaction.swapExactTokensForTokens(
            amountIn,
            amountOutMinimum,
            path,
            config.contractAddress[config.network],
            deadline
        );
        return {
            to: AERODROME_ROUTER,
            data: tx.data,
        };
    } catch (error) {
        log(`Failed to get Aerodrome swap data: ${error.message}`);
        return null;
    }
}

module.exports = {
    getUniswapQuote: withErrorHandling(getUniswapQuote),
    getAerodromeQuote: withErrorHandling(getAerodromeQuote),
    getPancakeSwapQuote: withErrorHandling(getPancakeSwapQuote),
    getUniswapSwapData: withErrorHandling(getUniswapSwapData),
    getAerodromeSwapData: withErrorHandling(getAerodromeSwapData),
    getPancakeSwapSwapData: withErrorHandling(getPancakeSwapSwapData),
};
