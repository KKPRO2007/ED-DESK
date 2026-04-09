import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  offlineApi,
  type BackendStatus,
  type ChatMessageRecord,
  type ConversationRecord,
  type PeerRecord,
  type SessionRecord,
  type DevicePermissions
} from '../offlineApi'

// ==================== TYPES ====================

interface Message {
  id: string
  sender: string
  role: 'teacher' | 'student' | 'admin' | 'system'
  content: string
  timestamp: Date
  isOwn: boolean
  system?: boolean
  encrypted?: boolean
  delivered?: boolean
  read?: boolean
  failed?: boolean
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

const ACTIVE_CHAT_STORAGE_KEY = 'eddesk-active-chat-session'

const getErrorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e)

const inferRole = (name: string): 'teacher' | 'student' | 'admin' => {
  const v = name.toLowerCase()
  if (v.includes('teacher') || v.includes('faculty') || v.includes('prof')) return 'teacher'
  if (v.includes('admin') || v.includes('staff')) return 'admin'
  return 'student'
}

const buildPeerSession = (
  peer: PeerRecord,
  conv: ConversationRecord | undefined,
  profileName: string
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
  activeUsers: [profileName, peer.displayName],
  messageCount: conv?.unreadCount ?? 0,
  lastActivity: new Date(conv?.updatedAt ?? peer.lastSeen),
  address: peer.address,
  transport: 'wifi',
  status: peer.status,
  conversationId: conv?.id ?? null,
  backendSessionId: null
})

const findConversationForSession = (
  conversations: ConversationRecord[],
  peerId: string,
  sessionCode?: string | null
) => {
  const normalizedCode = sessionCode?.trim().toUpperCase() || null
  return conversations.find((item) =>
    item.peerId === peerId && (item.sessionCode ?? null) === normalizedCode
  )
}

const findBestConversationForSession = (
  conversations: ConversationRecord[],
  peerId: string,
  sessionCode?: string | null
) => {
  const exact = findConversationForSession(conversations, peerId, sessionCode)
  if (exact) return exact

  const peerConversations = conversations
    .filter((item) => item.peerId === peerId)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (peerConversations.length === 1) return peerConversations[0]

  return peerConversations.find((item) => item.sessionCode) ?? peerConversations[0]
}

const isPeerSessionVisible = (peer: PeerRecord) => peer.status === 'online' && Boolean(peer.hostedSession)

const saveActiveSession = (session: Session | null) => {
  if (typeof window === 'undefined') return
  if (!session) {
    window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, JSON.stringify({
    ...session,
    created: session.created.toISOString(),
    lastActivity: session.lastActivity.toISOString()
  }))
}

const loadSavedSession = (): Session | null => {
  if (typeof window === 'undefined') return null

  const raw = window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Omit<Session, 'created' | 'lastActivity'> & {
      created: string
      lastActivity: string
    }

    return {
      ...parsed,
      created: new Date(parsed.created),
      lastActivity: new Date(parsed.lastActivity)
    }
  } catch {
    window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY)
    return null
  }
}

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

// ==================== COMPONENT ====================

