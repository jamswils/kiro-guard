import fs from 'fs'
import path from 'path'
import os from 'os'
import chokidar, { FSWatcher } from 'chokidar'
import type { StatusPayload } from '../shared/types'
import { statusManager } from './statusManager'

const DISABLE_ENV = 'KIRO_BUDDY_DISABLE_INPUT_MONITOR'
const INPUT_REQUIRED_PATTERN = /Showed native inputRequired notification for execution ([\w-]+)/i
const INPUT_REQUIRED_GLOBAL_PATTERN =
  /Showed native inputRequired notification for execution\s+([\w-]+)/gi
const PENDING_QUESTION_GLOBAL_PATTERN =
  /\[Execution\] adding pending user question\s+\{"id":"([^"]+)"/gi
const ANSWERED_QUESTION_GLOBAL_PATTERN =
  /\[Execution\] adding response to question\s+([^\s]+)/gi
const CANCELLED_QUESTION_GLOBAL_PATTERN =
  /\[Execution\].*(?:cancel(?:ed|led)|dismiss(?:ed)?|reject(?:ed)?|abort(?:ed)?).*(?:pending )?(?:user )?question\s+([^\s"]+)?/gi
const INPUT_CANCELLED_GLOBAL_PATTERN =
  /(?:inputRequired|user input|native input).*(?:cancel(?:ed|led)|dismiss(?:ed)?|closed|reject(?:ed)?|abort(?:ed)?)/gi
const INPUT_RESOLVED_GLOBAL_PATTERN =
  /(?:\[Terminal\] Executing command|\[Terminal\] execute terminal command done|\[Terminal\] Command execution completed)/gi
const SPEC_FILE_GLOBAL_PATTERN =
  /\[WriteFile\] complete write file: .*\/(?:requirements|design|tasks)\.md/gi
const MIN_ASKING_INTERVAL_MS = 1200
const POLL_MS = 1000
const TAIL_BYTES = 64 * 1024
const MAX_SEEN_EXECUTIONS = 80

let watcher: FSWatcher | null = null
let pollTimer: NodeJS.Timeout | null = null
let activeLogPath: string | null = null
let activeOffset = 0
let lastExecutionId: string | null = null
let lastAskingAt = 0
let inputPending = false
let pendingInputKind: 'command' | 'question' | null = null
const seenInputEventKeys: string[] = []
const seenResolvedEventKeys: string[] = []

function kiroLogRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kiro', 'logs')
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'logs')
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Kiro', 'logs')
}

function findNewestKiroLog(root: string = kiroLogRoot()): string | null {
  const candidates: Array<{ filePath: string; mtimeMs: number }> = []

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(filePath)
        continue
      }

      if (entry.isFile() && entry.name === 'Kiro Logs.log') {
        try {
          candidates.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs })
        } catch {
          // Ignore files that disappear while scanning.
        }
      }
    }
  }

  walk(root)
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.filePath ?? null
}

