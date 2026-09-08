/**
 * Regression tests for the two reported field bugs:
 *
 * 1. Multi-monitor coverage leak — during credential auth the shield
 *    (kiosk + screen-saver always-on-top) was dropped on EVERY display,
 *    leaving the taskbar (and Slack hover previews) exposed on secondary
 *    monitors. Only the primary display (where the credential dialog
 *    appears) may be unshielded. Displays attached while locked must get
 *    a lock window.
 *
 * 2. Password unlock bypass — the PowerShell auth helper accepted an
 *    empty password. PromptForCredential returns a credential object for
 *    a blank password, and ValidateCredentials('user', '') can succeed
 *    via an unauthenticated LDAP bind. The script must reject empty
 *    passwords before any validation strategy runs.
 */

// --- electron mock -----------------------------------------------------------

type DisplayLike = { id: number; bounds: { x: number; y: number; width: number; height: number } }

const PRIMARY: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const SECONDARY: DisplayLike = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }

let displays: DisplayLike[] = [PRIMARY, SECONDARY]
const screenListeners = new Map<string, Array<() => void>>()

const createdWindows: FakeBrowserWindow[] = []

class FakeBrowserWindow {
  options: Record<string, unknown>
  destroyed = false
  kiosk: boolean | null = null
  alwaysOnTop = true
  alwaysOnTopLevel: string | null = null
  webContents = {
    send: jest.fn(),
    on: jest.fn(),
  }
  __displayId?: number

  constructor(options: Record<string, unknown>) {
    this.options = options
    createdWindows.push(this)
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.alwaysOnTop = flag
    this.alwaysOnTopLevel = flag ? (level ?? 'floating') : null
  }
  setKiosk(flag: boolean): void { this.kiosk = flag }
  loadFile(): Promise<void> { return Promise.resolve() }
  show(): void { /* noop */ }
  focus(): void { /* noop */ }
  hide(): void { /* noop */ }
  moveTop(): void { /* noop */ }
  close(): void { this.destroyed = true }
  destroy(): void { this.destroyed = true }
  isDestroyed(): boolean { return this.destroyed }
}

jest.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getAllDisplays: jest.fn(() => displays),
    getPrimaryDisplay: jest.fn(() => PRIMARY),
    on: jest.fn((event: string, handler: () => void) => {
      const list = screenListeners.get(event) ?? []
      list.push(handler)
      screenListeners.set(event, list)
    }),
  },
  globalShortcut: {
    register: jest.fn(() => true),
    unregisterAll: jest.fn(),
  },
  powerSaveBlocker: {
    start: jest.fn(() => 1),
    stop: jest.fn(),
  },
  app: {},
}))

jest.mock('../../src/main/statusManager', () => ({
  statusManager: {
    getCurrentStatus: jest.fn(() => ({ status: 'idle' })),
    onStatusChange: jest.fn(),
  },
}))

// child_process.execFile — capture the invocation; resolve via test control.
let execFileCallback: ((err: Error | null, stdout: string, stderr: string) => void) | null = null
const execFileMock = jest.fn(
  (
    _cmd: string,
    _args: string[],
    _opts: Record<string, unknown>,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCallback = cb
  },
)
jest.mock('child_process', () => ({ execFile: execFileMock }))

import { lock, unlock, quickUnlock, getCurrentLockState } from '../../src/main/lockController'
import * as fs from 'fs'
import * as path from 'path'

const LOCK_CONFIG = {
  hotkey: 'Control+Shift+L',
  requireAuth: true,
  autoLockOnAgentStart: false,
  showElapsedTime: true,
  lockMessage: 'locked',
}

function fireScreenEvent(event: string): void {
  for (const h of screenListeners.get(event) ?? []) h()
}

