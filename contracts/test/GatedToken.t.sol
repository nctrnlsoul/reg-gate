// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegGateStatus} from "../src/RegGateStatus.sol";
import {GatedToken} from "../src/GatedToken.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
}

/// End-to-end on-chain story: a report arrives through the forwarder and a
/// real token's transfers start or stop because of it.
contract GatedTokenTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant FORWARDER = address(0xF0);
    address constant REVIEWER = address(0xBEEF);
    address constant ALICE = address(0xA1);
    address constant BOB = address(0xB0B);
    uint64 constant MAX_AGE = 2 days;
    uint64 constant T0 = 1_792_375_163;
    uint8 constant STABLECOINS = 0;
    uint8 constant MARKETS = 2;
    bytes32 constant DOC = bytes32("2026-20466");

    RegGateStatus gate;
    GatedToken lenient; // STABLECOINS, blocks only on BLOCK
    GatedToken strictToken; // MARKETS, passes only on OK

    function setUp() public {
        vm.warp(T0);
        gate = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER);
        lenient = new GatedToken("Gated USD", "gUSD", address(gate), STABLECOINS, false, 1_000 ether);
        strictToken = new GatedToken("Gated Asset", "gAST", address(gate), MARKETS, true, 1_000 ether);
    }

    function _report(uint64 asOf, uint8[4] memory s, bytes32[4] memory d) internal {
        vm.prank(FORWARDER);
        gate.onReport("", abi.encode(block.chainid, asOf, s, d));
    }

    function _noDocs() internal pure returns (bytes32[4] memory d) {}

    function test_noReportYetBlocksEveryTransfer() public {
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, STABLECOINS, uint8(2)));
        lenient.transfer(ALICE, 1 ether);
    }

    function test_okReportAllowsTransfers() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        lenient.transfer(ALICE, 1 ether);
        strictToken.transfer(ALICE, 1 ether);
        require(lenient.balanceOf(ALICE) == 1 ether && strictToken.balanceOf(ALICE) == 1 ether, "moved");
    }

    function test_reviewSplitsStrictAndLenient() public {
        // Mirrors the live 2026-10-18 run: STABLECOINS OK, others REVIEW.
        _report(T0, [uint8(0), 1, 1, 1], [bytes32(0), DOC, DOC, DOC]);
        lenient.transfer(ALICE, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, MARKETS, uint8(1)));
        strictToken.transfer(ALICE, 1 ether);
        require(lenient.transfersAllowed() && !strictToken.transfersAllowed(), "view matches behaviour");
    }

    function test_blockStopsEvenLenientAndTransferFrom() public {
        _report(T0, [uint8(2), 0, 0, 0], [DOC, bytes32(0), bytes32(0), bytes32(0)]);
        lenient.approve(BOB, 5 ether);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, STABLECOINS, uint8(2)));
        lenient.transferFrom(address(this), ALICE, 1 ether);
    }

    function test_staleDataStopsTransfers() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        vm.warp(T0 + MAX_AGE + 1);
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, STABLECOINS, uint8(2)));
        lenient.transfer(ALICE, 1 ether);
    }

    function test_latchHoldsUntilReviewerClearsThenReviewPasses() public {
        bytes32[4] memory d = [DOC, bytes32(0), bytes32(0), bytes32(0)];
        _report(T0, [uint8(2), 0, 0, 0], d);
        _report(T0 + 60, [uint8(0), 0, 0, 0], _noDocs());
        require(!lenient.transfersAllowed(), "latched BLOCK survives an OK report");

        vm.prank(REVIEWER);
        gate.clearLatch(STABLECOINS);
        lenient.transfer(ALICE, 1 ether); // latest report is OK and latch cleared
        require(lenient.balanceOf(ALICE) == 1 ether, "moved after clear");
    }

    function test_badCategoryFailsAtDeploy() public {
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidCategory.selector, uint8(7)));
        new GatedToken("Bad", "BAD", address(gate), 7, false, 1);
    }

    function test_transferFromSpendsAllowance() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        lenient.approve(BOB, 5 ether);
        vm.prank(BOB);
        lenient.transferFrom(address(this), ALICE, 3 ether);
        require(lenient.allowance(address(this), BOB) == 2 ether, "allowance reduced");
        vm.prank(BOB);
        vm.expectRevert(GatedToken.InsufficientAllowance.selector);
        lenient.transferFrom(address(this), ALICE, 3 ether);
    }

    function test_balanceAndAllowanceStillEnforced() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        vm.prank(ALICE);
        vm.expectRevert(GatedToken.InsufficientBalance.selector);
        lenient.transfer(BOB, 1);
        vm.prank(BOB);
        vm.expectRevert(GatedToken.InsufficientAllowance.selector);
        lenient.transferFrom(address(this), BOB, 1);
    }
}
