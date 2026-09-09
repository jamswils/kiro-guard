/**
 * The real lock.html in a FRESH JSDOM per test (scripts run in page scope, exactly
 * like the real cover), driven through the same bridge the preload exposes.
 */
import * as fs from 'fs'
import * as path from 'path'
import { JSDOM } from 'jsdom'

type Init = { message: string; showElapsed: boolean; lockedAt: number; authMode?: string; requireAuth?: boolean; kirocrewEnabled?: boolean }
type Bridge = {
  init: (d: Init) => void
  pulse: (s: unknown) => void
  recovery: (q: string) => void
  authError: (m: string) => void
  elapsed: (now: number) => void
  submitted: string[]
  unlockRequests: number
}

let dom: JSDOM | null = null
let doc: Document

async function loadLock(): Promise<Bridge> {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'lock.html'), 'utf8')
  const b: Partial<Bridge> & { submitted: string[]; unlockRequests: number } = { submitted: [], unlockRequests: 0 }
  dom?.window.close()
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      ;(window as unknown as { kiroLock: unknown }).kiroLock = {
        onInit: (h: Bridge['init']) => { b.init = h },
        onStatus: () => {}, onElapsed: (h: Bridge['elapsed']) => { b.elapsed = h },
        onAuthStart: () => {}, onAuthError: (h: Bridge['authError']) => { b.authError = h }, onUnlockSuccess: () => {},
        onRecoveryOffered: (h: Bridge['recovery']) => { b.recovery = h },
        onKiroCrewPulse: (h: Bridge['pulse']) => { b.pulse = h },
        requestUnlock: () => { b.unlockRequests++ },
        submitPassphrase: (t: string) => { b.submitted.push(t) },
      }
      ;(window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ({ clearRect: () => {}, drawImage: () => {} })
    },
  })
  doc = dom.window.document
  // jsdom fires DOMContentLoaded asynchronously; the page binds its button there.
  if (doc.readyState === 'loading') await new Promise<void>(r => doc.addEventListener('DOMContentLoaded', () => r()))
  return b as Bridge
}
function renderPulse(snap: unknown, now: number): void {
  ;(dom!.window as unknown as { renderPulse: (s: unknown, n: number) => void }).renderPulse(snap, now)
}
function key(input: HTMLInputElement, k: string): void {
  input.dispatchEvent(new dom!.window.KeyboardEvent('keydown', { key: k, bubbles: true }))
}
// The page runs animation timers; an open window keeps Jest's event loop alive forever.
afterAll(() => { dom?.window.close(); dom = null })

const $ = (id: string) => doc.getElementById(id)!
const base: Init = { message: 'm', showElapsed: false, lockedAt: 1 }

describe('lock screen auth modes', () => {
  it('windows: password button, no passphrase box', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows', requireAuth: true })
    expect($('unlockBtn').textContent!.trim()).toBe('Unlock with Windows password')
    expect($('passRow').dataset.visible).toBe('false')
    $('unlockBtn').click()
    expect(b.unlockRequests).toBe(1)
    expect(b.submitted).toEqual([])
  })

  it('passphrase: box shown, Enter and the button both submit, empty is ignored, box is cleared', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'passphrase', requireAuth: true })
    expect($('passRow').dataset.visible).toBe('true')
    expect($('unlockBtn').textContent!.trim()).toBe('Unlock')
    expect($('authHint').textContent).toMatch(/passphrase/i)
    const input = $('passInput') as HTMLInputElement
    $('unlockBtn').click()
    expect(b.submitted).toEqual([])                  // empty -> nothing sent
    input.value = 'open sesame'
    key(input, 'Enter')
    expect(b.submitted).toEqual(['open sesame'])
    expect(input.value).toBe('')
    input.value = 'second'
    $('unlockBtn').click()
    expect(b.submitted).toEqual(['open sesame', 'second'])
    expect(b.unlockRequests).toBe(0)                 // never asks main for a Windows prompt
  })

  it('passphrase: recovery question appears only when main offers it', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'passphrase', requireAuth: true })
    expect($('passQuestion').textContent).toBe('')
    b.recovery("Mother's maiden name")
    expect($('passQuestion').textContent).toBe("Forgot it? Answer: Mother's maiden name")
    expect(($('passInput') as HTMLInputElement).placeholder).toBe('passphrase or answer')
  })

  it('none: honest hint pointing at the tray "Unlock with" menu', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'none', requireAuth: false })
    expect($('unlockBtn').textContent!.trim()).toBe('Unlock')
    expect($('authHint').textContent).toMatch(/unlocks immediately/)
    expect($('authHint').textContent).toMatch(/"Unlock with"/)
    expect($('passRow').dataset.visible).toBe('false')
  })

  it('switching modes clears the recovery question, error text and typed input from the previous mode', async () => {
    // Caught by eye, not by the earlier tests: after a wrong passphrase, switching to
    // Windows mode left "Forgot it? Answer: …" and the red error on the new cover.
    const b = await loadLock(); b.init({ ...base, authMode: 'passphrase', requireAuth: true })
    ;($('passInput') as HTMLInputElement).value = 'half-typed'
    b.recovery("Mother's maiden name")
    b.authError('Incorrect. You can also type the answer to the question above.')
    expect($('passQuestion').textContent).not.toBe('')
    expect($('authError').textContent).not.toBe('')
    b.init({ ...base, authMode: 'windows', requireAuth: true })
    expect($('passQuestion').textContent).toBe('')
    expect($('authError').textContent).toBe('')
    expect(($('passInput') as HTMLInputElement).value).toBe('')
    expect(($('passInput') as HTMLInputElement).placeholder).toBe('passphrase')
    expect($('passRow').dataset.visible).toBe('false')
  })

  it('legacy payload without authMode still resolves from requireAuth', async () => {
    const b = await loadLock(); b.init({ ...base, requireAuth: true })
    expect($('unlockBtn').textContent!.trim()).toBe('Unlock with Windows password')
  })
})

