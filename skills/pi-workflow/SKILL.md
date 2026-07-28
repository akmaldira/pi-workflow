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

### Workflow with parallel fan-out
```javascript
export const meta = { name: 'multi_review', description: 'Multi-perspective review' };
const results = await parallel([
  () => agent('reviewer: Review auth module', { label: 'auth' }),
  () => agent('reviewer: Review API module', { label: 'api' }),
]);
return { results };
```
