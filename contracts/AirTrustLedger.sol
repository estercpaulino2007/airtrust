// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AirTrustLedger
/// @notice Tamper-evident ledger for environmental data. Stores only
///         cryptographic fingerprints (SHA-256), never raw measurements.
///         Three proof types:
///           1. ReadingProof  - a single critical reading (e.g. an anomaly)
///           2. BatchProof    - Merkle root covering many routine readings
///           3. EventProof    - an AI-verified environmental event
contract AirTrustLedger {
    struct ReadingProof {
        bytes32 dataHash;
        address submittedBy;
        uint256 timestamp;
        string sensorId;
        string pollutant;
        uint256 value; // scaled x100 (e.g. 92.47 ug/m3 -> 9247)
        string status;
    }

    struct EventProof {
        bytes32 dataHash;
        address submittedBy;
        uint256 timestamp;
        string eventType;
        string severity;
    }

    struct BatchProof {
        bytes32 merkleRoot;
        address submittedBy;
        uint256 timestamp;
        uint256 readingCount;
        uint256 fromTime;
        uint256 toTime;
    }

    address public owner;
    mapping(address => bool) public submitters;

    mapping(bytes32 => ReadingProof) private readingProofs;
    mapping(bytes32 => EventProof) private eventProofs;
    mapping(bytes32 => BatchProof) private batchProofs;

    uint256 public totalReadingProofs;
    uint256 public totalEventProofs;
    uint256 public totalBatchProofs;

    event ReadingProofSubmitted(bytes32 indexed dataHash, string sensorId, string pollutant, uint256 value, string status, uint256 timestamp);
    event EventProofSubmitted(bytes32 indexed dataHash, string eventType, string severity, uint256 timestamp);
    event BatchProofSubmitted(bytes32 indexed merkleRoot, uint256 readingCount, uint256 fromTime, uint256 toTime, uint256 timestamp);
    event SubmitterUpdated(address indexed account, bool allowed);

    error NotAuthorized();
    error EmptyHash();
    error DuplicateHash(bytes32 dataHash);
    error ProofNotFound(bytes32 dataHash);

    modifier onlySubmitter() {
        if (!submitters[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
        submitters[msg.sender] = true;
        emit SubmitterUpdated(msg.sender, true);
    }

    /// @notice Owner can authorise additional ingestion gateways (e.g. one per city).
    function setSubmitter(address account, bool allowed) external {
        if (msg.sender != owner) revert NotAuthorized();
        submitters[account] = allowed;
        emit SubmitterUpdated(account, allowed);
    }

    // ---------------------------------------------------------------- readings

    function submitReadingProof(
        bytes32 dataHash,
        string calldata sensorId,
        string calldata pollutant,
        uint256 value,
        string calldata status
    ) external onlySubmitter {
        if (dataHash == bytes32(0)) revert EmptyHash();
        if (readingProofs[dataHash].timestamp != 0) revert DuplicateHash(dataHash);
        readingProofs[dataHash] = ReadingProof(dataHash, msg.sender, block.timestamp, sensorId, pollutant, value, status);
        totalReadingProofs++;
        emit ReadingProofSubmitted(dataHash, sensorId, pollutant, value, status, block.timestamp);
    }

    function getReadingProof(bytes32 dataHash) external view returns (ReadingProof memory) {
        if (readingProofs[dataHash].timestamp == 0) revert ProofNotFound(dataHash);
        return readingProofs[dataHash];
    }

    /// @notice Returns true when the supplied hash was anchored on-chain.
    function verifyReadingProof(bytes32 dataHash) external view returns (bool) {
        return readingProofs[dataHash].timestamp != 0;
    }

    // ------------------------------------------------------------------ events

    function submitEventProof(bytes32 dataHash, string calldata eventType, string calldata severity) external onlySubmitter {
        if (dataHash == bytes32(0)) revert EmptyHash();
        if (eventProofs[dataHash].timestamp != 0) revert DuplicateHash(dataHash);
        eventProofs[dataHash] = EventProof(dataHash, msg.sender, block.timestamp, eventType, severity);
        totalEventProofs++;
        emit EventProofSubmitted(dataHash, eventType, severity, block.timestamp);
    }

    function getEventProof(bytes32 dataHash) external view returns (EventProof memory) {
        if (eventProofs[dataHash].timestamp == 0) revert ProofNotFound(dataHash);
        return eventProofs[dataHash];
    }

    function verifyEventProof(bytes32 dataHash) external view returns (bool) {
        return eventProofs[dataHash].timestamp != 0;
    }

    // ----------------------------------------------------------------- batches

    function submitBatchProof(bytes32 merkleRoot, uint256 readingCount, uint256 fromTime, uint256 toTime) external onlySubmitter {
        if (merkleRoot == bytes32(0)) revert EmptyHash();
        if (batchProofs[merkleRoot].timestamp != 0) revert DuplicateHash(merkleRoot);
        batchProofs[merkleRoot] = BatchProof(merkleRoot, msg.sender, block.timestamp, readingCount, fromTime, toTime);
        totalBatchProofs++;
        emit BatchProofSubmitted(merkleRoot, readingCount, fromTime, toTime, block.timestamp);
    }

    function getBatchProof(bytes32 merkleRoot) external view returns (BatchProof memory) {
        if (batchProofs[merkleRoot].timestamp == 0) revert ProofNotFound(merkleRoot);
        return batchProofs[merkleRoot];
    }

    /// @notice Verifies that `leaf` belongs to an anchored batch, on-chain.
    ///         Uses sorted-pair SHA-256 hashing, identical to the off-chain builder.
    function verifyBatchMembership(bytes32 merkleRoot, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        if (batchProofs[merkleRoot].timestamp == 0) return false;
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed = computed <= p ? sha256(abi.encodePacked(computed, p)) : sha256(abi.encodePacked(p, computed));
        }
        return computed == merkleRoot;
    }

    function getTotalProofs() external view returns (uint256 readings, uint256 events_, uint256 batches) {
        return (totalReadingProofs, totalEventProofs, totalBatchProofs);
    }
}
