/**
 * Unit tests for `configStore`
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
 *
 * Requirement 9.1: Config stored at ~/.kiro-buddy/config.json
 * Requirement 9.2: AppConfig includes window position, statusFilePath, notifications, clickThrough, pollIntervalMs
 * Requirement 9.3: setWindowPosition persists and getConfig returns updated values
 * Requirement 9.4: setNotificationPrefs persists immediately
 * Requirement 9.5: Default values on first run: position (100,100), notifications enabled for done and error,
 *                  click-through disabled, poll interval 500ms
 */

import path from 'path'
import os from 'os'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Mock electron-store with an in-memory store
// ---------------------------------------------------------------------------

// In-memory backing store shared across all mock instances
let memStore: Record<string, unknown> = {}

jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(({ defaults }: { defaults?: Record<string, unknown> }) => {
    // Reset and seed with defaults on each construction
    memStore = {}
    if (defaults) {
      // Flatten defaults into dot-notation keys for get/set compatibility
      function flatten(obj: Record<string, unknown>, prefix = ''): void {
        for (const [k, v] of Object.entries(obj)) {
          const key = prefix ? `${prefix}.${k}` : k
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            flatten(v as Record<string, unknown>, key)
          } else {
            memStore[key] = v
          }
        }
      }
      flatten(defaults)
    }

    return {
      get(key: string, defaultValue?: unknown): unknown {
        return key in memStore ? memStore[key] : defaultValue
      },
      set(key: string, value: unknown): void {
        // If value is a plain object, flatten it into dot-notation keys
        // so that subsequent dot-notation gets (e.g. 'notifications.enabled') work
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          // Remove any existing keys under this prefix first
          for (const k of Object.keys(memStore)) {
            if (k === key || k.startsWith(`${key}.`)) {
              delete memStore[k]
            }
          }
          function flattenInto(obj: Record<string, unknown>, prefix: string): void {
            for (const [k, v] of Object.entries(obj)) {
              const fullKey = `${prefix}.${k}`
              if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                flattenInto(v as Record<string, unknown>, fullKey)
              } else {
                memStore[fullKey] = v
              }
            }
          }
          flattenInto(value as Record<string, unknown>, key)
        } else {
          memStore[key] = value
        }
      },
    }
  })
})

// Import after mock is set up
import {
  getConfig,
  repairConfigFileEncoding,
  setWindowPosition,
  setNotificationPrefs,
  setClickThrough,
  setPetScale,
} from '../../src/main/configStore'
import type { NotificationConfig } from '../../src/shared/types'

// ---------------------------------------------------------------------------
// Requirement 9.5 — Default values on first run
// ---------------------------------------------------------------------------

