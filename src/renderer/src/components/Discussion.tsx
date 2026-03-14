import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '../App'
import { Discussion, DiscussionReply, Attachment } from '../types'

export default function DiscussionForum() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { currentUser, deviceInfo } = useApp()
  
  const [discussions, setDiscussions] = useState<Discussion[]>([])
  const [selectedDiscussion, setSelectedDiscussion] = useState<Discussion | null>(null)
  const [newReply, setNewReply] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newDiscussion, setNewDiscussion] = useState({
    topic: '',
    content: '',
    tags: [] as string[],
    attachments: [] as Attachment[]
  })
  const [tagInput, setTagInput] = useState('')
  const [sortBy, setSortBy] = useState<'latest' | 'popular' | 'unanswered'>('latest')
  const [filterTag, setFilterTag] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')

  // Sample discussions data
  useEffect(() => {
    const sampleDiscussions: Discussion[] = [
      {
        id: '1',
        sessionId: sessionId || 'disc-1',
        topic: 'Blockchain Implementation in Educational Assessments',
        content: 'How can we leverage blockchain to ensure tamper-proof examination records? Let\'s discuss the technical challenges and solutions.',
        attachments: [
          {
            id: 'att-1',
            name: 'blockchain-architecture.png',
            type: 'image/png',
            size: 245000,
            url: '#'
          }
        ],
        createdBy: 'user-1',
        creatorName: 'Dr. Sharma',
        createdAt: new Date(Date.now() - 86400000), // 1 day ago
        replies: [
          {
            id: 'r1',
            userId: 'user-2',
            userName: 'Priya Singh',
            userAvatar: '👩‍🎓',
            content: 'We could use smart contracts to automatically verify and store grades. Each assessment could be a transaction on the blockchain.',
            timestamp: new Date(Date.now() - 43200000),
            likes: ['user-3', 'user-4']
          },
          {
            id: 'r2',
            userId: 'user-3',
            userName: 'Rahul Kumar',
            userAvatar: '👨‍🎓',
            content: 'What about the scalability issues? Blockchain transactions can be slow for large classes.',
            timestamp: new Date(Date.now() - 21600000),
            likes: ['user-1']
          },
          {
            id: 'r3',
            userId: 'user-1',
            userName: 'Dr. Sharma',
            userAvatar: '👨‍🏫',
            content: 'Good point! We could use a hybrid approach - store only hashes on-chain and actual data locally.',
            timestamp: new Date(Date.now() - 10800000),
            likes: ['user-2', 'user-3', 'user-4']
          }
        ],
        tags: ['blockchain', 'security', 'assessment'],
        isPinned: true
      },
      {
        id: '2',
        sessionId: sessionId || 'disc-1',
        topic: 'Peer-to-Peer Communication for Offline Collaboration',
        content: 'Discussing WebRTC and Bluetooth implementations for offline device communication in classroom settings.',
        createdBy: 'user-4',
        creatorName: 'Prof. Verma',
        createdAt: new Date(Date.now() - 172800000), // 2 days ago
        replies: [
          {
            id: 'r4',
            userId: 'user-5',
            userName: 'Anjali Patel',
            userAvatar: '👩‍🎓',
            content: 'WebRTC works great for LAN connections. We can establish direct peer connections without internet.',
            timestamp: new Date(Date.now() - 86400000),
            likes: ['user-4', 'user-6']
          }
        ],
        tags: ['p2p', 'webrtc', 'bluetooth'],
        isPinned: false
      },
      {
        id: '3',
        sessionId: sessionId || 'disc-1',
        topic: 'AI-Powered Code Review System',
        content: 'Proposal for an AI system that can automatically review student code submissions and provide feedback.',
        attachments: [
          {
            id: 'att-2',
            name: 'ai-architecture.pdf',
            type: 'application/pdf',
            size: 1250000,
            url: '#'
          }
        ],
        createdBy: 'user-6',
        creatorName: 'Rajesh Gupta',
        createdAt: new Date(Date.now() - 259200000), // 3 days ago
        replies: [],
        tags: ['ai', 'code-review', 'automation'],
        isPinned: false
      }
    ]
    setDiscussions(sampleDiscussions)
  }, [sessionId])

  const handleCreateDiscussion = () => {
    const discussion: Discussion = {
      id: Math.random().toString(36).substr(2, 9),
      sessionId: sessionId || 'disc-1',
      topic: newDiscussion.topic,
      content: newDiscussion.content,
      attachments: newDiscussion.attachments,
      createdBy: currentUser?.id || 'user-1',
      creatorName: currentUser?.name || 'User',
      createdAt: new Date(),
      replies: [],
      tags: newDiscussion.tags,
      isPinned: false
    }
    setDiscussions([discussion, ...discussions])
    setShowCreateModal(false)
    setNewDiscussion({ topic: '', content: '', tags: [], attachments: [] })
  }

  const handleAddReply = (discussionId: string) => {
    if (!newReply.trim()) return

    const reply: DiscussionReply = {
      id: Math.random().toString(36).substr(2, 9),
      userId: currentUser?.id || 'user-1',
      userName: currentUser?.name || 'User',
      userAvatar: currentUser?.avatar || '👤',
      content: newReply,
      timestamp: new Date(),
      likes: []
    }

    setDiscussions(discussions.map(d => {
      if (d.id === discussionId) {
        return { ...d, replies: [...d.replies, reply] }
      }
      return d
    }))
    setNewReply('')
  }

  const handleLikeReply = (discussionId: string, replyId: string) => {
    setDiscussions(discussions.map(d => {
      if (d.id === discussionId) {
        return {
          ...d,
          replies: d.replies.map(r => {
            if (r.id === replyId) {
              const likes = r.likes.includes(currentUser?.id || '')
                ? r.likes.filter(id => id !== currentUser?.id)
                : [...r.likes, currentUser?.id || '']
              return { ...r, likes }
            }
            return r
          })
        }
      }
      return d
    }))
  }

  const filteredDiscussions = discussions
    .filter(d => 
      (filterTag ? d.tags.includes(filterTag) : true) &&
      (searchQuery ? 
        d.topic.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.content.toLowerCase().includes(searchQuery.toLowerCase()) :
        true
      )
    )
    .sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1
      if (!a.isPinned && b.isPinned) return 1
      
      switch (sortBy) {
        case 'latest':
          return b.createdAt.getTime() - a.createdAt.getTime()
        case 'popular':
          return b.replies.length - a.replies.length
        case 'unanswered':
          return a.replies.length - b.replies.length
        default:
          return 0
      }
    })

  const allTags = Array.from(new Set(discussions.flatMap(d => d.tags)))

  return (
    <div className="discussion-forum">
      {/* Header */}
      <div className="forum-header">
        <div className="forum-title">
          <h1>Discussion Forum</h1>
          <p className="session-info">
            {deviceInfo.nearbyDevices.length} participants online • 
            {discussions.reduce((acc, d) => acc + d.replies.length, 0)} replies
          </p>
        </div>
        <div className="forum-actions">
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <span className="btn-icon">+</span> New Discussion
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="forum-filters">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            placeholder="Search discussions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="filter-controls">
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
            <option value="latest">📅 Latest</option>
            <option value="popular">🔥 Popular</option>
            <option value="unanswered">❓ Unanswered</option>
          </select>
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
            <option value="">All Tags</option>
            {allTags.map(tag => (
              <option key={tag} value={tag}>#{tag}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Discussions List */}
      <div className="discussions-container">
        {selectedDiscussion ? (
          // Detailed Discussion View
          <div className="discussion-detail">
            <button className="back-btn" onClick={() => setSelectedDiscussion(null)}>
              ← Back to Discussions
            </button>
            
            <div className="detail-header">
              <h2>{selectedDiscussion.topic}</h2>
              <div className="discussion-meta">
                <span className="author">By {selectedDiscussion.creatorName}</span>
                <span className="time">{selectedDiscussion.createdAt.toLocaleDateString()}</span>
                <div className="tags">
                  {selectedDiscussion.tags.map(tag => (
                    <span key={tag} className="tag">#{tag}</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="discussion-content">
              <p>{selectedDiscussion.content}</p>
              
              {selectedDiscussion.attachments && selectedDiscussion.attachments.length > 0 && (
                <div className="attachments">
                  <h4>Attachments</h4>
                  {selectedDiscussion.attachments.map(att => (
                    <div key={att.id} className="attachment-item">
                      {att.type.startsWith('image/') ? (
                        <img src={att.url} alt={att.name} />
                      ) : (
                        <div className="file-attachment">
                          <span className="file-icon">📎</span>
                          <span className="file-name">{att.name}</span>
                          <span className="file-size">{(att.size / 1024).toFixed(1)} KB</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Replies Section */}
            <div className="replies-section">
              <h3>{selectedDiscussion.replies.length} Replies</h3>
              
              <div className="replies-list">
                {selectedDiscussion.replies.map(reply => (
                  <div key={reply.id} className="reply-item">
                    <div className="reply-avatar">{reply.userAvatar}</div>
                    <div className="reply-content">
                      <div className="reply-header">
                        <span className="reply-author">{reply.userName}</span>
                        <span className="reply-time">
                          {reply.timestamp.toLocaleDateString()} at{' '}
                          {reply.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="reply-text">{reply.content}</p>
                      <div className="reply-actions">
                        <button 
                          className={`like-btn ${reply.likes.includes(currentUser?.id || '') ? 'liked' : ''}`}
                          onClick={() => handleLikeReply(selectedDiscussion.id, reply.id)}
                        >
                          ❤️ {reply.likes.length}
                        </button>
                        <button className="reply-btn">↩️ Reply</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add Reply */}
              <div className="add-reply">
                <textarea
                  placeholder="Write your reply..."
                  value={newReply}
                  onChange={(e) => setNewReply(e.target.value)}
                  rows={3}
                />
                <button 
                  className="btn btn-primary"
                  onClick={() => handleAddReply(selectedDiscussion.id)}
                >
                  Post Reply
                </button>
              </div>
            </div>
          </div>
        ) : (
          // Discussions List View
          <div className="discussions-list">
            {filteredDiscussions.map(discussion => (
              <div 
                key={discussion.id} 
                className={`discussion-card ${discussion.isPinned ? 'pinned' : ''}`}
                onClick={() => setSelectedDiscussion(discussion)}
              >
                {discussion.isPinned && <span className="pinned-badge">📌 Pinned</span>}
                
                <div className="discussion-card-header">
                  <h3>{discussion.topic}</h3>
                  <span className="reply-count">{discussion.replies.length} replies</span>
                </div>
                
                <p className="discussion-excerpt">
                  {discussion.content.substring(0, 150)}...
                </p>
                
                <div className="discussion-card-footer">
                  <span className="author">By {discussion.creatorName}</span>
                  <span className="time">{discussion.createdAt.toLocaleDateString()}</span>
                  <div className="tags">
                    {discussion.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="tag">#{tag}</span>
                    ))}
                  </div>
                </div>
                
                {discussion.attachments && discussion.attachments.length > 0 && (
                  <span className="attachment-indicator">📎 {discussion.attachments.length}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Discussion Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content large" onClick={e => e.stopPropagation()}>
            <h2>Start New Discussion</h2>
            
            <div className="form-group">
              <label>Topic</label>
              <input
                type="text"
                value={newDiscussion.topic}
                onChange={(e) => setNewDiscussion({ ...newDiscussion, topic: e.target.value })}
                placeholder="Enter discussion topic"
              />
            </div>

            <div className="form-group">
              <label>Content</label>
              <textarea
                value={newDiscussion.content}
                onChange={(e) => setNewDiscussion({ ...newDiscussion, content: e.target.value })}
                placeholder="Describe your discussion topic..."
                rows={6}
              />
            </div>

            <div className="form-group">
              <label>Tags</label>
              <div className="tag-input">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && tagInput.trim()) {
                      setNewDiscussion({
                        ...newDiscussion,
                        tags: [...newDiscussion.tags, tagInput.trim().toLowerCase()]
                      })
                      setTagInput('')
                    }
                  }}
                  placeholder="Press Enter to add tags"
                />
              </div>
              <div className="tag-list">
                {newDiscussion.tags.map(tag => (
                  <span key={tag} className="tag">
                    #{tag}
                    <button onClick={() => setNewDiscussion({
                      ...newDiscussion,
                      tags: newDiscussion.tags.filter(t => t !== tag)
                    })}>×</button>
                  </span>
                ))}
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button 
                className="btn btn-primary"
                onClick={handleCreateDiscussion}
                disabled={!newDiscussion.topic || !newDiscussion.content}
              >
                Create Discussion
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}