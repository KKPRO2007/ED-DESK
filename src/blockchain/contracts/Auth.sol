// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// =============================================================================
//
//   ███████╗██████╗       ██████╗ ███████╗███████╗██╗  ██╗
//   ██╔════╝██╔══██╗      ██╔══██╗██╔════╝██╔════╝██║ ██╔╝
//   █████╗  ██║  ██║█████╗██║  ██║█████╗  ███████╗█████╔╝
//   ██╔══╝  ██║  ██║╚════╝██║  ██║██╔══╝  ╚════██║██╔═██╗
//   ███████╗██████╔╝      ██████╔╝███████╗███████║██║  ██╗
//   ╚══════╝╚═════╝       ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝
//
//   ED-DESK — Offline Desktop Application for Academic Communication
//              and Assessment
//
//   Contract  : EDDeskAuth.sol
//   Version   : 1.0.0
//   Author    : Mallavarapu Krishna Koushik Reddy (Project Lead)
//   Team      : Shivam Dixit (Blockchain), Priyank Gaur (QA),
//               Arun Rawat (Frontend), Harsh Sharma (UI/UX)
//   Supervisor: Mr. Abhishek Singh, GLA University
//
//   Purpose   : Blockchain-based authentication, identity verification,
//               role-based access control, session management,
//               academic record integrity, tamper-resistant audit log,
//               and cryptographic proof-of-participation for the
//               ED-DESK offline academic platform.
//
//   Deployment: Local blockchain environment (Hardhat / Ganache)
//               No internet connectivity required.
//
// =============================================================================

// =============================================================================
// SECTION 1 — INTERFACES
// =============================================================================

/**
 * @title IEDDeskAuth
 * @notice External interface exposing the core authentication surface.
 *         Any future ED-DESK module (Assessment, Chat, Poll, Quiz,
 *         Discussion) can query identity without knowing implementation.
 */
interface IEDDeskAuth {
    function isRegistered(address user) external view returns (bool);
    function getRole(address user) external view returns (uint8);
    function isSessionActive(bytes32 sessionId) external view returns (bool);
    function hasJoinedSession(bytes32 sessionId, address user) external view returns (bool);
    function getReputation(address user) external view returns (uint256);
}

// =============================================================================
// SECTION 2 — LIBRARIES
// =============================================================================

/**
 * @title Strings
 * @notice Minimal on-chain string utilities used for hash composition
 *         and event-log enrichment.
 */
library Strings {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    /// @dev Converts a uint256 to its ASCII decimal string representation.
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Converts a bytes32 to a lowercase hex string prefixed with 0x.
    function toHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory result = new bytes(66);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            result[2 + i * 2]     = HEX_DIGITS[uint8(value[i] >> 4)];
            result[3 + i * 2]     = HEX_DIGITS[uint8(value[i] & 0x0f)];
        }
        return string(result);
    }
}

/**
 * @title AccessControl
 * @notice Lightweight role management library.  Roles are stored as
 *         bytes32 constants so they cost no storage beyond membership maps.
 */
library AccessControl {

    bytes32 internal constant ROLE_ADMIN   = keccak256("ADMIN");
    bytes32 internal constant ROLE_TEACHER = keccak256("TEACHER");
    bytes32 internal constant ROLE_STUDENT = keccak256("STUDENT");
    bytes32 internal constant ROLE_GUEST   = keccak256("GUEST");

    struct RoleData {
        mapping(address => bool) members;
        bytes32 adminRole;
    }

    /// @dev Grant a role to an account inside a RoleData struct.
    function grant(RoleData storage role, address account) internal {
        role.members[account] = true;
    }

    /// @dev Revoke a role from an account inside a RoleData struct.
    function revoke(RoleData storage role, address account) internal {
        role.members[account] = false;
    }

    /// @dev Check membership.
    function has(RoleData storage role, address account) internal view returns (bool) {
        return role.members[account];
    }
}

/**
 * @title Cryptography
 * @notice Helpers for message-hash construction, signature recovery,
 *         and session-secret derivation used throughout authentication.
 */
library Cryptography {

    /// @dev Returns the Ethereum signed message hash of a raw bytes32 hash.
    function toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    /// @dev Derives a deterministic session secret from multiple seeds.
    function deriveSessionSecret(
        address creator,
        uint256 nonce,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(creator, nonce, salt));
    }

    /// @dev Hashes a credential tuple for storage without exposing plaintext.
    function hashCredential(
        string memory username,
        string memory passwordHash,
        address wallet
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(username, passwordHash, wallet));
    }

    /// @dev Verifies an ECDSA signature and returns the recovered signer.
    function recoverSigner(
        bytes32 messageHash,
        bytes memory signature
    ) internal pure returns (address) {
        require(signature.length == 65, "Cryptography: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Cryptography: invalid signature v value");
        return ecrecover(messageHash, v, r, s);
    }

    /// @dev Checks whether a signature matches the expected signer.
    function verifySignature(
        bytes32 messageHash,
        bytes memory signature,
        address expectedSigner
    ) internal pure returns (bool) {
        address recovered = recoverSigner(toEthSignedMessageHash(messageHash), signature);
        return recovered == expectedSigner;
    }
}

/**
 * @title MerkleProof
 * @notice Minimal Merkle-proof verifier.  Used for batch-enrollment of
 *         students from a pre-committed list without exposing all addresses.
 */
library MerkleProof {

    /// @dev Verifies a Merkle proof for `leaf` against `root`.
    function verify(
        bytes32[] memory proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }
        return computedHash == root;
    }

    /// @dev Builds a leaf hash for a given address — matches off-chain tree.
    function leafHash(address account) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(account));
    }
}

// =============================================================================
// SECTION 3 — CUSTOM ERRORS  (gas-efficient over revert strings)
// =============================================================================

error AlreadyRegistered(address account);
error NotRegistered(address account);
error Unauthorized(address caller, string requiredRole);
error InvalidCredential(address account);
error SessionNotFound(bytes32 sessionId);
error SessionExpired(bytes32 sessionId, uint256 expiry, uint256 current);
error SessionFull(bytes32 sessionId, uint256 capacity);
error SessionLocked(bytes32 sessionId);
error AlreadyJoined(bytes32 sessionId, address account);
error NotJoined(bytes32 sessionId, address account);
error RecordAlreadySubmitted(bytes32 sessionId, address account);
error InvalidMerkleProof(address account, bytes32 root);
error ZeroAddress();
error EmptyString(string field);
error RateLimitExceeded(address account, uint256 cooldownEnd);
error AccountSuspended(address account, string reason);
error InvalidSignature(address claimed, address recovered);
error NonceAlreadyUsed(address account, uint256 nonce);
error ContractPaused();

// =============================================================================
// SECTION 4 — EVENTS
// =============================================================================

// User lifecycle
event UserRegistered     (address indexed account, uint8 role, uint256 timestamp);
event UserUpdated        (address indexed account, string field, uint256 timestamp);
event UserDeactivated    (address indexed account, address indexed by, uint256 timestamp);
event UserReactivated    (address indexed account, address indexed by, uint256 timestamp);
event UserSuspended      (address indexed account, string reason, uint256 until);
event UserRoleChanged    (address indexed account, uint8 oldRole, uint8 newRole, address indexed by);

// Authentication
event LoginAttempt       (address indexed account, bool success, uint256 timestamp);
event LogoutRecorded     (address indexed account, uint256 timestamp);
event PasswordChanged    (address indexed account, uint256 timestamp);
event SignatureVerified  (address indexed account, bytes32 indexed msgHash, uint256 timestamp);
event NonceConsumed      (address indexed account, uint256 nonce, uint256 timestamp);

