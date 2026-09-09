/**
 * configStore.ts — Kiro Guard
 * Extends kiro-buddy config with lock settings.
 */

import path from 'path'
import os from 'os'
import fs from 'fs'
import ElectronStore from 'electron-store'
import type { AppConfig, NotificationConfig, LockConfig } from '../shared/types'

type AppConfigSchema = AppConfig

const schema: ElectronStore.Schema<AppConfigSchema> = {
  window: {
    type: 'object',
    properties: {
      x:      { type: 'number' },
      y:      { type: 'number' },
      width:  { type: 'number' },
      height: { type: 'number' },
    },
    required: ['x', 'y', 'width', 'height'],
    additionalProperties: false,
  },
  statusFilePath: { type: 'string' },
  notifications: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      onDone:  { type: 'boolean' },
      onError: { type: 'boolean' },
    },
    required: ['enabled', 'onDone', 'onError'],
    additionalProperties: false,
  },
  clickThrough:   { type: 'boolean' },
  pollIntervalMs: { type: 'number' },
  petScale:       { type: 'number', minimum: 0.6, maximum: 1.4 },
  configVersion:  { type: 'number' },
  lock: {
    type: 'object',
    properties: {
      hotkey:               { type: 'string' },
      requireAuth:          { type: 'boolean' },
      autoLockOnAgentStart: { type: 'boolean' },
      showElapsedTime:      { type: 'boolean' },
      lockMessage:          { type: 'string' },
    },
    required: ['hotkey', 'requireAuth', 'autoLockOnAgentStart', 'showElapsedTime', 'lockMessage'],
    additionalProperties: false,
  },
}

const DEFAULT_LOCK_CONFIG: LockConfig = {
  hotkey: 'Control+Shift+L',
  // Default ON. With this false, every unlock surface (lock-screen button,
  // tray, hotkey) calls quickUnlock() and the cover drops on a single click
  // — users reported the guard "just unlocks when you click it". A guard
  // that opens on a click is not a guard; quick mode is opt-out via the
  // tray's "Require password to unlock" checkbox.
  requireAuth: true,
  autoLockOnAgentStart: false,
  showElapsedTime: true,
  lockMessage: 'Agents are working. Screen locked.',
}

const DEFAULT_CONFIG: AppConfigSchema = {
  window: { x: 100, y: 100, width: 390, height: 360 },
  statusFilePath: path.join(os.homedir(), '.kiro', 'status.json'),
  notifications: { enabled: true, onDone: true, onError: true },
  clickThrough:   false,
  pollIntervalMs: 500,
  petScale:       1,
  lock:           DEFAULT_LOCK_CONFIG,
}

const configDir = path.join(os.homedir(), '.kiro-guard')
const configFilePath = path.join(configDir, 'config.json')
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export function repairConfigFileEncoding(filePath: string = configFilePath): void {
  let buffer: Buffer
  try { buffer = fs.readFileSync(filePath) } catch { return }
  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    fs.writeFileSync(filePath, buffer.subarray(UTF8_BOM.length))
  }
}

repairConfigFileEncoding()

const store = new ElectronStore<AppConfigSchema>({
  name: 'config',
  cwd: configDir,
  schema,
  defaults: DEFAULT_CONFIG,
})

/**
 * One-time config migrations. Runs at module load.
 *
 * v2 — password protection on by default. electron-store writes `defaults`
 * to disk on first run, so every install created while the default was
 * `requireAuth: false` has that literal persisted; changing the default
 * alone would fix fresh installs only, not the users who reported the
 * click-to-unlock behaviour. Flip a persisted `false` to `true` exactly
 * once. This is the safe direction (the cover asks for a password instead
 * of dropping on a click); anyone who wants quick mode back re-unticks
 * "Require password to unlock" in the tray and the migration never runs
 * again for them.
 */
export const CONFIG_VERSION = 2

type KeyValueStore = {
  get(key: string, defaultValue?: unknown): unknown
  set(key: string, value: unknown): void
}

export function runConfigMigrations(s: KeyValueStore = store as unknown as KeyValueStore): void {
  const version = Number(s.get('configVersion', 1)) || 1
  if (version < 2) {
    if (s.get('lock.requireAuth', DEFAULT_LOCK_CONFIG.requireAuth) === false) {
      s.set('lock.requireAuth', true)
      console.log('[configStore] migration v2: lock.requireAuth false → true (password protection is now on by default; opt out via the tray menu)')
    }
    s.set('configVersion', CONFIG_VERSION)
  }
}

runConfigMigrations()

export function getConfig(): AppConfigSchema {
  const envPath = process.env.KIRO_GUARD_STATUS_FILE
  return {
    window: {
      x:      store.get('window.x',      DEFAULT_CONFIG.window.x),
      y:      store.get('window.y',      DEFAULT_CONFIG.window.y),
      width:  store.get('window.width',  DEFAULT_CONFIG.window.width),
      height: store.get('window.height', DEFAULT_CONFIG.window.height),
    },
    statusFilePath: (envPath && path.isAbsolute(envPath)) ? envPath : store.get('statusFilePath', DEFAULT_CONFIG.statusFilePath),
    notifications: {
      enabled: store.get('notifications.enabled', DEFAULT_CONFIG.notifications.enabled),
      onDone:  store.get('notifications.onDone',  DEFAULT_CONFIG.notifications.onDone),
      onError: store.get('notifications.onError', DEFAULT_CONFIG.notifications.onError),
    },
    clickThrough:   store.get('clickThrough',   DEFAULT_CONFIG.clickThrough),
    pollIntervalMs: store.get('pollIntervalMs', DEFAULT_CONFIG.pollIntervalMs),
    petScale:       store.get('petScale',       DEFAULT_CONFIG.petScale),
    lock: {
      hotkey:               store.get('lock.hotkey',               DEFAULT_LOCK_CONFIG.hotkey),
      requireAuth:          store.get('lock.requireAuth',          DEFAULT_LOCK_CONFIG.requireAuth),
      autoLockOnAgentStart: store.get('lock.autoLockOnAgentStart', DEFAULT_LOCK_CONFIG.autoLockOnAgentStart),
      showElapsedTime:      store.get('lock.showElapsedTime',      DEFAULT_LOCK_CONFIG.showElapsedTime),
      lockMessage:          store.get('lock.lockMessage',          DEFAULT_LOCK_CONFIG.lockMessage),
    },
  }
}

export function setWindowPosition(x: number, y: number): void {
  store.set('window.x', x)
  store.set('window.y', y)
}

export function setNotificationPrefs(prefs: NotificationConfig): void {
  store.set('notifications', prefs)
}

export function setClickThrough(enabled: boolean): void {
  store.set('clickThrough', enabled)
}

export function setPetScale(scale: number): void {
  const clampedScale = Math.max(0.6, Math.min(scale, 1.4))
  store.set('petScale', Math.round(clampedScale * 100) / 100)
}

export function setLockConfig(config: Partial<LockConfig>): void {
  const current = getConfig().lock
  const merged = { ...current, ...config }
  store.set('lock', merged)
}

export { store }
