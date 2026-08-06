# pi-workflow

A [pi](https://pi.dev) extension for delegating tasks to specialized subagents with isolated contexts, plus dynamic workflow orchestration inspired by [Claude Code's dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Features

- **Single mode**: Delegate one task to one agent
- **Parallel mode**: Run multiple agents concurrently (max 8 tasks, 4 concurrent)
- **Dynamic workflows**: Write JavaScript that fans out work across subagents
- **Agent discovery**: Load agents from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`
- **Rich agent configuration**: Support for all standard subagent attributes
- **Journaling & Resume** — Cache agent results and resume interrupted workflows with intelligent script-change detection
- **Git Worktree Isolation** — Run parallel file-mutating agents in safe throwaway git worktrees
- **Budget Tracking** — Track agent count, token usage, and script timeout with configurable limits
- **Error Resilience** — Graceful degradation with partial failure handling
- **Real-Time Display** — Workflow snapshots and progress rendering for TUI monitoring

## Install

```bash
# Local path
pi install ./pi-workflow

# Or, once published:
pi install npm:pi-workflow
```

## Usage

### Define Agents

Create agent files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase exploration
model: claude-haiku-4-5
tools: read, grep, find, ls, bash
thinking: high
inheritSkills: false
skills: safe-bash
---

You are a codebase scout. Search and explore files efficiently.
Return brief summaries focused on the task at hand.
```

### Use the Subagent Tool

```typescript
// Single mode
subagent(agent: "scout", task: "Find all authentication code")

// Parallel mode
subagent(tasks: [
  { agent: "scout", task: "Find all models" },
  { agent: "scout", task: "Find all providers" }
])
```

### Use the Workflow Tool

```typescript
workflow(script: `
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules'
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', { label: 'repo inventory' })

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' }
)

return { inventory, summary }
`)
```

### Commands

- `/workflows` — Open the interactive Claude Code-style dynamic workflow TUI navigator (runs ──▶ phases ──▶ agents ──▶ agent detail)
- `/workflow [on|off]` — Toggle workflow-only mode: forces the agent to delegate all work through the `workflow` tool (see below)
- `/saved-workflows` — List workflow scripts saved for reuse (`/saved-workflows delete <name>` to remove one)
- `/agents` — List available subagents with their configurations

### Workflow-Only Mode (`/workflow`)

`/workflow on` restricts the agent to a read-only + orchestration tool surface, forcing all file changes and delegation through the `workflow` tool:

- **Disabled**: `write`, `edit`, `subagent` — the agent cannot mutate files directly or delegate to a single subagent, bypassing workflow's journaling/budget/error-resilience machinery.
- **Read-only**: `bash` stays active but write-shaped commands (`rm`, `mv`, `sed -i`, redirects, `git commit`/`push`, package installs, etc.) are blocked with a message pointing back to the `workflow` tool. Pure investigation commands (`cat`, `grep`, `git status`/`diff`/`log`, `curl`, etc.) still work.
- **Available**: `read`, `bash` (read-only), `grep`, `find`, `ls`, `workflow`, `workflow_status`, plus any other currently-active non-mutating tools.
- **System-prompt injection**: while the mode is on, a directive is appended to the system prompt on every turn instructing the model to use `workflow` for any task needing file changes or delegation, and to keep investigation to read-only tools — modeled on the keyword-arming / prompt-injection pattern used by pi-dynamic-workflows' `workflow-editor.ts` (`installWorkflowKeywordArming`/`buildArmedWorkflowPrompt`) and the read-only tool-gating pattern from the bundled `plan-mode` example extension.

`/workflow off` restores the exact tool set that was active before `/workflow on` was run. `/workflow` (no args) or `/workflow status` reports the current state without changing anything.

This is useful when you want to guarantee every code change goes through workflow's journaling, budget tracking, and worktree isolation — e.g. in CI-like or supervised sessions where ad-hoc direct edits should not be possible.

## Dynamic Workflows