// Session lifecycle
event SessionCreated     (bytes32 indexed sessionId, address indexed creator, uint8 sessionType, uint256 expiry);
event SessionJoined      (bytes32 indexed sessionId, address indexed participant, uint256 timestamp);
event SessionLeft        (bytes32 indexed sessionId, address indexed participant, uint256 timestamp);
event SessionClosed      (bytes32 indexed sessionId, address indexed by, uint256 timestamp);
event SessionExtended    (bytes32 indexed sessionId, uint256 newExpiry, address indexed by);
event SessionTransferred (bytes32 indexed sessionId, address indexed from, address indexed to);
event SessionLockToggled (bytes32 indexed sessionId, bool locked, address indexed by);

// Academic records
event RecordSubmitted    (bytes32 indexed sessionId, address indexed student, bytes32 recordHash, uint256 timestamp);
event RecordVerified     (bytes32 indexed sessionId, address indexed student, address indexed verifier);
event GradeAssigned      (bytes32 indexed sessionId, address indexed student, uint16 score, address indexed teacher);
event CertificateIssued  (address indexed student, bytes32 indexed certId, uint256 timestamp);

// Reputation
event ReputationChanged  (address indexed account, int256 delta, string reason, uint256 timestamp);

// Administration
event AdminAdded         (address indexed account, address indexed by, uint256 timestamp);
event AdminRemoved       (address indexed account, address indexed by, uint256 timestamp);
event ContractPausedEvent(address indexed by, uint256 timestamp);
event ContractResumedEvent(address indexed by, uint256 timestamp);
event EmergencyWithdraw  (address indexed to, uint256 amount);

// Audit
event AuditEntry         (bytes32 indexed category, address indexed actor, bytes32 dataHash, uint256 timestamp);

// =============================================================================
// SECTION 5 — MAIN CONTRACT
// =============================================================================

/**
 * @title EDDeskAuth
 * @notice Primary authentication and identity management contract for the
 *         ED-DESK offline academic platform.
 *
 *         Responsibilities
 *         ─────────────────
 *         1. User registration with role-based access (Admin/Teacher/Student)
 *         2. Credential storage (hashed) and signature-based login
 *         3. Session creation, join/leave, capacity and expiry enforcement
 *         4. Academic record hashing, submission, and tamper detection
 *         5. Reputation system for gamified academic engagement
 *         6. Merkle-proof based batch enrollment
 *         7. Nonce-based replay attack prevention
 *         8. Rate-limiting per address
 *         9. Emergency pause mechanism
 *        10. Comprehensive on-chain audit trail
 */
