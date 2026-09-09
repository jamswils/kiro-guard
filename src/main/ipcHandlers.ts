import { ipcMain } from 'electron'
import { getConfig } from './configStore'
import { IPC_CHANNELS } from '../shared/ipc'
import {
  lock,
  unlock,
  quickUnlock,
  unlockWithPassphrase,
  getCurrentLockState,
  getLockedAt,
} from './lockController'

/** Route an unlock request through whichever gate the config names. */
async function unlockPerMode(): Promise<void> {
  const config = getConfig()
  switch (config.lock.authMode) {
    case 'none':       quickUnlock(); return
    case 'passphrase': return   // needs text; the lock screen sends unlockWithPassphrase instead
    default:           await unlock(config.lock)
  }
}

export function registerIpcHandlers(): void {
  // Lock / unlock requests from any window (lock overlay button etc.)
  ipcMain.on(IPC_CHANNELS.lockRequest, async () => {
    const config = getConfig()
    await lock(config.lock)
  })

  ipcMain.on(IPC_CHANNELS.unlockRequest, async () => {
    await unlockPerMode()
  })

  // Passphrase / recovery answer typed on the cover. Verified in the main process.
  ipcMain.on(IPC_CHANNELS.unlockWithPassphrase, (_event, text: unknown) => {
    const config = getConfig()
    unlockWithPassphrase(config.lock, typeof text === 'string' ? text.slice(0, 512) : '')
  })

  ipcMain.on(IPC_CHANNELS.toggleLock, async () => {
    const config = getConfig()
    const state = getCurrentLockState()
    if (state === 'unlocked') {
      await lock(config.lock)
    } else if (state === 'locked') {
      await unlockPerMode()
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
