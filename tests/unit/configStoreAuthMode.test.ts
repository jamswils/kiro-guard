/**
 * configStore v1.1.0: authMode is the source of truth, requireAuth is derived,
 * migration v3 maps old installs, and a passphrase mode without a verifier
 * falls back to the Windows prompt instead of producing an un-unlockable cover.
 */

let memStore: Record<string, unknown> = {}
jest.mock('electron-store', () => jest.fn().mockImplementation(() => ({
  get(key: string, d?: unknown) {
    if (key in memStore) return memStore[key]
    // electron-store returns the nested object for a prefix key; rebuild it
    const prefix = key + '.'
    const nested: Record<string, unknown> = {}
    let found = false
    for (const [k, v] of Object.entries(memStore)) {
      if (!k.startsWith(prefix)) continue
      found = true
      const parts = k.slice(prefix.length).split('.')
      let cur = nested
      for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] as Record<string, unknown>) ?? (cur[parts[i]] = {})
      cur[parts[parts.length - 1]] = v
    }
    return found ? nested : d
  },
  set(key: string, value: unknown) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(memStore)) if (k === key || k.startsWith(key + '.')) delete memStore[k]
      const flat = (o: Record<string, unknown>, prefix: string) => {
        for (const [k, v] of Object.entries(o)) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) flat(v as Record<string, unknown>, `${prefix}.${k}`)
          else memStore[`${prefix}.${k}`] = v
        }
      }
      flat(value as Record<string, unknown>, key)
    } else memStore[key] = value
  },
})))

async function load(seed: Record<string, unknown>) {
  memStore = { ...seed }
  jest.resetModules()
  return import('../../src/main/configStore')
}

describe('configStore authMode', () => {
  it('fresh install: windows password, feed off', async () => {
    const m = await load({})
    const c = m.getConfig()
    expect(c.lock.authMode).toBe('windows')
    expect(c.lock.requireAuth).toBe(true)
    expect(c.lock.passphrase).toBeUndefined()
    expect(c.kirocrew).toMatchObject({ enabled: false, source: 'ssh', intervalMs: 10_000 })
    expect(c.kirocrew.remoteScript).toMatch(/kiro_pulse\.py$/)
  })

  it('migration v3 maps a persisted requireAuth to authMode and stamps the version', async () => {
    const m1 = await load({ configVersion: 2, 'lock.requireAuth': false })
    expect(memStore['lock.authMode']).toBe('none')
    expect(memStore['configVersion']).toBe(m1.CONFIG_VERSION)
    expect(m1.getConfig().lock.requireAuth).toBe(false)

    await load({ configVersion: 2, 'lock.requireAuth': true })
    expect(memStore['lock.authMode']).toBe('windows')

    // a v1 install runs v2 (false->true) THEN v3 -> windows
    await load({ 'lock.requireAuth': false })
    expect(memStore['lock.requireAuth']).toBe(true)
    expect(memStore['lock.authMode']).toBe('windows')
  })

  it('migration does not overwrite an authMode that already exists', async () => {
    await load({ configVersion: 2, 'lock.requireAuth': true, 'lock.authMode': 'none' })
    expect(memStore['lock.authMode']).toBe('none')
  })

  it('setLockConfig keeps authMode and requireAuth consistent both ways', async () => {
    const m = await load({})
    m.setLockConfig({ authMode: 'none' })
    expect(m.getConfig().lock.requireAuth).toBe(false)
    m.setLockConfig({ requireAuth: true })          // legacy caller
    expect(m.getConfig().lock.authMode).toBe('windows')
    m.setLockConfig({ requireAuth: false })
    expect(m.getConfig().lock.authMode).toBe('none')
  })

  it('setPassphrase stores verifiers and switches mode; passphrase mode without a verifier falls back to windows', async () => {
    const m = await load({})
    m.setPassphrase({ salt: 's', hash: 'h', iterations: 300000 }, { question: 'Q?', salt: 's2', hash: 'h2', iterations: 300000 })
    const c = m.getConfig()
    expect(c.lock.authMode).toBe('passphrase')
    expect(c.lock.passphrase).toEqual({ salt: 's', hash: 'h', iterations: 300000 })
    expect(c.lock.recovery?.question).toBe('Q?')
    expect(c.lock.requireAuth).toBe(true)

    const m2 = await load({ configVersion: 3, 'lock.authMode': 'passphrase' })   // flag but no verifier
    expect(m2.getConfig().lock.authMode).toBe('windows')
  })

  it('setKiroCrewConfig merges and floors the interval', async () => {
    const m = await load({})
    m.setKiroCrewConfig({ enabled: true, sshHost: 'dev-dsk', intervalMs: 1000 })
    expect(m.getConfig().kirocrew).toMatchObject({ enabled: true, sshHost: 'dev-dsk', intervalMs: 5000, source: 'ssh' })
  })
})