describe('lockController multi-monitor shield (Bug 1)', () => {
  beforeEach(() => {
    createdWindows.length = 0
    displays = [PRIMARY, SECONDARY]
    execFileCallback = null
    jest.useFakeTimers()
  })

  afterEach(async () => {
    // Drive any in-flight auth to a failure so the controller settles,
    // then quick-unlock so the module singleton is 'unlocked' for the
    // next test.
    if (execFileCallback) {
      execFileCallback(null, 'BAD\n', '')
      execFileCallback = null
      await Promise.resolve()
      await Promise.resolve()
    }
    if (getCurrentLockState() === 'locked') {
      quickUnlock()
      jest.advanceTimersByTime(700)
    }
    jest.useRealTimers()
  })

  it('creates one lock window per display', async () => {
    await lock(LOCK_CONFIG)
    expect(createdWindows.length).toBe(2)
    expect(createdWindows.map(w => w.__displayId).sort()).toEqual([1, 2])
    expect(getCurrentLockState()).toBe('locked')
  })

  it('keeps secondary displays shielded while auth is in progress', async () => {
    await lock(LOCK_CONFIG)
    const primaryWin = createdWindows.find(w => w.__displayId === PRIMARY.id)!
    const secondaryWin = createdWindows.find(w => w.__displayId === SECONDARY.id)!

    const unlockPromise = unlock(LOCK_CONFIG)
    // unlock() runs synchronously up to `await authenticateWindows()`,
    // so the primary display is unshielded and execFile has been invoked
    // by the time the microtask queue drains once.
    await Promise.resolve()

    // Primary is lowered so the credential dialog is visible…
    expect(primaryWin.kiosk).toBe(false)
    expect(primaryWin.alwaysOnTop).toBe(false)
    // …but the secondary display keeps its full shield. This was the leak:
    // previously BOTH windows were lowered during auth.
    expect(secondaryWin.kiosk).toBe(true)
    expect(secondaryWin.alwaysOnTop).toBe(true)
    expect(secondaryWin.alwaysOnTopLevel).toBe('screen-saver')

    // Auth fails -> every display re-shielded.
    execFileCallback!(null, 'BAD\n', '')
    execFileCallback = null
    await unlockPromise
    expect(primaryWin.kiosk).toBe(true)
    expect(primaryWin.alwaysOnTopLevel).toBe('screen-saver')
    expect(getCurrentLockState()).toBe('locked')
  })

  it('covers a display that is attached while locked', async () => {
    await lock(LOCK_CONFIG)
    expect(createdWindows.length).toBe(2)

    const THIRD: DisplayLike = { id: 3, bounds: { x: 3840, y: 0, width: 1920, height: 1080 } }
    displays = [PRIMARY, SECONDARY, THIRD]
    fireScreenEvent('display-added')
    await Promise.resolve()

    const third = createdWindows.find(w => w.__displayId === THIRD.id)
    expect(third).toBeDefined()
    expect(third!.options.fullscreen).toBe(true)
  })

  it('destroys the lock window of a removed display', async () => {
    await lock(LOCK_CONFIG)
    const secondaryWin = createdWindows.find(w => w.__displayId === SECONDARY.id)!

    displays = [PRIMARY]
    fireScreenEvent('display-removed')

    expect(secondaryWin.destroyed).toBe(true)
  })
})

describe('auth helper script guards (Bug 2)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main', 'lockController.ts'),
    'utf-8',
  )

  it('rejects empty passwords before running any validation strategy', () => {
    // The inline PowerShell script must bail out with BAD when the
    // password box is blank. Without this, ValidateCredentials('user','')
    // could return true via an unauthenticated LDAP bind.
    expect(source).toMatch(/IsNullOrEmpty\(\$password\)/)
    const guardIndex = source.indexOf('IsNullOrEmpty($password)')
    // First actual validation CALL (not prose in comments).
    const firstStrategyIndex = source.indexOf('$ctx.ValidateCredentials')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(firstStrategyIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(firstStrategyIndex)
  })
})
