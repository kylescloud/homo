const { ethers } = require('ethers');
const config = require('./config');
const { loadBalancer } = require('./provider');

const initialProvider = loadBalancer.getNextProvider();
const wallet = new ethers.Wallet(config.auth.privateKey, initialProvider);

module.exports = {
    wallet,
};
