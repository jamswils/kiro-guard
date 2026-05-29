const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const workspaceRoot = path.resolve(process.env.KIRO_BUDDY_WORKSPACE || process.cwd())
const hookDir = path.join(workspaceRoot, '.kiro', 'hooks')
const agentDir = path.join(workspaceRoot, '.kiro', 'agents')
const isWindows = process.platform === 'win32'
const sourceStatusHookPath = path.join(
  __dirname,
  isWindows ? 'kiro-status-hook.ps1' : 'kiro-status-hook.cjs',
)
const installedScriptDir = path.join(workspaceRoot, '.kiro', 'kiro-buddy')
const installMetadataPath = path.join(installedScriptDir, 'install.json')
const statusHookPath = path.join(
  installedScriptDir,
  isWindows ? 'kiro-status-hook.ps1' : 'kiro-status-hook.cjs',
)
const cliPath = path.join(path.resolve(__dirname, '..'), 'bin', 'kiro-buddy.cjs')
const vscodeSettingsPath = path.join(workspaceRoot, '.vscode', 'settings.json')
const workspaceFolderName = path.basename(workspaceRoot)
const workspaceStatusFilePath = path.join(
  process.env.HOME || process.env.USERPROFILE || workspaceRoot,
  '.kiro-buddy',
  'workspaces',
  crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12),
  'status.json',
)

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

function quoteShellEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function quotePowerShellArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function commandFor(status, phase, options = {}) {
  const extraArgs = [
    ...(isWindows ? [`--status-file=${workspaceStatusFilePath}`] : []),
    ...(options.readStdin && !isWindows ? ['--read-stdin'] : []),
    ...(options.requirePhase ? ['--require-phase'] : []),
    ...(typeof options.delayMs === 'number' ? [`--delay-ms=${options.delayMs}`] : []),
    ...(typeof options.fallbackAskingMs === 'number'
      ? [`--fallback-asking-ms=${options.fallbackAskingMs}`]
      : []),
  ]
  const env = {
    KIRO_BUDDY_STATUS_FILE: workspaceStatusFilePath,
  }

  const args = isWindows
    ? [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        quoteCommandArg(statusHookPath),
        status,
      ]
    : [
        ...Object.entries(env).map(([key, value]) => `${key}=${quoteShellEnvValue(value)}`),
        quoteCommandArg(process.execPath),
        quoteCommandArg(statusHookPath),
        status,
      ]

  if (phase) {
    args.push(phase)
  } else if (isWindows && extraArgs.length > 0) {
    args.push('auto')
  }
  args.push(...(isWindows ? extraArgs.map(quoteCommandArg) : extraArgs))

  return args.join(' ')
}

function controlCommandFor(action) {
  const command = [quoteCommandArg(process.execPath), quoteCommandArg(cliPath), action].join(' ')
  if (isWindows) {
    return command
  }

  return `KIRO_BUDDY_STATUS_FILE=${quoteShellEnvValue(workspaceStatusFilePath)} ${command}`
}

function controlShellCommandFor(action) {
  if (isWindows) {
    return [
      `$env:KIRO_BUDDY_STATUS_FILE=${quotePowerShellArg(workspaceStatusFilePath)};`,
      '&',
      quoteCommandArg(process.execPath),
      quoteCommandArg(cliPath),
      action,
    ].join(' ')
  }

  return controlCommandFor(action)
}

function agentShellCommandFor(action) {
  const command = controlShellCommandFor(action)
  if (isWindows) {
    return `${command}; Write-Output 'Kiro Buddy command finished.'`
  }

  return `${command}; printf '\\nKiro Buddy command finished.\\n'`
}

function trustedCommandPrefix() {
  if (isWindows) {
    return [
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      quoteCommandArg(statusHookPath),
    ].join(' ')
  }

  return [quoteCommandArg(process.execPath), quoteCommandArg(statusHookPath)].join(' ')
}

function trustedControlCommandPrefix() {
  return [quoteCommandArg(process.execPath), quoteCommandArg(cliPath)].join(' ')
}

function trustedControlShellCommandPrefix() {
  if (isWindows) {
    return ['&', quoteCommandArg(process.execPath), quoteCommandArg(cliPath)].join(' ')
  }

  return trustedControlCommandPrefix()
}

