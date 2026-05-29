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
import type { LockState, LockConfig, StatusPayload } from '../shared/types'
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
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

async function showLockScreens(config: LockConfig): Promise<void> {
  const displays = screen.getAllDisplays()
  lockWindows = displays.map(d => createLockWindow(d))

  const lockHtmlPath = require('path').join(__dirname, '..', '..', 'renderer', 'lock.html')
  const currentStatus = statusManager.getCurrentStatus()

  for (const win of lockWindows) {
    await win.loadFile(lockHtmlPath)
    win.webContents.send('lock-init', {
      message: config.lockMessage,
      showElapsed: config.showElapsedTime,
      lockedAt,
      status: currentStatus?.status ?? 'idle',
    })
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

  // Keep enforcing top-most. Skip when auth is in progress so the
  // credential dialog can appear above the lock window. Without this
  // skip, the timer re-applies screen-saver level mid-auth and the
  // password dialog ends up hidden behind the lock screen.
  topMostTimer = setInterval(() => {
    if (authInProgress) return
    for (const w of lockWindows) {
      if (!w.isDestroyed()) {
        w.setAlwaysOnTop(true, 'screen-saver', 1)
        w.moveTop()
      }
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
      // Use orderOut equivalent: just close without triggering app quit
      try { win.close() } catch {}
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

function startSleepPrevention(): void {
  if (powerSaveId !== null) return
  powerSaveId = powerSaveBlocker.start('prevent-display-sleep')
}

function stopSleepPrevention(): void {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId)
    powerSaveId = null
  }
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
    // matches how `test-auth.ps1` (which works) is invoked.
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
      { windowsHide: false, timeout: 120_000 },
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

  await showLockScreens(config)
  startInputBlocking()
  startSleepPrevention()
  startElapsedTimer()

  transitionTo('locked')
  console.log('[LockController] Locked')
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
    for (const w of lockWindows) {
      if (!w.isDestroyed()) {
        try { w.setKiosk(false) } catch {}
        try { w.setAlwaysOnTop(false) } catch {}
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
          if (!w.isDestroyed()) {
            try { w.setAlwaysOnTop(true, 'screen-saver', 1) } catch {}
            try { w.setKiosk(true) } catch {}
          }
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
  // STATE.md so users know it exists. Triple-modifier so it's hard to hit
  // by accident.
  const emergencyHotkey = 'Control+Shift+Alt+U'
  try {
    const ok = globalShortcut.register(emergencyHotkey, () => {
      console.warn('[LockController] EMERGENCY UNLOCK invoked via hotkey')
      if (lockState === 'locked' || lockState === 'unlocking') {
        // Force state to 'locked' so quickUnlock() will accept the call.
        if (lockState === 'unlocking') {
          authInProgress = false
          lockState = 'locked'
        }
        quickUnlock()
      }
    })
    if (ok) console.log(`[LockController] Emergency unlock hotkey registered: ${emergencyHotkey}`)
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
