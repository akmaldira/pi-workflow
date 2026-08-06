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

The `workflow` tool runs a **graph** of coordinating agents: nodes are agents, edges decide where
each result goes next. Use it when the path is not known in advance — particularly when an agent
might hit a wall and need to hand the problem back to whoever can fix it. For a single delegation
with no coordination, use `subagent` instead.

```
workflow(script="export const meta = { name: 'audit', description: 'Security audit' };
const g = graph();
g.node('scan', agent('scout', (s) => 'Find security issues in: ' + s.target));
g.node('verify', agent('researcher', (s) => 'Verify these findings with evidence:\n' + s.scan));
g.edge('scan', 'verify');
g.edge('verify', END);
g.run({ target: args.target });", args={ target: "auth module" })
```

**Building a graph:**
- `graph()` — create the graph (exactly one per script)
- `g.node(id, agent(name, (state) => prompt))` — an agent node
- `g.node(id, mainAgent(prompt))` — pause for your own judgement mid-run
- `g.node(id, human(prompt, { options, default }))` — ask the user; always give a `default`
- `g.edge(from, to)` / `g.edge(from, END)` — direct routing
- `g.edge(from, (state, result) => target)` — conditional routing
- `g.run(initialState)` — start it

**State flows between nodes.** Each node's result is stored under its id, so a later node reads an
earlier one via `s.<nodeId>`. Interpolating a result gives the agent's text; edge conditions get
`{ status, text, blockedOn, reason }`.

**Route blockers to whoever owns the problem.** When an agent reports `status === 'blocked'`, send
it back rather than retrying the same node — that is the entire point of the graph:

```
g.edge('green', (state, result) => {
  if (result.status === 'blocked') {
    return result.blockedOn === 'contract' ? 'architect' : 'red';
  }
  return 'reviewer';
});
```

Cycles are allowed and are how escalation works. A run stops at `maxIterations` (default 25) if a
loop never resolves.

**Only these globals exist:** `graph`, `agent`, `mainAgent`, `human`, `END`, `args`, `JSON`. No
`fs`, `process`, `require`, `import`, `fetch`, `Date`, or `Math.random` — a graph describes routing
only. Scripts are validated before any agent spawns, so a rejected script costs nothing.

## Saving and Reusing Workflows

Scripts are not persisted automatically — pass `saveWorkflow: true` to save a script for later reuse, and `loadWorkflow` to re-run one without rewriting it:

```
workflow(script="...", saveWorkflow=true)                         # persists to .pi-workflow/workflows/<meta.name>.js
workflow(loadWorkflow="audit", args={ repo: "..." })               # re-runs the saved script; `script` not needed
```

Before writing a new workflow script from scratch, check whether a matching one was already saved (e.g. via `/saved-workflows` or by trying `loadWorkflow` first) — especially if the user asks to "run that workflow again" or describes a repeatable process. If `loadWorkflow` references an unknown name, the tool error lists the names that do exist. Use `saveWorkflow: true` when the user explicitly asks to save a workflow, or when the task is clearly a repeatable process worth reusing later; don't save one-off exploratory workflows by default.

The user can also save a workflow after the fact from the `/workflows` TUI navigator by selecting a run and pressing `s` — no need to have passed `saveWorkflow: true` up front. This only works for runs still live in the current session (the script is kept in memory, not journaled); it won't work for runs restored from a prior session's journal.

## Workflow-Only Mode (`/workflow`)

`/workflow on` locks the session into workflow-only delegation: `write`, `edit`, and `subagent` are removed from the active tool set, `bash` is restricted to read-only commands (mutation-shaped commands like `rm`, `mv`, `sed -i`, redirects, `git commit`/`push`, package installs are blocked), and a system-prompt directive is injected telling the model to use the `workflow` tool for any task that needs file changes or delegation. `read`, read-only `bash`, `grep`, `find`, `ls`, `workflow`, and `workflow_status` remain available for investigation and orchestration.

`/workflow off` restores the exact tool set active before the mode was entered. `/workflow` or `/workflow status` reports current state without changing anything.

If you are the agent and workflow mode is active (you'll see it in the injected system-prompt directive, or a blocked-tool error message), do not try to work around it — write a workflow script and call the `workflow` tool instead of attempting write/edit/subagent or a mutating bash command.

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
