# FlashBot - AAVE V3 Flash Loan Arbitrage Bot PRD

## Original Problem Statement
Fix the arbitrage bot using AAVE V3 flash loans with DeFi arbitrage strategies to be a fully functional mainnet production version bot on Base chain, with all top Base DEXes and DEX aggregator integration.

## Architecture
- **Bot Engine**: Node.js (ethers.js v6) in `/app/src/`
- **Smart Contract**: Solidity 0.8.24 (BaseAlphaArb.sol) using Aave V3 FlashLoanSimpleReceiverBase
  - Typed DEX interfaces: Uniswap V3 (ISwapRouter02), Aerodrome (IAerodromeRouter), PancakeSwap V3
  - Generic calldata execution for aggregators (Odos)
  - SafeERC20, router whitelisting, per-hop balance checks
- **Dashboard Backend**: Python FastAPI on port 8001
- **Dashboard Frontend**: React + Tailwind CSS on port 3000
- **Database**: MongoDB (shared state between bot and dashboard)
- **Target Network**: Base Mainnet (Chain ID: 8453)

## User Personas
- DeFi arbitrage traders operating flash loan bots on Base chain
- Bot operators monitoring PnL and adjusting risk parameters

## Core Requirements (Static)
1. AAVE V3 flash loan integration on Base chain
2. Multi-hop arbitrage path detection and execution
3. DEX integration: Uniswap V3, Aerodrome, PancakeSwap V3
4. DEX Aggregator: Odos (covers 50+ Base DEXes)
5. Real-time monitoring dashboard
6. Adjustable risk/gas management settings

## What's Been Implemented

### Feb 17, 2026 - Initial Fixes
- Fixed all DEX contract addresses for Base chain
- Fixed Uniswap V3 QuoterV2 integration
- Fixed Aerodrome Router ABI (Route struct)
- Removed Flashbots (not on Base), CoW Swap (not on Base)
- Fixed Odos aggregator API endpoints
- Built monitoring dashboard (React + FastAPI + MongoDB)

### Feb 17, 2026 - Smart Contract Production Rewrite
- **Typed DEX Interfaces**: Contract natively calls `exactInputSingle()` for Uniswap V3 / PancakeSwap V3, and `swapExactTokensForTokens()` with Route struct for Aerodrome
- **Generic Calldata**: Supports `router.call(data)` for aggregators like Odos, with return value checking
- **SafeERC20**: All token operations use `forceApprove()` and `safeTransfer()` for non-standard tokens
- **Router Whitelisting**: Only pre-approved router addresses can be called (security)
- **Per-Hop Balance Checks**: Verifies tokenOut balance increased by >= amountOutMin after each step
- **Per-Hop Slippage Protection**: Each SwapStep has its own amountOutMin
- **Path Connectivity Validation**: Verifies each step's tokenIn matches previous step's tokenOut
- **Circular Path Validation**: First step tokenIn and last step tokenOut must match (the borrowed asset)
- **Events**: SwapExecuted per hop + ArbExecuted at completion
- **WETH Utilities**: wrap/unwrap functions for native ETH handling
- **11 Hardhat Tests Passing**: Generic, UniV3, Aerodrome, multi-DEX 3-hop, slippage, whitelist, ownership, connectivity, profitability

### Correct Base Chain Contract Addresses
- Uniswap V3 SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481
- Uniswap V3 QuoterV2: 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
- Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
- Aerodrome Factory: 0x420DD381b31aEf6683db6B902084cB0FFECe40Da
- PancakeSwap V3 SmartRouter: 0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86
- Odos Router V2: 0x19cEeAd7105607Cd444F5ad10dd51356436095a1
- Aave V3 Pool: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
- WETH: 0x4200000000000000000000000000000000000006

## Prioritized Backlog

### P0 - Before Mainnet
- [ ] Deploy BaseAlphaArb contract to Base mainnet
- [ ] Configure real wallet private key and RPC endpoints
- [ ] Whitelist all DEX routers on deployed contract
- [ ] Live test with small flash loan amounts

### P1 - Production Hardening
- [ ] Add WebSocket bot <-> dashboard communication
- [ ] Implement Flashblocks (200ms blocks on Base)
- [ ] Add multi-asset flash loan support
- [ ] Dynamic gas pricing based on Base L1 data costs
- [ ] Telegram/Discord alerts for profitable trades

### P2 - Optimization
- [ ] Mempool monitoring for reactive arbitrage
- [ ] Historical profit charting in dashboard
- [ ] Backtest mode using historical block data
- [ ] Portfolio tracking with token balance display
