// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OfflineMessagingBlockchain {
    // -------------------------------
    // User Structure
    // -------------------------------
    struct User {
        string username;
        bytes32 publicKeyHash; // For verification
        uint256 registeredAt;
        bool isActive;
        string deviceId; // Bluetooth device identifier
    }
    
    // -------------------------------
    // Message Structure
    // -------------------------------
    struct Message {
        uint256 messageId;
        string fromUser;
        string toUser;
        string content;
        uint256 timestamp;
        bool isDelivered;
        bool isRead;
        string signature; // Digital signature for verification
        bytes32 hash; // Message hash for integrity
    }
    
    // -------------------------------
    // Offline Queue Structure
    // -------------------------------
    struct OfflineMessage {
        Message msg;
        bool isSynced;
        uint256 retryCount;
    }
    
    // -------------------------------
    // Storage
    // -------------------------------
    mapping(string => User) public users; // username => User
    mapping(uint256 => Message) public messages;
    mapping(string => uint256[]) public userMessages; // username => messageIds
    mapping(string => OfflineMessage[]) public offlineQueue; // deviceId => offline messages
    
    string[] public usernames;
    uint256 public messageCounter;
    uint256 public totalUsers;
    
    // Events
    event UserRegistered(string indexed username, string deviceId);
    event MessageSent(uint256 indexed messageId, string from, string to, uint256 timestamp);
    event MessageDelivered(uint256 indexed messageId, string to);
    event MessageRead(uint256 indexed messageId, string by);
    event OfflineMessageQueued(string indexed toDevice, uint256 messageId);
    
    // -------------------------------
    // Modifiers
    // -------------------------------
    modifier userExists(string memory username) {
        require(users[username].isActive, "User does not exist");
        _;
    }
    
    modifier validMessageContent(string memory content) {
        require(bytes(content).length > 0, "Message content cannot be empty");
        require(bytes(content).length <= 500, "Message too long");
        _;
    }
    
    // -------------------------------
    // User Management
    // -------------------------------
    function registerUser(
        string memory username,
        string memory deviceId,
        bytes32 publicKeyHash
    ) public {
        require(!users[username].isActive, "Username already taken");
        require(bytes(username).length >= 3, "Username too short");
        require(bytes(username).length <= 30, "Username too long");
        
        users[username] = User({
            username: username,
            publicKeyHash: publicKeyHash,
            registeredAt: block.timestamp,
            isActive: true,
            deviceId: deviceId
        });
        
        usernames.push(username);
        totalUsers++;
        
        emit UserRegistered(username, deviceId);
    }
    
    // -------------------------------
    // Send Message (Online/Offline)
    // -------------------------------
    function sendMessage(
        string memory from,
        string memory to,
        string memory content,
        string memory signature
    ) 
        public 
        userExists(from)
        userExists(to)
        validMessageContent(content)
        returns (uint256)
    {
        // Create message hash
        bytes32 messageHash = keccak256(
            abi.encodePacked(from, to, content, block.timestamp, messageCounter)
        );
        
        Message memory newMessage = Message({
            messageId: messageCounter,
            fromUser: from,
            toUser: to,
            content: content,
            timestamp: block.timestamp,
            isDelivered: false,
            isRead: false,
            signature: signature,
            hash: messageHash
        });
        
        messages[messageCounter] = newMessage;
        userMessages[to].push(messageCounter);
        
        // Check if recipient is available (simulated - in real app would check Bluetooth)
        if (isUserOnline(to)) {
            deliverMessage(messageCounter);
        } else {
            // Queue for offline delivery
            addToOfflineQueue(to, newMessage);
            emit OfflineMessageQueued(users[to].deviceId, messageCounter);
        }
        
        emit MessageSent(messageCounter, from, to, block.timestamp);
        
        messageCounter++;
        return messageCounter - 1;
    }
    
    // -------------------------------
    // Deliver Message (via Bluetooth)
    // -------------------------------
    function deliverMessage(uint256 messageId) public {
        require(messageId < messageCounter, "Message does not exist");
        Message storage msg = messages[messageId];
        require(!msg.isDelivered, "Message already delivered");
        
        msg.isDelivered = true;
        emit MessageDelivered(messageId, msg.toUser);
    }
    
    // -------------------------------
    // Mark Message as Read
    // -------------------------------
    function markAsRead(uint256 messageId, string memory byUser) public {
        require(messageId < messageCounter, "Message does not exist");
        Message storage msg = messages[messageId];
        require(msg.toUser == byUser, "Only recipient can mark as read");
        require(!msg.isRead, "Message already read");
        
        msg.isRead = true;
        emit MessageRead(messageId, byUser);
    }
    
    // -------------------------------
    // Get User's Messages
    // -------------------------------
    function getUserMessages(string memory username) 
        public 
        view 
        userExists(username) 
        returns (Message[] memory) 
    {
        uint256[] memory messageIds = userMessages[username];
        Message[] memory userMsgs = new Message[](messageIds.length);
        
        for (uint256 i = 0; i < messageIds.length; i++) {
            userMsgs[i] = messages[messageIds[i]];
        }
        
        return userMsgs;
    }
    
    // -------------------------------
    // Get Undelivered Messages
    // -------------------------------
    function getUndeliveredMessages(string memory username) 
        public 
        view 
        userExists(username) 
        returns (Message[] memory) 
    {
        uint256[] memory messageIds = userMessages[username];
        uint256 undeliveredCount = 0;
        
        // Count undelivered messages
        for (uint256 i = 0; i < messageIds.length; i++) {
            if (!messages[messageIds[i]].isDelivered) {
                undeliveredCount++;
            }
        }
        
        Message[] memory undelivered = new Message[](undeliveredCount);
        uint256 index = 0;
        
        for (uint256 i = 0; i < messageIds.length; i++) {
            if (!messages[messageIds[i]].isDelivered) {
                undelivered[index] = messages[messageIds[i]];
                index++;
            }
        }
        
        return undelivered;
    }
    
    // -------------------------------
    // Sync Offline Messages (via Bluetooth)
    // -------------------------------
    function syncOfflineMessages(string memory deviceId) 
        public 
        returns (Message[] memory) 
    {
        OfflineMessage[] storage queue = offlineQueue[deviceId];
        Message[] memory syncedMessages = new Message[](queue.length);
        
        for (uint256 i = 0; i < queue.length; i++) {
            if (!queue[i].isSynced) {
                syncedMessages[i] = queue[i].msg;
                queue[i].isSynced = true;
                deliverMessage(queue[i].msg.messageId);
            }
        }
        
        return syncedMessages;
    }
    
    // -------------------------------
    // Verify Message Integrity
    // -------------------------------
    function verifyMessageIntegrity(uint256 messageId) 
        public 
        view 
        returns (bool) 
    {
        require(messageId < messageCounter, "Message does not exist");
        Message memory msg = messages[messageId];
        
        bytes32 computedHash = keccak256(
            abi.encodePacked(
                msg.fromUser,
                msg.toUser,
                msg.content,
                msg.timestamp,
                msg.messageId
            )
        );
        
        return computedHash == msg.hash;
    }
    
    // -------------------------------
    // Get Blockchain Statistics
    // -------------------------------
    function getStats() public view returns (
        uint256 totalMsgCount,
        uint256 totalUserCount,
        uint256 deliveredCount,
        uint256 readCount
    ) {
        totalMsgCount = messageCounter;
        totalUserCount = totalUsers;
        
        for (uint256 i = 0; i < messageCounter; i++) {
            if (messages[i].isDelivered) deliveredCount++;
            if (messages[i].isRead) readCount++;
        }
    }
    
    // -------------------------------
    // Helper Functions
    // -------------------------------
    function isUserOnline(string memory username) private view returns (bool) {
        // In real implementation, this would check Bluetooth connectivity
        // For now, return false for offline queue simulation
        return false;
    }
    
    function addToOfflineQueue(string memory to, Message memory msg) private {
        offlineQueue[users[to].deviceId].push(OfflineMessage({
            msg: msg,
            isSynced: false,
            retryCount: 0
        }));
    }
''    
    // -------------------------------
    // Export Blockchain Data (for offline sync)
    // -------------------------------
    function exportBlockchain() public view returns (
        string[] memory allUsernames,
        User[] memory allUsers,
        Message[] memory allMessages
    ) {
        allUsernames = usernames;
        allUsers = new User[](totalUsers);
        allMessages = new Message[](messageCounter);
        
        for (uint256 i = 0; i < totalUsers; i++) {
            allUsers[i] = users[usernames[i]];
        }
        
        for (uint256 i = 0; i < messageCounter; i++) {
            allMessages[i] = messages[i];
        }
    }
}+++
++