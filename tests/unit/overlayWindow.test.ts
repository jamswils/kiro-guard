/**
 * Unit tests for `overlayWindow`
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 10.1, 10.2, 11.1
 *
 * Requirement 1.1: BrowserWindow created with alwaysOnTop: true, transparent: true, frame: false, skipTaskbar: true
 * Requirement 1.2: Window dimensions are 120×120
 * Requirement 1.3: Position restored from configStore on creation
 * Requirement 1.4: Default position (100, 100) used when no saved position exists
 * Requirement 10.1: Retry logic — retry after 2000ms on BrowserWindow creation failure
 * Requirement 10.2: After 3 failures, call app.exit(1)
 * Requirement 11.1: webPreferences has contextIsolation: true, nodeIntegration: false
 */

// ---------------------------------------------------------------------------
// Mocks — jest.mock() is hoisted, so factories must be self-contained.
// We use jest.fn() inside the factory and retrieve the mocks via the mocked
// module imports below.
// ---------------------------------------------------------------------------

jest.mock('electron', () => {
  const mockInstance = {
    setPosition: jest.fn(),
    setIgnoreMouseEvents: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    setFullScreenable: jest.fn(),
    setVisibleOnAllWorkspaces: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
  }
  const MockBrowserWindow = jest.fn(() => mockInstance)
  // Attach the instance to the constructor so tests can access it
  ;(MockBrowserWindow as unknown as { _instance: typeof mockInstance })._instance = mockInstance

  return {
    BrowserWindow: MockBrowserWindow,
    app: { exit: jest.fn() },
  }
})

jest.mock('../../src/main/configStore', () => ({
  getConfig: jest.fn(() => ({
    window: { x: 100, y: 100, width: 120, height: 120 },
    statusFilePath: '/home/user/.kiro/status.json',
    notifications: { enabled: true, onDone: true, onError: true },
    clickThrough: false,
    pollIntervalMs: 500,
  })),
  setWindowPosition: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import { BrowserWindow, app } from 'electron'
import { getConfig } from '../../src/main/configStore'

// ---------------------------------------------------------------------------
// Typed helpers to access the mocks
// ---------------------------------------------------------------------------

const MockBrowserWindow = BrowserWindow as unknown as jest.Mock
const mockAppExit = app.exit as jest.Mock
const mockGetConfig = getConfig as jest.Mock

// ---------------------------------------------------------------------------
// Default config used in most tests
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  width: 120,
  height: 120,
  x: 0,   // will be overridden by configStore
  y: 0,
  alwaysOnTop: true,
  transparent: true,
  frame: false,
  skipTaskbar: true,
}

// ---------------------------------------------------------------------------
// Helper: fresh overlayWindow module (resets module-level `win` variable)
// ---------------------------------------------------------------------------

function getOverlayWindow() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../src/main/overlayWindow').overlayWindow
}

// ---------------------------------------------------------------------------
// Requirement 1.1 — Overlay window properties
// ---------------------------------------------------------------------------

describe('overlayWindow.create — window properties (Req 1.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    MockBrowserWindow.mockImplementation(() => ({
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      setFullScreenable: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }))
  })

  it('creates BrowserWindow with alwaysOnTop: true', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.alwaysOnTop).toBe(true)
  })

  it('creates BrowserWindow with transparent: true', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.transparent).toBe(true)
  })

  it('creates BrowserWindow with frame: false', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.frame).toBe(false)
  })

  it('creates BrowserWindow with skipTaskbar: true', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.skipTaskbar).toBe(true)
  })

  it('configures macOS fullscreen Spaces visibility', () => {
    const macWindow = {
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      setFullScreenable: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { configureMacFullscreenOverlay } = require('../../src/main/overlayWindow')
    configureMacFullscreenOverlay(macWindow, 'darwin')

    expect(macWindow.setFullScreenable).toHaveBeenCalledWith(false)
    expect(macWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    expect(macWindow.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver', 1)
  })

  it('uses macOS panel options for fullscreen overlays', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { macFullscreenOverlayOptions } = require('../../src/main/overlayWindow')

    expect(macFullscreenOverlayOptions('darwin')).toEqual({
      type: 'panel',
      show: false,
      fullscreenable: false,
      hiddenInMissionControl: true,
    })
  })

  it('does not apply macOS panel options on other platforms', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { macFullscreenOverlayOptions } = require('../../src/main/overlayWindow')

    expect(macFullscreenOverlayOptions('win32')).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Requirement 1.2 — Window dimensions
// ---------------------------------------------------------------------------

describe('overlayWindow.create — window dimensions (Req 1.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    MockBrowserWindow.mockImplementation(() => ({
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      setFullScreenable: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }))
  })

  it('creates BrowserWindow with width 120', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.width).toBe(120)
  })

  it('creates BrowserWindow with height 120', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.height).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// Requirement 11.1 — webPreferences security settings
// ---------------------------------------------------------------------------

describe('overlayWindow.create — webPreferences (Req 11.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    MockBrowserWindow.mockImplementation(() => ({
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      setFullScreenable: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }))
  })

  it('creates BrowserWindow with contextIsolation: true', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.webPreferences.contextIsolation).toBe(true)
  })

  it('creates BrowserWindow with nodeIntegration: false', () => {
    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)
    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.webPreferences.nodeIntegration).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Requirements 1.3, 1.4 — Position restore from configStore
// ---------------------------------------------------------------------------

