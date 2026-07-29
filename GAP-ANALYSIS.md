# Gap Analysis: Workflow Implementations

## Executive Summary

Our `pi-workflow` port of `py-dynamic-workflows` covers **core scripting** (agent/parallel/pipeline/phase), but lacks **production features** from both `pi-dynamic-workflows` and `pi-ultracode`:

| Feature | py-DW | pi-DW | ultracode | pi-wf |
|---------|-------|-------|-----------|-------|
| **Core Scripting** | ✓ | ✓ | ✓ | ✓ |
| agent() | ✓ | ✓ | ✓ | ✓ |
| parallel() | ✓ | ✓ | ✓ | ✓ |
| pipeline() | ✓ | ✓ | ✓ | ✓ |
| phase() | ✓ | ✓ | ✓ | ✓ |
| **Persistence & Resume** | ✗ | ✓ | ✓ | ✗ |
| journaling (cache results) | ✗ | ✓ | ✓ | ✗ |
| resumeFromRunId | ✗ | ✓ | ✓ | ✗ |
| edited-script resume | ✗ | ✓ | ✓ | ✗ |
| **Isolation** | ✗ | ✓ | ✓ | ✗ |
| git worktree per agent | ✗ | ✓ | ✓ | ✗ |
| **Agent Roles** | ✗ | limited | ✓ | ✗ |
| .pi/agents/*.md discovery | ✓* | limited | ✗ | ✓ |
| .pi/ultracode/agents/*.md | ✗ | ✗ | ✓ | ✗ |
| AgentType (role/effort/model) | ✗ | ✗ | ✓ | ✗ |
| **Model Routing** | ✗ | ✓ | ✓ | ✗ |
| tier: small/medium/big | ✗ | ✓ | ✓ | ✗ |
| explicit provider/model | ✗ | ✓ | ✓ | ✗ |
| thinking level override | ✗ | ✗ | ✓ | ✗ |
| **Structured Output** | ✓ | ✓ | ✓ | ✗ |
| schema capture + validation | ✓ | ✓ | ✓ | ✗ |
| **Concurrency** | limited | ✓ | ✓ | limited |
| concurrency limit per workflow | ✗ | ✓ | ✓ | limited |
| max total agents | ✗ | ✓ | ✓ | ✗ |
| **Budget** | ✗ | ✓ | ✓ | ✗ |
| token budget | ✗ | ✓ | ✓ | ✗ |
| script timeout | ✗ | ✓ | ✓ | ✗ |
| depth limit | ✗ | ✗ | ✓ | ✗ |
| **Display & Progress** | basic | ✓ | ✓ | basic |
| real-time progress panel | ✗ | ✓ | ✓ | ✗ |
| live render/snapshots | ✗ | ✓ | ✓ | ✗ |
| token counting | ✗ | ✓ | ✓ | ✗ |
| **Cancel/Abort** | signal | ✓ | ✓ | signal |
| graceful abort | ✓ | ✓ | ✓ | ✓ |
| captured partial output | ✗ | ✓ | ✓ | ✗ |

**Legend:** ✓ = implemented, ✗ = not implemented, * = via pi-subagents integration

---

## Feature Gaps (Detailed)

### 1. **Journaling & Resume** (Critical for iterative workflows)

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// pi-ultracode/src/workflow/journal.ts (~500 lines)
class RunJournal {
  static create(dir, meta): persists run metadata + every agent() result
  static resume(runId): loads prior cache, agent calls with same prompt/opts return instantly
  static editedResume(runId, scriptHash): only re-run changed/new calls
}

JournalAgentRecord {
  seq, key, prompt, result, outputTokens, durationMs, ...
}
```

**Our port:** ✗ Missing entirely
- No JSONL persistence
- No caching of agent() results
- No resume capability (would enable: "re-run workflow with edited script, cached results for unchanged calls")

**Impact:** Users cannot iterate on failing workflows without replaying all expensive agents.

---

### 2. **Git Worktree Isolation** (For parallel writes)

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// pi-ultracode/src/workflow/worktree.ts (~400 lines)
export function createWorktree(cwd, runId, index): Worktree {
  // git worktree add --detach <tmpdir> HEAD
  // git checkout -B ultracode/run-name-index
  // return { path, agentCwd, branch, baseCommit }
}

export function captureWorktreeDiff(worktree): WorktreeDiff {
  // git diff HEAD -- (files changed, insertions, deletions, patch)
  // merge strategy + conflict handling
}
```

Usage in agent():
```typescript
const result = await agent("refactor module X", { isolation: 'worktree' })
// Agent runs in isolated tmpdir worktree, changes don't affect shared cwd
// After agent completes, diff is captured and can be merged/applied
```

**Our port:** ✗ Missing entirely
- No worktree creation
- No per-agent file isolation
- No diff capture/merge

**Impact:** 
- Parallel write agents clobber each other's changes
- Must run sequentially to avoid conflicts
- No safe way to audit/merge changes from each agent

---

### 3. **Agent Type / Role Definitions** (Beyond simple agent() calls)

**pi-ultracode:**
```markdown
# .pi/ultracode/agents/reviewer.md
---
name: reviewer
effort: high
model: anthropic/claude-sonnet-4
tools: read, bash, grep
---
Review code for...
```

In workflow:
```typescript
const review = await agent("review src/main.ts", {
  agentType: 'reviewer'  // loads .pi/ultracode/agents/reviewer.md config
})
```

**pi-dynamic-workflows:**
- Limited agent discovery (basic .pi/agents/*.md)
- No agentType directive

**py-dynamic-workflows:**
- Via pi-subagents: .pi/agents/*.md discovery (what we ported)

**Our port:** ✓ Partial
- We have `.pi/agents/*.md` discovery from pi-subagents
- **Missing:** .pi/ultracode/agents/ namespace (can coexist without conflict)
- **Missing:** agentType parameter in workflow agent() calls

**Impact:** Workflows cannot reference custom typed agents; must inline config or rely on default agents.

---

### 4. **Model Routing & Tier System** (Per-agent model selection)

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// tier-based routing
const survey = await agent("List all routes", { tier: 'small' })     // gpt-4o-mini or equiv
const review = await agent("Review auth", { tier: 'medium' })        // claude-sonnet or equiv
const synthesize = await agent("Final check", { tier: 'big' })       // gpt-4-turbo or equiv

// explicit provider/model
const custom = await agent("task", { model: 'anthropic/claude-opus' })

// thinking level
const deep = await agent("task", { thinking: 'extended' })
```

pi-ultracode has:
- model-routing.ts: maps tiers → providers → models
- model-tier-config.ts: tier definitions + fallback chains

**Our port:** ✗ Missing entirely
- agent() options don't support tier / model / thinking
- agentRunner.run() has modelOverride but not tier system
- No routing logic

**Impact:**
- All agents inherit parent model (no per-agent tuning)
- Cannot use cheaper small-task models to save budget
- Cannot trigger extended thinking for complex tasks

---

### 5. **Concurrency & Budget Controls**

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// Concurrency limits
const opts = {
  maxConcurrent: 4,        // max parallel agents at once
  maxAgents: 100,          // max total agents in workflow
  scriptTimeoutMs: 60000,  // script runtime limit
  maxDepth: 3,             // nested workflow depth limit
}

// Budget tracking
class RunJournal {
  totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
  totalCost, agentCount, durationMs
}
```

**Our port:** ✗ Missing entirely
- MAX_CONCURRENCY hardcoded to 4 in mapWithConcurrencyLimit
- No max-agents limit
- No script timeout
- No depth tracking
- No budget enforcement at workflow level

**Impact:**
- Runaway workflows can spawn unlimited parallel tasks
- No token/cost visibility across workflow
- No fail-safe for misconfigured scripts

---

### 6. **Structured Output Capture** (Schema validation per agent)

**py-dynamic-workflows & pi-ultracode:**
```typescript
// agent() can pass schema
const findings = await agent("list findings", {
  schema: { type: 'array', items: { type: 'object', properties: { file, issue, severity } } }
})
// Returns validated JSON, not string

// pi-ultracode has:
// - structured-output.ts: schema validation
// - tool.ts: injects structured_output terminator tool
// - JSON schema inference from TypeBox
```

**Our port:** ✗ Missing in workflow
- runSingleAgent supports structuredOutput (via pi-subagents)
- But workflow.ts agent() function doesn't accept/pass schema parameter
- Returns plain string only

**Impact:** Workflows cannot enforce structured agent outputs; must parse/validate manually.

---

### 7. **Real-Time Display & Progress Tracking** (Live UI updates)

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// display.ts / workflow-ui.ts: live progress snapshots
export interface WorkflowSnapshot {
  meta: WorkflowMeta
  phases: {
    title, index, totalCount
    status: 'pending' | 'running' | 'done'
    agents: [{ status, label, model, effort, turns, tokens, ...partial output }]
  }[]
}

// Rendering for TUI
renderWorkflowLines(snapshot): string[]  // live pane rendering
renderWorkflowText(snapshot): string     // inline text
preview(value, maxLen): string           // token preview

// pi-ultracode has:
// - display.ts: inline live task pane (◆ ▶ audit_repo ...)
// - workflow-overlay.ts: modal details + paging
// - token counting + cost estimates
```

**Our port:** basic
- Workflow displays phase progress + agent count
- **Missing:** live token counts, model info, per-agent status rendering
- **Missing:** real-time snapshot updates (would need pub/sub or polling)
- **Missing:** modal task detail pane

**Impact:** No visibility into what each agent is doing, token consumption per agent.

---

### 8. **Error Handling & Fallback** (Graceful degradation)

**pi-dynamic-workflows & pi-ultracode:**
```typescript
// Partial failures don't break workflow
const results = await parallel([
  () => agent("task1"),
  () => agent("task2"),  // this can fail
  () => agent("task3"),
])
// results[1] is { error, partial output } if task2 failed
// workflow continues and can handle the error

// Pipeline handles one-at-a-time retries
const output = await pipeline(
  files,
  (file) => agent(`Process ${file}`, { retries: 2 }),
  (partial, prev) => { /* merge or skip */ }
)

