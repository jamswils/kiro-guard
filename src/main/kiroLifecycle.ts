import { app } from 'electron'
import { execFile } from 'child_process'

const WATCH_ENV = 'KIRO_BUDDY_EXIT_WITH_KIRO'
const POLL_MS = 5000
const MISSING_GRACE_MS = 15000

let pollTimer: NodeJS.Timeout | null = null
let missingSince: number | null = null

const WINDOWS_PROCESS_NAMES = new Set(['kiro.exe'])
const POSIX_PROCESS_NAMES = new Set(['kiro'])

function isKiroProcessName(name: string, platform: NodeJS.Platform): boolean {
  const normalized = name.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return platform === 'win32'
    ? WINDOWS_PROCESS_NAMES.has(normalized)
    : POSIX_PROCESS_NAMES.has(normalized)
}

function listProcesses(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-Process | Select-Object -ExpandProperty ProcessName",
        ],
        { windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          resolve(stdout.split(/\r?\n/).map((name) => `${name}.exe`))
        },
      )
      return
    }

    execFile('ps', ['-axo', 'comm=,command='], { encoding: 'utf8' }, (_error, stdout) => {
      resolve(stdout.split(/\r?\n/))
    })
  })
}

function isKiroCommandLine(commandLine: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return false
  }

  return commandLine.toLowerCase().includes('/kiro.app/')
}

export async function isKiroRunning(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const processes = await listProcesses(platform)
  return processes.some((processInfo) => {
    const processName = processInfo.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
    return isKiroProcessName(processName, platform) || isKiroCommandLine(processInfo, platform)
  })
}

export function startKiroLifecycleWatcher(): void {
  if (process.env[WATCH_ENV] !== '1' || pollTimer) {
    return
  }

  const poll = async (): Promise<void> => {
    const running = await isKiroRunning()
    if (running) {
      missingSince = null
      return
    }

    missingSince ??= Date.now()
    if (Date.now() - missingSince >= MISSING_GRACE_MS) {
      app.quit()
    }
  }

  pollTimer = setInterval(() => {
    void poll()
  }, POLL_MS)
  void poll()
}

export function stopKiroLifecycleWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  missingSince = null
}
