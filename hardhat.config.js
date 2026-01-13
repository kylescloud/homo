require('dotenv').config();
require("@nomicfoundation/hardhat-toolbox");

const baseRpcUrls = process.env.BASE_RPC_URLS;
if (!baseRpcUrls) {
  throw new Error("BASE_RPC_URLS environment variable is not set. Please create a .env file and set it.");
}
const firstRpcUrl = baseRpcUrls.split(',')[0];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {},
    base: {
      url: firstRpcUrl,
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
