# Agent Frontmatter Reference

## Complete Attribute List

### Core Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | string | auto | Model identifier (e.g., `google/gemini-2.5-pro`, `openai/o3-mini`) |
| `tools` | string or array | all | Tool allowlist. Comma-separated string or YAML list. |
| `maxTurns` | number | 10 | Maximum conversation turns before forced completion. |
| `maxToolCalls` | number | 30 | Maximum tool calls before forced completion. |
| `temperature` | number | 0.1 | Model temperature (0.0 = deterministic, 1.0 = creative). |

### Acceptance Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `acceptance.level` | string | auto | Acceptance level: `none`, `checked`, `auto`. |
| `acceptance.evidence` | array | [] | Required evidence kinds: `code-exists`, `tests-added`, `output-exists`. |
| `acceptance.criteria` | array | [] | Acceptance criteria with `id`, `must`, `evidence`, `severity`. |
| `acceptance.verify` | array | [] | Verification steps with `tool`, `args`, `expect`. |
| `acceptance.review` | object | - | Review config: `agent`, `required`. |

### Advanced Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `output` | string | single | Output mode: `single`, `file-only`, `inline`. |
| `maxDepth` | number | 3 | Maximum subagent nesting depth. |
| `skills` | array | [] | Pi skills to load for the subagent. |
| `contextFiles` | array | - | Project context files to include. |
| `appendSystemPrompt` | string | - | Additional system prompt text. |

## Examples

### Minimal Agent
```yaml
---
model: google/gemini-2.5-flash
---
# Scout
Quickly explore and report findings.
```

### Full Agent
```yaml
---
model: google/gemini-2.5-pro
tools: read, write, edit, bash, grep
maxTurns: 15
maxToolCalls: 50
temperature: 0.1
output: single
maxDepth: 3
acceptance:
  level: checked
  evidence:
    - code-exists
    - tests-added
  criteria:
    - id: implementation
      must: Code implements the requested feature
      evidence:
        - code-exists
      severity: required
  verify:
    - tool: bash
      args: ["npm test"]
      expect: exit-code-0
  review:
    agent: reviewer
    required: true
---
# Worker
Implement code changes with tests.
```

### YAML List Format for Tools
```yaml
tools:
  - read
  - write
  - edit
  - bash
```

### Comma-Separated String Format
```yaml
tools: read, write, edit, bash
```
