import { ipcMain } from 'electron'
import { getConfig, setLockConfig } from './configStore'
import { IPC_CHANNELS } from '../shared/ipc'
import {
  lock,
  unlock,
  quickUnlock,
  getCurrentLockState,
  getLockedAt,
} from './lockController'

export function registerIpcHandlers(): void {
  // Lock / unlock requests from any window (lock overlay button etc.)
  ipcMain.on(IPC_CHANNELS.lockRequest, async () => {
    const config = getConfig()
    await lock(config.lock)
  })

  ipcMain.on(IPC_CHANNELS.unlockRequest, async () => {
    const config = getConfig()
    if (config.lock.requireAuth) {
      await unlock(config.lock)
    } else {
      quickUnlock()
    }
  })

  ipcMain.on(IPC_CHANNELS.toggleLock, async () => {
    const config = getConfig()
    const state = getCurrentLockState()
    if (state === 'unlocked') {
      await lock(config.lock)
    } else if (state === 'locked') {
      if (config.lock.requireAuth) {
        await unlock(config.lock)
      } else {
        quickUnlock()
      }
    }
  })

  // Read lock state
  ipcMain.handle(IPC_CHANNELS.getLockState, () => ({
    state: getCurrentLockState(),
    lockedAt: getLockedAt(),
  }))

  ipcMain.handle(IPC_CHANNELS.getConfig, () => getConfig())

  // Update lock config from settings UI
  ipcMain.on(IPC_CHANNELS.setLockConfig, (_event, config: unknown) => {
    if (config && typeof config === 'object') {
      setLockConfig(config as any)
    }
  })
}
