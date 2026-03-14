export interface User {
  id: string
  name: string
  role: 'teacher' | 'student' | 'admin'
  avatar: string
  deviceId: string
  publicKey?: string
  department?: string
  year?: number
}

export interface Session {
  id: string
  name: string
  type: 'chat' | 'assessment' | 'quiz' | 'poll' | 'discussion'
  createdBy: string
  creatorName: string
  createdAt: Date
  status: 'active' | 'ended' | 'scheduled'
  joinCode: string
  isEncrypted: boolean
  encryptionType?: 'blockchain' | 'end-to-end'
  password?: string
  participants: Participant[]
  maxParticipants?: number
  metadata: any
}

export interface Participant {
  userId: string
  userName: string
  role: 'host' | 'co-host' | 'participant'
  joinedAt: Date
  deviceId: string
}

export interface Message {
  id: string
  sessionId: string
  senderId: string
  senderName: string
  senderAvatar: string
  content: string
  type: 'text' | 'code' | 'image' | 'file' | 'system'
  timestamp: Date
  isEncrypted: boolean
  isEdited: boolean
  replyTo?: string
  reactions: { [emoji: string]: string[] }
  attachments?: Attachment[]
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
}

export interface Question {
  id: string
  text: string
  type: 'mcq' | 'true-false' | 'short-answer' | 'coding' | 'file-upload'
  options?: string[]
  correctAnswer?: string | number
  points: number
  codeTemplate?: string
  testCases?: TestCase[]
  rubric?: RubricItem[]
}

export interface TestCase {
  input: string
  expectedOutput: string
  weight: number
}

export interface RubricItem {
  criterion: string
  maxPoints: number
  description: string
}

export interface Assessment {
  id: string
  sessionId: string
  title: string
  description: string
  questions: Question[]
  timeLimit?: number
  startTime?: Date
  endTime?: Date
  shuffleQuestions: boolean
  shuffleOptions: boolean
  showResults: 'immediately' | 'after-end' | 'never'
  allowRetake: boolean
  maxAttempts: number
  proctoring: boolean
}

export interface Poll {
  id: string
  sessionId: string
  question: string
  options: PollOption[]
  isMultipleChoice: boolean
  isAnonymous: boolean
  createdBy: string
  createdAt: Date
  endTime?: Date
  totalVotes: number
}

export interface PollOption {
  id: string
  text: string
  votes: string[] // userIds
}

export interface Discussion {
  id: string
  sessionId: string
  topic: string
  content: string
  attachments?: Attachment[]
  createdBy: string
  creatorName: string
  createdAt: Date
  replies: DiscussionReply[]
  tags: string[]
  isPinned: boolean
}

export interface DiscussionReply {
  id: string
  userId: string
  userName: string
  userAvatar: string
  content: string
  timestamp: Date
  likes: string[]
  attachments?: Attachment[]
}

export interface SystemMetrics {
  cpu: {
    usage: number
    cores: number
    model: string
  }
  memory: {
    total: number
    used: number
    free: number
    usagePercent: number
  }
  storage: {
    total: number
    used: number
    free: number
    usagePercent: number
  }
  network: {
    ipAddress: string
    type: 'wifi' | 'ethernet' | 'none'
    strength: number
    downloadSpeed: number
    uploadSpeed: number
  }
  bluetooth: {
    available: boolean
    enabled: boolean
    connectedDevices: number
    discoverable: boolean
  }
  battery?: {
    available: boolean
    charging: boolean
    level: number
    timeRemaining: number
  }
}

export interface NearbyDevice {
  id: string
  name: string
  type: 'computer' | 'laptop' | 'tablet' | 'phone'
  signal: number
  ipAddress: string
  lastSeen: Date
  capabilities: {
    bluetooth: boolean
    wifi: boolean
    blockchain: boolean
  }
}