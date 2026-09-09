/**
 * lockController.ts
 *
 * Windows screen lock state machine and orchestrator.
 * Built for Windows via Electron APIs.
 *
 * Lock flow:
 *   unlocked → locking → locked
 *   locked → unlocking → unlocked (or back to locked on auth fail)
 *
 * Windows auth uses PowerShell CredentialUI or a password overlay.
 *
 * Note: there is no kernel-level input blocking. The lock is a presence
 * overlay (fullscreen + kiosk + screen-saver window level), not a security
 * boundary. Keys still reach the OS; they hit the overlay (ignored) or the
 * credential dialog (used). See the "Input blocking — DISABLED" section
 * below for why hooking input was removed.
 */

import { globalShortcut, powerSaveBlocker, BrowserWindow, screen, app } from 'electron'
import { execFile } from 'child_process'
import type { LockState, LockConfig, StatusPayload, KiroCrewFeedConfig } from '../shared/types'
import { IPC_CHANNELS } from '../shared/ipc'
import { verifySecret, verifyRecovery } from './passphrase'
import { KiroCrewFeed, type PulseSnapshot } from './kirocrewFeed'
import { statusManager } from './statusManager'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LockStateChangeHandler = (state: LockState, lockedAt?: number) => void

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let lockState: LockState = 'unlocked'
let lockedAt: number | undefined
let powerSaveId: number | null = null
let lockWindow: BrowserWindow | null = null
let hotkeyRegistered = false
let stateHandlers: LockStateChangeHandler[] = []
let elapsedTimer: NodeJS.Timeout | null = null
let topMostTimer: NodeJS.Timeout | null = null
let authInProgress = false
let failCount = 0
/** After this many wrong passphrases the recovery question is offered. */
export const RECOVERY_AFTER_FAILURES = 5
/** 0.99, not 1.0 — see createLockWindow(). */
export const LOCK_WINDOW_OPACITY = 0.99
/** KiroCrew feed lives only while locked. Config getter is injected by index.ts. */
let feed: KiroCrewFeed | null = null
let kirocrewConfigGetter: (() => KiroCrewFeedConfig) | null = null
let feedFactory: ((getCfg: () => KiroCrewFeedConfig, onSnap: (s: PulseSnapshot) => void) => KiroCrewFeed) | null = null
let failCooldownTimer: NodeJS.Timeout | null = null
let lockStatusUnsubscribe: (() => void) | null = null
const FAIL_COOLDOWN_MS = 30_000
const FAIL_MAX_BEFORE_COOLDOWN = 3

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

function canTransition(from: LockState, to: LockState): boolean {
  const valid: Array<[LockState, LockState]> = [
    ['unlocked', 'locking'],
    ['locking', 'locked'],
    ['locking', 'unlocked'],
    ['locked', 'unlocking'],
    ['unlocking', 'locked'],
    ['unlocking', 'unlocked'],
    ['locked', 'unlocked'],
  ]
  return valid.some(([f, t]) => f === from && t === to)
}

function transitionTo(next: LockState): void {
  if (!canTransition(lockState, next)) {
    console.warn(`[LockController] Invalid transition ${lockState} → ${next}`)
    return
  }
  lockState = next
  for (const h of stateHandlers) h(lockState, lockedAt)
}

// ---------------------------------------------------------------------------
// Lock window management
// ---------------------------------------------------------------------------

function getAllDisplayBounds(): Electron.Rectangle[] {
  return screen.getAllDisplays().map(d => d.bounds)
}

