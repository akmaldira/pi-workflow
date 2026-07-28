# Workflow API Reference

## `agent(prompt)`

Spawns a subagent with the given prompt. The prompt should include the agent name followed by a colon and the task description.

### Syntax
```javascript
const result = await agent('agent-name: task description');
```

### Parameters
- `prompt` (string): Agent name and task. Format: `<agent-name>: <task description>`

### Returns
- Promise resolving to the subagent's structured output (parsed JSON if the agent produces JSON, otherwise the raw output string)

### Examples

```javascript
// Basic usage
const findings = await agent('scout: Find security issues');

// With conditional logic
const analysis = await agent('researcher: Analyze the authentication module');
if (analysis.criticalIssues > 0) {
  await agent('worker: Fix all critical security issues');
}

// Parallel execution
const [auth, payments] = await Promise.all([
  agent('scout: Review auth module'),
  agent('scout: Review payment module')
]);
```

## `return result`

Returns the final workflow result.

### Syntax
```javascript
return {
  summary: 'Workflow completed',
  data: { ... }
};
```

### Parameters
- `result` (any): Any JSON-serializable value

## Environment Variables

The following environment variables are available in workflow scripts:

| Variable | Description |
|----------|-------------|
| `PI_WORKFLOW_SCRIPT` | Path to the current workflow script |
| `PI_WORKFLOW_DIR` | Directory containing the workflow script |

## Error Handling

```javascript
try {
  const result = await agent('worker: Implement feature X');
  return { success: true, result };
} catch (error) {
  return { success: false, error: error.message };
}
```

## Deterministic Execution

Workflow scripts are executed in a deterministic JS sandbox:
- Only `agent()`, `Promise`, `JSON`, `Math`, and standard JS are available
- No filesystem access (use agents for file operations)
- No network access (use agents for web operations)
- Execution is single-threaded and sequential unless using `Promise.all`
