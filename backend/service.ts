import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import http, { IncomingMessage } from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { BackendDatabase } from './database'
import type {
  AssessmentQuestion,
  AssessmentRecord,
  AssessmentSubmissionRecord,
  BackendStatus,
  ChatMessageRecord,
  ConversationRecord,
  DevicePermissions,
  HostedSessionSummary,
  PeerRecord,
  SessionRecord
} from './types'

interface PeerHeartbeat {
  app: 'ed-desk'
  peerId: string
  displayName: string
  port: number
  capabilities: string[]
  hostedSession: HostedSessionSummary | null
  timestamp: number
}

interface PeerMessagePayload {
  peerId: string
  peerName: string
  recipientName: string
  content: string
  timestamp: number
  serverPort: number
  sessionCode?: string
}

interface JoinSessionPayload {
  peerId: string
  peerName: string
  code: string
  serverPort: number
  password?: string
}

export class OfflineBackendService {
  private readonly discoveryPort = 41235
  private readonly database: BackendDatabase
  private readonly peerId: string
  private readonly displayName: string
  private server: http.Server | null = null
  private discoverySocket: dgram.Socket | null = null
  private serverPort = 0
  private localAddress = '127.0.0.1'
  private heartbeatTimer: NodeJS.Timeout | null = null
  private peerExpiryTimer: NodeJS.Timeout | null = null

  constructor() {
    this.database = new BackendDatabase(join(app.getPath('userData'), 'backend', 'eddesk.sqlite'))
    this.peerId = `peer-${os.hostname().toLowerCase()}`
    this.displayName = os.hostname()
  }

