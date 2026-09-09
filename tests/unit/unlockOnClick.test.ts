/**
 * @jest-environment jsdom
 *
 * Regression tests for the field report "the lock screen just unlocks when
 * you click it".
 *
 * Root cause: `requireAuth` defaulted to false, and every unlock surface
 * (lock-screen button, tray, hotkey) routes to quickUnlock() when it is
 * false — so a fresh install unlocks on a single click. The lock screen
 * made it worse by labelling that button "Unlock with Windows password"
 * regardless of the setting, so users believed a password step had been
 * promised and skipped.
 *
 * Three fixes, one test each:
 *   1. requireAuth defaults to TRUE on first run.
 *   2. The lock-init payload tells the lock screen whether a password is
 *      actually required.
 *   3. lock.html renders an honest button label + hint from that flag.
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Fix 1 — configStore default
// ---------------------------------------------------------------------------

describe('Fix 1: requireAuth default', () => {
  it('requires a password to unlock on a fresh install', () => {
    // Read the default straight from source: the configStore module pulls
    // in electron-store + electron at import time, which the other suites
    // mock heavily. The default literal is the contract here.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'main', 'configStore.ts'),
      'utf8',
    )
    const block = src.match(/const DEFAULT_LOCK_CONFIG[\s\S]*?\n}/)
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/requireAuth:\s*true/)
  })
})

// ---------------------------------------------------------------------------
// Fix 1b — existing installs. electron-store persisted the old default
// (`requireAuth: false`) to disk on first run, so a new default alone would
// leave every reporting user exactly where they are.
// ---------------------------------------------------------------------------

describe('Fix 1b: config migration for installs that persisted requireAuth:false', () => {
  function fakeStore(seed: Record<string, unknown>) {
    const data: Record<string, unknown> = { ...seed }
    return {
      data,
      get: (k: string, d?: unknown) => (k in data ? data[k] : d),
      set: (k: string, v: unknown) => { data[k] = v },
    }
  }

  async function loadMigrations() {
    jest.resetModules()
    jest.doMock('electron-store', () => jest.fn().mockImplementation(() => ({
      get: (_k: string, d?: unknown) => d,
      set: () => {},
    })))
    const mod = await import('../../src/main/configStore')
    return mod
  }

  it('flips a persisted false to true exactly once and stamps configVersion', async () => {
    const { runConfigMigrations, CONFIG_VERSION } = await loadMigrations()
    const s = fakeStore({ 'lock.requireAuth': false })
    runConfigMigrations(s)
    expect(s.data['lock.requireAuth']).toBe(true)
    expect(s.data['configVersion']).toBe(CONFIG_VERSION)
  })

  it('respects a user who turned the password OFF after the migration', async () => {
    const { runConfigMigrations, CONFIG_VERSION } = await loadMigrations()
    const s = fakeStore({ 'lock.requireAuth': false, configVersion: CONFIG_VERSION })
    runConfigMigrations(s)
    expect(s.data['lock.requireAuth']).toBe(false)
  })

  it('leaves an already-true value alone', async () => {
    const { runConfigMigrations } = await loadMigrations()
    const s = fakeStore({ 'lock.requireAuth': true })
    runConfigMigrations(s)
    expect(s.data['lock.requireAuth']).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix 2 — lock-init payload carries requireAuth
// ---------------------------------------------------------------------------

describe('Fix 2: lock-init payload', () => {
  it('buildLockInitPayload forwards requireAuth from config', async () => {
    jest.resetModules()
    jest.doMock('electron', () => ({
      BrowserWindow: class {},
      screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on: () => {} },
      globalShortcut: { register: () => true, unregisterAll: () => {} },
      powerSaveBlocker: { start: () => 1, stop: () => {} },
      app: {},
    }))
    jest.doMock('../../src/main/statusManager', () => ({
      statusManager: { getCurrentStatus: () => ({ status: 'working' }), onStatusChange: () => {} },
    }))
    const mod = await import('../../src/main/lockController')
    const base = {
      hotkey: 'Control+Shift+L',
      autoLockOnAgentStart: false,
      showElapsedTime: true,
      lockMessage: 'msg',
    }
    const on = mod.buildLockInitPayload({ ...base, requireAuth: true, authMode: 'windows' }, 123, 'idle')
    const off = mod.buildLockInitPayload({ ...base, requireAuth: false, authMode: 'none' }, 123, 'idle')
    expect(on).toMatchObject({ message: 'msg', showElapsed: true, lockedAt: 123, status: 'idle', requireAuth: true, authMode: 'windows' })
    expect(off.requireAuth).toBe(false)
    expect(off.authMode).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// Fix 3 — lock.html label honesty (real renderer, jsdom)
// ---------------------------------------------------------------------------

type InitData = { message: string; showElapsed: boolean; lockedAt: number; status?: string; requireAuth?: boolean; authMode?: 'windows' | 'passphrase' | 'none'; recoveryAvailable?: boolean; kirocrewEnabled?: boolean }

function loadLockHtml(): { fireInit: (d: InitData) => void } {
  const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'lock.html'),
    'utf8',
  )
  let initHandler: ((d: InitData) => void) | null = null
  ;(window as unknown as { kiroLock: unknown }).kiroLock = {
    onInit: (h: (d: InitData) => void) => { initHandler = h },
    onStatus: () => {},
    onElapsed: () => {},
    onAuthStart: () => {},
    onAuthError: () => {},
    onUnlockSuccess: () => {},
    onRecoveryOffered: (h: (q: string) => void) => { (window as unknown as { __rec: unknown }).__rec = h },
    onKiroCrewPulse: (h: (s: unknown) => void) => { (window as unknown as { __pulse: unknown }).__pulse = h },
    requestUnlock: () => {},
    submitPassphrase: () => {},
  }
  // Stub canvas/Image so the sprite loop in lock.html does not throw in jsdom.
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ({
    clearRect: () => {}, drawImage: () => {},
  })

  document.documentElement.innerHTML = html.replace(/<!DOCTYPE[^>]*>/i, '')
  // jsdom does not execute <script> injected via innerHTML; run them.
  for (const s of Array.from(document.querySelectorAll('script'))) {
    if (s.textContent) new Function(s.textContent)()  // eslint-disable-line no-new-func
  }
  document.dispatchEvent(new Event('DOMContentLoaded'))
  if (!initHandler) throw new Error('lock.html never registered onInit')
  return { fireInit: (d) => initHandler!(d) }
}

describe('Fix 3: lock screen tells the truth about the password step', () => {
  it('labels the button "Unlock with Windows password" only when a password is required', () => {
    const { fireInit } = loadLockHtml()
    fireInit({ message: 'm', showElapsed: false, lockedAt: 1, requireAuth: true })
    const btn = document.getElementById('unlockBtn')!
    expect(btn.textContent!.trim()).toBe('Unlock with Windows password')
    expect(document.getElementById('authHint')!.textContent!.trim()).toBe('')
  })

  it('does NOT promise a password when requireAuth is off, and says how to turn it on', () => {
    const { fireInit } = loadLockHtml()
    fireInit({ message: 'm', showElapsed: false, lockedAt: 1, requireAuth: false })
    const btn = document.getElementById('unlockBtn')!
    expect(btn.textContent!.trim()).toBe('Unlock')
    expect(btn.textContent).not.toMatch(/password/i)
    const hint = document.getElementById('authHint')!.textContent!
    expect(hint).toMatch(/password protection is off/i)
    expect(hint).toMatch(/"Unlock with" in the tray menu/)
  })

  it('never claims a password step before the init payload arrives', () => {
    // The static HTML must not carry the old hard-coded label: if the
    // payload is late or missing, the screen must not lie.
    const html = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'renderer', 'lock.html'),
      'utf8',
    )
    const staticBtn = html.match(/<button[^>]*id="unlockBtn"[^>]*>([\s\S]*?)<\/button>/)
    expect(staticBtn).not.toBeNull()
    expect(staticBtn![1]).not.toMatch(/password/i)
  })
})
