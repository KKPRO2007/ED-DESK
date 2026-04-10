export interface PeerRecord {
  id: string
  displayName: string
  address: string
  port: number
  status: 'online' | 'stale'
  transport: 'wifi'
  capabilities: string[]
  lastSeen: number
  hostedSession: HostedSessionSummary | null
}

export interface HostedSessionSummary {
  code: string
  name: string
  description: string
  visibility: 'public' | 'private'
  passwordRequired: boolean
  participantCount: number
  updatedAt: number
}

export interface ConversationRecord {
  id: string
  peerId: string
  peerName: string
  sessionCode: string | null
  lastMessage: string
  updatedAt: number
  unreadCount: number
}

export interface ChatMessageRecord {
  id: string
  conversationId: string
  peerId: string
  peerName: string
  senderName: string
  recipientName: string
  sessionMessageId?: string
  content: string
  direction: 'incoming' | 'outgoing'
  transport: 'wifi' | 'demo' | 'local'
  status: 'pending' | 'delivered' | 'failed'
  createdAt: number
  deliveredAt?: number
  hash: string
  previousHash: string
  attachmentId?: string
  attachmentType?: 'image' | 'pdf' | 'doc' | 'ppt' | 'file'
  attachmentName?: string
  attachmentSize?: number
  attachmentMime?: string
  attachmentData?: string
}

export interface AttachmentRecord {
  id: string
  messageId: string
  conversationId: string
  peerId: string
  type: 'image' | 'pdf' | 'doc' | 'ppt' | 'file'
  name: string
  size: number
  mime: string
  data: string
  savedPath?: string
  createdAt: number
}

export interface AssessmentQuestion {
  id: string
  prompt: string
  type: 'mcq' | 'true-false' | 'short-answer'
  options?: string[]
  correctAnswer?: string
  points: number
}

export interface AssessmentRecord {
  id: string
  code: string
  title: string
  description: string
  creatorName: string
  hostPeerId: string
  origin: 'local' | 'remote'
  status: 'draft' | 'active' | 'closed'
  timeLimitMinutes: number
  sharedWithPeers: boolean
  createdAt: number
  updatedAt: number
  questions: AssessmentQuestion[]
}

export interface AssessmentSubmissionRecord {
  id: string
  assessmentId: string
  participantName: string
  answers: Record<string, string>
  score: number
  submittedAt: number
  status: 'submitted' | 'synced'
}

export interface LedgerRecord {
  id: string
  entityType: 'message' | 'assessment' | 'submission'
  entityId: string
  action: string
  hash: string
  previousHash: string
  createdAt: number
  payload: Record<string, unknown>
}

export interface BackendStatus {
  peerId: string
  displayName: string
  localAddress: string
  serverPort: number
  discoveryPort: number
  backendMode: 'offline-desktop'
  blockchainMode: 'hash-ledger'
  bluetoothSupported: false
  wifiDiscoveryEnabled: boolean
  peersOnline: number
  conversations: number
  assessments: number
  recordsInLedger: number
  activeHostedSession: HostedSessionSummary | null
}

export interface SessionRecord {
  id: string
  code: string
  name: string
  description: string
  hostPeerId: string
  hostDisplayName: string
  visibility: 'public' | 'private'
  password: string | null
  participantPeerIds: string[]
  createdAt: number
  updatedAt: number
  status: 'waiting' | 'active'
}

export interface DevicePermissions {
  nearbyScan: 'prompt' | 'granted' | 'denied'
  localNetwork: 'granted'
}

export const offlineApi = {
  getStatus: () => window.electronAPI.offline.getStatus() as Promise<BackendStatus | null>,
  getProfile: () => window.electronAPI.offline.getProfile() as Promise<{ peerId: string; displayName: string } | null>,
  getPermissions: () => window.electronAPI.offline.getPermissions() as Promise<DevicePermissions>,
  updatePermissions: (payload: Partial<DevicePermissions>) => window.electronAPI.offline.updatePermissions(payload) as Promise<DevicePermissions>,
  scanPeers: () => window.electronAPI.offline.scanPeers() as Promise<PeerRecord[]>,
  listPeers: () => window.electronAPI.offline.listPeers() as Promise<PeerRecord[]>,
  listSessions: () => window.electronAPI.offline.listSessions() as Promise<Array<SessionRecord & { address: string; peerStatus: PeerRecord['status'] }>>,
  getHostedSession: () => window.electronAPI.offline.getHostedSession() as Promise<SessionRecord | null>,
  createHostedSession: (payload: {
    code?: string
    name: string
    description: string
    visibility: 'public' | 'private'
    password?: string
  }) => window.electronAPI.offline.createHostedSession(payload) as Promise<SessionRecord>,
  closeHostedSession: () => window.electronAPI.offline.closeHostedSession() as Promise<void>,
  joinSessionByCode: (code: string, password?: string) => window.electronAPI.offline.joinSessionByCode(code, password) as Promise<SessionRecord>,
  listConversations: () => window.electronAPI.offline.listConversations() as Promise<ConversationRecord[]>,
  deleteConversation: (conversationId: string) => window.electronAPI.offline.deleteConversation(conversationId) as Promise<void>,
  getMessages: (conversationId: string) => window.electronAPI.offline.getMessages(conversationId) as Promise<ChatMessageRecord[]>,
  sendMessage: (
    peerId: string,
    content: string,
    sessionCode?: string,
    attachment?: {
      type: AttachmentRecord['type']
      name: string
      size: number
      mime: string
      data: string
    },
    options?: {
      persistLocal?: boolean
      sessionMessageId?: string
      senderPeerId?: string
      senderName?: string
    }
  ) => window.electronAPI.offline.sendMessage(peerId, content, sessionCode, attachment, options) as Promise<ChatMessageRecord>,
  getAttachment: (attachmentId: string) => window.electronAPI.offline.getAttachment(attachmentId) as Promise<AttachmentRecord | undefined>,
  getSessionMessages: (sessionCode: string) => window.electronAPI.offline.getSessionMessages(sessionCode) as Promise<ChatMessageRecord[]>,
  saveAttachmentToDisk: (attachmentId: string, suggestedName: string) => window.electronAPI.offline.saveAttachmentToDisk(attachmentId, suggestedName) as Promise<{ canceled: boolean; filePath?: string }>,
  removeParticipant: (peerId: string) => window.electronAPI.offline.removeParticipant(peerId) as Promise<void>,
  listAssessments: () => window.electronAPI.offline.listAssessments() as Promise<AssessmentRecord[]>,
  createAssessment: (payload: {
    title: string
    description: string
    creatorName?: string
    timeLimitMinutes: number
    sharedWithPeers: boolean
    questions: AssessmentQuestion[]
  }) => window.electronAPI.offline.createAssessment(payload) as Promise<AssessmentRecord>,
  submitAssessment: (payload: {
    assessmentId: string
    participantName: string
    answers: Record<string, string>
  }) => window.electronAPI.offline.submitAssessment(payload) as Promise<AssessmentSubmissionRecord>,
  listSubmissions: (assessmentId: string) => window.electronAPI.offline.listSubmissions(assessmentId) as Promise<AssessmentSubmissionRecord[]>,
  listLedger: () => window.electronAPI.offline.listLedger() as Promise<LedgerRecord[]>
}
