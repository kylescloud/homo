const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BaseAlphaArb", function () {
    // DEX type constants matching the contract
    const DEX_GENERIC = 0;
    const DEX_UNISWAP_V3 = 1;
    const DEX_AERODROME = 2;
    const DEX_PANCAKESWAP_V3 = 3;
    const DEX_UNISWAP_V2 = 4;

    async function deployFixture() {
        const [owner, otherAccount] = await ethers.getSigners();

        // Deploy Mock Tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
        const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
        const dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);

        // Deploy Mock Aave Pool and Provider
        const MockAavePool = await ethers.getContractFactory("MockAavePool");
        const aavePool = await MockAavePool.deploy();
        const MockPoolAddressesProvider = await ethers.getContractFactory("MockPoolAddressesProvider");
        const aaveProvider = await MockPoolAddressesProvider.deploy(aavePool.target);
        await aavePool.setAddressesProvider(aaveProvider.target);

        // Deploy BaseAlphaArb with WETH address
        const BaseAlphaArb = await ethers.getContractFactory("BaseAlphaArb");
        const baseAlphaArb = await BaseAlphaArb.deploy(aaveProvider.target, weth.target);

        // Deploy Mock DEX Routers
        const MockAggregator = await ethers.getContractFactory("MockAggregator");
        const mockAggregator = await MockAggregator.deploy();

        const MockUniswapV3Router = await ethers.getContractFactory("MockUniswapV3Router");
        const mockUniRouter = await MockUniswapV3Router.deploy();

        const MockAerodromeRouter = await ethers.getContractFactory("MockAerodromeRouter");
        const mockAeroRouter = await MockAerodromeRouter.deploy();

        const MockUniswapV2Router = await ethers.getContractFactory("MockUniswapV2Router");
        const mockV2Router = await MockUniswapV2Router.deploy();

        // Whitelist all routers
        await baseAlphaArb.setRouterWhitelistBatch(
            [mockAggregator.target, mockUniRouter.target, mockAeroRouter.target, mockV2Router.target],
            true
        );

        return {
            baseAlphaArb, owner, otherAccount,
            usdc, weth, dai,
            aavePool, mockAggregator, mockUniRouter, mockAeroRouter, mockV2Router
        };
    }

    // ================================================================
    //  TEST: Two-hop arbitrage using GENERIC (aggregator) swap type
    // ================================================================
    it("Should execute a 2-hop arb via GENERIC calldata", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockAggregator } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("100", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        // Fund mock aggregator and Aave pool
        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockAggregator.target, intermediateAmount);
        await usdc.mint(mockAggregator.target, loanAmount + profit + premium);

        // Build generic calldata for hops
        const hop1Data = mockAggregator.interface.encodeFunctionData("swap", [
            usdc.target, weth.target, loanAmount, intermediateAmount
        ]);
        const hop2Data = mockAggregator.interface.encodeFunctionData("swap", [
            weth.target, usdc.target, intermediateAmount, loanAmount + profit + premium
        ]);

        const steps = [
            {
                dexType: DEX_GENERIC,
                router: mockAggregator.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: intermediateAmount,
                data: hop1Data,
            },
            {
                dexType: DEX_GENERIC,
                router: mockAggregator.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: loanAmount + profit,
                data: hop2Data,
            }
        ];

        await baseAlphaArb.executeArb(usdc.target, loanAmount, steps);

        const finalBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalBalance).to.equal(profit);
    });

    // ================================================================
    //  TEST: Two-hop arbitrage using UNISWAP_V3 typed swap
    // ================================================================
    it("Should execute a 2-hop arb via Uniswap V3 typed interface", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockUniRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("50", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        // Fund mock Uniswap router and Aave pool
        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockUniRouter.target, intermediateAmount);
        await usdc.mint(mockUniRouter.target, loanAmount + profit + premium);

        // Set preset exchange rates on mock router
        await mockUniRouter.setPresetAmount(usdc.target, weth.target, intermediateAmount);
        await mockUniRouter.setPresetAmount(weth.target, usdc.target, loanAmount + profit + premium);

        const steps = [
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 3000,  // 0.3% fee tier
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: intermediateAmount,
                data: "0x",
            },
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 3000,
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
    //  TEST: Two-hop arb using AERODROME typed swap with Route struct
    // ================================================================
    it("Should execute a 2-hop arb via Aerodrome typed interface", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockAeroRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("75", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockAeroRouter.target, intermediateAmount);
        await usdc.mint(mockAeroRouter.target, loanAmount + profit + premium);

        await mockAeroRouter.setPresetAmount(usdc.target, weth.target, intermediateAmount);
        await mockAeroRouter.setPresetAmount(weth.target, usdc.target, loanAmount + profit + premium);

        const aeroFactory = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

        const steps = [
            {
                dexType: DEX_AERODROME,
                router: mockAeroRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 0,
                stable: false,   // volatile pool
                factory: aeroFactory,
                amountOutMin: intermediateAmount,
                data: "0x",
            },
            {
                dexType: DEX_AERODROME,
                router: mockAeroRouter.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 0,
                stable: false,
                factory: aeroFactory,
                amountOutMin: loanAmount + profit,
                data: "0x",
            }
        ];

        await baseAlphaArb.executeArb(usdc.target, loanAmount, steps);

        const finalBalance = await usdc.balanceOf(baseAlphaArb.target);
        expect(finalBalance).to.equal(profit);
    });

    // ================================================================
    //  TEST: Two-hop arb using UNISWAP_V2 / BaseSwap typed swap
    // ================================================================
    it("Should execute a 2-hop arb via Uniswap V2 / BaseSwap typed interface", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockV2Router } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("60", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockV2Router.target, intermediateAmount);
        await usdc.mint(mockV2Router.target, loanAmount + profit + premium);

        await mockV2Router.setPresetAmount(usdc.target, weth.target, intermediateAmount);
        await mockV2Router.setPresetAmount(weth.target, usdc.target, loanAmount + profit + premium);

        const steps = [
            {
                dexType: DEX_UNISWAP_V2,
                router: mockV2Router.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: intermediateAmount,
                data: "0x",
            },
            {
                dexType: DEX_UNISWAP_V2,
                router: mockV2Router.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 0,
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
    //  TEST: Slippage protection reverts when output is insufficient
    // ================================================================
    it("Should revert when per-hop slippage exceeds amountOutMin", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockUniRouter } = await loadFixture(deployFixture);

        const loanAmount = ethers.parseUnits("10000", 6);
        const intermediateAmount = ethers.parseUnits("3", 18); // Low output
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockUniRouter.target, intermediateAmount);

        await mockUniRouter.setPresetAmount(usdc.target, weth.target, intermediateAmount);

        const steps = [
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 3000,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: ethers.parseUnits("5", 18), // Expects 5 WETH but only gets 3
                data: "0x",
            },
            {
                dexType: DEX_UNISWAP_V3,
                router: mockUniRouter.target,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 3000,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: 0,
                data: "0x",
            }
        ];

        await expect(
            baseAlphaArb.executeArb(usdc.target, loanAmount, steps)
        ).to.be.reverted;
    });

    // ================================================================
    //  TEST: Router whitelist enforcement
    // ================================================================
    it("Should revert when router is not whitelisted", async function () {
        const { baseAlphaArb, usdc, weth } = await loadFixture(deployFixture);

        const fakeRouter = "0x0000000000000000000000000000000000000001";
        const steps = [
            {
                dexType: DEX_GENERIC,
                router: fakeRouter,
                tokenIn: usdc.target,
                tokenOut: weth.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: 0,
                data: "0x1234",
            },
            {
                dexType: DEX_GENERIC,
                router: fakeRouter,
                tokenIn: weth.target,
                tokenOut: usdc.target,
                fee: 0,
                stable: false,
                factory: ethers.ZeroAddress,
                amountOutMin: 0,
                data: "0x1234",
            }
        ];

        await expect(
            baseAlphaArb.executeArb(usdc.target, 1000, steps)
        ).to.be.revertedWith("Router not whitelisted");
    });

    // ================================================================
    //  TEST: Only owner can execute
    // ================================================================
    it("Should revert when non-owner calls executeArb", async function () {
        const { baseAlphaArb, otherAccount, usdc, weth, mockAggregator } = await loadFixture(deployFixture);

        const steps = [{
            dexType: DEX_GENERIC,
            router: mockAggregator.target,
            tokenIn: usdc.target,
            tokenOut: weth.target,
            fee: 0,
            stable: false,
            factory: ethers.ZeroAddress,
            amountOutMin: 0,
            data: "0x1234",
        }];

        await expect(
            baseAlphaArb.connect(otherAccount).executeArb(usdc.target, 1000, steps)
        ).to.be.reverted;
    });

    // ================================================================
    //  TEST: Path connectivity validation
    // ================================================================
    it("Should revert when path is not connected", async function () {
        const { baseAlphaArb, usdc, weth, dai, mockAggregator } = await loadFixture(deployFixture);

        const steps = [
            {
                dexType: DEX_GENERIC,
                router: mockAggregator.target,
                tokenIn: usdc.target,
                tokenOut: weth.target, // outputs WETH
                fee: 0, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: 0, data: "0x1234",
            },
            {
                dexType: DEX_GENERIC,
                router: mockAggregator.target,
                tokenIn: dai.target, // expects DAI but previous outputs WETH
                tokenOut: usdc.target,
                fee: 0, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: 0, data: "0x1234",
            }
        ];

        await expect(
            baseAlphaArb.executeArb(usdc.target, 1000, steps)
        ).to.be.revertedWith("Path not connected");
    });

    // ================================================================
    //  TEST: Withdraw profits
    // ================================================================
    it("Should allow owner to withdraw accumulated profits", async function () {
        const { baseAlphaArb, owner, usdc, weth, aavePool, mockAggregator } = await loadFixture(deployFixture);

        // Execute a profitable trade first
        const loanAmount = ethers.parseUnits("10000", 6);
        const profit = ethers.parseUnits("100", 6);
        const intermediateAmount = ethers.parseUnits("5", 18);
        const premium = (loanAmount * 9n) / 10000n;

        await usdc.mint(aavePool.target, loanAmount + premium);
        await weth.mint(mockAggregator.target, intermediateAmount);
        await usdc.mint(mockAggregator.target, loanAmount + profit + premium);

        const hop1Data = mockAggregator.interface.encodeFunctionData("swap", [
            usdc.target, weth.target, loanAmount, intermediateAmount
        ]);
        const hop2Data = mockAggregator.interface.encodeFunctionData("swap", [
            weth.target, usdc.target, intermediateAmount, loanAmount + profit + premium
        ]);

        const steps = [
            {
                dexType: DEX_GENERIC, router: mockAggregator.target,
                tokenIn: usdc.target, tokenOut: weth.target,
                fee: 0, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: intermediateAmount, data: hop1Data,
            },
            {
                dexType: DEX_GENERIC, router: mockAggregator.target,
                tokenIn: weth.target, tokenOut: usdc.target,
                fee: 0, stable: false, factory: ethers.ZeroAddress,
                amountOutMin: loanAmount + profit, data: hop2Data,
            }
        ];

        await baseAlphaArb.executeArb(usdc.target, loanAmount, steps);

        // Withdraw profits
        const ownerBalanceBefore = await usdc.balanceOf(owner.address);
        await baseAlphaArb.withdraw(usdc.target);
        const ownerBalanceAfter = await usdc.balanceOf(owner.address);
        expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(profit);
    });
});
