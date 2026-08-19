// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Shared state and behaviour of the test tokens, minus `transferFrom`.
/// @dev `transferFrom` is left to the subclasses because the three variants
///      differ in their return type, which makes overriding impossible: they
///      have to be siblings rather than a chain.
abstract contract MockERC20Base {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function _spendAllowance(address from, uint256 amount) internal {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Well-behaved ERC-20 for unit tests. Test infrastructure only; nothing
///         in the demo path ever touches a mock.
contract MockERC20 is MockERC20Base {
    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20Base(name_, symbol_, decimals_)
    {}

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        return true;
    }
}

/// @notice A token whose `transferFrom` reports failure by returning false
///         instead of reverting, the way some real tokens do.
/// @dev Exists so the test suite can show that the gateway checks the return
///      value rather than assuming a revert.
contract FalseReturningERC20 is MockERC20Base {
    constructor() MockERC20Base("False", "FALSE", 18) {}

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice A token whose `transferFrom` returns nothing at all, like USDT.
/// @dev The gateway must treat an empty return as success, which is what
///      distinguishes a safe wrapper from a bare interface call.
contract NoReturnERC20 is MockERC20Base {
    constructor() MockERC20Base("NoReturn", "NORET", 6) {}

    function transferFrom(address from, address to, uint256 amount) external {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
    }
}
