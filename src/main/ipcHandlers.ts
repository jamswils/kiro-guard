import { ipcMain } from 'electron'
import { getConfig } from './configStore'
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

  // getConfig / setLockConfig handlers deliberately NOT registered.
  //
  // setLockConfig accepted any object from any renderer (validated only as
  // `typeof === 'object'`, then cast through `as any`) and persisted it, so a
  // renderer could turn requireAuth off and unlock without a password, or
  // write a garbage hotkey that silently killed the lock accelerator on the
  // next launch. getConfig handed back the whole AppConfig including absolute
  // filesystem paths. Neither was called by any renderer. Settings are owned
  // by the tray menu, which calls setLockConfig() in-process — validation is
  // therefore not the fix here; not having the channel is.
}
