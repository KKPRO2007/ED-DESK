import { app, BrowserWindow, ipcMain, shell, powerMonitor, screen, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { OfflineBackendService } from '../backend/service'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | null = null
let backendService: OfflineBackendService | null = null
let cpuUsageHistory: number[] = []
let lastCpuSnapshot = os.cpus().map((cpu) => ({ ...cpu.times }))
let previousProcessSnapshot = new Map<number, { cpuSeconds: number; sampledAt: number }>()
let batteryHistory: number[] = []
let windowsInfoCache: WindowsInfoRow | null = null

async function ensureBackendService(): Promise<OfflineBackendService> {
  if (backendService) return backendService
  const service = new OfflineBackendService()
  try {
    await service.start()
    backendService = service
    return service
  } catch (error) {
    console.error('Offline backend failed to start:', error)
    backendService = null
    throw error
  }
}

interface PowerShellProcessRow {
  Id: number
  ProcessName: string
  CPU: number | null
  WorkingSet64: number
  PriorityClass: number | string | null
  Threads: number
}

interface BatteryReading {
  EstimatedChargeRemaining?: number
  BatteryStatus?: number
  EstimatedRunTime?: number
  Name?: string
}

interface CounterSampleRow {
  Path?: string
  CookedValue?: number
}

interface NetworkSnapshot {
  rx: number
  tx: number
}

interface WindowsInfoRow {
  WindowsProductName?: string
  OsVersion?: string
}

interface WiFiInterfaceInfo {
  iface: string
  ip4: string
  mac: string
  operstate: string
  type: 'wireless'
  speed: number
  ssid?: string
  signal?: number
  channel?: number
  frequency?: number
}

async function runPowerShellJson<T>(command: string): Promise<T | null> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        (error, stdout) => {
          if (error) { reject(error); return }
          resolve(stdout)
        }
      )
    })
    const trimmed = output.trim()
    if (!trimmed || trimmed === 'null') return null
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

async function getWindowsInfo(): Promise<WindowsInfoRow> {
  if (windowsInfoCache) return windowsInfoCache
  windowsInfoCache =
    (await runPowerShellJson<WindowsInfoRow>(
      'Get-ComputerInfo | Select-Object WindowsProductName,OsVersion | ConvertTo-Json -Compress'
    )) ?? {}
  return windowsInfoCache
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1600, width),
    height: Math.min(900, height),
    backgroundColor: '#000000',
    show: false,
    frame: true,
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    },
    icon: join(__dirname, '../../resources/icon.png')
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('did-finish-load', () => mainWindow?.show())
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Renderer failed to load:', errorCode, errorDescription)
    mainWindow?.show()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details)
    mainWindow?.show()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function getRealCPUUsage(): number {
  const currentSnapshot = os.cpus().map((cpu) => ({ ...cpu.times }))
  let idleDiff = 0
  let totalDiff = 0
  currentSnapshot.forEach((times, index) => {
    const previous = lastCpuSnapshot[index]
    const currentTotal = times.user + times.nice + times.sys + times.idle + times.irq
    const previousTotal = previous.user + previous.nice + previous.sys + previous.idle + previous.irq
    idleDiff += times.idle - previous.idle
    totalDiff += currentTotal - previousTotal
  })
  lastCpuSnapshot = currentSnapshot
  const usage =
    totalDiff > 0
      ? Math.min(Math.max(Math.round((1 - idleDiff / totalDiff) * 1000) / 10, 0), 100)
      : 0
  cpuUsageHistory.push(usage)
  if (cpuUsageHistory.length > 60) cpuUsageHistory.shift()
  return usage
}

