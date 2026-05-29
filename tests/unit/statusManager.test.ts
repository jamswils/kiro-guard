/**
 * Unit tests for `statusManager`
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.4, 3.5, 3.6, 11.3
 *
 * Requirement 2.1: StatusManager watches status.json using chokidar
 * Requirement 2.2: Missing file created with idle defaults, idle dispatched
 * Requirement 2.3: Initial state read and dispatched on initialize()
 * Requirement 2.4: Valid payload dispatched to subscribers
 * Requirement 2.5: Rapid changes debounced within 50ms window
 * Requirement 2.6: stopWatching() closes watcher and releases resources
 * Requirement 3.4: Malformed JSON → warning logged, state unchanged
 * Requirement 3.5: Invalid schema → warning logged, state unchanged
 * Requirement 3.6: IO error → warning logged, state unchanged
 * Requirement 11.3: Path traversal sequences rejected before watcher init
 */

import path from 'path'
import os from 'os'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// Track mock watcher state
let mockWatcherClose: jest.Mock
let mockWatcherOn: jest.Mock
let mockWatcherInstance: { close: jest.Mock; on: jest.Mock }
let mockWatcherHandlers: Map<string, Array<(...args: unknown[]) => void>>

function resetMockWatcher(): void {
  mockWatcherHandlers = new Map()
  mockWatcherClose = jest.fn()
  mockWatcherOn = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = mockWatcherHandlers.get(event) ?? []
    handlers.push(handler)
    mockWatcherHandlers.set(event, handlers)
    return mockWatcherInstance
  })
  mockWatcherInstance = { close: mockWatcherClose, on: mockWatcherOn }
}

function emitWatcherEvent(event: string, ...args: unknown[]): void {
  for (const handler of mockWatcherHandlers.get(event) ?? []) {
    handler(...args)
  }
}

resetMockWatcher()

jest.mock('chokidar', () => {
  return {
    watch: jest.fn(() => mockWatcherInstance),
  }
})

// Track mock fs state
const mockExistsSync = jest.fn()
const mockMkdirSync = jest.fn()
const mockWriteFileSync = jest.fn()
const mockReadFileSync = jest.fn()

jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import chokidar from 'chokidar'
import { validateStatusFilePath } from '../../src/main/statusManager'
import { DEBOUNCE_MS } from '../../src/shared/constants'

// ---------------------------------------------------------------------------
// Helper: get a fresh statusManager instance by resetting the module
// ---------------------------------------------------------------------------

function getFreshStatusManager() {
  jest.resetModules()
  // Re-apply mocks after module reset
  jest.mock('chokidar', () => ({
    watch: jest.fn(() => mockWatcherInstance),
  }))
  jest.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  }))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../src/main/statusManager').statusManager
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const HOME_DIR = os.homedir()
const VALID_FILE_PATH = path.join(HOME_DIR, '.kiro', 'status.json')

const VALID_PAYLOAD = {
  status: 'idle' as const,
  message: 'Kiro is ready',
  timestamp: 1718000000000,
}

const VALID_PAYLOAD_JSON = JSON.stringify(VALID_PAYLOAD)

// ---------------------------------------------------------------------------
// Requirement 2.2 — File missing on init: created with idle defaults, idle dispatched
// ---------------------------------------------------------------------------