  async start(): Promise<void> {
    await this.database.init()
    await this.startHttpServer()
    await this.startDiscovery()
    this.broadcastHeartbeat()
    this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), 8000)
    this.peerExpiryTimer = setInterval(() => this.expirePeers(), 12000)
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.peerExpiryTimer) clearInterval(this.peerExpiryTimer)
    this.discoverySocket?.close()
    this.discoverySocket = null

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }

    this.server = null
  }

  private async startHttpServer(): Promise<void> {
    this.server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')

        if (request.method === 'GET' && url.pathname === '/api/status') {
          this.writeJson(response, 200, this.getStatus())
          return
        }

        if (request.method === 'POST' && url.pathname === '/api/peer/message') {
          const payload = await this.readJson<PeerMessagePayload>(request)
          const message = this.receivePeerMessage(payload, request.socket.remoteAddress)
          this.writeJson(response, 200, { ok: true, message })
          return
        }

        if (request.method === 'POST' && url.pathname === '/api/peer/session/join') {
          const payload = await this.readJson<JoinSessionPayload>(request)
          const session = this.acceptSessionJoin(payload, request.socket.remoteAddress)
          this.writeJson(response, 200, { ok: true, session })
          return
        }

        if (request.method === 'POST' && url.pathname === '/api/peer/assessment') {
          const payload = await this.readJson<{ assessment: AssessmentRecord }>(request)
          this.receivePeerAssessment(payload.assessment)
          this.writeJson(response, 200, { ok: true })
          return
        }

        if (request.method === 'POST' && url.pathname === '/api/peer/assessment-submission') {
          const payload = await this.readJson<{ submission: AssessmentSubmissionRecord }>(request)
          this.receiveSubmission(payload.submission)
          this.writeJson(response, 200, { ok: true })
          return
        }

        this.writeJson(response, 404, { error: 'Not found' })
      } catch (error) {
        this.writeJson(response, 400, {
          error: error instanceof Error ? error.message : 'Request failed'
        })
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.listen(0, '0.0.0.0', () => {
        const addressInfo = this.server?.address()
        if (!addressInfo || typeof addressInfo === 'string') {
          reject(new Error('Unable to bind local backend server'))
          return
        }

        this.serverPort = addressInfo.port
        this.localAddress = this.getLocalIpAddress()
        resolve()
      })
      this.server?.on('error', reject)
    })
  }

  private async startDiscovery(): Promise<void> {
    this.discoverySocket = dgram.createSocket('udp4')

    this.discoverySocket.on('message', (buffer, remote) => {
      try {
        const payload = JSON.parse(buffer.toString()) as PeerHeartbeat
        if (payload.app !== 'ed-desk' || payload.peerId === this.peerId) {
          return
        }

        this.database.upsertPeer({
          id: payload.peerId,
          displayName: payload.displayName,
          address: remote.address,
          port: payload.port,
          status: 'online',
          transport: 'wifi',
          capabilities: payload.capabilities,
          lastSeen: Date.now(),
          hostedSession: payload.hostedSession
        })
      } catch {
        // Ignore invalid datagrams.
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.discoverySocket?.bind(this.discoveryPort, () => {
        try {
          this.discoverySocket?.setBroadcast(true)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      this.discoverySocket?.on('error', reject)
    })
  }

  private expirePeers(): void {
    const peers = this.database.listPeers()
    const now = Date.now()

    for (const peer of peers) {
      const status: PeerRecord['status'] = now - peer.lastSeen > 30000 ? 'stale' : 'online'
      const hostedSession = status === 'stale' ? null : peer.hostedSession
      if (status !== peer.status || hostedSession !== peer.hostedSession) {
        this.database.upsertPeer({
          ...peer,
          status,
          hostedSession
        })
      }
    }
  }

  private currentHostedSessionSummary(): HostedSessionSummary | null {
    const hosted = this.database.getHostedSession()
    if (!hosted) return null
    return {
      code: hosted.code,
      name: hosted.name,
      description: hosted.description,
      visibility: hosted.visibility,
      passwordRequired: Boolean(hosted.password),
      participantCount: hosted.participantPeerIds.length + 1,
      updatedAt: hosted.updatedAt
    }
  }

  private broadcastHeartbeat(): void {
    const payload: PeerHeartbeat = {
      app: 'ed-desk',
      peerId: this.peerId,
      displayName: this.displayName,
      port: this.serverPort,
      capabilities: ['chat', 'assessment', 'ledger'],
      hostedSession: this.currentHostedSessionSummary(),
      timestamp: Date.now()
    }

    const message = Buffer.from(JSON.stringify(payload))
    this.discoverySocket?.send(message, this.discoveryPort, '255.255.255.255')
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as T
  }

  private writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
  }

  private async postJson<T>(peer: PeerRecord, path: string, payload: unknown): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          host: peer.address,
          port: peer.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 3000
        },
        async (response) => {
          const chunks: Buffer[] = []
          for await (const chunk of response) {
            chunks.push(Buffer.from(chunk))
          }
          const raw = Buffer.concat(chunks).toString()
          if (response.statusCode && response.statusCode >= 400) {
            const error = raw ? JSON.parse(raw) as { error?: string } : {}
            reject(new Error(error.error ?? `Request failed with status ${response.statusCode}`))
            return
          }
          resolve(JSON.parse(raw) as T)
        }
      )

      request.on('error', reject)
      request.write(JSON.stringify(payload))
      request.end()
    })
  }

  private getLocalIpAddress(): string {
    const interfaces = os.networkInterfaces()
    for (const addrs of Object.values(interfaces)) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address
        }
      }
    }

    return '127.0.0.1'
  }

  private normalizeRemoteAddress(address?: string | null): string {
    if (!address) return ''
    return address.startsWith('::ffff:') ? address.slice(7) : address
  }

  private upsertPeerConnection(
    peerId: string,
    displayName: string,
    serverPort: number,
    remoteAddress?: string | null
  ): void {
    const existing = this.database.getPeer(peerId)
    this.database.upsertPeer({
      id: peerId,
      displayName,
      address: this.normalizeRemoteAddress(remoteAddress) || existing?.address || '',
      port: serverPort || existing?.port || 0,
      status: 'online',
      transport: 'wifi',
      capabilities: existing?.capabilities ?? ['chat', 'assessment', 'ledger'],
      lastSeen: Date.now(),
      hostedSession: existing?.hostedSession ?? null
    })
  }

  getStatus(): BackendStatus {
    return {
      peerId: this.peerId,
      displayName: this.displayName,
      localAddress: this.localAddress,
      serverPort: this.serverPort,
      discoveryPort: this.discoveryPort,
      backendMode: 'offline-desktop',
      blockchainMode: 'hash-ledger',
      bluetoothSupported: false,
      wifiDiscoveryEnabled: true,
      peersOnline: this.listPeers().filter((peer) => peer.status === 'online').length,
      conversations: this.listConversations().length,
      assessments: this.listAssessments().length,
      recordsInLedger: this.listLedger().length,
      activeHostedSession: this.currentHostedSessionSummary()
    }
  }

  getProfile(): { peerId: string; displayName: string } {
    return {
      peerId: this.peerId,
      displayName: this.displayName
    }
  }

  getPermissions(): DevicePermissions {
    return this.database.getPermissions()
  }

  updatePermissions(partial: Partial<DevicePermissions>): DevicePermissions {
    return this.database.updatePermissions(partial)
  }

  listPeers(): PeerRecord[] {
    return this.database.listPeers()
  }

  scanPeers(): PeerRecord[] {
    if (this.getPermissions().nearbyScan !== 'granted') {
      throw new Error('Nearby device permission is not granted.')
    }
    this.broadcastHeartbeat()
    return this.listPeers()
  }

  listAvailableSessions(): Array<SessionRecord & { address: string; peerStatus: PeerRecord['status'] }> {
    return this.listPeers()
      .filter((peer) => peer.status === 'online' && peer.hostedSession)
      .map((peer) => ({
        id: `remote-${peer.id}`,
        code: peer.hostedSession!.code,
        name: peer.hostedSession!.name,
        description: peer.hostedSession!.description,
        hostPeerId: peer.id,
        hostDisplayName: peer.displayName,
        visibility: peer.hostedSession!.visibility,
        password: null,
        participantPeerIds: [],
        createdAt: peer.hostedSession!.updatedAt,
        updatedAt: peer.hostedSession!.updatedAt,
        status: peer.status === 'online' ? 'active' : 'waiting',
        address: peer.address,
        peerStatus: peer.status
      }))
  }

  getHostedSession(): SessionRecord | null {
    return this.database.getHostedSession()
  }

  createHostedSession(input: {
    code?: string
    name: string
    description: string
    visibility: 'public' | 'private'
    password?: string
  }): SessionRecord {
    const normalizedCode = (input.code?.trim().toUpperCase() || this.generateSessionCode())
    const password = input.visibility === 'private' ? input.password?.trim() || null : null
    const now = Date.now()
    const session: SessionRecord = {
      id: `session-${this.peerId}`,
      code: normalizedCode,
      name: input.name.trim() || `${this.displayName} Session`,
      description: input.description.trim() || 'LAN session ready for chat',
      hostPeerId: this.peerId,
      hostDisplayName: this.displayName,
      visibility: input.visibility,
      password,
      participantPeerIds: [],
      createdAt: now,
      updatedAt: now,
      status: 'waiting'
    }
    this.database.saveHostedSession(session)
    this.database.addLedgerRecord({
      entityType: 'message',
      entityId: session.id,
      action: 'session-create',
      payload: {
        code: session.code,
        visibility: session.visibility
      }
    })
    this.broadcastHeartbeat()
    return session
  }

  closeHostedSession(): void {
    const hosted = this.database.getHostedSession()
    if (hosted) {
      this.database.addLedgerRecord({
        entityType: 'message',
        entityId: hosted.id,
        action: 'session-close',
        payload: {
          code: hosted.code
        }
      })
    }
    this.database.saveHostedSession(null)
    this.broadcastHeartbeat()
  }

  async joinSessionByCode(code: string, password?: string): Promise<SessionRecord> {
    const normalizedCode = code.trim().toUpperCase()
    const findLivePeer = () => this.listPeers().find((peer) => peer.status === 'online' && peer.hostedSession?.code === normalizedCode)
    const stalePeer = this.listPeers().find((peer) => peer.hostedSession?.code === normalizedCode)
    const directMatch = findLivePeer()
    const peer = directMatch ?? (() => {
      this.broadcastHeartbeat()
      return findLivePeer()
    })()

    if (!peer || !peer.hostedSession) {
      if (stalePeer) {
        throw new Error(`Session code ${normalizedCode} is no longer active on this network.`)
      }
      throw new Error(`Session code ${normalizedCode} was not found on this network.`)
    }

    let response: { ok: true; session: SessionRecord }
    try {
      response = await this.postJson<{ ok: true; session: SessionRecord }>(peer, '/api/peer/session/join', {
        peerId: this.peerId,
        peerName: this.displayName,
        code: normalizedCode,
        serverPort: this.serverPort,
        password
      } satisfies JoinSessionPayload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(message)) {
        this.database.upsertPeer({
          ...peer,
          status: 'stale',
          hostedSession: null
        })
        throw new Error(`Session code ${normalizedCode} is offline or unreachable right now.`)
      }
      throw error
    }

    this.database.ensureConversation(peer.id, peer.displayName, normalizedCode)
    this.database.addLedgerRecord({
      entityType: 'message',
      entityId: response.session.id,
      action: 'session-join',
      payload: {
        code: normalizedCode,
        hostPeerId: peer.id
      }
    })
    return response.session
  }

  private acceptSessionJoin(payload: JoinSessionPayload, remoteAddress?: string | null): SessionRecord {
    const hosted = this.database.getHostedSession()
    if (!hosted || hosted.code !== payload.code.trim().toUpperCase()) {
      throw new Error('Requested session is no longer available.')
    }
    if (hosted.visibility === 'private' && hosted.password !== (payload.password?.trim() || null)) {
      throw new Error('Incorrect session password.')
    }

    const participantIds = hosted.participantPeerIds.includes(payload.peerId)
      ? hosted.participantPeerIds
      : [...hosted.participantPeerIds, payload.peerId]

    this.upsertPeerConnection(payload.peerId, payload.peerName, payload.serverPort, remoteAddress)

    const updated: SessionRecord = {
      ...hosted,
      participantPeerIds: participantIds,
      updatedAt: Date.now(),
      status: 'active'
    }
    this.database.saveHostedSession(updated)
    this.database.addLedgerRecord({
      entityType: 'message',
      entityId: updated.id,
      action: 'session-accept',
      payload: {
        participantPeerId: payload.peerId,
        code: updated.code
      }
    })
    this.broadcastHeartbeat()
    return updated
  }

  listConversations(): ConversationRecord[] {
    return this.database.listConversations()
  }

  getMessages(conversationId: string): ChatMessageRecord[] {
    this.database.markConversationRead(conversationId)
    return this.database.listMessages(conversationId)
  }

  async sendLanMessage(peerId: string, content: string, sessionCode?: string): Promise<ChatMessageRecord> {
    const peer = this.database.getPeer(peerId)
    if (!peer) {
      throw new Error('Peer is not available on the local network.')
    }

    const normalizedSessionCode = sessionCode?.trim().toUpperCase() || null
    const conversation = this.database.ensureConversation(peer.id, peer.displayName, normalizedSessionCode)
    const createdAt = Date.now()
    const pendingMessage = this.database.addMessage({
      id: `msg-${randomUUID()}`,
      conversationId: conversation.id,
      peerId: peer.id,
      peerName: peer.displayName,
      senderName: this.displayName,
      recipientName: peer.displayName,
      content,
      direction: 'outgoing',
      transport: 'wifi',
      status: 'pending',
      createdAt
    })

    this.database.addLedgerRecord({
      entityType: 'message',
      entityId: pendingMessage.id,
      action: 'lan-send',
      payload: {
        peerId,
        contentLength: content.length
      }
    })

    try {
      await this.postJson(peer, '/api/peer/message', {
        peerId: this.peerId,
        peerName: this.displayName,
        recipientName: peer.displayName,
        content,
        timestamp: createdAt,
        serverPort: this.serverPort,
        sessionCode: normalizedSessionCode ?? undefined
      } satisfies PeerMessagePayload)

      const deliveredAt = Date.now()
      this.database.updateMessageStatus(pendingMessage.id, 'delivered', deliveredAt)
      return {
        ...pendingMessage,
        status: 'delivered',
        deliveredAt
      }
    } catch (error) {
      this.database.updateMessageStatus(pendingMessage.id, 'failed')
      throw error
    }
  }

  receivePeerMessage(payload: PeerMessagePayload, remoteAddress?: string | null): ChatMessageRecord {
    this.upsertPeerConnection(payload.peerId, payload.peerName, payload.serverPort, remoteAddress)
    const peer = this.database.getPeer(payload.peerId) ?? {
      id: payload.peerId,
      displayName: payload.peerName,
      address: this.normalizeRemoteAddress(remoteAddress),
      port: payload.serverPort,
      status: 'online' as const,
      transport: 'wifi' as const,
      capabilities: ['chat'],
      lastSeen: Date.now(),
      hostedSession: null
    }

    const conversation = this.database.ensureConversation(peer.id, payload.peerName, payload.sessionCode)
    const message = this.database.addMessage({
      id: `msg-${randomUUID()}`,
      conversationId: conversation.id,
      peerId: peer.id,
      peerName: payload.peerName,
      senderName: payload.peerName,
      recipientName: payload.recipientName,
      content: payload.content,
      direction: 'incoming',
      transport: 'wifi',
      status: 'delivered',
      createdAt: payload.timestamp,
      deliveredAt: Date.now()
    })

    this.database.addLedgerRecord({
      entityType: 'message',
      entityId: message.id,
      action: 'lan-receive',
      payload: {
        peerId: payload.peerId,
        contentLength: payload.content.length
      }
    })

    return message
  }

  async createAssessment(input: {
    title: string
    description: string
    creatorName?: string
    timeLimitMinutes: number
    sharedWithPeers: boolean
    questions: AssessmentQuestion[]
  }): Promise<AssessmentRecord> {
    const now = Date.now()
    const assessment: AssessmentRecord = {
      id: `assessment-${randomUUID()}`,
      code: Math.random().toString(36).slice(2, 8).toUpperCase(),
      title: input.title,
      description: input.description,
      creatorName: input.creatorName ?? this.displayName,
      hostPeerId: this.peerId,
      origin: 'local',
      status: 'active',
      timeLimitMinutes: input.timeLimitMinutes,
      sharedWithPeers: input.sharedWithPeers,
      createdAt: now,
      updatedAt: now,
      questions: input.questions
    }

    this.database.saveAssessment(assessment)
    this.database.addLedgerRecord({
      entityType: 'assessment',
      entityId: assessment.id,
      action: 'create',
      payload: {
        code: assessment.code,
        title: assessment.title,
        questions: assessment.questions.length
      }
    })

    if (assessment.sharedWithPeers) {
      const peers = this.listPeers().filter((peer) => peer.status === 'online')
      await Promise.allSettled(peers.map(async (peer) => {
        await this.postJson(peer, '/api/peer/assessment', { assessment })
      }))
    }

    return assessment
  }

  receivePeerAssessment(assessment: AssessmentRecord): void {
    const remoteAssessment: AssessmentRecord = {
      ...assessment,
      origin: 'remote',
      updatedAt: Date.now()
    }

    this.database.saveAssessment(remoteAssessment)
    this.database.addLedgerRecord({
      entityType: 'assessment',
      entityId: remoteAssessment.id,
      action: 'sync-in',
      payload: {
        code: remoteAssessment.code,
        hostPeerId: remoteAssessment.hostPeerId
      }
    })
  }

  listAssessments(): AssessmentRecord[] {
    return this.database.listAssessments()
  }

  listSubmissions(assessmentId: string): AssessmentSubmissionRecord[] {
    return this.database.listSubmissions(assessmentId)
  }

  async submitAssessment(input: {
    assessmentId: string
    participantName: string
    answers: Record<string, string>
  }): Promise<AssessmentSubmissionRecord> {
    const assessment = this.database.getAssessment(input.assessmentId)
    if (!assessment) {
      throw new Error('Assessment not found.')
    }

    const score = this.calculateScore(assessment.questions, input.answers)
    const submission: AssessmentSubmissionRecord = {
      id: `submission-${randomUUID()}`,
      assessmentId: assessment.id,
      participantName: input.participantName,
      answers: input.answers,
      score,
      submittedAt: Date.now(),
      status: assessment.origin === 'local' ? 'submitted' : 'synced'
    }

    this.database.saveSubmission(submission)
    this.database.addLedgerRecord({
      entityType: 'submission',
      entityId: submission.id,
      action: 'submit',
      payload: {
        assessmentId: submission.assessmentId,
        participantName: submission.participantName,
        score
      }
    })

    if (assessment.origin === 'remote') {
      const host = this.database.getPeer(assessment.hostPeerId)
      if (host) {
        await this.postJson(host, '/api/peer/assessment-submission', { submission })
      }
    }

    return submission
  }

  receiveSubmission(submission: AssessmentSubmissionRecord): void {
    this.database.saveSubmission(submission)
    this.database.addLedgerRecord({
      entityType: 'submission',
      entityId: submission.id,
      action: 'sync-in',
      payload: {
        assessmentId: submission.assessmentId,
        participantName: submission.participantName,
        score: submission.score
      }
    })
  }

  listLedger() {
    return this.database.listLedger()
  }

  private generateSessionCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase()
  }

  private calculateScore(questions: AssessmentQuestion[], answers: Record<string, string>): number {
    let earned = 0
    let total = 0

    for (const question of questions) {
      total += question.points
      const expected = question.correctAnswer?.trim().toLowerCase()
      const actual = answers[question.id]?.trim().toLowerCase()
      if (expected && actual && expected === actual) {
        earned += question.points
      }
    }

    if (total === 0) {
      return 0
    }

    return Math.round((earned / total) * 100)
  }
}
