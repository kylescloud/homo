const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BaseAlphaArb", function () {
    async function deployFixture() {
        const [owner, otherAccount] = await ethers.getSigners();

        // Deploy Mock Tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
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

        // Deploy the MockAggregator
        const MockAggregator = await ethers.getContractFactory("MockAggregator");
        const mockAggregator = await MockAggregator.deploy();

        return { baseAlphaArb, owner, usdc, weth, aavePool, mockAggregator };
    }

    it("Should execute a two-hop flash loan and repay with profit", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockAggregator } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("100", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);

        // Fund the mock aggregator and mock Aave pool
        let premium = (loanAmount * 9n) / 10000n;
        await usdc.mint(mockAggregator.target, loanAmount + profit + premium);
        await weth.mint(mockAggregator.target, intermediateAmount);
        await usdc.mint(aavePool.target, loanAmount + premium);

        // Path: USDC -> WETH -> USDC
        const tokens = [usdc.target, weth.target, usdc.target];

        const hop1Data = mockAggregator.interface.encodeFunctionData("swap", [usdc.target, weth.target, loanAmount, intermediateAmount]);
        const hop2Data = mockAggregator.interface.encodeFunctionData("swap", [weth.target, usdc.target, intermediateAmount, loanAmount + profit + premium]);

        const hops = [
            { target: mockAggregator.target, data: hop1Data },
            { target: mockAggregator.target, data: hop2Data },
        ];

        // Execute the arbitrage
        await baseAlphaArb.executeArb(tokens, hops, loanAmount);

        const finalContractBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalContractBalance).to.equal(profit);
    });
});