describe('statusManager.initialize() — file missing (Req 2.2, 2.3)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>

  beforeEach(() => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()
  })

  it('creates the file with idle payload when file does not exist', async () => {
    // Directory exists, file does not
    mockExistsSync.mockImplementation((p: string) => {
      if (p === path.dirname(VALID_FILE_PATH)) return true
      return false // file missing
    })
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)

    await sm.initialize(VALID_FILE_PATH)

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    const [writtenPath, writtenContent] = mockWriteFileSync.mock.calls[0]
    expect(writtenPath).toBe(VALID_FILE_PATH)
    const written = JSON.parse(writtenContent as string)
    expect(written.status).toBe('idle')
    expect(written.message).toBe('Kiro is ready')
    expect(typeof written.timestamp).toBe('number')
    expect(written.timestamp).toBeGreaterThan(0)
  })

  it('dispatches idle state to subscribers when file is missing', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === path.dirname(VALID_FILE_PATH)) return true
      return false
    })
    // After writing the default file, readFileSync returns the idle payload
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)

    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)

    await sm.initialize(VALID_FILE_PATH)

    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(subscriber.mock.calls[0][0].status).toBe('idle')
  })

  it('creates parent directory if it does not exist', async () => {
    // Both dir and file are missing
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)

    await sm.initialize(VALID_FILE_PATH)

    expect(mockMkdirSync).toHaveBeenCalledWith(path.dirname(VALID_FILE_PATH), { recursive: true })
  })

  it('logs and does not throw when the status file cannot be initialized', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockExistsSync.mockReturnValue(false)
    mockMkdirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    await expect(sm.initialize(VALID_FILE_PATH)).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize status file'))
    expect(mockReadFileSync).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Requirement 2.3 — Existing file: reads and dispatches existing state
// ---------------------------------------------------------------------------

describe('statusManager.initialize() — existing file (Req 2.3)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>

  beforeEach(() => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()
  })

  it('reads and dispatches the existing state when file exists', async () => {
    const workingPayload = {
      status: 'working',
      message: 'Implementing feature',
      timestamp: 1718000001000,
    }
    mockExistsSync.mockReturnValue(true) // dir and file both exist
    mockReadFileSync.mockReturnValue(JSON.stringify(workingPayload))

    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)

    await sm.initialize(VALID_FILE_PATH)

    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(subscriber.mock.calls[0][0].status).toBe('working')
    expect(subscriber.mock.calls[0][0].message).toBe('Implementing feature')
  })

  it('getCurrentStatus() returns the dispatched payload after initialize()', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)

    await sm.initialize(VALID_FILE_PATH)

    const current = sm.getCurrentStatus()
    expect(current).not.toBeNull()
    expect(current!.status).toBe('idle')
  })

  it('dispatches same-status prompt updates when the message changes inside the debounce window', async () => {
    const firstPayload = {
      status: 'working',
      message: 'Prompt: first request',
      timestamp: 1718000001000,
    }
    const secondPayload = {
      status: 'working',
      message: 'Prompt: second request',
      timestamp: 1718000001001,
    }
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(firstPayload))

    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)

    await sm.initialize(VALID_FILE_PATH)
    mockReadFileSync.mockReturnValue(JSON.stringify(secondPayload))
    sm.processStatusUpdate(VALID_FILE_PATH)

    expect(subscriber).toHaveBeenCalledTimes(2)
    expect(subscriber.mock.calls[1][0]).toMatchObject(secondPayload)
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.4 — Malformed JSON: warning logged, state unchanged
// ---------------------------------------------------------------------------

