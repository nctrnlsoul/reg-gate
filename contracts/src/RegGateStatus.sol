// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title RegGateStatus
/// @notice On-chain regulatory status per asset category, written by the Reg-Gate
///         CRE workflow. Token contracts call `statusOf` or `isAllowed` before transfers.
/// @dev Fail-closed by construction:
///      - No report yet, or the last report is older than `maxAge`: BLOCK.
///      - Every blocking document needs its own human review. A report lists every
///        document at BLOCK in each category, and each unreviewed one joins a review
///        queue that later reports cannot shorten: a document stays queued until a
///        reviewer clears it, even after it leaves the workflow's search window. While
///        the queue is not empty the category is latched at BLOCK, even if later reports
///        say OK. Clearing one document latches the next straight away.
///      - When every listed document has been reviewed, BLOCK reads as REVIEW, never OK.
///      - BLOCK with no document latches on the empty document, and the category stays
///        BLOCK, even after that clear, until a report stops saying BLOCK.
///      - A report arriving more than MAX_REPORT_GAP after the previous one means the
///        workflow could not see part of that time. Every category then queues
///        COVERAGE_GAP, so a reviewer has to sign off on the blind spot before any
///        category can read OK again.
///      Reports are accepted only from the Chainlink forwarder, from the pinned workflow
///      owner, for this chain, with a strictly increasing timestamp. A contract deployed
///      in simulation mode (the CRE simulation forwarder, which checks no DON signatures)
///      may run with no author pinned; anyone who can reach that forwarder can write to it.
///      This contract flags regulatory publications for human review. It is not legal advice.
contract RegGateStatus is IReceiver {
    uint8 public constant OK = 0;
    uint8 public constant REVIEW = 1;
    uint8 public constant BLOCK = 2;
    uint8 public constant NUM_CATEGORIES = 4; // STABLECOINS, TOKENIZED_SECURITIES, DIGITAL_ASSET_MARKETS, AML_SANCTIONS
    uint256 public constant MAX_BLOCK_DOCS = 16;
    /// @notice Most unreviewed documents one category may queue. A report that would exceed it
    ///         is rejected, so the chain goes stale and reads BLOCK rather than dropping one.
    uint256 public constant MAX_PENDING = 64;
    /// @notice Longest time between reports the workflow's 14-day search window can cover.
    uint64 public constant MAX_REPORT_GAP = 14 days;
    /// @notice Queued in every category after a gap longer than MAX_REPORT_GAP. Never marked reviewed,
    ///         so a later gap queues it again.
    bytes32 public constant COVERAGE_GAP = bytes32("COVERAGE-GAP");

    /// @dev How far ahead of block time a report's asOf may be. Reports carry DON
    ///      consensus time, which is at or slightly after the block that includes them.
    uint64 public constant MAX_FUTURE_SKEW = 2 minutes;

    address public immutable forwarder;
    uint64 public immutable maxAge;
    /// @notice True only for a deployment behind the CRE simulation forwarder.
    bool public immutable simulation;

    address public owner;
    address public pendingOwner;
    address public reviewer;
    /// @notice Workflow owner allowed to write. Required unless `simulation` is true.
    address public expectedAuthor;

    uint64 public lastAsOf;
    uint8[NUM_CATEGORIES] private _reported;
    bytes32[NUM_CATEGORIES] private _triggerDoc;
    mapping(uint8 => bytes32[]) private _blockDocs; // every document at BLOCK in the last report
    mapping(uint8 => mapping(bytes32 => bool)) private _reviewed;
    bool[NUM_CATEGORIES] private _latched;
    bytes32[NUM_CATEGORIES] private _latchedDoc;
    /// @dev Unreviewed blocking documents, oldest first. Only a reviewer's clear removes one.
    mapping(uint8 => bytes32[]) private _pending;
    mapping(uint8 => mapping(bytes32 => bool)) private _queued;

    event StatusUpdated(uint64 indexed asOf, uint8[NUM_CATEGORIES] statuses, bytes32[NUM_CATEGORIES] triggerDocs);
    event Latched(uint8 indexed category, bytes32 documentNumber);
    event Queued(uint8 indexed category, bytes32 documentNumber);
    event LatchCleared(uint8 indexed category, bytes32 documentNumber, address indexed by);
    event ExpectedAuthorSet(address author);
    event ReviewerSet(address reviewer);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error ZeroAddress();
    error InvalidMaxAge();
    error NotOwner();
    error NotPendingOwner();
    error NotReviewer();
    error InvalidSender(address sender);
    error AuthorNotSet();
    error InvalidMetadata();
    error InvalidAuthor(address author);
    error InvalidReport();
    error WrongChain(uint256 chainId);
    error StaleOrReplayed(uint64 asOf, uint64 lastAsOf);
    error FutureReport(uint64 asOf);
    error InvalidStatus(uint8 category, uint8 status);
    error InvalidCategory(uint8 category);
    error NotLatched(uint8 category);
    error LatchedDocMismatch(bytes32 latchedDoc);
    error ReviewQueueFull(uint8 category);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyReviewer() {
        if (msg.sender != reviewer) revert NotReviewer();
        _;
    }

    /// @param author_ workflow owner to pin. May be zero only when `simulation_` is true.
    constructor(address forwarder_, uint64 maxAge_, address reviewer_, address author_, bool simulation_) {
        if (forwarder_ == address(0) || reviewer_ == address(0)) revert ZeroAddress();
        if (author_ == address(0) && !simulation_) revert AuthorNotSet();
        if (maxAge_ == 0) revert InvalidMaxAge();
        forwarder = forwarder_;
        maxAge = maxAge_;
        simulation = simulation_;
        reviewer = reviewer_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ReviewerSet(reviewer_);
        if (author_ != address(0)) {
            expectedAuthor = author_;
            emit ExpectedAuthorSet(author_);
        }
    }

    // ---------------------------------------------------------------- writes

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(uint256 chainId, uint64 asOf, uint8[4] statuses,
    ///      bytes32[4] triggerDocs, bytes32[] blockDocs, uint8[] blockCategories)
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender);

        address pinned = expectedAuthor;
        if (pinned == address(0)) {
            if (!simulation) revert AuthorNotSet();
        } else {
            // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner[, bytes2 reportId])
            if (metadata.length < 62) revert InvalidMetadata();
            address author = address(bytes20(metadata[42:62]));
            if (author != pinned) revert InvalidAuthor(author);
        }

        (
            uint256 chainId,
            uint64 asOf,
            uint8[NUM_CATEGORIES] memory statuses,
            bytes32[NUM_CATEGORIES] memory docs,
            bytes32[] memory blockDocs,
            uint8[] memory blockCats
        ) = abi.decode(report, (uint256, uint64, uint8[4], bytes32[4], bytes32[], uint8[])); // 4 == NUM_CATEGORIES

        // Canonical encoding only: 12 head words, then two length-prefixed arrays.
        uint256 n = blockDocs.length;
        if (n > MAX_BLOCK_DOCS || blockCats.length != n || report.length != 32 * (14 + 2 * n)) revert InvalidReport();

        if (chainId != block.chainid) revert WrongChain(chainId);
        if (asOf <= lastAsOf) revert StaleOrReplayed(asOf, lastAsOf);
        if (asOf > block.timestamp + MAX_FUTURE_SKEW) revert FutureReport(asOf);

        bool coverageGap = lastAsOf != 0 && asOf > lastAsOf + MAX_REPORT_GAP;
        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            if (statuses[i] > BLOCK) revert InvalidStatus(i, statuses[i]);
            delete _blockDocs[i];
        }
        for (uint256 j = 0; j < n; j++) {
            uint8 c = blockCats[j];
            if (c >= NUM_CATEGORIES) revert InvalidCategory(c);
            // A listed document must be non-empty and belong to a category reported at BLOCK.
            if (blockDocs[j] == bytes32(0) || statuses[c] != BLOCK) revert InvalidReport();
            _blockDocs[c].push(blockDocs[j]);
            _enqueue(c, blockDocs[j]);
        }

        if (coverageGap) {
            for (uint8 i = 0; i < NUM_CATEGORIES; i++) _enqueue(i, COVERAGE_GAP);
        }

        lastAsOf = asOf;
        _reported = statuses;
        _triggerDoc = docs;

        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            if (!_latched[i] && (statuses[i] == BLOCK || _pending[i].length > 0)) _latchNext(i, statuses[i] == BLOCK);
        }

        emit StatusUpdated(asOf, statuses, docs);
    }

    /// @notice Reviewer confirms a human read and handled the latched document.
    /// @param expectedDoc the document the reviewer read; must be the one latched now,
    ///        so a clear can never acknowledge a document nobody looked at.
    function clearLatch(uint8 category, bytes32 expectedDoc) external onlyReviewer {
        _checkCategory(category);
        if (!_latched[category]) revert NotLatched(category);
        bytes32 doc = _latchedDoc[category];
        if (doc != expectedDoc) revert LatchedDocMismatch(doc);
        _latched[category] = false;
        delete _latchedDoc[category];
        if (doc != bytes32(0)) {
            if (doc != COVERAGE_GAP) _reviewed[category][doc] = true;
            _dequeue(category, doc);
        }
        emit LatchCleared(category, doc, msg.sender);
        // Every other queued document still needs its own review, even if the latest
        // report no longer lists it (it may have left the workflow's search window).
        _latchNext(category, false);
    }

    function setExpectedAuthor(address author) external onlyOwner {
        if (author == address(0)) revert ZeroAddress();
        expectedAuthor = author;
        emit ExpectedAuthorSet(author);
    }

    function setReviewer(address reviewer_) external onlyOwner {
        if (reviewer_ == address(0)) revert ZeroAddress();
        reviewer = reviewer_;
        emit ReviewerSet(reviewer_);
    }

    /// @notice Step one of two. The new owner must call `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    /// @dev Latch the first unreviewed listed document. A BLOCK with no listed
    ///      document latches on the empty document, but only from a new report
    ///      (`fromReport`), so clearing it does not immediately re-latch.
    function _latchNext(uint8 category, bool fromReport) private {
        bytes32[] storage queue = _pending[category];
        if (queue.length > 0) {
            _latch(category, queue[0]); // oldest first; everything queued is unreviewed
            return;
        }
        if (fromReport && _blockDocs[category].length == 0) _latch(category, bytes32(0));
    }

    /// @dev Queue a blocking document for review once. Reviewed documents never return.
    function _enqueue(uint8 category, bytes32 doc) private {
        if (_reviewed[category][doc] || _queued[category][doc]) return;
        if (_pending[category].length >= MAX_PENDING) revert ReviewQueueFull(category);
        _queued[category][doc] = true;
        _pending[category].push(doc);
        emit Queued(category, doc);
    }

    /// @dev Remove a reviewed document, keeping the rest in arrival order.
    function _dequeue(uint8 category, bytes32 doc) private {
        bytes32[] storage queue = _pending[category];
        uint256 len = queue.length;
        for (uint256 j = 0; j < len; j++) {
            if (queue[j] == doc) {
                for (uint256 k = j; k + 1 < len; k++) queue[k] = queue[k + 1];
                queue.pop();
                break;
            }
        }
        _queued[category][doc] = false;
    }

    function _latch(uint8 category, bytes32 doc) private {
        _latched[category] = true;
        _latchedDoc[category] = doc;
        emit Latched(category, doc);
    }

    // ----------------------------------------------------------------- reads

    /// @notice Effective status for a category, after staleness, latching and review.
    function statusOf(uint8 category) public view returns (uint8) {
        _checkCategory(category);
        if (lastAsOf == 0 || block.timestamp > uint256(lastAsOf) + maxAge) return BLOCK;
        if (_latched[category]) return BLOCK;
        // Every unreviewed blocking document is queued (see _enqueue), so an empty queue
        // means every listed document was reviewed. Checked here even without the latch.
        if (_pending[category].length > 0) return BLOCK;
        uint8 reported = _reported[category];
        if (reported != BLOCK) return reported;
        if (_blockDocs[category].length == 0) return BLOCK;
        return REVIEW; // every blocking document was reviewed by a human
    }

    /// @notice Transfer gate. strict = only OK passes; otherwise anything but BLOCK passes.
    function isAllowed(uint8 category, bool strict) external view returns (bool) {
        uint8 s = statusOf(category);
        return strict ? s == OK : s != BLOCK;
    }

    function reportedStatus(uint8 category) external view returns (uint8 status, bytes32 triggerDoc) {
        _checkCategory(category);
        return (_reported[category], _triggerDoc[category]);
    }

    /// @return latched whether the category is held at BLOCK for review
    /// @return latchedDoc the document waiting for review (zero for a BLOCK with no document)
    /// @return unreviewed how many blocking documents are queued for review, listed or not
    function latchInfo(uint8 category) external view returns (bool latched, bytes32 latchedDoc, uint256 unreviewed) {
        _checkCategory(category);
        return (_latched[category], _latchedDoc[category], _pending[category].length);
    }

    /// @notice Documents waiting for review in a category, oldest first. The first is latched.
    function reviewQueue(uint8 category) external view returns (bytes32[] memory) {
        _checkCategory(category);
        return _pending[category];
    }

    function isReviewed(uint8 category, bytes32 doc) external view returns (bool) {
        _checkCategory(category);
        return _reviewed[category][doc];
    }

    /// @notice Everything the last report stored, in report order. The workflow reads this
    ///         to skip a write that would change nothing.
    function snapshot()
        external
        view
        returns (
            uint64 asOf,
            uint64 maxAge_,
            uint8[NUM_CATEGORIES] memory statuses,
            bytes32[NUM_CATEGORIES] memory triggerDocs,
            bytes32[] memory blockDocs,
            uint8[] memory blockCats
        )
    {
        uint256 n;
        for (uint8 i = 0; i < NUM_CATEGORIES; i++) n += _blockDocs[i].length;
        blockDocs = new bytes32[](n);
        blockCats = new uint8[](n);
        uint256 k;
        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            bytes32[] storage list = _blockDocs[i];
            for (uint256 j = 0; j < list.length; j++) {
                blockDocs[k] = list[j];
                blockCats[k] = i;
                k++;
            }
        }
        return (lastAsOf, maxAge, _reported, _triggerDoc, blockDocs, blockCats);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _checkCategory(uint8 category) private pure {
        if (category >= NUM_CATEGORIES) revert InvalidCategory(category);
    }
}
