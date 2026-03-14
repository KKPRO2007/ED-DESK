import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../App'

export default function Home() {
  const navigate = useNavigate()
  const { currentUser, deviceInfo, scanNearbyDevices } = useApp()
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [sessionPassword, setSessionPassword] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [systemMetrics, setSystemMetrics] = useState({
    cpu: '23%',
    memory: '4.2/16GB',
    network: 'WiFi 5GHz',
    bluetooth: 'Connected'
  })

  const handleCreateSession = (type: string, isPublic: boolean, password?: string) => {
    // Generate random session code
    const sessionCode = Math.random().toString(36).substring(2, 8).toUpperCase()
    alert(`Session created!\nType: ${type}\nCode: ${sessionCode}\n${!isPublic ? 'Password: ' + password : 'Public Session'}`)
    setShowCreateModal(false)
  }

  const handleJoinSession = () => {
    if (joinCode) {
      if (!isPublic && !sessionPassword) {
        alert('Please enter password for locked session')
        return
      }
      alert(`Joining session: ${joinCode}${!isPublic ? ' with password' : ''}`)
      setShowJoinModal(false)
      setJoinCode('')
      setSessionPassword('')
    }
  }

  return (
    <div className="home-container">
      {/* Welcome Header with System Status */}
      <div className="welcome-header">
        <div>
          <h1 className="welcome-title">
            Welcome back, <span className="gradient-text">{currentUser?.name || 'KK Professional'}</span>
          </h1>
          <div className="system-status-bar">
            <span className="status-item">💻 CPU: {systemMetrics.cpu}</span>
            <span className="status-item">🧠 RAM: {systemMetrics.memory}</span>
            <span className="status-item">📶 {systemMetrics.network}</span>
            <span className="status-item">📱 BT: {systemMetrics.bluetooth}</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            Create Session
          </button>
          <button className="btn btn-secondary" onClick={() => setShowJoinModal(true)}>
            Join Session
          </button>
        </div>
      </div>

      {/* Quick Session Cards */}
      <div className="session-cards">
        <div className="session-card" onClick={() => handleCreateSession('chat', true)}>
          <div className="session-icon">💬</div>
          <h3>Chat Session</h3>
          <p>Start instant messaging</p>
        </div>
        <div className="session-card" onClick={() => handleCreateSession('assessment', false, '1234')}>
          <div className="session-icon">📝</div>
          <h3>Assessment</h3>
          <p>Create locked assessment</p>
        </div>
        <div className="session-card" onClick={() => handleCreateSession('quiz', true)}>
          <div className="session-icon">❓</div>
          <h3>Quiz</h3>
          <p>Interactive quiz</p>
        </div>
        <div className="session-card" onClick={() => handleCreateSession('poll', true)}>
          <div className="session-icon">📊</div>
          <h3>Poll</h3>
          <p>Live voting</p>
        </div>
        <div className="session-card" onClick={() => handleCreateSession('discussion', false, '5678')}>
          <div className="session-icon">🗣️</div>
          <h3>Discussion</h3>
          <p>Topic-based chat</p>
        </div>
      </div>

      {/* Nearby Devices */}
      <div className="nearby-section">
        <h3>Nearby Devices</h3>
        <div className="devices-grid">
          {deviceInfo.nearbyDevices.map(device => (
            <div key={device.id} className="device-item">
              <span className="device-icon">
                {device.type === 'computer' ? '🖥️' : 
                 device.type === 'laptop' ? '💻' : '📱'}
              </span>
              <span className="device-name">{device.name}</span>
              <span className="device-signal">{device.signal}%</span>
              <button className="device-connect" onClick={() => alert(`Connecting to ${device.name}`)}>
                Connect
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Create Session Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content small" onClick={e => e.stopPropagation()}>
            <h3>Create Session</h3>
            <div className="modal-body">
              <div className="session-type-selector">
                <button className="type-btn" onClick={() => handleCreateSession('chat', true)}>💬 Chat</button>
                <button className="type-btn" onClick={() => handleCreateSession('assessment', false, '1234')}>📝 Assessment</button>
                <button className="type-btn" onClick={() => handleCreateSession('quiz', true)}>❓ Quiz</button>
                <button className="type-btn" onClick={() => handleCreateSession('poll', true)}>📊 Poll</button>
                <button className="type-btn" onClick={() => handleCreateSession('discussion', false, '5678')}>🗣️ Discussion</button>
              </div>
            </div>
            <button className="modal-close" onClick={() => setShowCreateModal(false)}>×</button>
          </div>
        </div>
      )}

      {/* Join Session Modal */}
      {showJoinModal && (
        <div className="modal-overlay" onClick={() => setShowJoinModal(false)}>
          <div className="modal-content small" onClick={e => e.stopPropagation()}>
            <h3>Join Session</h3>
            <div className="modal-body">
              <div className="join-options">
                <label className="join-option">
                  <input 
                    type="radio" 
                    checked={isPublic} 
                    onChange={() => setIsPublic(true)} 
                  /> Public Session
                </label>
                <label className="join-option">
                  <input 
                    type="radio" 
                    checked={!isPublic} 
                    onChange={() => setIsPublic(false)} 
                  /> Locked Session
                </label>
              </div>
              <input
                type="text"
                className="join-input"
                placeholder="Enter session code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                maxLength={6}
              />
              {!isPublic && (
                <input
                  type="password"
                  className="join-input"
                  placeholder="Enter password"
                  value={sessionPassword}
                  onChange={(e) => setSessionPassword(e.target.value)}
                />
              )}
              <button className="btn btn-primary join-submit" onClick={handleJoinSession}>
                Join Session
              </button>
            </div>
            <button className="modal-close" onClick={() => setShowJoinModal(false)}>×</button>
          </div>
        </div>
      )}

      {/* Footer with your link */}
      <footer className="app-footer">
        Powered by <a href="https://kkprofessional.vercel.app/" target="_blank" rel="noopener noreferrer">KK Professional</a>
      </footer>
    </div>
  )
}