function readNewText(filePath: string): string {
  const stats = fs.statSync(filePath)
  if (filePath !== activeLogPath || stats.size < activeOffset) {
    activeLogPath = filePath
    activeOffset = stats.size
    return ''
  }

  if (stats.size === activeOffset) {
    return ''
  }

  const fd = fs.openSync(filePath, 'r')
  try {
    const length = stats.size - activeOffset
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, activeOffset)
    activeOffset = stats.size
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export function detectInputRequired(text: string): string | null {
  const match = INPUT_REQUIRED_PATTERN.exec(text) ?? INPUT_REQUIRED_GLOBAL_PATTERN.exec(text)
  INPUT_REQUIRED_GLOBAL_PATTERN.lastIndex = 0
  return match?.[1] ?? null
}

function detectInputRequiredExecutions(text: string): string[] {
  const executionIds: string[] = []
  let match: RegExpExecArray | null
  INPUT_REQUIRED_GLOBAL_PATTERN.lastIndex = 0
  while ((match = INPUT_REQUIRED_GLOBAL_PATTERN.exec(text)) !== null) {
    executionIds.push(match[1])
  }
  INPUT_REQUIRED_GLOBAL_PATTERN.lastIndex = 0
  return executionIds
}

type InputMonitorEvent =
  | { type: 'required'; key: string; executionId: string; index: number }
  | { type: 'question'; key: string; questionId: string; index: number }
  | { type: 'phase'; key: string; phase: 'requirements' | 'design' | 'tasks'; index: number }
  | {
      type: 'resolved'
      key: string
      kind: 'command' | 'question'
      outcome: 'answered' | 'cancelled' | 'completed'
      index: number
    }

export function payloadAfterInputResolved(
  currentStatus: StatusPayload | null | undefined,
  outcome: 'answered' | 'cancelled' | 'completed',
  timestamp: number = Date.now(),
): StatusPayload | null {
  if (currentStatus?.status !== 'asking' && currentStatus?.status !== 'waiting') {
    return null
  }

  if (outcome === 'cancelled') {
    return {
      status: 'idle',
      message: 'Kiro is ready',
      timestamp,
    }
  }

  const payload: StatusPayload = {
    status: 'working',
    message: 'Kiro is working',
    timestamp,
  }
  if (currentStatus.phase) {
    payload.phase = currentStatus.phase
  }
  return payload
}

export function detectInputMonitorEvents(text: string): InputMonitorEvent[] {
  const events: InputMonitorEvent[] = []
  let inputMatch: RegExpExecArray | null
  let questionMatch: RegExpExecArray | null
  let answerMatch: RegExpExecArray | null
  let cancelledQuestionMatch: RegExpExecArray | null
  let inputCancelledMatch: RegExpExecArray | null
  let resolvedMatch: RegExpExecArray | null
  let specFileMatch: RegExpExecArray | null

  INPUT_REQUIRED_GLOBAL_PATTERN.lastIndex = 0
  while ((inputMatch = INPUT_REQUIRED_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'required',
      key: `input:${inputMatch[1]}:${inputMatch.index}`,
      executionId: inputMatch[1],
      index: inputMatch.index,
    })
  }
  INPUT_REQUIRED_GLOBAL_PATTERN.lastIndex = 0

  PENDING_QUESTION_GLOBAL_PATTERN.lastIndex = 0
  while ((questionMatch = PENDING_QUESTION_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'question',
      key: `question:${questionMatch[1]}`,
      questionId: questionMatch[1],
      index: questionMatch.index,
    })
  }
  PENDING_QUESTION_GLOBAL_PATTERN.lastIndex = 0

  ANSWERED_QUESTION_GLOBAL_PATTERN.lastIndex = 0
  while ((answerMatch = ANSWERED_QUESTION_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'resolved',
      key: `answer:${answerMatch[1]}`,
      kind: 'question',
      outcome: 'answered',
      index: answerMatch.index,
    })
  }
  ANSWERED_QUESTION_GLOBAL_PATTERN.lastIndex = 0

  CANCELLED_QUESTION_GLOBAL_PATTERN.lastIndex = 0
  while ((cancelledQuestionMatch = CANCELLED_QUESTION_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'resolved',
      key: `question-cancel:${cancelledQuestionMatch[1] ?? cancelledQuestionMatch.index}`,
      kind: 'question',
      outcome: 'cancelled',
      index: cancelledQuestionMatch.index,
    })
  }
  CANCELLED_QUESTION_GLOBAL_PATTERN.lastIndex = 0

  INPUT_CANCELLED_GLOBAL_PATTERN.lastIndex = 0
  while ((inputCancelledMatch = INPUT_CANCELLED_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'resolved',
      key: `input-cancel:${inputCancelledMatch.index}`,
      kind: 'command',
      outcome: 'cancelled',
      index: inputCancelledMatch.index,
    })
  }
  INPUT_CANCELLED_GLOBAL_PATTERN.lastIndex = 0

  INPUT_RESOLVED_GLOBAL_PATTERN.lastIndex = 0
  while ((resolvedMatch = INPUT_RESOLVED_GLOBAL_PATTERN.exec(text)) !== null) {
    events.push({
      type: 'resolved',
      key: `terminal:${resolvedMatch.index}`,
      kind: 'command',
      outcome: 'completed',
      index: resolvedMatch.index,
    })
  }
  INPUT_RESOLVED_GLOBAL_PATTERN.lastIndex = 0

  SPEC_FILE_GLOBAL_PATTERN.lastIndex = 0
  while ((specFileMatch = SPEC_FILE_GLOBAL_PATTERN.exec(text)) !== null) {
    const fileName = specFileMatch[0].match(/(?:requirements|design|tasks)\.md/i)?.[0].toLowerCase()
    const phase =
      fileName === 'tasks.md' ? 'tasks' : fileName === 'design.md' ? 'design' : 'requirements'
    events.push({
      type: 'phase',
      key: `phase:${phase}:${specFileMatch.index}`,
      phase,
      index: specFileMatch.index,
    })
  }
  SPEC_FILE_GLOBAL_PATTERN.lastIndex = 0

  events.sort((left, right) => left.index - right.index)
  return events
}

function rememberInputEvent(key: string): void {
  if (seenInputEventKeys.includes(key)) {
    return
  }

  seenInputEventKeys.push(key)
  while (seenInputEventKeys.length > MAX_SEEN_EXECUTIONS) {
    seenInputEventKeys.shift()
  }
}

function hasSeenInputEvent(key: string): boolean {
  return seenInputEventKeys.includes(key)
}

function rememberResolvedEvent(key: string): void {
  if (seenResolvedEventKeys.includes(key)) {
    return
  }

  seenResolvedEventKeys.push(key)
  while (seenResolvedEventKeys.length > MAX_SEEN_EXECUTIONS) {
    seenResolvedEventKeys.shift()
  }
}