function hookFileName(shortName) {
  return path.join(hookDir, `${shortName}.kiro.hook`)
}

function writeHook(shortName, hook) {
  const filePath = hookFileName(shortName)
  const json = `${JSON.stringify(hook, null, 2)}\n`
  fs.writeFileSync(filePath, json, 'utf8')
  return filePath
}

function agentFileName(name) {
  return path.join(agentDir, `${name}.md`)
}

function writeAgent(name, description, action, doneMessage) {
  const command = agentShellCommandFor(action)
  const filePath = agentFileName(name)
  const markdown = `---
name: ${name}
description: ${description}
tools: ["shell"]
includeMcpJson: false
includePowers: false
---

You control Kiro Buddy.

Your first action must be to call the shell tool with this exact command:

\`\`\`shell
${command}
\`\`\`

Rules:
- Run Command Hook output is ambient Buddy status. Ignore it; it does not count as the command above.
- The command intentionally starts or stops a detached Buddy app.
- When the terminal prints "Kiro Buddy command finished.", the command is done.
- Do not inspect the repository.
- Do not ask the user questions.
- Do not answer until the shell command above has finished.
- Do not use any tool except the shell tool call needed to run the command above.
- After the command finishes, reply with exactly: ${doneMessage}
`

  fs.writeFileSync(filePath, markdown, 'utf8')
  return filePath
}

