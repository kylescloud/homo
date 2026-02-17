const axios = require('axios');
const { log, withErrorHandling } = require('./utils');
const config = require('./config');

const DEXSCREENER_API_URL = 'https://api.dexscreener.com/latest/dex/';

/**
 * Fetches trading pairs from DexScreener for all configured DEXes on Base.
 * Builds a comprehensive token database including pair/pool information.
 *
 * Fetches pairs for: Uniswap V2, Uniswap V3, PancakeSwap V3,
 * Aerodrome, SushiSwap V3, BaseSwap
 */
async function fetchAllPairs(dexIds) {
    const tokenDatabase = {};
    const configuredDexIds = dexIds || config.dexScreenerIds || [
        'aerodrome',
        'uniswap',
        'pancakeswap',
        'sushiswap',
        'baseswap'
    ];

    log(`Fetching pairs for DEXs: ${configuredDexIds.join(', ')}...`);

    for (const dexId of configuredDexIds) {
        try {
            // Use DexScreener search to find pairs on Base for this DEX
            const url = `${DEXSCREENER_API_URL}search?q=${encodeURIComponent(dexId + ' base')}`;
            const response = await axios.get(url, { timeout: 15000 });
            const pairs = response.data?.pairs || [];

            // Filter for Base chain pairs with minimum liquidity
            const basePairs = pairs.filter(p =>
                p.chainId === 'base' &&
                p.liquidity?.usd > 10000 // Minimum $10k liquidity for arb viability
            );

            log(`Found ${basePairs.length} Base pairs for ${dexId}`);

            for (const pair of basePairs) {
                const { baseToken, quoteToken, liquidity, dexId: pairDex } = pair;
                if (!baseToken || !quoteToken) continue;

                const baseAddr = baseToken.address.toLowerCase();
                const quoteAddr = quoteToken.address.toLowerCase();

                // Add/update tokens in database
                [
                    [baseAddr, baseToken],
                    [quoteAddr, quoteToken]
                ].forEach(([addr, token]) => {
                    if (!tokenDatabase[addr]) {
                        tokenDatabase[addr] = {
                            symbol: token.symbol,
                            name: token.name,
                            pairs: {},
                            liquidity: 0,
                            dexes: new Set(),
                        };
                    }
                });

                // Map the DEX ID to our internal naming
                const dexName = mapDexId(pairDex || dexId);

                // Add pair information (bidirectional)
                tokenDatabase[baseAddr].pairs[quoteAddr] = { dex: dexName };
                tokenDatabase[quoteAddr].pairs[baseAddr] = { dex: dexName };

                // Track which DEXes this token trades on
                tokenDatabase[baseAddr].dexes.add(dexName);
                tokenDatabase[quoteAddr].dexes.add(dexName);

                // Aggregate liquidity
                const liq = liquidity?.usd || 0;
                tokenDatabase[baseAddr].liquidity += liq;
                tokenDatabase[quoteAddr].liquidity += liq;
            }

            // Rate limit between DexScreener requests
            await new Promise(r => setTimeout(r, 500));

        } catch (error) {
            log(`Failed to fetch pairs for ${dexId}: ${error.message}`);
        }
    }

    // Convert Set to Array for JSON serialization
    for (const addr of Object.keys(tokenDatabase)) {
        if (tokenDatabase[addr].dexes instanceof Set) {
            tokenDatabase[addr].dexes = Array.from(tokenDatabase[addr].dexes);
        }
    }

    log(`Built database with ${Object.keys(tokenDatabase).length} tokens across ${configuredDexIds.length} DEXes.`);
    return tokenDatabase;
}

/**
 * Maps DexScreener dexId to our internal naming convention.
 */
function mapDexId(dexScreenerId) {
    const mapping = {
        'uniswap': 'uniswap',
        'uniswap_v2': 'uniswapV2',
        'uniswap_v3': 'uniswapV3',
        'aerodrome': 'aerodrome',
        'pancakeswap': 'pancakeswapV3',
        'pancakeswap_v3': 'pancakeswapV3',
        'sushiswap': 'sushiswapV3',
        'sushiswap_v3': 'sushiswapV3',
        'baseswap': 'baseswap',
    };
    const lower = (dexScreenerId || '').toLowerCase();
    return mapping[lower] || lower;
}

module.exports = {
    fetchAllPairs: withErrorHandling(fetchAllPairs),
};
