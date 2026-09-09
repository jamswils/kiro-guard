const listeners = new Map<string, (_event: unknown, payload: unknown) => void>()
const handlers = new Map<string, (_event: unknown, payload?: unknown) => unknown>()
const warnMock = jest.spyOn(console, 'warn').mockImplementation(() => {})

jest.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: jest.fn((channel: string) => listeners.delete(channel)),
    removeHandler: jest.fn((channel: string) => handlers.delete(channel)),
    on: jest.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
      listeners.set(channel, handler)
    }),
    handle: jest.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
  },
}))

jest.mock('../../src/main/configStore', () => ({
  getConfig: jest.fn(() => ({
    window: { x: 100, y: 100, width: 360, height: 300 },
    statusFilePath: 'C:\\Users\\test\\.kiro\\status.json',
    notifications: { enabled: true, onDone: true, onError: true },
    clickThrough: false,
    pollIntervalMs: 500,
    petScale: 1,
    lock: {
      hotkey: 'Control+Shift+L',
      requireAuth: false,
      authMode: 'none',
      autoLockOnAgentStart: false,
      showElapsedTime: true,
      lockMessage: 'Screen locked.',
    },
  })),
  setLockConfig: jest.fn(),
}))

const lockMock = jest.fn()
const unlockMock = jest.fn()
const quickUnlockMock = jest.fn()
let mockLockState: 'unlocked' | 'locked' = 'unlocked'

jest.mock('../../src/main/lockController', () => ({
  lock: lockMock,
  unlock: unlockMock,
  quickUnlock: quickUnlockMock,
  unlockWithPassphrase: jest.fn(),
  getCurrentLockState: jest.fn(() => mockLockState),
  getLockedAt: jest.fn(() => undefined),
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from '../../src/main/ipcHandlers'
import { IPC_CHANNELS } from '../../src/shared/ipc'

describe('registerIpcHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    listeners.clear()
    handlers.clear()
    mockLockState = 'unlocked'
    registerIpcHandlers()
  })

  afterAll(() => {
    warnMock.mockRestore()
  })

  it('registers all required IPC channels for lock control', () => {
    // 3 fire-and-forget channels. setLockConfig is deliberately absent — see
    // the dedicated test below.
    // lockRequest, unlockRequest, unlockWithPassphrase, toggleLock
    expect(ipcMain.on).toHaveBeenCalledTimes(4)
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.lockRequest, expect.any(Function))
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.unlockRequest, expect.any(Function))
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.toggleLock, expect.any(Function))

    // 1 invoke handler. getConfig is deliberately absent — see below.
    expect(ipcMain.handle).toHaveBeenCalledTimes(1)
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.getLockState, expect.any(Function))
  })

  it('does not register the renderer-writable config channel', () => {
    // setLockConfig previously accepted any object from any renderer
    // (validated only as `typeof === 'object'`, then cast through `as any`)
    // and persisted it — so a renderer could set requireAuth: false and then
    // unlock with no password, or write a garbage hotkey that silently killed
    // the lock accelerator on next launch. The tray calls setLockConfig()
    // in-process; no renderer needs this channel.
    expect(listeners.has(IPC_CHANNELS.setLockConfig)).toBe(false)
    expect(ipcMain.on).not.toHaveBeenCalledWith(
      IPC_CHANNELS.setLockConfig,
      expect.any(Function),
    )
  })

  it('does not register the config-read channel', () => {
    // getConfig returned the whole AppConfig, including the absolute
    // statusFilePath, to a renderer that never used it.
    expect(handlers.has(IPC_CHANNELS.getConfig)).toBe(false)
    expect(ipcMain.handle).not.toHaveBeenCalledWith(
      IPC_CHANNELS.getConfig,
      expect.any(Function),
    )
  })

  it('does not register the retired move-window channel', () => {
    expect(listeners.has(IPC_CHANNELS.moveWindow)).toBe(false)
  })

  it('lockRequest invokes lock() with the current lock config', async () => {
    const handler = listeners.get(IPC_CHANNELS.lockRequest)
    expect(handler).toBeDefined()
    await handler!({}, undefined)
    expect(lockMock).toHaveBeenCalledTimes(1)
    expect(lockMock.mock.calls[0][0]).toMatchObject({ hotkey: 'Control+Shift+L' })
  })

  it('unlockRequest calls quickUnlock when requireAuth is false', async () => {
    const handler = listeners.get(IPC_CHANNELS.unlockRequest)
    await handler!({}, undefined)
    expect(quickUnlockMock).toHaveBeenCalledTimes(1)
    expect(unlockMock).not.toHaveBeenCalled()
  })

  it('toggleLock locks when unlocked and unlocks when locked', async () => {
    const handler = listeners.get(IPC_CHANNELS.toggleLock)
    expect(handler).toBeDefined()

    // Unlocked -> lock
    mockLockState = 'unlocked'
    await handler!({}, undefined)
    expect(lockMock).toHaveBeenCalledTimes(1)

    // Locked -> quickUnlock (requireAuth: false)
    mockLockState = 'locked'
    await handler!({}, undefined)
    expect(quickUnlockMock).toHaveBeenCalledTimes(1)
  })

  it('getLockState returns current state and lockedAt', () => {
    const handler = handlers.get(IPC_CHANNELS.getLockState)
    expect(handler).toBeDefined()
    const result = handler!({}, undefined)
    expect(result).toEqual({ state: 'unlocked', lockedAt: undefined })
  })

  it('getConfig is not reachable from a renderer', () => {
    expect(handlers.get(IPC_CHANNELS.getConfig)).toBeUndefined()
  })
})
