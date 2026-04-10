import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs from 'sql.js'
import type {
  AssessmentRecord,
  AssessmentSubmissionRecord,
  AttachmentRecord,
  ChatMessageRecord,
  ConversationRecord,
  DevicePermissions,
  LedgerRecord,
  PeerRecord,
  SessionRecord
} from './types'

type AddMessageInput = Omit<ChatMessageRecord, 'hash' | 'previousHash'>
type AddLedgerInput = Omit<LedgerRecord, 'id' | 'hash' | 'previousHash' | 'createdAt'>

interface PersistedState {
  peers: PeerRecord[]
  conversations: ConversationRecord[]
  messages: Record<string, ChatMessageRecord[]>
  assessments: AssessmentRecord[]
  submissions: Record<string, AssessmentSubmissionRecord[]>
  ledger: LedgerRecord[]
  permissions: DevicePermissions
  hostedSession: SessionRecord | null
}

const defaultState = (): PersistedState => ({
  peers: [],
  conversations: [],
  messages: {},
  assessments: [],
  submissions: {},
  ledger: [],
  permissions: {
    nearbyScan: 'prompt',
    localNetwork: 'granted'
  },
  hostedSession: null
})

const require = createRequire(import.meta.url)
const SQL_JS_WASM_PATH = require.resolve('sql.js/dist/sql-wasm.wasm')

