/**
 * kirocrewFeed.ts — nothing here shells out: the ssh runner is injected and the
 * file source uses a temp file.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parsePulseJson, parsePulseText, errorSnapshot, isStale, fetchOnce, KiroCrewFeed,
  STALE_AFTER_MS, MAX_CHATS_SHOWN,
} from '../../src/main/kirocrewFeed'
import type { KiroCrewFeedConfig } from '../../src/shared/types'

const NOW = 1_800_000_000_000
const PULSE = {
  generated_at: NOW / 1000 - 3,
  chats_active: 2, chats_recent: 3, agents_running: 5, turns_last_10m: 7, last_message_age_s: 4.2,
  chats: [
    { key: 'a', title: 'Kiro Guard deep dive', age_s: 4.2, last_role: 'tool', active: true, state: 'Kiro is working (running tools)' },
    { key: 'b', title: 'Bridge', age_s: 40, last_role: 'assistant', active: true, state: 'Kiro is replying' },
    { key: 'c', title: 'Old', age_s: 900, last_role: 'user', active: false, state: 'idle' },
  ],
  errors: [],
}
const base: KiroCrewFeedConfig = { enabled: true, source: 'ssh', sshHost: 'devdsk', remoteScript: '~/p.py', statusFile: '', intervalMs: 10_000 }

describe('parsePulseJson', () => {
  it('maps kiro_pulse --json into the lock-screen view model', () => {
    const s = parsePulseJson(JSON.stringify(PULSE), NOW)
    expect(s.headline).toBe('KiroCrew is working')
    expect(s.chatsActive).toBe(2)
    expect(s.agentsRunning).toBe(5)
    expect(s.turnsLast10m).toBe(7)
    expect(s.lastMessageAgeS).toBeCloseTo(4.2)
    expect(s.generatedAt).toBe(Math.round((NOW / 1000 - 3) * 1000))
    expect(s.receivedAt).toBe(NOW)
    expect(s.chats.map(c => c.title)).toEqual(['Kiro Guard deep dive', 'Bridge', 'Old'])
    expect(s.chats[0]).toMatchObject({ state: 'Kiro is working (running tools)', active: true })
    expect(s.error).toBeUndefined()
  })

  it('headline reflects idle vs nothing', () => {
    expect(parsePulseJson(JSON.stringify({ ...PULSE, chats_active: 0, agents_running: 0 }), NOW).headline).toBe('KiroCrew is idle')
    expect(parsePulseJson(JSON.stringify({ chats_active: 0, agents_running: 0, chats: [] }), NOW).headline).toBe('KiroCrew: no recent activity')
  })

  it('caps chats shown and tolerates missing fields', () => {
    const many = { chats: Array.from({ length: 9 }, (_, i) => ({ title: `c${i}`, active: true })) }
    const s = parsePulseJson(JSON.stringify(many), NOW)
    expect(s.chats.length).toBe(MAX_CHATS_SHOWN)
    expect(s.chats[0].state).toBe('moving')
    expect(s.generatedAt).toBe(NOW)   // no generated_at -> receivedAt
  })

  it('throws on non-JSON and non-object payloads', () => {
    expect(() => parsePulseJson('KiroCrew is working', NOW)).toThrow(/not JSON/)
    expect(() => parsePulseJson('[1,2]', NOW)).toThrow(/not an object/)
  })
})

describe('parsePulseText / errorSnapshot / isStale', () => {
  it('text: first line is the headline, rest are lines, capped', () => {
    const txt = 'KiroCrew is working | 1 chat\r\n> A (x, 1s)\n- B (idle, 5m)\n\n' + Array(10).fill('> more').join('\n')
    const s = parsePulseText(txt, NOW - 1000, NOW)
    expect(s.headline).toBe('KiroCrew is working | 1 chat')
    expect(s.lines[0]).toBe('> A (x, 1s)')
    expect(s.lines.length).toBe(MAX_CHATS_SHOWN + 1)
    expect(s.generatedAt).toBe(NOW - 1000)
  })

  it('staleness uses generatedAt, not receivedAt', () => {
    const fresh = parsePulseText('x', NOW - 10_000, NOW)
    const old = parsePulseText('x', NOW - STALE_AFTER_MS - 1, NOW)
    expect(isStale(fresh, NOW)).toBe(false)
    expect(isStale(old, NOW)).toBe(true)
    expect(isStale(null, NOW)).toBe(true)
    expect(isStale(errorSnapshot('boom', NOW), NOW)).toBe(true)
  })
})

describe('fetchOnce', () => {
  it('ssh: runs the pulse script with --json on the configured host', async () => {
    const calls: Array<[string, string]> = []
    const ssh = async (h: string, c: string) => { calls.push([h, c]); return JSON.stringify(PULSE) }
    const s = await fetchOnce(base, { ssh, now: () => NOW })
    expect(calls).toEqual([['devdsk', 'python3 ~/p.py --json']])
    expect(s.chatsActive).toBe(2)
  })

  it('ssh failure becomes an error snapshot, never a throw or an empty "idle"', async () => {
    const ssh = async () => { throw new Error('Permission denied (publickey)') }
    const s = await fetchOnce(base, { ssh, now: () => NOW })
    expect(s.error).toBe('Permission denied (publickey)')
    expect(s.headline).toBe('KiroCrew feed unreachable')
    expect(isStale(s, NOW)).toBe(true)
  })

  it('ssh with no host configured is an error, not a hang', async () => {
    const s = await fetchOnce({ ...base, sshHost: '  ' }, { ssh: async () => 'x', now: () => NOW })
    expect(s.error).toMatch(/no KiroCrew host/)
  })

  it('file: reads JSON or text and uses the file mtime as freshness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgfeed-'))
    try {
      const f = path.join(dir, 'status.txt')
      fs.writeFileSync(f, 'KiroCrew is working | 2 chats\n> A (Kiro is replying, 3s)\n')
      const mtime = new Date(NOW - 5000); fs.utimesSync(f, mtime, mtime)
      const t = await fetchOnce({ ...base, source: 'file', statusFile: f }, { now: () => NOW })
      expect(t.headline).toBe('KiroCrew is working | 2 chats')
      expect(t.lines).toEqual(['> A (Kiro is replying, 3s)'])
      expect(Math.abs(t.generatedAt - (NOW - 5000))).toBeLessThan(1000)

      fs.writeFileSync(f, JSON.stringify(PULSE)); fs.utimesSync(f, mtime, mtime)
      const j = await fetchOnce({ ...base, source: 'file', statusFile: f }, { now: () => NOW })
      expect(j.chats.length).toBe(3)
      // the feeder's own generated_at is newer than the file mtime here; mtime wins (honest)
      expect(Math.abs(j.generatedAt - (NOW - 5000))).toBeLessThan(1000)

      const missing = await fetchOnce({ ...base, source: 'file', statusFile: path.join(dir, 'nope') }, { now: () => NOW })
      expect(missing.error).toMatch(/ENOENT|no such file/i)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('KiroCrewFeed poller', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('does nothing when disabled, polls on the interval when enabled, stops cleanly', async () => {
    let cfg = { ...base, enabled: false, intervalMs: 7_000 }
    const snaps: unknown[] = []
    let n = 0
    const ssh = async () => { n++; return JSON.stringify(PULSE) }
    const feed = new KiroCrewFeed(() => cfg, (s) => snaps.push(s), { ssh, now: () => NOW, log: () => {} })
    feed.start()
    expect(feed.running).toBe(false)
    expect(n).toBe(0)

    cfg = { ...cfg, enabled: true }
    feed.start()
    expect(feed.running).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    expect(n).toBe(1)                       // immediate first poll
    await jest.advanceTimersByTimeAsync(7_000)
    expect(n).toBe(2)
    await jest.advanceTimersByTimeAsync(14_000)
    expect(n).toBe(4)
    expect(snaps.length).toBe(4)
    expect(feed.latest).not.toBeNull()

    feed.stop()
    expect(feed.running).toBe(false)
    expect(feed.latest).toBeNull()
    await jest.advanceTimersByTimeAsync(30_000)
    expect(n).toBe(4)
  })

  it('enforces a 5s floor on the interval and logs a failure streak once', async () => {
    const logs: string[] = []
    let fail = true
    const ssh = async () => { if (fail) throw new Error('down'); return JSON.stringify(PULSE) }
    const feed = new KiroCrewFeed(() => ({ ...base, intervalMs: 1 }), () => {}, { ssh, now: () => NOW, log: (m) => logs.push(m) })
    feed.start()
    await Promise.resolve(); await Promise.resolve()
    await jest.advanceTimersByTimeAsync(5_000)
    await jest.advanceTimersByTimeAsync(5_000)
    expect(logs.filter(l => /down/.test(l)).length).toBe(1)   // not once per tick
    fail = false
    await jest.advanceTimersByTimeAsync(5_000)
    expect(logs.some(l => /recovered after 3 failed polls/.test(l))).toBe(true)
    feed.stop()
  })
})