function createLockWindow(display: Electron.Display): BrowserWindow {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreen: true,
    focusable: true,
    show: false,
    backgroundColor: '#0a0f0f',
    // KEEP THE WORK RUNNING. Chromium's occlusion tracker (Chrome, and the Kiro
    // IDE which is Electron) treats a window it covers as hidden and throttles
    // its renderer — so a fully opaque cover slows the very agents it guards.
    // Windows only counts a window as occluding when it is fully opaque; at
    // 0.99 the cover becomes a layered window and is ignored by that check,
    // while staying visually black. Same trick Freeze Screen relies on.
    opacity: LOCK_WINDOW_OPACITY,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The cover's own clock/status timers must not be throttled when the
      // window loses focus to the credential prompt.
      backgroundThrottling: false,
      // Disable sandbox for the preload script so it can use require() to
      // load relative modules like '../shared/ipc'. Without this, Electron
      // runs the preload in a sandboxed context that only allows specific
      // built-in modules, and the preload fails to load with
      // "module not found: ../shared/ipc". With contextIsolation still
      // true, this is safe — the renderer cannot access Node directly.
      sandbox: false,
      preload: require('path').join(__dirname, 'preload.js'),
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver', 1)

  // Remember which display this window covers so display add/remove and
  // the auth-time shield logic can address windows per-display.
  ;(win as BrowserWindow & { __displayId?: number }).__displayId = display.id

  // Forward renderer console messages to main process stdout so they
  // appear in kiro-guard.log. Without this, lock.html's console.log calls
  // are invisible.
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelName = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'LOG'
    console.log(`[lock-window ${levelName}] ${message} (${sourceId}:${line})`)
  })

  // Surface preload load failures so we can diagnose missing window.kiroLock
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[lock-window] preload-error in ${preloadPath}:`, error.message)
  })

  return win
}

let lockWindows: BrowserWindow[] = []

/**
 * Payload sent to every lock window on 'lock-init'. Exported so tests can
 * pin its shape.
 *
 * `requireAuth` is included so the lock screen can label its unlock button
 * honestly. Before this the button always read "Unlock with Windows
 * password" even when requireAuth was false and a click unlocked instantly
 * — the field report "it just unlocks when you click it".
 */
export interface LockInitPayload {
  message: string
  showElapsed: boolean
  lockedAt: number | undefined
  status: string
  requireAuth: boolean
  authMode: 'windows' | 'passphrase' | 'none'
  /** Whether a recovery question exists. The question itself is only sent after repeated failures. */
  recoveryAvailable: boolean
  kirocrewEnabled: boolean
}

export function buildLockInitPayload(
  config: LockConfig,
  lockedAtMs: number | undefined,
  status: string,
  kirocrewEnabled: boolean = false,
): LockInitPayload {
  const authMode = config.authMode ?? (config.requireAuth ? 'windows' : 'none')
  return {
    message: config.lockMessage,
    showElapsed: config.showElapsedTime,
    lockedAt: lockedAtMs,
    status,
    requireAuth: authMode !== 'none',
    authMode,
    recoveryAvailable: Boolean(config.recovery),
    kirocrewEnabled,
  }
}

function kirocrewEnabled(): boolean {
  try { return Boolean(kirocrewConfigGetter?.().enabled) } catch { return false }
}
let lastLockConfig: LockConfig | null = null
let displayHandlersRegistered = false

function windowDisplayId(win: BrowserWindow): number | undefined {
  return (win as BrowserWindow & { __displayId?: number }).__displayId
}

function shieldWindow(win: BrowserWindow): void {
  try { win.setAlwaysOnTop(true, 'screen-saver', 1) } catch {}
  try { win.setKiosk(true) } catch {}
}

function unshieldWindow(win: BrowserWindow): void {
  try { win.setKiosk(false) } catch {}
  try { win.setAlwaysOnTop(false) } catch {}
}

async function addLockWindowForDisplay(display: Electron.Display, config: LockConfig): Promise<void> {
  const win = createLockWindow(display)
  lockWindows.push(win)
  const lockHtmlPath = require('path').join(__dirname, '..', '..', 'renderer', 'lock.html')
  await win.loadFile(lockHtmlPath)

  // Re-check state after the await. An unlock can complete during loadFile
  // (doUnlock tears down on a 600ms timer), and destroyLockScreens() clears
  // lockWindows — so without this guard the continuation would shield and
  // show an opaque fullscreen cover on an already-unlocked desktop, in a
  // state ('unlocked') that quickUnlock() and the emergency hotkey both
  // ignore. That is another permanently-covered screen.
  if (lockState !== 'locked' && lockState !== 'locking' && lockState !== 'unlocking') {
    try { win.destroy() } catch {}
    lockWindows = lockWindows.filter(w => w !== win)
    return
  }

  win.webContents.send('lock-init', buildLockInitPayload(
    config, lockedAt, statusManager.getCurrentStatus()?.status ?? 'idle', kirocrewEnabled(),
  ))
  if (feed?.latest) win.webContents.send(IPC_CHANNELS.kirocrewPulse, feed.latest)
  shieldWindow(win)
  win.show()
}

/**
 * Keep lock coverage in sync with the physical display set. Without this,
 * a monitor plugged in while locked showed the bare desktop, and hovering
 * the taskbar there exposed app previews (the reported Slack thumbnail
 * leak). Re-covering on every change closes both gaps.
 */
function handleDisplaysChanged(): void {
  if (lockState !== 'locked' && lockState !== 'unlocking') return
  const config = lastLockConfig
  if (!config) return

  const displays = screen.getAllDisplays()
  const coveredIds = new Set(
    lockWindows.filter(w => !w.isDestroyed()).map(w => windowDisplayId(w)),
  )

  // Close windows whose display disappeared.
  lockWindows = lockWindows.filter(w => {
    if (w.isDestroyed()) return false
    const id = windowDisplayId(w)
    if (id !== undefined && !displays.some(d => d.id === id)) {
      try { w.destroy() } catch {}
      return false
    }
    return true
  })

  // Cover newly attached displays.
  for (const display of displays) {
    if (!coveredIds.has(display.id)) {
      addLockWindowForDisplay(display, config).catch(err =>
        console.error('[LockController] Failed to cover new display:', err),
      )
    }
  }

  // Resize existing covers to their display's current bounds.
  //
  // This is what makes 'display-metrics-changed' actually do something. A
  // resolution, DPI or rotation change keeps the SAME display id, so the
  // add/remove reconciliation above matches everything and no window is
  // touched — the cover silently keeps its old geometry and leaves an
  // uncovered strip of live desktop, with a subscribed listener making the
  // gap look handled. Compare bounds and re-apply.
  for (const win of lockWindows) {
    if (win.isDestroyed()) continue
    const id = windowDisplayId(win)
    const display = displays.find(d => d.id === id)
    if (!display) continue
    const want = display.bounds
    let current: Electron.Rectangle | undefined
    try { current = win.getBounds() } catch { current = undefined }
    if (
      !current ||
      current.x !== want.x ||
      current.y !== want.y ||
      current.width !== want.width ||
      current.height !== want.height
    ) {
      try { win.setBounds(want) } catch {}
      // Re-assert the shield: on some Windows configurations a bounds change
      // drops the window out of kiosk/screen-saver level.
      shieldWindow(win)
    }
  }
}

function registerDisplayHandlers(): void {
  if (displayHandlersRegistered) return
  screen.on('display-added', handleDisplaysChanged)
  screen.on('display-removed', handleDisplaysChanged)
  screen.on('display-metrics-changed', handleDisplaysChanged)
  displayHandlersRegistered = true
}

async function showLockScreens(config: LockConfig): Promise<void> {
  lastLockConfig = config
  registerDisplayHandlers()
  const displays = screen.getAllDisplays()
  lockWindows = displays.map(d => createLockWindow(d))

  const lockHtmlPath = require('path').join(__dirname, '..', '..', 'renderer', 'lock.html')
  const currentStatus = statusManager.getCurrentStatus()

  for (const win of lockWindows) {
    await win.loadFile(lockHtmlPath)
    win.webContents.send('lock-init', buildLockInitPayload(
      config, lockedAt, currentStatus?.status ?? 'idle', kirocrewEnabled(),
    ))
    win.setAlwaysOnTop(true, 'screen-saver', 1)
    // Kiosk mode hides the Windows taskbar over the fullscreen window
    try { win.setKiosk(true) } catch {}
    win.show()
    win.focus()
  }

  // Forward live Kiro status updates to lock windows so the buddy reacts.
  if (!lockStatusUnsubscribe) {
    const handler = (payload: StatusPayload): void => {
      for (const w of lockWindows) {
        if (!w.isDestroyed()) {
          try { w.webContents.send('lock-status', payload) } catch {}
        }
      }
    }
    statusManager.onStatusChange(handler)
    lockStatusUnsubscribe = () => {
      // statusManager doesn't expose remove yet; track for cleanup intent.
      // No-op for now; subscriber list only grows during a session.
    }
  }

  // Keep enforcing top-most. While auth is in progress, skip ONLY the
  // window on the primary display (where the credential dialog appears)
  // so the dialog stays visible and clickable. All other displays stay
  // shielded — previously every display was skipped, which exposed the
  // taskbar (and Slack hover previews) on secondary monitors for the
  // whole credential-dialog lifetime.
  topMostTimer = setInterval(() => {
    const primaryId = screen.getPrimaryDisplay().id
    for (const w of lockWindows) {
      if (w.isDestroyed()) continue
      if (authInProgress && windowDisplayId(w) === primaryId) continue
      w.setAlwaysOnTop(true, 'screen-saver', 1)
      // moveTop() while the credential dialog is up can push the dialog
      // behind a lock window on some z-order configurations; only re-raise
      // when no auth is running.
      if (!authInProgress) w.moveTop()
    }
  }, 1500)
}

function destroyLockScreens(): void {
  if (topMostTimer) {
    clearInterval(topMostTimer)
    topMostTimer = null
  }
  for (const win of lockWindows) {
    if (!win.isDestroyed()) {
      win.hide()
      // destroy(), NOT close(). These windows are created with
      // closable: false, so close() is a silent no-op — every lock cycle
      // leaked a live window plus its renderer, and because lockWindows is
      // cleared below the reference was dropped while the window stayed
      // alive on screen. destroy() is the only teardown that actually
      // applies to a non-closable window.
      try { win.destroy() } catch {}
    }
  }
  lockWindows = []
}

// ---------------------------------------------------------------------------
// Input blocking — DISABLED.
//
// The previous implementation used uiohook-napi to swallow every keystroke
// while locked. This caused a hard deadlock: the Windows password prompt
// (PromptForCredential) couldn't receive keys, so users could never unlock
// and had to hard-reboot the machine.
//
// We rely instead on the lock window being:
//   - fullscreen + kiosk + screen-saver-level (covers everything)
//   - closable: false, focusable: true (forces input into our window)
// Keys still reach the OS, which is the correct behavior — they just hit the
// lock overlay (which ignores them) or the credential dialog (which uses
// them). No kernel-level blocking, no deadlocks.
// ---------------------------------------------------------------------------

function startInputBlocking(): void {
  // Intentional no-op. See comment block above.
}

function stopInputBlocking(): void {
  // Intentional no-op. See comment block above.
}

// ---------------------------------------------------------------------------
// Sleep prevention
// ---------------------------------------------------------------------------

// Two blockers, not one. 'prevent-display-sleep' keeps the screen and system
// awake; 'prevent-app-suspension' is the belt-and-braces for Modern Standby
// laptops, where the OS is eager to suspend background work the moment it thinks
// nobody is looking. Re-asserted every minute in case something cleared them.
let suspendBlockerId: number | null = null
let blockerRenewTimer: NodeJS.Timeout | null = null
export const BLOCKER_RENEW_MS = 60_000

function startSleepPrevention(): void {
  ensureBlockers()
  if (!blockerRenewTimer) blockerRenewTimer = setInterval(ensureBlockers, BLOCKER_RENEW_MS)
}

function blockerAlive(id: number | null): boolean {
  if (id === null) return false
  return typeof powerSaveBlocker.isStarted === 'function' ? powerSaveBlocker.isStarted(id) : true
}

function ensureBlockers(): void {
  if (!blockerAlive(powerSaveId)) powerSaveId = powerSaveBlocker.start('prevent-display-sleep')
  if (!blockerAlive(suspendBlockerId)) suspendBlockerId = powerSaveBlocker.start('prevent-app-suspension')
}

function stopSleepPrevention(): void {
  if (blockerRenewTimer) { clearInterval(blockerRenewTimer); blockerRenewTimer = null }
  if (powerSaveId !== null) { powerSaveBlocker.stop(powerSaveId); powerSaveId = null }
  if (suspendBlockerId !== null) { powerSaveBlocker.stop(suspendBlockerId); suspendBlockerId = null }
}

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

function startElapsedTimer(): void {
  elapsedTimer = setInterval(() => {
    for (const win of lockWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('lock-elapsed', Date.now())
      }
    }
  }, 1000)
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function authenticateWindows(): Promise<boolean> {
  return new Promise((resolve) => {
    // Write the auth helper to a temp .ps1 and invoke with -File. Passing
    // a long script via -Command suffers from PowerShell's argument
    // re-parsing rules: nested quotes, backticks, dollar signs, and
    // backslashes can be interpreted differently than when read from a
    // file. Running via -File reads the script verbatim from disk, which
    // matches the invocation form that was verified working on Windows.
    //
    // Strategy chain:
    //   1. ContextType.Domain  (online AD validation)
    //   2. ContextType.Machine (cached domain creds via LSA when DOMAIN/user form is given)
    //   3. LogonUser INTERACTIVE / UNLOCK / NETWORK
    // Pre-fill credential dialog with $USERDOMAIN\$USERNAME so the user
    // doesn't have to remember the prefix.
    //
    // Stdout sentinel:
    //   OK     -> validated
    //   BAD    -> rejected by all strategies
    //   CANCEL -> user dismissed dialog
    //   ERROR  -> helper crashed
    const psScript = `
