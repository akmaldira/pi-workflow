# pi-workflow

A [pi](https://pi.dev) extension for delegating tasks to specialized subagents with isolated contexts, plus dynamic workflow orchestration inspired by [Claude Code's dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Features

- **Single mode**: Delegate one task to one agent
- **Parallel mode**: Run multiple agents concurrently (max 8 tasks, 4 concurrent)
- **Dynamic workflows**: Write JavaScript that fans out work across subagents
- **Agent discovery**: Load agents from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`
- **Rich agent configuration**: Support for all standard subagent attributes

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

- `/agents` — List available subagents with their configurations

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

### Error Handling

Failed `agent()`, `parallel()`, or `pipeline()` branches return `null` and log the failure. Check for nulls before synthesizing conclusions:

```js
const result = await agent('scout: Find auth code', { label: 'auth scan' })
if (!result) {
  log('Auth scan failed, using fallback approach')
  // ... fallback logic
}
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
| `defaultContext` | `fresh` \| `fork` | Launch context default |
| `skills` | string or array | Specific skills to load |
| `skillPath` | string or array | Private skill files or directories |
| `output` | string | Default output file |
| `defaultReads` | string or array | Files to read before running |
| `defaultProgress` | boolean | Maintain `progress.md` |
| `async` | boolean | Default to background mode |
| `timeoutMs` | number | Runtime deadline in milliseconds |
| `turnBudget` | object | `{"maxTurns": 20, "graceTurns": 2}` |
| `acceptance` | string or object | Acceptance level or `{level, reason}` |
| `acceptanceRole` | `read-only` \| `writer` | Role for acceptance inference |
| `completionGuard` | boolean | Auto-detect implementation (default: true) |
| `interactive` | boolean | Parsed for compatibility |
| `maxSubagentDepth` | number | Nested delegation limit |
| `memory` | object | `{scope: "project"|"user", path: "<name>"}` |

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

### workflow

| Parameter | Type | Description |
|-----------|------|-------------|
| `script` | string | Required JavaScript workflow script |
| `args` | any | Optional JSON value exposed as `args` global |
| `agentScope` | string | Agent discovery scope (default: `"user"`) |

## Agent Locations

- **User agents**: `~/.pi/agent/agents/*.md` (always loaded)
- **Project agents**: `.pi/agents/*.md` (requires `agentScope: "both"` or `"project"`)

## Security

Project-local agents (`.pi/agents/*.md`) can instruct the model to read files, run bash commands, etc.

By default, you're prompted before running project agents. Only enable project agents for repositories you trust.

Workflow scripts run in a deterministic VM sandbox with no filesystem, network, or time access.
