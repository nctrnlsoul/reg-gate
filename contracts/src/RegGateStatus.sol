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
///        document at BLOCK in each category. While any of them is unreviewed the
///        category is latched at BLOCK, even if later reports say OK. Clearing one
///        document latches the next unreviewed one straight away.
///      - When every listed document has been reviewed, BLOCK reads as REVIEW, never OK.
///      - BLOCK with no document (unknown type, or a result set we could not see whole)
///        reads BLOCK until a report says otherwise.
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

    event StatusUpdated(uint64 indexed asOf, uint8[NUM_CATEGORIES] statuses, bytes32[NUM_CATEGORIES] triggerDocs);
    event Latched(uint8 indexed category, bytes32 documentNumber);
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
        }

        lastAsOf = asOf;
        _reported = statuses;
        _triggerDoc = docs;

        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            if (statuses[i] == BLOCK && !_latched[i]) _latchNext(i, true);
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
        if (doc != bytes32(0)) _reviewed[category][doc] = true;
        emit LatchCleared(category, doc, msg.sender);
        // Any other blocking document in the last report still needs its own review.
        if (_reported[category] == BLOCK) _latchNext(category, false);
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
        bytes32[] storage list = _blockDocs[category];
        uint256 len = list.length;
        if (len == 0) {
            if (fromReport) _latch(category, bytes32(0));
            return;
        }
        for (uint256 j = 0; j < len; j++) {
            if (!_reviewed[category][list[j]]) {
                _latch(category, list[j]);
                return;
            }
        }
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
        uint8 reported = _reported[category];
        if (reported != BLOCK) return reported;
        bytes32[] storage list = _blockDocs[category];
        if (list.length == 0) return BLOCK;
        for (uint256 j = 0; j < list.length; j++) {
            if (!_reviewed[category][list[j]]) return BLOCK;
        }
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
    /// @return unreviewed how many listed blocking documents are not yet reviewed
    function latchInfo(uint8 category) external view returns (bool latched, bytes32 latchedDoc, uint256 unreviewed) {
        _checkCategory(category);
        bytes32[] storage list = _blockDocs[category];
        for (uint256 j = 0; j < list.length; j++) {
            if (!_reviewed[category][list[j]]) unreviewed++;
        }
        return (_latched[category], _latchedDoc[category], unreviewed);
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
