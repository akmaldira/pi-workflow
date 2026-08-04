---
name: pi-workflow
description: Subagent delegation and dynamic workflow orchestration. Use the subagent tool to delegate tasks to specialized agents, and the workflow tool to orchestrate multi-agent deterministic workflows.
---

# Pi Workflow Skill

This skill teaches you how to delegate tasks to specialized subagents and orchestrate multi-agent workflows.

## How to Spawn a Subagent

The `subagent` tool delegates a task to a specialized agent. You call it like this:

```
subagent(tasks=[{"agent": "AGENT_NAME", "task": "TASK_DESCRIPTION"}], mode="single")
```

**Step 1: Check available agents**
First, use the `/agents` command to see what agents are available, or check `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`.

**Step 2: Call the subagent tool**
```
subagent(tasks=[{"agent": "scout", "task": "Find security issues in the authentication module"}], mode="single")
```

The tool will:
1. Discover the agent file (e.g., `scout.md`) from the agent scope
2. Apply the agent's frontmatter (model, tools, maxTurns, etc.)
3. Spawn a child pi process with the agent's configuration
4. Return the subagent's output

**Step 3: Handle the result**
The result is the subagent's output string. Use it in your response or chain it to another subagent.

## How to Run Parallel Subagents

```
subagent(tasks=[{"agent": "scout", "task": "Review auth module"}, {"agent": "scout", "task": "Review payment module"}], mode="parallel")
```

## How to Run a Workflow

The `workflow` tool executes a deterministic JavaScript script that orchestrates multiple subagents:

```
workflow(script="export const meta = { name: 'audit', description: 'Security audit' };\nphase('Discovery');\nconst findings = await agent('scout: Find security issues');\nreturn { findings };")
```

**Key workflow globals:**
- `agent('agentName: prompt')` — Spawn a subagent (the agent name must match a file in the agent scope)
- `parallel([() => agent(...), () => agent(...)])` — Run agents concurrently (pass functions, not promises)
- `phase('title')` — Create a progress group
- `log('message')` — Log output

## Saving and Reusing Workflows

Scripts are not persisted automatically — pass `saveWorkflow: true` to save a script for later reuse, and `loadWorkflow` to re-run one without rewriting it:

```
workflow(script="...", saveWorkflow=true)                         # persists to .pi-workflow/workflows/<meta.name>.js
workflow(loadWorkflow="audit", args={ repo: "..." })               # re-runs the saved script; `script` not needed
```

Before writing a new workflow script from scratch, check whether a matching one was already saved (e.g. via `/saved-workflows` or by trying `loadWorkflow` first) — especially if the user asks to "run that workflow again" or describes a repeatable process. If `loadWorkflow` references an unknown name, the tool error lists the names that do exist. Use `saveWorkflow: true` when the user explicitly asks to save a workflow, or when the task is clearly a repeatable process worth reusing later; don't save one-off exploratory workflows by default.

## Creating Agents

Create agent files in `~/.pi/agent/agents/*.md` (user scope) or `.pi/agents/*.md` (project scope).

**CRITICAL REQUIREMENT:** Every agent file *must* include `name` and `description` in the YAML frontmatter block, otherwise the agent will be silently ignored!

```markdown
---
name: scout
description: Lightweight exploration agent that finds security issues and code smells.
model: google/gemini-2.5-flash
tools: read, grep, bash
maxTurns: 5
acceptance:
  level: none
---

# Scout Agent

Find security issues and code smells. Keep responses concise.
```

## Agent Frontmatter Attributes

| Attribute | Description |
|-----------|-------------|
| `name` | **Required.** Name of the agent (used to spawn it) |
| `description` | **Required.** Short description of what the agent does |
| `model` | Model to use (e.g., google/gemini-2.5-pro) |
| `tools` | Tool allowlist (comma-separated or YAML list) |
| `maxTurns` | Maximum conversation turns |
| `maxToolCalls` | Maximum tool calls |
| `temperature` | Model temperature (0.0-1.0) |
| `acceptance.level` | none, checked, or auto |
| `acceptance.evidence` | Required evidence kinds |
| `defaultContext` | `fresh` or `fork` (global default: `fork`) — see Context section below |