export default function Chat() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sessionCodeParam = searchParams.get('code')?.toUpperCase() ?? ''

  // --- Core state ---
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [networkNodes, setNetworkNodes] = useState<NetworkNode[]>([])

  // --- Backend state ---
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null)
  const [profile, setProfile] = useState<{ peerId: string; displayName: string } | null>(null)
  const [peerRecords, setPeerRecords] = useState<PeerRecord[]>([])
  const [permissions, setPermissions] = useState<DevicePermissions | null>(null)

  // --- UI state ---
  const [isScanning, setIsScanning] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [nearbySessions, setNearbySessions] = useState<Session[]>([])
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [showParticipants, setShowParticipants] = useState(false)
  const [showNetworkPanel, setShowNetworkPanel] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createVisibility, setCreateVisibility] = useState<'public' | 'private'>('public')
  const [createPassword, setCreatePassword] = useState('')
  const [typingUsers] = useState<string[]>([])
  const [time, setTime] = useState(new Date())
  const [sessionLogs, setSessionLogs] = useState<string[]>([])
  const [selectedTab, setSelectedTab] = useState<'messages' | 'logs' | 'network'>('messages')
  const [filter, setFilter] = useState<'all' | 'teacher' | 'student'>('all')
  const [broadcastMode, setBroadcastMode] = useState(false)
  const [packetCount, setPacketCount] = useState(0)
  const [rxBytes, setRxBytes] = useState(0)
  const [txBytes, setTxBytes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [permPrompt, setPermPrompt] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSessionRef = useRef<Session | null>(null)
  const isPollingRef = useRef(false)
  const latestMessageSignatureRef = useRef('')
  const shouldStickToBottomRef = useRef(true)
  const scanAfterPermissionGrantRef = useRef(false)
  currentSessionRef.current = currentSession

  // --- Clock ---
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // --- Scroll to bottom ---
  useEffect(() => {
    if (!shouldStickToBottomRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [messages])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    shouldStickToBottomRef.current = distanceFromBottom < 96
  }, [])

  // --- Helpers ---
  const fmt = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const fmtShort = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  const fmtBytes = (b: number) => {
    if (b < 1024) return `${b} B`
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
    return `${(b / 1048576).toFixed(2)} MB`
  }

  const addLog = useCallback((msg: string) => {
    setSessionLogs(prev => [`[${fmt(new Date())}] ${msg}`, ...prev.slice(0, 49)])
  }, [])

  const showError = useCallback((msg: string) => {
    setError(msg)
    setTimeout(() => setError(null), 4000)
  }, [])

  const buildMessageSignature = useCallback((items: Message[]) =>
    items.map(item => `${item.id}:${item.delivered ? 1 : 0}:${item.read ? 1 : 0}:${item.content}`).join('|')
  , [])

  const syncMessages = useCallback((nextMessages: Message[]) => {
    const signature = buildMessageSignature(nextMessages)
    if (signature === latestMessageSignatureRef.current) return false
    latestMessageSignatureRef.current = signature
    setMessages(nextMessages)
    return true
  }, [buildMessageSignature])

  useEffect(() => {
    if (!currentSession) return
    saveActiveSession(currentSession)
  }, [currentSession])

  // --- Load base snapshot ---
  const loadSnapshot = useCallback(async (scan = false, applyState = true) => {
    try {
      if (scan) {
        const perms = await offlineApi.getPermissions()
        if (perms.nearbyScan !== 'granted') {
          setPermPrompt(true)
          return null
        }
        await offlineApi.scanPeers()
        await new Promise(r => setTimeout(r, 1000))
      }

      const [status, profileData, peers, convs] = await Promise.all([
        offlineApi.getStatus(),
        offlineApi.getProfile(),
        offlineApi.listPeers(),
        offlineApi.listConversations()
      ])

      const sessions = peers
        .filter(isPeerSessionVisible)
        .map(p => buildPeerSession(
          p,
          findBestConversationForSession(convs, p.id, p.hostedSession?.code),
          profileData?.displayName ?? 'You'
        ))

      const allSessions = peers
        .filter(isPeerSessionVisible)
        .map(p =>
        buildPeerSession(
          p,
          findBestConversationForSession(convs, p.id, p.hostedSession?.code),
          profileData?.displayName ?? 'You'
        )
      )

      if (applyState) {
        setBackendStatus(status)
        setProfile(profileData)
        setPeerRecords(peers)
        setNearbySessions(sessions)
        setNetworkNodes([
          {
            id: status?.peerId ?? 'local',
            name: 'Local Backend',
            latency: 1,
            status: 'connected'
          },
          ...peers.slice(0, 5).map((p, i) => ({
            id: p.id,
            name: p.displayName,
            latency: p.status === 'online' ? 10 + i * 8 : 999,
            status: p.status === 'online' ? 'connected' as const : 'lost' as const
          }))
        ])
      }

      return { status, profile: profileData, peers, convs, allSessions }
    } catch (e) {
      addLog(`Backend error: ${getErrorMessage(e)}`)
      return null
    }
  }, [addLog])

  // --- Grant permission ---
  const grantPermission = useCallback(async () => {
    try {
      const updated = await offlineApi.updatePermissions({ nearbyScan: 'granted' })
      setPermissions(updated)
      setPermPrompt(false)
      addLog('Nearby scan permission granted')
      if (scanAfterPermissionGrantRef.current) {
        scanAfterPermissionGrantRef.current = false
        setIsScanning(true)
        addLog('Scanning LAN for peers...')
        try {
          const snap = await loadSnapshot(true)
          if (!snap) return
          const sessions = snap.peers
            .filter(isPeerSessionVisible)
            .map(p => buildPeerSession(
              p,
              findBestConversationForSession(snap.convs, p.id, p.hostedSession?.code),
              snap.profile?.displayName ?? 'You'
            ))
          setNearbySessions(sessions)
          setShowJoinModal(true)
          addLog(sessions.length > 0
            ? `Found ${sessions.length} active session${sessions.length === 1 ? '' : 's'} on LAN`
            : 'No sessions found. Ask your friend to create a session first.')
        } catch (e) {
          showError(`Scan failed: ${getErrorMessage(e)}`)
        } finally {
          setIsScanning(false)
        }
      }
    } catch (e) {
      showError(`Permission update failed: ${getErrorMessage(e)}`)
    }
  }, [addLog, loadSnapshot, showError])

  // --- Load messages for current session ---
  const loadMessages = useCallback(async (session: Session, status: BackendStatus | null, prof: { peerId: string; displayName: string } | null) => {
    const systemMsg: Message = {
      id: `sys-${session.peerId}`,
      sender: 'System',
      role: 'system',
      content: `BACKEND · ${status?.localAddress ?? '127.0.0.1'}:${status?.serverPort ?? 0} · WIFI LINK ${session.status.toUpperCase()}`,
      timestamp: new Date(),
      isOwn: false,
      system: true
    }

    if (session.mode === 'host') {
      setMessages([
        systemMsg,
        {
          id: `host-code-${session.code}`,
          sender: 'System',
          role: 'system',
          content: `SESSION CREATED · CODE: ${session.code} · Share this code with your friend. They can also scan your device on the same LAN.`,
          timestamp: new Date(),
          isOwn: false,
          system: true
        }
      ])
      latestMessageSignatureRef.current = ''
      setPacketCount(0)
      setRxBytes(0)
      setTxBytes(0)
      return
    }

    // Peer mode — load real messages
    if (!session.conversationId) {
      syncMessages([systemMsg, {
        id: `empty-${session.peerId}`,
        sender: 'System',
        role: 'system',
        content: `CONNECTED TO ${session.name.toUpperCase()} · Send a message to start`,
        timestamp: new Date(),
        isOwn: false,
        system: true
      }])
      return
    }

    try {
      const records = await offlineApi.getMessages(session.conversationId)
      const mapped: Message[] = records.map(r => ({
        id: r.id,
        sender: r.direction === 'outgoing' ? (prof?.displayName ?? 'You') : (r.senderName || r.peerName),
        role: inferRole(r.direction === 'outgoing' ? (prof?.displayName ?? '') : (r.senderName || r.peerName)),
        content: r.content,
        timestamp: new Date(r.createdAt),
        isOwn: r.direction === 'outgoing',
        encrypted: true,
        delivered: r.status === 'delivered',
        read: r.status === 'delivered',
        failed: r.status === 'failed'
      }))

      syncMessages([systemMsg, ...mapped])
      setPacketCount(records.length)
      setRxBytes(records.filter(r => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
      setTxBytes(records.filter(r => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
    } catch (e) {
      addLog(`Load messages failed: ${getErrorMessage(e)}`)
    }
  }, [addLog, syncMessages])

  const mapRecordsToMessages = useCallback((
    records: ChatMessageRecord[],
    prof: { peerId: string; displayName: string } | null
  ): Message[] => records.map(r => ({
    id: r.id,
    sender: r.direction === 'outgoing' ? (prof?.displayName ?? 'You') : (r.senderName || r.peerName),
    role: inferRole(r.direction === 'outgoing' ? (prof?.displayName ?? '') : (r.senderName || r.peerName)),
    content: r.content,
    timestamp: new Date(r.createdAt),
    isOwn: r.direction === 'outgoing',
    encrypted: true,
    delivered: r.status === 'delivered',
    read: r.status === 'delivered',
    failed: r.status === 'failed'
  })), [])

  const refreshCurrentSession = useCallback(async (session: Session) => {
    const snap = await loadSnapshot(false, false)
    if (!snap) return

    const currentPeer = snap.peers.find(p => p.id === session.peerId)
    const sessionStatus = session.mode === 'peer' ? (currentPeer?.status ?? session.status) : 'online'
    const systemMsg: Message = {
      id: `sys-${session.peerId}`,
      sender: 'System',
      role: 'system',
      content: `BACKEND · ${snap.status?.localAddress ?? '127.0.0.1'}:${snap.status?.serverPort ?? 0} · WIFI LINK ${sessionStatus.toUpperCase()}`,
      timestamp: new Date(),
      isOwn: false,
      system: true
    }

    if (session.mode === 'host') {
      const hosted = await offlineApi.getHostedSession().catch(() => null)
      if (!hosted) return

      const updatedSession = buildHostSession(hosted, snap.profile, snap.status)
      setCurrentSession(updatedSession)

      const nextParticipants: Participant[] = [
        {
          id: snap.profile?.peerId ?? 'local',
          name: snap.profile?.displayName ?? 'You',
          role: inferRole(snap.profile?.displayName ?? 'You'),
          status: 'online',
          joinedAt: updatedSession.created,
          device: 'This Device',
          ipAddress: snap.status?.localAddress ?? '127.0.0.1',
          messagesSent: 0
        }
      ]

      const allRecords: ChatMessageRecord[] = []
      for (const pid of hosted.participantPeerIds) {
        const peer = snap.peers.find(p => p.id === pid)
        if (!peer) continue

        nextParticipants.push({
          id: pid,
          name: peer.displayName,
          role: inferRole(peer.displayName),
          status: peer.status === 'online' ? 'online' : 'away',
          joinedAt: new Date(hosted.updatedAt),
          device: peer.displayName,
          ipAddress: peer.address,
          messagesSent: 0
        })

        const conv = findBestConversationForSession(snap.convs, pid, session.code)
        if (!conv) continue
        const records = await offlineApi.getMessages(conv.id).catch(() => [] as ChatMessageRecord[])
        allRecords.push(...records)
      }

      allRecords.sort((a, b) => a.createdAt - b.createdAt)
      const mapped = mapRecordsToMessages(allRecords, snap.profile)
      syncMessages([
        systemMsg,
        {
          id: `host-code-${updatedSession.code}`,
          sender: 'System',
          role: 'system',
          content: `SESSION CREATED · CODE: ${updatedSession.code} · Share this code with your friend. They can also scan your device on the same LAN.`,
          timestamp: new Date(updatedSession.created),
          isOwn: false,
          system: true
        },
        ...mapped
      ])
      setParticipants(nextParticipants)
      setPacketCount(allRecords.length)
      setRxBytes(allRecords.filter(r => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
      setTxBytes(allRecords.filter(r => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
      return
    }

    const conversationId = findBestConversationForSession(snap.convs, session.peerId, session.code)?.id ?? session.conversationId
    const updatedSession: Session = {
      ...session,
      name: currentPeer?.hostedSession?.name?.trim() || session.name,
      peerDisplayName: currentPeer?.displayName ?? session.peerDisplayName,
      status: sessionStatus,
      conversationId
    }
    setCurrentSession(updatedSession)
    setParticipants([
      {
        id: snap.profile?.peerId ?? 'local',
        name: snap.profile?.displayName ?? 'You',
        role: inferRole(snap.profile?.displayName ?? 'You'),
        status: 'online',
        joinedAt: new Date(),
        device: 'This Device',
        ipAddress: snap.status?.localAddress ?? '127.0.0.1',
        messagesSent: 0
      },
      {
        id: session.peerId,
        name: currentPeer?.displayName ?? session.peerDisplayName,
        role: inferRole(currentPeer?.displayName ?? session.peerDisplayName),
        status: sessionStatus === 'online' ? 'online' : 'away',
        joinedAt: session.created,
        device: currentPeer?.displayName ?? session.peerDisplayName,
        ipAddress: currentPeer?.address ?? session.address,
        messagesSent: 0
      }
    ])

    if (!conversationId) {
      syncMessages([systemMsg, {
        id: `empty-${session.peerId}`,
        sender: 'System',
        role: 'system',
        content: `CONNECTED TO ${session.name.toUpperCase()} · Send a message to start`,
        timestamp: new Date(),
        isOwn: false,
        system: true
      }])
      setPacketCount(0)
      setRxBytes(0)
      setTxBytes(0)
      return
    }

    const records = await offlineApi.getMessages(conversationId).catch(() => [] as ChatMessageRecord[])
    syncMessages([systemMsg, ...mapRecordsToMessages(records, snap.profile)])
    setPacketCount(records.length)
    setRxBytes(records.filter(r => r.direction === 'incoming').reduce((s, r) => s + r.content.length * 2, 0))
    setTxBytes(records.filter(r => r.direction === 'outgoing').reduce((s, r) => s + r.content.length * 2, 0))
  }, [loadSnapshot, mapRecordsToMessages, syncMessages])

  // --- Open session ---
  const openSession = useCallback(async (session: Session) => {
    setCurrentSession(session)
    setShowJoinModal(false)
    setJoinCode('')
    setJoinPassword('')
    setSelectedTab('messages')
    navigate(`/chat?code=${session.code}`, { replace: true })
    addLog(`Session opened · ${session.name}`)
    const snap = await loadSnapshot(false)
    const status = snap?.status ?? null
    const prof = snap?.profile ?? null

    // Rebuild with fresh conv id
    if (session.mode === 'peer' && snap) {
      const freshConv = findBestConversationForSession(snap.convs, session.peerId, session.code)
      const freshSession = { ...session, conversationId: freshConv?.id ?? null }
      setCurrentSession(freshSession)
      setParticipants([
        {
          id: prof?.peerId ?? 'local',
          name: prof?.displayName ?? 'You',
          role: inferRole(prof?.displayName ?? 'You'),
          status: 'online',
          joinedAt: new Date(),
          device: 'This Device',
          ipAddress: status?.localAddress ?? '127.0.0.1',
          messagesSent: 0
        },
        {
          id: session.peerId,
          name: session.peerDisplayName,
          role: inferRole(session.peerDisplayName),
          status: session.status === 'online' ? 'online' : 'away',
          joinedAt: session.created,
          device: session.peerDisplayName,
          ipAddress: session.address,
          messagesSent: 0
        }
      ])
      await loadMessages(freshSession, status, prof)
    } else {
      setParticipants([
        {
          id: prof?.peerId ?? 'local',
          name: prof?.displayName ?? 'You',
          role: inferRole(prof?.displayName ?? 'You'),
          status: 'online',
          joinedAt: new Date(),
          device: 'This Device',
          ipAddress: status?.localAddress ?? '127.0.0.1',
          messagesSent: 0
        }
      ])
      await loadMessages(session, status, prof)
    }
  }, [addLog, loadMessages, loadSnapshot, navigate])

  // --- Bootstrap on mount ---
  useEffect(() => {
    let mounted = true
    const bootstrap = async () => {
      const perms = await offlineApi.getPermissions().catch(() => null)
      if (mounted && perms) setPermissions(perms)

      const snap = await loadSnapshot(false)
      if (!mounted || !snap) return

      addLog('Offline backend ready · Electron IPC connected')

      // Check if there's an existing hosted session
      const hosted = await offlineApi.getHostedSession().catch(() => null)
      if (hosted && mounted) {
        const hostSession = buildHostSession(hosted, snap.profile, snap.status)
        if (sessionCodeParam && hostSession.code === sessionCodeParam) {
          await openSession(hostSession)
          return
        }
      }

      if (sessionCodeParam && snap.allSessions) {
        const match = snap.allSessions.find(s => s.code === sessionCodeParam)
        if (match) await openSession(match)
        return
      }

      const savedSession = loadSavedSession()
      if (!savedSession) return

      if (savedSession.mode === 'host') {
        const hostedSession = await offlineApi.getHostedSession().catch(() => null)
        if (hostedSession && hostedSession.code === savedSession.code) {
          await openSession(buildHostSession(hostedSession, snap.profile, snap.status))
          return
        }

        saveActiveSession(null)
        return
      }

      const savedPeer = snap.peers.find(p => p.id === savedSession.peerId)
      const savedConv = findBestConversationForSession(snap.convs, savedSession.peerId, savedSession.code)
      if (savedPeer) {
        await openSession(buildPeerSession(savedPeer, savedConv, snap.profile?.displayName ?? 'You'))
        return
      }

      if (savedConv) {
        await openSession({
          ...savedSession,
          conversationId: savedConv.id,
          status: 'stale'
        })
        return
      }

      saveActiveSession(null)
    }
    bootstrap().catch(e => console.error(e))
    return () => { mounted = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Poll for new messages ---
  useEffect(() => {
    if (!currentSession) return
    shouldStickToBottomRef.current = true
    const interval = setInterval(async () => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      const sess = currentSessionRef.current
      if (!sess) {
        isPollingRef.current = false
        return
      }

      try {
        await refreshCurrentSession(sess)
      } finally {
        isPollingRef.current = false
      }
    }, 1500)
    return () => clearInterval(interval)
  }, [currentSession, refreshCurrentSession])

  // --- Scan ---
  const scanForSessions = useCallback(async () => {
    const perms = await offlineApi.getPermissions().catch(() => null)
    if (perms?.nearbyScan !== 'granted') {
      setPermissions(perms ?? null)
      scanAfterPermissionGrantRef.current = true
      setPermPrompt(true)
      return
    }

    setIsScanning(true)
    addLog('Scanning LAN for peers...')
    try {
      const snap = await loadSnapshot(true)
      if (!snap) return
      const sessions = snap.peers
        .filter(isPeerSessionVisible)
        .map(p => buildPeerSession(
          p,
          findBestConversationForSession(snap.convs, p.id, p.hostedSession?.code),
          snap.profile?.displayName ?? 'You'
        ))
      setNearbySessions(sessions)
      setShowJoinModal(true)
      addLog(sessions.length > 0
        ? `Found ${sessions.length} active session${sessions.length === 1 ? '' : 's'} on LAN`
        : 'No sessions found. Ask your friend to create a session first.')
    } catch (e) {
      showError(`Scan failed: ${getErrorMessage(e)}`)
    } finally {
      setIsScanning(false)
    }
  }, [addLog, loadSnapshot, showError])

  // --- Create session (REAL backend call) ---
  const createSession = useCallback(async () => {
    setShowCreateModal(false)
    try {
      addLog('Creating session on backend...')
      const backendSession = await offlineApi.createHostedSession({
        name: createName.trim() || `${profile?.displayName ?? 'My'} Session`,
        description: createDesc.trim() || 'LAN session — share the code to chat offline',
        visibility: createVisibility,
        password: createVisibility === 'private' ? createPassword.trim() || undefined : undefined
      })

      const snap = await loadSnapshot(false)
      const hostSession = buildHostSession(backendSession, snap?.profile ?? profile, snap?.status ?? backendStatus)

      setCurrentSession(hostSession)
      setSelectedTab('messages')
      setBroadcastMode(false)
      setMessages([
        {
          id: `sys-host`,
          sender: 'System',
          role: 'system',
          content: `BACKEND · ${snap?.status?.localAddress ?? '127.0.0.1'}:${snap?.status?.serverPort ?? 0} · WIFI READY`,
          timestamp: new Date(),
          isOwn: false,
          system: true
        },
        {
          id: `host-code-${backendSession.code}`,
          sender: 'System',
          role: 'system',
          content: `SESSION CREATED · CODE: ${backendSession.code} · Share this with your friend. They can scan or enter this code manually to join.`,
          timestamp: new Date(),
          isOwn: false,
          system: true
        }
      ])
      setParticipants([
        {
          id: snap?.profile?.peerId ?? 'local',
          name: snap?.profile?.displayName ?? 'You',
          role: inferRole(snap?.profile?.displayName ?? 'You'),
          status: 'online',
          joinedAt: new Date(),
          device: 'This Device',
          ipAddress: snap?.status?.localAddress ?? '127.0.0.1',
          messagesSent: 0
        }
      ])
      setPacketCount(0)
      setRxBytes(0)
      setTxBytes(0)
      navigate(`/chat?code=${backendSession.code}`, { replace: true })
      addLog(`Session ${backendSession.code} created · ${createVisibility.toUpperCase()}`)

      // Reset form
      setCreateName('')
      setCreateDesc('')
      setCreateVisibility('public')
      setCreatePassword('')
    } catch (e) {
      showError(`Create failed: ${getErrorMessage(e)}`)
    }
  }, [addLog, backendStatus, createDesc, createName, createPassword, createVisibility, loadSnapshot, navigate, profile, showError])

  // --- Join by code (REAL backend call) ---
  const joinByCode = useCallback(async (code: string, password?: string) => {
    const normalizedCode = code.trim().toUpperCase()
    if (!normalizedCode || normalizedCode.length < 4) {
      showError('Enter a valid session code')
      return
    }

    addLog(`Joining session ${normalizedCode}...`)

    try {
      const backendSession = await offlineApi.joinSessionByCode(normalizedCode, password)
      // After joining, refresh to get peer + conversation
      const freshSnap = await loadSnapshot(false)
      if (!freshSnap) return

      const peer = freshSnap.peers.find(p => p.id === backendSession.hostPeerId)
      if (peer) {
        const conv = findBestConversationForSession(freshSnap.convs, peer.id, normalizedCode)
        const session = buildPeerSession(peer, conv, freshSnap.profile?.displayName ?? 'You')
        await openSession(session)
      } else {
        // Peer not in list yet — create minimal session
        const minimalSession: Session = {
          code: normalizedCode,
          peerId: backendSession.hostPeerId,
          name: backendSession.name,
          peerDisplayName: backendSession.hostDisplayName,
          mode: 'peer',
          participants: 2,
          encrypted: backendSession.visibility === 'private',
          created: new Date(backendSession.createdAt),
          description: backendSession.description,
          activeUsers: [freshSnap.profile?.displayName ?? 'You', backendSession.hostDisplayName],
          messageCount: 0,
          lastActivity: new Date(),
          address: '',
          transport: 'wifi',
          status: 'online',
          conversationId: findBestConversationForSession(freshSnap.convs, backendSession.hostPeerId, normalizedCode)?.id ?? null,
          backendSessionId: backendSession.id
        }
        await openSession(minimalSession)
      }
      setShowJoinModal(false)
      addLog(`Joined session ${normalizedCode} successfully`)
    } catch (e) {
      showError(`Join failed: ${getErrorMessage(e)}`)
      addLog(`Join failed: ${getErrorMessage(e)}`)
    }
  }, [addLog, loadSnapshot, openSession, showError])

  // --- Leave session ---
  const leaveSession = useCallback(async () => {
    if (currentSession?.mode === 'host') {
      try {
        await offlineApi.closeHostedSession()
        addLog('Hosted session closed')
      } catch (e) {
        addLog(`Close session error: ${getErrorMessage(e)}`)
      }
    }
    addLog(`Left session · ${currentSession?.name ?? ''}`)
    setCurrentSession(null)
    setMessages([])
    setParticipants([])
    setSelectedTab('messages')
    setBroadcastMode(false)
    saveActiveSession(null)
    navigate('/chat', { replace: true })
    await loadSnapshot(false)
  }, [addLog, currentSession, loadSnapshot, navigate])

  // --- Send message ---
  const sendMessage = useCallback(async () => {
    if (!newMessage.trim() || !currentSession || isSending) return

    if (currentSession.mode === 'host') {
      const hosted = await offlineApi.getHostedSession().catch(() => null)
      if (!hosted || hosted.participantPeerIds.length === 0) {
        setMessages(prev => [...prev, {
          id: `wait-${Date.now()}`,
          sender: 'System',
          role: 'system',
          content: 'WAITING FOR FRIEND TO JOIN · Share the session code above',
          timestamp: new Date(),
          isOwn: false,
          system: true
        }])
        return
      }
      // Send to all participants
      const content = newMessage.trim()
      setNewMessage('')
      setIsSending(true)
      try {
        const snap = await loadSnapshot(false)
        const peers = snap?.peers.filter(p => hosted.participantPeerIds.includes(p.id)) ?? []
        await Promise.allSettled(peers.map(p => offlineApi.sendMessage(p.id, content, currentSession.code)))
        addLog(`Broadcast sent to ${peers.length} participant(s)`)
        // Optimistic add
        setMessages(prev => [...prev, {
          id: `local-${Date.now()}`,
          sender: snap?.profile?.displayName ?? 'You',
          role: inferRole(snap?.profile?.displayName ?? 'You'),
          content,
          timestamp: new Date(),
          isOwn: true,
          encrypted: true,
          delivered: true,
          failed: false
        }])
      } catch (e) {
        showError(`Send failed: ${getErrorMessage(e)}`)
      } finally {
        await refreshCurrentSession(currentSession).catch(() => undefined)
        setIsSending(false)
        inputRef.current?.focus()
      }
      return
    }

    const content = newMessage.trim()
    setNewMessage('')
    setIsSending(true)
    const optimisticId = `local-${Date.now()}`

    setMessages(prev => [...prev, {
      id: optimisticId,
      sender: profile?.displayName ?? 'You',
      role: inferRole(profile?.displayName ?? 'You'),
      content,
      timestamp: new Date(),
      isOwn: true,
      encrypted: true,
      delivered: false,
      failed: false
    }])

    try {
      if (broadcastMode) {
        await Promise.allSettled(peerRecords.filter(p => p.status === 'online').map(p => offlineApi.sendMessage(p.id, content, currentSession.code)))
        addLog(`Broadcast sent`)
      } else {
        await offlineApi.sendMessage(currentSession.peerId, content, currentSession.code)
        addLog(`Message sent to ${currentSession.peerDisplayName}`)
      }
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, delivered: true, failed: false } : m))
    } catch (e) {
      showError(`Send failed: ${getErrorMessage(e)}`)
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, delivered: false, failed: true } : m))
    } finally {
      await refreshCurrentSession(currentSession).catch(() => undefined)
      setIsSending(false)
      inputRef.current?.focus()
    }
  }, [addLog, broadcastMode, currentSession, isSending, loadSnapshot, newMessage, peerRecords, profile, refreshCurrentSession, showError])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage() }
  }

  const filteredMessages = useMemo(() => messages.filter(m => {
    if (filter === 'teacher') return m.role === 'teacher' || m.system
    if (filter === 'student') return m.role === 'student' || m.system
    return true
  }), [filter, messages])

  // ==================== RENDER ====================

  return (
    <div className="cr">

      {/* ── ERROR TOAST ── */}
      {error && (
        <div className="toast-err">{error}</div>
      )}

      {/* ── PERMISSION PROMPT ── */}
      {permPrompt && (
        <div className="modal-overlay" onClick={() => setPermPrompt(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">NEARBY SCAN PERMISSION</div>
            <div className="modal-sub" style={{ marginBottom: 16 }}>
              ED-DESK needs permission to scan for nearby devices on your local LAN. This is required to discover peers running ED-DESK on the same Wi-Fi network.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-join" style={{ flex: 1 }} onClick={grantPermission}>GRANT PERMISSION</button>
              <button className="btn-join" style={{ flex: 1, background: 'none', border: '1px solid #333' }} onClick={() => setPermPrompt(false)}>CANCEL</button>
            </div>
            <button className="modal-close" onClick={() => setPermPrompt(false)}>×</button>
          </div>
        </div>
      )}

      {/* ── CREATE SESSION MODAL ── */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">CREATE SESSION</div>
            <div className="modal-sub">Others on the same LAN can scan or enter your session code to join</div>
            <div className="create-form">
              <label className="form-label">SESSION NAME</label>
              <input
                className="code-input"
                style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                placeholder={`${profile?.displayName ?? 'My'} Session`}
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                maxLength={40}
              />
              <label className="form-label">DESCRIPTION (optional)</label>
              <input
                className="code-input"
                style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                placeholder="What is this session for?"
                value={createDesc}
                onChange={e => setCreateDesc(e.target.value)}
                maxLength={100}
              />
              <label className="form-label">VISIBILITY</label>
              <div className="vis-row">
                <button
                  className={`vis-btn ${createVisibility === 'public' ? 'vis-active' : ''}`}
                  onClick={() => setCreateVisibility('public')}
                >PUBLIC · Anyone on LAN can join</button>
                <button
                  className={`vis-btn ${createVisibility === 'private' ? 'vis-active' : ''}`}
                  onClick={() => setCreateVisibility('private')}
                >PRIVATE · Requires password</button>
              </div>
              {createVisibility === 'private' && (
                <>
                  <label className="form-label">PASSWORD</label>
                  <input
                    type="password"
                    className="code-input"
                    style={{ letterSpacing: 'normal', textAlign: 'left', fontSize: 11 }}
                    placeholder="Session password"
                    value={createPassword}
                    onChange={e => setCreatePassword(e.target.value)}
                  />
                </>
              )}
              <button className="btn-join" style={{ marginTop: 8 }} onClick={createSession}>
                CREATE SESSION
              </button>
            </div>
            <button className="modal-close" onClick={() => setShowCreateModal(false)}>×</button>
          </div>
        </div>
      )}

      {/* ── SIDEBAR ── */}
      <aside className="sb">
        <div className="sb-hdr">
          <span className="sb-title">CHAT SESSIONS</span>
          <div className="sb-hdr-r">
            <span className="sb-time">{fmtShort(time)}</span>
          </div>
        </div>

        {currentSession ? (
          <div className="s-panel">
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
                <div className="host-share-hint">Friend opens ED-DESK → Scan LAN or enter code manually</div>
              </div>
            )}
            <div className="s-desc">{currentSession.description}</div>
            <div className="s-stats">
              <div className="ss"><span>MODE</span><span>{currentSession.mode.toUpperCase()}</span></div>
              <div className="ss"><span>PARTICIPANTS</span><span>{participants.length}</span></div>
              <div className="ss"><span>MESSAGES</span><span>{messages.filter(m => !m.system).length}</span></div>
              <div className="ss"><span>PACKETS</span><span>{packetCount}</span></div>
              <div className="ss"><span>RX</span><span>{fmtBytes(rxBytes)}</span></div>
              <div className="ss"><span>TX</span><span>{fmtBytes(txBytes)}</span></div>
              <div className="ss"><span>ENCRYPT</span><span className="enc-on">AES-256</span></div>
            </div>
            <div className="s-actions">
              <button className="btn-panel" onClick={() => setShowParticipants(p => !p)}>USERS ({participants.length})</button>
              <button className="btn-panel" onClick={() => setShowNetworkPanel(p => !p)}>NODES</button>
            </div>
            {showParticipants && (
              <div className="sub-panel">
                <div className="sp-title">PARTICIPANTS</div>
                {participants.map(p => (
                  <div key={p.id} className="p-row">
                    <span className={`p-dot ${p.status}`} />
                    <div className="p-inf">
                      <span className="p-name">{p.name}</span>
                      <span className="p-role">{p.role.toUpperCase()}</span>
                    </div>
                    <span className="p-ip">{p.ipAddress}</span>
                  </div>
                ))}
              </div>
            )}
            {showNetworkPanel && (
              <div className="sub-panel">
                <div className="sp-title">NETWORK NODES</div>
                {networkNodes.map(n => (
                  <div key={n.id} className="n-row">
                    <span className={`n-dot ${n.status}`} />
                    <span className="n-name">{n.name}</span>
                    <span className="n-lat">{n.latency}ms</span>
                  </div>
                ))}
              </div>
            )}
            <button className="btn-leave" onClick={leaveSession}>LEAVE SESSION</button>
          </div>
        ) : (
          <div className="no-sess">
            <div className="no-sess-icon">⬡</div>
            <p>No active session</p>
            <p className="hint">Create or scan to join</p>
          </div>
        )}

        <div className="qa">
          <div className="qa-title">QUICK ACTIONS</div>
          <button className="qa-btn" onClick={() => setShowCreateModal(true)}>
            <span className="qa-badge badge-pub">NEW</span> Create Session
          </button>
          <button className="qa-btn" onClick={scanForSessions} disabled={isScanning}>
            <span className="qa-badge badge-scan">LAN</span> {isScanning ? 'Scanning...' : 'Scan for Sessions'}
          </button>
          <button className="qa-btn" onClick={() => { setJoinCode(''); setShowJoinModal(true) }}>
            <span className="qa-badge badge-scan">↗</span> Join by Code
          </button>
          <button className={`qa-btn ${broadcastMode ? 'qa-active' : ''}`} onClick={() => setBroadcastMode(b => !b)}>
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
            <div className="ch">
              <div className="ch-l">
                <div className="ch-title">{currentSession.name}</div>
                <div className="ch-meta">
                  <span className="ch-tag">{currentSession.code}</span>
                  {currentSession.mode === 'peer' && <span>Chatting with {currentSession.peerDisplayName}</span>}
                  <span>{participants.filter(p => p.status === 'online').length} online / {participants.length} total</span>
                  {currentSession.encrypted && <span className="ch-enc">SECURE</span>}
                  {broadcastMode && <span className="ch-bcast">BROADCAST</span>}
                  {currentSession.mode === 'host' && <span className="ch-host">HOST</span>}
                </div>
              </div>
              <div className="ch-r">
                <div className="ch-stat"><span>LATENCY</span><span>{networkNodes[0]?.latency ?? '--'}ms</span></div>
                <div className="ch-stat"><span>PKTS</span><span>{packetCount}</span></div>
                <div className="ch-stat"><span>TIME</span><span>{fmt(time)}</span></div>
              </div>
            </div>

            <div className="tab-bar">
              {(['messages', 'logs', 'network'] as const).map(tab => (
                <button key={tab} className={`tab-btn ${selectedTab === tab ? 'tab-on' : ''}`} onClick={() => setSelectedTab(tab)}>
                  {tab.toUpperCase()}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {selectedTab === 'messages' && (
                <div className="filter-row">
                  {(['all', 'teacher', 'student'] as const).map(f => (
                    <button key={f} className={`filter-btn ${filter === f ? 'filter-on' : ''}`} onClick={() => setFilter(f)}>
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedTab === 'messages' && (
              <div className="msgs" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
                {filteredMessages.map(msg => (
                  <div key={msg.id} className={`mw ${msg.isOwn ? 'mw-own' : ''} ${msg.system ? 'mw-sys' : ''}`}>
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
                          <div className="msg-cnt">{msg.content}</div>
                          <div className="msg-foot">
                            <span className="msg-ts">{fmt(msg.timestamp)}</span>
                            {msg.isOwn && (
                              <span className="msg-st">{msg.failed ? 'FAILED' : msg.delivered ? 'SENT' : 'PEND'}</span>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {typingUsers.length > 0 && (
                  <div className="typing-row">
                    <span className="typing-dot">...</span>
                    <span>{typingUsers[0]} is typing</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}

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

            {selectedTab === 'network' && (
              <div className="net-area">
                <div className="net-title">ACTIVE NODES</div>
                <div className="net-grid">
                  {networkNodes.map(n => (
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
                  {participants.map(p => (
                    <div key={p.id} className="dev-card">
                      <div className="dc-top">
                        <span className={`dc-dot ${p.status}`} />
                        <span className="dc-name">{p.name}</span>
                        <span className={`dc-role dc-${p.role}`}>{p.role.toUpperCase()}</span>
                      </div>
                      <div className="dc-row"><span>IP</span><span>{p.ipAddress}</span></div>
                      <div className="dc-row"><span>DEVICE</span><span>{p.device}</span></div>
                      <div className="dc-row"><span>STATUS</span><span>{p.status.toUpperCase()}</span></div>
                    </div>
                  ))}
                </div>
                <div className="net-title" style={{ marginTop: 18 }}>LIVE STATS</div>
                <div className="stats-grid">
                  <div className="stat-card"><span>PACKETS</span><span>{packetCount}</span></div>
                  <div className="stat-card"><span>RECEIVED</span><span>{fmtBytes(rxBytes)}</span></div>
                  <div className="stat-card"><span>SENT</span><span>{fmtBytes(txBytes)}</span></div>
                  <div className="stat-card"><span>ENCRYPTION</span><span>AES-256-GCM</span></div>
                  <div className="stat-card"><span>PROTOCOL</span><span>UDP + HTTP</span></div>
                  <div className="stat-card"><span>NODES</span><span>{networkNodes.filter(n => n.status === 'connected').length}/{networkNodes.length}</span></div>
                </div>
              </div>
            )}

            {selectedTab === 'messages' && (
              <div className="inp-area">
                {broadcastMode && (
                  <div className="bcast-banner">BROADCAST MODE · Message will be sent to all available peers</div>
                )}
                <div className="inp-row">
                  <div className="inp-pfx">&gt;</div>
                  <input
                    ref={inputRef}
                    className="msg-inp"
                    placeholder={
                      currentSession.mode === 'host' && participants.length <= 1
                        ? `Waiting for friend to join (code: ${currentSession.code})...`
                        : broadcastMode
                          ? 'Broadcast message...'
                          : currentSession.mode === 'peer'
                            ? `Message ${currentSession.peerDisplayName}...`
                            : 'Type a message... (Enter to send)'
                    }
                    value={newMessage}
                    onChange={e => setNewMessage(e.target.value)}
                    onKeyDown={handleKey}
                    disabled={isSending}
                  />
                  <span className="inp-cnt">{newMessage.length}</span>
                  <button className="btn-send" onClick={sendMessage} disabled={!newMessage.trim() || isSending}>
                    {isSending ? '...' : 'SEND'}
                  </button>
                </div>
                <div className="inp-foot">
                  <span>SESSION · {currentSession.code}</span>
                  <span>{currentSession.encrypted ? 'AES-256-GCM ENCRYPTED' : 'UNENCRYPTED'}</span>
                  <span>{participants.filter(p => p.status === 'online').length} ONLINE</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="welcome">
            <div className="w-ascii-header">
              <pre className="w-glitch">{`   ____ _   _    _  _____
  / ___| | | |  / \\|_   _|
 | |   | |_| | / _ \\ | |
 | |___|  _  |/ ___ \\| |
  \\____|_| |_/_/   \\_\\_|`}</pre>
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
              <button className="wbtn wsecondary" onClick={() => { setJoinCode(''); setShowJoinModal(true) }}>
                ENTER CODE
              </button>
            </div>
            <div className="w-info">
              <div className="wi-row"><span>ENCRYPTION</span><span>AES-256-GCM</span></div>
              <div className="wi-row"><span>NETWORK</span><span>LOCAL LAN · Wi-Fi</span></div>
              <div className="wi-row"><span>DISCOVERY</span><span>UDP BROADCAST</span></div>
              <div className="wi-row"><span>TRANSPORT</span><span>HTTP · PEER-TO-PEER</span></div>
              <div className="wi-row"><span>BACKEND</span><span>{backendStatus ? `${backendStatus.localAddress}:${backendStatus.serverPort}` : 'Connecting...'}</span></div>
              <div className="wi-row"><span>PEERS ONLINE</span><span>{backendStatus?.peersOnline ?? 0}</span></div>
            </div>
          </div>
        )}
      </main>

      {/* ── JOIN MODAL ── */}
      {showJoinModal && (
        <div className="modal-overlay" onClick={() => setShowJoinModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">JOIN SESSION</div>
            <div className="modal-sub">{nearbySessions.length} active session{nearbySessions.length !== 1 ? 's' : ''} found on LAN</div>

            {nearbySessions.length > 0 && (
              <div className="sess-list">
                {nearbySessions.map(sess => (
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
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                maxLength={10}
              />
              {nearbySessions.find(s => s.code === joinCode)?.encrypted && (
                <input
                  type="password"
                  className="code-input"
                  style={{ letterSpacing: 'normal', fontSize: 11, textAlign: 'left' }}
                  placeholder="PASSWORD"
                  value={joinPassword}
                  onChange={e => setJoinPassword(e.target.value)}
                />
              )}
              <button className="btn-join" onClick={() => joinByCode(joinCode, joinPassword || undefined)} disabled={!joinCode}>
                JOIN
              </button>
            </div>
            <button className="modal-close" onClick={() => setShowJoinModal(false)}>×</button>
          </div>
        </div>
      )}

      {/* ── STYLES ── */}
      <style>{`
        * { margin:0; padding:0; box-sizing:border-box; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:#111; }
        ::-webkit-scrollbar-thumb { background:#222; border-radius:2px; }
        ::-webkit-scrollbar-thumb:hover { background:#1e3a5f; }
        * { scrollbar-width:thin; scrollbar-color:#222 #111; }

        .cr {
          display:flex;
          height:100%;
          min-height:calc(100vh - 120px);
          width:100%;
          overflow:hidden;
          background:#030303;
          color:#fff;
          font-family:'SF Mono','Monaco','Fira Code',monospace;
          font-size:11px;
          position:relative;
        }

        /* Toast */
        .toast-err {
          position:fixed; top:68px; left:50%; transform:translateX(-50%);
          background:#3a1010; border:1px solid #c86060; color:#ff9a9a;
          padding:8px 20px; font-size:9px; letter-spacing:0.5px; z-index:9999;
          animation:fadeIn 0.2s ease;
        }
        @keyframes fadeIn { from{opacity:0;transform:translateX(-50%) translateY(-6px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }

        /* Sidebar */
        .sb {
          width:280px; min-width:280px; background:#0a0a0a;
          border-right:1px solid #1e3a5f; display:flex;
          flex-direction:column; overflow-y:auto; overflow-x:hidden;
        }
        .sb-hdr {
          display:flex; justify-content:space-between; align-items:center;
          padding:12px 14px; border-bottom:1px solid #1e3a5f; background:#060606; flex-shrink:0;
        }
        .sb-title { font-size:9px; letter-spacing:1.5px; opacity:0.55; }
        .sb-hdr-r { display:flex; align-items:center; gap:8px; }
        .sb-time { font-size:10px; opacity:0.4; }

        /* Session panel */
        .s-panel { padding:12px 14px; border-bottom:1px solid #1e3a5f; flex-shrink:0; }
        .s-code-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
        .s-code { font-size:18px; font-weight:700; letter-spacing:4px; }
        .s-badge { font-size:7px; padding:2px 6px; border-radius:2px; }
        .badge-priv { background:rgba(30,58,95,0.5); border:1px solid #1e3a5f; }
        .badge-pub  { background:rgba(255,255,255,0.07); border:1px solid #333; }
        .badge-scan { background:rgba(255,255,255,0.05); border:1px solid #222; }
        .badge-bcast { background:rgba(74,144,217,0.2); border:1px solid #1e3a5f; }
        .badge-warn { background:rgba(200,80,80,0.3); border:1px solid #c86060; color:#ff9a9a; }

        /* Host share box */
        .host-share-box {
          background:#0d1a2a; border:1px solid #1e3a5f; padding:10px 12px;
          margin-bottom:8px; text-align:center;
        }
        .host-share-label { font-size:7px; opacity:0.45; letter-spacing:1px; margin-bottom:4px; }
        .host-share-code {
          font-size:24px; font-weight:700; letter-spacing:6px;
          color:#6ab4ff; text-shadow:0 0 12px rgba(106,180,255,0.4);
        }
        .host-share-hint { font-size:7px; opacity:0.35; margin-top:5px; font-style:italic; }

        .s-desc { font-size:8px; opacity:0.35; margin-bottom:8px; font-style:italic; }
        .s-stats {
          display:grid; grid-template-columns:1fr 1fr; background:#070707;
          border:1px solid #1e3a5f; padding:6px; gap:2px 0; margin-bottom:8px;
        }
        .ss { display:flex; justify-content:space-between; font-size:8px; padding:2px 0; border-bottom:1px dotted #111; }
        .ss span:first-child { opacity:0.4; }
        .enc-on { color:#6ab4ff; }

        .s-actions { display:flex; gap:5px; margin-bottom:6px; }
        .btn-panel {
          flex:1; background:#111; border:1px solid #1e3a5f; color:#fff;
          padding:4px 0; font-size:8px; cursor:pointer; font-family:inherit; transition:background 0.2s;
        }
        .btn-panel:hover { background:#1e3a5f; }
        .btn-leave {
          width:100%; background:none; border:1px solid rgba(255,255,255,0.15); color:#fff;
          padding:5px; font-size:8px; cursor:pointer; font-family:inherit;
          letter-spacing:1px; transition:all 0.2s; margin-top:4px;
        }
        .btn-leave:hover { background:rgba(255,255,255,0.04); border-color:#fff; }

        .sub-panel { padding:8px 14px; background:#050505; border-bottom:1px solid #1e3a5f; flex-shrink:0; }
        .sp-title { font-size:7px; letter-spacing:1px; opacity:0.35; margin-bottom:6px; }
        .p-row { display:flex; align-items:center; gap:6px; padding:4px 0; border-bottom:1px dotted #111; }
        .p-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
        .p-dot.online { background:#4a90d9; }
        .p-dot.away   { background:#888; animation:blink 1.2s infinite; }
        .p-dot.offline { background:#333; }
        .p-inf { flex:1; }
        .p-name { display:block; font-size:9px; }
        .p-role { font-size:7px; opacity:0.3; }
        .p-ip { font-size:7px; opacity:0.25; font-family:monospace; }
        .n-row { display:flex; align-items:center; gap:6px; padding:3px 0; font-size:8px; }
        .n-dot { width:5px; height:5px; border-radius:50%; }
        .n-dot.connected { background:#4a90d9; }
        .n-dot.connecting { background:#888; animation:blink 1.2s infinite; }
        .n-dot.lost { background:#333; }
        .n-name { flex:1; }
        .n-lat { opacity:0.4; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }

        .no-sess { padding:24px 14px; text-align:center; flex-shrink:0; }
        .no-sess-icon { font-size:22px; opacity:0.1; margin-bottom:6px; }
        .no-sess p { opacity:0.35; font-size:10px; }
        .hint { font-size:8px; opacity:0.2; margin-top:3px; }

        /* Quick actions */
        .qa { margin-top:auto; padding:10px 14px; border-top:1px solid #1e3a5f; flex-shrink:0; }
        .qa-title { font-size:7px; opacity:0.3; letter-spacing:1px; margin-bottom:6px; }
        .qa-btn {
          width:100%; background:#0d0d0d; border:1px solid #141414; color:#fff;
          padding:6px 9px; font-size:9px; cursor:pointer; font-family:inherit;
          display:flex; align-items:center; gap:7px; margin-bottom:3px;
          transition:border-color 0.2s; text-align:left;
        }
        .qa-btn:hover:not(:disabled) { border-color:#1e3a5f; background:#111; }
        .qa-btn:disabled { opacity:0.35; cursor:not-allowed; }
        .qa-btn.qa-active { border-color:#4a90d9; background:rgba(74,144,217,0.06); }
        .qa-btn.qa-perm { border-color:rgba(200,80,80,0.4); }
        .qa-badge { font-size:6px; padding:1px 4px; border-radius:1px; font-weight:700; flex-shrink:0; }

        /* Main */
        .cm {
          flex:1; display:flex; flex-direction:column;
          background:#030303; overflow:hidden; min-width:0; width:100%;
        }

        /* Chat header */
        .ch {
          display:flex; justify-content:space-between; align-items:center;
          padding:9px 18px; border-bottom:1px solid #1e3a5f;
          background:#060606; flex-shrink:0;
        }
        .ch-title { font-size:12px; font-weight:600; margin-bottom:3px; }
        .ch-meta { display:flex; align-items:center; gap:9px; font-size:8px; opacity:0.6; flex-wrap:wrap; }
        .ch-tag { background:#111; border:1px solid #1e3a5f; padding:1px 5px; font-family:monospace; }
        .ch-enc  { color:#6ab4ff; border:1px solid rgba(106,180,255,0.2); padding:1px 5px; font-size:7px; }
        .ch-bcast { color:#ffd700; border:1px solid rgba(255,215,0,0.2); padding:1px 5px; font-size:7px; }
        .ch-host  { color:#4a90d9; border:1px solid rgba(74,144,217,0.3); padding:1px 5px; font-size:7px; }
        .ch-r { display:flex; gap:14px; flex-shrink:0; }
        .ch-stat { display:flex; flex-direction:column; align-items:flex-end; font-size:8px; }
        .ch-stat span:first-child { opacity:0.3; font-size:7px; }
        .ch-stat span:last-child { font-weight:600; }

        /* Tab bar */
        .tab-bar {
          display:flex; align-items:center; height:34px;
          border-bottom:1px solid #1e3a5f; background:#070707;
          padding:0 18px; flex-shrink:0;
        }
        .tab-btn {
          background:none; border:none; border-bottom:2px solid transparent;
          color:#fff; opacity:0.3; font-size:8px; letter-spacing:1px;
          padding:0 10px; height:100%; cursor:pointer; font-family:inherit; transition:all 0.15s;
        }
        .tab-btn:hover { opacity:0.6; }
        .tab-btn.tab-on { opacity:1; border-bottom-color:#1e3a5f; }
        .filter-row { display:flex; gap:3px; }
        .filter-btn {
          background:none; border:1px solid #181818; color:#fff; opacity:0.3;
          font-size:7px; padding:2px 7px; cursor:pointer; font-family:inherit; transition:all 0.15s;
        }
        .filter-btn:hover { opacity:0.6; }
        .filter-btn.filter-on { opacity:1; border-color:#1e3a5f; background:rgba(30,58,95,0.18); }

        /* Messages */
        .msgs {
          flex:1; overflow-y:auto; padding:14px 18px;
          display:flex; flex-direction:column; gap:8px; min-height:0;
        }
        .mw { display:flex; flex-direction:column; align-items:flex-start; max-width:min(70%, 560px); }
        .mw-own { align-self:flex-end; align-items:flex-end; }
        .mw-sys { align-self:center; max-width:100%; }
        .msg-sys {
          display:flex; align-items:center; gap:7px; font-size:8px; opacity:0.3;
          padding:3px 10px; background:#090909; border:1px solid #111;
        }
        .sys-pipe { color:#1e3a5f; }
        .msg-ts { margin-left:auto; font-size:7px; }
        .msg-sndr-row { display:flex; align-items:center; gap:5px; margin-bottom:2px; margin-left:2px; }
        .sndr-badge { font-size:6px; padding:1px 4px; border-radius:1px; font-weight:700; }
        .role-teacher { background:rgba(30,58,95,0.6); }
        .role-student { background:rgba(255,255,255,0.08); }
        .role-admin   { background:rgba(180,100,50,0.4); }
        .msg-sndr { font-size:9px; opacity:0.6; }
        .enc-tag { font-size:6px; opacity:0.3; border:1px solid #222; padding:1px 3px; }
        .msg-bub { display:inline-block; width:fit-content; max-width:100%; background:#0e0e0e; border:1px solid #1e3a5f; padding:7px 11px; }
        .bub-own { background:#1e3a5f; border-color:#2a4a7a; }
        .msg-cnt { font-size:11px; line-height:1.5; word-break:break-word; }
        .msg-foot { display:flex; justify-content:flex-end; align-items:center; gap:5px; margin-top:3px; }
        .msg-ts { font-size:7px; opacity:0.35; }
        .msg-st { font-size:8px; opacity:0.5; }
        .typing-row { display:flex; align-items:center; gap:5px; font-size:8px; opacity:0.3; }
        .typing-dot { animation:blink 1s infinite; }

        /* Logs */
        .logs-area { flex:1; overflow-y:auto; padding:10px 18px; font-family:monospace; font-size:9px; }
        .logs-hdr { font-size:7px; opacity:0.3; letter-spacing:1px; margin-bottom:8px; padding-bottom:5px; border-bottom:1px solid #111; }
        .log-line { display:flex; gap:10px; padding:2px 0; border-bottom:1px dotted #0d0d0d; opacity:0.6; }
        .log-line:hover { opacity:1; }
        .log-idx { opacity:0.2; flex-shrink:0; }

        /* Network */
        .net-area { flex:1; overflow-y:auto; padding:14px 18px; }
        .net-title { font-size:8px; letter-spacing:1.5px; opacity:0.35; margin-bottom:8px; }
        .net-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-bottom:6px; }
        .net-card { background:#0a0a0a; border:1px solid #1e3a5f; padding:9px; }
        .nc-hdr { display:flex; align-items:center; gap:5px; margin-bottom:5px; padding-bottom:4px; border-bottom:1px dotted #111; }
        .nc-dot { width:5px; height:5px; border-radius:50%; }
        .nc-dot.connected { background:#4a90d9; }
        .nc-dot.lost { background:#333; }
        .nc-name { font-size:8px; }
        .nc-row { display:flex; justify-content:space-between; font-size:7px; opacity:0.55; margin-top:2px; }
        .nc-row span:last-child { color:#fff; opacity:1; }
        .dev-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
        .dev-card { background:#0a0a0a; border:1px solid #111; padding:9px; }
        .dc-top { display:flex; align-items:center; gap:5px; margin-bottom:5px; padding-bottom:4px; border-bottom:1px dotted #111; }
        .dc-dot { width:4px; height:4px; border-radius:50%; }
        .dc-dot.online { background:#4a90d9; }
        .dc-dot.away { background:#888; }
        .dc-name { flex:1; font-size:8px; }
        .dc-role { font-size:6px; padding:1px 4px; }
        .dc-teacher { background:rgba(30,58,95,0.5); }
        .dc-student { background:rgba(255,255,255,0.07); }
        .dc-row { display:flex; justify-content:space-between; font-size:7px; opacity:0.55; padding:2px 0; }
        .dc-row span:last-child { color:#fff; opacity:1; }
        .stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
        .stat-card { background:#0a0a0a; border:1px solid #1e3a5f; padding:9px; display:flex; flex-direction:column; gap:3px; }
        .stat-card span:first-child { font-size:6px; opacity:0.35; }
        .stat-card span:last-child { font-size:10px; font-weight:600; }

        /* Input */
        .inp-area { border-top:1px solid #1e3a5f; padding:10px 18px; background:#060606; flex-shrink:0; }
        .bcast-banner {
          font-size:7px; color:#ffd700; border:1px solid rgba(255,215,0,0.18);
          background:rgba(255,215,0,0.04); padding:3px 8px; margin-bottom:6px;
        }
        .inp-row { display:flex; align-items:center; gap:7px; margin-bottom:5px; }
        .inp-pfx { font-size:13px; opacity:0.3; flex-shrink:0; }
        .msg-inp {
          flex:1; background:#0e0e0e; border:1px solid #1e3a5f; color:#fff;
          padding:8px 11px; font-size:11px; font-family:inherit; outline:none; transition:border-color 0.2s;
        }
        .msg-inp:focus { border-color:rgba(255,255,255,0.25); }
        .msg-inp::placeholder { opacity:0.25; }
        .msg-inp:disabled { opacity:0.4; }
        .inp-cnt { font-size:8px; opacity:0.2; min-width:22px; text-align:right; flex-shrink:0; }
        .btn-send {
          background:#1e3a5f; border:none; color:#fff; padding:8px 18px;
          font-size:9px; cursor:pointer; font-family:inherit; letter-spacing:1px;
          transition:background 0.2s; flex-shrink:0;
        }
        .btn-send:hover:not(:disabled) { background:#2a4a7a; }
        .btn-send:disabled { opacity:0.28; cursor:not-allowed; }
        .inp-foot { display:flex; gap:14px; font-size:7px; opacity:0.2; letter-spacing:0.4px; }

        /* Welcome */
        .welcome {
          flex:1; display:flex; flex-direction:column; align-items:center;
          justify-content:center; padding:40px 24px; text-align:center; overflow-y:auto; overflow-x:hidden;
          background:
            radial-gradient(circle at top, rgba(30,58,95,0.18), transparent 42%),
            linear-gradient(180deg, #05080d 0%, #030303 48%, #030303 100%);
        }
        .welcome > * {
          width:100%;
          max-width:560px;
          margin-left:auto;
          margin-right:auto;
        }
        .w-ascii-header {
          background:#050a14;
          border-bottom:1px solid #1e3a5f;
          padding:14px 20px;
          display:flex;
          justify-content:space-between;
          align-items:center;
          gap:16px;
          flex-shrink:0;
          width:100%;
          margin-bottom:18px;
          text-align:left;
        }
        .w-glitch {
          color:#94b8ff;
          font-size:9px;
          line-height:1.25;
          text-shadow:0 0 18px rgba(148,184,255,0.35);
          white-space:pre;
          letter-spacing:0.5px;
          margin:0;
          overflow-x:auto;
        }
        .w-header-info {
          display:flex;
          gap:14px;
          align-items:center;
          background:#0a1628;
          padding:8px 14px;
          border:1px solid #1e3a5f;
          flex-shrink:0;
          min-width:0;
        }
        .w-version { font-size:9px; color:#4a7abf; }
        .w-time { font-size:13px; font-weight:600; color:#e8f0ff; letter-spacing:1px; }
        .w-log-box { border-left:1px solid #1e3a5f; padding-left:12px; min-width:0; }
        .w-log-msg {
          font-size:9px;
          color:#94b8ff;
          opacity:0.75;
          display:block;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
          max-width:180px;
        }
        .w-sub { font-size:9px; opacity:0.48; line-height:1.8; margin-bottom:24px; max-width:420px; }
        .w-actions { display:flex; gap:10px; margin-bottom:22px; flex-wrap:wrap; justify-content:center; align-items:center; }
        .wbtn {
          background:none; border:1px solid #1e3a5f; color:#fff;
          padding:9px 22px; font-size:9px; cursor:pointer; font-family:inherit;
          letter-spacing:1px; transition:all 0.2s; min-width:120px; text-align:center;
        }
        .wprimary { background:#1e3a5f; }
        .wprimary:hover { background:#2a4a7a; }
        .wsecondary:hover { background:rgba(30,58,95,0.2); }
        .wbtn:disabled { opacity:0.35; cursor:not-allowed; }
        .w-info { background:#0a0a0a; border:1px solid #1e3a5f; padding:12px 22px; width:min(100%, 420px); min-width:0; }
        .wi-row { display:flex; justify-content:space-between; font-size:8px; padding:4px 0; border-bottom:1px dotted #111; gap:40px; }
        .wi-row span:first-child { opacity:0.35; }

        /* Modal */
        .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.92); display:flex; align-items:center; justify-content:center; z-index:2000; }
        .modal-box {
          background:#0a0a0a; border:1px solid #1e3a5f; padding:22px;
          width:500px; max-width:94vw; max-height:82vh; overflow-y:auto; position:relative;
        }
        .modal-title { font-size:12px; letter-spacing:2px; margin-bottom:3px; }
        .modal-sub { font-size:8px; opacity:0.35; margin-bottom:14px; }
        .sess-list { border:1px solid #1e3a5f; max-height:240px; overflow-y:auto; margin-bottom:12px; }
        .sess-item {
          display:flex; justify-content:space-between; align-items:center;
          padding:10px 12px; border-bottom:1px solid #0d0d0d; cursor:pointer; transition:background 0.15s;
        }
        .sess-item:hover { background:#111; }
        .si-name { font-size:10px; margin-bottom:2px; }
        .si-code { font-size:8px; opacity:0.35; font-family:monospace; margin-bottom:1px; }
        .si-desc { font-size:7px; opacity:0.25; font-style:italic; }
        .si-r { display:flex; flex-direction:column; align-items:flex-end; gap:3px; }
        .si-badge { font-size:6px; padding:2px 6px; }
        .si-cnt { font-size:7px; opacity:0.4; }
        .modal-div { text-align:center; position:relative; font-size:7px; opacity:0.35; margin:12px 0; }
        .modal-div::before,.modal-div::after { content:''; position:absolute; top:50%; width:42%; height:1px; background:#1e3a5f; }
        .modal-div::before { left:0; }
        .modal-div::after { right:0; }
        .manual-join { display:flex; flex-direction:column; gap:7px; }
        .code-input {
          background:#0e0e0e; border:1px solid #1e3a5f; color:#fff;
          padding:9px 12px; font-size:13px; font-family:monospace;
          letter-spacing:4px; text-align:center; outline:none; width:100%;
        }
        .code-input:focus { border-color:#fff; }
        .btn-join {
          width:100%; background:#1e3a5f; border:none; color:#fff; padding:9px;
          font-size:9px; cursor:pointer; font-family:inherit; letter-spacing:1px; transition:background 0.2s;
        }
        .btn-join:hover:not(:disabled) { background:#2a4a7a; }
        .btn-join:disabled { opacity:0.35; cursor:not-allowed; }
        .modal-close {
          position:absolute; top:10px; right:14px; background:none;
          border:none; color:#fff; font-size:20px; cursor:pointer; opacity:0.3; line-height:1;
        }
        .modal-close:hover { opacity:1; }

        /* Create form */
        .create-form { display:flex; flex-direction:column; gap:7px; }
        .form-label { font-size:7px; opacity:0.45; letter-spacing:1px; margin-top:4px; }
        .vis-row { display:flex; gap:5px; }
        .vis-btn {
          flex:1; background:#0e0e0e; border:1px solid #1e3a5f; color:#fff;
          padding:7px 6px; font-size:8px; cursor:pointer; font-family:inherit;
          transition:all 0.15s; text-align:center; opacity:0.5;
        }
        .vis-btn:hover { opacity:0.8; }
        .vis-btn.vis-active { opacity:1; background:rgba(30,58,95,0.4); border-color:#6ab4ff; }

        /* Responsive */
        @media(max-width:900px){.sb{width:220px;min-width:220px;}.net-grid,.dev-grid{grid-template-columns:repeat(2,1fr)}}
        @media(max-width:640px){
          .welcome{padding:28px 16px;}
          .w-ascii-header{padding:12px 14px; flex-direction:column; align-items:flex-start;}
          .w-glitch{font-size:8px; letter-spacing:0.4px; width:100%;}
          .w-header-info{width:100%;}
          .w-log-msg{max-width:none;}
          .w-actions{flex-direction:column;}
          .wbtn{width:100%; max-width:320px;}
          .wi-row{gap:12px;}
        }
      `}</style>
    </div>
  )
}
