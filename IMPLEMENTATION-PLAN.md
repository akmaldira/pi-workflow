# Implementation Plan: 5-Feature Roadmap

## Overview

Prioritized implementation of 5 critical features from gap analysis:
1. **Journaling & Resume** (enable workflow caching + edited-script resume)
2. **Git Worktree Isolation** (safe parallel writes)
3. **Budget & Safety Controls** (tracking + limits, no hard enforcement)
4. **Real-Time Display** (TUI monitoring)
5. **Error Resilience** (graceful partial failures)

**Timeline:** Phases, incremental commits, all vitest tests maintained ≥302 passing.

---

## Feature 1: Journaling & Resume

### Scope
- JSONL-based run journal stored in `~/.pi/sessions/<sessionId>/workflows/<runId>.jsonl`
- Per-agent result caching by (prompt, options) hash
- Resume capability: skip cached agents, re-run only new/changed ones
- Edited-script resume: script hash validation

### Files to Create

#### `extensions/journal-types.ts` (new)
```typescript
export interface JournalRunMeta {
  type: "run"
  runId: string
  scriptHash: string  // djb2-xor hash of script content
  name: string
  startedAt: number
}

export interface JournalAgentRecord {
  type: "agent"
  seq: number
  key: string  // hash of (prompt + options)
  label: string
  result: unknown
  error?: string
  outputTokens?: number
  inputTokens?: number
  durationMs: number
  startedAt: number
}

export interface JournalResultRecord {
  type: "result"
  ok: boolean
  result?: unknown
  error?: string
  agentCount: number
  totalTokens: number
  durationMs: number
}

export type JournalRecord = JournalRunMeta | JournalAgentRecord | JournalResultRecord
```

#### `extensions/journal.ts` (new, ~400 lines)
```typescript
import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export function hashString(input: string): string {
  // djb2-xor stable hash
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i)
  return (h >>> 0).toString(16).padStart(8, "0")
}

export function agentCallKey(prompt: string, opts: unknown): string {
  return hashString(JSON.stringify({ prompt, opts }))
}

export class RunJournal {
  readonly filePath: string
  readonly runId: string
  private seq = 0
  private priorResults = new Map<string, { result: unknown; tokens: number }>()
  private totalTokens = 0
  private agentCount = 0

  private constructor(filePath: string, runId: string) {
    this.filePath = filePath
    this.runId = runId
  }

  static create(sessionDir: string, scriptHash: string, name: string): RunJournal {
    const runId = randomUUID()
    const workflowDir = path.join(sessionDir, "workflows")
    fs.mkdirSync(workflowDir, { recursive: true })
    
    const filePath = path.join(workflowDir, `${runId}.jsonl`)
    fs.writeFileSync(filePath, "")  // truncate
    
    const journal = new RunJournal(filePath, runId)
    journal.append({
      type: "run",
      runId,
      scriptHash,
      name,
      startedAt: Date.now(),
    })
    return journal
  }

  static resume(sessionDir: string, runId: string, scriptHash: string, name: string): { journal: RunJournal; isCacheValid: boolean } {
    const workflowDir = path.join(sessionDir, "workflows")
    const filePath = path.join(workflowDir, `${runId}.jsonl`)
    
    if (!fs.existsSync(filePath)) {
      return { journal: RunJournal.create(sessionDir, scriptHash, name), isCacheValid: false }
    }

    // Load prior run, check script hash match
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)
    const firstRecord = lines[0] ? JSON.parse(lines[0]) : null
    
    const isCacheValid = firstRecord?.scriptHash === scriptHash
    if (!isCacheValid) {
      // Script changed, start fresh
      fs.writeFileSync(filePath, "")
      const journal = new RunJournal(filePath, runId)
      journal.append({
        type: "run",
        runId,
        scriptHash,
        name,
        startedAt: Date.now(),
      })
      return { journal, isCacheValid: false }
    }

    // Load prior results into cache
    const journal = new RunJournal(filePath, runId)
    for (let i = 1; i < lines.length; i++) {
      const record = JSON.parse(lines[i]) as JournalRecord
      if (record.type === "agent") {
        journal.priorResults.set(record.key, {
          result: record.result,
          tokens: record.outputTokens || 0,
        })
        journal.seq = Math.max(journal.seq, record.seq + 1)
        journal.totalTokens += record.outputTokens || 0
        journal.agentCount++
      }
    }
    return { journal, isCacheValid: true }
  }

  private append(record: JournalRecord) {
    const line = JSON.stringify(record)
    fs.appendFileSync(this.filePath, line + "\n")
  }

  recordAgent(key: string, label: string, result: unknown, tokens: number, duration: number) {
    this.seq++
    this.agentCount++
    this.totalTokens += tokens
    
    this.append({
      type: "agent",
      seq: this.seq,
      key,
      label,
      result,
      outputTokens: tokens,
      durationMs: duration,
      startedAt: Date.now() - duration,
    })
  }

  recordError(key: string, label: string, error: string, duration: number) {
    this.seq++
    
    this.append({
      type: "agent",
      seq: this.seq,
      key,
      label,
      error,
      durationMs: duration,
      startedAt: Date.now() - duration,
    })
  }

  recordResult(ok: boolean, result: unknown, error?: string, durationMs?: number) {
    this.append({
      type: "result",
      ok,
      result,
      error,
      agentCount: this.agentCount,
      totalTokens: this.totalTokens,
      durationMs: durationMs || 0,
    })
  }

  getCachedResult(key: string): { result: unknown; tokens: number } | null {
    return this.priorResults.get(key) || null
  }

  getStats() {
    return {
      runId: this.runId,
      seq: this.seq,
      agentCount: this.agentCount,
      totalTokens: this.totalTokens,
    }
  }
}
```

