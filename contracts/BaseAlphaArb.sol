// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ISwapRouter02.sol";
import "./interfaces/IAerodromeRouter.sol";
import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IWETH.sol";

/**
 * @title BaseAlphaArb
 * @notice Production-grade multi-hop flash loan arbitrage contract for Base chain.
 * Supports typed DEX interfaces (Uniswap V3, Aerodrome, PancakeSwap V3)
 * plus generic calldata execution for aggregators (Odos, etc.).
 *
 * Security: Router whitelisting, SafeERC20, per-hop balance checks,
 * per-hop slippage protection, reentrancy guard.
 */
contract BaseAlphaArb is FlashLoanSimpleReceiverBase, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================
    //                         CONSTANTS
    // ============================================================

    uint8 public constant DEX_GENERIC        = 0; // Raw calldata (Odos, SushiSwap RouteProcessor)
    uint8 public constant DEX_UNISWAP_V3    = 1; // Uniswap V3 exactInputSingle
    uint8 public constant DEX_AERODROME     = 2; // Aerodrome volatile/stable swap
    uint8 public constant DEX_PANCAKESWAP_V3 = 3; // PancakeSwap V3 exactInputSingle
    uint8 public constant DEX_UNISWAP_V2    = 4; // Uniswap V2 / BaseSwap (standard V2 AMM)

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /// @notice Defines a single atomic swap step in a multi-hop arbitrage path.
    struct SwapStep {
        uint8 dexType;          // DEX type (see constants above)
        address router;         // DEX router address (must be whitelisted)
        address tokenIn;        // Token to sell
        address tokenOut;       // Token to buy
        uint24 fee;             // V3 fee tier (100, 500, 3000, 10000) - for UNISWAP_V3/PANCAKESWAP_V3
        bool stable;            // Aerodrome pool type: true=stable, false=volatile
        address factory;        // Aerodrome pool factory address
        uint256 amountOutMin;   // Minimum output for this step (per-hop slippage protection)
        bytes data;             // Raw calldata (only used for DEX_GENERIC type)
    }

    // ============================================================
    //                          STORAGE
    // ============================================================

    /// @notice Whitelisted DEX router addresses that can be called
    mapping(address => bool) public whitelistedRouters;

    /// @notice WETH address on Base chain
    address public immutable WETH;

    /// @dev Temporary storage for flash loan callback execution
    SwapStep[] private _pendingSteps;
    bool private _inFlashLoan;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event RouterWhitelisted(address indexed router, bool status);
    event SwapExecuted(
        uint256 indexed stepIndex,
        uint8 dexType,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event ArbExecuted(address indexed asset, uint256 amount, uint256 profit);
    event ArbFailed(address indexed asset, uint256 amount, string reason);
    event Withdrawn(address indexed token, uint256 amount);

    // ============================================================
    //                        CONSTRUCTOR
    // ============================================================

    /**
     * @param poolProvider The address of the Aave V3 PoolAddressesProvider on Base
     * @param weth The WETH contract address on Base (0x4200000000000000000000000000000000000006)
     */
    constructor(address poolProvider, address weth)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(poolProvider))
        Ownable(msg.sender)
    {
        require(weth != address(0), "Invalid WETH");
        WETH = weth;
    }

    // ============================================================
    //                     ROUTER MANAGEMENT
    // ============================================================

    /**
     * @notice Whitelist or remove a DEX router address
     */
    function setRouterWhitelist(address router, bool status) external onlyOwner {
        require(router != address(0), "Zero address");
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
    }

    /**
     * @notice Batch whitelist DEX router addresses
     */
    function setRouterWhitelistBatch(address[] calldata routers, bool status) external onlyOwner {
        for (uint i = 0; i < routers.length; i++) {
            require(routers[i] != address(0), "Zero address");
            whitelistedRouters[routers[i]] = status;
            emit RouterWhitelisted(routers[i], status);
        }
    }

    // ============================================================
    //                     ARBITRAGE EXECUTION
    // ============================================================

    /**
     * @notice Initiates a flash loan and executes a multi-hop arbitrage trade.
     * Each step can use a different DEX with typed interface calls.
     *
     * @param asset The token to borrow (must be flash-loanable on Aave V3)
     * @param amount The amount to borrow
     * @param steps The sequence of atomic swap steps to execute
     */
    function executeArb(
        address asset,
        uint256 amount,
        SwapStep[] calldata steps
    ) external onlyOwner whenNotPaused nonReentrant {
        require(steps.length > 0, "No steps");
        require(steps.length <= 10, "Too many steps"); // Gas safety

        // Validate: first step's tokenIn must match the borrowed asset
        require(steps[0].tokenIn == asset, "First step tokenIn must match asset");
        // Validate: last step's tokenOut must match the borrowed asset (circular arb)
        require(steps[steps.length - 1].tokenOut == asset, "Last step tokenOut must match asset");

        // Validate all routers are whitelisted and path is connected
        for (uint i = 0; i < steps.length; i++) {
            require(whitelistedRouters[steps[i].router], "Router not whitelisted");
            require(steps[i].tokenIn != address(0), "Invalid tokenIn");
            require(steps[i].tokenOut != address(0), "Invalid tokenOut");
            // Verify path connectivity: each step's tokenIn must match previous step's tokenOut
            if (i > 0) {
                require(steps[i].tokenIn == steps[i - 1].tokenOut, "Path not connected");
            }
        }

        // Store steps in storage for the flash loan callback
        delete _pendingSteps;
        for (uint i = 0; i < steps.length; i++) {
            _pendingSteps.push(steps[i]);
        }
        _inFlashLoan = true;

        // Initiate flash loan - Aave will call executeOperation()
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            "", // params not needed - we use storage
            0   // referralCode
        );

        // Cleanup storage after execution
        delete _pendingSteps;
        _inFlashLoan = false;
    }

    /**
     * @notice Called by Aave V3 Pool after flash loan funds are received.
     * Executes all swap steps atomically and repays the loan + premium.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata /* params */
    ) external override returns (bool) {
        // Security: Only Aave Pool can call this, only we can initiate
        require(msg.sender == address(POOL), "Caller not Aave Pool");
        require(initiator == address(this), "Invalid initiator");
        require(_inFlashLoan, "Not in flash loan context");

        uint256 stepCount = _pendingSteps.length;
        require(stepCount > 0, "No steps to execute");

        // Execute each swap step with balance verification
        for (uint i = 0; i < stepCount; i++) {
            _executeSwapStep(i, _pendingSteps[i]);
        }

        // Verify we have enough to repay
        uint256 repayAmount = amount + premium;
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= repayAmount, "Insufficient to repay flash loan");

        uint256 profit = balanceAfter - repayAmount;
        emit ArbExecuted(asset, amount, profit);

        // Approve Aave Pool to pull repayment
        IERC20(asset).forceApprove(address(POOL), repayAmount);

        return true;
    }

    // ============================================================
    //                    INTERNAL SWAP LOGIC
    // ============================================================

    /**
     * @dev Executes a single swap step with full safety checks.
     * Records balance before, executes typed swap, verifies balance after.
     */
    function _executeSwapStep(uint256 stepIndex, SwapStep memory step) internal {
        // Record balances before swap
        uint256 tokenOutBalanceBefore = IERC20(step.tokenOut).balanceOf(address(this));
        uint256 amountIn = IERC20(step.tokenIn).balanceOf(address(this));
        require(amountIn > 0, string(abi.encodePacked("No input balance at step ", _toStr(stepIndex))));

        // Approve router to spend input tokens (using forceApprove for non-standard tokens)
        IERC20(step.tokenIn).forceApprove(step.router, amountIn);

        // Execute swap based on DEX type
        if (step.dexType == DEX_UNISWAP_V3) {
            _swapUniswapV3(step, amountIn);
        } else if (step.dexType == DEX_AERODROME) {
            _swapAerodrome(step, amountIn);
        } else if (step.dexType == DEX_PANCAKESWAP_V3) {
            _swapPancakeSwapV3(step, amountIn);
        } else if (step.dexType == DEX_UNISWAP_V2) {
            _swapUniswapV2(step, amountIn);
        } else if (step.dexType == DEX_GENERIC) {
            _swapGeneric(step);
        } else {
            revert("Unknown DEX type");
        }

        // Revoke approval for security
        IERC20(step.tokenIn).forceApprove(step.router, 0);

        // Verify output: tokenOut balance must have increased by at least amountOutMin
        uint256 tokenOutBalanceAfter = IERC20(step.tokenOut).balanceOf(address(this));
        uint256 amountOut = tokenOutBalanceAfter - tokenOutBalanceBefore;
        require(amountOut >= step.amountOutMin, string(abi.encodePacked("Slippage exceeded at step ", _toStr(stepIndex))));

        emit SwapExecuted(stepIndex, step.dexType, step.tokenIn, step.tokenOut, amountIn, amountOut);
    }

    /**
     * @dev Uniswap V3 typed swap via exactInputSingle
     */
    function _swapUniswapV3(SwapStep memory step, uint256 amountIn) internal {
        ISwapRouter02(step.router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: step.tokenIn,
                tokenOut: step.tokenOut,
                fee: step.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: step.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /**
     * @dev PancakeSwap V3 typed swap via exactInputSingle (same interface as Uniswap V3)
     */
    function _swapPancakeSwapV3(SwapStep memory step, uint256 amountIn) internal {
        ISwapRouter02(step.router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: step.tokenIn,
                tokenOut: step.tokenOut,
                fee: step.fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: step.amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /**
     * @dev Aerodrome typed swap via swapExactTokensForTokens with Route struct
     */
    function _swapAerodrome(SwapStep memory step, uint256 amountIn) internal {
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: step.tokenIn,
            to: step.tokenOut,
            stable: step.stable,
            factory: step.factory
        });

        IAerodromeRouter(step.router).swapExactTokensForTokens(
            amountIn,
            step.amountOutMin,
            routes,
            address(this),
            block.timestamp + 300 // 5 minute deadline
        );
    }

    /**
     * @dev Generic swap via raw calldata (for aggregators like Odos)
     */
    function _swapGeneric(SwapStep memory step) internal {
        require(step.data.length > 0, "No calldata for generic swap");
        (bool success, bytes memory returnData) = step.router.call(step.data);
        if (!success) {
            // Try to extract revert reason
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert("Generic swap failed");
        }
    }

    // ============================================================
    //                     WETH UTILITIES
    // ============================================================

    /**
     * @notice Wrap ETH to WETH
     */
    function wrapETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to wrap");
        IWETH(WETH).deposit{value: balance}();
    }

    /**
     * @notice Unwrap WETH to ETH
     * @param amount Amount of WETH to unwrap
     */
    function unwrapETH(uint256 amount) external onlyOwner {
        IWETH(WETH).withdraw(amount);
    }

    // ============================================================
    //                      FUND MANAGEMENT
    // ============================================================

    /**
     * @notice Withdraw accumulated profit tokens
     */
    function withdraw(address token) external onlyOwner {
        uint256 amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "No balance to withdraw");
        IERC20(token).safeTransfer(owner(), amount);
        emit Withdrawn(token, amount);
    }

    /**
     * @notice Withdraw specific amount of tokens
     */
    function withdrawAmount(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransfer(owner(), amount);
        emit Withdrawn(token, amount);
    }

    /**
     * @notice Withdraw ETH to owner
     */
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH");
        payable(owner()).transfer(balance);
    }

    /**
     * @notice Rescue accidentally sent ERC20 tokens
     */
    function rescueERC20(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransfer(owner(), amount);
    }

    // ============================================================
    //                    PAUSE / RECEIVE
    // ============================================================

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Accept ETH (for WETH unwrapping)
    receive() external payable {}

    // ============================================================
    //                         HELPERS
    // ============================================================

    function _toStr(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
