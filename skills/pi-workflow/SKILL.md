---
name: pi-workflow
description: Subagent delegation and dynamic workflow orchestration for pi. Use the subagent tool to delegate tasks to specialized agents with frontmatter support, and the workflow tool to orchestrate multi-agent deterministic workflows.
---

# Pi Workflow Skill

This skill teaches you how to use the pi-workflow extension's tools: `subagent` and `workflow`.

## Available Tools

### 1. `subagent` Tool

Delegates tasks to specialized subagents with isolated context.

**Parameters:**
- `tasks` (array, required): Array of task objects, each with:
  - `agent` (string): Agent name (must exist in ~/.pi/agent/agents/*.md or .pi/agents/*.md)
  - `task` (string): Task description/prompt
  - `label` (string, optional): Unique label for the subagent
  - `model` (string, optional): Override the agent's model
  - `maxTurns` (number, optional): Override max turns
  - `maxToolCalls` (number, optional): Override max tool calls
- `mode` (string, optional): "single" or "parallel" (default: "single")
- `agentScope` (string, optional): "user", "project", or "both" (default: "user")

**Usage:**
```
subagent(tasks=[{"agent": "scout", "task": "Find security issues in the auth module"}], mode="single")
```

**Parallel mode:**
```
subagent(tasks=[{"agent": "scout", "task": "Review auth"}, {"agent": "scout", "task": "Review payments"}], mode="parallel")
```

### 2. `workflow` Tool

Executes a deterministic JavaScript workflow that orchestrates multiple subagents.

**Parameters:**
- `script` (string, required): Raw JavaScript workflow script
- `args` (any, optional): Arguments exposed as `args` global
- `agentScope` (string, optional): "user" or "both" (default: "user")

**Script format:**
```javascript
export const meta = { name: 'security_audit', description: 'Find and fix security issues' };

// Use phase() to group work
phase('Discovery');
const findings = await agent('scout: Find security issues in the codebase');

// Conditional branching
if (findings.critical) {
  phase('Remediation');
  await agent('worker: Fix all critical security issues');
}

// Parallel execution
const [auth, payments] = await parallel([
  () => agent('scout: Review auth module', { label: 'auth review' }),
  () => agent('scout: Review payment module', { label: 'payment review' })
]);

return { status: 'complete', findings };
```

**Available globals in workflow scripts:**
- `agent(prompt, opts)` — Spawn a subagent (prompt format: "agentName: task description")
- `parallel(thunks)` — Run multiple agent calls concurrently (takes functions, not promises)
- `pipeline(items, ...stages)` — Run items through sequential stages
- `phase(title)` — Create a progress group
- `log(message)` — Log a message
- `args` — Arguments passed to the workflow
- `cwd` — Current working directory

## Creating Agents

Agents are markdown files with YAML frontmatter. Create them in:
- User scope: `~/.pi/agent/agents/*.md`
- Project scope: `.pi/agents/*.md`

**Example agent file (scout.md):**
```markdown
---
model: google/gemini-2.5-flash
tools: read, grep, bash
maxTurns: 5
acceptance:
  level: none
---

# Scout Agent

You are a scout agent. Explore codebases quickly and report findings.
Focus on security issues, code smells, and key patterns.
```

**Agent frontmatter attributes:**
- `model` — Model to use (e.g., google/gemini-2.5-pro)
- `tools` — Tool allowlist (comma-separated or YAML list)
- `maxTurns` — Maximum conversation turns
- `maxToolCalls` — Maximum tool calls
- `temperature` — Model temperature
- `acceptance.level` — none, checked, or auto
- `acceptance.evidence` — Required evidence kinds (code-exists, tests-added)
- `acceptance.criteria` — Acceptance criteria
- `acceptance.verify` — Verification steps
- `acceptance.review` — Review configuration

## When to Use Each Tool

**Use `subagent` when:**
- Delegating a single task to a specialized agent
- Running a few agents in parallel (2-5)
- You need quick, one-off delegation

**Use `workflow` when:**
- Orchestrating multiple agents with conditional logic
- Running 5+ agents with complex dependencies
- You need deterministic, repeatable multi-step processes
- You want progress tracking with phases

## Examples

### Single Subagent
```
subagent(tasks=[{"agent": "researcher", "task": "Analyze the authentication module for security issues"}], mode="single")
```

### Parallel Subagents
```
subagent(tasks=[{"agent": "scout", "task": "Review auth"}, {"agent": "scout", "task": "Review payments"}, {"agent": "scout", "task": "Review API"}], mode="parallel")
```

### Workflow Script
```javascript
export const meta = { name: 'code_review', description: 'Multi-perspective code review' };

phase('Review');
const [auth, api, payments] = await parallel([
  () => agent('reviewer: Review auth module', { label: 'auth review' }),
  () => agent('reviewer: Review API module', { label: 'api review' }),
  () => agent('reviewer: Review payment module', { label: 'payment review' })
]);

phase('Synthesis');
const summary = await agent('worker: Combine review findings into a summary', { label: 'synthesis' });

return { reviews: [auth, api, payments], summary };
```

## Commands

- `/agents` — List all available subagents
- `/subagent <agent>: <task>` — Run a single subagent (slash command)
- `/subagent-parallel <agent>: <task1> | <agent>: <task2>` — Run parallel subagents
- `/workflow <script-name>` — Run a workflow from .pi/workflows/