The `workflow` tool lets you write a small JavaScript script that fans out work across multiple subagents, then synthesizes the results.

### Workflow Script Format

A workflow script is plain JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'short_snake_case',  // required
  description: 'non-empty description',  // required
  whenToUse: 'When to use this workflow',  // optional
  phases: [  // optional documentation
    { title: 'Scan' },
    { title: 'Analyze' }
  ]
}
```

After the metadata, write plain JavaScript using the available globals.

### Available Globals

| Global | Description |
|--------|-------------|
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text output. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. |
| `phase(title)` | Mark the current phase for progress grouping. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Agent Resolution

The `agent()` global can resolve named agents from your agent definitions by prefixing the prompt with the agent name:

```js
// Uses the "researcher" agent's frontmatter attributes
const findings = await agent('researcher: Find security vulnerabilities in this codebase', {
  label: 'security research'
})
```

If the agent name matches a discovered agent, its frontmatter attributes (model, tools, skills, system prompt, etc.) are applied automatically.

### Determinism Rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- Spreads, computed keys, template interpolation, function calls inside `meta`

### Parallel and Pipeline Examples

```js
// Parallel: fan out across multiple agents
phase('Research')
const results = await parallel([
  () => agent('researcher: Find API documentation', { label: 'api docs' }),
  () => agent('researcher: Find security issues', { label: 'security scan' }),
  () => agent('researcher: Find performance bottlenecks', { label: 'perf scan' })
])

// Pipeline: process items through stages
phase('Review')
const reviews = await pipeline(
  ['file1.ts', 'file2.ts', 'file3.ts'],
  (file) => agent(`reviewer: Review ${file} for quality`, { label: `review ${file}` }),
  (review) => agent('planner: Create fix plan from review', { label: 'fix plan' })
)
```

### Context: Fresh vs Fork

Every subagent (via `subagent` tool or `agent()` in a workflow) runs with one of two context modes:

| Mode | Behavior |
|------|----------|
| `fork` (default) | Child's system prompt is prepended with a **compaction-style structured summary** of the parent session (Goal / Progress / Key Decisions / Next Steps / Critical Context), not the raw transcript. |
| `fresh` | Child starts with zero inherited history — only its system prompt + the task prompt. |

**Why a summary instead of the full raw transcript?** Forking the entire parent session JSONL scales linearly with conversation length — a long-running session can be millions of tokens, and forking that into every delegated agent (especially with `parallel()` fan-out) is both cost-prohibitive and mostly noise for a focused task. Instead, `fork` reuses Pi's own compaction primitives (the same mechanism behind `/compact` and auto-compaction) to produce a small, signal-dense summary. Fork cost stays roughly flat regardless of how long the parent conversation has been running.

**Escape hatch:** when a fork summary is generated, the child's system prompt also references the parent's raw session file path, so a task that genuinely needs an exact quote or detail not captured in the summary can read it directly instead of always paying full-fork cost upfront.

**Setting context:**

```js
// Per-call, in a workflow script (fork is already the default, this is explicit for clarity)
await agent('worker: continue the API implementation', { context: 'fork' })

// Opt out of forking for a fully isolated agent:
await agent('worker: run in complete isolation', { context: 'fresh' })

// Or set defaultContext in the agent's frontmatter (see below) to change its default
```

```json
// subagent tool call (single mode) — opt out of the fork default
{ "agent": "worker", "task": "...", "context": "fresh" }

