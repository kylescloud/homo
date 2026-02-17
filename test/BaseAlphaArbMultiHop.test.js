const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BaseAlphaArb Multi-DEX Multi-Hop", function () {
    const DEX_GENERIC = 0;
    const DEX_UNISWAP_V3 = 1;
    const DEX_AERODROME = 2;

    async function deployFixture() {
        const [owner] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
        const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
        const dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);

        const MockAavePool = await ethers.getContractFactory("MockAavePool");
        const aavePool = await MockAavePool.deploy();
        const MockPoolAddressesProvider = await ethers.getContractFactory("MockPoolAddressesProvider");
        const aaveProvider = await MockPoolAddressesProvider.deploy(aavePool.target);
        await aavePool.setAddressesProvider(aaveProvider.target);

        const BaseAlphaArb = await ethers.getContractFactory("BaseAlphaArb");
        const baseAlphaArb = await BaseAlphaArb.deploy(aaveProvider.target, weth.target);

        const MockAggregator = await ethers.getContractFactory("MockAggregator");
        const mockAggregator = await MockAggregator.deploy();

        const MockUniswapV3Router = await ethers.getContractFactory("MockUniswapV3Router");
        const mockUniRouter = await MockUniswapV3Router.deploy();

        const MockAerodromeRouter = await ethers.getContractFactory("MockAerodromeRouter");
        const mockAeroRouter = await MockAerodromeRouter.deploy();

        // Whitelist all routers
        await baseAlphaArb.setRouterWhitelistBatch(
            [mockAggregator.target, mockUniRouter.target, mockAeroRouter.target],
            true
        );

        return {
            baseAlphaArb, owner,
            usdc, weth, dai,
            aavePool, mockAggregator, mockUniRouter, mockAeroRouter
        };
    }

    // ================================================================
    //  TEST: 3-hop multi-DEX arb (Uniswap V3 -> Aerodrome -> Generic)
    //  USDC -[UniV3]-> WETH -[Aero]-> DAI -[Odos/Generic]-> USDC
    // ================================================================
    it("Should execute a 3-hop arb across Uniswap V3, Aerodrome, and Generic (Odos)", async function () {
        const { baseAlphaArb, owner, usdc, weth, dai, aavePool, mockAggregator, mockUniRouter, mockAeroRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("120", 6);
        const wethAmount = ethers.parseUnits("5", 18);
        const daiAmount = ethers.parseUnits("10000", 18);
        const premium = (loanAmount * 9n) / 10000n;

        // Fund everything
        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockUniRouter.target, wethAmount);             // UniV3 outputs WETH
        await dai.mint(mockAeroRouter.target, daiAmount);               // Aerodrome outputs DAI
        await usdc.mint(mockAggregator.target, loanAmount + profit + premium); // Generic outputs USDC

        // Set exchange rates
        await mockUniRouter.setPresetAmount(usdc.target, weth.target, wethAmount);
        await mockAeroRouter.setPresetAmount(weth.target, dai.target, daiAmount);

        // Build generic calldata for the last hop (simulating Odos aggregator)
        const genericHopData = mockAggregator.interface.encodeFunctionData("swap", [
            dai.target, usdc.target, daiAmount, loanAmount + profit + premium
        ]);

        const aeroFactory = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

        const steps = [
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 3000,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: wethAmount,
                data: "0x",
            },
            {
                dexType: DEX_AERODROME,
                router: mockAeroRouter.target,
                tokenIn: weth.target,
                tokenOut: dai.target,
                fee: 0,
                stable: false,
                factory: aeroFactory,
                amountOutMin: daiAmount,
                data: "0x",
            },
            {
                dexType: DEX_GENERIC,
                router: mockAggregator.target,
                tokenIn: dai.target,
                tokenOut: usdc.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: loanAmount + profit,
                data: genericHopData,
            }
        ];

        // Execute the multi-DEX arbitrage
        const tx = await baseAlphaArb.executeArb(usdc.target, loanAmount, steps);
        const receipt = await tx.wait();

        // Verify profit
        const finalBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalBalance).to.equal(profit);

        // Verify events were emitted for each step
        const swapEvents = receipt.logs.filter(log => {
            try {
                return baseAlphaArb.interface.parseLog(log)?.name === "SwapExecuted";
            } catch { return false; }
        });
        expect(swapEvents.length).to.equal(3); // One per hop

        // Verify ArbExecuted event
        const arbEvent = receipt.logs.find(log => {
            try {
                return baseAlphaArb.interface.parseLog(log)?.name === "ArbExecuted";
            } catch { return false; }
        });
        expect(arbEvent).to.not.be.undefined;
    });

    // ================================================================
    //  TEST: 3-hop all typed swaps (UniV3 -> Aero -> UniV3)
    // ================================================================
    it("Should execute a 3-hop arb with all typed DEX swaps", async function () {
        const { baseAlphaArb, owner, usdc, weth, dai, aavePool, mockUniRouter, mockAeroRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("5000", 6);
        const profit = ethers.parseUnits("80", 6);
        const wethAmount = ethers.parseUnits("2", 18);
        const daiAmount = ethers.parseUnits("5000", 18);
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockUniRouter.target, wethAmount);
        await dai.mint(mockAeroRouter.target, daiAmount);
        await usdc.mint(mockUniRouter.target, loanAmount + profit + premium);

        await mockUniRouter.setPresetAmount(usdc.target, weth.target, wethAmount);
        await mockAeroRouter.setPresetAmount(weth.target, dai.target, daiAmount);
        await mockUniRouter.setPresetAmount(dai.target, usdc.target, loanAmount + profit + premium);

        const aeroFactory = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

        const steps = [
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 500, // 0.05% fee tier
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: wethAmount,
                data: "0x",
            },
            {
                dexType: DEX_AERODROME,
                router: mockAeroRouter.target,
                tokenIn: weth.target,
                tokenOut: dai.target,
                fee: 0,
                stable: false, // volatile pool
                factory: aeroFactory,
                amountOutMin: daiAmount,
                data: "0x",
            },
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: dai.target,
                tokenOut: usdc.target,
                fee: 500,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: loanAmount + profit,
                data: "0x",
            }
        ];

        await baseAlphaArb.executeArb(usdc.target, loanAmount, steps);

        const finalBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalBalance).to.equal(profit);
    });

    // ================================================================
    //  TEST: Flash loan repayment fails when trade is not profitable
    // ================================================================
    it("Should revert when final balance cannot repay flash loan", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockUniRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const lossAmount = ethers.parseUnits("9000", 6); // Less than borrowed + premium
        const wethAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockUniRouter.target, wethAmount);
        await usdc.mint(mockUniRouter.target, lossAmount); // Not enough to repay

        await mockUniRouter.setPresetAmount(usdc.target, weth.target, wethAmount);
        await mockUniRouter.setPresetAmount(weth.target, usdc.target, lossAmount);

        const steps = [
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 3000, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: 0, data: "0x",
            },
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 3000, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: 0, data: "0x",
            }
        ];

        await expect(
            baseAlphaArb.executeArb(usdc.target, loanAmount, steps)
        ).to.be.reverted; // "Insufficient to repay flash loan"
    });
});
