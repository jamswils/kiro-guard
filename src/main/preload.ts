import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, isMoveWindowPayload, type MoveWindowPayload } from '../shared/ipc'
import type { StatusPayload, LockConfig } from '../shared/types'
import { validateStatusPayload } from '../shared/validation'

type StatusUpdateHandler = (payload: StatusPayload) => void
type LockStateHandler = (state: string, lockedAt?: number) => void

contextBridge.exposeInMainWorld('kiroBuddy', {
  onStatusUpdate(handler: StatusUpdateHandler): () => void {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!validateStatusPayload(payload)) return
      handler(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.statusUpdate, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.statusUpdate, listener)
  },

  moveWindow(position: MoveWindowPayload): void {
    if (!isMoveWindowPayload(position)) return
    ipcRenderer.send(IPC_CHANNELS.moveWindow, position)
  },

  lock(): void {
    ipcRenderer.send(IPC_CHANNELS.lockRequest)
  },

  unlock(): void {
    ipcRenderer.send(IPC_CHANNELS.unlockRequest)
  },

  toggleLock(): void {
    ipcRenderer.send(IPC_CHANNELS.toggleLock)
  },

  onLockState(handler: LockStateHandler): () => void {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event: Electron.IpcRendererEvent, state: string, lockedAt?: number) => {
      handler(state, lockedAt)
    }
    ipcRenderer.on(IPC_CHANNELS.lockStateUpdate, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.lockStateUpdate, listener)
  },

  getLockState(): Promise<{ state: string; lockedAt?: number }> {
    return ipcRenderer.invoke(IPC_CHANNELS.getLockState)
  },

  getConfig(): Promise<any> {
    return ipcRenderer.invoke(IPC_CHANNELS.getConfig)
  },

  setLockConfig(config: Partial<LockConfig>): void {
    ipcRenderer.send(IPC_CHANNELS.setLockConfig, config)
  },
})

// Lock screen preload extras — events from main to lock window
contextBridge.exposeInMainWorld('kiroLock', {
  onInit(handler: (data: { message: string; showElapsed: boolean; lockedAt: number; status?: string }) => void): void {
    ipcRenderer.on('lock-init', (_e, data) => handler(data))
  },
  onStatus(handler: (payload: { status: string; message?: string }) => void): void {
    ipcRenderer.on('lock-status', (_e, payload) => handler(payload))
  },
  onElapsed(handler: (now: number) => void): void {
    ipcRenderer.on('lock-elapsed', (_e, now) => handler(now))
  },
  onAuthStart(handler: () => void): void {
    ipcRenderer.on('auth-start', () => handler())
  },
  onAuthError(handler: (msg: string) => void): void {
    ipcRenderer.on('auth-error', (_e, msg) => handler(msg))
  },
  onUnlockSuccess(handler: () => void): void {
    ipcRenderer.on('unlock-success', () => handler())
  },
  requestUnlock(): void {
    ipcRenderer.send(IPC_CHANNELS.unlockRequest)
  },
})
