import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const projectRoot = path.resolve(__dirname, '..', '..')
const cliPath = path.join(projectRoot, 'bin', 'kiro-buddy.cjs')

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-buddy-cli-'))
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function runCli(homeDir: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      KIRO_BUDDY_DRY_RUN: '1',
      KIRO_BUDDY_STATUS_FILE: path.join(homeDir, '.kiro', 'status.json'),
    },
  })
}

describe('kiro-buddy CLI open/close controls', () => {
  let tempDir: string
  let manualClosePath: string
  let lastCommandPath: string
  let launchRequestPath: string
  let statusFilePath: string

  beforeEach(() => {
    tempDir = makeTempDir()
    manualClosePath = path.join(tempDir, '.kiro-buddy', 'manual-close.json')
    lastCommandPath = path.join(tempDir, '.kiro-buddy', 'last-command.json')
    launchRequestPath = path.join(tempDir, '.kiro-buddy', 'last-launch.json')
    statusFilePath = path.join(tempDir, '.kiro', 'status.json')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it.each(['close', 'off'])('%s records manual close state', (command) => {
    const result = runCli(tempDir, [command])

    expect(result.status).toBe(0)
    expect(fs.existsSync(manualClosePath)).toBe(true)
    expect(readJson<{ command: string }>(lastCommandPath)).toMatchObject({
      command: 'buddy-close',
    })
  })

  it.each([
    ['open', 'buddy-open'],
    ['on', 'buddy-open'],
  ])('%s clears manual close state and writes idle status', (command, lastCommand) => {
    fs.mkdirSync(path.dirname(manualClosePath), { recursive: true })
    fs.writeFileSync(manualClosePath, '{"timestamp":1}\n', 'utf8')

    const result = runCli(tempDir, [command])

    expect(result.status).toBe(0)
    expect(fs.existsSync(manualClosePath)).toBe(false)
    expect(readJson<{ command: string }>(lastCommandPath)).toMatchObject({
      command: lastCommand,
    })
    expect(readJson<{ command: string }>(launchRequestPath)).toMatchObject({
      command: lastCommand,
      exitWithKiro: true,
    })
    expect(readJson<{ status: string }>(statusFilePath)).toMatchObject({
      status: 'idle',
    })
  })

  it('test opens Buddy through the visual test command path', () => {
    fs.mkdirSync(path.dirname(manualClosePath), { recursive: true })
    fs.writeFileSync(manualClosePath, '{"timestamp":1}\n', 'utf8')

    const result = runCli(tempDir, ['test'])

    expect(result.status).toBe(0)
    expect(fs.existsSync(manualClosePath)).toBe(false)
    expect(readJson<{ command: string }>(lastCommandPath)).toMatchObject({
      command: 'buddy-test',
    })
    expect(readJson<{ command: string }>(launchRequestPath)).toMatchObject({
      command: 'buddy-test',
      exitWithKiro: true,
    })
  })

  it('cli open clears manual close state and writes idle status', () => {
    fs.mkdirSync(path.dirname(manualClosePath), { recursive: true })
    fs.writeFileSync(manualClosePath, '{"timestamp":1}\n', 'utf8')

    const result = runCli(tempDir, ['cli', 'open'])

    expect(result.status).toBe(0)
    expect(fs.existsSync(manualClosePath)).toBe(false)
    expect(readJson<{ command: string }>(lastCommandPath)).toMatchObject({
      command: 'buddy-cli-open',
    })
    expect(readJson<{ command: string; exitWithKiro: boolean }>(launchRequestPath)).toMatchObject({
      command: 'buddy-cli-open',
      exitWithKiro: false,
    })
    expect(readJson<{ status: string }>(statusFilePath)).toMatchObject({
      status: 'idle',
    })
  })

  it('cli open uses a session-scoped status file when KIRO_BUDDY_SESSION_ID is set', () => {
    const result = spawnSync(process.execPath, [cliPath, 'cli', 'open'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        USERPROFILE: tempDir,
        KIRO_BUDDY_DRY_RUN: '1',
        KIRO_BUDDY_SESSION_ID: 'terminal-one',
      },
    })

    const sessionStatusPath = path.join(tempDir, '.kiro-buddy', 'sessions', 'terminal-one', 'status.json')

    expect(result.status).toBe(0)
    expect(readJson<{ command: string; sessionId: string; statusFilePath: string }>(launchRequestPath)).toMatchObject({
      command: 'buddy-cli-open',
      sessionId: 'terminal-one',
      statusFilePath: sessionStatusPath,
    })
    expect(readJson<{ status: string }>(sessionStatusPath)).toMatchObject({
      status: 'idle',
    })
  })

  it('cli run creates a dedicated session environment for Kiro CLI', () => {
    const result = spawnSync(process.execPath, [cliPath, 'cli', 'run', '--', 'chat', '--agent', 'kiro-buddy-cli'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        USERPROFILE: tempDir,
        KIRO_BUDDY_DRY_RUN: '1',
        KIRO_BUDDY_SESSION_ID: 'terminal-two',
      },
    })

    const sessionStatusPath = path.join(tempDir, '.kiro-buddy', 'sessions', 'terminal-two', 'status.json')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Kiro Buddy: session terminal-two')
    expect(result.stdout).toContain(`Kiro Buddy: status file ${sessionStatusPath}`)
    expect(result.stdout).toContain('Kiro Buddy: kiro-cli chat --agent kiro-buddy-cli')
  })

  it('cli install writes the Kiro CLI agent config and the installed agent opens Buddy for CLI sessions', () => {
    const result = spawnSync(process.execPath, [cliPath, 'cli', 'install'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        USERPROFILE: tempDir,
        KIRO_BUDDY_WORKSPACE: tempDir,
      },
    })

    expect(result.status).toBe(0)
    const agentPath = path.join(tempDir, '.kiro', 'agents', 'kiro-buddy-cli.json')
    expect(fs.existsSync(agentPath)).toBe(true)

    const agentConfig = readJson<{
      hooks: {
        agentSpawn: Array<{ command: string }>
        preToolUse: Array<{ command: string; matcher: string }>
      }
    }>(agentPath)
    expect(agentConfig.hooks.agentSpawn[0].command).toContain('cli')
    expect(agentConfig.hooks.agentSpawn[0].command).toContain('open')
    expect(agentConfig.hooks.preToolUse[0]).toMatchObject({
      matcher: '*',
    })
    expect(agentConfig.hooks.preToolUse[0].command).toContain('asking')
    if (process.platform === 'win32') {
      expect(agentConfig.hooks.agentSpawn[0].command).toMatch(/^&\s+"/)
      expect(agentConfig.hooks.preToolUse[0].command).toMatch(/^&\s+"/)
    }

    const commandEnv = {
      ...process.env,
      HOME: tempDir,
      USERPROFILE: tempDir,
      KIRO_BUDDY_DRY_RUN: '1',
      KIRO_BUDDY_STATUS_FILE: statusFilePath,
    }
    const openResult =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', agentConfig.hooks.agentSpawn[0].command],
            {
              cwd: tempDir,
              encoding: 'utf8',
              env: commandEnv,
            },
          )
        : spawnSync(agentConfig.hooks.agentSpawn[0].command, {
            cwd: tempDir,
            encoding: 'utf8',
            shell: true,
            env: commandEnv,
          })

    expect(openResult.status).toBe(0)
    expect(readJson<{ command: string; exitWithKiro: boolean }>(launchRequestPath)).toMatchObject({
      command: 'buddy-cli-open',
      exitWithKiro: false,
    })
    expect(readJson<{ status: string }>(statusFilePath)).toMatchObject({
      status: 'idle',
    })
  })
})
