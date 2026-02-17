// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IUniswapV2Router02.sol";

/**
 * @title MockUniswapV2Router
 * @notice Mock implementation of standard V2 Router for testing (Uniswap V2 / BaseSwap)
 */
contract MockUniswapV2Router {
    // Preset exchange rates
    mapping(address => mapping(address => uint256)) public presetAmounts;

    function setPresetAmount(address tokenIn, address tokenOut, uint256 amountOut) external {
        presetAmounts[tokenIn][tokenOut] = amountOut;
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(path.length == 2, "Mock only supports direct swaps");
        require(deadline >= block.timestamp, "Expired");

        address tokenIn = path[0];
        address tokenOut = path[1];
        uint256 amountOut = presetAmounts[tokenIn][tokenOut];
        require(amountOut > 0, "No preset amount");
        require(amountOut >= amountOutMin, "Insufficient output");

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
        return amounts;
    }

    function getAmountsOut(
        uint amountIn,
        address[] calldata path
    ) external view returns (uint[] memory amounts) {
        require(path.length == 2, "Mock only supports direct paths");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = presetAmounts[path[0]][path[1]];
        return amounts;
    }

    function factory() external pure returns (address) {
        return address(0);
    }

    function WETH() external pure returns (address) {
        return address(0);
    }
}
