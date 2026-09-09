/**
 * settingsWindow.ts — the small window for things the tray menu cannot do:
 * setting a passphrase + recovery question, and pointing the KiroCrew feed at
 * a host.
 *
 * Security shape: the preload is shared with the lock screen, so the settings
 * IPC channels are guarded by SENDER, not by which bridge exposes them. Every
 * handler refuses unless `event.sender` is this window's webContents. That keeps
 * the previously-closed hole closed: nothing the lock screen can send changes
 * auth settings.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'path'
import { IPC_CHANNELS } from '../shared/ipc'
import type { AuthMode, KiroCrewFeedConfig } from '../shared/types'
import { getConfig, setKiroCrewConfig, setLockConfig, setPassphrase } from './configStore'
import { makeRecovery, makeVerifier, validatePassphraseSetup } from './passphrase'
import { fetchOnce } from './kirocrewFeed'

let win: BrowserWindow | null = null
let handlersRegistered = false
let onChanged: (() => void) | null = null

export type SettingsPane = 'passphrase' | 'kirocrew'

export function openSettingsWindow(pane: SettingsPane, changed?: () => void): BrowserWindow {
  onChanged = changed ?? onChanged
  registerHandlers()
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings-show-pane', pane)
    win.show(); win.focus()
    return win
  }
  win = new BrowserWindow({
    width: 520, height: 560,
    resizable: false, minimizable: false, maximizable: false,
    title: 'Kiro Guard settings',
    backgroundColor: '#0a0f0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.on('closed', () => { win = null })
  void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'settings.html'), { query: { pane } })
  win.once('ready-to-show', () => win?.show())
  return win
}

function fromSettingsWindow(event: IpcMainInvokeEvent): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

/** What the settings page may see. Never the verifiers themselves. */
function settingsView() {
  const cfg = getConfig()
  return {
    authMode: cfg.lock.authMode as AuthMode,
    passphraseSet: Boolean(cfg.lock.passphrase),
    recoveryQuestion: cfg.lock.recovery?.question ?? '',
    kirocrew: cfg.kirocrew,
  }
}

function registerHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    if (!fromSettingsWindow(event)) throw new Error('not allowed')
    return settingsView()
  })

  ipcMain.handle(IPC_CHANNELS.settingsSavePassphrase, (event, input: unknown) => {
    if (!fromSettingsWindow(event)) throw new Error('not allowed')
    const i = (input ?? {}) as { passphrase?: unknown; confirm?: unknown; question?: unknown; answer?: unknown }
    const clean = {
      passphrase: String(i.passphrase ?? ''), confirm: String(i.confirm ?? ''),
      question: String(i.question ?? ''), answer: String(i.answer ?? ''),
    }
    const problem = validatePassphraseSetup(clean)
    if (problem) return { ok: false, error: problem }
    setPassphrase(makeVerifier(clean.passphrase), makeRecovery(clean.question, clean.answer))
    onChanged?.()
    return { ok: true, view: settingsView() }
  })

  ipcMain.handle(IPC_CHANNELS.settingsSaveKiroCrew, async (event, input: unknown) => {
    if (!fromSettingsWindow(event)) throw new Error('not allowed')
    const i = (input ?? {}) as Partial<Record<keyof KiroCrewFeedConfig | 'test', unknown>>
    const patch: Partial<KiroCrewFeedConfig> = {}
    if (typeof i.enabled === 'boolean') patch.enabled = i.enabled
    if (i.source === 'ssh' || i.source === 'file') patch.source = i.source
    if (typeof i.sshHost === 'string') patch.sshHost = i.sshHost.trim().slice(0, 200)
    if (typeof i.remoteScript === 'string' && i.remoteScript.trim()) patch.remoteScript = i.remoteScript.trim().slice(0, 400)
    if (typeof i.statusFile === 'string') patch.statusFile = i.statusFile.trim().slice(0, 400)
    if (typeof i.intervalMs === 'number' && Number.isFinite(i.intervalMs)) patch.intervalMs = Math.max(5000, Math.round(i.intervalMs))
    setKiroCrewConfig(patch)
    onChanged?.()
    const view = settingsView()
    if (i.test === true) {
      // One real poll so the user finds out now, not while the screen is black.
      const snap = await fetchOnce(view.kirocrew)
      return { ok: !snap.error, error: snap.error, snapshot: snap, view }
    }
    return { ok: true, view }
  })

  ipcMain.on(IPC_CHANNELS.settingsClose, (event) => {
    if (win && !win.isDestroyed() && event.sender === win.webContents) win.close()
  })
}

/** Tray helper: switch auth mode; opening the passphrase pane if none is set yet. */
export function chooseAuthMode(mode: AuthMode, changed?: () => void): void {
  const cfg = getConfig()
  if (mode === 'passphrase' && !cfg.lock.passphrase) {
    openSettingsWindow('passphrase', changed)
    return
  }
  setLockConfig({ authMode: mode })
  changed?.()
}
