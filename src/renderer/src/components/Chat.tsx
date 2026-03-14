import React, { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useApp } from '../App'
import { Message, Attachment } from '../types'

export default function Chat() {
  const { sessionId } = useParams()
  const { currentUser, deviceInfo } = useApp()
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [encryptionEnabled, setEncryptionEnabled] = useState(true)
  const [participants, setParticipants] = useState<any[]>([])
  const [showFileUpload, setShowFileUpload] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Sample participants
  useEffect(() => {
    setParticipants([
      { id: '1', name: 'Teacher Kumar', role: 'host', avatar: '👨‍🏫', isTyping: false },
      { id: '2', name: 'Student Priya', role: 'participant', avatar: '👩‍🎓', isTyping: true },
      { id: '3', name: 'Student Raj', role: 'participant', avatar: '👨‍🎓', isTyping: false },
      { id: '4', name: 'Student Sneha', role: 'participant', avatar: '👩‍🎓', isTyping: false }
    ])
  }, [])

  // Sample messages
  useEffect(() => {
    const sampleMessages: Message[] = [
      {
        id: '1',
        sessionId: sessionId || '1',
        senderId: '2',
        senderName: 'Student Priya',
        senderAvatar: '👩‍🎓',
        content: 'Can you explain the difference between var and let in JavaScript?',
        type: 'text',
        timestamp: new Date(Date.now() - 3600000),
        isEncrypted: true,
        isEdited: false,
        reactions: { '👍': ['3'], '❤️': ['1'] }
      },
      {
        id: '2',
        sessionId: sessionId || '1',
        senderId: '1',
        senderName: 'Teacher Kumar',
        senderAvatar: '👨‍🏫',
        content: 'Great question! var is function-scoped while let is block-scoped...',
        type: 'text',
        timestamp: new Date(Date.now() - 3000000),
        isEncrypted: true,
        isEdited: false,
        reactions: { '👍': ['2', '3'] },
        replyTo: '1'
      },
      {
        id: '3',
        sessionId: sessionId || '1',
        senderId: '1',
        senderName: 'Teacher Kumar',
        senderAvatar: '👨‍🏫',
        content: 'Here\'s a code example:',
        type: 'text',
        timestamp: new Date(Date.now() - 2400000),
        isEncrypted: true,
        isEdited: false
      },
      {
        id: '4',
        sessionId: sessionId || '1',
        senderId: '1',
        senderName: 'Teacher Kumar',
        senderAvatar: '👨‍🏫',
        content: '```javascript\nif (true) {\n  var x = 5;\n  let y = 10;\n}\nconsole.log(x); // 5\nconsole.log(y); // ReferenceError\n```',
        type: 'code',
        timestamp: new Date(Date.now() - 2000000),
        isEncrypted: true,
        isEdited: false
      }
    ]
    setMessages(sampleMessages)
  }, [sessionId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = () => {
    if (!newMessage.trim() && !fileInputRef.current?.files?.length) return

    const attachments: Attachment[] = []
    if (fileInputRef.current?.files) {
      Array.from(fileInputRef.current.files).forEach(file => {
        attachments.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          type: file.type,
          size: file.size,
          url: URL.createObjectURL(file)
        })
      })
    }

    const message: Message = {
      id: Math.random().toString(36).substr(2, 9),
      sessionId: sessionId || '1',
      senderId: currentUser?.id || '1',
      senderName: currentUser?.name || 'You',
      senderAvatar: currentUser?.avatar || '👤',
      content: newMessage,
      type: attachments.length > 0 ? 'file' : 'text',
      timestamp: new Date(),
      isEncrypted: encryptionEnabled,
      isEdited: false,
      reactions: {},
      attachments: attachments.length > 0 ? attachments : undefined,
      replyTo: replyTo?.id
    }

    setMessages([...messages, message])
    setNewMessage('')
    setReplyTo(null)
    setShowFileUpload(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleReaction = (messageId: string, emoji: string) => {
    setMessages(messages.map(msg => {
      if (msg.id === messageId) {
        const reactions = { ...msg.reactions }
        if (!reactions[emoji]) reactions[emoji] = []
        
        const userIndex = reactions[emoji].indexOf(currentUser?.id || '')
        if (userIndex === -1) {
          reactions[emoji].push(currentUser?.id || '')
        } else {
          reactions[emoji].splice(userIndex, 1)
          if (reactions[emoji].length === 0) delete reactions[emoji]
        }
        
        return { ...msg, reactions }
      }
      return msg
    }))
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div className="chat-advanced">
      <div className="chat-header">
        <div className="chat-info">
          <h2>Chat Session</h2>
          <div className="session-meta">
            <span className="encryption-badge">
              {encryptionEnabled ? '🔒 End-to-End Encrypted' : '🔓 Not Encrypted'}
            </span>
            <span className="participant-count">👥 {participants.length} participants</span>
          </div>
        </div>
        <div className="chat-actions">
          <button
            className={`encryption-toggle ${encryptionEnabled ? 'active' : ''}`}
            onClick={() => setEncryptionEnabled(!encryptionEnabled)}
          >
            {encryptionEnabled ? '🔒' : '🔓'}
          </button>
          <button className="info-btn">ℹ️</button>
        </div>
      </div>

      <div className="chat-main-area">
        <div className="chat-sidebar">
          <h3>Participants</h3>
          <div className="participants-list">
            {participants.map(p => (
              <div key={p.id} className="participant-item">
                <span className="participant-avatar">{p.avatar}</span>
                <div className="participant-details">
                  <span className="participant-name">{p.name}</span>
                  <span className="participant-role">{p.role}</span>
                </div>
                {p.isTyping && <span className="typing-indicator">typing...</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="chat-content">
          <div className="messages-container">
            {messages.map((msg, index) => (
              <div
                key={msg.id}
                className={`message-wrapper ${msg.senderId === currentUser?.id ? 'own' : ''}`}
              >
                {msg.senderId !== currentUser?.id && (
                  <span className="message-avatar">{msg.senderAvatar}</span>
                )}
                <div className="message-bubble">
                  {msg.senderId !== currentUser?.id && (
                    <span className="message-sender">{msg.senderName}</span>
                  )}
                  
                  {msg.replyTo && (
                    <div className="reply-preview">
                      <span>Replying to message</span>
                    </div>
                  )}

                  {msg.type === 'code' ? (
                    <pre className="code-block">
                      <code>{msg.content.replace(/```javascript|```/g, '')}</code>
                    </pre>
                  ) : (
                    <p className="message-text">{msg.content}</p>
                  )}

                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="attachments">
                      {msg.attachments.map(att => (
                        <div key={att.id} className="attachment">
                          {att.type.startsWith('image/') ? (
                            <img src={att.url} alt={att.name} />
                          ) : (
                            <div className="file-attachment">
                              <span className="file-icon">📎</span>
                              <span className="file-name">{att.name}</span>
                              <span className="file-size">{formatFileSize(att.size)}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="message-footer">
                    <span className="message-time">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {msg.isEdited && <span className="edited-indicator">(edited)</span>}
                    
                    <div className="message-reactions">
                      {Object.entries(msg.reactions).map(([emoji, users]) => (
                        <button
                          key={emoji}
                          className={`reaction-btn ${users.includes(currentUser?.id || '') ? 'active' : ''}`}
                          onClick={() => handleReaction(msg.id, emoji)}
                        >
                          {emoji} {users.length}
                        </button>
                      ))}
                      <button className="add-reaction" onClick={() => setShowEmojiPicker(true)}>
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {replyTo && (
            <div className="reply-bar">
              <span>Replying to: {replyTo.content.substring(0, 50)}...</span>
              <button onClick={() => setReplyTo(null)}>×</button>
            </div>
          )}

          {showFileUpload && (
            <div className="file-upload-bar">
              <input
                type="file"
                ref={fileInputRef}
                multiple
                onChange={() => {}}
              />
              <button onClick={() => setShowFileUpload(false)}>Cancel</button>
            </div>
          )}

          <div className="chat-input-area">
            <button className="attach-btn" onClick={() => setShowFileUpload(!showFileUpload)}>
              📎
            </button>
            <button className="emoji-btn" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
              😊
            </button>
            <input
              type="text"
              className="chat-input"
              placeholder="Type a message..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            />
            <button className="send-btn" onClick={sendMessage}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}