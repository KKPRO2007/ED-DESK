import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  offlineApi,
  type AttachmentRecord,
  type BackendStatus,
  type ChatMessageRecord,
  type ConversationRecord,
  type DevicePermissions,
  type PeerRecord,
  type SessionRecord
} from '../offlineApi'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface Message {
  id: string
  sender: string
  role: 'teacher' | 'student' | 'admin' | 'system'
  content: string
  timestamp: Date
  isOwn: boolean
  system?: boolean
  delivered?: boolean
  failed?: boolean
  attachmentId?: string
  attachmentType?: AttachmentRecord['type']
  attachmentName?: string
  attachmentSize?: number
  attachmentMime?: string
  attachmentData?: string // base64 data URL for preview
}

interface Session {
  code: string
  peerId: string
  name: string
  peerDisplayName: string
  mode: 'host' | 'peer'
  participants: number
  encrypted: boolean
  created: Date
  description?: string
  activeUsers: string[]
  messageCount: number
  lastActivity: Date
  address: string
  transport: 'wifi'
  status: 'online' | 'stale'
  conversationId: string | null
  backendSessionId: string | null
  isHistory?: boolean // viewing a past chat (read-only if stale)
}

interface Participant {
  id: string
  name: string
  role: 'teacher' | 'student' | 'admin'
  status: 'online' | 'away' | 'offline'
  joinedAt: Date
  device: string
  ipAddress: string
  messagesSent: number
}

interface NetworkNode {
  id: string
  name: string
  latency: number
  status: 'connected' | 'connecting' | 'lost'
}

interface HistoryEntry {
  session: Session
  lastMessage: string
  unreadCount: number
  conversationIds: string[]
}

interface PendingFile {
  dataUrl: string
  mimeType: string
  name: string
  size: number
  fileType: AttachmentRecord['type']
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const POLL_INTERVAL = 1500

const getErr = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const inferRole = (name: string): 'teacher' | 'student' | 'admin' => {
  const v = name.toLowerCase()
  if (v.includes('teacher') || v.includes('faculty') || v.includes('prof')) return 'teacher'
  if (v.includes('admin') || v.includes('staff')) return 'admin'
  return 'student'
}

const dedupeById = <T extends { id: string }>(arr: T[]): T[] => {
  const seen = new Set<string>()
  return arr.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

const guessFileType = (mime: string, name: string): AttachmentRecord['type'] => {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['doc', 'docx'].includes(ext) || mime.includes('word')) return 'doc'
  if (['ppt', 'pptx'].includes(ext) || mime.includes('presentation')) return 'ppt'
  return 'file'
}

const fmtFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(2)} MB`
}

const fileTypeIcon = (type?: string): string => {
  switch (type) {
    case 'image': return '🖼'
    case 'pdf': return '📄'
    case 'doc': return '📝'
    case 'ppt': return '📊'
    default: return '📎'
  }
}

const normalizeDataUrl = (data: string, mime: string): string => {
  if (data.startsWith('data:')) return data
  return `data:${mime};base64,${data}`
}

const parseLegacyInlineImage = (
  content: string
): { attachmentType: 'image'; attachmentMime: string; attachmentData: string; content: string } | null => {
  if (!content.startsWith('__IMG__:')) return null

  try {
    const parsed = JSON.parse(content.slice(8)) as { data?: string; type?: string }
    if (!parsed.data) return null
    return {
      attachmentType: 'image',
      attachmentMime: parsed.type || 'image/png',
      attachmentData: parsed.data,
      content: ''
    }
  } catch {
    return null
  }
}

const formatConversationPreview = (content: string): string => {
  if (content.startsWith('__IMG__:')) return '[IMAGE]'
  return content
}

// Session persistence (localStorage — fine for Electron renderer)
const SESSION_KEY = 'eddesk-active-chat-session-v2'

const saveActiveSession = (session: Session | null): void => {
  if (!session) { localStorage.removeItem(SESSION_KEY); return }
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    ...session,
    created: session.created.toISOString(),
    lastActivity: session.lastActivity.toISOString()
  }))
}

const loadSavedSession = (): Session | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(p as unknown as Session),
      created: new Date(p.created as string),
      lastActivity: new Date(p.lastActivity as string)
    }
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

const findConversation = (
  convs: ConversationRecord[],
  peerId: string,
  code?: string | null
): ConversationRecord | undefined => {
  const norm = code?.trim().toUpperCase() || null
  return convs.find((c) => c.peerId === peerId && (c.sessionCode ?? null) === norm)
}

const findBestConversation = (
  convs: ConversationRecord[],
  peerId: string,
  code?: string | null
): ConversationRecord | undefined => {
  const exact = findConversation(convs, peerId, code)
  if (exact) return exact
  const peerConvs = convs.filter((c) => c.peerId === peerId).sort((a, b) => b.updatedAt - a.updatedAt)
  if (peerConvs.length === 1) return peerConvs[0]
  return peerConvs.find((c) => c.sessionCode) ?? peerConvs[0]
}

const findSessionConversations = (
  convs: ConversationRecord[],
  code?: string | null
): ConversationRecord[] => {
  const norm = code?.trim().toUpperCase() || null
  if (!norm) return []
  return convs
    .filter((conv) => (conv.sessionCode ?? null) === norm)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

const buildHistoryEntries = (
  convs: ConversationRecord[],
  peers: PeerRecord[],
  myName: string
): HistoryEntry[] => {
  const grouped = new Map<string, ConversationRecord[]>()
  for (const conv of convs) {
    const key = conv.sessionCode ? `session:${conv.sessionCode}` : `conv:${conv.id}`
    const bucket = grouped.get(key) ?? []
    bucket.push(conv)
    grouped.set(key, bucket)
  }

  return [...grouped.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => b.updatedAt - a.updatedAt)
      const primary = sorted[0]
      const hostPeer = primary.sessionCode
        ? peers.find((peer) => peer.hostedSession?.code === primary.sessionCode)
        : undefined
      const directPeer = peers.find((peer) => peer.id === primary.peerId)
      return {
        session: buildHistorySession(primary, hostPeer ?? directPeer, myName),
        lastMessage: formatConversationPreview(primary.lastMessage),
        unreadCount: group.reduce((sum, item) => sum + item.unreadCount, 0),
        conversationIds: group.map((item) => item.id)
      }
    })
    .sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime())
}

const makeSessionMessageId = (): string =>
  `session-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const buildPeerSession = (
  peer: PeerRecord,
  conv: ConversationRecord | undefined,
  myName: string
): Session => ({
  code: conv?.sessionCode ?? peer.hostedSession?.code ?? peer.id.slice(-6).toUpperCase(),
  peerId: peer.id,
  name: peer.hostedSession?.name?.trim() || `Chat with ${peer.displayName}`,
  peerDisplayName: peer.displayName,
  mode: 'peer',
  participants: 2,
  encrypted: peer.hostedSession?.visibility === 'private',
  created: new Date(conv?.updatedAt ?? peer.lastSeen),
  description: `Offline LAN chat with ${peer.displayName}`,
  activeUsers: [myName, peer.displayName],
  messageCount: conv?.unreadCount ?? 0,
  lastActivity: new Date(conv?.updatedAt ?? peer.lastSeen),
  address: peer.address,
  transport: 'wifi',
  status: peer.status,
  conversationId: conv?.id ?? null,
  backendSessionId: null
})

const buildHistorySession = (
  conv: ConversationRecord,
  peer: PeerRecord | undefined,
  myName: string
): Session => ({
  code: conv.sessionCode ?? peer?.hostedSession?.code ?? conv.peerId.slice(-6).toUpperCase(),
  peerId: conv.peerId,
  name: peer?.hostedSession?.name?.trim() || `Chat with ${conv.peerName}`,
  peerDisplayName: peer?.displayName ?? conv.peerName,
  mode: 'peer',
  participants: 2,
  encrypted: peer?.hostedSession?.visibility === 'private',
  created: new Date(conv.updatedAt),
  description: peer?.hostedSession?.description || `Previous chat with ${conv.peerName}`,
  activeUsers: [myName, peer?.displayName ?? conv.peerName],
  messageCount: conv.unreadCount,
  lastActivity: new Date(conv.updatedAt),
  address: peer?.address ?? '',
  transport: 'wifi',
  status: peer?.status === 'online' ? 'online' : 'stale',
  conversationId: conv.id,
  backendSessionId: null,
  isHistory: true
})

