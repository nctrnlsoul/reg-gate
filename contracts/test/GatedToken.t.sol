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
        gate = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER, address(0), true); // simulation mode
        lenient = new GatedToken("Gated USD", "gUSD", address(gate), STABLECOINS, false, 1_000 ether);
        strictToken = new GatedToken("Gated Asset", "gAST", address(gate), MARKETS, true, 1_000 ether);
    }

    /// Every BLOCK category lists its trigger document, as the workflow does.
    function _report(uint64 asOf, uint8[4] memory s, bytes32[4] memory d) internal {
        uint256 n;
        for (uint256 i = 0; i < 4; i++) if (s[i] == 2 && d[i] != bytes32(0)) n++;
        bytes32[] memory bd = new bytes32[](n);
        uint8[] memory bc = new uint8[](n);
        uint256 k;
        for (uint8 i = 0; i < 4; i++) {
            if (s[i] == 2 && d[i] != bytes32(0)) (bd[k], bc[k], k) = (d[i], i, k + 1);
        }
        vm.prank(FORWARDER);
        gate.onReport("", abi.encode(block.chainid, asOf, s, d, bd, bc));
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
        gate.clearLatch(STABLECOINS, DOC);
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

    function test_constructorRejectsZeroGate() public {
        vm.expectRevert(GatedToken.ZeroAddress.selector);
        new GatedToken("Bad", "BAD", address(0), 0, false, 1);
    }

    function test_transferToZeroAddressReverts() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        vm.expectRevert(GatedToken.ZeroAddress.selector);
        lenient.transfer(address(0), 1);
    }

    function test_zeroValueTransferIsStillGated() public {
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, STABLECOINS, uint8(2)));
        lenient.transfer(ALICE, 0);
    }

    function test_maxAllowanceIsNotSpent() public {
        _report(T0, [uint8(0), 0, 0, 0], _noDocs());
        lenient.approve(BOB, type(uint256).max);
        vm.prank(BOB);
        lenient.transferFrom(address(this), ALICE, 1 ether);
        require(lenient.allowance(address(this), BOB) == type(uint256).max, "max allowance untouched");
    }

    function test_blockedTransferFromLeavesAllowanceUntouched() public {
        _report(T0, [uint8(2), 0, 0, 0], [DOC, bytes32(0), bytes32(0), bytes32(0)]);
        lenient.approve(BOB, 5 ether);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(GatedToken.TransferBlockedByRegGate.selector, STABLECOINS, uint8(2)));
        lenient.transferFrom(address(this), ALICE, 1 ether);
        require(lenient.allowance(address(this), BOB) == 5 ether, "revert rolled the allowance back");
    }

    function test_reviewedBlockPassesLenientNotStrict() public {
        // Both tokens on MARKETS for a like-for-like comparison.
        GatedToken lenientMarkets = new GatedToken("L", "L", address(gate), MARKETS, false, 1_000 ether);
        bytes32[4] memory d = [bytes32(0), bytes32(0), DOC, bytes32(0)];
        _report(T0, [uint8(0), 0, 2, 0], d);
        vm.prank(REVIEWER);
        gate.clearLatch(MARKETS, DOC);
        _report(T0 + 60, [uint8(0), 0, 2, 0], d); // the reviewed document is still reported
        require(lenientMarkets.transfersAllowed(), "reviewed BLOCK reads REVIEW: lenient passes");
        require(!strictToken.transfersAllowed(), "strict still stops on REVIEW");
    }
}
