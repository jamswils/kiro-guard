import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const projectRoot = path.resolve(__dirname, '..', '..')
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function normalizeCommand(command: string): string {
  return command.replace(/\\/g, '/')
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-buddy-platform-'))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('platform script compatibility', () => {
  it('npm status scripts run through the cross-platform Node hook', () => {
    const tempDir = makeTempDir()
    const statusFilePath = path.join(tempDir, 'status.json')

    try {
      const result = spawnSync(npmBin, ['run', 'status:working'], {
        cwd: projectRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          KIRO_BUDDY_NO_AUTOSTART: '1',
          KIRO_BUDDY_STATUS_FILE: statusFilePath,
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('powershell.exe: command not found')

      const payload = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'))
      expect(payload).toMatchObject({
        status: 'working',
        message: 'Kiro is working',
      })
    } finally {
      cleanup(tempDir)
    }
  })

  it('installs Kiro hook commands and slash agents for the current platform', () => {
    const tempDir = makeTempDir()

    try {
      const result = spawnSync(process.execPath, ['scripts/install-kiro-hooks.cjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KIRO_BUDDY_WORKSPACE: tempDir,
        },
      })

      expect(result.status).toBe(0)

      const scriptName = process.platform === 'win32' ? 'kiro-status-hook.ps1' : 'kiro-status-hook.cjs'
      expect(fs.existsSync(path.join(tempDir, '.kiro', 'kiro-buddy', scriptName))).toBe(true)
      const installMetadata = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'kiro-buddy', 'install.json'), 'utf8'),
      )
      expect(installMetadata.statusFilePath).toContain(path.join('.kiro-buddy', 'workspaces'))

      const workingHook = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-working.kiro.hook'), 'utf8'),
      )
      const command = workingHook.then.command as string
      const openHook = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-on.kiro.hook'), 'utf8'),
      )
      const askingHook = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-waiting.kiro.hook'), 'utf8'),
      )
      const specActivityHook = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-spec-activity.kiro.hook'),
          'utf8',
        ),
      )
      const settings = JSON.parse(fs.readFileSync(path.join(tempDir, '.vscode', 'settings.json'), 'utf8'))
      const trustedCommands = settings['kiroAgent.trustedCommands'] as string[]
      expect(specActivityHook.enabled).toBe(true)
      expect(specActivityHook.then.command).toContain('--require-phase')
      expect(specActivityHook.then.command).toContain('--fallback-asking-ms=2000')

      if (process.platform === 'win32') {
        const installedPowerShellHook = fs.readFileSync(
          path.join(tempDir, '.kiro', 'kiro-buddy', 'kiro-status-hook.ps1'),
          'utf8',
        )
        expect(installedPowerShellHook).toContain('$startInfo.CreateNoWindow = $true')
        expect(installedPowerShellHook).toContain('$startInfo.RedirectStandardOutput = $true')
        expect(installedPowerShellHook).toContain('$startInfo.RedirectStandardError = $true')
        expect(command).toContain('powershell.exe')
        expect(command).toContain('kiro-status-hook.ps1')
        expect(command).toContain('--status-file=')
        expect(command).toContain(installMetadata.statusFilePath)
        expect(command).not.toContain('--read-stdin')
        expect(openHook.then.command).toContain('& "')
        expect(openHook.then.command).toContain('$env:KIRO_BUDDY_STATUS_FILE')
        expect(askingHook.then.command).toContain('kiro-status-hook.ps1')
        expect(askingHook.then.command).toContain('asking')
        expect(askingHook.then.command).not.toContain('--read-stdin')
      } else {
        expect(command).toContain('KIRO_BUDDY_STATUS_FILE=')
        expect(command).toContain(installMetadata.statusFilePath)
        expect(command).toContain(process.execPath)
        expect(command).toContain('kiro-status-hook.cjs')
        expect(command).not.toContain('powershell.exe')
        expect(command).toContain('--read-stdin')
        expect(openHook.then.command).toContain('KIRO_BUDDY_STATUS_FILE=')
        expect(openHook.then.command).toContain(installMetadata.statusFilePath)
      }

      const openAgentPath = path.join(tempDir, '.kiro', 'agents', 'buddy-open.md')
      const closeAgentPath = path.join(tempDir, '.kiro', 'agents', 'buddy-close.md')
      const testAgentPath = path.join(tempDir, '.kiro', 'agents', 'buddy-test.md')
      expect(fs.existsSync(openAgentPath)).toBe(true)
      expect(fs.existsSync(closeAgentPath)).toBe(true)
      expect(fs.existsSync(testAgentPath)).toBe(true)

      const openAgent = fs.readFileSync(openAgentPath, 'utf8')
      expect(openAgent).toContain('name: buddy-open')
      expect(openAgent).toContain('tools: ["shell"]')
      expect(openAgent).toContain(process.execPath)
      expect(normalizeCommand(openAgent)).toContain('bin/kiro-buddy.cjs')
      expect(openAgent).toContain(installMetadata.statusFilePath)
      expect(openAgent).toContain('open')
      expect(openAgent).toContain('Kiro Buddy command finished.')

      const testAgent = fs.readFileSync(testAgentPath, 'utf8')
      expect(testAgent).toContain('name: buddy-test')
      expect(testAgent).toContain('test')
      expect(testAgent).toContain(installMetadata.statusFilePath)
      expect(testAgent).toContain('Your first action must be to call the shell tool')
      expect(testAgent).toContain('Run Command Hook output is ambient Buddy status')
      expect(testAgent).toContain('Kiro Buddy command finished.')
      expect(trustedCommands).toContain(command)
      expect(trustedCommands).toContain(askingHook.then.command)
      expect(trustedCommands).toContain(openHook.then.command)
      expect(
        trustedCommands.some(
          (trustedCommand) =>
            normalizeCommand(trustedCommand).includes('bin/kiro-buddy.cjs') &&
            trustedCommand.includes('open') &&
            trustedCommand.includes('Kiro Buddy command finished.'),
        ),
      ).toBe(true)
      expect(
        trustedCommands.some(
          (trustedCommand) =>
            normalizeCommand(trustedCommand).includes('bin/kiro-buddy.cjs') &&
            trustedCommand.includes('test'),
        ),
      ).toBe(true)
    } finally {
      cleanup(tempDir)
    }
  })

  it('runs generated Windows IDE hooks through PowerShell and records approval context', () => {
    if (process.platform !== 'win32') {
      return
    }

    const tempDir = makeTempDir()
    try {
      const installResult = spawnSync(process.execPath, ['scripts/install-kiro-hooks.cjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KIRO_BUDDY_WORKSPACE: tempDir,
        },
      })
      expect(installResult.status).toBe(0)
      const installMetadata = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'kiro-buddy', 'install.json'), 'utf8'),
      )
      const statusFilePath = installMetadata.statusFilePath
      expect(typeof statusFilePath).toBe('string')

      const workingHook = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-working.kiro.hook'), 'utf8'),
      )
      const askingHook = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.kiro', 'hooks', 'kiro-buddy-waiting.kiro.hook'), 'utf8'),
      )

      const workingResult = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', workingHook.then.command],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            KIRO_BUDDY_NO_AUTOSTART: '1',
            USER_PROMPT: 'please update requirements.md',
          },
        },
      )

      expect(workingResult.status).toBe(0)
      expect(JSON.parse(fs.readFileSync(statusFilePath, 'utf8'))).toMatchObject({
        status: 'working',
        message: 'Prompt: please update requirements.md',
        phase: 'requirements',
        context: 'Prompt: please update requirements.md',
      })

      const askingResult = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', askingHook.then.command],
        {
          cwd: tempDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            KIRO_BUDDY_NO_AUTOSTART: '1',
            KIRO_ACTIVE_FILE: path.join(tempDir, 'requirements.md'),
          },
        },
      )

      expect(askingResult.status).toBe(0)
      expect(JSON.parse(fs.readFileSync(statusFilePath, 'utf8'))).toMatchObject({
        status: 'asking',
        message: 'Kiro is asking for your input',
        phase: 'requirements',
        context: 'requirements.md',
      })
    } finally {
      cleanup(tempDir)
    }
  })

  it('accepts legacy Windows PowerShell --read-stdin flags without blocking', () => {
    if (process.platform !== 'win32') {
      return
    }

    const tempDir = makeTempDir()
    const statusFilePath = path.join(tempDir, 'status.json')

    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(projectRoot, 'scripts', 'kiro-status-hook.ps1'),
          'working',
          '--read-stdin',
          '--require-phase',
          `--status-file=${statusFilePath}`,
        ],
        {
          cwd: tempDir,
          encoding: 'utf8',
          timeout: 3000,
          env: {
            ...process.env,
            KIRO_BUDDY_NO_AUTOSTART: '1',
            USER_PROMPT: 'please update requirements.md',
          },
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Kiro Buddy: working')
      expect(JSON.parse(fs.readFileSync(statusFilePath, 'utf8'))).toMatchObject({
        status: 'working',
        phase: 'requirements',
        message: 'Prompt: please update requirements.md',
      })
    } finally {
      cleanup(tempDir)
    }
  })

  it('lets users set Buddy size from the CLI', () => {
    const homeDir = makeTempDir()

    try {
      const baseEnv = {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        KIRO_BUDDY_DRY_RUN: '1',
      }

      const setResult = spawnSync(process.execPath, ['bin/kiro-buddy.cjs', 'size', '80'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: baseEnv,
      })
      expect(setResult.status).toBe(0)
      expect(setResult.stdout).toContain('Kiro Buddy size: 80%')

      const configPath = path.join(homeDir, '.kiro-buddy', 'config.json')
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ petScale: 0.8 })

      const increaseResult = spawnSync(process.execPath, ['bin/kiro-buddy.cjs', 'size', '+'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: baseEnv,
      })
      expect(increaseResult.status).toBe(0)
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ petScale: 0.9 })
    } finally {
      cleanup(homeDir)
    }
  })

  it('replaces stale Kiro Buddy trusted commands for the same workspace', () => {
    const tempDir = makeTempDir()
    const vscodeDir = path.join(tempDir, '.vscode')
    const settingsPath = path.join(vscodeDir, 'settings.json')
    const scriptName = process.platform === 'win32' ? 'kiro-status-hook.ps1' : 'kiro-status-hook.cjs'
    const statusHookPath = path.join(tempDir, '.kiro', 'kiro-buddy', scriptName)
    const cliPath = path.join(projectRoot, 'bin', 'kiro-buddy.cjs')

    try {
      fs.mkdirSync(vscodeDir, { recursive: true })
      fs.writeFileSync(
        settingsPath,
        `${JSON.stringify(
          {
            'kiroAgent.trustedCommands': [
              `"old-node" "${statusHookPath}"`,
              `"old-node" "${cliPath}"`,
              'echo unrelated',
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      const result = spawnSync(process.execPath, ['scripts/install-kiro-hooks.cjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          KIRO_BUDDY_WORKSPACE: tempDir,
        },
      })

      expect(result.status).toBe(0)

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      const trustedCommands = settings['kiroAgent.trustedCommands'] as string[]

      expect(trustedCommands).toContain('echo unrelated')
      expect(trustedCommands.some((command) => command.includes('old-node'))).toBe(false)
      expect(trustedCommands.some((command) => command.includes(statusHookPath))).toBe(true)
      expect(trustedCommands.some((command) => command.includes(cliPath))).toBe(true)
    } finally {
      cleanup(tempDir)
    }
  })

  it('installs a Kiro CLI agent config with Buddy hooks', () => {
    const tempDir = makeTempDir()
    const homeDir = makeTempDir()

    try {
      const result = spawnSync(process.execPath, ['scripts/install-kiro-cli-hooks.cjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          KIRO_BUDDY_WORKSPACE: tempDir,
        },
      })

      expect(result.status).toBe(0)

      const agentPath = path.join(homeDir, '.kiro', 'agents', 'kiro-buddy-cli.json')
      const workspaceAgentPath = path.join(tempDir, '.kiro', 'agents', 'kiro-buddy-cli.json')
      expect(fs.existsSync(agentPath)).toBe(true)
      expect(fs.existsSync(workspaceAgentPath)).toBe(true)

      const config = JSON.parse(fs.readFileSync(agentPath, 'utf8'))
      expect(config.name).toBe('kiro-buddy-cli')
      expect(normalizeCommand(config.hooks.agentSpawn[0].command)).toContain('bin/kiro-buddy.cjs')
      expect(config.hooks.agentSpawn[0].command).toContain('cli')
      expect(config.hooks.agentSpawn[0].command).toContain('open')
      expect(config.hooks.userPromptSubmit[0].command).toContain('kiro-status-hook.cjs')
      expect(config.hooks.userPromptSubmit[0].command).toContain('working')
      expect(config.hooks.preToolUse[0].matcher).toBe('*')
      expect(config.hooks.preToolUse[0].command).toContain('kiro-status-hook.cjs')
      expect(config.hooks.preToolUse[0].command).toContain('asking')
      if (process.platform === 'win32') {
        expect(config.hooks.agentSpawn[0].command).toMatch(/^&\s+"/)
        expect(config.hooks.userPromptSubmit[0].command).toMatch(/^&\s+"/)
        expect(config.hooks.preToolUse[0].command).toMatch(/^&\s+"/)
      }
      expect(config.hooks.postToolUse[0].matcher).toBe('*')
      expect(config.hooks.stop[0].command).toContain('done')
    } finally {
      cleanup(tempDir)
      cleanup(homeDir)
    }
  })

  it('routes CLI status hooks to a session status file when a session id is set', () => {
    const tempDir = makeTempDir()
    const homeDir = makeTempDir()
    const sessionId = 'cli-session-routing-test'

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/kiro-status-hook.cjs', 'working'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            KIRO_BUDDY_NO_AUTOSTART: '1',
            KIRO_BUDDY_SESSION_ID: sessionId,
          },
        },
      )

      expect(result.status).toBe(0)

      const sessionStatusPath = path.join(
        homeDir,
        '.kiro-buddy',
        'sessions',
        sessionId,
        'status.json',
      )
      expect(JSON.parse(fs.readFileSync(sessionStatusPath, 'utf8'))).toMatchObject({
        status: 'working',
        message: 'Kiro is working',
      })
      expect(fs.existsSync(path.join(homeDir, '.kiro', 'status.json'))).toBe(false)
    } finally {
      cleanup(tempDir)
      cleanup(homeDir)
    }
  })
})
