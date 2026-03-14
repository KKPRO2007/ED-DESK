import React, { useState, useEffect, createContext, useContext } from 'react'
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Navigation from './components/Navigation'
import Home from './components/Home'
import CreateSession from './components/CreateSession'
import Chat from './components/Chat'
import Assessment from './components/Assessment'
import Quiz from './components/Quiz'
import Poll from './components/Poll'
import Discussion from './components/Discussion'
import './assets/global.css'

// Types
interface User {
  id: string
  name: string
  role: 'teacher' | 'student' | 'admin'
  avatar: string
  deviceId: string
}

interface DeviceInfo {
  ipAddress: string
  bluetoothEnabled: boolean
  wifiEnabled: boolean
  nearbyDevices: { id: string; name: string; signal: number; type: string }[]
}

interface AppContextType {
  currentUser: User | null
  setCurrentUser: (user: User | null) => void
  deviceInfo: DeviceInfo
  refreshDeviceInfo: () => void
  scanNearbyDevices: () => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

export const useApp = () => {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used within AppProvider')
  return context
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo>({
    ipAddress: '127.0.0.1',
    bluetoothEnabled: true,
    wifiEnabled: true,
    nearbyDevices: []
  })

  const refreshDeviceInfo = async () => {
    try {
      const ip = await window.electronAPI?.getLocalIP() || '192.168.1.100'
      setDeviceInfo(prev => ({
        ...prev,
        ipAddress: ip
      }))
    } catch (error) {
      console.error('Failed to get device info:', error)
    }
  }

  const scanNearbyDevices = () => {
    const mockDevices = [
      { id: '1', name: 'Teacher-Desktop', signal: 95, type: 'computer' },
      { id: '2', name: 'Student-Laptop-1', signal: 87, type: 'laptop' },
      { id: '3', name: 'Student-Laptop-2', signal: 76, type: 'laptop' },
      { id: '4', name: 'Lab-PC-5', signal: 62, type: 'computer' },
      { id: '5', name: 'iPad-Pro', signal: 45, type: 'tablet' }
    ]
    setDeviceInfo(prev => ({
      ...prev,
      nearbyDevices: mockDevices
    }))
  }

  useEffect(() => {
    refreshDeviceInfo()
    scanNearbyDevices()
    
    // Demo user
    setCurrentUser({
      id: 'user-1',
      name: 'Teacher Kumar',
      role: 'teacher',
      avatar: '👨‍🏫',
      deviceId: 'device-1'
    })
  }, [])

  return (
    <AppContext.Provider value={{
      currentUser,
      setCurrentUser,
      deviceInfo,
      refreshDeviceInfo,
      scanNearbyDevices
    }}>
      <Router>
        <div className="app">
          <Navigation />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/create-session" element={<CreateSession />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/chat/:sessionId" element={<Chat />} />
              <Route path="/assessment" element={<Assessment />} />
              <Route path="/assessment/:sessionId" element={<Assessment />} />
              <Route path="/quiz" element={<Quiz />} />
              <Route path="/quiz/:sessionId" element={<Quiz />} />
              <Route path="/poll" element={<Poll />} />
              <Route path="/poll/:sessionId" element={<Poll />} />
              <Route path="/discussion" element={<Discussion />} />
              <Route path="/discussion/:sessionId" element={<Discussion />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
        </div>
      </Router>
    </AppContext.Provider>
  )
}

export default App