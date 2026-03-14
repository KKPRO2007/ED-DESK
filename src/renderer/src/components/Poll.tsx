import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '../App'
import { Poll, PollOption } from '../types'

export default function PollSystem() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { currentUser, deviceInfo } = useApp()
  
  const [polls, setPolls] = useState<Poll[]>([])
  const [selectedPoll, setSelectedPoll] = useState<Poll | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newPoll, setNewPoll] = useState({
    question: '',
    options: ['', ''],
    isMultipleChoice: false,
    isAnonymous: true,
    duration: 5 // minutes
  })
  const [votedPolls, setVotedPolls] = useState<Set<string>>(new Set())

  // Sample polls data
  useEffect(() => {
    const samplePolls: Poll[] = [
      {
        id: 'poll-1',
        sessionId: sessionId || 'poll-session',
        question: 'Which programming language should we focus on for the next project?',
        options: [
          { id: 'opt1', text: 'Python', votes: ['user1', 'user2', 'user3'] },
          { id: 'opt2', text: 'JavaScript', votes: ['user4', 'user5'] },
          { id: 'opt3', text: 'Java', votes: ['user6'] },
          { id: 'opt4', text: 'C++', votes: ['user7', 'user8'] }
        ],
        isMultipleChoice: false,
        isAnonymous: false,
        createdBy: 'teacher1',
        createdAt: new Date(Date.now() - 3600000),
        totalVotes: 8
      },
      {
        id: 'poll-2',
        sessionId: sessionId || 'poll-session',
        question: 'How satisfied are you with the offline learning platform?',
        options: [
          { id: 'opt5', text: 'Very Satisfied', votes: ['user1', 'user4', 'user7'] },
          { id: 'opt6', text: 'Satisfied', votes: ['user2', 'user5', 'user8'] },
          { id: 'opt7', text: 'Neutral', votes: ['user3'] },
          { id: 'opt8', text: 'Dissatisfied', votes: [] },
          { id: 'opt9', text: 'Very Dissatisfied', votes: [] }
        ],
        isMultipleChoice: false,
        isAnonymous: true,
        createdBy: 'admin1',
        createdAt: new Date(Date.now() - 7200000),
        totalVotes: 7
      },
      {
        id: 'poll-3',
        sessionId: sessionId || 'poll-session',
        question: 'What features would you like to see in the next update? (Select all that apply)',
        options: [
          { id: 'opt10', text: 'Video Conferencing', votes: ['user1', 'user3', 'user5', 'user7'] },
          { id: 'opt11', text: 'Screen Sharing', votes: ['user2', 'user4', 'user6', 'user8'] },
          { id: 'opt12', text: 'File Sharing', votes: ['user1', 'user4', 'user7'] },
          { id: 'opt13', text: 'Whiteboard', votes: ['user3', 'user6', 'user8'] },
          { id: 'opt14', text: 'Code Collaboration', votes: ['user2', 'user5', 'user7'] }
        ],
        isMultipleChoice: true,
        isAnonymous: true,
        createdBy: 'teacher1',
        createdAt: new Date(Date.now() - 1800000),
        totalVotes: 12
      }
    ]
    setPolls(samplePolls)
  }, [sessionId])

  const handleCreatePoll = () => {
    const options: PollOption[] = newPoll.options
      .filter(opt => opt.trim() !== '')
      .map((text, index) => ({
        id: `opt-${Date.now()}-${index}`,
        text,
        votes: []
      }))

    const poll: Poll = {
      id: `poll-${Date.now()}`,
      sessionId: sessionId || 'poll-session',
      question: newPoll.question,
      options,
      isMultipleChoice: newPoll.isMultipleChoice,
      isAnonymous: newPoll.isAnonymous,
      createdBy: currentUser?.id || 'user1',
      createdAt: new Date(),
      totalVotes: 0
    }

    setPolls([poll, ...polls])
    setShowCreateModal(false)
    setNewPoll({ question: '', options: ['', ''], isMultipleChoice: false, isAnonymous: true, duration: 5 })
  }

  const handleVote = (pollId: string, optionId: string) => {
    if (votedPolls.has(pollId)) return

    setPolls(polls.map(poll => {
      if (poll.id === pollId) {
        let updatedOptions = poll.options.map(opt => {
          if (poll.isMultipleChoice) {
            // For multiple choice, toggle vote
            if (opt.id === optionId) {
              const hasVoted = opt.votes.includes(currentUser?.id || '')
              return {
                ...opt,
                votes: hasVoted 
                  ? opt.votes.filter(id => id !== currentUser?.id)
                  : [...opt.votes, currentUser?.id || '']
              }
            }
            return opt
          } else {
            // For single choice, remove from others and add to selected
            return {
              ...opt,
              votes: opt.id === optionId 
                ? [...opt.votes, currentUser?.id || '']
                : opt.votes.filter(id => id !== currentUser?.id)
            }
          }
        })

        // Remove duplicates for multiple choice
        if (poll.isMultipleChoice) {
          const userVotes = updatedOptions.filter(opt => 
            opt.votes.includes(currentUser?.id || '')
          )
          if (userVotes.length === 0) {
            // If no votes, add the selected one
            updatedOptions = updatedOptions.map(opt =>
              opt.id === optionId
                ? { ...opt, votes: [...opt.votes, currentUser?.id || ''] }
                : opt
            )
          }
        }

        const totalVotes = updatedOptions.reduce((sum, opt) => sum + opt.votes.length, 0)

        if (!poll.isMultipleChoice || (poll.isMultipleChoice && !votedPolls.has(pollId))) {
          setVotedPolls(new Set([...votedPolls, pollId]))
        }

        return { ...poll, options: updatedOptions, totalVotes }
      }
      return poll
    }))
  }

  const getPercentage = (votes: number, total: number) => {
    return total === 0 ? 0 : (votes / total) * 100
  }

  return (
    <div className="poll-system">
      {/* Header */}
      <div className="poll-header">
        <h1>Live Polls</h1>
        <div className="poll-stats">
          <span className="stat">📊 {polls.length} Active Polls</span>
          <span className="stat">👥 {deviceInfo.nearbyDevices.length} Participants</span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
          <span className="btn-icon">+</span> Create Poll
        </button>
      </div>

      {/* Polls Grid */}
      <div className="polls-grid">
        {polls.map(poll => (
          <div key={poll.id} className="poll-card">
            <div className="poll-card-header">
              <h3>{poll.question}</h3>
              <div className="poll-badges">
                {poll.isMultipleChoice && <span className="badge">Multiple Choice</span>}
                {poll.isAnonymous && <span className="badge">Anonymous</span>}
              </div>
            </div>

            <div className="poll-meta">
              <span className="creator">By {poll.createdBy}</span>
              <span className="time">{poll.createdAt.toLocaleDateString()}</span>
              <span className="votes">{poll.totalVotes} votes</span>
            </div>

            <div className="poll-options">
              {poll.options.map(option => {
                const percentage = getPercentage(option.votes.length, poll.totalVotes)
                const hasVoted = option.votes.includes(currentUser?.id || '')
                
                return (
                  <div key={option.id} className="poll-option">
                    <button
                      className={`vote-btn ${hasVoted ? 'voted' : ''} ${votedPolls.has(poll.id) && !poll.isMultipleChoice ? 'disabled' : ''}`}
                      onClick={() => handleVote(poll.id, option.id)}
                      disabled={!poll.isMultipleChoice && votedPolls.has(poll.id)}
                    >
                      <span className="option-text">{option.text}</span>
                      <span className="vote-count">{option.votes.length}</span>
                    </button>
                    
                    {votedPolls.has(poll.id) && (
                      <div className="progress-bar">
                        <div 
                          className="progress-fill" 
                          style={{ width: `${percentage}%` }}
                        />
                        <span className="percentage">{percentage.toFixed(1)}%</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {votedPolls.has(poll.id) && (
              <div className="poll-results">
                <button className="view-details">View Details →</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create Poll Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>Create New Poll</h2>

            <div className="form-group">
              <label>Question</label>
              <input
                type="text"
                value={newPoll.question}
                onChange={(e) => setNewPoll({ ...newPoll, question: e.target.value })}
                placeholder="Ask a question..."
              />
            </div>

            <div className="form-group">
              <label>Options</label>
              {newPoll.options.map((opt, index) => (
                <div key={index} className="option-input-group">
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => {
                      const options = [...newPoll.options]
                      options[index] = e.target.value
                      setNewPoll({ ...newPoll, options })
                    }}
                    placeholder={`Option ${index + 1}`}
                  />
                  {index === newPoll.options.length - 1 && index < 6 && (
                    <button 
                      className="add-option"
                      onClick={() => setNewPoll({
                        ...newPoll,
                        options: [...newPoll.options, '']
                      })}
                    >
                      +
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={newPoll.isMultipleChoice}
                  onChange={(e) => setNewPoll({ ...newPoll, isMultipleChoice: e.target.checked })}
                />
                Allow multiple choices
              </label>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={newPoll.isAnonymous}
                  onChange={(e) => setNewPoll({ ...newPoll, isAnonymous: e.target.checked })}
                />
                Anonymous voting
              </label>
            </div>

            <div className="form-group">
              <label>Poll Duration (minutes)</label>
              <input
                type="number"
                value={newPoll.duration}
                onChange={(e) => setNewPoll({ ...newPoll, duration: parseInt(e.target.value) })}
                min="1"
                max="60"
              />
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button 
                className="btn btn-primary"
                onClick={handleCreatePoll}
                disabled={!newPoll.question || newPoll.options.filter(o => o.trim()).length < 2}
              >
                Create Poll
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}