// Structured abort on cancel
const aborted = signal.aborted  // check if parent cancelled
// gracefully finalize and return partial results
```

**Our port:** partial
- Signal handling works (AbortSignal)
- Parallel agents capture errors
- **Missing:** retry logic in pipeline
- **Missing:** explicit fallback/degradation modes

**Impact:** One failing agent kills entire workflow or requires custom error handling code.

---

### 9. **Determinism & Validation** (Script sandboxing)

**Both py-dynamic-workflows & pi-ultracode:**
```typescript
// Reject non-deterministic code
function assertDeterministicAst(node) {
  // Error if: Math.random(), Date.now(), new Date(), etc.
}

// Acorn-based parser + validator
// - No top-level await
// - No imports
// - No function declarations (only const arrow)
// - metadata first statement must be export const meta = { name, description }

// pi-ultracode adds:
// - blocked stdlib modules (fs, child_process, network)
// - hash-based script identity (for journal resume matching)
```

**Our port:** ✓ Basic
- We have determinism checks (Date.now, Math.random, etc.)
- **Missing:** hash-based script identity (for resume)

**Impact:** Scripts can be edited and re-run, but we can't match them to cache; must re-run all agents.

---

## Specific Missing Files from Reference Implementations

### pi-dynamic-workflows (40+ files) — examples of key gaps
- `workflow-saved.ts` — resume + journaling infrastructure
- `run-persistence.ts` — save/load run results
- `workflow-ui.ts`, `workflow-ui-pager.ts` — live display rendering
- `usage-limit-scheduler.ts` — token budget + concurrency scheduling
- `model-tier-config.ts`, `model-routing.ts` — tier-based model selection
- `agent-history.ts` — replay logic for edited-script resume

### pi-ultracode (14 workflow-specific files)
- `workflow/journal.ts` — JSONL run log + cache
- `workflow/worktree.ts` — git worktree isolation
- `workflow/agent-types.ts` — AgentType role definitions
- `workflow/agent-runner.ts` — model routing, thinking level, retry logic
- `workflow/run-details.ts` — token/turn/tool tracking per agent
- `workflow/display.ts`, `workflow-overlay.ts` — live TUI rendering
- `workflow/registry.ts` — agent type registry

---

## Recommendation: Prioritized Backlog

### Phase 1: **Survivability** (Low risk, high value)
- [ ] Add `token_budget` option to WorkflowRunOptions (track + warn/enforce)
- [ ] Add `script_timeout` option (AbortSignal-based)
- [ ] Add `max_agents` limit (throw if exceeded)
- [ ] Better error capture in parallel/pipeline (return { error, output } instead of throwing)

### Phase 2: **Usability** (Medium effort, medium value)
- [ ] Agent TYPE parameter in agent() calls (route to .pi/ultracode/agents/*.md)
- [ ] Model tier system (small/medium/big) + explicit provider/model param
- [ ] Thinking level override (model.thinking)
- [ ] Better display: inline token counts + per-agent live status

### Phase 3: **Production** (High effort, high value)
- [ ] Journaling + resume (JSONL run log + cache matching)
- [ ] Edited-script resume (hash-based script matching)
- [ ] Git worktree isolation for parallel write agents
- [ ] Real-time modal detail pane + TUI progress overlay

### Phase 4: **Advanced** (Future, optional)
- [ ] Structured output schema in agent() options
- [ ] Pipeline retry logic per stage
- [ ] Cost estimation + budget enforcement
- [ ] Full integration with pi-ultracode's AgentType system

---

## Summary Table: Implementation Effort vs. Value

| Feature | Effort | Value | Priority |
|---------|--------|-------|----------|
| Budget limits + timeout | ⭐ | ⭐⭐⭐ | 1 |
| Agent TYPE / roles | ⭐⭐ | ⭐⭐ | 2 |
| Model tiers + routing | ⭐⭐ | ⭐⭐⭐ | 2 |
| Improved error display | ⭐ | ⭐⭐ | 1 |
| Journaling + resume | ⭐⭐⭐ | ⭐⭐⭐ | 3 |
| Worktree isolation | ⭐⭐⭐ | ⭐⭐ | 3 |
| Live TUI display | ⭐⭐⭐ | ⭐⭐ | 4 |
| Structured output schema | ⭐ | ⭐ | 2 |

---

## Conclusion

Our `pi-workflow` is **feature-complete for scripting** but **lacks production hardening**. The core loop (agent/parallel/pipeline/phase/abort) is solid. The gaps are:

1. **Observability:** No token/budget tracking, no live display
2. **Resilience:** No resume, no worktree isolation, no retry logic
3. **Flexibility:** No model tiers, no agent types, no per-agent schema
4. **Safety:** No hard limits (agents, concurrency, timeout)

For a publishable package, recommend implementing Phase 1 (budget/timeout/limits) first. Phase 2 (tiers/types) would unlock real multi-model orchestration. Phase 3 (journal/worktree) enables production workflows on large codebases.
