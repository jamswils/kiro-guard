/**
 * lockController — recovery and cover-invariant regression tests.
 *
 * Why this file exists: before it, `lockController.ts` (546 lines — every
 * line that covers a monitor, gates unlock behind a password, and tears the
 * cover back down) had ZERO test coverage, and the string `requireAuth: true`
 * appeared nowhere in the suite. The password requirement could be deleted
 * outright and the whole suite stayed green.
 *
 * Fidelity note — this harness deliberately models `close()` as a NO-OP.
 * Lock windows are created with `closable: false`, and on Windows `close()`
 * on such a window does nothing. A test double that treats `close()` as
 * destroying the window cannot observe the leak (or the
 * cover-shown-on-unlocked-desktop bug that follows from it), which is
 * precisely why both survived review. Only `destroy()` tears down here.
 */

type DisplayLike = { id: number; bounds: { x: number; y: number; width: number; height: number } }

const PRIMARY: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const SECONDARY: DisplayLike = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }

let displays: DisplayLike[] = [PRIMARY, SECONDARY]
let screenListeners = new Map<string, Array<() => void>>()
let createdWindows: FakeBrowserWindow[] = []

/** Controls what the next loadFile() call does, so lock failure is testable. */
let loadFileBehaviour: 'resolve' | 'reject' | 'defer' = 'resolve'
let deferredLoads: Array<() => void> = []

class FakeBrowserWindow {
  options: Record<string, unknown>
  destroyed = false
  kiosk: boolean | null = null
  alwaysOnTop = true
  alwaysOnTopLevel: string | null = null
  shown = false
  closeCalls = 0
  destroyCalls = 0
  bounds: { x: number; y: number; width: number; height: number }
  webContents = { send: jest.fn(), on: jest.fn() }
  __displayId?: number

  constructor(options: Record<string, unknown>) {
    this.options = options
    this.bounds = (options.x !== undefined)
      ? {
          x: options.x as number,
          y: options.y as number,
          width: options.width as number,
          height: options.height as number,
        }
      : { x: 0, y: 0, width: 0, height: 0 }
    createdWindows.push(this)
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.alwaysOnTop = flag
    this.alwaysOnTopLevel = flag ? (level ?? 'floating') : null
  }
  setKiosk(flag: boolean): void { this.kiosk = flag }
  getBounds(): { x: number; y: number; width: number; height: number } { return this.bounds }
  setBounds(b: { x: number; y: number; width: number; height: number }): void { this.bounds = { ...b } }

  loadFile(): Promise<void> {
    if (loadFileBehaviour === 'reject') return Promise.reject(new Error('loadFile failed'))
    if (loadFileBehaviour === 'defer') {
      return new Promise<void>(resolve => { deferredLoads.push(resolve) })
    }
    return Promise.resolve()
  }

  show(): void { this.shown = true }
  focus(): void { /* noop */ }
  hide(): void { /* noop */ }
  moveTop(): void { /* noop */ }

  /**
   * NO-OP by design: these windows are `closable: false`. See the file header.
   */
  close(): void { this.closeCalls++ }
  destroy(): void { this.destroyCalls++; this.destroyed = true }
  isDestroyed(): boolean { return this.destroyed }
}

const globalShortcutHandlers = new Map<string, () => void>()
let registerReturns = true

jest.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getAllDisplays: jest.fn(() => displays),
    getPrimaryDisplay: jest.fn(() => displays[0] ?? PRIMARY),
    on: jest.fn((event: string, handler: () => void) => {
      const list = screenListeners.get(event) ?? []
      list.push(handler)
      screenListeners.set(event, list)
    }),
  },
  globalShortcut: {
    register: jest.fn((accel: string, handler: () => void) => {
      if (registerReturns) globalShortcutHandlers.set(accel, handler)
      return registerReturns
    }),
    unregisterAll: jest.fn(() => globalShortcutHandlers.clear()),
  },
  powerSaveBlocker: { start: jest.fn(() => 1), stop: jest.fn() },
  app: {},
}))

jest.mock('../../src/main/statusManager', () => ({
  statusManager: {
    getCurrentStatus: jest.fn(() => ({ status: 'idle' })),
    onStatusChange: jest.fn(),
  },
}))

let execFileCallback: ((err: Error | null, stdout: string, stderr: string) => void) | null = null
let execFileOptions: Record<string, unknown> | null = null
let execFileScriptArgs: string[] | null = null
const execFileMock = jest.fn(
  (
    _cmd: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileScriptArgs = args
    execFileOptions = opts
    execFileCallback = cb
  },
)
jest.mock('child_process', () => ({ execFile: execFileMock }))

