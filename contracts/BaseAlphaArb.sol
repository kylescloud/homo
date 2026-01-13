// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BaseAlphaArb
 * @author Jules
 * @notice This contract executes arbitrage trades on Base network using Aave V3 flash loans.
 * It is designed to be called by a trusted off-chain bot.
 */
contract BaseAlphaArb is FlashLoanSimpleReceiverBase, Ownable, Pausable, ReentrancyGuard {

    // Event to log the outcome of an arbitrage execution
    event ArbExecuted(
        address indexed asset,
        uint256 amount,
        uint256 profit,
        bool success
    );

    // Event to log profit withdrawal
    event Withdrawn(address indexed token, uint256 amount);

    /**
     * @param poolProvider The address of the Aave V3 PoolAddressesProvider
     */
    constructor(address poolProvider)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(poolProvider))
        Ownable(msg.sender)
    {}

    /// @dev Defines a single hop in a multi-hop swap path.
    struct Hop {
        address target; // The DEX/aggregator router address
        bytes data;     // The calldata for the swap
    }

    /**
     * @notice Initiates a flash loan for a multi-hop arbitrage trade.
     * @dev Can only be called by the owner (the off-chain bot).
     * @param tokens The sequence of token addresses in the trade path (e.g., [USDC, WETH, USDC]).
     * @param hops The sequence of swaps to be executed.
     * @param amount The amount of the initial token to be borrowed.
     */
    function executeArb(
        address[] calldata tokens,
        Hop[] calldata hops,
        uint256 amount
    ) external onlyOwner whenNotPaused nonReentrant {
        require(tokens.length == hops.length + 1, "Invalid path: tokens and hops length mismatch");
        address asset = tokens[0];
        bytes memory params = abi.encode(tokens, hops);

        POOL.flashLoanSimple(
            address(this), // receiverAddress
            asset,
            amount,
            params,
            0 // referralCode
        );
    }

    /**
     * @notice This function is called by the Aave V3 Pool after the flash loan is funded.
     * It executes the full sequence of arbitrage trades and repays the loan.
     * @param asset The address of the token that was borrowed.
     * @param amount The amount of the token that was borrowed.
     * @param premium The fee charged by Aave for the flash loan.
     * @param initiator The address that initiated the flash loan (this contract).
     * @param params The encoded data passed from executeArb, containing the token path and hops.
     * @return A boolean indicating the success of the operation.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Not from Aave Pool");
        require(initiator == address(this), "Invalid initiator");

        (address[] memory tokens, Hop[] memory hops) = abi.decode(params, (address[], Hop[]));

        // Execute all swaps in the multi-hop path
        for (uint i = 0; i < hops.length; i++) {
            address fromToken = tokens[i];
            Hop memory hop = hops[i];

            // Approve the target to spend the full balance of the fromToken
            uint256 amountIn = IERC20(fromToken).balanceOf(address(this));
            IERC20(fromToken).approve(hop.target, amountIn);

            // Execute the swap
            (bool success, ) = hop.target.call(hop.data);
            require(success, "Swap failed");

            // Revoke approval for security
            IERC20(fromToken).approve(hop.target, 0);
        }

        // Check profit and emit event
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 repayAmount = amount + premium;

        require(balanceAfter >= repayAmount, "Insufficient funds to repay loan");

        uint256 profit = balanceAfter - repayAmount;
        emit ArbExecuted(asset, amount, profit, true);

        // Approve the pool to pull back the funds
        IERC20(asset).approve(address(POOL), repayAmount);

        return true;
    }

    /**
     * @notice Withdraws accumulated profit tokens from the contract.
     * @dev Can only be called by the owner.
     * @param token The address of the ERC20 token to withdraw.
     */
    function withdraw(address token) external onlyOwner {
        uint256 amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "No balance to withdraw");
        IERC20(token).transfer(owner(), amount);
        emit Withdrawn(token, amount);
    }

    /**
     * @notice Rescues ERC20 tokens that were accidentally sent to this contract.
     * @dev Can only be called by the owner.
     * @param token The address of the token to rescue.
     * @param amount The amount of tokens to rescue.
     */
    function rescueERC20(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be greater than 0");
        IERC20(token).transfer(owner(), amount);
    }

    /**
     * @notice Pauses the contract, preventing new arbitrage executions.
     * @dev Can only be called by the owner.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract, re-enabling arbitrage executions.
     * @dev Can only be called by the owner.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Allows the contract to receive ETH.
     */
    receive() external payable {}
}