export class BackendDatabase {
  private readonly dbPath: string
  private readonly legacyJsonPath: string
  private readonly peers = new Map<string, PeerRecord>()
  private readonly conversations = new Map<string, ConversationRecord>()
  private readonly messages = new Map<string, ChatMessageRecord[]>()
  private readonly assessments = new Map<string, AssessmentRecord>()
  private readonly submissions = new Map<string, AssessmentSubmissionRecord[]>()
  private readonly attachments = new Map<string, AttachmentRecord>()
  private readonly ledger: LedgerRecord[] = []
  private permissions: DevicePermissions = defaultState().permissions
  private hostedSession: SessionRecord | null = null
  private sqlite: import('sql.js').Database | null = null
  // Track max ledger sequence to avoid ID collisions after reload
  private ledgerSeq = 0

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.legacyJsonPath = dbPath.replace(/\.sqlite$/i, '.json')
  }

  async init(): Promise<void> {
    fs.mkdirSync(dirname(this.dbPath), { recursive: true })

    const SQL = await initSqlJs({
      locateFile: (file) =>
        file.endsWith('.wasm') ? SQL_JS_WASM_PATH : join(dirname(SQL_JS_WASM_PATH), file)
    })

    const fileBuffer = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : null
    this.sqlite =
      fileBuffer && fileBuffer.length > 0
        ? new SQL.Database(fileBuffer)
        : new SQL.Database()

    this.createSchema()

    if (this.hasExistingRows()) {
      this.loadFromSqlite()
      return
    }

    const migrated = this.migrateLegacyJson()
    if (!migrated) {
      this.persist()
    }
  }

  // ── Peers ──────────────────────────────────────────────────────────────────

  listPeers(): PeerRecord[] {
    return [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  upsertPeer(peer: PeerRecord): void {
    const existing = this.peers.get(peer.id)
    const peerChanged = !existing || JSON.stringify(existing) !== JSON.stringify(peer)
    this.peers.set(peer.id, peer)

    let conversationChanged = false
    for (const [conversationId, conversation] of this.conversations.entries()) {
      if (
        conversation.peerId !== peer.id ||
        conversation.peerName === peer.displayName
      )
        continue
      this.conversations.set(conversationId, {
        ...conversation,
        peerName: peer.displayName
      })
      conversationChanged = true
    }

    if (peerChanged || conversationChanged) {
      this.persist()
    }
  }

  getPeer(peerId: string): PeerRecord | undefined {
    return this.peers.get(peerId)
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  ensureConversation(
    peerId: string,
    peerName: string,
    sessionCode?: string | null
  ): ConversationRecord {
    const normalizedSessionCode = sessionCode?.trim().toUpperCase() || null
    const existing = [...this.conversations.values()].find(
      (item) =>
        item.peerId === peerId &&
        (item.sessionCode ?? null) === normalizedSessionCode
    )
    if (existing) {
      if (existing.peerName !== peerName) {
        const updated = { ...existing, peerName }
        this.conversations.set(existing.id, updated)
        this.persist()
        return updated
      }
      return existing
    }

    const conversation: ConversationRecord = {
      id: normalizedSessionCode
        ? `conversation-${peerId}-${normalizedSessionCode}`
        : `conversation-${peerId}`,
      peerId,
      peerName,
      sessionCode: normalizedSessionCode,
      lastMessage: '',
      updatedAt: Date.now(),
      unreadCount: 0
    }
    this.conversations.set(conversation.id, conversation)
    this.persist()
    return conversation
  }

  listConversations(): ConversationRecord[] {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  deleteConversation(conversationId: string): void {
    let changed = false
    if (this.conversations.delete(conversationId)) changed = true
    if (this.messages.delete(conversationId)) changed = true
    // Also remove attachments for this conversation
    for (const [id, att] of this.attachments.entries()) {
      if (att.conversationId === conversationId) {
        this.attachments.delete(id)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  markConversationRead(conversationId: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return
    if (conversation.unreadCount === 0) return
    this.conversations.set(conversationId, { ...conversation, unreadCount: 0 })
    this.persist()
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  listMessages(conversationId: string): ChatMessageRecord[] {
    return [...(this.messages.get(conversationId) ?? [])]
  }

  findMessageBySessionMessageId(
    conversationId: string,
    sessionMessageId: string
  ): ChatMessageRecord | undefined {
    return (this.messages.get(conversationId) ?? []).find(
      (message) => message.sessionMessageId === sessionMessageId
    )
  }

  addMessage(input: AddMessageInput): ChatMessageRecord {
    const previousHash = this.lastMessageHash(input.conversationId)
    const hash = this.hashValue({ ...input, previousHash })
    const message: ChatMessageRecord = { ...input, hash, previousHash }
    const bucket = this.messages.get(input.conversationId) ?? []
    bucket.push(message)
    this.messages.set(input.conversationId, bucket)

    const conversation = this.conversations.get(input.conversationId)
    if (conversation) {
      this.conversations.set(input.conversationId, {
        ...conversation,
        lastMessage: input.attachmentName
          ? `[${input.attachmentType?.toUpperCase() ?? 'FILE'}] ${input.attachmentName}`
          : input.content,
        updatedAt: input.createdAt,
        unreadCount:
          input.direction === 'incoming'
            ? conversation.unreadCount + 1
            : conversation.unreadCount
      })
    }

    this.persist()
    return message
  }

  updateMessageStatus(
    messageId: string,
    status: ChatMessageRecord['status'],
    deliveredAt?: number
  ): void {
    for (const [conversationId, bucket] of this.messages.entries()) {
      const index = bucket.findIndex((item) => item.id === messageId)
      if (index === -1) continue
      bucket[index] = { ...bucket[index], status, deliveredAt }
      this.messages.set(conversationId, bucket)
      this.persist()
      return
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  saveAttachment(attachment: AttachmentRecord): void {
    this.attachments.set(attachment.id, attachment)
    this.persist()
  }

  getAttachment(attachmentId: string): AttachmentRecord | undefined {
    return this.attachments.get(attachmentId)
  }

  getAttachmentsForConversation(conversationId: string): AttachmentRecord[] {
    return [...this.attachments.values()].filter(
      (a) => a.conversationId === conversationId
    )
  }

  updateAttachmentSavedPath(attachmentId: string, savedPath: string): void {
    const att = this.attachments.get(attachmentId)
    if (!att) return
    this.attachments.set(attachmentId, { ...att, savedPath })
    this.persist()
  }

  // ── Assessments ────────────────────────────────────────────────────────────

  saveAssessment(assessment: AssessmentRecord): void {
    this.assessments.set(assessment.id, assessment)
    this.persist()
  }

  listAssessments(): AssessmentRecord[] {
    return [...this.assessments.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getAssessment(assessmentId: string): AssessmentRecord | undefined {
    return this.assessments.get(assessmentId)
  }

  // ── Submissions ────────────────────────────────────────────────────────────

  saveSubmission(submission: AssessmentSubmissionRecord): void {
    // Deduplicate: don't add the same submission twice
    const bucket = this.submissions.get(submission.assessmentId) ?? []
    const existing = bucket.findIndex((s) => s.id === submission.id)
    if (existing !== -1) {
      bucket[existing] = submission
    } else {
      bucket.push(submission)
    }
    this.submissions.set(submission.assessmentId, bucket)
    this.persist()
  }

  listSubmissions(assessmentId: string): AssessmentSubmissionRecord[] {
    return [...(this.submissions.get(assessmentId) ?? [])].sort(
      (a, b) => b.submittedAt - a.submittedAt
    )
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────

  addLedgerRecord(input: AddLedgerInput): LedgerRecord {
    const previousHash = this.lastLedgerHash()
    const createdAt = Date.now()
    const hash = this.hashValue({ ...input, previousHash, createdAt })
    // Use UUID to avoid ID collision after reloads
    this.ledgerSeq += 1
    const record: LedgerRecord = {
      id: `ledger-${this.ledgerSeq}-${randomUUID().slice(0, 8)}`,
      createdAt,
      previousHash,
      hash,
      ...input
    }
    this.ledger.unshift(record)
    this.persist()
    return record
  }

  listLedger(): LedgerRecord[] {
    return [...this.ledger]
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  getPermissions(): DevicePermissions {
    return this.permissions
  }

  getOrCreateDeviceId(): string {
    const existing = this.readSetting<string>('deviceId')
    if (existing?.trim()) return existing
    const created = `peer-${randomUUID()}`
    this.writeSetting('deviceId', created)
    return created
  }

  updatePermissions(partial: Partial<DevicePermissions>): DevicePermissions {
    const nextPermissions = { ...this.permissions, ...partial }
    if (JSON.stringify(nextPermissions) === JSON.stringify(this.permissions)) {
      return this.permissions
    }
    this.permissions = nextPermissions
    this.persist()
    return this.permissions
  }

  // ── Hosted session ─────────────────────────────────────────────────────────

  getHostedSession(): SessionRecord | null {
    return this.hostedSession
  }

  saveHostedSession(session: SessionRecord | null): void {
    if (JSON.stringify(this.hostedSession) === JSON.stringify(session)) return
    this.hostedSession = session
    this.persist()
  }

  // ── Schema ─────────────────────────────────────────────────────────────────

  private createSchema(): void {
    const db = this.db()

    // Rebuild tables if columns changed
    this.rebuildTableIfNeeded('peers', ['id', 'data'])
    this.rebuildTableIfNeeded('conversations', ['id', 'peer_id', 'session_code', 'updated_at', 'data'])
    this.rebuildTableIfNeeded('messages', ['id', 'conversation_id', 'created_at', 'data'])
    this.rebuildTableIfNeeded('assessments', ['id', 'updated_at', 'data'])
    this.rebuildTableIfNeeded('submissions', ['id', 'assessment_id', 'submitted_at', 'data'])
    this.rebuildTableIfNeeded('attachments', ['id', 'conversation_id', 'created_at', 'data'])
    this.rebuildTableIfNeeded('ledger', ['id', 'created_at', 'data'])
    this.rebuildTableIfNeeded('settings', ['key', 'data'])

    db.run(`CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL DEFAULT '', session_code TEXT, updated_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS assessments (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL DEFAULT '', submitted_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}')`)
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')`)

    this.ensureColumn('peers', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('conversations', 'peer_id', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('conversations', 'session_code', 'TEXT')
    this.ensureColumn('conversations', 'updated_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('conversations', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('messages', 'conversation_id', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('messages', 'created_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('messages', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('assessments', 'updated_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('assessments', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('submissions', 'assessment_id', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('submissions', 'submitted_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('submissions', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('attachments', 'conversation_id', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('attachments', 'created_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('attachments', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('ledger', 'created_at', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('ledger', 'data', `TEXT NOT NULL DEFAULT '{}'`)
    this.ensureColumn('settings', 'data', `TEXT NOT NULL DEFAULT '{}'`)

    db.run('CREATE INDEX IF NOT EXISTS idx_conversations_peer ON conversations(peer_id, session_code)')
    db.run('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)')
    db.run('CREATE INDEX IF NOT EXISTS idx_submissions_assessment ON submissions(assessment_id, submitted_at)')
    db.run('CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id, created_at)')
    db.run('CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at)')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (this.hasColumn(table, column)) return
    this.db().run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private rebuildTableIfNeeded(table: string, expectedColumns: string[]): void {
    if (!this.tableExists(table)) return
    const actualColumns = this.getColumnNames(table)
    const matches =
      actualColumns.length === expectedColumns.length &&
      expectedColumns.every((col, i) => actualColumns[i] === col)
    if (matches) return
    this.db().run(`DROP TABLE IF EXISTS ${table}`)
  }

  private tableExists(table: string): boolean {
    const statement = this.db().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    statement.bind([table])
    const exists = statement.step()
    statement.free()
    return exists
  }

  private getColumnNames(table: string): string[] {
    const statement = this.db().prepare(`PRAGMA table_info(${table})`)
    const columns: string[] = []
    while (statement.step()) {
      const row = statement.getAsObject() as { name?: string }
      if (typeof row.name === 'string') columns.push(row.name)
    }
    statement.free()
    return columns
  }

  private hasColumn(table: string, column: string): boolean {
    return this.getColumnNames(table).includes(column)
  }

  private hasExistingRows(): boolean {
    return (
      this.countRows('peers') > 0 ||
      this.countRows('conversations') > 0 ||
      this.countRows('messages') > 0 ||
      this.countRows('assessments') > 0 ||
      this.countRows('submissions') > 0 ||
      this.countRows('ledger') > 0 ||
      this.countRows('settings') > 0
    )
  }

  private countRows(table: string): number {
    const rows = this.db().exec(`SELECT COUNT(*) AS count FROM ${table}`)
    const value = rows[0]?.values?.[0]?.[0]
    return typeof value === 'number' ? value : Number(value ?? 0)
  }

  private loadFromSqlite(): void {
    this.peers.clear()
    this.conversations.clear()
    this.messages.clear()
    this.assessments.clear()
    this.submissions.clear()
    this.attachments.clear()
    this.ledger.length = 0
    this.permissions = defaultState().permissions
    this.hostedSession = null
    this.ledgerSeq = 0

    for (const peer of this.readJsonRows<PeerRecord>('SELECT data FROM peers')) {
      this.peers.set(peer.id, peer)
    }

    for (const conversation of this.readJsonRows<ConversationRecord>(
      'SELECT data FROM conversations ORDER BY updated_at DESC'
    )) {
      this.conversations.set(conversation.id, conversation)
    }

    for (const message of this.readJsonRows<ChatMessageRecord>(
      'SELECT data FROM messages ORDER BY created_at ASC'
    )) {
      const bucket = this.messages.get(message.conversationId) ?? []
      bucket.push(message)
      this.messages.set(message.conversationId, bucket)
    }

    for (const assessment of this.readJsonRows<AssessmentRecord>(
      'SELECT data FROM assessments ORDER BY updated_at DESC'
    )) {
      this.assessments.set(assessment.id, assessment)
    }

    for (const submission of this.readJsonRows<AssessmentSubmissionRecord>(
      'SELECT data FROM submissions ORDER BY submitted_at DESC'
    )) {
      const bucket = this.submissions.get(submission.assessmentId) ?? []
      bucket.push(submission)
      this.submissions.set(submission.assessmentId, bucket)
    }

    for (const attachment of this.readJsonRows<AttachmentRecord>(
      'SELECT data FROM attachments ORDER BY created_at ASC'
    )) {
      this.attachments.set(attachment.id, attachment)
    }

    const ledgerRows = this.readJsonRows<LedgerRecord>(
      'SELECT data FROM ledger ORDER BY created_at DESC'
    )
    this.ledger.push(...ledgerRows)
    // Set ledgerSeq to max existing sequence number
    for (const row of ledgerRows) {
      const parts = row.id.split('-')
      const seq = parseInt(parts[1] ?? '0', 10)
      if (seq > this.ledgerSeq) this.ledgerSeq = seq
    }

    this.permissions =
      this.readSetting<DevicePermissions>('permissions') ?? defaultState().permissions
    this.hostedSession = this.readSetting<SessionRecord>('hostedSession') ?? null
  }

  private migrateLegacyJson(): boolean {
    if (!fs.existsSync(this.legacyJsonPath)) return false
    const raw = fs.readFileSync(this.legacyJsonPath, 'utf8').trim()
    if (!raw) return false

    const parsed = { ...defaultState(), ...JSON.parse(raw) } as PersistedState
    for (const peer of parsed.peers) this.peers.set(peer.id, peer)
    for (const conversation of parsed.conversations)
      this.conversations.set(conversation.id, conversation)
    for (const [conversationId, bucket] of Object.entries(parsed.messages))
      this.messages.set(conversationId, bucket)
    for (const assessment of parsed.assessments)
      this.assessments.set(assessment.id, assessment)
    for (const [assessmentId, bucket] of Object.entries(parsed.submissions))
      this.submissions.set(assessmentId, bucket)
    this.ledger.push(...(parsed.ledger ?? []))
    this.ledgerSeq = this.ledger.length
    this.permissions = parsed.permissions ?? defaultState().permissions
    this.hostedSession = parsed.hostedSession ?? null
    this.persist()
    return true
  }

  private readJsonRows<T>(sql: string): T[] {
    const statement = this.db().prepare(sql)
    const rows: T[] = []
    while (statement.step()) {
      const row = statement.getAsObject() as { data?: string }
      if (typeof row.data === 'string') {
        try {
          rows.push(JSON.parse(row.data) as T)
        } catch {
          // Skip corrupt rows
        }
      }
    }
    statement.free()
    return rows
  }

  private readSetting<T>(key: string): T | null {
    const statement = this.db().prepare('SELECT data FROM settings WHERE key = ?')
    statement.bind([key])
    const exists = statement.step()
    const row = exists ? (statement.getAsObject() as { data?: string }) : null
    statement.free()
    if (!row || typeof row.data !== 'string') return null
    try {
      return JSON.parse(row.data) as T
    } catch {
      return null
    }
  }

  private writeSetting(key: string, value: unknown): void {
    this.db().run(
      'INSERT OR REPLACE INTO settings (key, data) VALUES (?, ?)',
      [key, JSON.stringify(value)]
    )
    fs.writeFileSync(this.dbPath, Buffer.from(this.db().export()))
  }

  private persist(): void {
    const db = this.db()
    db.run('BEGIN TRANSACTION')
    try {
      this.replaceTable(
        'peers',
        [...this.peers.values()].map((peer) => ({
          id: peer.id,
          data: JSON.stringify(peer)
        }))
      )

      this.replaceTable(
        'conversations',
        [...this.conversations.values()].map((conversation) => ({
          id: conversation.id,
          sortValue: conversation.updatedAt,
          extra1: conversation.peerId,
          extra2: conversation.sessionCode,
          data: JSON.stringify(conversation)
        }))
      )

      this.replaceTable(
        'messages',
        [...this.messages.values()]
          .flat()
          .map((message) => ({
            id: message.id,
            sortValue: message.createdAt,
            extra1: message.conversationId,
            data: JSON.stringify(message)
          }))
      )

      this.replaceTable(
        'assessments',
        [...this.assessments.values()].map((assessment) => ({
          id: assessment.id,
          sortValue: assessment.updatedAt,
          data: JSON.stringify(assessment)
        }))
      )

      this.replaceTable(
        'submissions',
        [...this.submissions.values()]
          .flat()
          .map((submission) => ({
            id: submission.id,
            sortValue: submission.submittedAt,
            extra1: submission.assessmentId,
            data: JSON.stringify(submission)
          }))
      )

      this.replaceTable(
        'attachments',
        [...this.attachments.values()].map((att) => ({
          id: att.id,
          sortValue: att.createdAt,
          extra1: att.conversationId,
          data: JSON.stringify(att)
        }))
      )

      this.replaceTable(
        'ledger',
        this.ledger.map((record) => ({
          id: record.id,
          sortValue: record.createdAt,
          data: JSON.stringify(record)
        }))
      )

      db.run('DELETE FROM settings')
      db.run('INSERT INTO settings (key, data) VALUES (?, ?)', [
        'permissions',
        JSON.stringify(this.permissions)
      ])
      db.run('INSERT INTO settings (key, data) VALUES (?, ?)', [
        'hostedSession',
        JSON.stringify(this.hostedSession)
      ])
      db.run('COMMIT')
    } catch (error) {
      db.run('ROLLBACK')
      throw error
    }

    fs.writeFileSync(this.dbPath, Buffer.from(db.export()))
  }

  private replaceTable(
    table:
      | 'peers'
      | 'conversations'
      | 'messages'
      | 'assessments'
      | 'submissions'
      | 'attachments'
      | 'ledger',
    rows: Array<{
      id: string
      sortValue?: number | null
      extra1?: string | null
      extra2?: string | null
      data: string
    }>
  ): void {
    const db = this.db()
    db.run(`DELETE FROM ${table}`)

    const sqlMap: Record<string, string> = {
      peers: 'INSERT INTO peers (id, data) VALUES (?, ?)',
      conversations:
        'INSERT INTO conversations (id, peer_id, session_code, updated_at, data) VALUES (?, ?, ?, ?, ?)',
      messages:
        'INSERT INTO messages (id, conversation_id, created_at, data) VALUES (?, ?, ?, ?)',
      assessments: 'INSERT INTO assessments (id, updated_at, data) VALUES (?, ?, ?)',
      submissions:
        'INSERT INTO submissions (id, assessment_id, submitted_at, data) VALUES (?, ?, ?, ?)',
      attachments:
        'INSERT INTO attachments (id, conversation_id, created_at, data) VALUES (?, ?, ?, ?)',
      ledger: 'INSERT INTO ledger (id, created_at, data) VALUES (?, ?, ?)'
    }

    const sql = sqlMap[table]
    if (!sql) throw new Error(`Unknown table: ${table}`)

    const statement = db.prepare(sql)
    for (const row of rows) {
      switch (table) {
        case 'peers':
          statement.run([row.id, row.data])
          break
        case 'conversations':
          statement.run([row.id, row.extra1 ?? '', row.extra2 ?? null, row.sortValue ?? 0, row.data])
          break
        case 'messages':
          statement.run([row.id, row.extra1 ?? '', row.sortValue ?? 0, row.data])
          break
        case 'assessments':
          statement.run([row.id, row.sortValue ?? 0, row.data])
          break
        case 'submissions':
          statement.run([row.id, row.extra1 ?? '', row.sortValue ?? 0, row.data])
          break
        case 'attachments':
          statement.run([row.id, row.extra1 ?? '', row.sortValue ?? 0, row.data])
          break
        case 'ledger':
          statement.run([row.id, row.sortValue ?? 0, row.data])
          break
      }
    }
    statement.free()
  }

  private db(): import('sql.js').Database {
    if (!this.sqlite) throw new Error('Database not initialized')
    return this.sqlite
  }

  private lastLedgerHash(): string {
    return this.ledger[0]?.hash ?? 'GENESIS'
  }

  // Per-conversation message hash chain (not ledger)
  private lastMessageHash(conversationId: string): string {
    const bucket = this.messages.get(conversationId) ?? []
    return bucket[bucket.length - 1]?.hash ?? 'GENESIS'
  }

  private hashValue(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }
}
