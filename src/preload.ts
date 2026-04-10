import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  getFullSystemInfo: () => ipcRenderer.invoke('get-full-system-info'),
  getCPUHistory: () => ipcRenderer.invoke('get-cpu-history'),
  getNetworkSpeed: () => ipcRenderer.invoke('get-network-speed'),
  getPowerInfo: () => ipcRenderer.invoke('get-power-info'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  getBatteryHistory: () => ipcRenderer.invoke('get-battery-history'),
  getSystemLoad: () => ipcRenderer.invoke('get-system-load'),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  demo: {
    ping: () => ipcRenderer.invoke('demo:ping')
  },
  offline: {
    getStatus: () => ipcRenderer.invoke('offline:get-status'),
    getProfile: () => ipcRenderer.invoke('offline:get-profile'),
    getPermissions: () => ipcRenderer.invoke('offline:get-permissions'),
    updatePermissions: (payload: unknown) =>
      ipcRenderer.invoke('offline:update-permissions', payload),
    scanPeers: () => ipcRenderer.invoke('offline:scan-peers'),
    listPeers: () => ipcRenderer.invoke('offline:list-peers'),
    listSessions: () => ipcRenderer.invoke('offline:list-sessions'),
    getHostedSession: () => ipcRenderer.invoke('offline:get-hosted-session'),
    createHostedSession: (payload: unknown) =>
      ipcRenderer.invoke('offline:create-hosted-session', payload),
    closeHostedSession: () => ipcRenderer.invoke('offline:close-hosted-session'),
    joinSessionByCode: (code: string, password?: string) =>
      ipcRenderer.invoke('offline:join-session', code, password),
    listConversations: () => ipcRenderer.invoke('offline:list-conversations'),
    deleteConversation: (conversationId: string) =>
      ipcRenderer.invoke('offline:delete-conversation', conversationId),
    getMessages: (conversationId: string) =>
      ipcRenderer.invoke('offline:get-messages', conversationId),
    sendMessage: (
      peerId: string,
      content: string,
      sessionCode?: string,
      attachment?: {
        type: string
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
    ) => ipcRenderer.invoke('offline:send-message', peerId, content, sessionCode, attachment, options),
    getAttachment: (attachmentId: string) =>
      ipcRenderer.invoke('offline:get-attachment', attachmentId),
    getSessionMessages: (sessionCode: string) =>
      ipcRenderer.invoke('offline:get-session-messages', sessionCode),
    saveAttachmentToDisk: (attachmentId: string, suggestedName: string) =>
      ipcRenderer.invoke('offline:save-attachment-to-disk', attachmentId, suggestedName),
    removeParticipant: (peerId: string) =>
      ipcRenderer.invoke('offline:remove-participant', peerId),
    listAssessments: () => ipcRenderer.invoke('offline:list-assessments'),
    getAssessment: (assessmentId: string) =>
      ipcRenderer.invoke('offline:get-assessment', assessmentId),
    createAssessment: (payload: unknown) =>
      ipcRenderer.invoke('offline:create-assessment', payload),
    submitAssessment: (payload: unknown) =>
      ipcRenderer.invoke('offline:submit-assessment', payload),
    listSubmissions: (assessmentId: string) =>
      ipcRenderer.invoke('offline:list-submissions', assessmentId),
    listLedger: () => ipcRenderer.invoke('offline:list-ledger')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type IElectronAPI = typeof electronAPI

// Augment the Window interface so TypeScript knows about electronAPI
declare global {
  interface Window {
    electronAPI: IElectronAPI
  }
}