// subagent tool call (parallel mode) — per task
{ "tasks": [{ "agent": "worker", "task": "...", "context": "fresh" }] }
```

Resolution order: explicit `context` option → agent's `defaultContext` frontmatter → `fork`.

If `fork` context can't be produced (e.g. no active session, or summarization fails), the subagent runs with `fresh` context instead and a note is recorded — it never throws or blocks execution.

### Error Handling

`pi-workflow` distinguishes two kinds of subagent failure:

- **Agent-level failures** — the subagent ran, but its own work has errors (a test suite failed, a tool call errored, acceptance validation rejected the output). These are **not** treated as fatal: `agent()`, `parallel()`, or `pipeline()` branches return `null` (or `{ error, ok: false }` for `parallel()`/`pipeline()` items) and log the failure. The workflow keeps running.
- **Technical failures** — infrastructure problems that make the result untrustworthy: LLM provider errors (rate limits, quota exhaustion, auth failures, timeouts, 5xx responses), the subagent process being killed (e.g. an OOM kill / `SIGKILL`), or protocol-level output limits being exceeded. These **automatically abort the whole workflow run**: any sibling subagents still in flight are cancelled (SIGTERM'd), and the `workflow` tool call fails with a clear message identifying which agent failed and why — instead of silently letting a downstream `agent()` call consume a corrupted/garbage result.

Check for nulls (or inspect the failure text) before synthesizing conclusions from agent-level failures:

```js
const result = await agent('scout: Find auth code', { label: 'auth scan' })
if (!result) {
  log('Auth scan failed, using fallback approach')
  // ... fallback logic
}
```

When a technical failure aborts a workflow, the tool call itself throws with a message like:

```
Workflow "build_app" stopped: agent "backend" hit a technical failure (provider-error): rate limit exceeded

This was classified as a technical/infrastructure failure (not a normal agent-level error, e.g. failing tests),
so the workflow was stopped and remaining subagents were cancelled to avoid wasting work on corrupted input.

Run ID: wf-1234567890. Use the workflow_status tool with this runId to inspect the failing agent's full result,
error, and tool-call history before deciding how to proceed (e.g. retry, fix the workflow script, or wait and
re-run if this looks like a transient provider outage).
```

#### Investigating a failure: the `workflow_status` tool

Use the `workflow_status` tool (available to the main agent, no TUI required) to inspect a run after a failure:

```
workflow_status({ runId: "wf-1234567890" })
```

Returns a summary of every agent's status, phase, and error/result preview. To see one agent's full detail — complete prompt, full (untruncated) result, and its tool-call/output history — pass `agentId`:

```
workflow_status({ runId: "wf-1234567890", agentId: 2, historyLimit: 200 })
```

This is the same live data the interactive `/workflows` navigator reads, so it works for both in-progress and completed runs.

### Advanced: Workflow Options

The `workflow` tool accepts optional parameters that control execution behavior:

```typescript
workflow(script, {
  args: { repo: 'github.com/bejorock/pi-workflow' },  // Exposed as `args` global
  agentScope: 'both',                                  // Discover agents from both user & project
  cwd: '/path/to/project',                            // Working directory
  journalDir: '/tmp/pi-workflow-journals',            // Enable journaling/resume
  resumeRunId: 'run-abc123',                          // Resume a previous run by ID
  saveWorkflow: true,                                  // Persist script to .pi-workflow/workflows/<name>.js
  loadWorkflow: 'build_docs',                          // Run a previously saved workflow (script optional/ignored)
})
```

#### Journaling & Resume

Enable persistent caching of agent results by providing a `journalDir`. Subsequent calls with the same `runId` can skip cached agents automatically:

```js
export const meta = { name: 'build_docs', description: 'Generate project documentation' }

// If journalDir + resumeRunId provided, cached results are reused
const overview = await agent('scout: Map the codebase structure', { label: 'overview' })
// If this agent ran before with the same script hash, it returns instantly from cache
const analysis = await agent('researcher: Analyze the modules', { label: 'analysis' })

