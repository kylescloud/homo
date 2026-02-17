const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying BaseAlphaArb with account:", deployer.address);

    // Base Mainnet addresses
    const AAVE_POOL_ADDRESSES_PROVIDER = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";
    const WETH = "0x4200000000000000000000000000000000000006";

    // Deploy the contract
    const BaseAlphaArb = await hre.ethers.getContractFactory("BaseAlphaArb");
    const baseAlphaArb = await BaseAlphaArb.deploy(AAVE_POOL_ADDRESSES_PROVIDER, WETH);
    await baseAlphaArb.waitForDeployment();

    const contractAddress = await baseAlphaArb.getAddress();
    console.log("BaseAlphaArb deployed to:", contractAddress);

    // Whitelist DEX routers on Base
    const routers = [
        "0x2626664c2603336E57B271c5C0b26F421741e481", // Uniswap V3 SwapRouter02
        "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome Router
        "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", // PancakeSwap V3 SmartRouter
        "0x19cEeAd7105607Cd444F5ad10dd51356436095a1", // Odos Router V2
    ];

    console.log("Whitelisting DEX routers...");
    const tx = await baseAlphaArb.setRouterWhitelistBatch(routers, true);
    await tx.wait();
    console.log("Routers whitelisted:", routers);

    console.log("\n=== Deployment Complete ===");
    console.log("Contract:", contractAddress);
    console.log("Owner:", deployer.address);
    console.log("WETH:", WETH);
    console.log("\nUpdate config/config.json with:");
    console.log(`  "contractAddress": { "base": "${contractAddress}" }`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
