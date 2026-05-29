/**
 * statusManager.ts
 *
 * Reads and watches `status.json`, validates payloads, and dispatches state
 * changes to registered subscribers.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.4, 3.5, 3.6, 11.3, 11.4, 11.5
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import type { StatusPayload } from '../shared/types'
import { validateStatusPayload } from '../shared/validation'
import { DEBOUNCE_MS } from '../shared/constants'

// ---------------------------------------------------------------------------
// Path traversal validation
// ---------------------------------------------------------------------------

/**
 * Validates that `filePath` does not contain path traversal sequences and
 * resolves within the user's home directory.
 *
 * Rejects paths containing:
 *   - `../` or `..\` (relative traversal)
 *   - null bytes (`\0`)
 *   - Absolute paths that resolve outside the user's home directory
 *
 * @param filePath - The file path to validate
 * @returns `true` if the path is safe, `false` otherwise
 */
export function validateStatusFilePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    console.warn('[StatusManager] Path validation failed: empty or non-string path')
    return false
  }

  // Reject null bytes
  if (filePath.includes('\0')) {
    console.warn('[StatusManager] Path validation failed: null byte in path')
    return false
  }

  // Reject relative traversal sequences
  if (filePath.includes('../') || filePath.includes('..\\')) {
    console.warn('[StatusManager] Path validation failed: path traversal sequence detected')
    return false
  }

  // Resolve the path and check it stays within the home directory
  const homeDir = os.homedir()
  const resolved = path.resolve(filePath)

  // Ensure resolved path starts with homeDir (with trailing separator to avoid
  // prefix collisions like /home/user vs /home/username)
  const homeDirNormalized = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep
  if (!resolved.startsWith(homeDirNormalized) && resolved !== homeDir) {
    console.warn(
      `[StatusManager] Path validation failed: resolved path "${resolved}" is outside home directory "${homeDir}"`
    )
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// StatusManager implementation
// ---------------------------------------------------------------------------

class StatusManagerImpl {
  private filePath: string | null = null
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private pendingPath: string | null = null
  private currentStatus: StatusPayload | null = null
  private subscribers: Array<(payload: StatusPayload) => void> = []

  /**
   * Initializes the StatusManager with the given file path.
   *
   * - Validates the path against traversal attacks
   * - Creates the file with default `idle` payload if missing
   * - Reads and dispatches the initial state
   *
   * Requirements: 2.1, 2.2, 2.3, 11.3, 11.4, 11.5
   */
  async initialize(filePath: string): Promise<void> {
    if (!validateStatusFilePath(filePath)) {
      console.warn(`[StatusManager] initialize() rejected invalid path: "${filePath}"`)
      return
    }

    this.filePath = filePath

    try {
      this.ensureStatusFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[StatusManager] Failed to initialize status file: ${message}`)
      return
    }

    this.processStatusUpdate(filePath)
  }

  /**
   * Starts watching the status file for changes using chokidar.
   *
   * Requirements: 2.1, 2.4, 2.5
   */
  startWatching(): void {
    if (this.filePath === null) {
      console.warn('[StatusManager] startWatching() called before initialize()')
      return
    }

    if (this.watcher !== null) {
      console.warn('[StatusManager] startWatching() called while already watching')
      return
    }

    const filePath = this.filePath
    const watchDir = path.dirname(filePath)
    const statusFileName = path.basename(filePath)
    const isStatusFileEvent = (eventPath: string): boolean =>
      path.basename(eventPath) === statusFileName

    this.watcher = chokidar.watch(watchDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    })

    this.watcher.on('change', (changedPath: string) => {
      if (isStatusFileEvent(changedPath)) {
        this.scheduleStatusUpdate(filePath)
      }
    })

    this.watcher.on('add', (addedPath: string) => {
      if (isStatusFileEvent(addedPath)) {
        this.scheduleStatusUpdate(filePath)
      }
    })

    this.watcher.on('unlink', (removedPath: string) => {
      if (!isStatusFileEvent(removedPath)) {
        return
      }

      try {
        this.ensureStatusFile(filePath)
        this.scheduleStatusUpdate(filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[StatusManager] Failed to recreate missing status file: ${message}`)
      }
    })

    this.watcher.on('error', (err: Error) => {
      console.warn(`[StatusManager] Watcher error: ${err.message}`)
    })
  }

  /**
   * Stops the chokidar watcher and releases resources.
   *
   * Requirement: 2.6
   */
  stopWatching(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
      this.pendingPath = null
    }

    if (this.watcher !== null) {
      this.watcher.close()
      this.watcher = null
    }
  }

  /**
   * Writes a trusted in-process status update through the same status file that
   * external Kiro hooks use. This gives internal monitors one canonical path
   * into the renderer instead of bypassing validation/subscriber dispatch.
   */
  writeStatus(payload: StatusPayload): void {
    if (this.filePath === null) {
      console.warn('[StatusManager] writeStatus() called before initialize()')
      return
    }

    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const tempFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tempFile, `${JSON.stringify(payload)}\n`, 'utf-8')
      fs.renameSync(tempFile, this.filePath)
      this.processStatusUpdate(this.filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[StatusManager] Failed to write status file: ${message}`)
    }
  }

  /**
   * Registers a subscriber callback that is called whenever a valid status
   * change is dispatched.
   *
   * Requirement: 2.4
   */
  onStatusChange(callback: (payload: StatusPayload) => void): void {
    this.subscribers.push(callback)
  }

  /**
   * Returns the last valid `StatusPayload` received, or `null` if none has
   * been dispatched yet.
   */
  getCurrentStatus(): StatusPayload | null {
    return this.currentStatus
  }

  /**
   * Returns the watched status file path, when initialized.
   */
  getStatusFilePath(): string | null {
    return this.filePath
  }

  private ensureStatusFile(filePath: string): void {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    if (!fs.existsSync(filePath)) {
      const defaultPayload: StatusPayload = {
        status: 'idle',
        message: 'Kiro is ready',
        timestamp: Date.now(),
      }
      fs.writeFileSync(filePath, JSON.stringify(defaultPayload), 'utf-8')
    }
  }

  private scheduleStatusUpdate(filePath: string): void {
    this.pendingPath = filePath
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      const pendingPath = this.pendingPath
      this.debounceTimer = null
      this.pendingPath = null
      if (pendingPath) {
        this.processStatusUpdate(pendingPath)
      }
    }, DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  /**
   * Reads, parses, validates, debounces, and dispatches a status update.
   *
   * Design pseudocode:
   *   1. Read file (IO error → log warning, return)
   *   2. Parse JSON (parse error → log warning, return)
   *   3. Validate payload (invalid → log warning, return)
   *   4. Debounce: skip if same status within DEBOUNCE_MS window
   *   5. Dispatch to subscribers
   *
   * Requirements: 3.4, 3.5, 3.6, 2.4, 2.5
   */
  processStatusUpdate(filePath: string): void {
    // Step 1: Read file
    let rawContent: string
    try {
      rawContent = fs.readFileSync(filePath, 'utf-8')
    } catch (ioError) {
      const msg = ioError instanceof Error ? ioError.message : String(ioError)
      console.warn(`[StatusManager] Failed to read status file: ${msg}`)
      return
    }

    // Step 2: Parse JSON (never use eval())
    let payload: unknown
    try {
      payload = JSON.parse(rawContent)
    } catch (parseError) {
      console.warn('[StatusManager] Malformed status.json — ignoring update')
      return
    }

    // Step 3: Validate payload
    if (!validateStatusPayload(payload)) {
      console.warn('[StatusManager] Invalid payload schema — ignoring update')
      return
    }

    // Step 4: Debounce identical rapid repeats, but let prompt/message changes through.
    const lastPayload = this.getCurrentStatus()
    if (
      lastPayload !== null &&
      payload.status === lastPayload.status &&
      payload.message === lastPayload.message &&
      payload.phase === lastPayload.phase &&
      payload.context === lastPayload.context &&
      payload.timestamp - lastPayload.timestamp < DEBOUNCE_MS
    ) {
      return
    }

    // Step 5: Update current status and dispatch to subscribers
    this.currentStatus = payload
    for (const subscriber of this.subscribers) {
      subscriber(payload)
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Singleton StatusManager instance */
export const statusManager = new StatusManagerImpl()
