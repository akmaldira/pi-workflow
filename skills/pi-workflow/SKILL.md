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

**Revisiting a node overwrites its state entry.** A node is not single-use: an edge can route
back to it any number of times (a run is capped at `maxIterations`, default 25). But when a node
runs again, `s.<nodeId>` is replaced with the **latest** result — earlier results are dropped from
state (the full visit sequence is still recorded in the run's history/path). This is deliberate:
cycles are for *iterative refinement* where each pass only needs the most recent state (red finds
failures → green fixes them → back to red which re-runs tests). It is **not** a way to collect one
output per pass. If you must keep every intermediate output, give each step its own node id.

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

### Cycles vs. linear chains — choose deliberately

The single most common mistake is writing a **flat linear chain with unique node names**
(`planner_1`, `architect_1`, `planner_2`, …) when the task is actually iterative. That works but
throws away the only thing the graph adds over plain sequential `await` calls: **routing**.

- A **linear chain** (`g.edge('a','b'); g.edge('b','c')`) is right when the path is fully known in
  advance and no decision depends on any agent's output.
- A **cycle** is right when the path depends on what agents actually produce — an implementer gets
  blocked and must hand work back, a reviewer rejects and the task re-enters an earlier stage, a
  draft needs another revision round.

To send the *same* node through a known multi-stage loop, reuse the single node id and decide the
next hop with a visit counter stamped into state:

```js
export const meta = { name: 'revise', description: 'Revise a draft up to 3 times' };
const g = graph();
g.node('planner', agent('planner', (s) => 'Draft from: ' + (s.feedback ?? 'scratch')));
g.node('reviewer', agent('reviewer', (s) => 'Critique: ' + s.planner));
g.edge('planner', (s) => {
  s.rounds = (s.rounds ?? 0) + 1;
  return s.rounds < 3 ? 'reviewer' : END;   // revise up to 3 times
});
g.edge('reviewer', 'planner');
g.run({});
```

But note: `s.planner` holds only the *latest* draft. If a reviewer needs every draft, the
latest-wins behavior is wrong — and that is your signal to use distinct node ids instead.

**What's available in a script:** the graph API (`graph`, `agent`, `mainAgent`, `human`, `END`,
`args`) plus ordinary language intrinsics (`JSON`, `Object`, `Array`, `String`, `Math`, etc. —
they resolve to the sandbox's own copies, so using them cannot reach the host). No `fs`,
`process`, `require`, `import`, `fetch`, `Date`, or `Math.random` — a graph describes routing
only, and non-determinism would mean a rerun could take a different path. Scripts are validated
before any agent spawns, so a rejected script costs nothing.

## Saving and Reusing Workflows

Scripts are not persisted automatically — pass `saveWorkflow: true` to save a script for later reuse (it is filed under the graph's `meta.name`), and `loadWorkflow` to re-run one without rewriting it:

```
workflow(script="...", saveWorkflow=true)                      # persists to .pi-workflow/workflows/<meta.name>.js
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

### Agents that work in a workflow graph

A custom agent does not need to know anything about routing, edges, or which other agents exist —
it only needs to do its own job. **But if it can hit a wall, it must say so using the escalation
protocol, or the graph will route it forward as if it succeeded.** This is the single most
important thing to get right when authoring an agent for a workflow.

When an agent cannot complete its task, teach it to emit this exact block (the parser is
line-anchored on `STATUS:` and `BLOCKED_ON:`):

```text
## Escalation

If you can't complete the task, say so instead of faking it:

STATUS: blocked
BLOCKED_ON: requirements | environment | conflict | contract | tests | information
REASON: <specifically what you hit>
EVIDENCE: <error output, file:line>
PROPOSED_FIX: <what would unblock you>
```

Copy that `## Escalation` section verbatim into the agent's markdown body. `BLOCKED_ON` is a
**closed vocabulary** — it is a routing key the edge branches on, not prose.
Reuse the existing categories (`requirements`, `environment`, `conflict`, `contract`, `tests`,
`information`) when one fits; the parser preserves any other value verbatim so the edge can still
see it, but a recognized category is what an edge author will have written a route for.

Two rules that make an agent safe in a graph:
1. **Escalating is a successful outcome.** State plainly that reporting a blocker is good — it is
   *cheaper than faking*. "Faking a pass is the only real failure."
2. **Forbid the shortcut failure modes by name** for any agent that writes code: do not mock or
   stub the thing under implementation, do not weaken or delete tests, do not hardcode to test
   inputs, do not claim done while the suite is red.

**You do not have to include the block for routing to work.** The protocol is **auto-injected**
into every workflow agent's system prompt at spawn time — a custom agent whose `.md` omits it
still receives it and can report a blocker. Including it in the `.md` yourself is still good
practice (it reinforces the instruction and documents intent), and it is idempotent: if the block
is already present the injection is skipped, so there is never a duplicate. Only a *technical*
crash (OOM, provider error) is not covered by this — but those already abort the graph as a
safety net.

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

Every subagent runs with one of two context modes, resolved as: explicit `context` option (subagent tool only) → agent's `defaultContext` frontmatter → `fork`.

- **`fork`** (default): the child's system prompt is prepended with a compaction-style structured summary (Goal / Progress / Key Decisions / Next Steps) of the parent session — not the raw transcript. This keeps cost bounded regardless of how long the parent conversation has run. A note referencing the parent's raw session file is included as an escape hatch, in case the child needs an exact detail not captured in the summary.
- **`fresh`**: the child starts with zero inherited history — only its system prompt + the task you give it. Use this for agents that should run in full isolation with no awareness of the current conversation.

In the `subagent` tool, override per-call:

```
subagent(tasks=[{"agent": "worker", "task": "run an isolated audit", "context": "fresh"}], mode="single")
```

In a `workflow` graph there is no inline per-node override — set `defaultContext: fresh` in that agent's frontmatter so every spawn of it runs isolated:

```markdown
---
name: auditor
defaultContext: fresh
---
```

If fork context can't be produced (no active session, or summarization fails), the subagent silently runs fresh instead — it never blocks or throws.

## Error Handling: Agent-Level vs Technical Failures

Two kinds of subagent failure are handled differently:

- **Agent-level** (the agent ran, but its own work has errors — failing tests, a tool error, rejected acceptance): The graph node still emits a result, but `status === 'error'` or `status === 'blocked'`. The workflow keeps running and follows whatever edge you wrote for that condition.
- **Technical** (LLM provider errors, rate limits, quota exhaustion, process crashes/OOM kills, protocol output limits): the whole workflow run is **automatically aborted**. The `workflow` tool call fails with a message naming the failing agent, the failure reason, and the `runId` to investigate further.

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
```js
export const meta = { name: 'fix_issues', description: 'Find and fix issues' };
const g = graph();
g.node('scan', agent('scout', () => 'Find security issues'));
g.node('fix', agent('worker', (s) => 'Fix these: ' + s.scan));
g.edge('scan', (s, r) => r.text.includes('critical') ? 'fix' : END);
g.edge('fix', END);
g.run();
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