function hasSeenResolvedEvent(key: string): boolean {
  return seenResolvedEventKeys.includes(key)
}

function readTail(filePath: string): string {
  const stats = fs.statSync(filePath)
  const start = Math.max(0, stats.size - TAIL_BYTES)
  const length = stats.size - start
  if (length <= 0) {
    return ''
  }

  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function publishAsking(inputId: string, kind: 'command' | 'question'): void {
  const now = Date.now()
  if (lastExecutionId === inputId && now - lastAskingAt < MIN_ASKING_INTERVAL_MS) {
    return
  }

  if (kind === 'command' && pendingInputKind === 'question') {
    return
  }

  lastExecutionId = inputId
  lastAskingAt = now
  inputPending = true
  pendingInputKind = kind

  const currentStatus = statusManager.getCurrentStatus()
  const payload: StatusPayload = {
    status: 'asking',
    message: 'Kiro is waiting for your input',
    timestamp: now,
  }
  if (currentStatus?.phase) {
    payload.phase = currentStatus.phase
  }
  statusManager.writeStatus(payload)
}

function publishAfterInputResolved(
  kind: 'command' | 'question',
  outcome: 'answered' | 'cancelled' | 'completed',
): void {
  if (!inputPending || pendingInputKind !== kind) {
    return
  }

  const currentStatus = statusManager.getCurrentStatus()
  inputPending = false
  pendingInputKind = null
  const payload = payloadAfterInputResolved(currentStatus, outcome)
  if (!payload) {
    return
  }
  statusManager.writeStatus(payload)
}

function publishPhaseWorking(phase: 'requirements' | 'design' | 'tasks'): void {
  if (inputPending) {
    return
  }

  const now = Date.now()
  const phaseTitle =
    phase === 'tasks' ? 'Task List' : phase.slice(0, 1).toUpperCase() + phase.slice(1)
  const payload: StatusPayload = {
    status: 'working',
    message: `${phaseTitle} in progress`,
    phase,
    timestamp: now,
  }
  statusManager.writeStatus(payload)
}

function processLogEvents(text: string, markExistingOnly: boolean): void {
  for (const event of detectInputMonitorEvents(text)) {
    if (event.type === 'required' || event.type === 'question') {
      if (hasSeenInputEvent(event.key)) {
        continue
      }

      rememberInputEvent(event.key)
      if (!markExistingOnly) {
        publishAsking(
          event.type === 'required' ? event.executionId : event.questionId,
          event.type === 'required' ? 'command' : 'question',
        )
      }
      continue
    }

    if (event.type === 'phase') {
      if (hasSeenInputEvent(event.key)) {
        continue
      }

      rememberInputEvent(event.key)
      if (!markExistingOnly) {
        publishPhaseWorking(event.phase)
      }
      continue
    }

    if (hasSeenResolvedEvent(event.key)) {
      continue
    }

    rememberResolvedEvent(event.key)
    if (!markExistingOnly) {
      publishAfterInputResolved(event.kind, event.outcome)
    }
  }
}

function processLogText(text: string): void {
  processLogEvents(text, false)
}

function scanNewestLog(markExistingOnly: boolean): void {
  const newestLog = findNewestKiroLog()
  if (!newestLog) {
    return
  }

  let text = ''
  try {
    text = readTail(newestLog)
  } catch {
    return
  }

  processLogEvents(text, markExistingOnly)
}

export function startKiroInputMonitor(): void {
  if (process.env[DISABLE_ENV] === '1' || watcher !== null) {
    return
  }

  const root = kiroLogRoot()
  const newestLog = findNewestKiroLog(root)
  if (newestLog) {
    try {
      activeLogPath = newestLog
      activeOffset = fs.statSync(newestLog).size
      scanNewestLog(true)
    } catch {
      activeLogPath = null
      activeOffset = 0
    }
  }

  watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: {
      stabilityThreshold: 60,
      pollInterval: 20,
    },
  })

  const handleChange = (filePath: string): void => {
    if (path.basename(filePath) !== 'Kiro Logs.log') {
      return
    }

    try {
      processLogText(readNewText(filePath))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[KiroInputMonitor] Failed to process Kiro log: ${message}`)
    }
  }

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('error', (error) => {
    console.warn(`[KiroInputMonitor] Watcher error: ${error.message}`)
  })

  pollTimer = setInterval(() => scanNewestLog(false), POLL_MS)
  pollTimer.unref?.()
}

export function stopKiroInputMonitor(): void {
  if (watcher !== null) {
    watcher.close()
    watcher = null
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  activeLogPath = null
  activeOffset = 0
  lastExecutionId = null
  lastAskingAt = 0
  inputPending = false
  pendingInputKind = null
  seenInputEventKeys.length = 0
  seenResolvedEventKeys.length = 0
}
