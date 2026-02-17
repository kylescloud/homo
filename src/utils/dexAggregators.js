const RateLimiter = require("./rateLimiter");

const dexAggregators = {
  odos: {
    limiter: new RateLimiter(2, 1000), // 2 requests per second
  },
};

module.exports = dexAggregators;
