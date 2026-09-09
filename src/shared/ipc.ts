export const IPC_CHANNELS = {
  moveWindow: 'move-window',
  statusUpdate: 'status-update',
  lockStateUpdate: 'lock-state-update',
  lockRequest: 'lock-request',
  unlockRequest: 'unlock-request',
  toggleLock: 'toggle-lock',
  getLockState: 'get-lock-state',
  getConfig: 'get-config',
  setLockConfig: 'set-lock-config',
  /** Lock screen -> main: passphrase or recovery answer typed on the cover. */
  unlockWithPassphrase: 'unlock-passphrase',
  /** Main -> lock screen: latest KiroCrew activity snapshot. */
  kirocrewPulse: 'kirocrew-pulse',
  /** Settings window <-> main. Handlers verify the sender is the settings window. */
  settingsGet: 'settings-get',
  settingsSavePassphrase: 'settings-save-passphrase',
  settingsSaveKiroCrew: 'settings-save-kirocrew',
  settingsClose: 'settings-close',
} as const

export interface MoveWindowPayload {
  x: number
  y: number
}

const MAX_ABS_WINDOW_COORDINATE = 100000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAllowedCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_ABS_WINDOW_COORDINATE
  )
}

export function isMoveWindowPayload(payload: unknown): payload is MoveWindowPayload {
  if (!isPlainRecord(payload)) return false
  const keys = Object.keys(payload)
  return (
    keys.length === 2 &&
    keys.includes('x') &&
    keys.includes('y') &&
    isAllowedCoordinate(payload.x) &&
    isAllowedCoordinate(payload.y)
  )
}