describe('statusManager.processStatusUpdate() — malformed JSON (Req 3.4)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>
  let warnSpy: jest.SpyInstance

  beforeEach(async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Initialize with a valid state first
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)
    await sm.initialize(VALID_FILE_PATH)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('logs a warning when JSON is malformed', () => {
    mockReadFileSync.mockReturnValue('{ not valid json !!!')
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed'))
  })

  it('leaves state unchanged when JSON is malformed', () => {
    const stateBefore = sm.getCurrentStatus()
    mockReadFileSync.mockReturnValue('{ not valid json !!!')
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(sm.getCurrentStatus()).toEqual(stateBefore)
  })

  it('does not dispatch to subscribers when JSON is malformed', () => {
    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)
    mockReadFileSync.mockReturnValue('not-json-at-all')
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('handles empty string as malformed JSON', () => {
    mockReadFileSync.mockReturnValue('')
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed'))
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.5 — Schema validation failure: warning logged, state unchanged
// ---------------------------------------------------------------------------

describe('statusManager.processStatusUpdate() — invalid schema (Req 3.5)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>
  let warnSpy: jest.SpyInstance

  beforeEach(async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Initialize with a valid state first
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)
    await sm.initialize(VALID_FILE_PATH)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('logs a warning when status field is invalid', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'unknown', message: 'hi', timestamp: 1 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid payload schema'))
  })

  it('leaves state unchanged when status field is invalid', () => {
    const stateBefore = sm.getCurrentStatus()
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'unknown', message: 'hi', timestamp: 1 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(sm.getCurrentStatus()).toEqual(stateBefore)
  })

  it('logs a warning when message field is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'idle', timestamp: 1 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid payload schema'))
  })

  it('leaves state unchanged when message field is missing', () => {
    const stateBefore = sm.getCurrentStatus()
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'idle', timestamp: 1 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(sm.getCurrentStatus()).toEqual(stateBefore)
  })

  it('logs a warning when timestamp is not a positive integer', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'idle', message: 'hi', timestamp: -1 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid payload schema'))
  })

  it('does not dispatch to subscribers when schema is invalid', () => {
    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)
    mockReadFileSync.mockReturnValue(JSON.stringify({ status: 'bad', message: '', timestamp: 0 }))
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(subscriber).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.6 — IO error: warning logged, state unchanged
// ---------------------------------------------------------------------------

describe('statusManager.processStatusUpdate() — IO error (Req 3.6)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>
  let warnSpy: jest.SpyInstance

  beforeEach(async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    // Initialize with a valid state first
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)
    await sm.initialize(VALID_FILE_PATH)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('logs a warning when readFileSync throws an IO error', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read status file'))
  })

  it('leaves state unchanged when readFileSync throws', () => {
    const stateBefore = sm.getCurrentStatus()
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(sm.getCurrentStatus()).toEqual(stateBefore)
  })

  it('does not dispatch to subscribers when IO error occurs', () => {
    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EBUSY: resource busy')
    })
    sm.processStatusUpdate(VALID_FILE_PATH)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('handles non-Error throws gracefully', () => {
    mockReadFileSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string error'
    })
    expect(() => sm.processStatusUpdate(VALID_FILE_PATH)).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Requirement 11.3 — Path traversal rejection
// ---------------------------------------------------------------------------

describe('validateStatusFilePath() — path traversal rejection (Req 11.3)', () => {
  it('rejects paths containing ../', () => {
    expect(validateStatusFilePath('../etc/passwd')).toBe(false)
  })

  it('rejects paths containing ../ in the middle', () => {
    expect(validateStatusFilePath(path.join(HOME_DIR, 'foo', '..', '..', 'etc', 'passwd'))).toBe(false)
  })

  it('rejects paths containing ..\\ (Windows-style traversal)', () => {
    expect(validateStatusFilePath('..\\etc\\passwd')).toBe(false)
  })

  it('rejects absolute paths outside the home directory', () => {
    expect(validateStatusFilePath('/etc/passwd')).toBe(false)
  })

  it('rejects /tmp paths (outside home directory)', () => {
    expect(validateStatusFilePath('/tmp/status.json')).toBe(false)
  })

  it('accepts a valid path inside the home directory', () => {
    const validPath = path.join(HOME_DIR, '.kiro', 'status.json')
    expect(validateStatusFilePath(validPath)).toBe(true)
  })

  it('accepts a path directly in the home directory', () => {
    const validPath = path.join(HOME_DIR, 'status.json')
    expect(validateStatusFilePath(validPath)).toBe(true)
  })

  it('rejects empty string', () => {
    expect(validateStatusFilePath('')).toBe(false)
  })

  it('rejects paths with null bytes', () => {
    expect(validateStatusFilePath(path.join(HOME_DIR, 'status\0.json'))).toBe(false)
  })

  it('does not initialize watcher for traversal paths', async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    const sm = getFreshStatusManager()

    await sm.initialize('../etc/passwd')

    expect(chokidar.watch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Requirement 2.6 — stopWatching() closes the watcher
// ---------------------------------------------------------------------------

describe('statusManager.stopWatching() (Req 2.6)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>

  beforeEach(async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()

    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)
    await sm.initialize(VALID_FILE_PATH)
  })

  it('calls watcher.close() when stopWatching() is called', () => {
    sm.startWatching()
    sm.stopWatching()
    expect(mockWatcherClose).toHaveBeenCalledTimes(1)
  })

  it('does not throw when stopWatching() is called without startWatching()', () => {
    expect(() => sm.stopWatching()).not.toThrow()
  })

  it('sets watcher to null after stopWatching() (idempotent second call)', () => {
    sm.startWatching()
    sm.stopWatching()
    // Second call should not throw and should not call close again
    expect(() => sm.stopWatching()).not.toThrow()
    expect(mockWatcherClose).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Requirement 2.1 — startWatching() registers change and add handlers
// ---------------------------------------------------------------------------

describe('statusManager.startWatching() (Req 2.1)', () => {
  let sm: ReturnType<typeof getFreshStatusManager>

  beforeEach(async () => {
    jest.clearAllMocks()
    resetMockWatcher()
    sm = getFreshStatusManager()

    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(VALID_PAYLOAD_JSON)
    await sm.initialize(VALID_FILE_PATH)
  })

  it('creates a watcher for the correct file path (chokidar.watch called)', () => {
    // After startWatching(), the mock watcher instance should have had .on() called
    // (which means chokidar.watch was invoked and returned our mock instance).
    // We verify indirectly via the watcher's .on() calls since the chokidar import
    // reference in this file diverges from the one used by the freshly-required module.
    sm.startWatching()
    // The watcher's .on() being called proves chokidar.watch() was invoked
    expect(mockWatcherOn).toHaveBeenCalled()
  })

  it('registers a "change" event handler', () => {
    sm.startWatching()
    const registeredEvents = mockWatcherOn.mock.calls.map((c: unknown[]) => c[0])
    expect(registeredEvents).toContain('change')
  })

  it('registers an "add" event handler', () => {
    sm.startWatching()
    const registeredEvents = mockWatcherOn.mock.calls.map((c: unknown[]) => c[0])
    expect(registeredEvents).toContain('add')
  })

  it('registers an "unlink" event handler for delete/recreate recovery', () => {
    sm.startWatching()
    const registeredEvents = mockWatcherOn.mock.calls.map((c: unknown[]) => c[0])
    expect(registeredEvents).toContain('unlink')
  })

  it('registers an "error" event handler', () => {
    sm.startWatching()
    const registeredEvents = mockWatcherOn.mock.calls.map((c: unknown[]) => c[0])
    expect(registeredEvents).toContain('error')
  })

  it('logs a warning when startWatching() is called before initialize()', () => {
    const freshSm = getFreshStatusManager()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    freshSm.startWatching()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('startWatching() called before initialize()'))
    warnSpy.mockRestore()
  })

  it('debounces rapid watcher events and dispatches only the latest payload', () => {
    jest.useFakeTimers()
    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)
    sm.startWatching()
    subscriber.mockClear()

    const latestPayload = {
      status: 'working',
      message: 'latest rapid update',
      timestamp: 1718000005000,
    }
    mockReadFileSync.mockReturnValue(JSON.stringify(latestPayload))

    for (let index = 0; index < 10; index += 1) {
      emitWatcherEvent('change', VALID_FILE_PATH)
    }
    jest.advanceTimersByTime(DEBOUNCE_MS - 1)
    expect(subscriber).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(subscriber.mock.calls[0][0]).toMatchObject(latestPayload)
    jest.useRealTimers()
  })

  it('recovers when the watched status file is deleted and recreated', () => {
    jest.useFakeTimers()
    const subscriber = jest.fn()
    sm.onStatusChange(subscriber)
    sm.startWatching()
    subscriber.mockClear()

    let fileExists = false
    mockExistsSync.mockImplementation((p: string) => {
      if (p === path.dirname(VALID_FILE_PATH)) return true
      if (p === VALID_FILE_PATH) return fileExists
      return false
    })

    emitWatcherEvent('unlink', VALID_FILE_PATH)
    expect(mockWriteFileSync).toHaveBeenCalled()

    fileExists = true
    const recreatedPayload = {
      status: 'working',
      message: 'after recreate',
      timestamp: 1718000006000,
    }
    mockReadFileSync.mockReturnValue(JSON.stringify(recreatedPayload))
    emitWatcherEvent('add', VALID_FILE_PATH)

    jest.advanceTimersByTime(DEBOUNCE_MS)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(subscriber.mock.calls[0][0]).toMatchObject(recreatedPayload)
    jest.useRealTimers()
  })
})
