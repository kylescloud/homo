// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";

contract MockPoolAddressesProvider is IPoolAddressesProvider {
    address private pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getPool() external view returns (address) {
        return pool;
    }

    // --- Fully Implemented IPoolAddressesProvider Interface ---
    function setPoolImpl(address) external {}
    function getPoolImpl() external view returns (address) { return address(0); }
    function setPoolConfiguratorImpl(address) external {}
    function getPoolConfigurator() external view returns (address) { return address(0); }
    function getPoolConfiguratorImpl() external view returns (address) { return address(0); }
    function setPriceOracle(address) external {}
    function getPriceOracle() external view returns (address) { return address(0); }
    function setACLManager(address) external {}
    function getACLManager() external view returns (address) { return address(0); }
    function setACLAdmin(address) external {}
    function getACLAdmin() external view returns (address) { return address(0); }
    function setPriceOracleSentinel(address) external {}
    function getPriceOracleSentinel() external view returns (address) { return address(0); }
    function setDataProvider(address) external {}
    function getDataProvider() external view returns (address) { return address(0); }
    function setPoolDataProvider(address) external {}
    function getPoolDataProvider() external view returns (address) { return address(0); }
    function getMarketId() external view returns (string memory) { return ""; }
    function setMarketId(string calldata) external {}
    function getAddress(bytes32) external view returns (address) { return address(0); }
    function setAddress(bytes32, address) external {}
    function setAddressAsProxy(bytes32, address) external {}
}