function getAllDisks() {
  const disks: Array<{
    fs: string
    size: number
    used: number
    available: number
    use: number
    mount: string
  }> = []
  try {
    if (process.platform === 'win32') {
      const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`)
      for (const drive of drives) {
        try {
          const stats = fs.statfsSync(drive)
          const total = stats.blocks * stats.bsize
          const free = stats.bfree * stats.bsize
          const used = total - free
          disks.push({
            fs: drive.replace('\\', ''),
            size: total,
            used,
            available: free,
            use: Math.round((used / total) * 100),
            mount: drive
          })
        } catch { /* Drive not available */ }
      }
    } else {
      const mounts = ['/', '/home', '/mnt', '/media']
      for (const mount of mounts) {
        try {
          const stats = fs.statfsSync(mount)
          const total = stats.blocks * stats.bsize
          const free = stats.bfree * stats.bsize
          const used = total - free
          disks.push({
            fs: mount,
            size: total,
            used,
            available: free,
            use: Math.round((used / total) * 100),
            mount
          })
        } catch { /* Mount not available */ }
      }
    }
  } catch (error) {
    console.error('Disk info error:', error)
  }
  return disks
}

async function getNetworkSpeed() {
  const rows = await runPowerShellJson<CounterSampleRow[] | CounterSampleRow>(
    "Get-Counter '\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec' | Select-Object -ExpandProperty CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Compress"
  )
  const samples = Array.isArray(rows) ? rows : rows ? [rows] : []
  return samples.reduce<NetworkSnapshot>(
    (acc, sample) => {
      const value = typeof sample.CookedValue === 'number' ? sample.CookedValue : 0
      const p = (sample.Path ?? '').toLowerCase()
      if (p.includes('bytes received/sec')) acc.rx += value
      if (p.includes('bytes sent/sec')) acc.tx += value
      return acc
    },
    { rx: 0, tx: 0 }
  )
}

async function getDetailedBatteryInfo() {
  const reading = await runPowerShellJson<BatteryReading | BatteryReading[]>(
    "$ErrorActionPreference='Stop'; $battery = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime,Name; if ($null -eq $battery) { 'null' } else { $battery | ConvertTo-Json -Compress }"
  )
  const battery = Array.isArray(reading) ? reading[0] : reading
  if (!battery || typeof battery.EstimatedChargeRemaining !== 'number') {
    return {
      hasBattery: false, percent: 0, discharging: false, timeRemaining: 0,
      timeToFull: 0, health: 'Unavailable', healthPercent: 0, cycles: 0,
      voltage: 0, temperature: 0, dischargeRate: 0, capacity: 0,
      designCapacity: 0, fullChargeCapacity: 0, history: []
    }
  }
  const percent = Math.max(0, Math.min(100, Math.round(battery.EstimatedChargeRemaining)))
  const batteryStatus = battery.BatteryStatus ?? 0
  const chargingStatuses = new Set([6, 7, 8, 9, 11])
  const discharging = powerMonitor.isOnBatteryPower() || (!chargingStatuses.has(batteryStatus) && percent < 100)
  const estimatedRunTimeMinutes = typeof battery.EstimatedRunTime === 'number' ? battery.EstimatedRunTime : 0
  const runtimeKnown = estimatedRunTimeMinutes > 0 && estimatedRunTimeMinutes < 1440
  batteryHistory.push(percent)
  if (batteryHistory.length > 60) batteryHistory.shift()
  const healthPercent = percent >= 80 ? 95 : percent >= 60 ? 85 : percent >= 40 ? 70 : 50
  const health = healthPercent >= 95 ? 'Good' : healthPercent >= 85 ? 'Fair' : healthPercent >= 70 ? 'Poor' : 'Critical'
  return {
    hasBattery: true, percent, discharging,
    timeRemaining: discharging && runtimeKnown ? estimatedRunTimeMinutes * 60 : 0,
    timeToFull: !discharging && percent < 100 && runtimeKnown ? estimatedRunTimeMinutes * 60 : 0,
    health, healthPercent, cycles: 0, voltage: 0, temperature: 0, dischargeRate: 0,
    capacity: percent, designCapacity: 100, fullChargeCapacity: percent,
    history: batteryHistory.slice(-20)
  }
}

function getWiFiInfo() {
  const interfaces = os.networkInterfaces()
  const wifiInterfaces: WiFiInterfaceInfo[] = []
  for (const [name, addrs] of Object.entries(interfaces)) {
    const isWireless = /wlan|wi-?fi|wireless|802\.11/i.test(name)
    if (!addrs || !isWireless) continue
    for (const addr of addrs) {
      if (!addr.internal && addr.family === 'IPv4') {
        wifiInterfaces.push({
          iface: name,
          ip4: addr.address,
          mac: addr.mac,
          operstate: 'up',
          type: 'wireless' as const,
          speed: 0
        })
      }
    }
  }
  return wifiInterfaces
}

function getBluetoothInfo() {
  return { available: false, enabled: false, devices: [] }
}

async function getProcessList(totalMem: number) {
  const rows = await runPowerShellJson<PowerShellProcessRow[] | PowerShellProcessRow>(
    "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,PriorityClass,@{Name='Threads';Expression={$_.Threads.Count}} | ConvertTo-Json -Compress"
  )
  const processes = Array.isArray(rows) ? rows : rows ? [rows] : []
  const sampledAt = Date.now()
  const cpuCount = Math.max(os.cpus().length, 1)
  const nextSnapshot = new Map<number, { cpuSeconds: number; sampledAt: number }>()

  const normalized = processes
    .filter((row) => typeof row.Id === 'number' && typeof row.ProcessName === 'string')
    .map((row) => {
      const cpuSeconds = typeof row.CPU === 'number' ? row.CPU : 0
      const previous = previousProcessSnapshot.get(row.Id)
      const elapsedSeconds = previous ? Math.max((sampledAt - previous.sampledAt) / 1000, 0.5) : 0
      const cpu = previous
        ? Math.max(0, Math.min(100, ((cpuSeconds - previous.cpuSeconds) / elapsedSeconds / cpuCount) * 100))
        : 0
      nextSnapshot.set(row.Id, { cpuSeconds, sampledAt })
      return {
        pid: row.Id,
        name: row.ProcessName,
        cpu: Number(cpu.toFixed(1)),
        mem: Number((((row.WorkingSet64 ?? 0) / totalMem) * 100).toFixed(2)),
        threads: row.Threads ?? 0,
        priority: row.PriorityClass == null ? 'Unknown' : String(row.PriorityClass)
      }
    })
    .sort((a, b) => (b.cpu !== a.cpu ? b.cpu - a.cpu : b.mem - a.mem))

  previousProcessSnapshot = nextSnapshot
  return normalized.slice(0, 12)
}

app.whenReady().then(async () => {
  createWindow()

  try {
    await ensureBackendService()
  } catch (error) {
    backendService = null
  }

  // ── System information handlers ────────────────────────────────────────────

  ipcMain.handle('get-full-system-info', async () => {
    try {
      const cpus = os.cpus()
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const cpuCurrent = getRealCPUUsage()
      const disks = getAllDisks()
      const uptime = os.uptime()
      const [windowsInfo, processes, batteryInfo] = await Promise.all([
        getWindowsInfo(),
        getProcessList(totalMem),
        getDetailedBatteryInfo()
      ])

      const networkInterfaces = os.networkInterfaces()
      const networks: unknown[] = []
      const wifiNetworks = getWiFiInfo()

      for (const [name, interfaces] of Object.entries(networkInterfaces)) {
        if (interfaces) {
          for (const net of interfaces) {
            if (!net.internal) {
              const wifi = wifiNetworks.find((w) => w.iface === name)
              networks.push({
                iface: name,
                ip4: net.family === 'IPv4' ? net.address : '',
                ip6: net.family === 'IPv6' ? net.address : '',
                mac: net.mac,
                operstate: 'up',
                type: wifi ? 'wireless' : 'wired',
                speed: wifi ? wifi.speed : 0,
                ssid: wifi?.ssid,
                signal: wifi?.signal,
                channel: wifi?.channel,
                frequency: wifi?.frequency
              })
            }
          }
        }
      }

      const bluetoothInfo = getBluetoothInfo()
      const loadAvg = os.loadavg()

      return {
        cpu: {
          manufacturer: cpus[0]?.model?.includes('Intel') ? 'Intel' : cpus[0]?.model?.includes('AMD') ? 'AMD' : 'Unknown',
          brand: cpus[0]?.model || 'Unknown CPU',
          speed: cpus[0]?.speed || 0,
          cores: cpus.length,
          physicalCores: cpus.length,
          usage: cpuCurrent,
          temperature: 0,
          load: loadAvg[0],
          cache: {}
        },
        memory: {
          total: totalMem, free: freeMem, used: usedMem, active: usedMem,
          available: freeMem, buffcache: 0, swaptotal: 0, swapused: 0,
          percent: Math.round((usedMem / totalMem) * 100)
        },
        disk: disks,
        os: {
          platform: process.platform,
          distro: windowsInfo.WindowsProductName || os.type(),
          release: windowsInfo.OsVersion || os.release(),
          kernel: os.version() || os.release(),
          arch: typeof os.machine === 'function' ? os.machine() : os.arch(),
          hostname: os.hostname(),
          uptime,
          build: os.release(),
          users: 1,
          loadavg: loadAvg
        },
        network: networks,
        bluetooth: bluetoothInfo,
        processes,
        battery: batteryInfo,
        node: {
          version: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }
      }
    } catch (error) {
      console.error('System info error:', error)
      return null
    }
  })

  ipcMain.handle('get-cpu-history', () => cpuUsageHistory)
  ipcMain.handle('get-network-speed', async () => await getNetworkSpeed())
  ipcMain.handle('get-power-info', async () => ({
    onBattery: powerMonitor.isOnBatteryPower(),
    level: (await getDetailedBatteryInfo()).percent,
    charging: !powerMonitor.isOnBatteryPower()
  }))
  ipcMain.handle('demo:ping', () => 'pong')
  ipcMain.handle('get-local-ip', () => {
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address
      }
    }
    return '127.0.0.1'
  })
  ipcMain.handle('get-battery-history', () => batteryHistory)
  ipcMain.handle('get-system-load', () => os.loadavg())
  ipcMain.handle('get-network-interfaces', () => os.networkInterfaces())

  // ── Offline backend handlers ───────────────────────────────────────────────

  ipcMain.handle('offline:get-status', async () => (await ensureBackendService()).getStatus())
  ipcMain.handle('offline:get-profile', async () => (await ensureBackendService()).getProfile())
  ipcMain.handle('offline:get-permissions', async () => (await ensureBackendService()).getPermissions())
  ipcMain.handle('offline:update-permissions', async (_event, payload) =>
    (await ensureBackendService()).updatePermissions(payload)
  )
  ipcMain.handle('offline:scan-peers', async () => (await ensureBackendService()).scanPeers())
  ipcMain.handle('offline:list-peers', async () => (await ensureBackendService()).listPeers())
  ipcMain.handle('offline:list-sessions', async () => (await ensureBackendService()).listAvailableSessions())
  ipcMain.handle('offline:get-hosted-session', async () => (await ensureBackendService()).getHostedSession())
  ipcMain.handle('offline:create-hosted-session', async (_event, payload) =>
    (await ensureBackendService()).createHostedSession(payload)
  )
  ipcMain.handle('offline:close-hosted-session', async () =>
    (await ensureBackendService()).closeHostedSession()
  )
  ipcMain.handle('offline:join-session', async (_event, code: string, password?: string) =>
    await (await ensureBackendService()).joinSessionByCode(code, password)
  )
  ipcMain.handle('offline:list-conversations', async () =>
    (await ensureBackendService()).listConversations()
  )
  ipcMain.handle('offline:delete-conversation', async (_event, conversationId: string) =>
    (await ensureBackendService()).deleteConversation(conversationId)
  )
  ipcMain.handle('offline:get-messages', async (_event, conversationId: string) =>
    (await ensureBackendService()).getMessages(conversationId)
  )
  ipcMain.handle('offline:get-session-messages', async (_event, sessionCode: string) =>
    (await ensureBackendService()).getSessionMessages(sessionCode)
  )
  ipcMain.handle(
    'offline:send-message',
    async (_event, peerId: string, content: string, sessionCode?: string, attachment?: {
      type: string; name: string; size: number; mime: string; data: string
    }, options?: {
      persistLocal?: boolean
      sessionMessageId?: string
      senderPeerId?: string
      senderName?: string
    }) =>
      await (await ensureBackendService()).sendLanMessage(peerId, content, sessionCode, attachment as never, options)
  )
  ipcMain.handle('offline:get-attachment', async (_event, attachmentId: string) =>
    (await ensureBackendService()).getAttachment(attachmentId)
  )

  // Save attachment to disk using native save dialog
  ipcMain.handle(
    'offline:save-attachment-to-disk',
    async (_event, attachmentId: string, suggestedName: string) => {
      const service = await ensureBackendService()
      const attachment = service.getAttachment(attachmentId)
      if (!attachment) throw new Error('Attachment not found')

      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: path.join(os.homedir(), 'Downloads', suggestedName),
        filters: getFileFilters(attachment.mime, suggestedName)
      })

      if (result.canceled || !result.filePath) return { canceled: true }

      // Decode base64 and write to disk
      const base64Data = attachment.data.includes(',')
        ? attachment.data.split(',')[1]
        : attachment.data
      fs.writeFileSync(result.filePath, Buffer.from(base64Data, 'base64'))
      service.updateAttachmentSavedPath(attachmentId, result.filePath)
      return { canceled: false, filePath: result.filePath }
    }
  )

  ipcMain.handle('offline:remove-participant', async (_event, peerId: string) =>
    (await ensureBackendService()).removeParticipant(peerId)
  )
  ipcMain.handle('offline:list-assessments', async () => (await ensureBackendService()).listAssessments())
  ipcMain.handle('offline:get-assessment', async (_event, assessmentId: string) =>
    (await ensureBackendService()).getAssessment(assessmentId)
  )
  ipcMain.handle('offline:create-assessment', async (_event, payload) =>
    await (await ensureBackendService()).createAssessment(payload)
  )
  ipcMain.handle('offline:submit-assessment', async (_event, payload) =>
    await (await ensureBackendService()).submitAssessment(payload)
  )
  ipcMain.handle('offline:list-submissions', async (_event, assessmentId: string) =>
    (await ensureBackendService()).listSubmissions(assessmentId)
  )
  ipcMain.handle('offline:list-ledger', async () => (await ensureBackendService()).listLedger())
})

function getFileFilters(mime: string, filename: string): Electron.FileFilter[] {
  const ext = path.extname(filename).toLowerCase()
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    return [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, { name: 'All Files', extensions: ['*'] }]
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    return [{ name: 'PDF Documents', extensions: ['pdf'] }, { name: 'All Files', extensions: ['*'] }]
  }
  if (['.doc', '.docx'].includes(ext) || mime.includes('word')) {
    return [{ name: 'Word Documents', extensions: ['doc', 'docx'] }, { name: 'All Files', extensions: ['*'] }]
  }
  if (['.ppt', '.pptx'].includes(ext) || mime.includes('presentation')) {
    return [{ name: 'Presentations', extensions: ['ppt', 'pptx'] }, { name: 'All Files', extensions: ['*'] }]
  }
  return [{ name: 'All Files', extensions: ['*'] }]
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await backendService?.stop()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