return { overview, analysis }
```

The journal tracks: script hash (for cache invalidation on edits), total agents spawned, total tokens, and per-agent cached results. When the script changes, the cache is automatically invalidated.

### Saving & Reusing Workflows

A workflow script only exists in-memory for the duration of a `workflow` tool call by default — there is no automatic persistence. To save a script so it can be re-run later without rewriting it, pass `saveWorkflow: true`:

```js
workflow(script, { saveWorkflow: true })
```

This writes the script to `.pi-workflow/workflows/<meta.name>.js` in the project (keyed by `meta.name`; saving again under the same name overwrites the previous version — there is no versioning/history). The tool's response includes a note confirming the save and how to re-run it.

To re-run a saved workflow later, pass `loadWorkflow` with the saved name instead of `script`:

```js
workflow({ loadWorkflow: 'build_docs', args: { repo: 'github.com/bejorock/pi-workflow' } })
```

If `loadWorkflow` doesn't match anything saved, the tool throws an error listing the names that *are* available, so the agent can self-correct instead of guessing.

Use `/saved-workflows` to list everything saved in the current project (name, description, `whenToUse`, save timestamp), or `/saved-workflows delete <name>` to remove one. Saved workflow files are plain JS with a small header comment — you can also hand-edit them directly in `.pi-workflow/workflows/`.

**Saving from the `/workflows` TUI:** you don't need to ask the agent to pass `saveWorkflow: true` up front — open `/workflows`, select a run (from the runs list, or drilled into its phases/agents/detail view), and press `s` to save its script to the library right there. This works for any run still live in the current session (its script is kept in memory on the run, never written to the journal), so you can decide to save a workflow *after* seeing that it worked well, without re-running it. Runs restored purely from a persisted journal (e.g. after restarting pi) can't be saved this way, since only a hash of the script — not the script itself — is journaled; only `s`'s not-available warning will show in that case.

> Note: this is separate from journal-based resume (`journalDir`/`resumeRunId` above), which caches *agent results* within a single logical run. Saving a workflow persists the *script itself* for reuse across entirely new runs.

### Git Worktree Isolation

For parallel agents that write files, use `isolation: 'worktree'` to run in throwaway git worktrees:

```js
phase('Implementation')
const results = await parallel([
  () => agent('worker: Implement file A', { isolation: 'worktree', label: 'file A' }),
  () => agent('worker: Implement file B', { isolation: 'worktree', label: 'file B' })
])
```

Each worktree-isolated agent gets its own git branch in `/tmp/`, preventing concurrent file conflicts. Diffs are captured per-agent and can be applied back to the main tree after verification.

### Budget Tracking

The workflow runtime tracks agent usage and can enforce optional limits:

```js
// In agent options:
const result = await agent('task', {
  maxAgents: 10,           // Hard limit on total agents (throws if exceeded)
  scriptTimeoutMs: 60000,  // Max script runtime
  tokenBudget: 100000,     // Warn at 80%/100%, tracked only (no hard enforcement)
  maxConcurrent: 4,        // Max concurrent agents in parallel()
})
```

| Parameter | Limit Type | Behavior |
|-----------|-----------|----------|
| `maxAgents` | Hard | Throws error if exceeded |
| `scriptTimeoutMs` | Hard | Throws if exceeded |
| `tokenBudget` | Soft (tracking only) | Warns at 80%/100%, workflow continues |
| `maxConcurrent` | Soft | Limits parallelization, doesn't reduce result set |

### Real-Time Display

Access the `WorkflowSnapshot` API for custom TUI rendering:

```typescript
import { createWorkflowSnapshot, renderWorkflowText, getSnapshotStats } from 'pi-workflow/extensions/workflow-display'