contract EDDeskAuth is IEDDeskAuth {

    using Strings      for uint256;
    using Strings      for bytes32;
    using Cryptography for bytes32;
    using Cryptography for bytes;
    using AccessControl for AccessControl.RoleData;
    using MerkleProof  for bytes32[];

    // =========================================================================
    // 5.1  CONSTANTS
    // =========================================================================

    uint8 public constant ROLE_NONE    = 0;
    uint8 public constant ROLE_ADMIN   = 1;
    uint8 public constant ROLE_TEACHER = 2;
    uint8 public constant ROLE_STUDENT = 3;
    uint8 public constant ROLE_GUEST   = 4;

    uint8 public constant SESSION_TYPE_CHAT       = 1;
    uint8 public constant SESSION_TYPE_ASSESSMENT = 2;
    uint8 public constant SESSION_TYPE_QUIZ       = 3;
    uint8 public constant SESSION_TYPE_POLL       = 4;
    uint8 public constant SESSION_TYPE_DISCUSSION = 5;

    uint256 public constant MAX_SESSION_DURATION   = 24 hours;
    uint256 public constant MIN_SESSION_DURATION   = 5 minutes;
    uint256 public constant DEFAULT_CAPACITY       = 50;
    uint256 public constant MAX_CAPACITY           = 500;
    uint256 public constant RATE_LIMIT_WINDOW      = 1 minutes;
    uint256 public constant MAX_ACTIONS_PER_WINDOW = 30;
    uint256 public constant REPUTATION_INITIAL     = 100;
    uint256 public constant REPUTATION_MAX         = 10000;
    uint256 public constant SUSPENSION_THRESHOLD   = 10;
    uint8   public constant CONTRACT_VERSION       = 1;

    bytes32 public constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant LOGIN_TYPEHASH =
        keccak256("Login(address account,uint256 nonce,uint256 timestamp)");

    bytes32 public constant SESSION_JOIN_TYPEHASH =
        keccak256("JoinSession(bytes32 sessionId,address participant,uint256 nonce,uint256 timestamp)");

    // =========================================================================
    // 5.2  STORAGE STRUCTS
    // =========================================================================

    /**
     * @notice Full user profile stored on-chain.  Sensitive fields (password)
     *         are stored as keccak256 hashes — never plaintext.
     */
    struct User {
        address wallet;          // Primary identifier
        bytes32 credentialHash;  // keccak256(username, passwordHash, wallet)
        uint8   role;            // ROLE_* constant
        string  displayName;     // Human-readable name shown in UI
        string  institution;     // GLA University / department name
        uint256 registeredAt;    // Block timestamp of registration
        uint256 lastLoginAt;     // Block timestamp of last successful login
        uint256 lastLogoutAt;    // Block timestamp of last logout
        uint256 loginCount;      // Cumulative successful logins
        uint256 reputation;      // Gamification score
        bool    active;          // Whether account is enabled
        bool    suspended;       // Temporary suspension flag
        uint256 suspendedUntil;  // Unix timestamp when suspension lifts
        uint256 sessionCount;    // Total sessions participated in
        bytes32 merkleLeaf;      // Pre-computed leaf for batch enrollment
    }

    /**
     * @notice Academic session — covers chat, exam, quiz, poll, discussion.
     */
    struct Session {
        bytes32 id;              // keccak256(creator, nonce, block.timestamp)
        address creator;         // Who opened the session
        uint8   sessionType;     // SESSION_TYPE_* constant
        string  title;           // Human-readable title
        string  description;     // Brief description
        bytes32 accessCode;      // keccak256 of the plain access code
        uint256 createdAt;       // Block timestamp of creation
        uint256 expiresAt;       // Block timestamp of expiry
        uint256 capacity;        // Maximum participants (excl. creator)
        uint256 joinedCount;     // Current participants
        bool    active;          // Whether the session is ongoing
        bool    locked;          // Whether join is paused by creator
        bool    requiresProof;   // Whether Merkle enrollment is required
        bytes32 enrollmentRoot;  // Merkle root for pre-approved participants
        bytes32 metaHash;        // Hash of off-chain metadata (IPFS CID etc.)
    }

    /**
     * @notice Academic record for a single student in a session.
     */
    struct AcademicRecord {
        bytes32 sessionId;       // Parent session
        address student;         // Owner
        bytes32 contentHash;     // keccak256 of exam answers / submission
        bytes32 encryptedRef;    // Reference to encrypted data (off-chain)
        uint256 submittedAt;     // Block timestamp
        uint16  score;           // Numeric score (0–1000 for precision)
        bool    verified;        // Teacher/admin has verified the record
        address verifiedBy;      // Who performed verification
        uint256 verifiedAt;      // When verification occurred
    }

    /**
     * @notice Issued completion certificate.
     */
    struct Certificate {
        bytes32 id;              // Unique certificate identifier
        address student;         // Recipient
        bytes32 sessionId;       // Originating session
        string  title;           // Certificate title
        uint256 issuedAt;        // Block timestamp
        address issuedBy;        // Teacher or admin
        uint16  finalScore;      // Score at time of issuance
        bytes32 proofHash;       // Cryptographic proof of data integrity
    }

    /**
     * @notice Rate-limiter state per address.
     */
    struct RateLimit {
        uint256 windowStart;     // Start of current window
        uint256 actionCount;     // Actions performed in current window
    }

    /**
     * @notice Audit log entry for compliance and transparency.
     */
    struct AuditLog {
        bytes32  category;       // Identifies the event category
        address  actor;          // Who triggered the event
        bytes32  dataHash;       // Hash of associated data
        uint256  timestamp;      // Block timestamp
        uint256  blockNumber;    // Block number for chain verification
    }

    // =========================================================================
    // 5.3  STORAGE VARIABLES
    // =========================================================================

    // Contract metadata
    address public contractOwner;
    bool    public paused;
    uint256 public deployedAt;
    uint256 public totalUsersRegistered;
    uint256 public totalSessionsCreated;
    uint256 public totalRecordsSubmitted;
    uint256 public totalCertificatesIssued;

    // EIP-712 domain separator (computed once at deploy)
    bytes32 public DOMAIN_SEPARATOR;

    // Role data stores (AccessControl library)
    AccessControl.RoleData internal _adminRole;
    AccessControl.RoleData internal _teacherRole;
    AccessControl.RoleData internal _studentRole;

    // User registry
    mapping(address  => User)       internal _users;
    mapping(bytes32  => address)    internal _credHashToWallet; // reverse lookup
    address[]                       internal _userList;

    // Session registry
    mapping(bytes32  => Session)    internal _sessions;
    mapping(bytes32  => address[])  internal _sessionParticipants;
    mapping(bytes32  => mapping(address => bool)) internal _hasJoined;
    mapping(address  => bytes32[])  internal _userSessions;
    bytes32[]                       internal _sessionList;

    // Academic records
    mapping(bytes32  => mapping(address => AcademicRecord)) internal _records;
    // sessionId => student => record

    // Certificates
    mapping(bytes32  => Certificate)  internal _certificates;
    mapping(address  => bytes32[])    internal _studentCertificates;

    // Nonce tracking (replay attack prevention)
    mapping(address  => mapping(uint256 => bool)) internal _nonceUsed;
    mapping(address  => uint256) internal _latestNonce;

    // Rate limiting
    mapping(address  => RateLimit) internal _rateLimits;

    // Audit trail (append-only)
    AuditLog[] internal _auditLog;
    uint256    public   auditLogLength;

    // Reputation deltas for various actions (configurable by admin)
    mapping(bytes32  => int256) internal _reputationDeltas;

    // Creator nonce for session ID generation (prevents collisions)
    mapping(address  => uint256) internal _creatorNonce;

    // =========================================================================
    // 5.4  MODIFIERS
    // =========================================================================

    /**
     * @dev Reverts when contract is paused.
     */
    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    /**
     * @dev Restricts to the contract owner.
     */
    modifier onlyOwner() {
        if (msg.sender != contractOwner) revert Unauthorized(msg.sender, "OWNER");
        _;
    }

    /**
     * @dev Restricts to registered admins.
     */
    modifier onlyAdmin() {
        if (!_adminRole.has(msg.sender)) revert Unauthorized(msg.sender, "ADMIN");
        _;
    }

    /**
     * @dev Restricts to registered teachers or admins.
     */
    modifier onlyTeacherOrAdmin() {
        if (!_teacherRole.has(msg.sender) && !_adminRole.has(msg.sender))
            revert Unauthorized(msg.sender, "TEACHER_OR_ADMIN");
        _;
    }

    /**
     * @dev Restricts to registered users (any role).
     */
    modifier onlyRegistered() {
        if (!_users[msg.sender].active) revert NotRegistered(msg.sender);
        _;
    }

    /**
     * @dev Checks that an address is registered and not suspended.
     */
    modifier notSuspended(address account) {
        User storage u = _users[account];
        if (u.suspended && block.timestamp < u.suspendedUntil)
            revert AccountSuspended(account, "Suspension period active");
        if (u.suspended && block.timestamp >= u.suspendedUntil) {
            // Auto-lift suspension
            u.suspended      = false;
            u.suspendedUntil = 0;
        }
        _;
    }

    /**
     * @dev Simple rate limiter — reverts if caller exceeds MAX_ACTIONS_PER_WINDOW.
     */
    modifier rateLimit() {
        RateLimit storage rl = _rateLimits[msg.sender];
        if (block.timestamp >= rl.windowStart + RATE_LIMIT_WINDOW) {
            rl.windowStart  = block.timestamp;
            rl.actionCount  = 0;
        }
        rl.actionCount++;
        if (rl.actionCount > MAX_ACTIONS_PER_WINDOW)
            revert RateLimitExceeded(msg.sender, rl.windowStart + RATE_LIMIT_WINDOW);
        _;
    }

    /**
     * @dev Checks that a session exists and is still active.
     */
    modifier sessionExists(bytes32 sessionId) {
        if (!_sessions[sessionId].active) revert SessionNotFound(sessionId);
        _;
    }

    /**
     * @dev Checks that a session has not expired.
     */
    modifier sessionNotExpired(bytes32 sessionId) {
        Session storage s = _sessions[sessionId];
        if (block.timestamp > s.expiresAt)
            revert SessionExpired(sessionId, s.expiresAt, block.timestamp);
        _;
    }

    // =========================================================================
    // 5.5  CONSTRUCTOR
    // =========================================================================

    /**
     * @param initialAdmins  Array of addresses to bootstrap as administrators.
     *                       The deployer is always added as an admin.
     */
    constructor(address[] memory initialAdmins) {
        contractOwner    = msg.sender;
        paused           = false;
        deployedAt       = block.timestamp;

        // EIP-712 domain separator
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_SEPARATOR_TYPEHASH,
            keccak256("ED-DESK Auth"),
            keccak256(bytes(string(abi.encodePacked(uint8(CONTRACT_VERSION).toString())))),
            block.chainid,
            address(this)
        ));

        // Bootstrap reputation delta table
        _reputationDeltas[keccak256("SESSION_CREATE")]    =  10;
        _reputationDeltas[keccak256("SESSION_JOIN")]      =   5;
        _reputationDeltas[keccak256("RECORD_SUBMIT")]     =  20;
        _reputationDeltas[keccak256("RECORD_VERIFIED")]   =  15;
        _reputationDeltas[keccak256("CERT_ISSUED")]       =  50;
        _reputationDeltas[keccak256("LATE_SUBMISSION")]   = -10;
        _reputationDeltas[keccak256("VIOLATION")]         = -30;
        _reputationDeltas[keccak256("LOGIN_SUCCESS")]     =   1;

        // Register deployer as admin
        _registerAdmin(msg.sender, "Contract Deployer", "ED-DESK System");

        // Register additional bootstrap admins
        for (uint256 i = 0; i < initialAdmins.length; i++) {
            if (initialAdmins[i] != address(0) && initialAdmins[i] != msg.sender) {
                _registerAdmin(initialAdmins[i], "Bootstrap Admin", "ED-DESK System");
            }
        }
    }

    // =========================================================================
    // 5.6  INTERNAL HELPERS
    // =========================================================================

    /**
     * @dev Creates an admin user bypassing public registration.
     */
    function _registerAdmin(
        address wallet,
        string memory displayName,
        string memory institution
    ) internal {
        if (_users[wallet].wallet != address(0)) return; // already exists

        bytes32 credHash = Cryptography.hashCredential("admin", "bootstrap", wallet);
        _users[wallet] = User({
            wallet         : wallet,
            credentialHash : credHash,
            role           : ROLE_ADMIN,
            displayName    : displayName,
            institution    : institution,
            registeredAt   : block.timestamp,
            lastLoginAt    : 0,
            lastLogoutAt   : 0,
            loginCount     : 0,
            reputation     : REPUTATION_INITIAL,
            active         : true,
            suspended      : false,
            suspendedUntil : 0,
            sessionCount   : 0,
            merkleLeaf     : MerkleProof.leafHash(wallet)
        });

        _adminRole.grant(wallet);
        _credHashToWallet[credHash] = wallet;
        _userList.push(wallet);
        totalUsersRegistered++;

        emit UserRegistered(wallet, ROLE_ADMIN, block.timestamp);
    }

    /**
     * @dev Appends an entry to the immutable audit log.
     */
    function _audit(bytes32 category, address actor, bytes32 dataHash) internal {
        _auditLog.push(AuditLog({
            category    : category,
            actor       : actor,
            dataHash    : dataHash,
            timestamp   : block.timestamp,
            blockNumber : block.number
        }));
        auditLogLength++;
        emit AuditEntry(category, actor, dataHash, block.timestamp);
    }

    /**
     * @dev Updates reputation for a user by a signed delta.
     */
    function _adjustReputation(address account, bytes32 actionKey, string memory reason) internal {
        int256 delta = _reputationDeltas[actionKey];
        if (delta == 0) return;

        User storage u = _users[account];
        if (delta > 0) {
            uint256 increase = uint256(delta);
            u.reputation = (u.reputation + increase > REPUTATION_MAX)
                ? REPUTATION_MAX
                : u.reputation + increase;
        } else {
            uint256 decrease = uint256(-delta);
            u.reputation = (decrease >= u.reputation) ? 0 : u.reputation - decrease;
        }

        emit ReputationChanged(account, delta, reason, block.timestamp);
    }

    /**
     * @dev Validates and consumes a nonce to prevent replay attacks.
     */
    function _consumeNonce(address account, uint256 nonce) internal {
        if (_nonceUsed[account][nonce]) revert NonceAlreadyUsed(account, nonce);
        _nonceUsed[account][nonce] = true;
        if (nonce > _latestNonce[account]) _latestNonce[account] = nonce;
        emit NonceConsumed(account, nonce, block.timestamp);
    }

    /**
     * @dev Generates a deterministic session ID.
     */
    function _generateSessionId(address creator) internal returns (bytes32) {
        uint256 nonce = _creatorNonce[creator]++;
        return keccak256(abi.encodePacked(creator, nonce, block.timestamp, block.prevrandao));
    }

    /**
     * @dev Builds the EIP-712 digest for a login message.
     */
    function _buildLoginDigest(
        address account,
        uint256 nonce,
        uint256 timestamp
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(LOGIN_TYPEHASH, account, nonce, timestamp));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /**
     * @dev Builds the EIP-712 digest for a session-join message.
     */
    function _buildJoinDigest(
        bytes32 sessionId,
        address participant,
        uint256 nonce,
        uint256 timestamp
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(SESSION_JOIN_TYPEHASH, sessionId, participant, nonce, timestamp)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // =========================================================================
    // 5.7  USER REGISTRATION
    // =========================================================================

    /**
     * @notice Registers a new user on the ED-DESK platform.
     * @param displayName    Human-readable name for the UI.
     * @param institution    Department or institution name.
     * @param role           Must be ROLE_TEACHER or ROLE_STUDENT (admins use addAdmin).
     * @param credentialHash keccak256(username, passwordHash, wallet) — computed off-chain.
     */
    function registerUser(
        string calldata displayName,
        string calldata institution,
        uint8           role,
        bytes32         credentialHash
    )
        external
        whenNotPaused
        rateLimit
    {
        address wallet = msg.sender;

        if (wallet == address(0))                   revert ZeroAddress();
        if (_users[wallet].wallet != address(0))    revert AlreadyRegistered(wallet);
        if (bytes(displayName).length == 0)         revert EmptyString("displayName");
        if (role != ROLE_TEACHER && role != ROLE_STUDENT && role != ROLE_GUEST)
            revert Unauthorized(wallet, "INVALID_ROLE");
        if (_credHashToWallet[credentialHash] != address(0))
            revert AlreadyRegistered(_credHashToWallet[credentialHash]);

        _users[wallet] = User({
            wallet         : wallet,
            credentialHash : credentialHash,
            role           : role,
            displayName    : displayName,
            institution    : institution,
            registeredAt   : block.timestamp,
            lastLoginAt    : 0,
            lastLogoutAt   : 0,
            loginCount     : 0,
            reputation     : REPUTATION_INITIAL,
            active         : true,
            suspended      : false,
            suspendedUntil : 0,
            sessionCount   : 0,
            merkleLeaf     : MerkleProof.leafHash(wallet)
        });

        if (role == ROLE_TEACHER) {
            _teacherRole.grant(wallet);
        } else {
            _studentRole.grant(wallet);
        }

        _credHashToWallet[credentialHash] = wallet;
        _userList.push(wallet);
        totalUsersRegistered++;

        _audit(
            keccak256("USER_REGISTERED"),
            wallet,
            keccak256(abi.encodePacked(wallet, role, block.timestamp))
        );

        emit UserRegistered(wallet, role, block.timestamp);
    }

    /**
     * @notice Updates a user's display name and institution.
     *         Only the account owner or an admin may call this.
     */
    function updateUserProfile(
        address         account,
        string calldata displayName,
        string calldata institution
    )
        external
        whenNotPaused
        onlyRegistered
    {
        if (msg.sender != account && !_adminRole.has(msg.sender))
            revert Unauthorized(msg.sender, "OWNER_OR_ADMIN");
        if (bytes(displayName).length == 0) revert EmptyString("displayName");

        User storage u = _users[account];
        u.displayName = displayName;
        u.institution = institution;

        _audit(
            keccak256("USER_UPDATED"),
            msg.sender,
            keccak256(abi.encodePacked(account, displayName))
        );

        emit UserUpdated(account, "profile", block.timestamp);
    }

    /**
     * @notice Changes the credential hash (password change flow).
     *         Requires the current credential hash as proof of identity.
     * @param oldCredHash  The user's current credential hash.
     * @param newCredHash  The replacement credential hash.
     */
    function changeCredential(
        bytes32 oldCredHash,
        bytes32 newCredHash
    )
        external
        whenNotPaused
        onlyRegistered
        notSuspended(msg.sender)
        rateLimit
    {
        User storage u = _users[msg.sender];
        if (u.credentialHash != oldCredHash) revert InvalidCredential(msg.sender);
        if (_credHashToWallet[newCredHash] != address(0)) revert AlreadyRegistered(msg.sender);

        delete _credHashToWallet[u.credentialHash];
        u.credentialHash = newCredHash;
        _credHashToWallet[newCredHash] = msg.sender;

        _audit(
            keccak256("CREDENTIAL_CHANGED"),
            msg.sender,
            keccak256(abi.encodePacked(msg.sender, block.timestamp))
        );

        emit PasswordChanged(msg.sender, block.timestamp);
    }

    // =========================================================================
    // 5.8  AUTHENTICATION  (signature-based login / logout)
    // =========================================================================

    /**
     * @notice Records a successful login on-chain using EIP-712 signature.
     *         The ED-DESK Electron backend verifies credentials off-chain first,
     *         then calls this to commit the login event immutably.
     *
     * @param nonce      Unique nonce generated by the client for this request.
     * @param timestamp  Unix timestamp from the client (must be within 5 min).
     * @param signature  EIP-712 signature over (account, nonce, timestamp).
     */
    function recordLogin(
        uint256 nonce,
        uint256 timestamp,
        bytes calldata signature
    )
        external
        whenNotPaused
        notSuspended(msg.sender)
        rateLimit
    {
        address account = msg.sender;

        if (_users[account].wallet == address(0)) revert NotRegistered(account);
        if (!_users[account].active)              revert AccountSuspended(account, "Deactivated");

        // Timestamp drift check: ±5 minutes
        require(
            block.timestamp <= timestamp + 5 minutes &&
            timestamp        <= block.timestamp + 5 minutes,
            "EDDeskAuth: timestamp out of range"
        );

        _consumeNonce(account, nonce);

        bytes32 digest   = _buildLoginDigest(account, nonce, timestamp);
        bool    sigValid = Cryptography.verifySignature(digest, signature, account);

        if (!sigValid) revert InvalidSignature(account, Cryptography.recoverSigner(digest, signature));

        User storage u = _users[account];
        u.lastLoginAt = block.timestamp;
        u.loginCount++;

        _adjustReputation(account, keccak256("LOGIN_SUCCESS"), "login");
        _audit(
            keccak256("LOGIN"),
            account,
            keccak256(abi.encodePacked(account, nonce, timestamp))
        );

        emit LoginAttempt(account, true, block.timestamp);
        emit SignatureVerified(account, digest, block.timestamp);
    }

    /**
     * @notice Records a logout event on-chain.
     */
    function recordLogout() external whenNotPaused onlyRegistered {
        _users[msg.sender].lastLogoutAt = block.timestamp;
        _audit(
            keccak256("LOGOUT"),
            msg.sender,
            keccak256(abi.encodePacked(msg.sender, block.timestamp))
        );
        emit LogoutRecorded(msg.sender, block.timestamp);
    }

    /**
     * @notice Verifies a generic EIP-712 signature and emits an audit entry.
     *         Used by other ED-DESK modules (Assessment, Quiz, Poll) to prove
     *         that a specific action was authorised by the wallet holder.
     */
    function verifyAndRecordSignature(
        bytes32        messageHash,
        bytes calldata signature,
        uint256        nonce,
        uint256        timestamp
    )
        external
        whenNotPaused
        onlyRegistered
        notSuspended(msg.sender)
        rateLimit
        returns (bool)
    {
        require(
            block.timestamp <= timestamp + 5 minutes,
            "EDDeskAuth: signature expired"
        );

        _consumeNonce(msg.sender, nonce);

        bool valid = Cryptography.verifySignature(messageHash, signature, msg.sender);

        _audit(
            keccak256("SIG_VERIFY"),
            msg.sender,
            keccak256(abi.encodePacked(msg.sender, messageHash, valid))
        );

        if (valid) emit SignatureVerified(msg.sender, messageHash, block.timestamp);
        return valid;
    }

    // =========================================================================
    // 5.9  SESSION MANAGEMENT
    // =========================================================================

    /**
     * @notice Creates a new academic session.
     *
     * @param sessionType     SESSION_TYPE_* constant.
     * @param title           Human-readable title.
     * @param description     Brief description shown in the UI.
     * @param accessCodeHash  keccak256 of the plain access code (never stored plaintext).
     * @param duration        Session length in seconds (clamped to min/max).
     * @param capacity        Maximum participants (0 → DEFAULT_CAPACITY).
     * @param requiresProof   Whether participants must provide a Merkle proof.
     * @param enrollmentRoot  Merkle root for pre-approved list (0x0 if open).
     * @param metaHash        Optional off-chain metadata hash.
     * @return sessionId      Newly generated session identifier.
     */
    function createSession(
        uint8          sessionType,
        string calldata title,
        string calldata description,
        bytes32        accessCodeHash,
        uint256        duration,
        uint256        capacity,
        bool           requiresProof,
        bytes32        enrollmentRoot,
        bytes32        metaHash
    )
        external
        whenNotPaused
        onlyRegistered
        notSuspended(msg.sender)
        onlyTeacherOrAdmin
        rateLimit
        returns (bytes32 sessionId)
    {
        if (bytes(title).length == 0)    revert EmptyString("title");
        if (duration < MIN_SESSION_DURATION) duration = MIN_SESSION_DURATION;
        if (duration > MAX_SESSION_DURATION) duration = MAX_SESSION_DURATION;
        if (capacity == 0 || capacity > MAX_CAPACITY) capacity = DEFAULT_CAPACITY;

        sessionId = _generateSessionId(msg.sender);

        _sessions[sessionId] = Session({
            id             : sessionId,
            creator        : msg.sender,
            sessionType    : sessionType,
            title          : title,
            description    : description,
            accessCode     : accessCodeHash,
            createdAt      : block.timestamp,
            expiresAt      : block.timestamp + duration,
            capacity       : capacity,
            joinedCount    : 0,
            active         : true,
            locked         : false,
            requiresProof  : requiresProof,
            enrollmentRoot : enrollmentRoot,
            metaHash       : metaHash
        });

        _sessionList.push(sessionId);
        _userSessions[msg.sender].push(sessionId);
        totalSessionsCreated++;

        _adjustReputation(msg.sender, keccak256("SESSION_CREATE"), "session created");
        _audit(
            keccak256("SESSION_CREATED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, sessionType, block.timestamp))
        );

        emit SessionCreated(sessionId, msg.sender, sessionType, block.timestamp + duration);
    }

    /**
     * @notice Joins an existing session using the access code hash.
     *         If the session has requiresProof=true, a Merkle proof must be supplied.
     *
     * @param sessionId      Target session.
     * @param accessCodeHash keccak256 of the access code entered by the user.
     * @param merkleProof    Proof array (empty bytes32[] if not required).
     */
    function joinSession(
        bytes32          sessionId,
        bytes32          accessCodeHash,
        bytes32[] calldata merkleProof
    )
        external
        whenNotPaused
        onlyRegistered
        notSuspended(msg.sender)
        sessionExists(sessionId)
        sessionNotExpired(sessionId)
        rateLimit
    {
        Session storage s = _sessions[sessionId];

        if (s.locked)                          revert SessionLocked(sessionId);
        if (_hasJoined[sessionId][msg.sender]) revert AlreadyJoined(sessionId, msg.sender);
        if (s.joinedCount >= s.capacity)       revert SessionFull(sessionId, s.capacity);
        if (s.accessCode != bytes32(0) && s.accessCode != accessCodeHash)
            revert InvalidCredential(msg.sender);

        // Merkle proof enforcement
        if (s.requiresProof) {
            bytes32 leaf = MerkleProof.leafHash(msg.sender);
            if (!MerkleProof.verify(merkleProof, s.enrollmentRoot, leaf))
                revert InvalidMerkleProof(msg.sender, s.enrollmentRoot);
        }

        s.joinedCount++;
        _hasJoined[sessionId][msg.sender] = true;
        _sessionParticipants[sessionId].push(msg.sender);
        _userSessions[msg.sender].push(sessionId);
        _users[msg.sender].sessionCount++;

        _adjustReputation(msg.sender, keccak256("SESSION_JOIN"), "joined session");
        _audit(
            keccak256("SESSION_JOINED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, msg.sender, block.timestamp))
        );

        emit SessionJoined(sessionId, msg.sender, block.timestamp);
    }

    /**
     * @notice Voluntarily leaves an active session.
     */
    function leaveSession(bytes32 sessionId)
        external
        whenNotPaused
        onlyRegistered
        sessionExists(sessionId)
    {
        if (!_hasJoined[sessionId][msg.sender]) revert NotJoined(sessionId, msg.sender);

        _hasJoined[sessionId][msg.sender] = false;
        if (_sessions[sessionId].joinedCount > 0) _sessions[sessionId].joinedCount--;

        _audit(
            keccak256("SESSION_LEFT"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, msg.sender, block.timestamp))
        );

        emit SessionLeft(sessionId, msg.sender, block.timestamp);
    }

    /**
     * @notice Closes a session permanently.  Only the creator or an admin may close.
     */
    function closeSession(bytes32 sessionId)
        external
        whenNotPaused
        onlyRegistered
        sessionExists(sessionId)
    {
        Session storage s = _sessions[sessionId];
        if (msg.sender != s.creator && !_adminRole.has(msg.sender))
            revert Unauthorized(msg.sender, "CREATOR_OR_ADMIN");

        s.active = false;

        _audit(
            keccak256("SESSION_CLOSED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, msg.sender, block.timestamp))
        );

        emit SessionClosed(sessionId, msg.sender, block.timestamp);
    }

    /**
     * @notice Extends a session's expiry time.
     * @param extension  Additional seconds to add.
     */
    function extendSession(bytes32 sessionId, uint256 extension)
        external
        whenNotPaused
        onlyRegistered
        sessionExists(sessionId)
        sessionNotExpired(sessionId)
    {
        Session storage s = _sessions[sessionId];
        if (msg.sender != s.creator && !_adminRole.has(msg.sender))
            revert Unauthorized(msg.sender, "CREATOR_OR_ADMIN");

        uint256 newExpiry = s.expiresAt + extension;
        require(newExpiry <= s.createdAt + MAX_SESSION_DURATION, "EDDeskAuth: max duration exceeded");

        s.expiresAt = newExpiry;
        emit SessionExtended(sessionId, newExpiry, msg.sender);
    }

    /**
     * @notice Toggles the session lock state (pauses new joins).
     */
    function toggleSessionLock(bytes32 sessionId)
        external
        whenNotPaused
        onlyRegistered
        sessionExists(sessionId)
    {
        Session storage s = _sessions[sessionId];
        if (msg.sender != s.creator && !_adminRole.has(msg.sender))
            revert Unauthorized(msg.sender, "CREATOR_OR_ADMIN");

        s.locked = !s.locked;
        emit SessionLockToggled(sessionId, s.locked, msg.sender);
    }

    /**
     * @notice Transfers session ownership to another teacher or admin.
     */
    function transferSession(bytes32 sessionId, address newCreator)
        external
        whenNotPaused
        onlyRegistered
        sessionExists(sessionId)
    {
        Session storage s = _sessions[sessionId];
        if (msg.sender != s.creator) revert Unauthorized(msg.sender, "SESSION_CREATOR");
        if (newCreator == address(0)) revert ZeroAddress();
        if (!_users[newCreator].active) revert NotRegistered(newCreator);

        address old = s.creator;
        s.creator = newCreator;

        _audit(
            keccak256("SESSION_TRANSFERRED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, old, newCreator))
        );

        emit SessionTransferred(sessionId, old, newCreator);
    }

    // =========================================================================
    // 5.10  ACADEMIC RECORDS
    // =========================================================================

    /**
     * @notice Submits an academic record (exam answer, quiz response, etc.)
     *         as a content hash.  Actual data is encrypted and stored off-chain;
     *         only the hash is committed here for tamper detection.
     *
     * @param sessionId    Target session.
     * @param contentHash  keccak256 of the student's submission.
     * @param encryptedRef Reference pointer to off-chain encrypted data.
     */
    function submitRecord(
        bytes32 sessionId,
        bytes32 contentHash,
        bytes32 encryptedRef
    )
        external
        whenNotPaused
        onlyRegistered
        notSuspended(msg.sender)
        sessionExists(sessionId)
        rateLimit
    {
        if (!_hasJoined[sessionId][msg.sender]) revert NotJoined(sessionId, msg.sender);
        if (_records[sessionId][msg.sender].submittedAt != 0)
            revert RecordAlreadySubmitted(sessionId, msg.sender);

        bool lateSubmission = block.timestamp > _sessions[sessionId].expiresAt;

        _records[sessionId][msg.sender] = AcademicRecord({
            sessionId    : sessionId,
            student      : msg.sender,
            contentHash  : contentHash,
            encryptedRef : encryptedRef,
            submittedAt  : block.timestamp,
            score        : 0,
            verified     : false,
            verifiedBy   : address(0),
            verifiedAt   : 0
        });

        totalRecordsSubmitted++;

        bytes32 actionKey = lateSubmission
            ? keccak256("LATE_SUBMISSION")
            : keccak256("RECORD_SUBMIT");

        _adjustReputation(msg.sender, actionKey, lateSubmission ? "late submission" : "record submitted");
        _audit(
            keccak256("RECORD_SUBMITTED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, msg.sender, contentHash))
        );

        emit RecordSubmitted(sessionId, msg.sender, contentHash, block.timestamp);
    }

    /**
     * @notice Teacher or admin assigns a numeric score to a submitted record.
     * @param score  0–1000 (supports one decimal place via ×10 encoding).
     */
    function assignGrade(
        bytes32 sessionId,
        address student,
        uint16  score
    )
        external
        whenNotPaused
        onlyTeacherOrAdmin
        sessionExists(sessionId)
    {
        AcademicRecord storage r = _records[sessionId][student];
        require(r.submittedAt != 0, "EDDeskAuth: no record to grade");
        require(score <= 1000, "EDDeskAuth: score > 1000");

        r.score = score;

        _audit(
            keccak256("GRADE_ASSIGNED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, student, score))
        );

        emit GradeAssigned(sessionId, student, score, msg.sender);
    }

    /**
     * @notice Marks a submitted record as verified (integrity confirmed).
     */
    function verifyRecord(bytes32 sessionId, address student)
        external
        whenNotPaused
        onlyTeacherOrAdmin
    {
        AcademicRecord storage r = _records[sessionId][student];
        require(r.submittedAt != 0, "EDDeskAuth: record not found");
        require(!r.verified,        "EDDeskAuth: already verified");

        r.verified   = true;
        r.verifiedBy = msg.sender;
        r.verifiedAt = block.timestamp;

        _adjustReputation(student, keccak256("RECORD_VERIFIED"), "record verified by teacher");
        _audit(
            keccak256("RECORD_VERIFIED"),
            msg.sender,
            keccak256(abi.encodePacked(sessionId, student, msg.sender))
        );

        emit RecordVerified(sessionId, student, msg.sender);
    }

    // =========================================================================
    // 5.11  CERTIFICATES
    // =========================================================================

    /**
     * @notice Issues a completion certificate to a student.
     * @param student     Certificate recipient.
     * @param sessionId   Originating session.
     * @param title       Certificate title string.
     */
    function issueCertificate(
        address         student,
        bytes32         sessionId,
        string calldata title
    )
        external
        whenNotPaused
        onlyTeacherOrAdmin
    {
        AcademicRecord storage r = _records[sessionId][student];
        require(r.verified, "EDDeskAuth: record must be verified first");

        bytes32 certId = keccak256(
            abi.encodePacked(student, sessionId, block.timestamp, msg.sender)
        );

        bytes32 proofHash = keccak256(
            abi.encodePacked(certId, student, r.contentHash, r.score, block.timestamp)
        );

        _certificates[certId] = Certificate({
            id         : certId,
            student    : student,
            sessionId  : sessionId,
            title      : title,
            issuedAt   : block.timestamp,
            issuedBy   : msg.sender,
            finalScore : r.score,
            proofHash  : proofHash
        });

        _studentCertificates[student].push(certId);
        totalCertificatesIssued++;

        _adjustReputation(student, keccak256("CERT_ISSUED"), "certificate issued");
        _audit(
            keccak256("CERT_ISSUED"),
            msg.sender,
            keccak256(abi.encodePacked(certId, student, sessionId))
        );

        emit CertificateIssued(student, certId, block.timestamp);
    }

    /**
     * @notice Verifies a certificate's authenticity by re-computing its proof hash.
     * @return valid  True if the proof hash matches on-chain record.
     */
    function verifyCertificate(bytes32 certId) external view returns (bool valid, Certificate memory cert) {
        cert = _certificates[certId];
        if (cert.id == bytes32(0)) return (false, cert);

        AcademicRecord storage r = _records[cert.sessionId][cert.student];
        bytes32 expected = keccak256(
            abi.encodePacked(certId, cert.student, r.contentHash, r.score, cert.issuedAt)
        );

        valid = (expected == cert.proofHash);
    }

    // =========================================================================
    // 5.12  ADMIN FUNCTIONS
    // =========================================================================

    /**
     * @notice Adds a new administrator.  Only callable by existing admins.
     */
    function addAdmin(address account)
        external
        whenNotPaused
        onlyAdmin
    {
        if (account == address(0)) revert ZeroAddress();
        if (!_users[account].active) revert NotRegistered(account);

        _adminRole.grant(account);
        _users[account].role = ROLE_ADMIN;

        _audit(
            keccak256("ADMIN_ADDED"),
            msg.sender,
            keccak256(abi.encodePacked(account, msg.sender))
        );

        emit AdminAdded(account, msg.sender, block.timestamp);
        emit UserRoleChanged(account, _users[account].role, ROLE_ADMIN, msg.sender);
    }

    /**
     * @notice Removes an administrator.  Cannot remove the contract owner.
     */
    function removeAdmin(address account)
        external
        whenNotPaused
        onlyAdmin
    {
        if (account == contractOwner)     revert Unauthorized(msg.sender, "CANNOT_REMOVE_OWNER");
        if (!_adminRole.has(account)) revert Unauthorized(account, "NOT_AN_ADMIN");

        _adminRole.revoke(account);
        _users[account].role = ROLE_TEACHER; // Demote to teacher

        _audit(
            keccak256("ADMIN_REMOVED"),
            msg.sender,
            keccak256(abi.encodePacked(account, msg.sender))
        );

        emit AdminRemoved(account, msg.sender, block.timestamp);
        emit UserRoleChanged(account, ROLE_ADMIN, ROLE_TEACHER, msg.sender);
    }

    /**
     * @notice Changes the role of a registered user.
     */
    function changeUserRole(address account, uint8 newRole)
        external
        whenNotPaused
        onlyAdmin
    {
        if (!_users[account].active) revert NotRegistered(account);

        uint8 oldRole = _users[account].role;

        // Remove from old role group
        if (oldRole == ROLE_ADMIN)   _adminRole.revoke(account);
        if (oldRole == ROLE_TEACHER) _teacherRole.revoke(account);
        if (oldRole == ROLE_STUDENT) _studentRole.revoke(account);

        // Add to new role group
        if (newRole == ROLE_ADMIN)   _adminRole.grant(account);
        if (newRole == ROLE_TEACHER) _teacherRole.grant(account);
        if (newRole == ROLE_STUDENT) _studentRole.grant(account);

        _users[account].role = newRole;

        _audit(
            keccak256("ROLE_CHANGED"),
            msg.sender,
            keccak256(abi.encodePacked(account, oldRole, newRole))
        );

        emit UserRoleChanged(account, oldRole, newRole, msg.sender);
    }

    /**
     * @notice Suspends a user until a given timestamp.
     * @param account    Address to suspend.
     * @param until      Unix timestamp when suspension lifts.
     * @param reason     Human-readable suspension reason for the audit log.
     */
    function suspendUser(address account, uint256 until, string calldata reason)
        external
        whenNotPaused
        onlyAdmin
    {
        if (!_users[account].active) revert NotRegistered(account);
        require(until > block.timestamp, "EDDeskAuth: suspension must be future");

        User storage u = _users[account];
        u.suspended      = true;
        u.suspendedUntil = until;

        _audit(
            keccak256("USER_SUSPENDED"),
            msg.sender,
            keccak256(abi.encodePacked(account, until, reason))
        );

        emit UserSuspended(account, reason, until);
    }

    /**
     * @notice Manually lifts a suspension before it expires.
     */
    function liftSuspension(address account)
        external
        whenNotPaused
        onlyAdmin
    {
        User storage u = _users[account];
        if (!u.suspended) return;

        u.suspended      = false;
        u.suspendedUntil = 0;

        _audit(
            keccak256("SUSPENSION_LIFTED"),
            msg.sender,
            keccak256(abi.encodePacked(account, block.timestamp))
        );

        emit UserReactivated(account, msg.sender, block.timestamp);
    }

    /**
     * @notice Deactivates a user account entirely.
     */
    function deactivateUser(address account)
        external
        whenNotPaused
        onlyAdmin
    {
        if (!_users[account].active) revert NotRegistered(account);

        _users[account].active = false;

        _audit(
            keccak256("USER_DEACTIVATED"),
            msg.sender,
            keccak256(abi.encodePacked(account, block.timestamp))
        );

        emit UserDeactivated(account, msg.sender, block.timestamp);
    }

    /**
     * @notice Reactivates a deactivated account.
     */
    function reactivateUser(address account)
        external
        whenNotPaused
        onlyAdmin
    {
        _users[account].active = true;

        _audit(
            keccak256("USER_REACTIVATED"),
            msg.sender,
            keccak256(abi.encodePacked(account, block.timestamp))
        );

        emit UserReactivated(account, msg.sender, block.timestamp);
    }

    /**
     * @notice Updates the reputation delta for a specific action key.
     *         Allows governance without redeployment.
     */
    function setReputationDelta(bytes32 actionKey, int256 delta)
        external
        whenNotPaused
        onlyAdmin
    {
        require(delta >= -500 && delta <= 500, "EDDeskAuth: delta out of range");
        _reputationDeltas[actionKey] = delta;
    }

    /**
     * @notice Manually adjusts a user's reputation (moderation tool).
     */
    function adminAdjustReputation(address account, int256 delta, string calldata reason)
        external
        whenNotPaused
        onlyAdmin
    {
        User storage u = _users[account];
        require(u.active, "EDDeskAuth: user not active");

        if (delta > 0) {
            uint256 inc = uint256(delta);
            u.reputation = (u.reputation + inc > REPUTATION_MAX) ? REPUTATION_MAX : u.reputation + inc;
        } else {
            uint256 dec = uint256(-delta);
            u.reputation = (dec >= u.reputation) ? 0 : u.reputation - dec;
        }

        _audit(
            keccak256("REPUTATION_ADMIN_ADJUSTED"),
            msg.sender,
            keccak256(abi.encodePacked(account, delta, reason))
        );

        emit ReputationChanged(account, delta, reason, block.timestamp);
    }

    /**
     * @notice Pauses all state-changing operations (emergency stop).
     */
    function pause() external onlyOwner {
        paused = true;
        emit ContractPausedEvent(msg.sender, block.timestamp);
    }

    /**
     * @notice Resumes normal operation after a pause.
     */
    function resume() external onlyOwner {
        paused = false;
        emit ContractResumedEvent(msg.sender, block.timestamp);
    }

    /**
     * @notice Transfers contract ownership to a new address.
     */
    function transferOwnership(address newOwner)
        external
        onlyOwner
    {
        if (newOwner == address(0)) revert ZeroAddress();
        contractOwner = newOwner;
        _adminRole.grant(newOwner);
    }

    // =========================================================================
    // 5.13  VIEW FUNCTIONS  (IEDDeskAuth implementation + extras)
    // =========================================================================

    /// @inheritdoc IEDDeskAuth
    function isRegistered(address user) external view override returns (bool) {
        return _users[user].active;
    }

    /// @inheritdoc IEDDeskAuth
    function getRole(address user) external view override returns (uint8) {
        return _users[user].role;
    }

    /// @inheritdoc IEDDeskAuth
    function isSessionActive(bytes32 sessionId) external view override returns (bool) {
        return _sessions[sessionId].active && block.timestamp <= _sessions[sessionId].expiresAt;
    }

    /// @inheritdoc IEDDeskAuth
    function hasJoinedSession(bytes32 sessionId, address user) external view override returns (bool) {
        return _hasJoined[sessionId][user];
    }

    /// @inheritdoc IEDDeskAuth
    function getReputation(address user) external view override returns (uint256) {
        return _users[user].reputation;
    }

    /**
     * @notice Returns the full user profile for a given address.
     */
    function getUser(address account) external view returns (User memory) {
        return _users[account];
    }

    /**
     * @notice Returns basic user information — safe to expose externally.
     */
    function getUserInfo(address account)
        external
        view
        returns (
            string memory displayName,
            string memory institution,
            uint8         role,
            uint256       registeredAt,
            uint256       loginCount,
            uint256       reputation,
            bool          active,
            bool          suspended
        )
    {
        User storage u = _users[account];
        return (
            u.displayName,
            u.institution,
            u.role,
            u.registeredAt,
            u.loginCount,
            u.reputation,
            u.active,
            u.suspended
        );
    }

    /**
     * @notice Returns full session details.
     */
    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /**
     * @notice Returns the list of participants in a session.
     */
    function getSessionParticipants(bytes32 sessionId)
        external
        view
        returns (address[] memory)
    {
        return _sessionParticipants[sessionId];
    }

    /**
     * @notice Returns the list of session IDs a user has created or joined.
     */
    function getUserSessions(address account)
        external
        view
        returns (bytes32[] memory)
    {
        return _userSessions[account];
    }

    /**
     * @notice Returns an academic record.
     */
    function getRecord(bytes32 sessionId, address student)
        external
        view
        returns (AcademicRecord memory)
    {
        return _records[sessionId][student];
    }

    /**
     * @notice Returns certificate IDs held by a student.
     */
    function getStudentCertificates(address student)
        external
        view
        returns (bytes32[] memory)
    {
        return _studentCertificates[student];
    }

    /**
     * @notice Returns a paginated slice of the audit log.
     * @param from  Starting index (inclusive).
     * @param to    Ending index (exclusive, capped to length).
     */
    function getAuditLog(uint256 from, uint256 to)
        external
        view
        returns (AuditLog[] memory entries)
    {
        if (to > auditLogLength)    to = auditLogLength;
        if (from >= to)             return new AuditLog[](0);

        entries = new AuditLog[](to - from);
        for (uint256 i = from; i < to; i++) {
            entries[i - from] = _auditLog[i];
        }
    }

    /**
     * @notice Returns the latest nonce used by an account.
     */
    function getLatestNonce(address account) external view returns (uint256) {
        return _latestNonce[account];
    }

    /**
     * @notice Returns whether a specific nonce has been consumed.
     */
    function isNonceUsed(address account, uint256 nonce) external view returns (bool) {
        return _nonceUsed[account][nonce];
    }

    /**
     * @notice Returns a list of all registered user addresses.
     *         Pagination is the caller's responsibility.
     */
    function getAllUsers() external view returns (address[] memory) {
        return _userList;
    }

    /**
     * @notice Returns all session IDs ever created.
     */
    function getAllSessions() external view returns (bytes32[] memory) {
        return _sessionList;
    }

    /**
     * @notice Returns platform-wide statistics.
     */
    function getStats()
        external
        view
        returns (
            uint256 users,
            uint256 sessions,
            uint256 records,
            uint256 certs,
            uint256 auditEntries,
            bool    contractPaused
        )
    {
        return (
            totalUsersRegistered,
            totalSessionsCreated,
            totalRecordsSubmitted,
            totalCertificatesIssued,
            auditLogLength,
            paused
        );
    }

    /**
     * @notice Pre-computes the EIP-712 login digest for a given set of params.
     *         Called by the Electron main process to construct the message
     *         before requesting the wallet signature.
     */
    function buildLoginDigest(
        address account,
        uint256 nonce,
        uint256 timestamp
    ) external view returns (bytes32) {
        return _buildLoginDigest(account, nonce, timestamp);
    }

    /**
     * @notice Pre-computes the EIP-712 session-join digest.
     */
    function buildJoinDigest(
        bytes32 sessionId,
        address participant,
        uint256 nonce,
        uint256 timestamp
    ) external view returns (bytes32) {
        return _buildJoinDigest(sessionId, participant, nonce, timestamp);
    }

    /**
     * @notice Utility to build a credential hash off the contract
     *         (mirrors the Cryptography library helper).
     */
    function buildCredentialHash(
        string calldata username,
        string calldata passwordHash,
        address         wallet
    ) external pure returns (bytes32) {
        return Cryptography.hashCredential(username, passwordHash, wallet);
    }

    /**
     * @notice Checks whether a Merkle proof is valid for a given account
     *         and enrollment root (preview function — does not store state).
     */
    function checkMerkleProof(
        bytes32[] calldata proof,
        bytes32            root,
        address            account
    ) external pure returns (bool) {
        return MerkleProof.verify(proof, root, MerkleProof.leafHash(account));
    }

    /**
     * @notice Returns the reputation delta configured for a given action key.
     */
    function getReputationDelta(bytes32 actionKey) external view returns (int256) {
        return _reputationDeltas[actionKey];
    }

    // =========================================================================
    // 5.14  FALLBACK / RECEIVE
    // =========================================================================

    /**
     * @dev Rejects any accidental ETH transfers.
     */
    receive() external payable {
        revert("EDDeskAuth: does not accept ETH");
    }

    fallback() external {
        revert("EDDeskAuth: unknown function selector");
    }
}

// =============================================================================
// END OF  EDDeskAuth.sol
//
// Deployment:
//   npx hardhat compile
//   npx hardhat run scripts/deploy.js --network localhost
//
// Test:
//   npx hardhat test test/EDDeskAuth.test.js
//
// Integration (Electron IPC):
//   const { ethers } = require('ethers')
//   const provider   = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545')
//   const contract   = new ethers.Contract(ADDRESS, ABI, signer)
//   await contract.registerUser(displayName, institution, ROLE_STUDENT, credHash)
// =============================================================================
