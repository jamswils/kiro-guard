/**
 * v1.1.0 lock controller behaviour:
 *   A. passphrase unlock — accept, reject, cooldown, recovery offered after 5,
 *      recovery answer accepted, refused when mode is not passphrase
 *   B. keep the work running — layered 0.99 cover, no background throttling,
 *      both power blockers started and stopped
 *   C. KiroCrew feed — started on lock, snapshots broadcast to covers, stopped
 *      on unlock; never started when index.ts has not configured it
 */

type DisplayLike = { id: number; bounds: { x: number; y: number; width: number; height: number } }
const PRIMARY: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
let displays: DisplayLike[] = [PRIMARY]

const createdWindows: FakeBrowserWindow[] = []
class FakeBrowserWindow {
  options: Record<string, unknown>
  destroyed = false
  webContents = { send: jest.fn(), on: jest.fn() }
  __displayId?: number
  constructor(options: Record<string, unknown>) { this.options = options; createdWindows.push(this) }
  setAlwaysOnTop(): void {}
  setKiosk(): void {}
  loadFile(): Promise<void> { return Promise.resolve() }
  show(): void {} focus(): void {} hide(): void {} moveTop(): void {}
  close(): void { this.destroyed = true }
  destroy(): void { this.destroyed = true }
  isDestroyed(): boolean { return this.destroyed }
}

const blockers = { started: [] as string[], stopped: [] as number[], alive: new Set<number>() }
let nextBlockerId = 100
jest.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  screen: { getAllDisplays: jest.fn(() => displays), getPrimaryDisplay: jest.fn(() => PRIMARY), on: jest.fn() },
  globalShortcut: { register: jest.fn(() => true), unregisterAll: jest.fn() },
  powerSaveBlocker: {
    start: jest.fn((type: string) => { blockers.started.push(type); const id = nextBlockerId++; blockers.alive.add(id); return id }),
    stop: jest.fn((id: number) => { blockers.stopped.push(id); blockers.alive.delete(id) }),
    isStarted: jest.fn((id: number) => blockers.alive.has(id)),
  },
  app: {},
}))
jest.mock('../../src/main/statusManager', () => ({
  statusManager: { getCurrentStatus: jest.fn(() => ({ status: 'idle' })), onStatusChange: jest.fn() },
}))
jest.mock('child_process', () => ({ execFile: jest.fn() }))

import {
  lock, quickUnlock, unlockWithPassphrase, getCurrentLockState, configureKiroCrewFeed,
  RECOVERY_AFTER_FAILURES, LOCK_WINDOW_OPACITY, BLOCKER_RENEW_MS,
} from '../../src/main/lockController'
import { makeVerifier, makeRecovery } from '../../src/main/passphrase'
import { KiroCrewFeed, type PulseSnapshot } from '../../src/main/kirocrewFeed'
import type { LockConfig, KiroCrewFeedConfig } from '../../src/shared/types'
import { IPC_CHANNELS } from '../../src/shared/ipc'

const IT = 2_000
const PASS = 'open sesame 42'
const CFG: LockConfig = {
  hotkey: 'Control+Shift+L', requireAuth: true, authMode: 'passphrase',
  passphrase: makeVerifier(PASS, IT), recovery: makeRecovery("Mother's maiden name", 'Van Der Berg', IT),
  autoLockOnAgentStart: false, showElapsedTime: true, lockMessage: 'locked',
}

function sends(event: string): unknown[] {
  return createdWindows.flatMap(w => w.webContents.send.mock.calls.filter(c => c[0] === event).map(c => c[1]))
}
function lastError(): string | undefined { const e = sends('auth-error'); return e[e.length - 1] as string | undefined }

async function settle(): Promise<void> {
  if (getCurrentLockState() === 'locked') { quickUnlock(); jest.advanceTimersByTime(700) }
}

beforeEach(() => {
  jest.useFakeTimers()
  createdWindows.length = 0
  blockers.started.length = 0; blockers.stopped.length = 0; blockers.alive.clear()
  configureKiroCrewFeed(() => ({ enabled: false, source: 'ssh', sshHost: '', remoteScript: '', statusFile: '', intervalMs: 10_000 }))
})
afterEach(async () => { await settle(); jest.useRealTimers() })