const snapshot = createWorkflowSnapshot({ name: 'my_workflow', description: 'desc' })
// ... recordAgent, updatePhaseStatus, finalizeSnapshot ...
const text = renderWorkflowText(snapshot, { compact: false, showTokens: true })
console.log(text)
```

## Agent Frontmatter Attributes

### Required

| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Agent name (used for lookup) |
| `description` | string | What this agent does |

### Optional Configuration

| Attribute | Type | Description |
|-----------|------|-------------|
| `package` | string | Package identifier (registers as `package.name`) |
| `model` | string | Model ID (e.g., `claude-sonnet-4-5`) |
| `thinking` | string | Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `tools` | string or array | Tool allowlist (comma-separated or YAML list) |
| `extensions` | string or array | Extension allowlist (empty = no extensions, omitted = normal) |
| `subagentOnlyExtensions` | string or array | Extensions loaded only for child sessions |
| `fallbackModels` | string or array | Backup models for provider/model failures |
| `systemPromptMode` | `replace` \| `append` | System prompt behavior (default: `replace`) |
| `inheritProjectContext` | boolean | Keep inherited project instruction blocks (default: true) |
| `inheritSkills` | boolean | Keep Pi's discovered skills (default: true) |
| `defaultContext` | `fresh` \| `fork` | Launch context override for this agent (global default: `fork`). See [Context: Fresh vs Fork](#context-fresh-vs-fork). |
| `skills` | string or array | Specific skills to load |
| `skillPath` | string or array | Private skill files or directories |
| `output` | string | Default output file |
| `defaultReads` | string or array | Files to read before running |
| `defaultProgress` | boolean | Maintain `progress.md` |
| `async` | boolean | Default to background mode |
| `timeoutMs` | number | Runtime deadline in milliseconds |
| `turnBudget` | object | `{"maxTurns": 20, "graceTurns": 2}` |
| `acceptance` | string or object | Acceptance level or `{level, reason} |
| `acceptanceRole` | `read-only` \| `writer` | Role for acceptance inference |
| `completionGuard` | boolean | Auto-detect implementation (default: true) |
| `interactive` | boolean | Parsed for compatibility |
| `maxSubagentDepth` | number | Nested delegation limit |
| `memory` | object | `{scope: "project"\|"user", path: "<name>"}` |

## Example Agents

### Simple Scout

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
model: claude-haiku-4-5
---

You are a scout. Quickly explore the codebase and return key findings.
```

### Researcher with Web Access

```markdown
---
name: researcher
description: Web and docs research
tools: read, web_fetch
model: claude-sonnet-4-5
thinking: high
---

You are a researcher. Find authoritative sources and cite them.
```

### Planner with Custom Skills

```markdown
---
name: planner
description: Implementation planning
tools: read, grep, find
model: claude-sonnet-4-5
inheritSkills: false
skills: planning, documentation
---

You are a planner. Create concrete implementation plans.
Do NOT make changes; only read and analyze.
```

### Worker with Extensions

```markdown
---
name: worker
description: General implementation
model: claude-sonnet-4-5
extensions:
  - ./tools/my-tools.ts
subagentOnlyExtensions:
  - ./tools/worker-only.ts
completionGuard: false
---

You are a worker. Implement the approved plan.
Use all available tools.
```

### Agent with Memory

```markdown
---
name: reviewer
description: Code reviewer
model: claude-sonnet-4-5
memory:
  scope: project
  path: security-reviewer
---

You are a reviewer. Check for security issues and quality.
Your memory accumulates across reviews in this project.
```

### Agent with Turn Budget

```markdown
---
name: auditor
description: Code auditor
model: claude-sonnet-4-5
turnBudget:
  maxTurns: 15
  graceTurns: 2
timeoutMs: 300000
---

