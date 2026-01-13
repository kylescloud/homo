const axios = require('axios');
const config = require('./config');
const { log, withErrorHandling } = require('./utils');

const dexScreenerApi = axios.create({
    baseURL: 'https://api.dexscreener.com/latest/',
});

let volatileTokens = [];

/**
 * Fetches trending tokens from the DexScreener API.
 * @returns {Promise<Array<object>>} A list of trending tokens.
 */
const fetchTrendingTokens = async () => {
    log('Fetching trending tokens from DexScreener...');
    // DexScreener API for new pairs on Base. Adjust the endpoint as needed.
    const response = await dexScreenerApi.get('dex/search?q=base');
    const pairs = response.data.pairs;

    // Extract unique tokens from the new pairs
    const tokenSet = new Set();
    pairs.forEach(pair => {
        tokenSet.add({ address: pair.baseToken.address, symbol: pair.baseToken.symbol });
        tokenSet.add({ address: pair.quoteToken.address, symbol: pair.quoteToken.symbol });
    });

    log(`Found ${tokenSet.size} new tokens.`);
    return Array.from(tokenSet);
};

/**
 * Updates the list of volatile tokens.
 */
const updateVolatileList = async () => {
    const newTokens = await fetchTrendingTokens();
    if (newTokens) {
        // Simple replacement for now. More sophisticated logic could be used here.
        volatileTokens = newTokens;
        log('Volatile token list updated.');
    }
};

/**
 * Gets the current list of volatile tokens.
 * @returns {Array<object>} The list of volatile tokens.
 */
const getVolatileTokens = () => {
    return volatileTokens;
};

/**
 * Gets a token address from a symbol.
 * Note: This is a simple implementation and may not be robust enough for production.
 * @param {string} symbol The token symbol.
 * @returns {string|null} The token address or null if not found.
 */
const getTokenAddress = (symbol) => {
    const token = volatileTokens.find(t => t.symbol.toLowerCase() === symbol.toLowerCase());
    return token ? token.address : null;
};

/**
 * Gets the pair address for two token symbols from DexScreener.
 * @param {string} token0Symbol The symbol of the first token.
 * @param {string} token1Symbol The symbol of the second token.
 * @returns {string|null} The pair address or null if not found.
 */
const getPairAddress = async (token0Symbol, token1Symbol) => {
    try {
        const query = `${token0Symbol} ${token1Symbol}`;
        const response = await dexScreenerApi.get(`pairs/search?q=${query}`);
        const pairs = response.data.pairs;
        if (pairs && pairs.length > 0) {
            // This is a simplified approach. A more robust implementation would handle multiple results.
            return pairs[0].pairAddress;
        }
        return null;
    } catch (error) {
        log(`Failed to get pair address for ${token0Symbol}/${token1Symbol}: ${error.message}`);
        return null;
    }
};

// Periodically update the volatile token list
setInterval(updateVolatileList, 30 * 60 * 1000); // Update every 30 minutes

// Initial update
updateVolatileList();

module.exports = {
    fetchTrendingTokens: withErrorHandling(fetchTrendingTokens),
    updateVolatileList: withErrorHandling(updateVolatileList),
    getVolatileTokens,
    getTokenAddress,
    getPairAddress: withErrorHandling(getPairAddress),
};
