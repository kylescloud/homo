# FlashBot - AAVE V3 Flash Loan Arbitrage Bot PRD

## Original Problem Statement
Fix the arbitrage bot using AAVE V3 flash loans with DeFi arbitrage strategies to be a fully functional mainnet production version bot on Base chain, with all top Base DEXes and DEX aggregator integration.

## Architecture
- **Bot Engine**: Node.js (ethers.js v6) in `/app/src/`
- **Smart Contract**: Solidity 0.8.24 (BaseAlphaArb.sol) using Aave V3 FlashLoanSimpleReceiverBase
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

## What's Been Implemented (Feb 17, 2026)

### Bot Core Fixes
- Fixed all DEX contract addresses for Base chain (was using Ethereum mainnet addresses)
- Fixed Uniswap V3 QuoterV2 integration (was using V1 QuoterV1 ABI)
- Fixed Aerodrome Router ABI (now uses Route struct instead of V2-style address[] path)
- Removed Flashbots MEV protection (not available on Base - uses centralized sequencer)
- Removed CoW Swap integration (not deployed on Base chain)
- Fixed Odos aggregator API (correct v2 endpoints)
- Fixed opportunity scanner (removed broken 1inch reference, fixed swap data format)
- Fixed profit calculator (correct AAVE V3 flash loan premium: 0.05% on Base)
- Added fallback Aave V3 assets when RPC unavailable
- Improved path generator (capped at 4 hops for gas efficiency, max 2000 paths)
- Fixed wallet.js to handle missing private key (scan-only mode)

### Smart Contract
- BaseAlphaArb.sol compiles and passes all tests (2-hop and 3-hop multi-hop tests)
- Hardhat configuration updated for Base mainnet deployment

### Monitoring Dashboard
- Full cyberpunk terminal-style dashboard
- Stats cards: Net Profit, Win Rate, Total Trades, Opportunities, Best Trade, Avg Profit
- Opportunities table with real-time status badges
- Trade history with TX hash links to Basescan
- Live log viewer with color-coded severity levels
- Adjustable settings panel (gas, profit threshold, flash loan limits, slippage, scan interval)

### Correct Base Chain DEX Addresses
- Uniswap V3 SwapRouter02: 0x2626664c2603336E57B271c5C0b26F421741e481
- Uniswap V3 QuoterV2: 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
- Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
- PancakeSwap V3 SmartRouter: 0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86
- Odos Router V2: 0x19cEeAd7105607Cd444F5ad10dd51356436095a1
- Aave V3 Pool: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5

## Prioritized Backlog

### P0 - Before Mainnet
- [ ] Deploy BaseAlphaArb contract to Base mainnet
- [ ] Configure real wallet private key and RPC endpoints
- [ ] Live test with small flash loan amounts

### P1 - Production Hardening
- [ ] Add WebSocket bot <-> dashboard communication (replace polling)
- [ ] Implement Flashblocks (200ms blocks on Base via Flashbots collab)
- [ ] Add multi-asset flash loan support (not just single asset)
- [ ] Implement dynamic gas pricing based on Base L1 data costs
- [ ] Add Telegram/Discord alerts for profitable trades

### P2 - Optimization
- [ ] Implement mempool monitoring for reactive arbitrage
- [ ] Add historical profit charting in dashboard
- [ ] Implement backtest mode using historical block data
- [ ] Add portfolio tracking with token balance display
- [ ] Consider SushiSwap V3 and Maverick V2 direct integrations

## Next Tasks
1. Deploy smart contract to Base mainnet (requires funded wallet)
2. Connect bot to live RPC with real-time scanning
3. Add WebSocket for real-time dashboard updates
4. Implement profit/loss charting over time