You are an auditor. Complete within 15 turns max.
```

## Tool Parameters

### subagent

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | string | Agent name (single mode) |
| `task` | string | Task to delegate (single mode) |
| `tasks` | array | Array of `{agent, task}` objects (parallel mode) |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | Agent discovery scope (default: `"user"`) |
| `confirmProjectAgents` | boolean | Confirm before running project agents (default: `true`) |
| `cwd` | string | Working directory for agent process |
| `context` | `"fresh"` \| `"fork"` | Launch context (default: `"fork"`). See [Context: Fresh vs Fork](#context-fresh-vs-fork). Single mode: top-level param. Parallel mode: per-task field inside `tasks[]`. |

### workflow

| Parameter | Type | Description |
|-----------|------|-------------|
| `script` | string | JavaScript workflow script. Required unless `loadWorkflow` is provided. |
| `args` | any | Optional JSON value exposed as `args` global |
| `agentScope` | string | Agent discovery scope (default: `"user"`) |
| `cwd` | string | Working directory for subagents (default: project root) |
| `journalDir` | string | Directory for Journaling & Resume persistence |
| `resumeRunId` | string | Resume ID for cached results (used with journalDir) |
| `saveWorkflow` | boolean | If `true`, persist `script` to `.pi-workflow/workflows/<meta.name>.js` after a successful run. See [Saving & Reusing Workflows](#saving--reusing-workflows). |
| `loadWorkflow` | string | Name of a previously saved workflow to run instead of `script`. |

## Agent Locations

- **User agents**: `~/.pi/agent/agents/*.md` (always loaded)
- **Project agents**: `.pi/agents/*.md` (requires `agentScope: "both"` or `"project"`)

## Security

Project-local agents (`.pi/agents/*.md`) can instruct the model to read files, run bash commands, etc.

By default, you're prompted before running project agents. Only enable project agents for repositories you trust.

Workflow scripts run in a deterministic VM sandbox with no filesystem, network, or time access.

### Compatibility with `pi-permission-system`

pi-workflow's `subagent` and `workflow` tools spawn subagents the same way [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) does — as CLI subprocesses (`pi --mode json -p`) — and set the exact env vars [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) documents for that integration pattern:

- `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_DEPTH` — let pi-permission-system detect that a child process is a subagent (no in-process registration needed).
- `PI_SUBAGENT_PARENT_SESSION` — set to the parent's session id (`ctx.sessionManager.getSessionId()`) so `ask`-state permission prompts triggered inside a subagent are forwarded to and resolved in the parent session's UI, instead of being auto-denied.

If both extensions are installed, this works automatically — no configuration required. You can freely combine pi-workflow's `tools:`/`disallowed_tools:`-style frontmatter with pi-permission-system's `permission:` frontmatter block in the same agent `.md` file; the two are read independently and compose additively (a tool hidden by one is invisible to the other; a tool denied by either stays denied). See pi-permission-system's [permission-frontmatter-for-subagent-extensions guide](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-permission-system/docs/guides/permission-frontmatter-for-subagent-extensions.md) for the full frontmatter format and examples.

**Headless caveat:** if pi itself is run non-interactively (e.g. `pi --mode json`, an IDE extension, or an API integration) and pi-permission-system is installed, it has no UI to forward `ask` prompts to, so `ask`-gated tools (including `subagent`/`workflow` themselves, if policy requires asking for them) are auto-denied rather than silently allowed. Configure pi-permission-system's policy to `allow` the tools/surfaces you need in that mode — see the [Running Without a TUI](skills/pi-workflow/SKILL.md) section of the bundled skill for a config example.

## Roadmap: Graph-Based Agent Coordination

The imperative `workflow` script (agent/parallel/pipeline) is being **replaced** with a
**graph-based coordination system**: agents are nodes, edges handle routing (direct or
conditional), and shared state flowing through the graph IS the blackboard. The main pi agent
composes a different graph for each task — dynamic team assembly as constrained, validated code.
Agents coordinate *with each other* through the graph's routing, not through a central
dispatcher. A `green` node hitting a wall routes back to `architect` through an edge condition,
not through a messaging system.

The full design is in [`docs/GRAPH-WORKFLOW-DESIGN.md`](./docs/GRAPH-WORKFLOW-DESIGN.md) —
covering the graph DSL (constrained code, validated with acorn + vm sandbox), node types
(agent/mainAgent/human), edge types (direct/conditional), the graph executor, bundled agent
catalog, dynamic team composition, human-in-the-loop, persistence/resume, and a phased build
plan. (The earlier `docs/COORDINATION-DESIGN.md` is superseded.)

## Testing

This project includes a comprehensive test suite:

```bash
npm test                    # Run all tests
npm test -- name.filter     # Run tests matching filter
```

**Current: 378 tests passing across 17 test files** — covering workflow parsing, runtime execution, subagent spawning, agent discovery, budget controls, journaling, worktree isolation, error resilience, and real-time display.