function removeStaleHook(shortName) {
  const filePath = hookFileName(shortName)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

function installWorkspaceTrustedCommand() {
  const trustedPrefix = trustedCommandPrefix()
  const trustedControlPrefix = trustedControlCommandPrefix()
  let settings = {}

  if (fs.existsSync(vscodeSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(vscodeSettingsPath, 'utf8'))
    } catch {
      console.warn(
        `Skipped Kiro trusted command setup because ${vscodeSettingsPath} is not plain JSON.`,
      )
      return null
    }
  }

  const current = Array.isArray(settings['kiroAgent.trustedCommands'])
    ? settings['kiroAgent.trustedCommands']
    : []

  const nextTrustedCommands = current.filter(
    (command) => !command.includes(statusHookPath) && !command.includes(cliPath),
  )
  for (const command of [
    trustedPrefix,
    trustedControlPrefix,
    trustedControlShellCommandPrefix(),
    ...hooks.map((hook) => hook.command),
    controlShellCommandFor('open'),
    controlShellCommandFor('close'),
    controlShellCommandFor('test'),
    agentShellCommandFor('open'),
    agentShellCommandFor('close'),
    agentShellCommandFor('test'),
  ]) {
    if (!nextTrustedCommands.includes(command)) {
      nextTrustedCommands.push(command)
    }
  }

  if (JSON.stringify(nextTrustedCommands) !== JSON.stringify(current)) {
    settings['kiroAgent.trustedCommands'] = nextTrustedCommands
    fs.mkdirSync(path.dirname(vscodeSettingsPath), { recursive: true })
    fs.writeFileSync(vscodeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  }

  return trustedPrefix
}

const hooks = [
  {
    shortName: 'kiro-buddy-on',
    name: 'Kiro Buddy Open',
    description: 'Opens Kiro Buddy manually and switches it to the ready idle state.',
    when: { type: 'userTriggered' },
    command: controlShellCommandFor('open'),
  },
  {
    shortName: 'kiro-buddy-close',
    name: 'Kiro Buddy Close',
    description: 'Closes Kiro Buddy manually until it is opened again.',
    when: { type: 'userTriggered' },
    command: controlShellCommandFor('close'),
  },
  {
    shortName: 'kiro-buddy-working',
    name: 'Kiro Buddy Working',
    description:
      'Notifies Kiro Buddy to switch to working whenever a prompt is submitted to the agent.',
    when: { type: 'promptSubmit' },
    command: commandFor('working', undefined, { readStdin: true }),
  },
  {
    shortName: 'kiro-buddy-waiting',
    name: 'Kiro Buddy Asking For Input',
    description:
      'Automatically switches Kiro Buddy to asking when Kiro waits for user approval or input.',
    when: { type: 'preToolUse' },
    command: commandFor('asking', undefined, { readStdin: true }),
  },
  {
    shortName: 'kiro-buddy-tool-running',
    name: 'Kiro Buddy Tool Running',
    description:
      'Switches Kiro Buddy back to working after an approved tool or command runs.',
    when: { type: 'postToolUse' },
    command: commandFor('working', undefined, { readStdin: true }),
  },
  {
    shortName: 'kiro-buddy-done',
    name: 'Kiro Buddy Done',
    description:
      'Notifies Kiro Buddy to switch to done whenever the agent stops responding.',
    when: { type: 'agentStop' },
    command: commandFor('done'),
  },
  {
    shortName: 'kiro-buddy-error-test',
    name: 'Kiro Buddy Error Test',
    description: 'Manually triggers the Kiro Buddy error state for testing.',
    when: { type: 'userTriggered' },
    command: commandFor('error'),
  },
  {
    shortName: 'kiro-buddy-asking-test',
    name: 'Kiro Buddy Asking Test',
    description: 'Manually triggers the Kiro Buddy asking state for testing user-input prompts.',
    when: { type: 'userTriggered' },
    command: commandFor('asking'),
  },
  {
    shortName: 'kiro-buddy-spec-activity',
    name: 'Kiro Buddy Spec Activity',
    description:
      'Automatically switches Kiro Buddy to Design, Requirements, or Task List animations during spec work.',
    when: { type: 'postToolUse', toolTypes: ['write', 'spec'] },
    command: commandFor('working', undefined, {
      readStdin: true,
      requirePhase: true,
      fallbackAskingMs: 2000,
    }),
  },
]

if (!fs.existsSync(sourceStatusHookPath)) {
  console.error(`Missing status hook script: ${sourceStatusHookPath}`)
  process.exit(1)
}

fs.mkdirSync(hookDir, { recursive: true })
fs.mkdirSync(agentDir, { recursive: true })
fs.mkdirSync(installedScriptDir, { recursive: true })
const trustedPrefix = installWorkspaceTrustedCommand()
removeStaleHook('kiro-buddy-start')
removeStaleHook('kiro-buddy-workspace-load')
removeStaleHook('kiro-buddy-design-test')
removeStaleHook('kiro-buddy-requirements-test')
removeStaleHook('kiro-buddy-tasks-test')
fs.copyFileSync(sourceStatusHookPath, statusHookPath)
// Remove Zone.Identifier ADS on Windows so PowerShell doesn't prompt "Do you want to run?"
if (isWindows) {
  try { fs.unlinkSync(`${statusHookPath}:Zone.Identifier`) } catch {}
}
fs.writeFileSync(
  installMetadataPath,
  `${JSON.stringify(
    { packageRoot: path.resolve(__dirname, '..'), statusFilePath: workspaceStatusFilePath },
    null,
    2,
  )}\n`,
  'utf8',
)

const written = hooks.map(({ shortName, name, description, when, command, enabled = true }) =>
  writeHook(shortName, {
    enabled,
    name,
    description,
    version: '1',
    when,
    then: {
      type: 'runCommand',
      command,
    },
    workspaceFolderName,
    shortName,
  }),
)
const writtenAgents = [
  writeAgent(
    'buddy-open',
    'Open Kiro Buddy from the slash command box.',
    'open',
    'Kiro Buddy opened.',
  ),
  writeAgent(
    'buddy-close',
    'Close Kiro Buddy from the slash command box.',
    'close',
    'Kiro Buddy closed.',
  ),
  writeAgent(
    'buddy-test',
    'Run Kiro Buddy visual test mode from the slash command box.',
    'test',
    'Kiro Buddy visual test started.',
  ),
]

console.log(`Installed Kiro Buddy status script into ${statusHookPath}`)
console.log(`Installed ${written.length} Kiro Buddy hooks into ${hookDir}`)
console.log(`Installed ${writtenAgents.length} Kiro Buddy slash agents into ${agentDir}`)
if (trustedPrefix) {
  console.log(`Trusted Kiro Buddy hook command prefix in ${vscodeSettingsPath}`)
}
for (const filePath of written) {
  console.log(`- ${path.basename(filePath)}`)
}
for (const filePath of writtenAgents) {
  console.log(`- ${path.basename(filePath)}`)
}