### Integration Points

#### `extensions/workflow.ts` — agent() function
```typescript
// Add to RuntimeState
interface RuntimeState {
  journal?: RunJournal
  scriptHash: string
  // ...
}

// In agent() function
const agent = async (prompt: unknown, agentOptions: unknown = {}): Promise<string> => {
  // Check cache first
  const cacheKey = agentCallKey(requireString(prompt, "prompt"), agentOptions)
  if (opts.journal) {
    const cached = opts.journal.getCachedResult(cacheKey)
    if (cached) {
      log(`[cached] ${label}`)
      return String(cached.result)
    }
  }

  // Run agent (existing code)
  const startTime = Date.now()
  const result = await run(...)
  const duration = Date.now() - startTime

  // Journal the result
  if (opts.journal) {
    try {
      const agentResult = JSON.parse(result)
      const tokens = agentResult.usage?.output_tokens || 0
      opts.journal.recordAgent(cacheKey, label, agentResult, tokens, duration)
    } catch {
      opts.journal.recordAgent(cacheKey, label, result, 0, duration)
    }
  }

  return result
}
```

#### `extensions/workflow-tool.ts` — createWorkflowAgentRunner()
```typescript
// Pass journal to runWorkflow
const journal = options.journal || 
  (options.resumeRunId 
    ? RunJournal.resume(sessionDir, options.resumeRunId, scriptHash, meta.name)
    : RunJournal.create(sessionDir, scriptHash, meta.name))

const result = await runWorkflow(script, {
  agentRunner,
  abort: signal,
  journal,  // ← add
  scriptHash,
})

journal.recordResult(true, result)
```

#### `extensions/index.ts` — tool definition
```typescript
export interface WorkflowToolOptions {
  journal?: RunJournal
  resumeRunId?: string  // ← resume mode
  tokenBudget?: number
  // ...
}
```

### Tests
- `tests/journal.test.ts` (create, resume, cache hit, script hash mismatch, JSONL format)

---

## Feature 2: Git Worktree Isolation

### Scope
- Support `isolation: 'worktree'` in agent() options
- Create throwaway git worktree per agent (tmpdir + detached branch)
- Capture diff after agent completion
- Clean up worktrees on exit

### Files to Create

