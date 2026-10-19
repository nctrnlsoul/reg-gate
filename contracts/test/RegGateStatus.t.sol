// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RegGateStatus} from "../src/RegGateStatus.sol";

// Minimal cheatcode interface, so the tests need no external libraries.
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function chainId(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
}

contract RegGateStatusTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant FORWARDER = address(0xF0);
    address constant REVIEWER = address(0xBEEF);
    address constant AUTHOR = address(0xA11CE);
    address constant ATTACKER = address(0xBAD);
    uint64 constant MAX_AGE = 2 days;
    uint64 constant T0 = 1_792_375_163;

    RegGateStatus gate;

    bytes32 constant DOC_A = bytes32("2026-16796");
    bytes32 constant DOC_B = bytes32("2026-20000");

    function setUp() public {
        vm.warp(T0);
        gate = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER);
    }

    // ------------------------------------------------------------ helpers

    function _report(uint256 chainId, uint64 asOf, uint8[4] memory s, bytes32[4] memory d) internal pure returns (bytes memory) {
        return abi.encode(chainId, asOf, s, d);
    }

    function _meta(address author) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10("reggate"), author, bytes2(0x0001));
    }

    function _all(uint8 s) internal pure returns (uint8[4] memory out) {
        out = [s, s, s, s];
    }

    function _none() internal pure returns (bytes32[4] memory d) {}

    function _send(uint64 asOf, uint8[4] memory s, bytes32[4] memory d) internal {
        vm.prank(FORWARDER);
        gate.onReport(_meta(AUTHOR), _report(block.chainid, asOf, s, d));
    }

    function _eq(uint256 a, uint256 b, string memory why) internal pure {
        require(a == b, why);
    }

    // ------------------------------------------------------- construction

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(RegGateStatus.ZeroAddress.selector);
        new RegGateStatus(address(0), MAX_AGE, REVIEWER);
        vm.expectRevert(RegGateStatus.ZeroAddress.selector);
        new RegGateStatus(FORWARDER, MAX_AGE, address(0));
        vm.expectRevert(RegGateStatus.InvalidMaxAge.selector);
        new RegGateStatus(FORWARDER, 0, REVIEWER);
    }

    // ------------------------------------------------------- fail closed

    function test_blocksBeforeAnyReport() public view {
        for (uint8 i = 0; i < 4; i++) _eq(gate.statusOf(i), gate.BLOCK(), "no data must be BLOCK");
        require(!gate.isAllowed(0, false), "no data must not be allowed");
    }

    function test_blocksBeforeAnyReportEvenOnFreshChain() public {
        // On a new local chain block.timestamp can be below maxAge, so staleness math
        // alone would read empty storage (0 == OK) as fresh. The explicit no-data rule must catch it.
        vm.warp(1000);
        RegGateStatus fresh = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER);
        _eq(fresh.statusOf(0), fresh.BLOCK(), "empty storage must never read as OK");
    }

    function test_freshOkReportAllows() public {
        _send(T0, _all(0), _none());
        _eq(gate.statusOf(0), gate.OK(), "fresh OK");
        require(gate.isAllowed(0, true), "strict allows OK");
    }

    function test_staleReportBlocks() public {
        _send(T0, _all(0), _none());
        vm.warp(T0 + MAX_AGE + 1);
        _eq(gate.statusOf(2), gate.BLOCK(), "stale must be BLOCK");
    }

    function test_reviewPassesLenientButNotStrict() public {
        _send(T0, [uint8(1), 0, 0, 0], [DOC_A, bytes32(0), bytes32(0), bytes32(0)]);
        require(gate.isAllowed(0, false), "lenient lets REVIEW through");
        require(!gate.isAllowed(0, true), "strict stops REVIEW");
    }

    function test_invalidCategoryReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidCategory.selector, uint8(4)));
        gate.statusOf(4);
    }

    // ------------------------------------------------------- access control

    function test_rejectsNonForwarder() public {
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidSender.selector, ATTACKER));
        gate.onReport(_meta(AUTHOR), _report(block.chainid, T0, _all(0), _none()));
    }

    function test_rejectsWrongWorkflowOwnerOnceAuthorPinned() public {
        gate.setExpectedAuthor(AUTHOR);
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidAuthor.selector, ATTACKER));
        gate.onReport(_meta(ATTACKER), _report(block.chainid, T0, _all(0), _none()));
    }

    function test_acceptsPinnedAuthorWith64ByteMetadata() public {
        gate.setExpectedAuthor(AUTHOR);
        require(_meta(AUTHOR).length == 64, "fixture must be 64 bytes like production");
        _send(T0, _all(0), _none());
        _eq(gate.lastAsOf(), T0, "accepted");
    }

    function test_rejectsShortMetadataOnceAuthorPinned() public {
        gate.setExpectedAuthor(AUTHOR);
        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidMetadata.selector);
        gate.onReport(hex"00", _report(block.chainid, T0, _all(0), _none()));
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotOwner.selector);
        gate.setExpectedAuthor(ATTACKER);
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotOwner.selector);
        gate.setReviewer(ATTACKER);
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotOwner.selector);
        gate.transferOwnership(ATTACKER);
    }

    // ------------------------------------------------------- replay defenses

    function test_rejectsReplayAndOlderReports() public {
        _send(T0, _all(0), _none());
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.StaleOrReplayed.selector, T0, T0));
        gate.onReport(_meta(AUTHOR), _report(block.chainid, T0, _all(2), _none()));
    }

    function test_rejectsWrongChain() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.WrongChain.selector, uint256(1)));
        gate.onReport(_meta(AUTHOR), _report(1, T0, _all(0), _none()));
    }

    function test_rejectsFarFutureReport() public {
        uint64 future = T0 + 1 days;
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.FutureReport.selector, future));
        gate.onReport(_meta(AUTHOR), _report(block.chainid, future, _all(0), _none()));
    }

    function test_rejectsOutOfRangeStatus() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidStatus.selector, uint8(1), uint8(3)));
        gate.onReport(_meta(AUTHOR), _report(block.chainid, T0, [uint8(0), 3, 0, 0], _none()));
    }

    // ------------------------------------------------------- latch

    function test_blockLatchesThroughLaterOkReports() public {
        _send(T0, [uint8(2), 0, 0, 0], [DOC_A, bytes32(0), bytes32(0), bytes32(0)]);
        _send(T0 + 60, _all(0), _none());
        _eq(gate.statusOf(0), gate.BLOCK(), "latched BLOCK must survive an OK report");
        _eq(gate.statusOf(1), gate.OK(), "other categories unaffected");
    }

    function test_onlyReviewerClears() public {
        _send(T0, [uint8(2), 0, 0, 0], [DOC_A, bytes32(0), bytes32(0), bytes32(0)]);
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotReviewer.selector);
        gate.clearLatch(0);
    }

    function test_clearingNonLatchedReverts() public {
        vm.prank(REVIEWER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.NotLatched.selector, uint8(0)));
        gate.clearLatch(0);
    }

    function test_clearedSameDocReadsReviewNotOk() public {
        bytes32[4] memory d = [DOC_A, bytes32(0), bytes32(0), bytes32(0)];
        _send(T0, [uint8(2), 0, 0, 0], d);
        vm.prank(REVIEWER);
        gate.clearLatch(0);
        _send(T0 + 60, [uint8(2), 0, 0, 0], d); // same doc still in the lookback window
        _eq(gate.statusOf(0), gate.REVIEW(), "acknowledged doc downgrades to REVIEW, never OK");
        (bool latched,,) = gate.latchInfo(0);
        require(!latched, "same doc must not re-latch");
    }

    function test_newBlockingDocRelatchesAfterClear() public {
        _send(T0, [uint8(2), 0, 0, 0], [DOC_A, bytes32(0), bytes32(0), bytes32(0)]);
        vm.prank(REVIEWER);
        gate.clearLatch(0);
        _send(T0 + 60, [uint8(2), 0, 0, 0], [DOC_B, bytes32(0), bytes32(0), bytes32(0)]);
        _eq(gate.statusOf(0), gate.BLOCK(), "a new blocking document latches again");
    }

    function test_blockWithoutDocumentAlwaysLatches() public {
        _send(T0, [uint8(2), 0, 0, 0], _none());
        _eq(gate.statusOf(0), gate.BLOCK(), "BLOCK with no doc latches");
        vm.prank(REVIEWER);
        gate.clearLatch(0);
        _send(T0 + 60, [uint8(2), 0, 0, 0], _none());
        _eq(gate.statusOf(0), gate.BLOCK(), "empty doc can never match an acknowledgment");
    }

    function test_staleOverridesAcknowledgedReview() public {
        bytes32[4] memory d = [DOC_A, bytes32(0), bytes32(0), bytes32(0)];
        _send(T0, [uint8(2), 0, 0, 0], d);
        vm.prank(REVIEWER);
        gate.clearLatch(0);
        vm.warp(T0 + MAX_AGE + 1);
        _eq(gate.statusOf(0), gate.BLOCK(), "staleness wins over everything");
    }

    function test_supportsReceiverInterface() public view {
        require(gate.supportsInterface(0x805f2132), "IReceiver.onReport selector id");
        require(gate.supportsInterface(0x01ffc9a7), "IERC165");
        require(!gate.supportsInterface(0xffffffff), "unknown id");
    }
}
