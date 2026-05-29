const fs = require('fs')
const os = require('os')
const path = require('path')

const workspaceRoot = path.resolve(process.env.KIRO_BUDDY_WORKSPACE || process.cwd())
const workspaceAgentDir = path.join(workspaceRoot, '.kiro', 'agents')
const globalAgentDir = path.join(os.homedir(), '.kiro', 'agents')
const cliPath = path.join(path.resolve(__dirname, '..'), 'bin', 'kiro-buddy.cjs')
const statusHookPath = path.join(path.resolve(__dirname), 'kiro-status-hook.cjs')
const isWindows = process.platform === 'win32'

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

function statusCommand(status, options = {}) {
  const args = [
    ...(isWindows ? ['&'] : []),
    quoteCommandArg(process.execPath),
    quoteCommandArg(statusHookPath),
    status,
    '--read-stdin',
  ]

  if (options.requirePhase) {
    args.push('--require-phase')
  }

  return args.join(' ')
}

function cliCommand(action) {
  return [
    ...(isWindows ? ['&'] : []),
    quoteCommandArg(process.execPath),
    quoteCommandArg(cliPath),
    'cli',
    action,
  ].join(' ')
}

const config = {
  name: 'kiro-buddy-cli',
  description: 'Kiro CLI agent profile that drives Kiro Buddy status, panel context, and visual QA from terminal sessions.',
  prompt:
    'Use Kiro Buddy hooks to surface terminal-agent activity. Keep status updates concise and continue normal development work.',
  tools: ['*'],
  hooks: {
    agentSpawn: [
      {
        command: cliCommand('open'),
        timeout_ms: 30000,
      },
    ],
    userPromptSubmit: [
      {
        command: statusCommand('working'),
        timeout_ms: 30000,
      },
    ],
    preToolUse: [
      {
        matcher: '*',
        command: statusCommand('asking'),
        timeout_ms: 30000,
      },
    ],
    postToolUse: [
      {
        matcher: '*',
        command: statusCommand('working'),
        timeout_ms: 30000,
      },
    ],
    stop: [
      {
        command: statusCommand('done'),
        timeout_ms: 30000,
      },
    ],
  },
  welcomeMessage:
    'Kiro Buddy CLI hooks are active. Use `kiro-buddy cli open`, `kiro-buddy cli close`, or `kiro-buddy cli test` from your terminal.',
}

function writeAgentConfig(agentDir) {
  const agentPath = path.join(agentDir, 'kiro-buddy-cli.json')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(agentPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return agentPath
}

const written = [writeAgentConfig(globalAgentDir)]
if (path.resolve(workspaceAgentDir) !== path.resolve(globalAgentDir)) {
  written.push(writeAgentConfig(workspaceAgentDir))
}

console.log('Installed Kiro CLI Buddy agent config:')
for (const agentPath of written) {
  console.log(`- ${agentPath}`)
}
console.log('Use it with: kiro-cli chat --agent kiro-buddy-cli')
