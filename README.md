# pi-workflow

A [pi](https://pi.dev) extension for delegating tasks to specialized subagents with isolated contexts.

## Features

- **Single mode**: Delegate one task to one agent
- **Parallel mode**: Run multiple agents concurrently (max 8 tasks, 4 concurrent)
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

### Use the Tool

```typescript
// Single mode
subagent(agent: "scout", task: "Find all authentication code")

// Parallel mode
subagent(tasks: [
  { agent: "scout", task: "Find all models" },
  { agent: "scout", task: "Find all providers" }
])
```

### Commands

- `/agents` — List available subagents with their configurations

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | string | Agent name (single mode) |
| `task` | string | Task to delegate (single mode) |
| `tasks` | array | Array of `{agent, task}` objects (parallel mode) |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | Agent discovery scope (default: `"user"`) |
| `confirmProjectAgents` | boolean | Confirm before running project agents (default: `true`) |
| `cwd` | string | Working directory for agent process |

## Agent Locations

- **User agents**: `~/.pi/agent/agents/*.md` (always loaded)
- **Project agents**: `.pi/agents/*.md` (requires `agentScope: "both"` or `"project"`)

## Security

Project-local agents (`.pi/agents/*.md`) can instruct the model to read files, run bash commands, etc.

By default, you're prompted before running project agents. Only enable project agents for repositories you trust.