describe('configStore — default values (Req 9.5)', () => {
  it('repairs a UTF-8 BOM in config.json before electron-store reads it', () => {
    const filePath = path.join(os.tmpdir(), `kiro-buddy-bom-${Date.now()}.json`)
    const json = '{"petScale":0.8}\n'
    fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]))

    try {
      repairConfigFileEncoding(filePath)
      expect(fs.readFileSync(filePath, 'utf8')).toBe(json)
    } finally {
      fs.rmSync(filePath, { force: true })
    }
  })

  it('returns default window position of (100, 100)', () => {
    const config = getConfig()
    expect(config.window.x).toBe(100)
    expect(config.window.y).toBe(100)
  })

  it('returns default window dimensions for the pet panel', () => {
    const config = getConfig()
    expect(config.window.width).toBe(390)
    expect(config.window.height).toBe(360)
  })

  it('returns notifications enabled by default', () => {
    const config = getConfig()
    expect(config.notifications.enabled).toBe(true)
  })

  it('returns onDone notification enabled by default', () => {
    const config = getConfig()
    expect(config.notifications.onDone).toBe(true)
  })

  it('returns onError notification enabled by default', () => {
    const config = getConfig()
    expect(config.notifications.onError).toBe(true)
  })

  it('returns clickThrough disabled by default', () => {
    const config = getConfig()
    expect(config.clickThrough).toBe(false)
  })

  it('returns pollIntervalMs of 500 by default', () => {
    const config = getConfig()
    expect(config.pollIntervalMs).toBe(500)
  })

  it('returns petScale of 1 by default', () => {
    const config = getConfig()
    expect(config.petScale).toBe(1)
  })

  it('returns a default statusFilePath pointing to ~/.kiro/status.json', () => {
    const config = getConfig()
    const expected = path.join(os.homedir(), '.kiro', 'status.json')
    expect(config.statusFilePath).toBe(expected)
  })

  it('uses KIRO_GUARD_STATUS_FILE when launching a session-scoped instance', () => {
    const previous = process.env.KIRO_GUARD_STATUS_FILE
    const sessionStatusPath = path.join(os.homedir(), '.kiro-buddy', 'sessions', 'one', 'status.json')

    process.env.KIRO_GUARD_STATUS_FILE = sessionStatusPath
    try {
      expect(getConfig().statusFilePath).toBe(sessionStatusPath)
    } finally {
      if (previous === undefined) {
        delete process.env.KIRO_GUARD_STATUS_FILE
      } else {
        process.env.KIRO_GUARD_STATUS_FILE = previous
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Requirement 9.2 — AppConfig shape
// ---------------------------------------------------------------------------

describe('configStore — AppConfig shape (Req 9.2)', () => {
  it('getConfig returns an object with all required AppConfig fields', () => {
    const config = getConfig()
    expect(config).toHaveProperty('window')
    expect(config).toHaveProperty('statusFilePath')
    expect(config).toHaveProperty('notifications')
    expect(config).toHaveProperty('clickThrough')
    expect(config).toHaveProperty('pollIntervalMs')
    expect(config).toHaveProperty('petScale')
  })

  it('window object contains x, y, width, height', () => {
    const { window } = getConfig()
    expect(window).toHaveProperty('x')
    expect(window).toHaveProperty('y')
    expect(window).toHaveProperty('width')
    expect(window).toHaveProperty('height')
  })

  it('notifications object contains enabled, onDone, onError', () => {
    const { notifications } = getConfig()
    expect(notifications).toHaveProperty('enabled')
    expect(notifications).toHaveProperty('onDone')
    expect(notifications).toHaveProperty('onError')
  })
})

// ---------------------------------------------------------------------------
// Requirement 9.3 — setWindowPosition persists and getConfig reflects it
// ---------------------------------------------------------------------------

describe('configStore — setWindowPosition (Req 9.3)', () => {
  it('persists new x and y values', () => {
    setWindowPosition(250, 300)
    const config = getConfig()
    expect(config.window.x).toBe(250)
    expect(config.window.y).toBe(300)
  })

  it('getConfig returns the updated position after setWindowPosition', () => {
    setWindowPosition(42, 99)
    const config = getConfig()
    expect(config.window.x).toBe(42)
    expect(config.window.y).toBe(99)
  })

  it('does not affect other config fields when updating position', () => {
    setWindowPosition(10, 20)
    const config = getConfig()
    expect(config.clickThrough).toBe(false)
    expect(config.pollIntervalMs).toBe(500)
    expect(config.notifications.enabled).toBe(true)
  })

  it('overwrites a previously set position', () => {
    setWindowPosition(100, 200)
    setWindowPosition(300, 400)
    const config = getConfig()
    expect(config.window.x).toBe(300)
    expect(config.window.y).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Requirement 9.4 — setNotificationPrefs persists immediately
// ---------------------------------------------------------------------------

describe('configStore — setNotificationPrefs (Req 9.4)', () => {
  it('persists all three notification fields', () => {
    const prefs: NotificationConfig = { enabled: false, onDone: false, onError: false }
    setNotificationPrefs(prefs)
    const config = getConfig()
    expect(config.notifications.enabled).toBe(false)
    expect(config.notifications.onDone).toBe(false)
    expect(config.notifications.onError).toBe(false)
  })

  it('getConfig reflects updated notification prefs immediately', () => {
    const prefs: NotificationConfig = { enabled: true, onDone: false, onError: true }
    setNotificationPrefs(prefs)
    const config = getConfig()
    expect(config.notifications).toEqual(prefs)
  })

  it('overwrites previously set notification prefs', () => {
    setNotificationPrefs({ enabled: true, onDone: true, onError: true })
    setNotificationPrefs({ enabled: false, onDone: false, onError: false })
    const config = getConfig()
    expect(config.notifications.enabled).toBe(false)
    expect(config.notifications.onDone).toBe(false)
    expect(config.notifications.onError).toBe(false)
  })

  it('does not affect window position when updating notification prefs', () => {
    setWindowPosition(55, 66)
    setNotificationPrefs({ enabled: false, onDone: false, onError: false })
    const config = getConfig()
    expect(config.window.x).toBe(55)
    expect(config.window.y).toBe(66)
  })
})

// ---------------------------------------------------------------------------
// setClickThrough — additional persistence check
// ---------------------------------------------------------------------------

describe('configStore — setClickThrough', () => {
  it('persists clickThrough = true', () => {
    setClickThrough(true)
    expect(getConfig().clickThrough).toBe(true)
  })

  it('persists clickThrough = false', () => {
    setClickThrough(false)
    expect(getConfig().clickThrough).toBe(false)
  })
})

describe('configStore — setPetScale', () => {
  it('persists petScale', () => {
    setPetScale(0.8)
    expect(getConfig().petScale).toBe(0.8)
  })

  it('clamps petScale to the supported range', () => {
    setPetScale(0.2)
    expect(getConfig().petScale).toBe(0.6)

    setPetScale(2)
    expect(getConfig().petScale).toBe(1.4)
  })
})
