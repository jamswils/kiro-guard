/**
 * kirocrewFeed.ts — live "what is KiroCrew doing" for the lock screen.
 *
 * Kiro Guard runs on the laptop; KiroCrew runs on a cloud desktop. The bridge is
 * kiro_pulse.py (shipped in scripts/kirocrew/), a read-only script on the
 * KiroCrew host that summarises chat/agent activity from file timestamps and
 * process liveness — never message content. Two ways to reach it:
 *
 *   ssh  — run `ssh <host> python3 <remoteScript> --json` on an interval
 *   file — read a local file some other feeder keeps fresh (text or JSON)
 *
 * Polling only happens while the screen is locked. Every snapshot carries the
 * time it was produced so the lock screen can colour a dead feed amber instead
 * of showing a stale "Kiro is working" as live. Failures are surfaced as a
 * snapshot with `error` set, never swallowed: a feed that cannot be reached
 * must look different from "nothing happening".
 */
import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import type { KiroCrewFeedConfig } from '../shared/types'

export interface PulseChat {
  title: string
  state: string
  ageS: number
  active: boolean
}

export interface PulseSnapshot {
  /** When the data was produced (ms epoch). For 'file' this is the file mtime. */
  generatedAt: number
  /** When we received it (ms epoch). */
  receivedAt: number
  headline: string
  chatsActive: number
  agentsRunning: number
  turnsLast10m: number
  lastMessageAgeS: number | null
  chats: PulseChat[]
  /** Raw text lines when the source was plain text, else empty. */
  lines: string[]
  error?: string
}

export const STALE_AFTER_MS = 90_000
export const MAX_CHATS_SHOWN = 4

export function isStale(snap: PulseSnapshot | null, now: number = Date.now()): boolean {
  if (!snap) return true
  return now - snap.generatedAt > STALE_AFTER_MS
}

function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

/** Parse kiro_pulse.py --json output. Throws on anything that is not the expected shape. */
export function parsePulseJson(text: string, receivedAt: number = Date.now()): PulseSnapshot {
  let d: unknown
  try { d = JSON.parse(text) } catch { throw new Error('pulse output is not JSON') }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('pulse JSON is not an object')
  const o = d as Record<string, unknown>
  const chatsRaw = Array.isArray(o.chats) ? o.chats : []
  const chats: PulseChat[] = chatsRaw.slice(0, MAX_CHATS_SHOWN).map((c) => {
    const r = (c ?? {}) as Record<string, unknown>
    return {
      title: String(r.title ?? r.key ?? 'chat').slice(0, 60),
      state: String(r.state ?? (r.active ? 'moving' : 'idle')),
      ageS: num(r.age_s),
      active: Boolean(r.active),
    }
  })
  const chatsActive = num(o.chats_active)
  const agentsRunning = num(o.agents_running)
  const recent = Array.isArray(o.chats) ? o.chats.length : 0
  const headline = chatsActive || agentsRunning ? 'KiroCrew is working'
    : recent ? 'KiroCrew is idle' : 'KiroCrew: no recent activity'
  const gen = num(o.generated_at, NaN)
  return {
    generatedAt: Number.isFinite(gen) ? Math.round(gen * 1000) : receivedAt,
    receivedAt,
    headline,
    chatsActive,
    agentsRunning,
    turnsLast10m: num(o.turns_last_10m),
    lastMessageAgeS: typeof o.last_message_age_s === 'number' ? o.last_message_age_s : null,
    chats,
    lines: [],
  }
}

/** Plain-text fallback (e.g. Freeze Screen's status.txt): first line is the headline. */
export function parsePulseText(text: string, generatedAt: number, receivedAt: number = Date.now()): PulseSnapshot {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.length > 0)
  return {
    generatedAt, receivedAt,
    headline: lines[0] ?? 'KiroCrew',
    chatsActive: 0, agentsRunning: 0, turnsLast10m: 0, lastMessageAgeS: null,
    chats: [],
    lines: lines.slice(1, 1 + MAX_CHATS_SHOWN + 1),
  }
}

export function errorSnapshot(message: string, receivedAt: number = Date.now()): PulseSnapshot {
  return {
    generatedAt: 0, receivedAt,
    headline: 'KiroCrew feed unreachable',
    chatsActive: 0, agentsRunning: 0, turnsLast10m: 0, lastMessageAgeS: null,
    chats: [], lines: [], error: message,
  }
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

export type SshRunner = (host: string, remoteCommand: string) => Promise<string>

/** Default runner: BatchMode so a hidden process never sits on a password prompt. */
export const sshRunner: SshRunner = (host, remoteCommand) => new Promise((resolve, reject) => {
  execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', host, remoteCommand],
    { timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split(/\r?\n/).pop() || 'ssh failed'
        reject(new Error(tail))
        return
      }
      resolve(String(stdout))
    })
})

export async function fetchOnce(cfg: KiroCrewFeedConfig, deps: { ssh?: SshRunner; now?: () => number } = {}): Promise<PulseSnapshot> {
  const now = deps.now ?? Date.now
  try {
    if (cfg.source === 'ssh') {
      if (!cfg.sshHost.trim()) throw new Error('no KiroCrew host configured')
      const out = await (deps.ssh ?? sshRunner)(cfg.sshHost.trim(), `python3 ${cfg.remoteScript} --json`)
      return parsePulseJson(out, now())
    }
    if (!cfg.statusFile.trim()) throw new Error('no status file configured')
    const [text, st] = await Promise.all([fsp.readFile(cfg.statusFile, 'utf8'), fsp.stat(cfg.statusFile)])
    const trimmed = text.trim()
    if (trimmed.startsWith('{')) {
      const snap = parsePulseJson(trimmed, now())
      // A JSON file written by a feeder: the file mtime is the honest freshness signal.
      return { ...snap, generatedAt: Math.min(snap.generatedAt, st.mtimeMs) }
    }
    return parsePulseText(trimmed, st.mtimeMs, now())
  } catch (e) {
    return errorSnapshot((e as Error).message || String(e), now())
  }
}

/**
 * Poller. start() fetches immediately then on the interval; stop() cancels.
 * Consecutive failures are logged once, not every tick.
 */
export class KiroCrewFeed {
  private timer: NodeJS.Timeout | null = null
  private inflight = false
  private failStreak = 0
  latest: PulseSnapshot | null = null

  constructor(
    private readonly getConfig: () => KiroCrewFeedConfig,
    private readonly onSnapshot: (snap: PulseSnapshot) => void,
    private readonly deps: { ssh?: SshRunner; now?: () => number; log?: (m: string) => void } = {},
  ) {}

  get running(): boolean { return this.timer !== null }

  start(): void {
    if (this.timer) return
    const cfg = this.getConfig()
    if (!cfg.enabled) return
    const interval = Math.max(5_000, cfg.intervalMs || 10_000)
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, interval)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.inflight = false
    this.latest = null
    this.failStreak = 0
  }

  async tick(): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    try {
      const snap = await fetchOnce(this.getConfig(), this.deps)
      if (snap.error) {
        this.failStreak++
        if (this.failStreak === 1) (this.deps.log ?? console.warn)(`[KiroCrewFeed] ${snap.error}`)
      } else if (this.failStreak > 0) {
        (this.deps.log ?? console.log)(`[KiroCrewFeed] recovered after ${this.failStreak} failed polls`)
        this.failStreak = 0
      }
      this.latest = snap
      this.onSnapshot(snap)
    } finally {
      this.inflight = false
    }
  }
}
