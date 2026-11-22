// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test helper only. The Sepolia flow uses the Lab 3 `MySimpleToken`
///      deployment (MST_ADDRESS); this local token exists so the Hardhat test
///      suite can run without touching a public testnet.
contract TestMST is ERC20 {
    constructor(address owner, uint256 supply) ERC20("Test My Simple Token", "tMST") {
        _mint(owner, supply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