describe('overlayWindow.create — position restore (Req 1.3, 1.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    MockBrowserWindow.mockImplementation(() => ({
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      setAlwaysOnTop: jest.fn(),
      setFullScreenable: jest.fn(),
      setVisibleOnAllWorkspaces: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }))
  })

  it('uses saved position (200, 300) from configStore', () => {
    mockGetConfig.mockReturnValue({
      window: { x: 200, y: 300, width: 120, height: 120 },
      statusFilePath: '/home/user/.kiro/status.json',
      notifications: { enabled: true, onDone: true, onError: true },
      clickThrough: false,
      pollIntervalMs: 500,
    })

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.x).toBe(200)
    expect(opts.y).toBe(300)
  })

  it('uses saved position (0, 0) from configStore', () => {
    mockGetConfig.mockReturnValue({
      window: { x: 0, y: 0, width: 120, height: 120 },
      statusFilePath: '/home/user/.kiro/status.json',
      notifications: { enabled: true, onDone: true, onError: true },
      clickThrough: false,
      pollIntervalMs: 500,
    })

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.x).toBe(0)
    expect(opts.y).toBe(0)
  })

  it('falls back to default position (100, 100) when configStore returns defaults', () => {
    // configStore default is (100, 100) — this is the "no saved position" case
    mockGetConfig.mockReturnValue({
      window: { x: 100, y: 100, width: 120, height: 120 },
      statusFilePath: '/home/user/.kiro/status.json',
      notifications: { enabled: true, onDone: true, onError: true },
      clickThrough: false,
      pollIntervalMs: 500,
    })

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.x).toBe(100)
    expect(opts.y).toBe(100)
  })

  it('overrides the x/y from the passed config with the saved position', () => {
    mockGetConfig.mockReturnValue({
      window: { x: 500, y: 600, width: 120, height: 120 },
      statusFilePath: '/home/user/.kiro/status.json',
      notifications: { enabled: true, onDone: true, onError: true },
      clickThrough: false,
      pollIntervalMs: 500,
    })

    const ow = getOverlayWindow()
    // Pass a different x/y in the config — should be overridden by saved position
    ow.create({ ...BASE_CONFIG, x: 10, y: 20 })

    const [opts] = MockBrowserWindow.mock.calls[0]
    expect(opts.x).toBe(500)
    expect(opts.y).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// Requirements 10.1, 10.2 — Retry logic on BrowserWindow creation failure
// ---------------------------------------------------------------------------

describe('overlayWindow.create — retry logic (Req 10.1, 10.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockGetConfig.mockReturnValue({
      window: { x: 100, y: 100, width: 120, height: 120 },
      statusFilePath: '/home/user/.kiro/status.json',
      notifications: { enabled: true, onDone: true, onError: true },
      clickThrough: false,
      pollIntervalMs: 500,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('retries after 2000ms when BrowserWindow constructor throws on first attempt', () => {
    const successInstance = {
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }
    // Fail once, then succeed
    MockBrowserWindow
      .mockImplementationOnce(() => { throw new Error('GPU crash') })
      .mockImplementation(() => successInstance)

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    // First attempt failed — constructor called once
    expect(MockBrowserWindow).toHaveBeenCalledTimes(1)

    // Advance time by 2000ms to trigger the retry
    jest.advanceTimersByTime(2000)

    // Second attempt should have been made
    expect(MockBrowserWindow).toHaveBeenCalledTimes(2)
    // app.exit should NOT have been called
    expect(mockAppExit).not.toHaveBeenCalled()
  })

  it('retries a second time after another 2000ms when second attempt also fails', () => {
    const successInstance = {
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }
    // Fail twice, then succeed
    MockBrowserWindow
      .mockImplementationOnce(() => { throw new Error('GPU crash') })
      .mockImplementationOnce(() => { throw new Error('GPU crash again') })
      .mockImplementation(() => successInstance)

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    expect(MockBrowserWindow).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(2000)
    expect(MockBrowserWindow).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(2000)
    expect(MockBrowserWindow).toHaveBeenCalledTimes(3)

    expect(mockAppExit).not.toHaveBeenCalled()
  })

  it('calls app.exit(1) after 3 consecutive failures (Req 10.2)', () => {
    // Fail all 3 attempts
    MockBrowserWindow.mockImplementation(() => {
      throw new Error('Persistent GPU crash')
    })

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    // Attempt 1 fails immediately
    expect(MockBrowserWindow).toHaveBeenCalledTimes(1)
    expect(mockAppExit).not.toHaveBeenCalled()

    // Attempt 2 after 2000ms
    jest.advanceTimersByTime(2000)
    expect(MockBrowserWindow).toHaveBeenCalledTimes(2)
    expect(mockAppExit).not.toHaveBeenCalled()

    // Attempt 3 after another 2000ms
    jest.advanceTimersByTime(2000)
    expect(MockBrowserWindow).toHaveBeenCalledTimes(3)

    // All retries exhausted — app.exit(1) must be called
    expect(mockAppExit).toHaveBeenCalledWith(1)
  })

  it('does not call app.exit(1) when creation succeeds on the first attempt', () => {
    MockBrowserWindow.mockImplementation(() => ({
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }))

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    jest.advanceTimersByTime(10000)

    expect(mockAppExit).not.toHaveBeenCalled()
  })

  it('does not call app.exit(1) when creation succeeds on the second attempt', () => {
    const successInstance = {
      setPosition: jest.fn(),
      setIgnoreMouseEvents: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      isDestroyed: jest.fn(() => false),
      isVisible: jest.fn(() => true),
      on: jest.fn(),
    }
    MockBrowserWindow
      .mockImplementationOnce(() => { throw new Error('transient error') })
      .mockImplementation(() => successInstance)

    const ow = getOverlayWindow()
    ow.create(BASE_CONFIG)

    jest.advanceTimersByTime(2000)

    expect(mockAppExit).not.toHaveBeenCalled()
  })
})