describe('lock screen KiroCrew block', () => {
  const NOW = 1_800_000_000_000
  const snap = {
    generatedAt: NOW - 4000, receivedAt: NOW, headline: 'KiroCrew is working', chatsActive: 2, agentsRunning: 5,
    turnsLast10m: 3, lastMessageAgeS: 4,
    chats: [
      { title: 'Kiro Guard deep dive', state: 'Kiro is working (running tools)', ageS: 4, active: true },
      { title: 'Old bridge', state: 'idle', ageS: 900, active: false },
    ], lines: [],
  }

  it('hidden until a snapshot arrives; "connecting" placeholder when the feed is enabled', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows' })
    expect($('crew').dataset.visible).toBe('false')
    const b2 = await loadLock(); b2.init({ ...base, authMode: 'windows', kirocrewEnabled: true })
    expect($('crew').dataset.visible).toBe('true')
    expect($('crewLines').textContent).toMatch(/connecting/)
  })

  it('renders headline, chat lines with active markers, and freshness', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows' })
    renderPulse(snap, NOW)
    expect($('crew').dataset.visible).toBe('true')
    expect($('crewHead').textContent).toBe('KiroCrew is working  ·  2 chats active  ·  5 agents running  ·  3 turns in 10m  ·  last message 4s ago')
    const lines = Array.from($('crewLines').children) as HTMLElement[]
    expect(lines.map(l => l.textContent)).toEqual([
      'Kiro Guard deep dive  (Kiro is working (running tools), 4s)',
      'Old bridge  (idle, 15m)',
    ])
    expect(lines.map(l => l.dataset.active)).toEqual(['true', 'false'])
    expect($('crew').dataset.stale).toBe('false')
    expect($('crewAge').textContent).toBe('updated 4s ago')
  })

  it('goes amber and says so when the snapshot is older than 90s; error snapshots too', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows' })
    renderPulse(snap, NOW + 100_000)
    expect($('crew').dataset.stale).toBe('true')
    expect($('crewAge').textContent).toMatch(/feed stale/)
    renderPulse({ ...snap, chats: [], error: 'Permission denied (publickey)', receivedAt: NOW - 20_000 }, NOW)
    expect($('crew').dataset.error).toBe('true')
    expect($('crewHead').textContent).toBe('KiroCrew feed unreachable')
    expect($('crewLines').textContent).toMatch(/Permission denied/)
    expect($('crewAge').textContent).toBe('last tried 20s ago')
  })

  it('text-only snapshots (file source) render their lines with > as active', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows' })
    b.pulse({ ...snap, chats: [], lines: ['> A  (x, 1s)', '- B  (idle, 5m)'] })
    const lines = Array.from($('crewLines').children) as HTMLElement[]
    expect(lines.map(l => l.textContent)).toEqual(['A  (x, 1s)', 'B  (idle, 5m)'])
    expect(lines.map(l => l.dataset.active)).toEqual(['true', 'false'])
  })

  it('the elapsed tick re-renders the age line so staleness is live', async () => {
    const b = await loadLock(); b.init({ ...base, authMode: 'windows' })
    b.pulse(snap)
    b.elapsed(NOW + 95_000)
    expect($('crew').dataset.stale).toBe('true')
  })
})