const buildHostSession = (
  backendSession: SessionRecord,
  profile: { peerId: string; displayName: string } | null,
  status: BackendStatus | null
): Session => ({
  code: backendSession.code,
  peerId: profile?.peerId ?? 'local-host',
  name: backendSession.name,
  peerDisplayName: profile?.displayName ?? 'You',
  mode: 'host',
  participants: 1 + backendSession.participantPeerIds.length,
  encrypted: backendSession.visibility === 'private',
  created: new Date(backendSession.createdAt),
  description: backendSession.description || 'Share the code below with your friend to chat.',
  activeUsers: [profile?.displayName ?? 'You'],
  messageCount: 0,
  lastActivity: new Date(backendSession.updatedAt),
  address: status?.localAddress ?? '127.0.0.1',
  transport: 'wifi',
  status: 'online',
  conversationId: null,
  backendSessionId: backendSession.id
})

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function Chat() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sessionCodeParam = searchParams.get('code')?.toUpperCase() ?? ''

  // ── Core state ────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [networkNodes, setNetworkNodes] = useState<NetworkNode[]>([])
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null)
  const [profile, setProfile] = useState<{ peerId: string; displayName: string } | null>(null)
  const [peerRecords, setPeerRecords] = useState<PeerRecord[]>([])
  const [permissions, setPermissions] = useState<DevicePermissions | null>(null)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [activeSessions, setActiveSessions] = useState<Session[]>([])

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isScanning, setIsScanning] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [nearbySessions, setNearbySessions] = useState<Session[]>([])
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [showParticipants, setShowParticipants] = useState(false)
  const [showNetworkPanel, setShowNetworkPanel] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showImagePreview, setShowImagePreview] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [isJoining, setIsJoining] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createVisibility, setCreateVisibility] = useState<'public' | 'private'>('public')
  const [createPassword, setCreatePassword] = useState('')
  const [selectedTab, setSelectedTab] = useState<'messages' | 'logs' | 'network'>('messages')
  const [filter, setFilter] = useState<'all' | 'teacher' | 'student'>('all')
  const [broadcastMode, setBroadcastMode] = useState(false)
  const [packetCount, setPacketCount] = useState(0)
  const [rxBytes, setRxBytes] = useState(0)
  const [txBytes, setTxBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [permPrompt, setPermPrompt] = useState(false)
  const [kickConfirm, setKickConfirm] = useState<Participant | null>(null)
  const [sessionLogs, setSessionLogs] = useState<string[]>([])
  const [time, setTime] = useState(new Date())
  const [savingAttachment, setSavingAttachment] = useState<string | null>(null)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionRef = useRef<Session | null>(null)
  const isPollingRef = useRef(false)
  const knownMsgIdsRef = useRef<Set<string>>(new Set())
  const userScrolledUpRef = useRef(false)
  const scanAfterPermRef = useRef(false)
  currentSessionRef.current = currentSession

  // ── Helpers ───────────────────────────────────────────────────────────────
  const fmt = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const fmtShort = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

  const normalizedJoinCode = joinCode.trim().toUpperCase()
  const selectedJoinSession = useMemo(
    () => nearbySessions.find((session) => session.code === normalizedJoinCode) ?? null,
    [nearbySessions, normalizedJoinCode]
  )

  const addLog = useCallback((msg: string) => {
    setSessionLogs((prev) => [`[${fmt(new Date())}] ${msg}`, ...prev.slice(0, 99)])
  }, [])

  const showErr = useCallback((msg: string) => {
    setError(msg)
    setTimeout(() => setError(null), 5000)
  }, [])

  const buildPeerParticipants = useCallback(
    (
      session: Session,
      snap: {
        status: BackendStatus | null
        profile: { peerId: string; displayName: string } | null
        peers: PeerRecord[]
        convs: ConversationRecord[]
      }
    ): Participant[] => {
      const entries = new Map<string, Participant>()
      entries.set(snap.profile?.peerId ?? 'local', {
        id: snap.profile?.peerId ?? 'local',
        name: snap.profile?.displayName ?? 'You',
        role: inferRole(snap.profile?.displayName ?? 'You'),
        status: 'online',
        joinedAt: new Date(),
        device: 'This Device',
        ipAddress: snap.status?.localAddress ?? '127.0.0.1',
        messagesSent: 0
      })

      const sessionConvs = findSessionConversations(snap.convs, session.code)
      const peerIds = new Set<string>([session.peerId, ...sessionConvs.map((conv) => conv.peerId)])

      for (const peerId of peerIds) {
        const peer = snap.peers.find((item) => item.id === peerId)
        const conv = sessionConvs.find((item) => item.peerId === peerId)
        const isHost = peerId === session.peerId
        const isLiveHost = isHost && peer?.status === 'online' && peer.hostedSession?.code === session.code
        entries.set(peerId, {
          id: peerId,
          name: peer?.displayName ?? conv?.peerName ?? (isHost ? session.peerDisplayName : 'Participant'),
          role: inferRole(peer?.displayName ?? conv?.peerName ?? session.peerDisplayName),
          status: isLiveHost ? 'online' : peer?.status === 'online' ? 'online' : 'away',
          joinedAt: conv ? new Date(conv.updatedAt) : session.created,
          device: peer?.displayName ?? conv?.peerName ?? 'LAN Peer',
          ipAddress: peer?.address ?? (isHost ? session.address : ''),
          messagesSent: 0
        })
      }

      return [...entries.values()]
    },
    []
  )

  // ── Clock ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // ── Scroll management ─────────────────────────────────────────────────────
  // When session changes: reset scroll state and jump to bottom
  useEffect(() => {
    userScrolledUpRef.current = false
    knownMsgIdsRef.current = new Set()
    const container = messagesContainerRef.current
    if (container) {
      // Immediate scroll to bottom on session switch
      container.scrollTop = container.scrollHeight
    }
  }, [currentSession?.code, currentSession?.peerId])

  // When new messages arrive: only auto-scroll if user is at (or near) the bottom
  useEffect(() => {
    if (messages.length === 0) return
    if (userScrolledUpRef.current) return
    // Scroll to bottom
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages.length])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    // If user scrolls more than 80px up, stop auto-scrolling
    userScrolledUpRef.current = distanceFromBottom > 80
  }, [])

  // ── Map ChatMessageRecord → Message ───────────────────────────────────────
  const mapRecord = useCallback(
    (r: ChatMessageRecord, prof: { peerId: string; displayName: string } | null): Message => {
      const legacyImage = parseLegacyInlineImage(r.content)
      return {
        id: r.id,
        sender:
          r.direction === 'outgoing'
            ? (prof?.displayName ?? 'You')
            : r.senderName || r.peerName,
        role: inferRole(
          r.direction === 'outgoing'
            ? (prof?.displayName ?? '')
            : r.senderName || r.peerName
        ),
        content: legacyImage?.content ?? r.content,
        timestamp: new Date(r.createdAt),
        isOwn: r.direction === 'outgoing',
        delivered: r.status === 'delivered',
        failed: r.status === 'failed',
        attachmentId: r.attachmentId,
        attachmentType: legacyImage?.attachmentType ?? r.attachmentType,
        attachmentName: r.attachmentName,
        attachmentSize: r.attachmentSize,
        attachmentMime: legacyImage?.attachmentMime ?? r.attachmentMime,
        attachmentData: legacyImage?.attachmentData ?? r.attachmentData
      }
    },
    []
  )

  // ── Snapshot loader ───────────────────────────────────────────────────────
  const loadSnapshot = useCallback(
    async (scan = false, applyState = true) => {
      try {
        if (scan) {
          const perms = await offlineApi.getPermissions()
          if (perms.nearbyScan !== 'granted') { setPermPrompt(true); return null }
          await offlineApi.scanPeers()
          await new Promise((r) => setTimeout(r, 1000))
        }

        const [status, profileData, peers, convs] = await Promise.all([
          offlineApi.getStatus(),
          offlineApi.getProfile(),
          offlineApi.listPeers(),
          offlineApi.listConversations()
        ])

        const sessions = peers
          .filter((p) => p.status === 'online' && p.hostedSession)
          .map((p) =>
            buildPeerSession(p, findBestConversation(convs, p.id, p.hostedSession?.code), profileData?.displayName ?? 'You')
          )

        const history = buildHistoryEntries(convs, peers, profileData?.displayName ?? 'You')

        if (applyState) {
          setBackendStatus(status)
          setProfile(profileData)
          setPeerRecords(peers)
          setActiveSessions(sessions)
          setNearbySessions(sessions)
          setHistoryEntries(history)
          setNetworkNodes([
            { id: status?.peerId ?? 'local', name: 'Local Backend', latency: 1, status: 'connected' },
            ...peers.slice(0, 5).map((p, i) => ({
              id: p.id,
              name: p.displayName,
              latency: p.status === 'online' ? 10 + i * 8 : 999,
              status: p.status === 'online' ? ('connected' as const) : ('lost' as const)
            }))
          ])
        }

        return { status, profile: profileData, peers, convs, allSessions: sessions }
      } catch (e) {
        addLog(`Backend error: ${getErr(e)}`)
        return null
      }
    },
    [addLog]
  )

  // ── Inject system message (once) ──────────────────────────────────────────
  const injectSys = useCallback((id: string, content: string) => {
    if (knownMsgIdsRef.current.has(id)) return
    knownMsgIdsRef.current.add(id)
    const msg: Message = {
      id, sender: 'System', role: 'system',
      content, timestamp: new Date(), isOwn: false, system: true
    }
    setMessages((prev) => dedupeById([...prev, msg]))
  }, [])

  // ── Load messages for a session ───────────────────────────────────────────
  const loadMessages = useCallback(
    async (
      session: Session,
      status: BackendStatus | null,
      prof: { peerId: string; displayName: string } | null
    ) => {
      knownMsgIdsRef.current = new Set()
      userScrolledUpRef.current = false

      const sysId = `sys-${session.peerId}`
      const sysContent = `BACKEND · ${status?.localAddress ?? '127.0.0.1'}:${status?.serverPort ?? 0} · WIFI ${session.status.toUpperCase()}`
      const systemMsg: Message = {
        id: sysId, sender: 'System', role: 'system',
        content: sysContent, timestamp: new Date(), isOwn: false, system: true
      }
      knownMsgIdsRef.current.add(sysId)

      const baseMessages: Message[] = [systemMsg]
      if (session.mode === 'host') {
        const codeId = `host-code-${session.code}`
        const codeMsg: Message = {
          id: codeId, sender: 'System', role: 'system',
          content: `SESSION CREATED · CODE: ${session.code} · Share this code with your friend.`,
          timestamp: new Date(), isOwn: false, system: true
        }
        knownMsgIdsRef.current.add(codeId)
        baseMessages.push(codeMsg)
      }

      try {
        const records = session.code
          ? await offlineApi.getSessionMessages(session.code)
          : session.conversationId
            ? await offlineApi.getMessages(session.conversationId)
            : []

        if (records.length === 0 && session.mode === 'peer') {
          const emptyId = `empty-${session.peerId}`
          const emptyMsg: Message = {
            id: emptyId, sender: 'System', role: 'system',
            content: `CONNECTED TO ${session.name.toUpperCase()} · Send a message to start`,
            timestamp: new Date(), isOwn: false, system: true
          }
          knownMsgIdsRef.current.add(emptyId)
          baseMessages.push(emptyMsg)
        }

        const mapped = records.map((r) => mapRecord(r, prof))
        const all = dedupeById([...baseMessages, ...mapped])
        all.forEach((m) => knownMsgIdsRef.current.add(m.id))
        setMessages(all)
        setPacketCount(records.length)
        setRxBytes(records.filter((r) => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
        setTxBytes(records.filter((r) => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
      } catch (e) {
        addLog(`Load messages failed: ${getErr(e)}`)
      }
    },
    [addLog, mapRecord]
  )

  // ── Open session ──────────────────────────────────────────────────────────
  const openSession = useCallback(
    async (session: Session) => {
      setCurrentSession(session)
      setMessages([])
      knownMsgIdsRef.current = new Set()
      userScrolledUpRef.current = false
      setShowJoinModal(false)
      setJoinCode('')
      setJoinPassword('')
      setSelectedTab('messages')
      navigate(`/chat?code=${session.code}`, { replace: true })
      addLog(`Session opened · ${session.name}`)

      const snap = await loadSnapshot(false)
      const status = snap?.status ?? null
      const prof = snap?.profile ?? null

      if (session.mode === 'peer' && snap) {
        const sessionConvs = findSessionConversations(snap.convs, session.code)
        const freshConv =
          findBestConversation(snap.convs, session.peerId, session.code) ??
          sessionConvs[0]
        const freshSession = { ...session, conversationId: freshConv?.id ?? null }
        setCurrentSession(freshSession)
        setParticipants(buildPeerParticipants(freshSession, snap))
        await loadMessages(freshSession, status, prof)
      } else {
        setParticipants([
          {
            id: prof?.peerId ?? 'local', name: prof?.displayName ?? 'You',
            role: inferRole(prof?.displayName ?? 'You'), status: 'online',
            joinedAt: new Date(), device: 'This Device',
            ipAddress: status?.localAddress ?? '127.0.0.1', messagesSent: 0
          }
        ])
        await loadMessages(session, status, prof)
      }
    },
    [addLog, buildPeerParticipants, loadMessages, loadSnapshot, navigate]
  )

  // ── Back to welcome (exit history/session view without leaving) ───────────
  const backToWelcome = useCallback(() => {
    setCurrentSession(null)
    setMessages([])
    setParticipants([])
    knownMsgIdsRef.current = new Set()
    setBroadcastMode(false)
    saveActiveSession(null)
    navigate('/chat', { replace: true })
  }, [navigate])

  // ── Leave session (with backend cleanup) ──────────────────────────────────
  const leaveSession = useCallback(async () => {
    const sess = currentSession
    if (!sess) return

    if (sess.mode === 'host') {
      const snap = await loadSnapshot(false, false)
      const hosted = await offlineApi.getHostedSession().catch(() => null)
      if (hosted) {
        // Best-effort notify all participants
        if (snap) {
          await Promise.allSettled(
            hosted.participantPeerIds.map(async (pid) => {
              const peer = snap.peers.find((p) => p.id === pid)
              if (peer) {
                await offlineApi.sendMessage(
                  pid,
                  `__SYS__:HOST_CLOSED:${sess.code}`,
                  sess.code,
                  undefined,
                  { persistLocal: false }
                ).catch(() => {})
              }
            })
          )
        }
        try { await offlineApi.closeHostedSession() } catch { /* ignore */ }
      }
      addLog('Hosted session closed')
    } else {
      // Best-effort notify host
      try {
        await offlineApi.sendMessage(
          sess.peerId,
          `__SYS__:PEER_LEFT:${profile?.displayName ?? 'A user'}`,
          sess.code,
          undefined,
          { persistLocal: false }
        )
      } catch { /* ignore */ }
    }

    backToWelcome()
    await loadSnapshot(false)
  }, [addLog, backToWelcome, currentSession, loadSnapshot, profile])

  // ── Kick participant ──────────────────────────────────────────────────────
  const kickParticipant = useCallback(
    async (participant: Participant) => {
      setKickConfirm(null)
      if (!currentSession || currentSession.mode !== 'host') return
      try {
        // Best-effort notify the kicked peer
        await offlineApi.sendMessage(
          participant.id,
          `__SYS__:KICKED:${participant.name}`,
          currentSession.code,
          undefined,
          { persistLocal: false }
        ).catch(() => {})
        // Actually remove from backend session
        await offlineApi.removeParticipant(participant.id)
        setParticipants((prev) => prev.filter((p) => p.id !== participant.id))
        injectSys(`kick-${participant.id}-${Date.now()}`, `${participant.name} was removed from the session`)
        addLog(`Kicked ${participant.name}`)
      } catch (e) {
        showErr(`Kick failed: ${getErr(e)}`)
      }
    },
    [addLog, currentSession, injectSys, showErr]
  )

  // ── Poll refresh ──────────────────────────────────────────────────────────
  const refreshCurrentSession = useCallback(
    async (session: Session) => {
      const snap = await loadSnapshot(false, false)
      if (!snap) return

      const currentPeer = snap.peers.find((p) => p.id === session.peerId)
      const sessionStatus =
        session.mode === 'peer'
          ? (currentPeer?.status === 'online' && currentPeer.hostedSession?.code === session.code ? 'online' : 'stale')
          : 'online'

      // Update system status message in-place
      const sysContent = `BACKEND · ${snap.status?.localAddress ?? '127.0.0.1'}:${snap.status?.serverPort ?? 0} · WIFI ${sessionStatus.toUpperCase()}`
      setMessages((prev) =>
        prev.map((m) =>
          m.id === `sys-${session.peerId}` ? { ...m, content: sysContent } : m
        )
      )

      if (session.mode === 'host') {
        const hosted = await offlineApi.getHostedSession().catch(() => null)
        if (!hosted) return

        const updatedSession = buildHostSession(hosted, snap.profile, snap.status)
        setCurrentSession(updatedSession)
        saveActiveSession(updatedSession)

        const nextParticipants: Participant[] = [
          {
            id: snap.profile?.peerId ?? 'local',
            name: snap.profile?.displayName ?? 'You',
            role: inferRole(snap.profile?.displayName ?? 'You'),
            status: 'online', joinedAt: updatedSession.created,
            device: 'This Device', ipAddress: snap.status?.localAddress ?? '127.0.0.1', messagesSent: 0
          }
        ]
        const seenPeerIds = new Set<string>()

        for (const pid of hosted.participantPeerIds) {
          const peer = snap.peers.find((p) => p.id === pid)
          if (!peer) continue
          if (!seenPeerIds.has(pid)) {
            seenPeerIds.add(pid)
            nextParticipants.push({
              id: pid, name: peer.displayName,
              role: inferRole(peer.displayName),
              status: peer.status === 'online' ? 'online' : 'away',
              joinedAt: new Date(hosted.updatedAt), device: peer.displayName,
              ipAddress: peer.address, messagesSent: 0
            })
            injectSys(`join-${pid}`, `${peer.displayName} joined the session`)
          }
        }

        const allRecords = await offlineApi.getSessionMessages(session.code).catch(() => [] as ChatMessageRecord[])
        const newRecords = allRecords.filter((r) => !knownMsgIdsRef.current.has(r.id))
        if (newRecords.length > 0) {
          const mapped = newRecords.map((r) => mapRecord(r, snap.profile))
          mapped.forEach((m) => knownMsgIdsRef.current.add(m.id))
          setMessages((prev) => dedupeById([...prev, ...mapped]))
        }

        setParticipants(nextParticipants)
        setPacketCount(allRecords.length)
        setRxBytes(allRecords.filter((r) => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
        setTxBytes(allRecords.filter((r) => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
        return
      }

      // Peer mode
      const sessionConvs = findSessionConversations(snap.convs, session.code)
      const convId =
        findBestConversation(snap.convs, session.peerId, session.code)?.id ??
        sessionConvs[0]?.id ??
        session.conversationId
      const hostStillHosting = currentPeer?.status === 'online' && currentPeer.hostedSession?.code === session.code
      const participantList = buildPeerParticipants(session, snap)
      const updatedSession: Session = {
        ...session,
        name: hostStillHosting ? (currentPeer?.hostedSession?.name?.trim() || session.name) : session.name,
        peerDisplayName: currentPeer?.displayName ?? session.peerDisplayName,
        status: hostStillHosting ? 'online' : 'stale',
        conversationId: convId,
        participants: Math.max(participantList.length, session.participants)
      }
      setCurrentSession(updatedSession)
      saveActiveSession(updatedSession)

      if (!hostStillHosting && session.status === 'online') {
        injectSys(
          `leave-${session.peerId}-${Date.now()}`,
          `${session.peerDisplayName} closed or left this session`
        )
      }

      setParticipants(participantList)

      const records = await offlineApi.getSessionMessages(session.code).catch(() => [] as ChatMessageRecord[])
      if (records.length === 0 && !convId) { setPacketCount(0); return }

      const newRecords = records.filter((r) => !knownMsgIdsRef.current.has(r.id))
      if (newRecords.length > 0) {
        const mapped = newRecords.map((r) => mapRecord(r, snap.profile))
        mapped.forEach((m) => knownMsgIdsRef.current.add(m.id))
        setMessages((prev) => dedupeById([...prev, ...mapped]))
      }

      setPacketCount(records.length)
      setRxBytes(records.filter((r) => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
      setTxBytes(records.filter((r) => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
    },
    [buildPeerParticipants, injectSys, loadSnapshot, mapRecord]
  )

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    const boot = async () => {
      const perms = await offlineApi.getPermissions().catch(() => null)
      if (mounted && perms) setPermissions(perms)

      const snap = await loadSnapshot(false)
      if (!mounted || !snap) return

      addLog('Offline backend ready · Electron IPC connected')

      const hosted = await offlineApi.getHostedSession().catch(() => null)
      if (hosted && mounted) {
        const hostSession = buildHostSession(hosted, snap.profile, snap.status)
        if (sessionCodeParam && hostSession.code === sessionCodeParam) {
          await openSession(hostSession); return
        }
      }

      if (sessionCodeParam && snap.allSessions) {
        const match = snap.allSessions.find((s) => s.code === sessionCodeParam)
        if (match && mounted) { await openSession(match); return }
      }

      const saved = loadSavedSession()
      if (!saved) return

      if (saved.mode === 'host') {
        const hostedSession = await offlineApi.getHostedSession().catch(() => null)
        if (hostedSession && hostedSession.code === saved.code) {
          await openSession(buildHostSession(hostedSession, snap.profile, snap.status))
          return
        }
        saveActiveSession(null); return
      }

      const savedPeer = snap.peers.find((p) => p.id === saved.peerId)
      const savedConv = findBestConversation(snap.convs, saved.peerId, saved.code)
      if (savedPeer && mounted) {
        await openSession(buildPeerSession(savedPeer, savedConv, snap.profile?.displayName ?? 'You'))
        return
      }
      if (savedConv && mounted) {
        await openSession({ ...saved, conversationId: savedConv.id, status: 'stale' })
        return
      }
      saveActiveSession(null)
    }
    boot().catch(console.error)
    return () => { mounted = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentSession) return
    const interval = setInterval(async () => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      const sess = currentSessionRef.current
      if (!sess) { isPollingRef.current = false; return }
      try { await refreshCurrentSession(sess) } finally { isPollingRef.current = false }
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [currentSession, refreshCurrentSession])

  // ── Scan ──────────────────────────────────────────────────────────────────
  const scanForSessions = useCallback(async () => {
    const perms = await offlineApi.getPermissions().catch(() => null)
    if (perms?.nearbyScan !== 'granted') {
      scanAfterPermRef.current = true
      setPermPrompt(true); return
    }
    setIsScanning(true)
    addLog('Scanning LAN...')
    try {
      const snap = await loadSnapshot(true)
      if (!snap) return
      const sessions = snap.peers
        .filter((p) => p.status === 'online' && p.hostedSession)
        .map((p) =>
          buildPeerSession(p, findBestConversation(snap.convs, p.id, p.hostedSession?.code), snap.profile?.displayName ?? 'You')
        )
      setNearbySessions(sessions)
      setShowJoinModal(true)
      addLog(sessions.length > 0 ? `Found ${sessions.length} session(s)` : 'No sessions found')
    } catch (e) { showErr(`Scan failed: ${getErr(e)}`) }
    finally { setIsScanning(false) }
  }, [addLog, loadSnapshot, showErr])

  // ── Grant permission ──────────────────────────────────────────────────────
  const grantPermission = useCallback(async () => {
    try {
      const updated = await offlineApi.updatePermissions({ nearbyScan: 'granted' })
      setPermissions(updated)
      setPermPrompt(false)
      addLog('Scan permission granted')
      if (scanAfterPermRef.current) {
        scanAfterPermRef.current = false
        await scanForSessions()
      }
    } catch (e) { showErr(`Permission update failed: ${getErr(e)}`) }
  }, [addLog, scanForSessions, showErr])

  // ── Create session ────────────────────────────────────────────────────────
  const createSession = useCallback(async () => {
    setShowCreateModal(false)
    try {
      addLog('Creating session...')
      const backendSession = await offlineApi.createHostedSession({
        name: createName.trim() || `${profile?.displayName ?? 'My'} Session`,
        description: createDesc.trim() || 'LAN session — share the code to chat offline',
        visibility: createVisibility,
        password: createVisibility === 'private' ? createPassword.trim() || undefined : undefined
      })

      const snap = await loadSnapshot(false)
      const hostSession = buildHostSession(backendSession, snap?.profile ?? profile, snap?.status ?? backendStatus)
      setCurrentSession(hostSession)
      saveActiveSession(hostSession)
      setSelectedTab('messages')
      setBroadcastMode(false)
      knownMsgIdsRef.current = new Set()

      const sysId = 'sys-host'
      const codeId = `host-code-${backendSession.code}`
      knownMsgIdsRef.current.add(sysId)
      knownMsgIdsRef.current.add(codeId)

      setMessages([
        {
          id: sysId, sender: 'System', role: 'system',
          content: `BACKEND · ${snap?.status?.localAddress ?? '127.0.0.1'}:${snap?.status?.serverPort ?? 0} · WIFI READY`,
          timestamp: new Date(), isOwn: false, system: true
        },
        {
          id: codeId, sender: 'System', role: 'system',
          content: `SESSION CREATED · CODE: ${backendSession.code} · Share this with your friend.`,
          timestamp: new Date(), isOwn: false, system: true
        }
      ])

      setParticipants([{
        id: snap?.profile?.peerId ?? 'local', name: snap?.profile?.displayName ?? 'You',
        role: inferRole(snap?.profile?.displayName ?? 'You'), status: 'online',
        joinedAt: new Date(), device: 'This Device',
        ipAddress: snap?.status?.localAddress ?? '127.0.0.1', messagesSent: 0
      }])
      setPacketCount(0); setRxBytes(0); setTxBytes(0)
      navigate(`/chat?code=${backendSession.code}`, { replace: true })
      addLog(`Session ${backendSession.code} created`)
      setCreateName(''); setCreateDesc(''); setCreateVisibility('public'); setCreatePassword('')
    } catch (e) { showErr(`Create failed: ${getErr(e)}`) }
  }, [addLog, backendStatus, createDesc, createName, createPassword, createVisibility, loadSnapshot, navigate, profile, showErr])

  // ── Join by code ──────────────────────────────────────────────────────────
  const joinByCode = useCallback(
    async (code: string, password?: string) => {
      const norm = code.trim().toUpperCase()
      if (!norm || norm.length < 4) { showErr('Enter a valid session code'); return }
      addLog(`Joining ${norm}...`)
      setIsJoining(true)
      try {
        const backendSession = await offlineApi.joinSessionByCode(norm, password)
        const snap = await loadSnapshot(false)
        if (!snap) return
        const peer = snap.peers.find((p) => p.id === backendSession.hostPeerId)
        if (peer) {
          const conv = findBestConversation(snap.convs, peer.id, norm)
          await openSession(buildPeerSession(peer, conv, snap.profile?.displayName ?? 'You'))
        } else {
          const minSession: Session = {
            code: norm, peerId: backendSession.hostPeerId, name: backendSession.name,
            peerDisplayName: backendSession.hostDisplayName, mode: 'peer', participants: 2,
            encrypted: backendSession.visibility === 'private', created: new Date(backendSession.createdAt),
            description: backendSession.description, activeUsers: [snap.profile?.displayName ?? 'You', backendSession.hostDisplayName],
            messageCount: 0, lastActivity: new Date(), address: '', transport: 'wifi', status: 'online',
            conversationId: findBestConversation(snap.convs, backendSession.hostPeerId, norm)?.id ?? null,
            backendSessionId: backendSession.id
          }
          await openSession(minSession)
        }
        setShowJoinModal(false)
        setJoinCode('')
        setJoinPassword('')
        addLog(`Joined ${norm}`)
      } catch (e) { showErr(`Join failed: ${getErr(e)}`); addLog(`Join failed: ${getErr(e)}`) }
      finally { setIsJoining(false) }
    },
    [addLog, loadSnapshot, openSession, showErr]
  )

  const submitJoin = useCallback(() => {
    if (!normalizedJoinCode || isJoining) return
    void joinByCode(normalizedJoinCode, joinPassword.trim() || undefined)
  }, [isJoining, joinByCode, joinPassword, normalizedJoinCode])

  // ── Delete history entry ──────────────────────────────────────────────────
  const deleteHistory = useCallback(
    async (entry: HistoryEntry) => {
      try {
        await Promise.allSettled(
          entry.conversationIds.map((conversationId) => offlineApi.deleteConversation(conversationId))
        )
        if (
          currentSession?.code === entry.session.code ||
          (currentSession?.conversationId != null && entry.conversationIds.includes(currentSession.conversationId))
        ) {
          backToWelcome()
        }
        await loadSnapshot(false)
        addLog(`Deleted history · ${entry.session.peerDisplayName}`)
      } catch (e) { showErr(`Delete failed: ${getErr(e)}`) }
    },
    [addLog, backToWelcome, currentSession?.conversationId, loadSnapshot, showErr]
  )

  // ── File selection ────────────────────────────────────────────────────────
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      if (file.size > MAX_FILE_BYTES) { showErr(`File too large (max ${fmtFileSize(MAX_FILE_BYTES)})`); return }

      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string
        const fileType = guessFileType(file.type, file.name)
        setPendingFile({ dataUrl, mimeType: file.type, name: file.name, size: file.size, fileType })
      }
      reader.readAsDataURL(file)
      e.target.value = ''
    },
    [showErr]
  )

  // ── Save attachment to desktop ────────────────────────────────────────────
  const saveAttachmentToDisk = useCallback(
    async (msg: Message) => {
      if (!msg.attachmentId || !msg.attachmentName) return
      setSavingAttachment(msg.attachmentId)
      try {
        const result = await offlineApi.saveAttachmentToDisk(msg.attachmentId, msg.attachmentName)
        if (!result.canceled) {
          addLog(`Saved: ${result.filePath}`)
          injectSys(`saved-${msg.attachmentId}`, `File saved to ${result.filePath}`)
        }
      } catch (e) {
        showErr(`Save failed: ${getErr(e)}`)
      } finally {
        setSavingAttachment(null)
      }
    },
    [addLog, injectSys, showErr]
  )

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    if ((!newMessage.trim() && !pendingFile) || !currentSession || isSending) return
    if (isReadOnlyMode) return

    const file = pendingFile
    const text = newMessage.trim()
    setNewMessage('')
    setPendingFile(null)
    setIsSending(true)

    // Optimistic message
    const optimisticId = `local-${Date.now()}`
    const optMsg: Message = {
      id: optimisticId,
      sender: profile?.displayName ?? 'You',
      role: inferRole(profile?.displayName ?? 'You'),
      content: text,
      timestamp: new Date(),
      isOwn: true,
      delivered: false,
      failed: false,
      ...(file ? {
        attachmentType: file.fileType,
        attachmentName: file.name,
        attachmentSize: file.size,
        attachmentMime: file.mimeType,
        attachmentData: file.dataUrl
      } : {})
    }
    knownMsgIdsRef.current.add(optimisticId)
    setMessages((prev) => dedupeById([...prev, optMsg]))

    const attachment = file
      ? {
          type: file.fileType,
          name: file.name,
          size: file.size,
          mime: file.mimeType,
          data: file.dataUrl
        }
      : undefined

    const sessionMessageId = makeSessionMessageId()
    const sendTo = async (peerId: string) => {
      await offlineApi.sendMessage(peerId, text, currentSession.code, attachment, { sessionMessageId })
    }

    try {
      let targetPeerIds: string[] = []
      if (currentSession.mode === 'host') {
        const hosted = await offlineApi.getHostedSession().catch(() => null)
        if (!hosted || hosted.participantPeerIds.length === 0) {
          injectSys(`wait-${Date.now()}`, `WAITING FOR FRIEND TO JOIN · Share code: ${currentSession.code}`)
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
          knownMsgIdsRef.current.delete(optimisticId)
          return
        }
        targetPeerIds = hosted.participantPeerIds
      } else if (broadcastMode) {
        targetPeerIds = peerRecords.filter((p) => p.status === 'online').map((p) => p.id)
      } else {
        targetPeerIds = [currentSession.peerId]
      }

      const results = await Promise.allSettled(targetPeerIds.map(sendTo))
      const succeeded = results.filter((result) => result.status === 'fulfilled').length
      if (succeeded === 0) {
        const firstFailure = results.find((result) => result.status === 'rejected')
        throw new Error(firstFailure?.status === 'rejected' ? getErr(firstFailure.reason) : 'Message delivery failed')
      }

      setMessages((prev) =>
        prev.filter((m) => m.id !== optimisticId)
      )
      knownMsgIdsRef.current.delete(optimisticId)
      addLog(
        succeeded < targetPeerIds.length
          ? `Message sent to ${succeeded}/${targetPeerIds.length}${file ? ` [${file.fileType.toUpperCase()}: ${file.name}]` : ''}`
          : `Message sent${file ? ` [${file.fileType.toUpperCase()}: ${file.name}]` : ''}`
      )
    } catch (e) {
      showErr(`Send failed: ${getErr(e)}`)
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, failed: true } : m))
      )
    } finally {
      await refreshCurrentSession(currentSession).catch(() => {})
      setIsSending(false)
      inputRef.current?.focus()
    }
  }, [addLog, broadcastMode, currentSession, injectSys, isSending, newMessage, peerRecords, pendingFile, profile, refreshCurrentSession, showErr])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const isReadOnlyMode = Boolean(
    currentSession?.mode === 'peer' &&
    currentSession?.status === 'stale' &&
    !currentSession?.isHistory === false  // allow viewing history
  )
  // Actually: read-only when stale peer AND session is history-mode
  const canSend = currentSession !== null &&
    !(currentSession.mode === 'peer' && currentSession.status === 'stale')

  const filteredMessages = useMemo(
    () =>
      messages.filter((m) => {
        if (filter === 'teacher') return m.role === 'teacher' || m.system
        if (filter === 'student') return m.role === 'student' || m.system
        return true
      }),
    [filter, messages]
  )

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div className="cr">
      {/* ERROR TOAST */}
      {error && <div className="toast-err">{error}</div>}

      {/* IMAGE PREVIEW */}
      {showImagePreview && (
        <div className="modal-overlay" onClick={() => setShowImagePreview(null)}>
          <div className="img-preview-box" onClick={(e) => e.stopPropagation()}>
            <img src={showImagePreview} alt="Preview" className="img-preview-img" />
            <button className="modal-close" onClick={() => setShowImagePreview(null)}>×</button>
          </div>
        </div>
      )}

      {/* KICK CONFIRM */}
      {kickConfirm && (
        <div className="modal-overlay" onClick={() => setKickConfirm(null)}>
          <div className="modal-box" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">REMOVE PARTICIPANT</div>
            <div className="modal-sub" style={{ marginBottom: 16 }}>
              Remove <strong>{kickConfirm.name}</strong> from this session?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-join" style={{ flex: 1, background: '#3a1010', borderColor: '#c86060' }} onClick={() => kickParticipant(kickConfirm)}>REMOVE</button>
              <button className="btn-join" style={{ flex: 1, background: 'none', border: '1px solid #333' }} onClick={() => setKickConfirm(null)}>CANCEL</button>
            </div>
            <button className="modal-close" onClick={() => setKickConfirm(null)}>×</button>
          </div>
        </div>
      )}

      {/* PERMISSION PROMPT */}
      {permPrompt && (
        <div className="modal-overlay" onClick={() => setPermPrompt(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">NEARBY SCAN PERMISSION</div>
            <div className="modal-sub" style={{ marginBottom: 16 }}>
              ED-DESK needs permission to scan for nearby devices on your local LAN.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-join" style={{ flex: 1 }} onClick={grantPermission}>GRANT PERMISSION</button>
              <button className="btn-join" style={{ flex: 1, background: 'none', border: '1px solid #333' }} onClick={() => setPermPrompt(false)}>CANCEL</button>
            </div>
            <button className="modal-close" onClick={() => setPermPrompt(false)}>×</button>
          </div>
        </div>
      )}

      {/* CREATE MODAL */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">CREATE SESSION</div>
            <div className="modal-sub">Others on the same LAN can scan or enter your code to join</div>
            <div className="create-form">
              <label className="form-label">SESSION NAME</label>
              <input className="code-input" style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                placeholder={`${profile?.displayName ?? 'My'} Session`}
                value={createName} onChange={(e) => setCreateName(e.target.value)} maxLength={40} />
              <label className="form-label">DESCRIPTION (optional)</label>
              <input className="code-input" style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                placeholder="What is this session for?"
                value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} maxLength={100} />
              <label className="form-label">VISIBILITY</label>
              <div className="vis-row">
                <button className={`vis-btn ${createVisibility === 'public' ? 'vis-active' : ''}`} onClick={() => setCreateVisibility('public')}>PUBLIC · Anyone on LAN</button>
                <button className={`vis-btn ${createVisibility === 'private' ? 'vis-active' : ''}`} onClick={() => setCreateVisibility('private')}>PRIVATE · Password required</button>
              </div>
              {createVisibility === 'private' && (
                <>
                  <label className="form-label">PASSWORD</label>
                  <input type="password" className="code-input" style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                    placeholder="Session password" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} />
                </>
              )}
              <button className="btn-join" style={{ marginTop: 8 }} onClick={createSession}>CREATE SESSION</button>
            </div>
            <button className="modal-close" onClick={() => setShowCreateModal(false)}>×</button>
          </div>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <aside className="sb">
        <div className="sb-hdr">
          <span className="sb-title">CHAT SESSIONS</span>
          <span className="sb-time">{fmtShort(time)}</span>
        </div>

        {currentSession ? (
          <div className="s-panel">
            {/* Back button to return to welcome without closing session */}
            <button className="btn-back" onClick={backToWelcome} title="Back to overview">
              ← BACK
            </button>

            <div className="s-code-row">
              <span className="s-code">{currentSession.code}</span>
              <span className={`s-badge ${currentSession.encrypted ? 'badge-priv' : 'badge-pub'}`}>
                {currentSession.encrypted ? 'PRIVATE' : 'PUBLIC'}
              </span>
            </div>

            {currentSession.mode === 'host' && (
              <div className="host-share-box">
                <div className="host-share-label">SHARE THIS CODE</div>
                <div className="host-share-code">{currentSession.code}</div>
                <div className="host-share-hint">Friend opens ED-DESK → Scan LAN or enter code</div>
              </div>
            )}

            <div className="s-desc">{currentSession.description}</div>

            <div className="s-stats">
              <div className="ss"><span>MODE</span><span>{currentSession.mode.toUpperCase()}</span></div>
              <div className="ss"><span>PARTICIPANTS</span><span>{participants.length}</span></div>
              <div className="ss"><span>MESSAGES</span><span>{messages.filter((m) => !m.system).length}</span></div>
              <div className="ss"><span>PACKETS</span><span>{packetCount}</span></div>
              <div className="ss"><span>RX</span><span>{fmtFileSize(rxBytes)}</span></div>
              <div className="ss"><span>TX</span><span>{fmtFileSize(txBytes)}</span></div>
              <div className="ss"><span>ENCRYPT</span><span className="enc-on">AES-256</span></div>
            </div>

            <div className="s-actions">
              <button className="btn-panel" onClick={() => setShowParticipants((p) => !p)}>USERS ({participants.length})</button>
              <button className="btn-panel" onClick={() => setShowNetworkPanel((p) => !p)}>NODES</button>
            </div>

            {showParticipants && (
              <div className="sub-panel">
                <div className="sp-title">PARTICIPANTS</div>
                {participants.map((p) => (
                  <div key={p.id} className="p-row">
                    <span className={`p-dot ${p.status}`} />
                    <div className="p-inf">
                      <span className="p-name">{p.name}</span>
                      <span className="p-role">{p.role.toUpperCase()}</span>
                    </div>
                    <span className="p-ip">{p.ipAddress}</span>
                    {currentSession.mode === 'host' && p.id !== (profile?.peerId ?? 'local') && (
                      <button className="kick-btn" onClick={() => setKickConfirm(p)}>✕</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {showNetworkPanel && (
              <div className="sub-panel">
                <div className="sp-title">NETWORK NODES</div>
                {networkNodes.map((n) => (
                  <div key={n.id} className="n-row">
                    <span className={`n-dot ${n.status}`} />
                    <span className="n-name">{n.name}</span>
                    <span className="n-lat">{n.latency}ms</span>
                  </div>
                ))}
              </div>
            )}

            <button className="btn-leave" onClick={leaveSession}>LEAVE & CLOSE SESSION</button>
          </div>
        ) : (
          <div className="no-sess">
            <div className="no-sess-icon">⬡</div>
            <p>No active session</p>
            <p className="hint">Create or scan to join</p>
          </div>
        )}

        {/* CHAT HISTORY */}
        <div className="history-panel">
          <div className="sp-title">CHAT HISTORY</div>
          {historyEntries.length > 0 ? (
            <div className="history-list">
              {historyEntries.map((entry) => (
                <div
                  key={entry.conversationIds.join('|')}
                  className={`history-item ${currentSession?.code === entry.session.code ? 'history-item-active' : ''}`}
                >
                  <button
                    className="history-open"
                    onClick={() => void openSession(entry.session)}
                    title={entry.session.status === 'stale' ? 'Read-only history' : 'Open chat'}
                  >
                    <div className="history-top">
                      <span className="history-name">{entry.session.peerDisplayName}</span>
                      <span className={`history-state ${entry.session.status === 'online' ? 'history-live' : 'history-stale'}`}>
                        {entry.session.status === 'online' ? 'LIVE' : 'HISTORY'}
                      </span>
                    </div>
                    <div className="history-code">{entry.session.code}</div>
                    <div className="history-preview">{entry.lastMessage || 'No messages yet'}</div>
                    {entry.unreadCount > 0 && (
                      <div className="history-unread">{entry.unreadCount} unread</div>
                    )}
                  </button>
                  <button
                    className="history-delete"
                    title="Delete history"
                    onClick={() => void deleteHistory(entry)}
                  >DEL</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="history-empty">No saved chats yet</div>
          )}
        </div>

        {/* QUICK ACTIONS */}
        <div className="qa">
          <div className="qa-title">QUICK ACTIONS</div>
          <button className="qa-btn" onClick={() => setShowCreateModal(true)}>
            <span className="qa-badge badge-pub">NEW</span> Create Session
          </button>
          <button className="qa-btn" onClick={scanForSessions} disabled={isScanning}>
            <span className="qa-badge badge-scan">LAN</span> {isScanning ? 'Scanning...' : 'Scan for Sessions'}
          </button>
          <button className="qa-btn" onClick={() => { setJoinCode(''); setJoinPassword(''); setShowJoinModal(true) }}>
            <span className="qa-badge badge-scan">↗</span> Join by Code
          </button>
          <button className={`qa-btn ${broadcastMode ? 'qa-active' : ''}`} onClick={() => setBroadcastMode((b) => !b)}>
            <span className="qa-badge badge-bcast">BCT</span> {broadcastMode ? 'Broadcast ON' : 'Broadcast OFF'}
          </button>
          {permissions?.nearbyScan !== 'granted' && (
            <button className="qa-btn qa-perm" onClick={() => setPermPrompt(true)}>
              <span className="qa-badge badge-warn">!</span> Grant Scan Permission
            </button>
          )}
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main className="cm">
        {currentSession ? (
          <>
            {/* CHAT HEADER */}
            <div className="ch">
              <div className="ch-l">
                <div className="ch-title">{currentSession.name}</div>
                <div className="ch-meta">
                  <span className="ch-tag">{currentSession.code}</span>
                  {currentSession.mode === 'peer' && (
                    <span>with {currentSession.peerDisplayName}</span>
                  )}
                  <span>{participants.filter((p) => p.status === 'online').length} online</span>
                  {currentSession.encrypted && <span className="ch-enc">SECURE</span>}
                  {broadcastMode && <span className="ch-bcast">BROADCAST</span>}
                  {currentSession.mode === 'host' && <span className="ch-host">HOST</span>}
                  {currentSession.status === 'stale' && (
                    <span className="ch-stale">DISCONNECTED</span>
                  )}
                  {currentSession.isHistory && currentSession.status === 'stale' && (
                    <span className="ch-hist">HISTORY</span>
                  )}
                </div>
              </div>
              <div className="ch-r">
                <div className="ch-stat"><span>LATENCY</span><span>{networkNodes[0]?.latency ?? '--'}ms</span></div>
                <div className="ch-stat"><span>PKTS</span><span>{packetCount}</span></div>
                <div className="ch-stat"><span>TIME</span><span>{fmt(time)}</span></div>
              </div>
            </div>

            {/* TAB BAR */}
            <div className="tab-bar">
              {(['messages', 'logs', 'network'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`tab-btn ${selectedTab === tab ? 'tab-on' : ''}`}
                  onClick={() => setSelectedTab(tab)}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {selectedTab === 'messages' && (
                <div className="filter-row">
                  {(['all', 'teacher', 'student'] as const).map((f) => (
                    <button
                      key={f}
                      className={`filter-btn ${filter === f ? 'filter-on' : ''}`}
                      onClick={() => setFilter(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* MESSAGES TAB */}
            {selectedTab === 'messages' && (
              <>
                <div
                  className="msgs"
                  ref={messagesContainerRef}
                  onScroll={handleMessagesScroll}
                >
                  {!canSend && (
                    <div className="msg-sys banner-readonly">
                      <span className="sys-pipe">|</span>
                      <span>HISTORY MODE · This chat is read-only. The peer is offline.</span>
                    </div>
                  )}

                  {filteredMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`mw ${msg.isOwn ? 'mw-own' : ''} ${msg.system ? 'mw-sys' : ''}`}
                    >
                      {msg.system ? (
                        <div className="msg-sys">
                          <span className="sys-pipe">|</span>
                          <span>{msg.content}</span>
                          <span className="msg-ts">{fmt(msg.timestamp)}</span>
                        </div>
                      ) : (
                        <>
                          {!msg.isOwn && (
                            <div className="msg-sndr-row">
                              <span className={`sndr-badge role-${msg.role}`}>{msg.role.toUpperCase()}</span>
                              <span className="msg-sndr">{msg.sender}</span>
                              <span className="enc-tag">AES</span>
                            </div>
                          )}
                          <div className={`msg-bub ${msg.isOwn ? 'bub-own' : ''}`}>
                            {/* File/image attachment */}
                            {msg.attachmentType && (
                              <div className="att-wrap">
                                {msg.attachmentType === 'image' && (msg.attachmentData || msg.attachmentId) ? (
                                  <div
                                    className="msg-img-wrap"
                                    onClick={() => {
                                      const src = msg.attachmentData
                                        ? normalizeDataUrl(msg.attachmentData, msg.attachmentMime ?? 'image/png')
                                        : undefined
                                      if (src) setShowImagePreview(src)
                                    }}
                                  >
                                    <img
                                      src={
                                        msg.attachmentData
                                          ? normalizeDataUrl(msg.attachmentData, msg.attachmentMime ?? 'image/png')
                                          : undefined
                                      }
                                      alt={msg.attachmentName}
                                      className="msg-img"
                                    />
                                    <div className="img-overlay">🔍 Click to enlarge</div>
                                  </div>
                                ) : (
                                  <div className="file-att">
                                    <span className="file-icon">{fileTypeIcon(msg.attachmentType)}</span>
                                    <div className="file-info">
                                      <div className="file-name">{msg.attachmentName}</div>
                                      <div className="file-meta">
                                        {msg.attachmentType?.toUpperCase()} · {fmtFileSize(msg.attachmentSize ?? 0)}
                                      </div>
                                    </div>
                                  </div>
                                )}
                                {/* Save to desktop button */}
                                {msg.attachmentId && (
                                  <button
                                    className="btn-save-file"
                                    disabled={savingAttachment === msg.attachmentId}
                                    onClick={() => saveAttachmentToDisk(msg)}
                                    title="Save to desktop"
                                  >
                                    {savingAttachment === msg.attachmentId ? '...' : '⬇ SAVE'}
                                  </button>
                                )}
                              </div>
                            )}
                            {/* Text content */}
                            {msg.content && (
                              <div className="msg-cnt">{msg.content}</div>
                            )}
                            <div className="msg-foot">
                              <span className="msg-ts">{fmt(msg.timestamp)}</span>
                              {msg.isOwn && (
                                <span className="msg-st">
                                  {msg.failed ? '✗ FAILED' : msg.delivered ? '✓ SENT' : '○ SENDING'}
                                </span>
                              )}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ))}

                  <div ref={messagesEndRef} style={{ height: 1 }} />
                </div>

                {/* INPUT AREA */}
                <div className="inp-area">
                  {!canSend && (
                    <div className="bcast-banner readonly-banner">
                      READ-ONLY HISTORY · Peer is offline. You can scroll through old messages.
                    </div>
                  )}
                  {broadcastMode && canSend && (
                    <div className="bcast-banner">
                      BROADCAST MODE · Message will be sent to all available peers
                    </div>
                  )}

                  {/* Pending file preview */}
                  {pendingFile && (
                    <div className="pending-file-row">
                      {pendingFile.fileType === 'image' ? (
                        <img src={pendingFile.dataUrl} alt="pending" className="pending-thumb" />
                      ) : (
                        <span className="pending-file-icon">{fileTypeIcon(pendingFile.fileType)}</span>
                      )}
                      <div className="pending-file-info">
                        <div className="pending-file-name">{pendingFile.name}</div>
                        <div className="pending-file-size">{fmtFileSize(pendingFile.size)}</div>
                      </div>
                      <button className="pending-remove" onClick={() => setPendingFile(null)}>✕</button>
                    </div>
                  )}

                  <div className="inp-row">
                    <div className="inp-pfx">&gt;</div>
                    <input
                      ref={inputRef}
                      className="msg-inp"
                      placeholder={
                        !canSend
                          ? 'History only – sending disabled'
                          : currentSession.mode === 'host' && participants.length <= 1
                          ? `Waiting for friend (code: ${currentSession.code})…`
                          : broadcastMode
                          ? 'Broadcast message…'
                          : currentSession.mode === 'peer'
                          ? `Message ${currentSession.peerDisplayName}…`
                          : 'Type a message… (Enter to send)'
                      }
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyDown={handleKey}
                      disabled={isSending || !canSend}
                    />
                    <span className="inp-cnt">{newMessage.length}</span>

                    {/* File attach */}
                    <button
                      className="btn-attach"
                      title="Attach file (image, PDF, doc, ppt – max 10MB)"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isSending || !canSend}
                    >
                      📎
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip,.rar"
                      style={{ display: 'none' }}
                      onChange={handleFileSelect}
                    />

                    <button
                      className="btn-send"
                      onClick={sendMessage}
                      disabled={(!newMessage.trim() && !pendingFile) || isSending || !canSend}
                    >
                      {isSending ? '...' : 'SEND'}
                    </button>
                  </div>

                  <div className="inp-foot">
                    <span>SESSION · {currentSession.code}</span>
                    <span>{currentSession.encrypted ? 'AES-256-GCM ENCRYPTED' : 'UNENCRYPTED'}</span>
                    <span>{participants.filter((p) => p.status === 'online').length} ONLINE</span>
                    <span>Files up to 10MB · images, PDF, doc, ppt</span>
                  </div>
                </div>
              </>
            )}

            {/* LOGS TAB */}
            {selectedTab === 'logs' && (
              <div className="logs-area">
                <div className="logs-hdr">EVENT LOG · {sessionLogs.length} entries</div>
                {sessionLogs.map((log, i) => (
                  <div key={i} className="log-line">
                    <span className="log-idx">{String(sessionLogs.length - i).padStart(3, '0')}</span>
                    <span>{log}</span>
                  </div>
                ))}
              </div>
            )}

            {/* NETWORK TAB */}
            {selectedTab === 'network' && (
              <div className="net-area">
                <div className="net-title">ACTIVE NODES</div>
                <div className="net-grid">
                  {networkNodes.map((n) => (
                    <div key={n.id} className={`net-card ${n.status}`}>
                      <div className="nc-hdr">
                        <span className={`nc-dot ${n.status}`} />
                        <span className="nc-name">{n.name}</span>
                      </div>
                      <div className="nc-row">LATENCY<span>{n.latency}ms</span></div>
                      <div className="nc-row">STATUS<span>{n.status.toUpperCase()}</span></div>
                    </div>
                  ))}
                </div>
                <div className="net-title" style={{ marginTop: 18 }}>PARTICIPANTS</div>
                <div className="dev-grid">
                  {participants.map((p) => (
                    <div key={p.id} className="dev-card">
                      <div className="dc-top">
                        <span className={`dc-dot ${p.status}`} />
                        <span className="dc-name">{p.name}</span>
                        <span className={`dc-role dc-${p.role}`}>{p.role.toUpperCase()}</span>
                      </div>
                      <div className="dc-row"><span>IP</span><span>{p.ipAddress}</span></div>
                      <div className="dc-row"><span>DEVICE</span><span>{p.device}</span></div>
                      <div className="dc-row"><span>STATUS</span><span>{p.status.toUpperCase()}</span></div>
                      {currentSession.mode === 'host' && p.id !== (profile?.peerId ?? 'local') && (
                        <button className="kick-btn-card" onClick={() => setKickConfirm(p)}>REMOVE</button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="net-title" style={{ marginTop: 18 }}>LIVE STATS</div>
                <div className="stats-grid">
                  <div className="stat-card"><span>PACKETS</span><span>{packetCount}</span></div>
                  <div className="stat-card"><span>RECEIVED</span><span>{fmtFileSize(rxBytes)}</span></div>
                  <div className="stat-card"><span>SENT</span><span>{fmtFileSize(txBytes)}</span></div>
                  <div className="stat-card"><span>ENCRYPTION</span><span>AES-256-GCM</span></div>
                  <div className="stat-card"><span>PROTOCOL</span><span>UDP + HTTP</span></div>
                  <div className="stat-card"><span>NODES</span><span>{networkNodes.filter((n) => n.status === 'connected').length}/{networkNodes.length}</span></div>
                </div>
              </div>
            )}
          </>
        ) : (
          /* WELCOME SCREEN */
          <div className="welcome">
            <div className="w-ascii-header">
              <pre className="w-glitch">{`   ____ _   _    _  _____\n  / ___| | | |  / \\|_   _|\n | |   | |_| | / _ \\ | |\n | |___|  _  |/ ___ \\| |\n  \\____|_| |_/_/   \\_\\_|`}</pre>
              <div className="w-header-info">
                <span className="w-version">v1.0.0</span>
                <span className="w-time">{fmtShort(time)}</span>
                <div className="w-log-box">
                  <span className="w-log-msg">{sessionLogs[0] ?? '[System ready]'}</span>
                </div>
              </div>
            </div>
            <p className="w-sub">
              Create a session and share the code with your friend.<br />
              Both must be on the same Wi-Fi network.
            </p>
            <div className="w-actions">
              <button className="wbtn wprimary" onClick={() => setShowCreateModal(true)}>CREATE SESSION</button>
              <button className="wbtn wsecondary" onClick={scanForSessions} disabled={isScanning}>
                {isScanning ? 'SCANNING...' : 'SCAN LAN'}
              </button>
              <button className="wbtn wsecondary" onClick={() => { setJoinCode(''); setJoinPassword(''); setShowJoinModal(true) }}>
                ENTER CODE
              </button>
            </div>

            {activeSessions.length > 0 && (
              <div className="w-active-sessions">
                <div className="w-active-title">ACTIVE SESSIONS ON LAN</div>
                {activeSessions.map((sess) => (
                  <div key={sess.code} className="w-sess-item" onClick={() => joinByCode(sess.code)}>
                    <div className="wsi-l">
                      <div className="wsi-name">{sess.name}</div>
                      <div className="wsi-meta">{sess.code} · {sess.peerDisplayName}</div>
                    </div>
                    <div className="wsi-r">
                      <span className={`si-badge ${sess.encrypted ? 'badge-priv' : 'badge-pub'}`}>
                        {sess.encrypted ? '🔒' : 'PUBLIC'}
                      </span>
                      <span className="join-hint">JOIN →</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="w-info">
              <div className="wi-row"><span>ENCRYPTION</span><span>AES-256-GCM</span></div>
              <div className="wi-row"><span>NETWORK</span><span>LOCAL LAN · Wi-Fi</span></div>
              <div className="wi-row"><span>DISCOVERY</span><span>UDP BROADCAST</span></div>
              <div className="wi-row"><span>TRANSPORT</span><span>HTTP · PEER-TO-PEER</span></div>
              <div className="wi-row"><span>BACKEND</span><span>{backendStatus ? `${backendStatus.localAddress}:${backendStatus.serverPort}` : 'Connecting...'}</span></div>
              <div className="wi-row"><span>PEERS ONLINE</span><span>{backendStatus?.peersOnline ?? 0}</span></div>
              <div className="wi-row"><span>FILE TRANSFER</span><span>Images, PDF, DOC, PPT · max 10MB</span></div>
            </div>
          </div>
        )}
      </main>

      {/* JOIN MODAL */}
      {showJoinModal && (
        <div className="modal-overlay" onClick={() => { if (!isJoining) setShowJoinModal(false) }}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">JOIN SESSION</div>
            <div className="modal-sub">
              {nearbySessions.length} session{nearbySessions.length !== 1 ? 's' : ''} found on LAN
            </div>

            {nearbySessions.length > 0 && (
              <div className="sess-list">
                {nearbySessions.map((sess) => (
                  <div key={sess.code} className="sess-item" onClick={() => joinByCode(sess.code)}>
                    <div className="si-l">
                      <div className="si-name">{sess.name}</div>
                      <div className="si-code">{sess.code}</div>
                      <div className="si-desc">{sess.description}</div>
                    </div>
                    <div className="si-r">
                      <span className={`si-badge ${sess.encrypted ? 'badge-priv' : 'badge-pub'}`}>
                        {sess.encrypted ? '🔒 PRIVATE' : 'PUBLIC'}
                      </span>
                      <span className="si-cnt">{sess.participants} online</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-div"><span>ENTER CODE MANUALLY</span></div>
            <div className="manual-join">
              <input
                className="code-input"
                placeholder="SESSION CODE"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitJoin()
                  }
                }}
                maxLength={10}
              />
              <input
                type="password"
                className="code-input"
                style={{ letterSpacing: 'normal', fontSize: 11, textAlign: 'left' }}
                placeholder={selectedJoinSession?.encrypted ? 'PASSWORD REQUIRED' : 'PASSWORD (OPTIONAL)'}
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitJoin()
                  }
                }}
              />
              <button
                type="button"
                className="btn-join"
                onClick={submitJoin}
                disabled={!normalizedJoinCode || isJoining}
              >
                {isJoining ? 'JOINING...' : 'JOIN'}
              </button>
            </div>
            <button className="modal-close" onClick={() => { if (!isJoining) setShowJoinModal(false) }}>×</button>
          </div>
        </div>
      )}

      {/* ── STYLES ── */}
      <style>{`
        *{margin:0;padding:0;box-sizing:border-box}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:#111}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:#2a4a7a}
        *{scrollbar-width:thin;scrollbar-color:#1e3a5f #111}

        .cr{display:flex;height:calc(100vh - 120px);max-height:calc(100vh - 120px);min-height:0;width:100%;overflow:hidden;
          background:#030303;color:#fff;font-family:'SF Mono','Fira Code','Cascadia Code',monospace;
          font-size:11px;position:relative}

        .toast-err{position:fixed;top:68px;left:50%;transform:translateX(-50%);
          background:#3a1010;border:1px solid #c86060;color:#ff9a9a;padding:8px 20px;
          font-size:9px;letter-spacing:.5px;z-index:9999;animation:slideIn .2s ease}
        @keyframes slideIn{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

        /* ── SIDEBAR ─────────────────── */
        .sb{width:280px;min-width:280px;height:100%;max-height:100%;background:#0a0a0a;border-right:1px solid #1e3a5f;
          display:flex;flex-direction:column;overflow:hidden}
        .sb-hdr{display:flex;justify-content:space-between;align-items:center;
          padding:12px 14px;border-bottom:1px solid #1e3a5f;background:#060606;flex-shrink:0}
        .sb-title{font-size:9px;letter-spacing:1.5px;opacity:.55}
        .sb-time{font-size:10px;opacity:.4}

        .btn-back{width:100%;background:none;border:none;border-bottom:1px solid #1e3a5f;
          color:#6ab4ff;padding:6px 14px;font-size:9px;cursor:pointer;font-family:inherit;
          text-align:left;letter-spacing:.5px;opacity:.7;transition:opacity .15s}
        .btn-back:hover{opacity:1}

        .s-panel{display:flex;flex-direction:column;border-bottom:1px solid #1e3a5f;flex-shrink:0}
        .s-code-row{display:flex;justify-content:space-between;align-items:center;
          padding:10px 14px 0;margin-bottom:6px}
        .s-code{font-size:18px;font-weight:700;letter-spacing:4px}
        .s-badge{font-size:7px;padding:2px 6px;border-radius:2px}
        .badge-priv{background:rgba(30,58,95,.5);border:1px solid #1e3a5f}
        .badge-pub{background:rgba(255,255,255,.07);border:1px solid #333}
        .badge-scan{background:rgba(255,255,255,.05);border:1px solid #222}
        .badge-bcast{background:rgba(74,144,217,.2);border:1px solid #1e3a5f}
        .badge-warn{background:rgba(200,80,80,.3);border:1px solid #c86060;color:#ff9a9a}

        .host-share-box{background:#0d1a2a;border:1px solid #1e3a5f;padding:10px 12px;
          margin:0 14px 8px;text-align:center}
        .host-share-label{font-size:7px;opacity:.45;letter-spacing:1px;margin-bottom:4px}
        .host-share-code{font-size:24px;font-weight:700;letter-spacing:6px;color:#6ab4ff;
          text-shadow:0 0 12px rgba(106,180,255,.4)}
        .host-share-hint{font-size:7px;opacity:.35;margin-top:5px;font-style:italic}

        .s-desc{font-size:8px;opacity:.35;padding:0 14px;margin-bottom:8px;font-style:italic}
        .s-stats{display:grid;grid-template-columns:1fr 1fr;background:#070707;
          border-top:1px solid #111;border-bottom:1px solid #111;padding:6px 14px;gap:2px 0;margin-bottom:8px}
        .ss{display:flex;justify-content:space-between;font-size:8px;padding:2px 0;border-bottom:1px dotted #111}
        .ss span:first-child{opacity:.4}
        .enc-on{color:#6ab4ff}

        .s-actions{display:flex;gap:5px;padding:0 14px;margin-bottom:8px}
        .btn-panel{flex:1;background:#111;border:1px solid #1e3a5f;color:#fff;padding:4px 0;
          font-size:8px;cursor:pointer;font-family:inherit;transition:background .2s}
        .btn-panel:hover{background:#1e3a5f}
        .btn-leave{margin:0 14px 12px;background:none;border:1px solid rgba(200,80,80,.3);color:#ff9a9a;
          padding:6px;font-size:8px;cursor:pointer;font-family:inherit;letter-spacing:1px;transition:all .2s}
        .btn-leave:hover{background:rgba(200,80,80,.1);border-color:#c86060}

        .sub-panel{padding:8px 14px;background:#050505;border-bottom:1px solid #1e3a5f;flex-shrink:0}
        .sp-title{font-size:7px;letter-spacing:1px;opacity:.35;margin-bottom:6px}
        .p-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px dotted #111}
        .p-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
        .p-dot.online{background:#4a90d9}
        .p-dot.away{background:#888;animation:blink 1.2s infinite}
        .p-dot.offline{background:#333}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
        .p-inf{flex:1;min-width:0}
        .p-name{display:block;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .p-role{font-size:7px;opacity:.3}
        .p-ip{font-size:7px;opacity:.25;font-family:monospace}
        .kick-btn{background:none;border:1px solid rgba(200,80,80,.3);color:#c86060;
          padding:1px 5px;font-size:9px;cursor:pointer;font-family:inherit;transition:all .15s;flex-shrink:0}
        .kick-btn:hover{background:rgba(200,80,80,.2);border-color:#c86060}
        .kick-btn-card{width:100%;margin-top:6px;background:none;border:1px solid rgba(200,80,80,.3);
          color:#c86060;padding:3px 0;font-size:7px;cursor:pointer;font-family:inherit;
          letter-spacing:1px;transition:all .15s}
        .kick-btn-card:hover{background:rgba(200,80,80,.15);border-color:#c86060}

        .n-row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:8px}
        .n-dot{width:5px;height:5px;border-radius:50%}
        .n-dot.connected{background:#4a90d9}
        .n-dot.connecting{background:#888;animation:blink 1.2s infinite}
        .n-dot.lost{background:#333}
        .n-name{flex:1}
        .n-lat{opacity:.4}

        .no-sess{padding:18px 14px;text-align:center;flex-shrink:0}
        .no-sess-icon{font-size:22px;opacity:.1;margin-bottom:6px}
        .no-sess p{opacity:.35;font-size:10px}
        .hint{font-size:8px;opacity:.2;margin-top:3px}

        /* HISTORY */
        .history-panel{flex:1;min-height:0;padding:10px 14px;border-top:1px solid #111;
          border-bottom:1px solid #1e3a5f;overflow:hidden;display:flex;flex-direction:column}
        .history-list{display:flex;flex-direction:column;gap:5px;overflow-y:auto;min-height:0}
        .history-item{display:flex;align-items:stretch;border:1px solid #141414;background:#090909;transition:all .15s}
        .history-item:hover,.history-item-active{border-color:#1e3a5f;background:#0d1016}
        .history-open{flex:1;background:none;border:none;color:#fff;text-align:left;
          padding:8px 10px;cursor:pointer;font-family:inherit}
        .history-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px}
        .history-name{font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .history-state{font-size:6px;letter-spacing:.8px;flex-shrink:0;opacity:.7}
        .history-live{color:#6ab4ff}
        .history-stale{color:#ffb08a}
        .history-code{font-size:7px;opacity:.35;font-family:monospace;margin-bottom:3px}
        .history-preview{font-size:8px;opacity:.45;display:-webkit-box;-webkit-line-clamp:2;
          -webkit-box-orient:vertical;overflow:hidden;line-height:1.4;min-height:22px}
        .history-unread{font-size:7px;color:#6ab4ff;margin-top:4px}
        .history-delete{background:none;border:none;border-left:1px solid #141414;color:#c86060;
          width:42px;cursor:pointer;font-size:8px;font-family:inherit;letter-spacing:1px;transition:background .15s}
        .history-delete:hover{background:rgba(200,80,80,.12)}
        .history-empty{font-size:8px;opacity:.25;padding:6px 0}

        /* QUICK ACTIONS */
        .qa{padding:10px 14px;border-top:1px solid #1e3a5f;flex-shrink:0}
        .qa-title{font-size:7px;opacity:.3;letter-spacing:1px;margin-bottom:6px}
        .qa-btn{width:100%;background:#0d0d0d;border:1px solid #141414;color:#fff;
          padding:6px 9px;font-size:9px;cursor:pointer;font-family:inherit;
          display:flex;align-items:center;gap:7px;margin-bottom:3px;transition:border-color .2s;text-align:left}
        .qa-btn:hover:not(:disabled){border-color:#1e3a5f;background:#111}
        .qa-btn:disabled{opacity:.35;cursor:not-allowed}
        .qa-btn.qa-active{border-color:#4a90d9;background:rgba(74,144,217,.06)}
        .qa-btn.qa-perm{border-color:rgba(200,80,80,.4)}
        .qa-badge{font-size:6px;padding:1px 4px;border-radius:1px;font-weight:700;flex-shrink:0}

        /* ── MAIN ─────────────────────── */
        .cm{flex:1;display:flex;flex-direction:column;background:#030303;overflow:hidden;min-width:0;min-height:0;
          height:100%;max-height:100%;width:100%}

        .ch{display:flex;justify-content:space-between;align-items:center;
          padding:9px 18px;border-bottom:1px solid #1e3a5f;background:#060606;flex-shrink:0}
        .ch-title{font-size:12px;font-weight:600;margin-bottom:3px}
        .ch-meta{display:flex;align-items:center;gap:9px;font-size:8px;opacity:.6;flex-wrap:wrap}
        .ch-tag{background:#111;border:1px solid #1e3a5f;padding:1px 5px;font-family:monospace}
        .ch-enc{color:#6ab4ff;border:1px solid rgba(106,180,255,.2);padding:1px 5px;font-size:7px}
        .ch-bcast{color:#ffd700;border:1px solid rgba(255,215,0,.2);padding:1px 5px;font-size:7px}
        .ch-host{color:#4a90d9;border:1px solid rgba(74,144,217,.3);padding:1px 5px;font-size:7px}
        .ch-stale{color:#ff9a9a;border:1px solid rgba(200,80,80,.3);padding:1px 5px;font-size:7px;animation:blink 1.5s infinite}
        .ch-hist{color:#ffb08a;border:1px solid rgba(255,176,138,.2);padding:1px 5px;font-size:7px}
        .ch-r{display:flex;gap:14px;flex-shrink:0}
        .ch-stat{display:flex;flex-direction:column;align-items:flex-end;font-size:8px}
        .ch-stat span:first-child{opacity:.3;font-size:7px}
        .ch-stat span:last-child{font-weight:600}

        .tab-bar{display:flex;align-items:center;height:34px;border-bottom:1px solid #1e3a5f;
          background:#070707;padding:0 18px;flex-shrink:0}
        .tab-btn{background:none;border:none;border-bottom:2px solid transparent;color:#fff;
          opacity:.3;font-size:8px;letter-spacing:1px;padding:0 10px;height:100%;cursor:pointer;
          font-family:inherit;transition:all .15s}
        .tab-btn:hover{opacity:.6}
        .tab-btn.tab-on{opacity:1;border-bottom-color:#1e3a5f}
        .filter-row{display:flex;gap:3px}
        .filter-btn{background:none;border:1px solid #181818;color:#fff;opacity:.3;
          font-size:7px;padding:2px 7px;cursor:pointer;font-family:inherit;transition:all .15s}
        .filter-btn:hover{opacity:.6}
        .filter-btn.filter-on{opacity:1;border-color:#1e3a5f;background:rgba(30,58,95,.18)}

        /* MESSAGES */
        .msgs{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 18px;
          display:flex;flex-direction:column;gap:8px;min-height:0;
          scroll-behavior:smooth}
        .msgs::-webkit-scrollbar{width:8px}
        .msgs::-webkit-scrollbar-track{background:#080808}
        .msgs::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:4px;border:2px solid #080808}
        .msgs::-webkit-scrollbar-thumb:hover{background:#2a4a7a}

        .mw{display:flex;flex-direction:column;align-items:flex-start;max-width:min(72%,600px)}
        .mw-own{align-self:flex-end;align-items:flex-end}
        .mw-sys{align-self:center;max-width:100%}

        .msg-sys{display:flex;align-items:center;gap:7px;font-size:8px;opacity:.3;
          padding:3px 10px;background:#090909;border:1px solid #111}
        .banner-readonly{background:rgba(255,176,138,.05);border-color:rgba(255,176,138,.2);
          opacity:.8;color:#ffb08a;align-self:stretch}
        .sys-pipe{color:#1e3a5f}
        .msg-ts{margin-left:auto;font-size:7px}

        .msg-sndr-row{display:flex;align-items:center;gap:5px;margin-bottom:2px;margin-left:2px}
        .sndr-badge{font-size:6px;padding:1px 4px;border-radius:1px;font-weight:700}
        .role-teacher{background:rgba(30,58,95,.6)}
        .role-student{background:rgba(255,255,255,.08)}
        .role-admin{background:rgba(180,100,50,.4)}
        .msg-sndr{font-size:9px;opacity:.6}
        .enc-tag{font-size:6px;opacity:.3;border:1px solid #222;padding:1px 3px}

        .msg-bub{display:inline-block;width:fit-content;max-width:100%;background:#0e0e0e;
          border:1px solid #1e3a5f;padding:7px 11px}
        .bub-own{background:#1e3a5f;border-color:#2a4a7a}
        .msg-cnt{font-size:11px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
        .msg-foot{display:flex;justify-content:flex-end;align-items:center;gap:5px;margin-top:3px}
        .msg-ts{font-size:7px;opacity:.35}
        .msg-st{font-size:8px;opacity:.5}

        /* Attachments */
        .att-wrap{margin-bottom:4px}
        .msg-img-wrap{max-width:320px;cursor:pointer;position:relative;overflow:hidden}
        .msg-img{max-width:100%;max-height:240px;display:block;object-fit:contain}
        .img-overlay{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.6);
          color:#fff;font-size:8px;padding:3px 6px;opacity:0;transition:opacity .2s;text-align:center}
        .msg-img-wrap:hover .img-overlay{opacity:1}

        .file-att{display:flex;align-items:center;gap:10px;padding:6px 0;min-width:200px}
        .file-icon{font-size:22px}
        .file-info{flex:1}
        .file-name{font-size:10px;word-break:break-all}
        .file-meta{font-size:8px;opacity:.4;margin-top:2px}

        .btn-save-file{display:block;width:100%;margin-top:5px;background:#0a1628;
          border:1px solid #1e3a5f;color:#6ab4ff;padding:4px 8px;font-size:8px;
          cursor:pointer;font-family:inherit;letter-spacing:.5px;transition:all .15s;text-align:center}
        .btn-save-file:hover:not(:disabled){background:#1e3a5f;color:#fff}
        .btn-save-file:disabled{opacity:.4;cursor:not-allowed}

        /* Pending file */
        .pending-file-row{display:flex;align-items:center;gap:8px;padding:6px 10px;
          background:#0a1628;border:1px solid #1e3a5f;margin-bottom:6px}
        .pending-thumb{width:36px;height:36px;object-fit:cover}
        .pending-file-icon{font-size:28px;width:36px;text-align:center}
        .pending-file-info{flex:1;min-width:0}
        .pending-file-name{font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pending-file-size{font-size:8px;opacity:.4;margin-top:1px}
        .pending-remove{background:none;border:none;color:#ff9a9a;font-size:16px;cursor:pointer;
          opacity:.7;padding:0 4px;transition:opacity .15s}
        .pending-remove:hover{opacity:1}

        /* Input area */
        .inp-area{border-top:1px solid #1e3a5f;padding:10px 18px;background:#060606;flex-shrink:0}
        .bcast-banner{font-size:7px;color:#ffd700;border:1px solid rgba(255,215,0,.18);
          background:rgba(255,215,0,.04);padding:3px 8px;margin-bottom:6px}
        .readonly-banner{color:#ffb08a;border-color:rgba(255,176,138,.2);
          background:rgba(255,176,138,.04)}
        .inp-row{display:flex;align-items:center;gap:7px;margin-bottom:5px}
        .inp-pfx{font-size:13px;opacity:.3;flex-shrink:0}
        .msg-inp{flex:1;background:#0e0e0e;border:1px solid #1e3a5f;color:#fff;
          padding:8px 11px;font-size:11px;font-family:inherit;outline:none;transition:border-color .2s}
        .msg-inp:focus{border-color:rgba(255,255,255,.25)}
        .msg-inp::placeholder{opacity:.25}
        .msg-inp:disabled{opacity:.4}
        .inp-cnt{font-size:8px;opacity:.2;min-width:22px;text-align:right;flex-shrink:0}
        .btn-attach{background:#111;border:1px solid #1e3a5f;color:#fff;padding:8px 10px;
          font-size:14px;cursor:pointer;transition:background .2s;flex-shrink:0}
        .btn-attach:hover:not(:disabled){background:#1e3a5f}
        .btn-attach:disabled{opacity:.28;cursor:not-allowed}
        .btn-send{background:#1e3a5f;border:none;color:#fff;padding:8px 18px;font-size:9px;
          cursor:pointer;font-family:inherit;letter-spacing:1px;transition:background .2s;flex-shrink:0}
        .btn-send:hover:not(:disabled){background:#2a4a7a}
        .btn-send:disabled{opacity:.28;cursor:not-allowed}
        .inp-foot{display:flex;gap:14px;font-size:7px;opacity:.2;letter-spacing:.4px;flex-wrap:wrap}

        /* Logs */
        .logs-area{flex:1;overflow-y:auto;padding:10px 18px;font-family:monospace;font-size:9px}
        .logs-hdr{font-size:7px;opacity:.3;letter-spacing:1px;margin-bottom:8px;
          padding-bottom:5px;border-bottom:1px solid #111}
        .log-line{display:flex;gap:10px;padding:2px 0;border-bottom:1px dotted #0d0d0d;opacity:.6}
        .log-line:hover{opacity:1}
        .log-idx{opacity:.2;flex-shrink:0}

        /* Network */
        .net-area{flex:1;overflow-y:auto;padding:14px 18px}
        .net-title{font-size:8px;letter-spacing:1.5px;opacity:.35;margin-bottom:8px}
        .net-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:6px}
        .net-card{background:#0a0a0a;border:1px solid #1e3a5f;padding:9px}
        .nc-hdr{display:flex;align-items:center;gap:5px;margin-bottom:5px;
          padding-bottom:4px;border-bottom:1px dotted #111}
        .nc-dot{width:5px;height:5px;border-radius:50%}
        .nc-dot.connected{background:#4a90d9}
        .nc-dot.lost{background:#333}
        .nc-name{font-size:8px}
        .nc-row{display:flex;justify-content:space-between;font-size:7px;opacity:.55;margin-top:2px}
        .nc-row span:last-child{color:#fff;opacity:1}
        .dev-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
        .dev-card{background:#0a0a0a;border:1px solid #111;padding:9px}
        .dc-top{display:flex;align-items:center;gap:5px;margin-bottom:5px;
          padding-bottom:4px;border-bottom:1px dotted #111}
        .dc-dot{width:4px;height:4px;border-radius:50%}
        .dc-dot.online{background:#4a90d9}
        .dc-dot.away{background:#888}
        .dc-name{flex:1;font-size:8px}
        .dc-role{font-size:6px;padding:1px 4px}
        .dc-teacher{background:rgba(30,58,95,.5)}
        .dc-student{background:rgba(255,255,255,.07)}
        .dc-row{display:flex;justify-content:space-between;font-size:7px;opacity:.55;padding:2px 0}
        .dc-row span:last-child{color:#fff;opacity:1}
        .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
        .stat-card{background:#0a0a0a;border:1px solid #1e3a5f;padding:9px;
          display:flex;flex-direction:column;gap:3px}
        .stat-card span:first-child{font-size:6px;opacity:.35}
        .stat-card span:last-child{font-size:10px;font-weight:600}

        /* Image preview modal */
        .img-preview-box{position:relative;max-width:90vw;max-height:90vh;
          background:#0a0a0a;border:1px solid #1e3a5f;padding:8px}
        .img-preview-img{max-width:100%;max-height:80vh;display:block;object-fit:contain}

        /* Welcome */
        .welcome{flex:1;display:flex;flex-direction:column;align-items:center;
          justify-content:center;padding:40px 24px;text-align:center;overflow-y:auto;min-height:0;height:100%;
          background:radial-gradient(circle at top,rgba(30,58,95,.18),transparent 42%),
            linear-gradient(180deg,#05080d 0%,#030303 48%,#030303 100%)}
        .welcome>*{width:100%;max-width:560px;margin-left:auto;margin-right:auto}
        .w-ascii-header{background:#050a14;border-bottom:1px solid #1e3a5f;padding:14px 20px;
          display:flex;justify-content:space-between;align-items:center;gap:16px;
          flex-shrink:0;width:100%;margin-bottom:18px;text-align:left}
        .w-glitch{color:#94b8ff;font-size:9px;line-height:1.25;
          text-shadow:0 0 18px rgba(148,184,255,.35);white-space:pre;margin:0}
        .w-header-info{display:flex;gap:14px;align-items:center;background:#0a1628;
          padding:8px 14px;border:1px solid #1e3a5f;flex-shrink:0}
        .w-version{font-size:9px;color:#4a7abf}
        .w-time{font-size:13px;font-weight:600;color:#e8f0ff;letter-spacing:1px}
        .w-log-box{border-left:1px solid #1e3a5f;padding-left:12px;min-width:0}
        .w-log-msg{font-size:9px;color:#94b8ff;opacity:.75;display:block;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
        .w-sub{font-size:9px;opacity:.48;line-height:1.8;margin-bottom:24px}
        .w-actions{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap;justify-content:center}
        .wbtn{background:none;border:1px solid #1e3a5f;color:#fff;padding:9px 22px;
          font-size:9px;cursor:pointer;font-family:inherit;letter-spacing:1px;
          transition:all .2s;min-width:120px}
        .wprimary{background:#1e3a5f}
        .wprimary:hover{background:#2a4a7a}
        .wsecondary:hover{background:rgba(30,58,95,.2)}
        .wbtn:disabled{opacity:.35;cursor:not-allowed}
        .w-active-sessions{border:1px solid #1e3a5f;background:#070707;margin-bottom:18px;
          width:min(100%,520px)}
        .w-active-title{font-size:7px;letter-spacing:1.5px;opacity:.35;padding:8px 14px;
          border-bottom:1px solid #1e3a5f}
        .w-sess-item{display:flex;justify-content:space-between;align-items:center;
          padding:10px 14px;border-bottom:1px solid #0d0d0d;cursor:pointer;transition:background .15s}
        .w-sess-item:last-child{border-bottom:none}
        .w-sess-item:hover{background:#111}
        .wsi-l{text-align:left}
        .wsi-name{font-size:10px}
        .wsi-meta{font-size:7px;opacity:.4;margin-top:2px}
        .wsi-r{display:flex;align-items:center;gap:8px}
        .join-hint{font-size:8px;color:#4a90d9}
        .w-info{background:#0a0a0a;border:1px solid #1e3a5f;padding:12px 22px;
          width:min(100%,420px)}
        .wi-row{display:flex;justify-content:space-between;font-size:8px;
          padding:4px 0;border-bottom:1px dotted #111;gap:40px}
        .wi-row span:first-child{opacity:.35}

        /* Modals */
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);
          display:flex;align-items:center;justify-content:center;z-index:2000}
        .modal-box{background:#0a0a0a;border:1px solid #1e3a5f;padding:22px;
          width:500px;max-width:94vw;max-height:82vh;overflow-y:auto;position:relative}
        .modal-title{font-size:12px;letter-spacing:2px;margin-bottom:3px}
        .modal-sub{font-size:8px;opacity:.35;margin-bottom:14px}
        .sess-list{border:1px solid #1e3a5f;max-height:240px;overflow-y:auto;margin-bottom:12px}
        .sess-item{display:flex;justify-content:space-between;align-items:center;
          padding:10px 12px;border-bottom:1px solid #0d0d0d;cursor:pointer;transition:background .15s}
        .sess-item:hover{background:#111}
        .si-name{font-size:10px;margin-bottom:2px}
        .si-code{font-size:8px;opacity:.35;font-family:monospace;margin-bottom:1px}
        .si-desc{font-size:7px;opacity:.25;font-style:italic}
        .si-r{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
        .si-badge{font-size:6px;padding:2px 6px}
        .si-cnt{font-size:7px;opacity:.4}
        .modal-div{text-align:center;position:relative;font-size:7px;opacity:.35;margin:12px 0}
        .modal-div::before,.modal-div::after{content:'';position:absolute;top:50%;
          width:42%;height:1px;background:#1e3a5f}
        .modal-div::before{left:0}
        .modal-div::after{right:0}
        .manual-join{display:flex;flex-direction:column;gap:7px}
        .code-input{background:#0e0e0e;border:1px solid #1e3a5f;color:#fff;
          padding:9px 12px;font-size:13px;font-family:monospace;letter-spacing:4px;
          text-align:center;outline:none;width:100%}
        .code-input:focus{border-color:#fff}
        .btn-join{width:100%;background:#1e3a5f;border:none;color:#fff;padding:9px;
          font-size:9px;cursor:pointer;font-family:inherit;letter-spacing:1px;transition:background .2s}
        .btn-join:hover:not(:disabled){background:#2a4a7a}
        .btn-join:disabled{opacity:.35;cursor:not-allowed}
        .modal-close{position:absolute;top:10px;right:14px;background:none;border:none;
          color:#fff;font-size:20px;cursor:pointer;opacity:.3;line-height:1}
        .modal-close:hover{opacity:1}
        .create-form{display:flex;flex-direction:column;gap:7px}
        .form-label{font-size:7px;opacity:.45;letter-spacing:1px;margin-top:4px}
        .vis-row{display:flex;gap:5px}
        .vis-btn{flex:1;background:#0e0e0e;border:1px solid #1e3a5f;color:#fff;
          padding:7px 6px;font-size:8px;cursor:pointer;font-family:inherit;
          transition:all .15s;text-align:center;opacity:.5}
        .vis-btn:hover{opacity:.8}
        .vis-btn.vis-active{opacity:1;background:rgba(30,58,95,.4);border-color:#6ab4ff}

        @media(max-width:900px){.sb{width:220px;min-width:220px}.net-grid,.dev-grid{grid-template-columns:repeat(2,1fr)}}
        @media(max-width:640px){
          .welcome{justify-content:flex-start;padding:20px 14px}
          .w-ascii-header{flex-direction:column;align-items:flex-start}
          .w-glitch{font-size:8px;width:100%}
          .w-header-info{width:100%}
          .w-log-msg{max-width:none}
          .w-actions{flex-direction:column}
          .wbtn{width:100%;max-width:320px}
          .net-grid,.dev-grid,.stats-grid{grid-template-columns:repeat(2,1fr)}
        }
      `}</style>
    </div>
  )
}