#### `extensions/worktree.ts` (new, ~350 lines)
```typescript
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface Worktree {
  path: string
  agentCwd: string  // worktree root + relative cwd
  branch: string
  baseCommit: string
}

export interface WorktreeDiff {
  filesChanged: number
  insertions: number
  deletions: number
  patch: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

export function isGitRepo(cwd: string): boolean {
  return tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true"
}

export function createWorktree(cwd: string, runId: string, index: number): Worktree {
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"])
  if (!toplevel) throw new Error("isolation: 'worktree' requires git repository")

  const baseCommit = tryGit(cwd, ["rev-parse", "HEAD"])
  if (!baseCommit) throw new Error("isolation: 'worktree' requires at least one commit")

  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run"
  const branch = `ultracode/${safeRun}-${index}`
  const worktreePath = path.join(os.tmpdir(), `ultracode-wt-${safeRun}-${index}`)

  // Clean stale worktree if exists
  removeWorktreeQuiet(toplevel, worktreePath, branch)

  git(toplevel, ["worktree", "add", "--detach", worktreePath, baseCommit])
  tryGit(worktreePath, ["checkout", "-B", branch])

  const relativeCwd = path.relative(toplevel, path.resolve(cwd))
  const agentCwd = relativeCwd && !relativeCwd.startsWith("..") 
    ? path.join(worktreePath, relativeCwd) 
    : worktreePath

  return { path: worktreePath, agentCwd, branch, baseCommit }
}

export function captureWorktreeDiff(worktree: Worktree): WorktreeDiff {
  tryGit(worktree.path, ["add", "-A"])
  
  const diffStat = tryGit(worktree.path, ["diff", "--cached", "--stat", worktree.baseCommit]) || ""
  const patch = tryGit(worktree.path, ["diff", "--cached", worktree.baseCommit]) || ""

  const lines = diffStat.split("\n")
  let filesChanged = 0, insertions = 0, deletions = 0
  for (const line of lines) {
    const match = line.match(/^.+?\s+(\d+)\s+\+*(\d*)\s*\-*(\d*)/)
    if (match) {
      filesChanged++
      insertions += parseInt(match[2] || "0", 10)
      deletions += parseInt(match[3] || "0", 10)
    }
  }

  return { filesChanged, insertions, deletions, patch }
}

export function removeWorktree(toplevel: string, worktreePath: string, branch: string) {
  tryGit(toplevel, ["worktree", "remove", "--force", worktreePath])
  tryGit(toplevel, ["branch", "-D", branch])
  fs.rmSync(worktreePath, { recursive: true, force: true })
}

function removeWorktreeQuiet(toplevel: string, worktreePath: string, branch: string) {
  try {
    removeWorktree(toplevel, worktreePath, branch)
  } catch {
    // ignore
  }
}

export function cleanupWorktrees(cwd: string, runId: string) {
  if (!isGitRepo(cwd)) return
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"])
  if (!toplevel) return

  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "run"
  const wtDirGlob = path.join(os.tmpdir(), `ultracode-wt-${safeRun}-*`)
  
  // Simple cleanup: remove any matching tmpdir worktrees
  try {
    const tmpdir = os.tmpdir()
    const entries = fs.readdirSync(tmpdir)
    for (const entry of entries) {
      if (entry.startsWith(`ultracode-wt-${safeRun}-`)) {
        fs.rmSync(path.join(tmpdir, entry), { recursive: true, force: true })
      }
    }
  } catch {
    // ignore
  }
}
```

### Integration Points

#### `extensions/execution.ts` — buildPiArgs()
```typescript
// Add worktree support
interface BuildPiArgsInput {
  worktree?: Worktree
  // ...
}

export function buildPiArgs(...): string[] {
  // If worktree provided, use worktree.agentCwd instead of cwd
  const effectiveCwd = input.worktree?.agentCwd || input.cwd
  // ... rest of args building
}
```

#### `extensions/workflow.ts` — agent() function
```typescript
const agent = async (prompt: unknown, agentOptions: unknown = {}): Promise<string> => {
  const opts = normalizeAgentOptions(agentOptions)
  const label = opts.label || defaultAgentLabel(state.phase, state.seq)

  let worktree: Worktree | undefined
  if (opts.isolation === "worktree") {
    worktree = createWorktree(state.cwd, state.runId, state.seq)
  }

  try {
    // Run agent with worktree if present
    const result = await run({
      ...state,
      worktree,
      // ...
    })

    // Capture diff if worktree was used
    if (worktree) {
      const diff = captureWorktreeDiff(worktree)
      // Can store diff in journal or add to result metadata
      log(`${label}: ${diff.filesChanged} files, +${diff.insertions} -${diff.deletions}`)
    }

    return result
  } finally {
    if (worktree) {
      removeWorktree(state.toplevel, worktree.path, worktree.branch)
    }
  }
}
```