describe('A. passphrase unlock', () => {
  it('correct passphrase unlocks', async () => {
    await lock(CFG)
    expect(unlockWithPassphrase(CFG, PASS)).toBe(true)
    expect(sends('unlock-success').length).toBe(1)
    jest.advanceTimersByTime(700)
    expect(getCurrentLockState()).toBe('unlocked')
  })

  it('wrong passphrase stays locked with an error; recovery is NOT offered early', async () => {
    await lock(CFG)
    expect(unlockWithPassphrase(CFG, 'nope')).toBe(false)
    expect(getCurrentLockState()).toBe('locked')
    expect(lastError()).toMatch(/Incorrect passphrase/)
    expect(sends('recovery-offered').length).toBe(0)
    // the recovery answer alone must not work before it is offered
    expect(unlockWithPassphrase(CFG, 'vanderberg')).toBe(false)
  })

  it('cooldown after 3 failures, recovery question after 5, then the answer unlocks', async () => {
    await lock(CFG)
    for (let i = 0; i < 3; i++) unlockWithPassphrase(CFG, 'wrong')
    expect(unlockWithPassphrase(CFG, PASS)).toBe(false)          // in cooldown, even the right one
    expect(lastError()).toMatch(/Too many failed attempts/)
    // After the first cooldown, every further failure re-arms a 30s wait: one
    // guess per half-minute. Failure 4, wait, failure 5 -> recovery offered.
    jest.advanceTimersByTime(30_001)
    unlockWithPassphrase(CFG, 'wrong')                            // failure 4
    expect(sends('recovery-offered').length).toBe(0)
    unlockWithPassphrase(CFG, 'wrong')                            // still cooling down: not counted
    expect(lastError()).toMatch(/Too many failed attempts/)
    jest.advanceTimersByTime(30_001)
    unlockWithPassphrase(CFG, 'wrong')                            // failure 5
    expect(sends('recovery-offered')).toEqual(["Mother's maiden name"])
    expect(lastError()).toMatch(/answer to the question/)
    expect(RECOVERY_AFTER_FAILURES).toBe(5)
    jest.advanceTimersByTime(30_001)                              // cooldown lifts, the offer stays
    expect(unlockWithPassphrase(CFG, 'VAN der Berg')).toBe(true)
    jest.advanceTimersByTime(700)
    expect(getCurrentLockState()).toBe('unlocked')
  })

  it('refuses when the config is not in passphrase mode or has no verifier', async () => {
    await lock(CFG)
    expect(unlockWithPassphrase({ ...CFG, authMode: 'windows' }, PASS)).toBe(false)
    expect(unlockWithPassphrase({ ...CFG, passphrase: undefined }, PASS)).toBe(false)
    expect(lastError()).toMatch(/not enabled/)
    expect(getCurrentLockState()).toBe('locked')
  })

  it('does nothing when not locked', () => {
    expect(getCurrentLockState()).toBe('unlocked')
    expect(unlockWithPassphrase(CFG, PASS)).toBe(false)
  })
})

describe('B. keep the work running', () => {
  it('cover is a layered 0.99 window with background throttling off', async () => {
    await lock(CFG)
    expect(LOCK_WINDOW_OPACITY).toBe(0.99)
    const opts = createdWindows[0].options
    expect(opts.opacity).toBe(0.99)
    expect((opts.webPreferences as Record<string, unknown>).backgroundThrottling).toBe(false)
  })

  it('starts display-sleep AND app-suspension blockers, renews them, and stops both on unlock', async () => {
    await lock(CFG)
    expect(blockers.started).toEqual(['prevent-display-sleep', 'prevent-app-suspension'])
    // something external clears one -> the renew tick re-asserts it
    blockers.alive.clear()
    jest.advanceTimersByTime(BLOCKER_RENEW_MS)
    expect(blockers.started.length).toBe(4)
    quickUnlock(); jest.advanceTimersByTime(700)
    expect(blockers.alive.size).toBe(0)
    expect(blockers.stopped.length).toBeGreaterThanOrEqual(2)
  })
})

describe('C. KiroCrew feed lifecycle', () => {
  class FakeFeed extends KiroCrewFeed {
    starts = 0; stops = 0
    constructor(getCfg: () => KiroCrewFeedConfig, private readonly emit: (s: PulseSnapshot) => void) { super(getCfg, emit) }
    start(): void { this.starts++ }
    stop(): void { this.stops++ }
    push(s: PulseSnapshot): void { this.latest = s; this.emit(s) }
  }
  const SNAP: PulseSnapshot = {
    generatedAt: 1, receivedAt: 2, headline: 'KiroCrew is working', chatsActive: 1, agentsRunning: 2,
    turnsLast10m: 3, lastMessageAgeS: 4, chats: [], lines: [],
  }

  it('starts on lock, broadcasts snapshots to every cover, stops on unlock', async () => {
    let feed: FakeFeed | null = null
    configureKiroCrewFeed(
      () => ({ enabled: true, source: 'ssh', sshHost: 'h', remoteScript: 'p', statusFile: '', intervalMs: 10_000 }),
      (getCfg, onSnap) => { feed = new FakeFeed(getCfg, onSnap); return feed },
    )
    await lock(CFG)
    expect(feed!.starts).toBe(1)
    // lock-init tells the cover a feed is expected
    expect((sends('lock-init')[0] as { kirocrewEnabled: boolean }).kirocrewEnabled).toBe(true)
    feed!.push(SNAP)
    expect(sends(IPC_CHANNELS.kirocrewPulse)).toEqual([SNAP])
    quickUnlock(); jest.advanceTimersByTime(700)
    expect(feed!.stops).toBe(1)
  })

  it('a newly attached display receives the latest snapshot immediately', async () => {
    let feed: FakeFeed | null = null
    configureKiroCrewFeed(
      () => ({ enabled: true, source: 'ssh', sshHost: 'h', remoteScript: 'p', statusFile: '', intervalMs: 10_000 }),
      (getCfg, onSnap) => { feed = new FakeFeed(getCfg, onSnap); return feed },
    )
    await lock(CFG)
    feed!.push(SNAP)
    const { screen } = jest.requireMock('electron') as { screen: { on: jest.Mock } }
    const added = screen.on.mock.calls.find(c => c[0] === 'display-added')?.[1] as (() => Promise<void>) | undefined
    expect(added).toBeDefined()
    displays = [PRIMARY, { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }]
    await added!()
    const second = createdWindows.find(w => w.__displayId === 2)!
    expect(second.webContents.send.mock.calls.some(c => c[0] === IPC_CHANNELS.kirocrewPulse)).toBe(true)
    displays = [PRIMARY]
  })

  it('lock-init reports kirocrewEnabled=false when the feed is off', async () => {
    await lock(CFG)
    expect((sends('lock-init')[0] as { kirocrewEnabled: boolean; authMode: string }).kirocrewEnabled).toBe(false)
    expect((sends('lock-init')[0] as { authMode: string }).authMode).toBe('passphrase')
  })
})
