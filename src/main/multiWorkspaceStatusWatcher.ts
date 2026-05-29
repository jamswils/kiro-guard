/**
 * multiWorkspaceStatusWatcher.ts
 *
 * Watches all per-workspace status files written by kiro-buddy hooks at
 * ~/.kiro-buddy/workspaces/*<hash>*\/status.json
 *
 * Why: kiro-buddy's installed hooks write to a per-workspace status file
 * (path is hash-derived from the workspace folder). The legacy
 * ~/.kiro/status.json is not updated by current hooks. To make Kiro Guard
 * show live status from any open Kiro IDE window, we watch every
 * per-workspace file and surface the status of whichever one was most
 * recently updated -- i.e. the workspace the user is currently working in.
 *
 * Multiple chats in the same workspace share one file (kiro-buddy design),
 * so this also handles the multi-chat case implicitly: the most recent
 * prompt across all chats in that workspace wins.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import type { StatusPayload } from '../shared/types'
import { validateStatusPayload } from '../shared/validation'

const WORKSPACES_DIR = path.join(os.homedir(), '.kiro-buddy', 'workspaces')
const DEBOUNCE_MS = 100

type Subscriber = (payload: StatusPayload) => void

class MultiWorkspaceStatusWatcher {
  private watcher: FSWatcher | null = null
  private subscribers: Subscriber[] = []
  private currentStatus: StatusPayload | null = null
  private debounceTimer: NodeJS.Timeout | null = null

  start(): void {
    if (this.watcher) {
      console.warn('[MultiWorkspaceStatusWatcher] already started')
      return
    }

    if (!fs.existsSync(WORKSPACES_DIR)) {
      console.log(`[MultiWorkspaceStatusWatcher] no workspaces dir at ${WORKSPACES_DIR} - kiro-buddy hooks may not be installed yet`)
      // Still create the watcher in case the dir appears later.
      try { fs.mkdirSync(WORKSPACES_DIR, { recursive: true }) } catch {}
    }

    // Watch one level down: workspaces/<hash>/status.json
    const pattern = path.join(WORKSPACES_DIR, '*', 'status.json')

    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    })

    const onChange = (changedPath: string): void => {
      if (path.basename(changedPath) !== 'status.json') return
      this.scheduleUpdate()
    }

    this.watcher.on('change', onChange)
    this.watcher.on('add', onChange)
    this.watcher.on('error', (err: Error) => {
      console.warn(`[MultiWorkspaceStatusWatcher] watcher error: ${err.message}`)
    })

    console.log(`[MultiWorkspaceStatusWatcher] watching ${pattern}`)

    // Read the most recent status on startup so we have something to show
    // before the first hook fires.
    this.readMostRecent()
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      this.watcher.close().catch(() => {})
      this.watcher = null
    }
  }

  onStatusChange(handler: Subscriber): void {
    this.subscribers.push(handler)
  }

  getCurrentStatus(): StatusPayload | null {
    return this.currentStatus
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.readMostRecent()
    }, DEBOUNCE_MS)
  }

  /**
   * Walk all workspace status files, find the most recently modified one,
   * read and validate its payload, dispatch to subscribers if it differs
   * from the current status.
   */
  private readMostRecent(): void {
    if (!fs.existsSync(WORKSPACES_DIR)) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[MultiWorkspaceStatusWatcher] readdir failed: ${msg}`)
      return
    }

    let bestPath: string | null = null
    let bestMtime = 0

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(WORKSPACES_DIR, entry.name, 'status.json')
      try {
        const stat = fs.statSync(candidate)
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs
          bestPath = candidate
        }
      } catch {
        // file may not exist yet for that workspace; skip
      }
    }

    if (!bestPath) return

    let raw: string
    try {
      raw = fs.readFileSync(bestPath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[MultiWorkspaceStatusWatcher] read ${bestPath} failed: ${msg}`)
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      console.warn(`[MultiWorkspaceStatusWatcher] malformed JSON in ${bestPath}`)
      return
    }

    if (!validateStatusPayload(payload)) {
      console.warn(`[MultiWorkspaceStatusWatcher] invalid status payload in ${bestPath}`)
      return
    }

    // Skip dispatch if this is identical to the last one we sent
    const last = this.currentStatus
    if (
      last &&
      payload.status === last.status &&
      payload.message === last.message &&
      payload.timestamp === last.timestamp
    ) {
      return
    }

    this.currentStatus = payload
    for (const sub of this.subscribers) {
      try { sub(payload) } catch (err) {
        console.warn(`[MultiWorkspaceStatusWatcher] subscriber threw:`, err)
      }
    }
  }
}

export const multiWorkspaceStatusWatcher = new MultiWorkspaceStatusWatcher()