#### `extensions/workflow-tool.ts` — cleanup on exit
```typescript
try {
  result = await runWorkflow(...)
} finally {
  cleanupWorktrees(options.cwd ?? ctx.cwd, runId)
}
```

### Tests
- `tests/worktree.test.ts` (create, isGitRepo, capture diff, cleanup)

---

## Feature 3: Budget & Safety Controls

### Scope
- Track token consumption (input + output + cache read/write)
- Enforce limits: max agents, max concurrency, script timeout
- Warn at budget thresholds (80%, 100%)
- No hard enforcement on tokens (just tracking)

### Files to Modify

#### `extensions/workflow.ts` — add tracking
```typescript
interface RuntimeState {
  tokenBudget?: number
  maxAgents?: number
  totalTokensUsed: number
  agentCount: number
  startTime: number
  scriptTimeoutMs?: number
}

// In agent() function
const agent = async (prompt: unknown, agentOptions: unknown = {}): Promise<string> => {
  // Check limits before running
  if (state.maxAgents && state.agentCount >= state.maxAgents) {
    throw new Error(`Exceeded max agents (${state.maxAgents})`)
  }

  if (state.scriptTimeoutMs && Date.now() - state.startTime > state.scriptTimeoutMs) {
    throwIfAborted()  // trigger abort via signal
    throw new Error(`Script timeout (${state.scriptTimeoutMs}ms)`)
  }

  // Run agent (existing code)
  const result = await run(...)

  // Extract tokens from result
  const tokens = extractTokenCount(result)
  state.totalTokensUsed += tokens
  state.agentCount++

  // Warn at thresholds
  if (state.tokenBudget) {
    const used = state.totalTokensUsed
    const budget = state.tokenBudget
    if (used >= budget) {
      log(`⚠ Token budget exceeded (${used} / ${budget})`)
    } else if (used >= budget * 0.8) {
      log(`⚠ Token budget 80% (${used} / ${budget})`)
    }
  }

  return result
}
```

#### `extensions/workflow-tool.ts` — pass options
```typescript
export interface WorkflowToolOptions {
  tokenBudget?: number
  maxAgents?: number
  maxConcurrent?: number  // already have this
  scriptTimeoutMs?: number
  // ...
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition {
  return {
    execute: async (input, ctx) => {
      const result = await runWorkflow(script, {
        agentRunner,
        tokenBudget: options.tokenBudget,
        maxAgents: options.maxAgents,
        maxConcurrent: options.maxConcurrent ?? 4,
        scriptTimeoutMs: options.scriptTimeoutMs,
        // ...
      })
      return result
    },
  }
}
```

### Tests
- `tests/budget.test.ts` (token tracking, max agents limit, timeout, threshold warnings)

---

## Feature 4: Real-Time Display & TUI Monitoring

### Scope
- Workflow snapshot (meta + phases + per-agent status)
- Live rendering (phases, agent count, status indicators)
- Per-agent metrics (label, status, tokens, model, turns)
- TUI widget integration (if available)

### Files to Create

#### `extensions/workflow-snapshot.ts` (new, ~200 lines)
```typescript
import type { WorkflowMeta, WorkflowMetaPhase } from "./workflow.ts"

export interface WorkflowAgentSnapshot {
  seq: number
  label: string
  status: "idle" | "running" | "completed" | "error"
  result?: unknown
  error?: string
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  model?: string
  turns?: number
  toolUses?: number
}

export interface WorkflowPhaseSnapshot {
  title?: string
  index: number
  status: "pending" | "active" | "completed"
  agents: WorkflowAgentSnapshot[]
}

export interface WorkflowSnapshot {
  meta: WorkflowMeta
  status: "running" | "completed" | "error" | "cancelled"
  phases: WorkflowPhaseSnapshot[]
  totalAgents: number
  totalTokens: number
  durationMs: number
  result?: unknown
  error?: string
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    meta,
    status: "running",
    phases: (meta.phases || []).map((phase, i) => ({
      title: phase.title,
      index: i,
      status: "pending",
      agents: [],
    })),
    totalAgents: 0,
    totalTokens: 0,
    durationMs: 0,
  }
}

export function recordAgentInSnapshot(snapshot: WorkflowSnapshot, phase: number, agent: WorkflowAgentSnapshot) {
  if (snapshot.phases[phase]) {
    snapshot.phases[phase].agents.push(agent)
    snapshot.totalAgents++
    if (agent.outputTokens) {
      snapshot.totalTokens += agent.outputTokens
    }
  }
}

export function updatePhaseStatus(snapshot: WorkflowSnapshot, phase: number, status: "pending" | "active" | "completed") {
  if (snapshot.phases[phase]) {
    snapshot.phases[phase].status = status
  }
}
```