## Context: Fresh vs Fork

Every subagent runs with one of two context modes, resolved as: explicit `context` option → agent's `defaultContext` frontmatter → `fork`.

- **`fork`** (default): the child's system prompt is prepended with a compaction-style structured summary (Goal / Progress / Key Decisions / Next Steps) of the parent session — not the raw transcript. This keeps cost bounded regardless of how long the parent conversation has run. A note referencing the parent's raw session file is included as an escape hatch, in case the child needs an exact detail not captured in the summary.
- **`fresh`**: the child starts with zero inherited history — only its system prompt + the task you give it. Use this for agents that should run in full isolation with no awareness of the current conversation.

Opt out of forking when a delegated task should run in complete isolation, unaware of the current conversation:

```
subagent(tasks=[{"agent": "worker", "task": "run an isolated audit", "context": "fresh"}], mode="single")
```

```javascript
await agent('worker: run an isolated audit', { context: 'fresh' })
```

If fork context can't be produced (no active session, or summarization fails), the subagent silently runs fresh instead — it never blocks or throws.

## Error Handling: Agent-Level vs Technical Failures

Two kinds of subagent failure are handled differently:

- **Agent-level** (the agent ran, but its own work has errors — failing tests, a tool error, rejected acceptance): `agent()` returns `null` and logs the failure. The workflow keeps running — always check for `null` before using a result downstream.
- **Technical** (LLM provider errors, rate limits, quota exhaustion, process crashes/OOM kills, protocol output limits): the whole workflow run is **automatically aborted**. Any sibling subagents still running are cancelled, and the `workflow` tool call fails with a message naming the failing agent, the failure reason, and the `runId` to investigate further.

```javascript
const result = await agent('scout: find security issues');
if (!result) {
  log('scout failed (agent-level) — continuing without findings');
}
```

If you see a workflow tool call fail with "hit a technical failure", **do not** assume the workflow script is broken — it's usually transient infrastructure (rate limit, provider outage, OOM). Use `workflow_status` to inspect before retrying or editing the script.

### Investigating a failed run: `workflow_status`

```
workflow_status({ runId: "wf-1234567890" })
```
Summarizes every agent's status/error/result preview in the run.

```
workflow_status({ runId: "wf-1234567890", agentId: 2 })
```
Returns one agent's full prompt, complete (untruncated) result, and tool-call/output history — use this to see exactly what a failing (or any) agent did before it failed, without needing the interactive `/workflows` TUI.

## Common Patterns

### Delegate to a specialized agent
```
subagent(tasks=[{"agent": "worker", "task": "Implement user authentication with JWT tokens"}], mode="single")
```

### Run multiple agents in parallel
```
subagent(tasks=[{"agent": "scout", "task": "Review auth"}, {"agent": "scout", "task": "Review API"}, {"agent": "scout", "task": "Review payments"}], mode="parallel")
```

### Workflow with conditional logic
```javascript
export const meta = { name: 'fix_issues', description: 'Find and fix issues' };
const findings = await agent('scout: Find security issues');
if (findings.critical) {
  await agent('worker: Fix all critical issues');
}
return { status: 'done' };
```

### Running Without a TUI (IDE / Headless Mode)

If you are running `pi` without an interactive terminal (like via an IDE extension, API, or `--mode json`) and you have `pi-permission-system` installed, it will automatically block the `subagent` and `workflow` tools because it cannot prompt the user for permission.

You must configure your `pi-permission-system` settings (`~/.pi/agent/settings.json`) to explicitly allow these tools, or allow all tools:

```json
{
  "extensionsConfig": {
    "pi-permission-system": {
      "policy": {
        "subagent": "allow",
        "workflow": "allow",
        "*": "allow" // Or configure specifically
      }
    }
  }
}
```