const LOCK_CONFIG = {
  hotkey: 'Control+Shift+L',
  requireAuth: true,
  authMode: 'windows' as const,
  autoLockOnAgentStart: false,
  showElapsedTime: true,
  lockMessage: 'locked',
}
const NO_AUTH_CONFIG = { ...LOCK_CONFIG, requireAuth: false }

type Controller = typeof import('../../src/main/lockController')

/** Fresh module state per test — lockController holds module-level state. */
function loadController(): Controller {
  let mod: Controller
  jest.isolateModules(() => {
    mod = require('../../src/main/lockController') as Controller
  })
  return mod!
}

function fireScreenEvent(event: string): void {
  for (const h of [...(screenListeners.get(event) ?? [])]) h()
}

/** Let queued promise callbacks run. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  displays = [PRIMARY, SECONDARY]
  screenListeners = new Map()
  createdWindows = []
  deferredLoads = []
  loadFileBehaviour = 'resolve'
  registerReturns = true
  globalShortcutHandlers.clear()
  execFileCallback = null
  execFileOptions = null
  execFileScriptArgs = null
  execFileMock.mockClear()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------
// The cover invariant
// ---------------------------------------------------------------------------

describe('cover invariant', () => {
  it('covers EVERY display at screen-saver level with kiosk on', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    expect(c.getCurrentLockState()).toBe('locked')
    const live = createdWindows.filter(w => !w.isDestroyed())
    expect(live.length).toBe(displays.length)

    for (const display of displays) {
      const win = live.find(w => w.__displayId === display.id)
      expect(win).toBeDefined()
      expect(win!.alwaysOnTop).toBe(true)
      expect(win!.alwaysOnTopLevel).toBe('screen-saver')
      expect(win!.kiosk).toBe(true)
      expect(win!.options.fullscreen).toBe(true)
    }
  })

  it('covers a display attached while locked', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    const THIRD: DisplayLike = { id: 3, bounds: { x: 3840, y: 0, width: 1280, height: 1024 } }
    displays = [PRIMARY, SECONDARY, THIRD]
    fireScreenEvent('display-added')
    await flush()

    const third = createdWindows.find(w => w.__displayId === THIRD.id && !w.isDestroyed())
    expect(third).toBeDefined()
    expect(third!.kiosk).toBe(true)
    expect(third!.alwaysOnTopLevel).toBe('screen-saver')
  })

  it('resizes a cover when its display bounds change (same display id)', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    const secondaryWin = createdWindows.find(w => w.__displayId === SECONDARY.id)!
    expect(secondaryWin.bounds.width).toBe(1920)

    // A resolution change keeps the SAME display id. Nothing is added or
    // removed, so an id-only reconciliation touches no window and the cover
    // keeps stale geometry — leaving live desktop visible beside it.
    displays = [
      PRIMARY,
      { id: SECONDARY.id, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]
    fireScreenEvent('display-metrics-changed')
    await flush()

    expect(secondaryWin.bounds).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 })
    expect(secondaryWin.kiosk).toBe(true)
    expect(secondaryWin.alwaysOnTopLevel).toBe('screen-saver')
  })
})

// ---------------------------------------------------------------------------
// C1 — a failed lock must never wedge the machine
// ---------------------------------------------------------------------------

describe('lock failure recovery', () => {
  it('unwinds to unlocked when showing the cover rejects', async () => {
    const c = loadController()
    loadFileBehaviour = 'reject'

    await c.lock(LOCK_CONFIG)

    // Previously stuck at 'locking' forever, with a cover already on screen
    // and unlock()/quickUnlock()/emergency hotkey ALL refusing to act.
    expect(c.getCurrentLockState()).toBe('unlocked')
    expect(c.getLockedAt()).toBeUndefined()
    expect(createdWindows.every(w => w.isDestroyed())).toBe(true)
  })

  it('can lock again after a failed lock', async () => {
    const c = loadController()
    loadFileBehaviour = 'reject'
    await c.lock(LOCK_CONFIG)
    expect(c.getCurrentLockState()).toBe('unlocked')

    loadFileBehaviour = 'resolve'
    createdWindows = []
    await c.lock(LOCK_CONFIG)

    expect(c.getCurrentLockState()).toBe('locked')
    expect(createdWindows.filter(w => !w.isDestroyed()).length).toBe(displays.length)
  })

  it('emergency unlock recovers a cover stranded in the locking state', async () => {
    const c = loadController()
    c.registerHotkey(LOCK_CONFIG, () => {})

    // Strand the lock mid-flight: loadFile never settles, so lock() is
    // still awaiting and the state is 'locking' with a window constructed.
    loadFileBehaviour = 'defer'
    void c.lock(LOCK_CONFIG)
    await flush()
    expect(c.getCurrentLockState()).toBe('locking')

    const emergency = globalShortcutHandlers.get('Control+Shift+Alt+U')
    expect(emergency).toBeDefined()
    emergency!()
    jest.advanceTimersByTime(600)

    expect(c.getCurrentLockState()).toBe('unlocked')
  })
})

// ---------------------------------------------------------------------------
// The password gate — requireAuth: true was never exercised at all
// ---------------------------------------------------------------------------

describe('password gate (requireAuth: true)', () => {
  it('stays LOCKED when the auth helper reports a bad password', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    const pending = c.unlock(LOCK_CONFIG)
    await flush()
    expect(execFileMock).toHaveBeenCalled()

    execFileCallback!(null, 'BAD\n', '')
    await pending
    jest.advanceTimersByTime(1000)

    expect(c.getCurrentLockState()).toBe('locked')
    expect(createdWindows.filter(w => !w.isDestroyed()).length).toBe(displays.length)
  })

  it('unlocks only on an OK verdict', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    const pending = c.unlock(LOCK_CONFIG)
    await flush()
    execFileCallback!(null, 'OK\n', '')
    await pending
    jest.advanceTimersByTime(600)

    expect(c.getCurrentLockState()).toBe('unlocked')
  })

  it('re-shields every display after a failed attempt', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)

    const pending = c.unlock(LOCK_CONFIG)
    await flush()
    // Primary is deliberately unshielded so the credential dialog is usable.
    const primaryWin = createdWindows.find(w => w.__displayId === PRIMARY.id)!
    expect(primaryWin.kiosk).toBe(false)
    // Secondary must stay shielded throughout — this was the reported leak.
    const secondaryWin = createdWindows.find(w => w.__displayId === SECONDARY.id)!
    expect(secondaryWin.kiosk).toBe(true)

    execFileCallback!(null, 'BAD\n', '')
    await pending

    expect(primaryWin.kiosk).toBe(true)
    expect(primaryWin.alwaysOnTopLevel).toBe('screen-saver')
  })

  it('bounds the fail-open window to 30s or less', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)
    void c.unlock(LOCK_CONFIG)
    await flush()

    // The primary cover is down for the whole lifetime of this call, so the
    // timeout IS the maximum exposure of a live desktop.
    expect(execFileOptions).not.toBeNull()
    expect(typeof execFileOptions!.timeout).toBe('number')
    expect(execFileOptions!.timeout as number).toBeLessThanOrEqual(30_000)
  })

  it('rejects an empty password inside the helper script before any validation', async () => {
    const c = loadController()
    await c.lock(LOCK_CONFIG)
    void c.unlock(LOCK_CONFIG)
    await flush()

    const scriptPath = execFileScriptArgs!.find(a => a.endsWith('.ps1'))!
    const script = require('fs').readFileSync(scriptPath, 'utf-8') as string
    const guard = script.indexOf('IsNullOrEmpty($password)')
    const firstValidation = script.indexOf('$ctx.ValidateCredentials')
    expect(guard).toBeGreaterThan(-1)
    expect(firstValidation).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstValidation)
  })
})

// ---------------------------------------------------------------------------
// Teardown — close() is a no-op on these windows
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('destroys covers rather than calling the no-op close()', async () => {
    const c = loadController()
    await c.lock(NO_AUTH_CONFIG)
    const covers = createdWindows.filter(w => !w.isDestroyed())
    expect(covers.length).toBeGreaterThan(0)

    await c.unlock(NO_AUTH_CONFIG)
    jest.advanceTimersByTime(600)

    for (const win of covers) {
      expect(win.destroyCalls).toBeGreaterThan(0)
      expect(win.isDestroyed()).toBe(true)
    }
    expect(c.getCurrentLockState()).toBe('unlocked')
  })

  it('never shows a cover once the screen is already unlocked', async () => {
    const c = loadController()
    await c.lock(NO_AUTH_CONFIG)

    // A display is attached, and its cover is still loading when the user
    // unlocks. The continuation must not shield-and-show onto a live desktop.
    loadFileBehaviour = 'defer'
    const THIRD: DisplayLike = { id: 3, bounds: { x: 3840, y: 0, width: 1920, height: 1080 } }
    displays = [PRIMARY, SECONDARY, THIRD]
    fireScreenEvent('display-added')
    await flush()

    const thirdWin = createdWindows.find(w => w.__displayId === THIRD.id)!
    expect(thirdWin.shown).toBe(false)

    await c.unlock(NO_AUTH_CONFIG)
    jest.advanceTimersByTime(600)
    expect(c.getCurrentLockState()).toBe('unlocked')

    // Now let the pending load finish.
    deferredLoads.forEach(resolve => resolve())
    await flush()

    expect(thirdWin.shown).toBe(false)
    expect(thirdWin.isDestroyed()).toBe(true)
  })
})
