---
name: pi-workflow
description: Subagent delegation and dynamic workflow orchestration for pi. Spawn specialized agents with full frontmatter support, run parallel subagents, execute deterministic JS workflow scripts, and manage structured output with acceptance criteria.
---

# Pi Workflow Skill

This skill provides subagent delegation and dynamic workflow orchestration for pi.

## Setup

After installing the `pi-workflow` extension (via `pi install git:github.com/bejorock/pi-workflow`), create agent definition files and workflow scripts.

## Agent Files

Create agent markdown files in one of these locations:

- **User scope:** `~/.pi/agent/agents/*.md`
- **Project scope:** `.pi/agents/*.md`

### Agent Frontmatter

```markdown
---
model: google/gemini-2.5-pro       # Optional: model to use
tools: read, write, edit, bash      # Optional: tool allowlist (comma-separated or YAML list)
maxTurns: 10                        # Optional: max conversation turns
maxToolCalls: 30                    # Optional: max tool calls
temperature: 0.1                    # Optional: model temperature
acceptance:
  level: checked                    # none | checked | auto
  evidence:                         # Required evidence kinds
    - code-exists
    - tests-added
---

# Agent Name

Your instructions here. Be specific about the agent's role and responsibilities.
```

### Example Agents

**scout.md** — Lightweight exploration agent:
```markdown
---
model: google/gemini-2.5-flash
tools: read, grep, bash
maxTurns: 5
acceptance:
  level: none
---
# Scout

Find security issues and code smells. Keep responses concise.
```

**worker.md** — Code implementation agent:
```markdown
---
model: google/gemini-2.5-pro
tools: read, write, edit, bash, grep
maxTurns: 15
acceptance:
  level: checked
  evidence:
    - code-exists
    - tests-added
---
# Worker

Implement code changes. Write tests. Verify changes work.
```

## Commands

### List Agents
```
/agents
```
Lists all discovered agents from both user and project scopes.

### Run a Single Subagent
```
/subagent <agent-name>: <task description>
```
Example:
```
/subagent scout: Find security issues in the authentication module
```

### Run Parallel Subagents
```
/subagent-parallel <agent-name>: <task 1> | <agent-name>: <task 2> | ...
```
Example:
```
/subagent-parallel scout: Review auth module | scout: Review payment module
```

## Workflow Scripts

Create workflow scripts in `.pi/workflows/*.js`.

### Basic Workflow

```javascript
// .pi/workflows/security-audit.js
const findings = await agent('scout: Find security issues in the codebase');

if (findings.critical) {
  await agent('researcher: Investigate critical findings and provide remediation steps');
}

return { status: 'complete', findings };
```

### Run a Workflow

```
/workflow <script-name>
```
Example:
```
/workflow security-audit
```

### Workflow API

| Function | Description |
|----------|-------------|
| `agent('name: prompt')` | Spawn a named subagent with the given prompt |
| `await agent(...)` | Returns the subagent's structured output |
| `return { ... }` | Return final workflow result |

### Advanced Workflow Features

```javascript
// Parallel execution
const [a, b] = await Promise.all([
  agent('scout: Review auth'),
  agent('scout: Review payments')
]);

// Conditional branching
const findings = await agent('researcher: Analyze the codebase');
if (findings.issues.length > 5) {
  await agent('worker: Fix all critical issues');
}

// Structured output
return {
  summary: 'Security audit complete',
  issuesFound: findings.issues.length,
  criticalCount: findings.critical,
};
```

## Agent Frontmatter Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | string | auto | Model to use (e.g., `google/gemini-2.5-pro`) |
| `tools` | string/array | all | Tool allowlist (comma-separated or YAML list) |
| `maxTurns` | number | 10 | Maximum conversation turns |
| `maxToolCalls` | number | 30 | Maximum tool calls |
| `temperature` | number | 0.1 | Model temperature |
| `acceptance.level` | string | auto | Acceptance level: `none`, `checked`, `auto` |
| `acceptance.evidence` | array | [] | Required evidence kinds |
| `acceptance.criteria` | array | [] | Acceptance criteria |
| `acceptance.verify` | array | [] | Verification steps |
| `acceptance.review` | object | - | Review configuration |

## Testing

Run the test suite:
```bash
npm test
```

Run tests in watch mode:
```bash
npm run test:watch
```
