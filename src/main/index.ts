import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'path'
import { getConfig, setLockConfig } from './configStore'
import { registerIpcHandlers } from './ipcHandlers'
import { statusManager } from './statusManager'
import { multiWorkspaceStatusWatcher } from './multiWorkspaceStatusWatcher'
import {
  lock,
  unlock,
  quickUnlock,
  getCurrentLockState,
  onLockStateChange,
  registerHotkey,
  unregisterHotkey,
} from './lockController'

// Disable hardware acceleration in environments where the GPU process is
// unstable (RDP, virtual machines, locked-down desktops). Set
// KIRO_GUARD_ENABLE_GPU=1 to opt back into hardware acceleration.
if (process.env.KIRO_GUARD_ENABLE_GPU !== '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('in-process-gpu')
}

let tray: Tray | null = null

function buildTrayMenu(): Electron.Menu {
  const config = getConfig()
  const locked = getCurrentLockState() === 'locked'

  return Menu.buildFromTemplate([
    { label: 'Kiro Guard', enabled: false },
    { type: 'separator' },
    {
      label: locked ? 'Unlock Screen' : 'Lock Screen',
      accelerator: config.lock.hotkey,
      click: async () => {
        if (locked) {
          if (config.lock.requireAuth) await unlock(config.lock)
          else quickUnlock()
        } else {
          await lock(config.lock)
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Require password to unlock',
          type: 'checkbox',
          checked: config.lock.requireAuth,
          click: (item) => setLockConfig({ requireAuth: item.checked }),
        },
        {
          label: 'Auto-lock when agent starts',
          type: 'checkbox',
          checked: config.lock.autoLockOnAgentStart,
          click: (item) => setLockConfig({ autoLockOnAgentStart: item.checked }),
        },
        {
          label: 'Show elapsed time',
          type: 'checkbox',
          checked: config.lock.showElapsedTime,
          click: (item) => setLockConfig({ showElapsedTime: item.checked }),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Quit Kiro Guard',
      click: () => app.quit(),
    },
  ])
}

function setupTray(): void {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png')
  try {
    tray = new Tray(iconPath)
  } catch {
    tray = new Tray(nativeImage.createEmpty())
  }
  tray.setToolTip('Kiro Guard — click to lock')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', async () => {
    const config = getConfig()
    const state = getCurrentLockState()
    if (state === 'unlocked') await lock(config.lock)
    else if (state === 'locked') {
      if (config.lock.requireAuth) await unlock(config.lock)
      else quickUnlock()
    }
  })
}

app.whenReady().then(async () => {
  // Prevent app from showing in dock on macOS — we run as a tray-only app
  if (process.platform === 'darwin') app.dock?.hide()

  const config = getConfig()

  registerIpcHandlers()
  setupTray()

  // Global hotkey: lock or unlock
  registerHotkey(config.lock, async () => {
    const cfg = getConfig()
    const state = getCurrentLockState()
    if (state === 'unlocked') {
      await lock(cfg.lock)
    } else if (state === 'locked') {
      if (cfg.lock.requireAuth) await unlock(cfg.lock)
      else quickUnlock()
    }
  })

  // Refresh tray menu label when lock state flips
  onLockStateChange(() => {
    tray?.setContextMenu(buildTrayMenu())
  })

  // Auto-lock if enabled and Kiro starts working
  statusManager.onStatusChange((payload) => {
    const cfg = getConfig()
    if (
      cfg.lock.autoLockOnAgentStart &&
      payload.status === 'working' &&
      getCurrentLockState() === 'unlocked'
    ) {
      lock(cfg.lock).catch(console.error)
    }
  })

  // statusManager keeps the lock screen's status row in sync.
  // Must initialize BEFORE multiWorkspaceStatusWatcher because that watcher
  // forwards to statusManager.writeStatus() which requires init first.
  await statusManager.initialize(config.statusFilePath)
  statusManager.startWatching()

  // Watch all workspace status files written by kiro-buddy hooks
  // (~/.kiro-buddy/workspaces/<hash>/status.json). Surfaces the status
  // of whichever Kiro IDE workspace was most recently active so the
  // lock screen shows live "Kiro Processing" / "Kiro Ready" updates.
  multiWorkspaceStatusWatcher.onStatusChange((payload) => {
    const cfg = getConfig()
    if (
      cfg.lock.autoLockOnAgentStart &&
      payload.status === 'working' &&
      getCurrentLockState() === 'unlocked'
    ) {
      lock(cfg.lock).catch(console.error)
    }
    // Forward to statusManager so existing subscribers (incl. lock
    // window's status row) get the update through one canonical path.
    statusManager.writeStatus(payload)
  })
  multiWorkspaceStatusWatcher.start()
})

app.on('before-quit', () => {
  unregisterHotkey()
  statusManager.stopWatching()
  multiWorkspaceStatusWatcher.stop()
})

// Keep the app alive even when no window is open (tray-only mode).
// Without this, on Windows the app would quit after every unlock when the
// lock screen window closes.
app.on('window-all-closed', () => {
  // Intentionally do nothing — the tray keeps the process alive.
})

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
})