$ErrorActionPreference = 'Continue'
try {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement

  $defaultUser = $env:USERNAME
  if ($env:USERDOMAIN) { $defaultUser = "$($env:USERDOMAIN)\\$($env:USERNAME)" }

  $cred = $host.ui.PromptForCredential('Kiro Guard', 'Enter your Windows password to unlock', $defaultUser, '')
  if ($null -eq $cred) {
    Write-Output 'CANCEL'
    exit 0
  }

  $username = $cred.UserName
  $password = $cred.GetNetworkCredential().Password

  # Reject empty passwords outright. PromptForCredential returns a
  # credential object even when the password box is left blank, and
  # PrincipalContext.ValidateCredentials with an empty password can
  # succeed via an unauthenticated LDAP bind on domain contexts. That
  # combination let "just click OK" unlock the screen. Blank password
  # is never a valid unlock.
  if ([string]::IsNullOrEmpty($password)) {
    Write-Output 'BAD'
    exit 0
  }

  $valid = $false

  $domainPart = ''
  $userPart = $username
  if ($username -match '^([^\\\\]+)\\\\(.+)$') { $domainPart = $matches[1]; $userPart = $matches[2] }
  elseif ($username -match '^(.+)@(.+)$')   { $userPart = $matches[1]; $domainPart = $matches[2] }

  if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) {
    try {
      $adDomain = (Get-CimInstance Win32_ComputerSystem).Domain
      $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Domain, $adDomain)
      $valid = $ctx.ValidateCredentials($username, $password)
    } catch {}
  }

  if (-not $valid) {
    try {
      $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)
      $valid = $ctx.ValidateCredentials($username, $password)
    } catch {}
  }

  if (-not $valid) {
    try {
      $signature = @"
[DllImport("advapi32.dll", SetLastError=true)]
public static extern bool LogonUser(string user, string domain, string password, int logonType, int logonProvider, out IntPtr token);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr handle);
"@
      $type = Add-Type -MemberDefinition $signature -Name 'KGAuth' -Namespace 'KGAuthNs' -PassThru
      foreach ($logonType in @(2, 7, 3)) {
        if ($valid) { break }
        $token = [IntPtr]::Zero
        $result = $type::LogonUser($userPart, $domainPart, $password, $logonType, 0, [ref]$token)
        if ($result) {
          $valid = $true
          $type::CloseHandle($token) | Out-Null
        }
      }
    } catch {}
  }

  if ($valid) { Write-Output 'OK' } else { Write-Output 'BAD' }
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
}
`.trim()

    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const tmpScript = path.join(os.tmpdir(), `kiro-guard-auth-${process.pid}-${Date.now()}.ps1`)
    fs.writeFileSync(tmpScript, psScript, { encoding: 'utf-8' })

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpScript],
      // 30s, not 120s. The primary display's cover is deliberately unshielded
      // for the whole lifetime of this call so the credential dialog is
      // visible and clickable, which means this timeout IS the maximum
      // fail-open window: walk away from the prompt and the primary desktop
      // stays exposed for its full duration while the app still reports
      // 'locked'. 30s is ample for a human to type a password and bounds the
      // exposure to a quarter of what it was.
      { windowsHide: false, timeout: 30_000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpScript) } catch {}
        if (err) {
          console.warn('[LockController] auth helper exec error:', err.message)
          if (stderr) console.warn('[LockController] auth helper stderr:', stderr)
          resolve(false)
          return
        }
        const verdict = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        console.log(`[LockController] auth verdict: ${verdict}`)
        resolve(verdict === 'OK')
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function lock(config: LockConfig): Promise<void> {
  if (lockState !== 'unlocked') return

  transitionTo('locking')
  lockedAt = Date.now()

  try {
    await showLockScreens(config)
    startInputBlocking()
    startSleepPrevention()
    startElapsedTimer()
    startKiroCrewFeed()
  } catch (err) {
    // A rejection here — most often win.loadFile(), made more likely by the
    // disableHardwareAcceleration + in-process-gpu flags in index.ts —
    // previously left lockState stuck at 'locking' forever. From 'locking',
    // unlock(), quickUnlock() AND the emergency hotkey all refuse to act,
    // while the first display's kiosk cover is already on screen. That left
    // a permanently covered screen whose only exit was Task Manager,
    // underneath a screen-saver-level window. Unwind fully instead and hand
    // the machine back to the user.
    console.error('[LockController] Lock failed — unwinding to unlocked:', err)
    stopKiroCrewFeed()
    stopElapsedTimer()
    stopSleepPrevention()
    stopInputBlocking()
    destroyLockScreens()
    lockedAt = undefined
    transitionTo('unlocked')
    return
  }

  transitionTo('locked')
  console.log('[LockController] Locked')
}

// ---------------------------------------------------------------------------
// KiroCrew feed — only while locked; every snapshot is pushed to every cover.
// ---------------------------------------------------------------------------

/** index.ts wires the live config; tests may inject a feed that does not shell out. */
export function configureKiroCrewFeed(
  getCfg: () => KiroCrewFeedConfig,
  factory: typeof feedFactory = null,
): void {
  kirocrewConfigGetter = getCfg
  feedFactory = factory
}

function startKiroCrewFeed(): void {
  const getCfg = kirocrewConfigGetter
  if (!getCfg) return
  const onSnap = (snap: PulseSnapshot) => broadcastToLockWindows(IPC_CHANNELS.kirocrewPulse, snap)
  if (!feed) feed = feedFactory ? feedFactory(getCfg, onSnap) : new KiroCrewFeed(getCfg, onSnap)
  feed.start()
}

function stopKiroCrewFeed(): void {
  feed?.stop()
  feed = null
}

function broadcastToLockWindows(channel: string, payload: unknown): void {
  for (const w of lockWindows) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export async function unlock(config: LockConfig): Promise<void> {
  if (lockState !== 'locked') return
  if (authInProgress) return

  // Rate-limit failed attempts
  if (failCount >= FAIL_MAX_BEFORE_COOLDOWN && failCooldownTimer) {
    notifyLockWindows('auth-error', 'Too many failed attempts. Wait 30 seconds.')
    return
  }

  transitionTo('unlocking')

  if (config.requireAuth) {
    authInProgress = true
    notifyLockWindows('auth-start', '')

    // Lower the lock overlay below the credential dialog so the prompt is
    // visible AND its keystrokes reach it. screen-saver level forces our
    // window above all OS dialogs, which is what kept the password prompt
    // hidden previously. 'normal' is below dialogs.
    //
    // Only the PRIMARY display is lowered — that is where the Windows
    // credential dialog appears. Every other display keeps its full
    // kiosk + screen-saver shield, so multi-monitor setups no longer
    // expose the taskbar (and Slack hover previews) during auth.
    const primaryId = screen.getPrimaryDisplay().id
    for (const w of lockWindows) {
      if (!w.isDestroyed() && windowDisplayId(w) === primaryId) {
        unshieldWindow(w)
      }
    }

    let success = false
    try {
      success = await authenticateWindows()
    } finally {
      authInProgress = false
      // If unlock failed, restore the shielding level so the lock screen
      // is still on top of everything.
      if (!success) {
        for (const w of lockWindows) {
          if (!w.isDestroyed()) shieldWindow(w)
        }
      }
    }

    if (success) {
      doUnlock()
    } else {
      failCount++
      transitionTo('locked')
      notifyLockWindows('auth-error', 'Incorrect password. Try again.')

      if (failCount >= FAIL_MAX_BEFORE_COOLDOWN) {
        failCooldownTimer = setTimeout(() => {
          failCount = 0
          failCooldownTimer = null
        }, FAIL_COOLDOWN_MS)
      }
    }
  } else {
    doUnlock()
  }
}

/**
 * Passphrase-mode unlock. `text` is either the passphrase or, once the recovery
 * question has been offered, the recovery answer. Same failure counter and
 * cooldown as the Windows path. Never transitions through 'unlocking' —
 * verification is synchronous and there is no external dialog to wait on.
 */
export function unlockWithPassphrase(config: LockConfig, text: string): boolean {
  if (lockState !== 'locked') return false
  if (authInProgress) return false
  if (config.authMode !== 'passphrase' || !config.passphrase) {
    notifyLockWindows('auth-error', 'Passphrase unlock is not enabled.')
    return false
  }
  if (failCount >= FAIL_MAX_BEFORE_COOLDOWN && failCooldownTimer) {
    notifyLockWindows('auth-error', 'Too many failed attempts. Wait 30 seconds.')
    return false
  }
  const typed = typeof text === 'string' ? text : ''
  const recoveryOffered = failCount >= RECOVERY_AFTER_FAILURES && Boolean(config.recovery)
  const ok = verifySecret(typed, config.passphrase) || (recoveryOffered && verifyRecovery(typed, config.recovery))
  if (ok) {
    doUnlock()
    return true
  }
  failCount++
  if (failCount >= RECOVERY_AFTER_FAILURES && config.recovery) {
    // Offer the way back. The question is only ever sent after real failures.
    broadcastToLockWindows('recovery-offered', config.recovery.question)
    notifyLockWindows('auth-error', 'Incorrect. You can also type the answer to the question above.')
  } else {
    notifyLockWindows('auth-error', 'Incorrect passphrase. Try again.')
  }
  if (failCount >= FAIL_MAX_BEFORE_COOLDOWN && !failCooldownTimer) {
    failCooldownTimer = setTimeout(() => {
      // Lift the cooldown but keep recovery offered once it has been earned.
      failCount = Math.min(failCount, RECOVERY_AFTER_FAILURES)
      failCooldownTimer = null
    }, FAIL_COOLDOWN_MS)
  }
  return false
}

export function quickUnlock(): void {
  if (lockState !== 'locked') return
  doUnlock()
}

function doUnlock(): void {
  failCount = 0
  notifyLockWindows('unlock-success', '')

  // Brief success animation delay then close
  setTimeout(() => {
    stopInputBlocking()
    stopSleepPrevention()
    stopElapsedTimer()
    stopKiroCrewFeed()
    destroyLockScreens()
    lockedAt = undefined
    transitionTo('unlocked')
    console.log('[LockController] Unlocked')
  }, 600)
}

function notifyLockWindows(event: string, data: string): void {
  for (const w of lockWindows) {
    if (!w.isDestroyed()) w.webContents.send(event, data)
  }
}

export function getCurrentLockState(): LockState {
  return lockState
}

export function getLockedAt(): number | undefined {
  return lockedAt
}

export function onLockStateChange(handler: LockStateChangeHandler): void {
  stateHandlers.push(handler)
}

export function registerHotkey(config: LockConfig, onTrigger: () => void): void {
  if (hotkeyRegistered) {
    globalShortcut.unregisterAll()
    hotkeyRegistered = false
  }

  const hotkey = config.hotkey || 'Control+Shift+L'

  try {
    const ok = globalShortcut.register(hotkey, onTrigger)
    hotkeyRegistered = ok
    if (ok) console.log(`[LockController] Hotkey registered: ${hotkey}`)
    else console.warn(`[LockController] Failed to register hotkey: ${hotkey}`)
  } catch (err) {
    console.warn('[LockController] Hotkey registration error:', err)
  }

  // Emergency escape hatch: force-unlock without auth.
  // Use this if the credential dialog ever hangs again. Documented in
  // README.md ("Help, I'm stuck — just unlock!") so users know it exists.
  // Triple-modifier so it's hard to hit by accident.
  const emergencyHotkey = 'Control+Shift+Alt+U'
  try {
    const ok = globalShortcut.register(emergencyHotkey, () => {
      console.warn('[LockController] EMERGENCY UNLOCK invoked via hotkey')
      // 'locking' is included deliberately: if showLockScreens() failed
      // part-way the state can be 'locking' with a cover already on screen,
      // and that is precisely when a user reaches for this hotkey. Leaving
      // it out is what made a failed lock unrecoverable without Task Manager.
      if (lockState === 'locked' || lockState === 'unlocking' || lockState === 'locking') {
        // Force state to 'locked' so quickUnlock() will accept the call.
        if (lockState === 'unlocking' || lockState === 'locking') {
          authInProgress = false
          lockState = 'locked'
        }
        quickUnlock()
      }
    })
    if (ok) console.log(`[LockController] Emergency unlock hotkey registered: ${emergencyHotkey}`)
    // Registration failure was previously silent, while the tray menu
    // advertises the accelerator regardless — so the documented escape hatch
    // could be dead with no warning anywhere.
    else console.warn(`[LockController] FAILED to register emergency unlock hotkey: ${emergencyHotkey} — the documented escape hatch is NOT available`)
  } catch (err) {
    console.warn('[LockController] Emergency hotkey registration error:', err)
  }
}

export function unregisterHotkey(): void {
  if (hotkeyRegistered) {
    globalShortcut.unregisterAll()
    hotkeyRegistered = false
  }
}
