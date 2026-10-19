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
///      - A BLOCK report latches. It stays BLOCK until the reviewer clears it,
///        even if later reports say OK.
///      - A cleared BLOCK on the same document reads as REVIEW, never OK.
///      Reports are accepted only from the Chainlink forwarder, from the pinned
///      workflow owner (once set), for this chain, with a strictly increasing timestamp.
///      This contract flags regulatory publications for human review. It is not legal advice.
contract RegGateStatus is IReceiver {
    uint8 public constant OK = 0;
    uint8 public constant REVIEW = 1;
    uint8 public constant BLOCK = 2;
    uint8 public constant NUM_CATEGORIES = 4; // STABLECOINS, TOKENIZED_SECURITIES, DIGITAL_ASSET_MARKETS, AML_SANCTIONS

    /// @dev How far ahead of block time a report's asOf may be (clock skew allowance).
    uint64 public constant MAX_FUTURE_SKEW = 15 minutes;

    address public immutable forwarder;
    uint64 public immutable maxAge;

    address public owner;
    address public reviewer;
    /// @notice Workflow owner allowed to write. Zero only for local simulation,
    ///         where the mock forwarder supplies no metadata. Set it before relying on this contract.
    address public expectedAuthor;

    uint64 public lastAsOf;
    uint8[NUM_CATEGORIES] private _reported;
    bytes32[NUM_CATEGORIES] private _triggerDoc;
    bool[NUM_CATEGORIES] private _latched;
    bytes32[NUM_CATEGORIES] private _latchedDoc;
    bytes32[NUM_CATEGORIES] private _acknowledgedDoc;

    event StatusUpdated(uint64 indexed asOf, uint8[NUM_CATEGORIES] statuses, bytes32[NUM_CATEGORIES] triggerDocs);
    event Latched(uint8 indexed category, bytes32 documentNumber);
    event LatchCleared(uint8 indexed category, bytes32 documentNumber, address indexed by);
    event ExpectedAuthorSet(address author);
    event ReviewerSet(address reviewer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error ZeroAddress();
    error InvalidMaxAge();
    error NotOwner();
    error NotReviewer();
    error InvalidSender(address sender);
    error InvalidMetadata();
    error InvalidAuthor(address author);
    error WrongChain(uint256 chainId);
    error StaleOrReplayed(uint64 asOf, uint64 lastAsOf);
    error FutureReport(uint64 asOf);
    error InvalidStatus(uint8 category, uint8 status);
    error InvalidCategory(uint8 category);
    error NotLatched(uint8 category);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyReviewer() {
        if (msg.sender != reviewer) revert NotReviewer();
        _;
    }

    constructor(address forwarder_, uint64 maxAge_, address reviewer_) {
        if (forwarder_ == address(0) || reviewer_ == address(0)) revert ZeroAddress();
        if (maxAge_ == 0) revert InvalidMaxAge();
        forwarder = forwarder_;
        maxAge = maxAge_;
        reviewer = reviewer_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ReviewerSet(reviewer_);
    }

    // ---------------------------------------------------------------- writes

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender);

        if (expectedAuthor != address(0)) {
            // metadata = abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner[, bytes2 reportId])
            if (metadata.length < 62) revert InvalidMetadata();
            address author = address(bytes20(metadata[42:62]));
            if (author != expectedAuthor) revert InvalidAuthor(author);
        }

        (uint256 chainId, uint64 asOf, uint8[NUM_CATEGORIES] memory statuses, bytes32[NUM_CATEGORIES] memory docs) =
            abi.decode(report, (uint256, uint64, uint8[4], bytes32[4])); // 4 == NUM_CATEGORIES

        if (chainId != block.chainid) revert WrongChain(chainId);
        if (asOf <= lastAsOf) revert StaleOrReplayed(asOf, lastAsOf);
        if (asOf > block.timestamp + MAX_FUTURE_SKEW) revert FutureReport(asOf);

        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            if (statuses[i] > BLOCK) revert InvalidStatus(i, statuses[i]);
        }

        lastAsOf = asOf;
        _reported = statuses;
        _triggerDoc = docs;

        for (uint8 i = 0; i < NUM_CATEGORIES; i++) {
            // A BLOCK with no document, or on a document the reviewer has not cleared, latches.
            if (statuses[i] == BLOCK && !_latched[i] && (docs[i] == bytes32(0) || docs[i] != _acknowledgedDoc[i])) {
                _latched[i] = true;
                _latchedDoc[i] = docs[i];
                emit Latched(i, docs[i]);
            }
        }

        emit StatusUpdated(asOf, statuses, docs);
    }

    /// @notice Reviewer confirms a latched BLOCK was read and handled by a human.
    function clearLatch(uint8 category) external onlyReviewer {
        _checkCategory(category);
        if (!_latched[category]) revert NotLatched(category);
        bytes32 doc = _latchedDoc[category];
        _latched[category] = false;
        _acknowledgedDoc[category] = doc;
        delete _latchedDoc[category];
        emit LatchCleared(category, doc, msg.sender);
    }

    function setExpectedAuthor(address author) external onlyOwner {
        expectedAuthor = author;
        emit ExpectedAuthorSet(author);
    }

    function setReviewer(address reviewer_) external onlyOwner {
        if (reviewer_ == address(0)) revert ZeroAddress();
        reviewer = reviewer_;
        emit ReviewerSet(reviewer_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ----------------------------------------------------------------- reads

    /// @notice Effective status for a category, after staleness and latching.
    function statusOf(uint8 category) public view returns (uint8) {
        _checkCategory(category);
        if (lastAsOf == 0 || block.timestamp > uint256(lastAsOf) + maxAge) return BLOCK;
        if (_latched[category]) return BLOCK;
        uint8 reported = _reported[category];
        bytes32 doc = _triggerDoc[category];
        if (reported == BLOCK && doc != bytes32(0) && doc == _acknowledgedDoc[category]) return REVIEW;
        return reported;
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

    function latchInfo(uint8 category) external view returns (bool latched, bytes32 latchedDoc, bytes32 acknowledgedDoc) {
        _checkCategory(category);
        return (_latched[category], _latchedDoc[category], _acknowledgedDoc[category]);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _checkCategory(uint8 category) private pure {
        if (category >= NUM_CATEGORIES) revert InvalidCategory(category);
    }
}
