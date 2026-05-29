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
    // 4 fire-and-forget channels
    expect(ipcMain.on).toHaveBeenCalledTimes(4)
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.lockRequest, expect.any(Function))
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.unlockRequest, expect.any(Function))
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.toggleLock, expect.any(Function))
    expect(ipcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.setLockConfig, expect.any(Function))

    // 2 invoke handlers
    expect(ipcMain.handle).toHaveBeenCalledTimes(2)
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.getLockState, expect.any(Function))
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.getConfig, expect.any(Function))
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

  it('getConfig returns the current configuration', () => {
    const handler = handlers.get(IPC_CHANNELS.getConfig)
    const result = handler!({}, undefined) as any
    expect(result.lock.hotkey).toBe('Control+Shift+L')
  })
})
