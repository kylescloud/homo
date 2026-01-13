const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BaseAlphaArb Multi-Hop", function () {
    async function deployFixture() {
        const [owner] = await ethers.getSigners();

        // Deploy Mock Tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
        const dai = await MockERC20.deploy("Dai", "DAI", 18);
        const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

        // Deploy Mock Aave Pool and Provider
        const MockAavePool = await ethers.getContractFactory("MockAavePool");
        const aavePool = await MockAavePool.deploy();
        const MockPoolAddressesProvider = await ethers.getContractFactory("MockPoolAddressesProvider");
        const aaveProvider = await MockPoolAddressesProvider.deploy(aavePool.target);
        await aavePool.setAddressesProvider(aaveProvider.target);

        // Deploy our BaseAlphaArb contract
        const BaseAlphaArb = await ethers.getContractFactory("BaseAlphaArb");
        const baseAlphaArb = await BaseAlphaArb.deploy(aaveProvider.target);

        // Deploy Mock Aggregators
        const MockAggregator = await ethers.getContractFactory("MockAggregator");
        const aggregator1 = await MockAggregator.deploy();
        const aggregator2 = await MockAggregator.deploy();
        const aggregator3 = await MockAggregator.deploy();

        return { baseAlphaArb, owner, usdc, dai, weth, aavePool, aggregator1, aggregator2, aggregator3 };
    }

    it("Should execute a three-hop flash loan and repay with profit", async function () {
        const { baseAlphaArb, owner, usdc, dai, weth, aavePool, aggregator1, aggregator2, aggregator3 } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("100", 6);
        const amount2 = ethers.parseUnits("10000", 18);
        const amount3 = ethers.parseUnits("5", 18);

        // Fund the mock aggregators and mock Aave pool
        let premium = (loanAmount * 9n) / 10000n;
        await dai.mint(aggregator1.target, amount2);
        await weth.mint(aggregator2.target, amount3);
        await usdc.mint(aggregator3.target, loanAmount + profit + premium);
        await usdc.mint(aavePool.target, loanAmount + premium);

        // Path: USDC -> DAI -> WETH -> USDC
        const tokens = [usdc.target, dai.target, weth.target, usdc.target];

        const hop1Data = aggregator1.interface.encodeFunctionData("swap", [usdc.target, dai.target, loanAmount, amount2]);
        const hop2Data = aggregator2.interface.encodeFunctionData("swap", [dai.target, weth.target, amount2, amount3]);
        const hop3Data = aggregator3.interface.encodeFunctionData("swap", [weth.target, usdc.target, amount3, loanAmount + profit + premium]);

        const hops = [
            { target: aggregator1.target, data: hop1Data },
            { target: aggregator2.target, data: hop2Data },
            { target: aggregator3.target, data: hop3Data },
        ];

        // Execute the arbitrage
        await baseAlphaArb.executeArb(tokens, hops, loanAmount);

        const finalContractBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalContractBalance).to.equal(profit);
    });
});