#### `extensions/workflow-display.ts` (new, ~250 lines)
```typescript
import type { WorkflowSnapshot } from "./workflow-snapshot.ts"

export interface WorkflowDisplayOptions {
  maxWidth?: number
  showTokens?: boolean
  showModel?: boolean
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const lines: string[] = []
  const { maxWidth = 120, showTokens = true, showModel = true } = options

  // Header
  const status = snapshot.status === "running" ? "▶" : snapshot.status === "completed" ? "✓" : "✗"
  const title = `${status} ${snapshot.meta.name || "workflow"}`
  const meta = `(${snapshot.totalAgents} agents, ${showTokens ? snapshot.totalTokens + "t" : ""})`
  lines.push(`◆ ${title} ${meta}`)

  // Phases
  for (const phase of snapshot.phases) {
    const phaseStatus = phase.status === "pending" ? "●" : phase.status === "active" ? "▶" : "✓"
    const phaseTitle = phase.title ? `${phase.title}` : `Phase ${phase.index + 1}`
    lines.push(`  ${phaseStatus} ${phaseTitle} (${phase.agents.length} agents)`)

    // Agents in phase
    for (const agent of phase.agents.slice(-3)) {  // show last 3
      const agentStatus = agent.status === "running" ? "●" : agent.status === "completed" ? "✓" : "✗"
      const tokens = showTokens && agent.outputTokens ? ` · ${agent.outputTokens}t` : ""
      const model = showModel && agent.model ? ` · ${agent.model}` : ""
      const duration = agent.durationMs ? ` · ${(agent.durationMs / 1000).toFixed(1)}s` : ""
      lines.push(`    ${agentStatus} ${agent.label}${tokens}${model}${duration}`)
    }
  }

  return lines
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string {
  return renderWorkflowLines(snapshot, options).join("\n")
}

export function preview(value: unknown, max = 80): string {
  const str = typeof value === "string" ? value : JSON.stringify(value)
  return str.length > max ? str.slice(0, max) + "..." : str
}
```

### Integration Points

#### `extensions/workflow.ts` — emit snapshots
```typescript
import { createWorkflowSnapshot, recordAgentInSnapshot, updatePhaseStatus } from "./workflow-snapshot.ts"
import { renderWorkflowLines } from "./workflow-display.ts"

interface RuntimeState {
  snapshot: WorkflowSnapshot
  onSnapshotUpdate?: (snapshot: WorkflowSnapshot) => void
  // ...
}

const phase = (title: unknown) => {
  const idx = state.currentPhase
  updatePhaseStatus(state.snapshot, idx, "active")
  state.onSnapshotUpdate?.(state.snapshot)
}

const agent = async (prompt, agentOptions = {}) => {
  // ... run agent
  recordAgentInSnapshot(state.snapshot, state.currentPhase, {
    seq: state.seq,
    label,
    status: "completed",
    result: preview(result),
    outputTokens,
    durationMs,
  })
  state.onSnapshotUpdate?.(state.snapshot)
}
```

#### `extensions/workflow-tool.ts` — create snapshot update handler
```typescript
const snapshot = createWorkflowSnapshot(meta)

// Simple log-based display (can integrate with TUI widget later)
const onSnapshotUpdate = (snap: WorkflowSnapshot) => {
  const lines = renderWorkflowLines(snap, { showTokens: true, showModel: false })
  console.log(lines.join("\n"))
}

const result = await runWorkflow(script, {
  // ...
  onSnapshotUpdate,
})
```

### Tests
- `tests/workflow-display.test.ts` (snapshot creation, rendering, token accumulation)

