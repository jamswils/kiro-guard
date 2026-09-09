const exposeInMainWorldMock = jest.fn()
const sendMock = jest.fn()
const onMock = jest.fn()
const removeListenerMock = jest.fn()

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: {
    send: sendMock,
    on: onMock,
    removeListener: removeListenerMock,
  },
}))

import { IPC_CHANNELS } from '../../src/shared/ipc'

describe('preload IPC bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.isolateModules(() => {
      require('../../src/main/preload')
    })
  })

  function exposedApi(): {
    onStatusUpdate(handler: (payload: unknown) => void): () => void
    moveWindow(payload: unknown): void
  } {
    const [, api] = exposeInMainWorldMock.mock.calls[0]
    return api
  }

  it('exposes kiroBuddy API with status, move-window, and lock methods', () => {
    expect(exposeInMainWorldMock).toHaveBeenCalledWith('kiroBuddy', expect.any(Object))
    expect(Object.keys(exposedApi()).sort()).toEqual([
      'getLockState',
      'moveWindow',
      'onLockState',
      'onStatusUpdate',
      'toggleLock',
    ])
  })

  it.each(['setLockConfig', 'getConfig', 'lock', 'unlock'])(
    'does not expose %s to the renderer',
    (method) => {
      // These four formed a password-bypass chain reachable from the lock
      // screen, which shares this preload: setLockConfig({ requireAuth:
      // false }) persisted to disk, then unlock() took the no-auth path.
      // getConfig additionally leaked absolute filesystem paths. Settings are
      // owned by the tray in the main process. If a settings UI is ever added
      // to a renderer, do NOT re-add these — pass a validated, narrowly typed
      // channel instead, and re-check this test on purpose.
      expect(exposedApi()).not.toHaveProperty(method)
    },
  )

  it('sends only valid move-window payloads', () => {
    const api = exposedApi()

    api.moveWindow({ x: 10, y: 20 })
    api.moveWindow({ x: 10, y: 20, extra: true })
    api.moveWindow({ x: Number.NaN, y: 20 })

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(IPC_CHANNELS.moveWindow, { x: 10, y: 20 })
  })

  it('subscribes to status-update and unregisters the same listener', () => {
    const api = exposedApi()
    const handler = jest.fn()
    const unsubscribe = api.onStatusUpdate(handler)
    const listener = onMock.mock.calls[0][1]

    listener({}, { status: 'idle', message: 'ready', timestamp: 1 })
    unsubscribe()

    expect(onMock).toHaveBeenCalledWith(IPC_CHANNELS.statusUpdate, listener)
    expect(handler).toHaveBeenCalledWith({ status: 'idle', message: 'ready', timestamp: 1 })
    expect(removeListenerMock).toHaveBeenCalledWith(IPC_CHANNELS.statusUpdate, listener)
  })

  it('drops malformed status-update payloads before renderer callbacks', () => {
    const api = exposedApi()
    const handler = jest.fn()
    api.onStatusUpdate(handler)
    const listener = onMock.mock.calls[0][1]

    listener({}, { status: 'idle', message: '', timestamp: 1 })
    listener({}, { status: 'idle', message: 'ready', timestamp: 1 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ status: 'idle', message: 'ready', timestamp: 1 })
  })
})
