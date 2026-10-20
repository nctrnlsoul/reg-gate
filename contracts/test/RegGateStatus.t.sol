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
    function load(address, bytes32) external view returns (bytes32);
    function store(address, bytes32, bytes32) external;
}

contract RegGateStatusTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant FORWARDER = address(0xF0);
    address constant REVIEWER = address(0xBEEF);
    address constant AUTHOR = address(0xA11CE);
    address constant ATTACKER = address(0xBAD);
    address constant NEW_OWNER = address(0x0E);
    uint64 constant MAX_AGE = 2 days;
    uint64 constant T0 = 1_792_375_163;

    RegGateStatus gate; // production mode, author pinned at deploy

    bytes32 constant DOC_A = bytes32("2026-16796");
    bytes32 constant DOC_B = bytes32("2026-20000");
    bytes32 constant DOC_C = bytes32("2026-21000");

    function setUp() public {
        vm.warp(T0);
        gate = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER, AUTHOR, false);
    }

    // ------------------------------------------------------------ helpers

    bytes32[] noList;
    uint8[] noCats;

    function _encode(uint256 chainId, uint64 asOf, uint8[4] memory s, bytes32[4] memory d, bytes32[] memory bd, uint8[] memory bc)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(chainId, asOf, s, d, bd, bc);
    }

    function _meta(address author) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10("reggate"), author, bytes2(0x0001));
    }

    function _all(uint8 s) internal pure returns (uint8[4] memory out) {
        out = [s, s, s, s];
    }

    function _none() internal pure returns (bytes32[4] memory d) {}

    function _one(bytes32 doc) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](1);
        l[0] = doc;
    }

    function _two(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = a;
        l[1] = b;
    }

    function _cats(uint256 n, uint8 c) internal pure returns (uint8[] memory l) {
        l = new uint8[](n);
        for (uint256 i = 0; i < n; i++) l[i] = c;
    }

    function _send(uint64 asOf, uint8[4] memory s, bytes32[4] memory d) internal {
        _sendList(asOf, s, d, noList, noCats);
    }

    function _sendList(uint64 asOf, uint8[4] memory s, bytes32[4] memory d, bytes32[] memory bd, uint8[] memory bc) internal {
        vm.prank(FORWARDER);
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, asOf, s, d, bd, bc));
    }

    /// BLOCK in category 0 on the given documents (first one is the trigger).
    function _block0(uint64 asOf, bytes32[] memory docs) internal {
        _sendList(asOf, [uint8(2), 0, 0, 0], [docs[0], bytes32(0), bytes32(0), bytes32(0)], docs, _cats(docs.length, 0));
    }

    function _clear(uint8 c, bytes32 doc) internal {
        vm.prank(REVIEWER);
        gate.clearLatch(c, doc);
    }

    function _latched(uint8 c) internal view returns (bool l, bytes32 doc, uint256 unreviewed) {
        return gate.latchInfo(c);
    }

    function _eq(uint256 a, uint256 b, string memory why) internal pure {
        require(a == b, why);
    }

    // ------------------------------------------------------- construction

    function test_constructorRejectsZeroAddressesAndMissingAuthor() public {
        vm.expectRevert(RegGateStatus.ZeroAddress.selector);
        new RegGateStatus(address(0), MAX_AGE, REVIEWER, AUTHOR, false);
        vm.expectRevert(RegGateStatus.ZeroAddress.selector);
        new RegGateStatus(FORWARDER, MAX_AGE, address(0), AUTHOR, false);
        vm.expectRevert(RegGateStatus.InvalidMaxAge.selector);
        new RegGateStatus(FORWARDER, 0, REVIEWER, AUTHOR, false);
        // Production mode cannot be deployed without a pinned workflow owner.
        vm.expectRevert(RegGateStatus.AuthorNotSet.selector);
        new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER, address(0), false);
    }

    function test_simulationModeAcceptsUnpinnedAuthor() public {
        RegGateStatus sim = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER, address(0), true);
        require(sim.simulation(), "flag set");
        vm.prank(FORWARDER);
        sim.onReport("", _encode(block.chainid, T0, _all(0), _none(), noList, noCats));
        _eq(sim.lastAsOf(), T0, "simulation accepts without metadata");
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
        RegGateStatus fresh = new RegGateStatus(FORWARDER, MAX_AGE, REVIEWER, AUTHOR, false);
        _eq(fresh.statusOf(0), fresh.BLOCK(), "empty storage must never read as OK");
    }

    function test_freshOkReportAllows() public {
        _send(T0, _all(0), _none());
        _eq(gate.statusOf(0), gate.OK(), "fresh OK");
        require(gate.isAllowed(0, true), "strict allows OK");
    }

    function test_staleBoundary() public {
        _send(T0, _all(0), _none());
        vm.warp(T0 + MAX_AGE);
        _eq(gate.statusOf(2), gate.OK(), "exactly maxAge old is still fresh");
        vm.warp(T0 + MAX_AGE + 1);
        _eq(gate.statusOf(2), gate.BLOCK(), "one second past maxAge is BLOCK");
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
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, _all(0), _none(), noList, noCats));
    }

    function test_rejectsWrongWorkflowOwner() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidAuthor.selector, ATTACKER));
        gate.onReport(_meta(ATTACKER), _encode(block.chainid, T0, _all(0), _none(), noList, noCats));
    }

    function test_acceptsPinnedAuthorWith62And64ByteMetadata() public {
        require(_meta(AUTHOR).length == 64, "fixture must be 64 bytes like production");
        _send(T0, _all(0), _none());
        bytes memory m62 = abi.encodePacked(bytes32(uint256(1)), bytes10("reggate"), AUTHOR);
        vm.prank(FORWARDER);
        gate.onReport(m62, _encode(block.chainid, T0 + 1, _all(0), _none(), noList, noCats));
        _eq(gate.lastAsOf(), T0 + 1, "62-byte metadata accepted");
    }

    function test_rejectsShortMetadata() public {
        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidMetadata.selector);
        gate.onReport(hex"00", _encode(block.chainid, T0, _all(0), _none(), noList, noCats));
    }

    function test_authorCannotBeUnpinned() public {
        vm.expectRevert(RegGateStatus.ZeroAddress.selector);
        gate.setExpectedAuthor(address(0));
        gate.setExpectedAuthor(ATTACKER);
        _eq(uint160(gate.expectedAuthor()), uint160(ATTACKER), "owner can rotate the author");
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

    function test_twoStepOwnership() public {
        gate.transferOwnership(NEW_OWNER);
        _eq(uint160(gate.owner()), uint160(address(this)), "owner unchanged until accepted");
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotPendingOwner.selector);
        gate.acceptOwnership();
        vm.prank(NEW_OWNER);
        gate.acceptOwnership();
        _eq(uint160(gate.owner()), uint160(NEW_OWNER), "accepted");
        _eq(uint160(gate.pendingOwner()), 0, "pending cleared");
        vm.expectRevert(RegGateStatus.NotOwner.selector);
        gate.setReviewer(ATTACKER);
    }

    function test_newReviewerCanClear() public {
        gate.setReviewer(ATTACKER);
        _block0(T0, _one(DOC_A));
        vm.prank(REVIEWER);
        vm.expectRevert(RegGateStatus.NotReviewer.selector);
        gate.clearLatch(0, DOC_A);
        vm.prank(ATTACKER);
        gate.clearLatch(0, DOC_A);
        (bool l,,) = _latched(0);
        require(!l, "new reviewer cleared");
    }

    // ------------------------------------------------------- replay and shape defenses

    function test_rejectsReplayAndOlderReports() public {
        _send(T0, _all(0), _none());
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.StaleOrReplayed.selector, T0, T0));
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, _all(2), _none(), noList, noCats));
    }

    function test_rejectsWrongChain() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.WrongChain.selector, uint256(1)));
        gate.onReport(_meta(AUTHOR), _encode(1, T0, _all(0), _none(), noList, noCats));
    }

    function test_futureSkewBoundary() public {
        _send(T0 + 2 minutes, _all(0), _none()); // exactly at the skew limit: accepted
        vm.warp(T0 + 1);
        uint64 tooFar = T0 + 1 + 2 minutes + 1; // one second past the limit
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.FutureReport.selector, tooFar));
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, tooFar, _all(0), _none(), noList, noCats));
    }

    function test_rejectsOutOfRangeStatus() public {
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidStatus.selector, uint8(1), uint8(3)));
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, [uint8(0), 3, 0, 0], _none(), noList, noCats));
    }

    function test_rejectsMalformedReports() public {
        bytes memory good = _encode(block.chainid, T0, _all(0), _none(), noList, noCats);
        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidReport.selector);
        gate.onReport(_meta(AUTHOR), abi.encodePacked(good, bytes32(0))); // trailing bytes

        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidReport.selector); // lists of different lengths
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, [uint8(2), 0, 0, 0], _none(), _one(DOC_A), noCats));

        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidReport.selector); // listed document in a category not at BLOCK
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, _all(1), _none(), _one(DOC_A), _cats(1, 0)));

        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidReport.selector); // empty listed document
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, [uint8(2), 0, 0, 0], _none(), _one(bytes32(0)), _cats(1, 0)));

        bytes32[] memory many = new bytes32[](17);
        for (uint256 i = 0; i < 17; i++) many[i] = bytes32(i + 1);
        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.InvalidReport.selector); // over the cap
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, [uint8(2), 0, 0, 0], _none(), many, _cats(17, 0)));

        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.InvalidCategory.selector, uint8(9)));
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, [uint8(2), 0, 0, 0], _none(), _one(DOC_A), _cats(1, 9)));
    }

    // ------------------------------------------------------- latch and review

    function test_blockLatchesThroughLaterOkReports() public {
        _block0(T0, _one(DOC_A));
        _send(T0 + 60, _all(0), _none());
        _eq(gate.statusOf(0), gate.BLOCK(), "latched BLOCK must survive an OK report");
        _eq(gate.statusOf(1), gate.OK(), "other categories unaffected");
    }

    function test_onlyReviewerClears() public {
        _block0(T0, _one(DOC_A));
        vm.prank(ATTACKER);
        vm.expectRevert(RegGateStatus.NotReviewer.selector);
        gate.clearLatch(0, DOC_A);
    }

    function test_clearingNonLatchedReverts() public {
        vm.prank(REVIEWER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.NotLatched.selector, uint8(0)));
        gate.clearLatch(0, DOC_A);
    }

    function test_clearMustNameTheLatchedDocument() public {
        _block0(T0, _one(DOC_A));
        vm.prank(REVIEWER);
        vm.expectRevert(abi.encodeWithSelector(RegGateStatus.LatchedDocMismatch.selector, DOC_A));
        gate.clearLatch(0, DOC_B);
    }

    function test_clearedSameDocReadsReviewNotOk() public {
        _block0(T0, _one(DOC_A));
        _clear(0, DOC_A);
        _block0(T0 + 60, _one(DOC_A)); // same doc still in the lookback window
        _eq(gate.statusOf(0), gate.REVIEW(), "reviewed doc reads REVIEW, never OK");
        (bool l,,) = _latched(0);
        require(!l, "same doc must not re-latch");
        require(gate.isReviewed(0, DOC_A), "review recorded");
    }

    function test_newBlockingDocRelatchesAfterClear() public {
        _block0(T0, _one(DOC_A));
        _clear(0, DOC_A);
        _block0(T0 + 60, _one(DOC_B));
        _eq(gate.statusOf(0), gate.BLOCK(), "a new blocking document latches again");
    }

    /// Audit finding: a second blocking document arriving during a latch was never reviewed.
    function test_documentArrivingDuringLatchIsLatchedAfterClear() public {
        _block0(T0, _one(DOC_A));
        _block0(T0 + 60, _two(DOC_A, DOC_B)); // B arrives while A is latched
        _clear(0, DOC_A);
        (bool l, bytes32 doc, uint256 unreviewed) = _latched(0);
        require(l && doc == DOC_B, "clearing A latches B straight away");
        _eq(unreviewed, 1, "B still unreviewed");
        _send(T0 + 120, _all(0), _none()); // even if B leaves the window
        _eq(gate.statusOf(0), gate.BLOCK(), "B holds the latch until a human clears it");
        _clear(0, DOC_B);
        _eq(gate.statusOf(0), gate.OK(), "both reviewed, latest report OK");
    }

    /// Audit finding: a blocking document hidden behind a reviewed trigger document.
    function test_unreviewedDocumentBehindReviewedTriggerLatches() public {
        _block0(T0, _one(DOC_A));
        _clear(0, DOC_A);
        _block0(T0 + 60, _two(DOC_A, DOC_B)); // trigger is still A, but B is new
        (bool l, bytes32 doc,) = _latched(0);
        require(l && doc == DOC_B, "B latches even though the trigger is the reviewed A");
        _eq(gate.statusOf(0), gate.BLOCK(), "BLOCK until B is reviewed");
        _clear(0, DOC_B);
        _eq(gate.statusOf(0), gate.REVIEW(), "all reviewed: REVIEW");
    }

    function test_everyListedDocumentNeedsItsOwnReview() public {
        bytes32[] memory three = new bytes32[](3);
        (three[0], three[1], three[2]) = (DOC_A, DOC_B, DOC_C);
        _block0(T0, three);
        _clear(0, DOC_A);
        _clear(0, DOC_B);
        _eq(gate.statusOf(0), gate.BLOCK(), "C still unreviewed");
        _clear(0, DOC_C);
        _eq(gate.statusOf(0), gate.REVIEW(), "three clears for three documents");
    }

    function test_blockWithoutDocumentLatchesAndStaysBlock() public {
        _send(T0, [uint8(2), 0, 0, 0], _none());
        (bool l, bytes32 doc,) = _latched(0);
        require(l && doc == bytes32(0), "BLOCK with no doc latches on the empty document");
        _clear(0, bytes32(0));
        _eq(gate.statusOf(0), gate.BLOCK(), "no document to review: still BLOCK while reported");
        (l,,) = _latched(0);
        require(!l, "and the clear does not immediately re-latch");
        _send(T0 + 60, [uint8(2), 0, 0, 0], _none());
        (l,,) = _latched(0);
        require(l, "the next BLOCK report with no document latches again");
    }

    function test_staleOverridesReviewedReview() public {
        _block0(T0, _one(DOC_A));
        _clear(0, DOC_A);
        vm.warp(T0 + MAX_AGE + 1);
        _eq(gate.statusOf(0), gate.BLOCK(), "staleness wins over everything");
    }

    function test_snapshotReturnsWhatTheReportStored() public {
        uint8[] memory cats = new uint8[](3);
        (cats[0], cats[1], cats[2]) = (0, 0, 3);
        bytes32[] memory docs = new bytes32[](3);
        (docs[0], docs[1], docs[2]) = (DOC_A, DOC_B, DOC_C);
        _sendList(T0, [uint8(2), 1, 0, 2], [DOC_A, DOC_B, bytes32(0), DOC_C], docs, cats);
        (uint64 asOf, uint64 maxAge_, uint8[4] memory st, bytes32[4] memory trig, bytes32[] memory bd, uint8[] memory bc) =
            gate.snapshot();
        _eq(asOf, T0, "asOf");
        _eq(maxAge_, MAX_AGE, "maxAge");
        _eq(st[3], 2, "statuses");
        require(trig[1] == DOC_B, "trigger docs");
        require(bd.length == 3 && bd[0] == DOC_A && bd[1] == DOC_B && bd[2] == DOC_C, "block docs in category order");
        require(bc[0] == 0 && bc[1] == 0 && bc[2] == 3, "block categories");
    }

    function test_supportsReceiverInterface() public view {
        require(gate.supportsInterface(0x805f2132), "IReceiver.onReport selector id");
        require(gate.supportsInterface(0x01ffc9a7), "IERC165");
        require(!gate.supportsInterface(0xffffffff), "unknown id");
    }

    // ------------------------------------------------------- defense in depth
    // These states cannot be reached through the contract's own functions. The tests
    // force them with a storage write (slots from `forge inspect RegGateStatus storageLayout`)
    // to prove the second line of defense holds if the first one ever regresses.

    function test_defenseInDepth_productionRefusesUnpinnedAuthor() public {
        bytes32 slot3 = vm.load(address(gate), bytes32(uint256(3))); // expectedAuthor (low 20 bytes) + lastAsOf
        vm.store(address(gate), bytes32(uint256(3)), bytes32(uint256(slot3) & ~uint256(type(uint160).max)));
        _eq(uint160(gate.expectedAuthor()), 0, "author forced to zero");
        vm.prank(FORWARDER);
        vm.expectRevert(RegGateStatus.AuthorNotSet.selector);
        gate.onReport(_meta(AUTHOR), _encode(block.chainid, T0, _all(0), _none(), noList, noCats));
    }

    function test_defenseInDepth_unreviewedDocumentBlocksEvenWithoutLatch() public {
        _block0(T0, _one(DOC_A));
        vm.store(address(gate), bytes32(uint256(11)), bytes32(0)); // _latched forced to all false
        (bool l,,) = _latched(0);
        require(!l, "latch forced off");
        _eq(gate.statusOf(0), gate.BLOCK(), "an unreviewed blocking document is BLOCK on its own");
    }
}