---

## Feature 5: Error Resilience & Graceful Degradation

### Scope
- Partial failure handling (one agent fails, workflow continues)
- Structured error capture (error + partial output)
- Retry logic in pipeline (optional, per-stage)
- Better error messages with context

### Files to Modify

#### `extensions/workflow.ts` — error handling
```typescript
export interface AgentRunResult {
  ok: boolean
  result?: unknown
  error?: string
  partial?: unknown
  durationMs: number
}

const agent = async (prompt: unknown, agentOptions: unknown = {}): Promise<string> => {
  const label = defaultAgentLabel(state.phase, state.seq)
  const startTime = Date.now()

  try {
    // Run agent (existing code)
    const result = await run(...)
    return result
  } catch (err) {
    const duration = Date.now() - startTime
    const errorMsg = err instanceof Error ? err.message : String(err)
    
    // Log error with context
    log(`✗ ${label}: ${errorMsg}`)

    // Journal the error
    if (state.journal) {
      state.journal.recordError(cacheKey, label, errorMsg, duration)
    }

    // Rethrow or return partial (depends on context)
    throw new Error(`Agent "${label}" failed: ${errorMsg}`)
  }
}

// parallel() collects errors, doesn't throw
const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
  const results = await Promise.allSettled(thunks.map(t => t()))
  
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value
    
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason)
    log(`✗ parallel[${i}] failed: ${error}`)
    return { error, partial: null, ok: false }
  })
}

// pipeline() retry + continue logic
const pipeline = async (
  items: unknown[],
  transform: (item: unknown, prev?: unknown) => Promise<unknown>,
  combine?: (partial: unknown, prev: unknown) => unknown,
): Promise<unknown[]> => {
  const results: unknown[] = []
  let prev: unknown

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    let retries = 0
    const maxRetries = 2  // configurable

    while (retries <= maxRetries) {
      try {
        const result = await transform(item, prev)
        if (combine) {
          prev = combine(result, prev)
        } else {
          prev = result
        }
        results.push(result)
        break
      } catch (err) {
        retries++
        if (retries > maxRetries) {
          const error = err instanceof Error ? err.message : String(err)
          log(`✗ pipeline[${i}] failed after ${maxRetries} retries: ${error}`)
          results.push({ error, ok: false })
          break
        } else {
          log(`⟲ pipeline[${i}] retry ${retries}/${maxRetries}`)
          // exponential backoff
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, retries)))
        }
      }
    }
  }

  return results
}
```

#### `extensions/workflow-tool.ts` — error summary
```typescript
const result = await runWorkflow(script, { ... })

// If result contains errors, format a summary
const summary = extractErrorSummary(result)
if (summary.errorCount > 0) {
  return {
    output: result.output || "",
    metadata: {
      warnings: summary.errors,
      completedAgents: summary.completedCount,
      failedAgents: summary.errorCount,
    },
  }
}

return { output: result, metadata: {} }
```

### Tests
- `tests/error-resilience.test.ts` (parallel with errors, pipeline retry, error messages)

---

## Implementation Order

### Phase 1 (Week 1): Foundation
1. **Budget & Safety** (#18) — simplest, just tracking + limits
2. **Journaling** (#16) — core persistence, enables resume
3. **Error Resilience** (#20) — immediate value, better UX

### Phase 2 (Week 2): Features
4. **Worktree Isolation** (#17) — complex but self-contained
5. **Real-Time Display** (#19) — depends on journal for full integration

### Acceptance Criteria
- All 302 vitest tests pass
- New tests for each feature (target 50+ new tests)
- No breaking changes to existing workflow.ts or workflow-tool.ts signatures
- Backward compatible (optional parameters, defaults to existing behavior)
- README updated with new options
- GAP-ANALYSIS.md updated with completed features

---

## Commit Strategy

Each task gets a discrete PR/commit:
```
feat: implement journaling & resume capability
feat: implement git worktree isolation
feat: implement budget tracking & safety limits
feat: implement real-time workflow display
feat: implement error resilience & graceful degradation
```

Each commit should:
- Include new files + modified files
- Add tests in `tests/` matching the feature
- Update `README.md` feature docs
- Keep all vitest tests green
- Small enough to review + self-contained
