const axios = require('axios');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');
const dexAggregators = require('./utils/dexAggregators');
const { wallet } = require('./wallet');

const odosApi = axios.create({
    baseURL: config.aggregatorUrls.odos,
});

const { TradingSdk, SupportedChainId } = require('@cowprotocol/cow-sdk');

const cowSdk = new TradingSdk({
    chainId: SupportedChainId.BASE,
    // Add other necessary config for the SDK
});

/**
 * Gets a quote from Odos.
 * @param {string} fromTokenAddress The address of the token to sell.
 * @param {string} toTokenAddress The address of the token to buy.
 * @param {string} amount The amount to sell.
 * @returns {Promise<object>} The quote from Odos.
 */
const getOdosQuote = async (fromTokenAddress, toTokenAddress, amount) => {
    await dexAggregators.odos.limiter.acquire();
    const quoteRequestBody = {
        chainId: 8453, // Base mainnet
        inputTokens: [
            {
                tokenAddress: fromTokenAddress,
                amount: amount
            }
        ],
        outputTokens: [
            {
                tokenAddress: toTokenAddress,
                proportion: 1
            }
        ],
        userAddr: '0x0000000000000000000000000000000000000000', // Not used for quoting
        slippageLimitPercent: config.slippageBuffer * 100,
        referralCode: 0,
        disableRFQs: true,
        compact: true,
    };
    try {
        const response = await odosApi.post('sor/quote/v3', quoteRequestBody);
        return { aggregator: 'odos', ...response.data };
    } catch (error) {
        log(`Odos quote failed: ${error.response?.data?.message || error.message}`);
        return null;
    }
};


/**
 * Gets the swap data (assembly) from Odos.
 * @returns {Promise<object>} The assembled transaction data from Odos.
 */
const getOdosAssemble = async (quote) => {
    await dexAggregators.odos.limiter.acquire();
    const assembleRequestBody = {
        userAddr: config.contractAddress[config.network], // The address of our contract
        pathId: quote.pathId,
        simulate: true,
    };
    try {
        const response = await odosApi.post('sor/assemble', assembleRequestBody);
        return response.data;
    } catch (error) {
        log(`Odos assemble failed: ${error.response?.data?.message || error.message}`);
        return null;
    }
};


/**
 * Gets a quote from CoW Swap.
 * @param {string} fromTokenAddress The address of the token to sell.
 * @param {string} toTokenAddress The address of the token to buy.
 * @param {string} amount The amount to sell.
 * @returns {Promise<object>} The quote from CoW Swap.
 */
const getCowQuote = async (fromTokenAddress, toTokenAddress, amount) => {
    await dexAggregators.cowSwap.quoteLimiter.acquire();
    try {
        const quote = await cowSdk.getQuote({
            sellToken: fromTokenAddress,
            buyToken: toTokenAddress,
            amount,
            kind: 'sell',
            userAddress: config.contractAddress[config.network],
        });
        return { aggregator: 'cowswap', ...quote };
    } catch (error) {
        log(`CoW Swap quote failed: ${error.message}`);
        return null;
    }
};


module.exports = {
    getOdosQuote: withErrorHandling(getOdosQuote),
    getOdosAssemble: withErrorHandling(getOdosAssemble),
    getCowQuote: withErrorHandling(getCowQuote),
};
