# Graph-Based Agent Coordination: Design

Status: **built and shipped.** This document records the design and the reasoning behind it. Where
implementation diverged from the plan, the divergence and its cause are noted inline.

For usage, see the [README](../README.md). This document is for *why*, not *how*.

## 1. Vision

Replace the imperative workflow script (`agent()`/`parallel()`/`pipeline()` in a `vm` sandbox)
with a **graph-based coordination system** where agents are nodes, edges handle routing, and
shared state flowing through the graph IS the blackboard. The main pi agent composes a different
graph for each task — dynamic team assembly as code, not as configuration. Agents coordinate
*with each other* through the graph's routing, not through a central dispatcher.

**Why graph, not imperative script:** in the imperative model, agents are functions that return
strings and die — there's no coordination, just forward data flow. In the graph model, an agent's
output determines where the graph routes next via edge conditions. Green hitting a wall routes
back to architect through an edge, not through a messaging system. Coordination IS routing.

**Why code-based graph definition, not JSON:** real coordination routing depends on the specific
content of an agent's output, which is inherently unpredictable. Code edge conditions express
task-specific judgment; JSON conditions either pre-define every possibility (impossible) or fall
back to LLM routing for everything (expensive, less transparent). Code is more honest about what
routing actually IS.

## 2. What stays, what goes

### Scrapped (imperative workflow engine — 9 files)

```
extensions/workflow.ts              ← vm.createContext imperative runner (agent/parallel/pipeline)
extensions/workflow-tool.ts         ← imperative workflow tool definition
extensions/workflow-library.ts      ← saved imperative scripts
extensions/workflow-runner.ts       ← imperative run orchestration
extensions/workflow-display.ts      ← imperative display adapter
extensions/workflow-display-types.ts
extensions/workflow-ui.ts           ← /workflows TUI navigator (rebuilt for graphs)
extensions/workflow-mode.ts         ← /workflow on/off command (re-evaluated)
extensions/workflow-manager.ts      ← event hub (adapted for graph runs)
```

Their tests are scrapped or rewritten:
```
tests/workflow-*.test.ts  (7 files)
```

### Kept and reused (22 files — the agent spawning + production infrastructure)

```
extensions/agents.ts               ← agent discovery (extended with "builtin" source)
extensions/execution.ts            ← runSingleAgent() — graph nodes call this to spawn agents
extensions/pi-spawn.ts             ← CLI subprocess spawning
extensions/pi-args.ts              ← argument building for child pi processes
extensions/structured-output.ts    ← structured result decoding (graph state updates)
extensions/failure-classifier.ts   ← technical vs agent-level failure classification
extensions/artifacts.ts            ← per-run artifact storage (contract.md, transcripts, etc.)
extensions/journal.ts              ← JSONL journaling (adapted: journal per-node instead of per-agent-call)
extensions/journal-types.ts        ← journal record types (extended with node records)
extensions/acceptance.ts           ← acceptance levels (verification gates)
extensions/task-intent.ts          ← task mutation classification
extensions/completion-guard.ts     ← completion evaluation
extensions/fork-context.ts         ← compaction-style context inheritance
extensions/worktree.ts             ← git worktree isolation
extensions/tool-budget.ts          ← tool call budgets
extensions/turn-budget.ts          ← turn limits
extensions/model-fallback.ts       ← model failover
extensions/capability-ceiling.ts   ← tool/extension restrictions
extensions/child-transcript.ts     ← JSONL transcript streaming
extensions/jsonl-writer.ts         ← append-only JSONL writer
extensions/types.ts                ← shared types
extensions/utils.ts                ← shared utilities
```

The `subagent` tool (single/parallel delegation) **stays unchanged** — it's the simple case.
The graph-based `workflow` tool replaces the imperative one for coordination.

### New files

```
extensions/graph-dsl.ts             ← graph(), node(), edge(), agent(), human(), mainAgent(), END
extensions/graph-validator.ts       ← acorn AST validation + structural graph validation
extensions/graph-executor.ts        ← walks the graph, runs nodes, evaluates edges, manages state
extensions/graph-tool.ts            ← the workflow tool definition (graph-based)
extensions/graph-journal.ts         ← journaling adapted for graph node execution
extensions/graph-ui.ts              ← /workflows TUI navigator (rebuilt for graph runs)
extensions/agent-catalog.ts         ← bundled agent discovery + catalog visibility (list_agents tool)
bundled-agents/*.md                 ← pre-built agent definitions shipped with the package
```

## 3. The graph DSL

### Sandbox API (the ONLY globals available to a graph script)

| Global | Type | Purpose |
|---|---|---|
| `graph` | `() => GraphBuilder` | Creates a new graph builder |
| `agent` | `(name, promptFn) → NodeDef` | Defines an agent node (spawns a subagent) |
| `mainAgent` | `(prompt) → NodeDef` | Defines a main-agent checkpoint node |
| `human` | `(prompt, opts?) → NodeDef` | Defines a human-input node |
| `END` | `unique symbol` | Terminal target for edges |
| `args` | `unknown` | Initial arguments passed by the caller |
| `meta` | export | `{ name, description, whenToUse? }` — same header pattern as before |

**Nothing else.** No `fs`, `process`, `require`, `import`, `fetch`, `console`, `Date`, `Math`,
`Promise`, `JSON` (except `JSON` — harmless, needed for prompt construction from structured
results). The existing `assertDeterministicAst` pattern already bans `Date.now()`/`Math.random()`;
the graph validator extends this to ban everything except the graph API.

### Complete syntax

```js
export const meta = {
  name: "tdd_feature",
  description: "Plan → architect → red → green → review with escalation loops",
  whenToUse: "Multi-step feature implementation with TDD",
};

const g = graph();

// ── Nodes: only three types ──────────────────────────────────────────

// Agent node: spawns a subagent from the catalog
g.node("planner", agent("planner", (s) => `Create an implementation plan:\n${s.task}`));
g.node("architect", agent("architect", (s) => `Design interfaces for:\n${s.planner}`));
g.node("red", agent("red", (s) => `Write failing tests for:\n${s.architect}`));
g.node("green", agent("green", (s) => `Implement to pass:\n${s.red}\nContract:\n${s.architect}`));
g.node("reviewer", agent("reviewer", (s) => `Review:\n${s.green}`));

// Main-agent node: pauses graph, main pi agent weighs in
g.node("decide", mainAgent((s) =>
  `Tests are failing after revision. Current contract:\n${s.architect}\n\nGreen says:\n${s.green}\n\nShould we revise the contract or the tests?`
));

// Human node: pauses graph, asks the human
g.node("approve", human("Approve this implementation for merge?", {
  options: ["approve", "reject", "revise"],
}));

// ── Edges: direct or conditional ─────────────────────────────────────

g.start("planner");

// Direct: always route here
g.edge("planner", "architect");
g.edge("architect", "red");
g.edge("red", "green");

// Conditional: task-specific logic written by the main agent
// Receives (state, result). result is THIS node's output.
g.edge("green", (s, result) => {
  if (result.status === "blocked") {
    // Route back to whoever can resolve the blocker
    return result.blockedOn === "contract" ? "architect" : "red";
  }
  return "reviewer";
});

g.edge("reviewer", (s, result) => {
  if (result.approved) return "approve";
  if (result.needsContractChange) return "decide";  // escalate to main agent
  return "green";  // retry implementation
});

g.edge("approve", END);
g.edge("decide", "architect");  // after main agent decides, replan

// ── Run ──────────────────────────────────────────────────────────────
g.run({ task: args.task });
```

### What the main agent writes vs. what it doesn't

The main agent (the LLM you're chatting with) writes this entire script. It decides:
- Which agents to include (reads the catalog, picks the roles this task needs)
- What prompt each agent gets (computed from accumulated state)
- How edges route (task-specific conditional logic)

It does NOT write:
- Arbitrary computation, file access, network calls (sandbox prevents this)
- More than one graph per script (validator enforces this)
- Anything outside the node/edge/meta API (AST validation enforces this)

### Why edge conditions are code, not JSON

The edge `(s, result) => result.status === "blocked" && result.reason.includes("interface") ? "architect" : "reviewer"` is a judgment call about the *specific content* of green's output. JSON conditions can't express "check if the reason mentions interfaces" without either enumerating every possible reason (impossible) or calling an LLM to evaluate (expensive). Code edge conditions are transparent, deterministic, and task-specific — exactly what real coordination needs.

## 4. Node types (detailed)

### `agent(name, promptFn)` — subagent node

Spawns a subagent from the discovered catalog (bundled + user + project agents). The prompt
function receives the current state and returns the prompt string. The agent runs to completion
(via existing `runSingleAgent()`), and its result is stored in `state[nodeId]`.

- `name`: must match a discovered agent name (validated at execution time; if not found, the
  executor feeds the error back as the node's result so a conditional edge can route to a
  correction path, rather than crashing the run)
- `promptFn`: `(state) => string` — pure function, no side effects
- Result: the agent's text output, OR a structured-output object if the agent uses `outputSchema`
- State update: `state[nodeId] = result` (automatic; later nodes reference it as `s.nodeId`)

Agent frontmatter attributes (model, tools, thinking, acceptance, turnBudget, etc.) are applied
from the discovered agent config — same as today's `subagent` tool.

### `mainAgent(promptFn)` — main-agent checkpoint

Pauses the graph and sends a message to the main pi agent (the one you're chatting with). The
main agent sees the message + the current graph state, responds, and the graph resumes with the
response stored in `state[nodeId]`.

- This is how the main agent stays involved mid-run without being a central dispatcher
- Implementation: the graph executor signals the parent session (via the existing tool-update
  mechanism), the main agent's next turn includes the checkpoint message, and the response is
  fed back as the node's result
- In headless mode (`ctx.hasUI === false`): the checkpoint is logged and skipped (returns a
  caller-provided default), same degrade pattern as `askHuman` — never hangs

### `human(prompt, opts?)` — human input

Pauses the graph and asks the human for input via `ctx.ui` (confirm/select/input — the same UI
methods already used throughout the extension).

- `prompt`: the question or approval request
- `opts.options`: optional array for select-style choices
- `opts.default`: default answer in headless mode (never hangs)
- Result: the human's response, stored in `state[nodeId]`

## 5. Edge types (detailed)

### Direct edge

```js
g.edge("planner", "architect");  // after planner, always go to architect
g.edge("approve", END);           // after approve, graph is done
```

### Conditional edge

```js
g.edge("green", (state, result) => {
  // Pure function: reads state + this node's result, returns next node name
  if (result.status === "blocked") return result.blockedOn === "contract" ? "architect" : "red";
  return "reviewer";
});
```

The condition function receives:
- `state`: the full accumulated state (every previous node's result is at `state[nodeId]`)
- `result`: the current node's output (same as `state[currentNodeId]`, passed separately for
  convenience)

It returns either:
- A node name string (must match a defined node)
- `END` (terminate the graph)

If the returned node name doesn't exist, the executor treats it as an error result and re-runs
the edge (the condition function sees `{ error: "unknown node 'foo'" }` in the result on the
next pass) — self-correcting, not crashing.

### Parallel fan-out (Phase 2 — not in initial build)

```js
g.edge("research", ["search_auth", "search_db", "search_api"]);  // fan out
g.edge(["search_auth", "search_db", "search_api"], "synthesize"); // join (wait for all)
```

Deferred to a later phase — initial build is sequential nodes with conditional routing, which
covers the coordination use case. Fan-out adds join semantics and partial-failure handling that
aren't needed for v1.

## 6. State model (the blackboard)

State is a plain JS object that flows through the graph. It IS the shared blackboard — no
separate IPC mechanism, no message queue, no file-based messaging.

```js
// After planner runs:
state = {
  task: "implement user auth",
  planner: "1. Add User model\n2. Add auth middleware\n3. ...",  // auto-populated
}

// After architect runs:
state = {
  task: "implement user auth",
  planner: "1. Add User model\n...",
  architect: "interface UserRepo { findById(id: string): Promise<User> ... }",  // auto-populated
}

// After green runs (with structured output):
state = {
  task: "implement user auth",
  planner: "...",
  architect: "...",
  red: "...",
  green: { status: "blocked", blockedOn: "contract", reason: "UserRepo can't express soft-deletes", proposedFix: "Add deletedAt to User type" },
}
```

- Every node automatically writes its result to `state[nodeId]`
- Every node's prompt function reads any previous node's result via `state.nodeId`
- Edge condition functions read the full state
- The initial state comes from `g.run({ ...initialState })`
- The final state is the graph's return value

**This is what "coordination between agents" means concretely:** architect sees what planner
produced, green sees what architect produced, and when green's output includes a blocker, the
edge routes back to architect who sees green's blocker in state on its next run. No messaging
system — just state flowing through the graph.

## 7. Validation strategy (before any agent spawns)

Three layers, all checked before the graph executor starts:

### Layer 1: AST validation (acorn parse + validate)

Same proven pattern as the existing `workflow.ts`:

```ts
// graph-validator.ts
function validateGraphAst(ast: Node): ValidationError[] {
  const errors: ValidationError[] = [];
  const ALLOWED_GLOBALS = new Set(["graph", "agent", "mainAgent", "human", "END", "args", "meta", "JSON"]);

  walkAst(ast, (node) => {
    // Ban: require, import, member access on forbidden globals
    if (isCallTo(node, "require")) errors.push({ msg: "require() is not allowed" });
    if (isImportStatement(node)) errors.push({ msg: "import is not allowed" });

    // Ban: Date.now(), Math.random(), new Date() (existing pattern)
    if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node))
      errors.push({ msg: "Non-deterministic operations are not allowed" });

    // Enforce: only allowed identifiers as callee/object
    if (isIdentifier(node) && !ALLOWED_GLOBALS.has(node.name) && !isLocalVariable(node))
      errors.push({ msg: `Identifier '${node.name}' is not available in the graph sandbox` });
  });

  return errors;
}
```

### Layer 2: Sandbox isolation (vm.createContext)

```ts
const sandbox = vm.createContext({
  graph: createGraphBuilder,
  agent: createAgentNodeDef,
  mainAgent: createMainAgentNodeDef,
  human: createHumanNodeDef,
  END: GRAPH_END,
  args: runArgs,
  JSON,  // harmless, needed for prompt construction
});
// That's IT. No fs, process, require, fetch, console, Date, Math, Promise.
```

Edge condition functions and prompt functions run inside this sandbox. They can use JS language
features (operators, property access, string/array methods, if/else, loops) but no global APIs
beyond what's explicitly provided. Side effects are impossible.

### Layer 3: Structural validation (after the script builds the graph, before execution)

```ts
function validateGraphStructure(graph: BuiltGraph): ValidationError[] {
  const errors: ValidationError[] = [];

  // Exactly one graph per script
  // (enforced by the builder — second graph() call throws)

  // Entry node exists
  if (!graph.nodes.has(graph.entry)) errors.push({ msg: "Entry node not defined" });

  // Every edge source is a defined node
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from)) errors.push({ msg: `Edge from unknown node '${edge.from}'` });
    if (edge.to !== END && !graph.nodes.has(edge.to)) errors.push({ msg: `Edge to unknown node '${edge.to}'` });
  }

  // Termination: at least one path reaches END (simple reachability check)
  if (!canReachEnd(graph)) errors.push({ msg: "No path to END from entry node" });

  return errors;
}
```

If any layer fails, the tool returns a validation error to the main agent **before any agent is
spawned** — no wasted tokens, no partial runs.

## 8. Graph executor

```ts
// graph-executor.ts
export async function runGraph(
  graph: ValidatedGraph,
  initialState: Record<string, unknown>,
  options: GraphRunOptions,
): Promise<GraphRunResult> {
  const state = { ...initialState };
  let currentNode = graph.entry;
  let iterations = 0;
  const MAX_ITERATIONS = options.maxIterations ?? 25;

  while (currentNode !== END) {
    if (++iterations > MAX_ITERATIONS)
      throw new Error(`Graph exceeded max iterations (${MAX_ITERATIONS}) — possible infinite loop`);

    const node = graph.nodes.get(currentNode);
    const nodeResult = await executeNode(node, state, options);

    // Auto-populate state: state[nodeId] = result
    state[currentNode] = nodeResult;

    // Journal the node execution (for resume)
    options.journal?.recordNode({ nodeId: currentNode, result: nodeResult, ... });

    // Evaluate outgoing edge
    const edge = graph.outgoingEdges.get(currentNode);
    currentNode = evaluateEdge(edge, state, nodeResult);
  }

  return { state, iterations, ... };
}
```

### `executeNode` — runs a node based on its type

```ts
async function executeNode(node: NodeDef, state: State, options: GraphRunOptions): Promise<unknown> {
  switch (node.type) {
    case "agent": {
      const prompt = node.promptFn(state);
      const agentConfig = await resolveAgent(node.agentName, options.cwd);
      const result = await runSingleAgent(options.cwd, agentConfig, prompt, {
        signal: options.signal,
        runId: options.runId,
        context: agentConfig.defaultContext ?? "fork",
        forkContext: options.forkContext,
        // ... same options as today's subagent spawning
      });
      // Result is either a string (text output) or an object (structured output)
      return decodeResult(result, agentConfig);
    }
    case "mainAgent": {
      const prompt = node.promptFn(state);
      return await checkpointToMainAgent(prompt, state, options);
    }
    case "human": {
      return await askHumanViaUi(node.prompt, node.options, options);
    }
  }
}
```

### `evaluateEdge` — routes to the next node

```ts
function evaluateEdge(edge: Edge, state: State, result: unknown): string {
  if (edge.type === "direct") return edge.to;

  // Conditional: run the condition function in the sandbox
  const target = edge.conditionFn(state, result);

  // Validate the returned target
  if (target === END) return END;
  if (typeof target === "string") return target;

  // Invalid return — treat as error, feed back for self-correction
  return "__error__";  // special node that re-runs the edge with an error result
}
```

### Reused infrastructure (plugged into the executor)

- **Journaling** (`journal.ts` adapted): each node execution journaled as a JSONL record. On
  resume, completed nodes are skipped (result loaded from journal).
- **Budget tracking**: tokens accumulated across all node executions. Warnings at 80%/100%.
- **Artifacts** (`artifacts.ts`): each agent node's input/output/transcript stored per-run.
- **Worktree isolation** (`worktree.ts`): graph runs can use worktrees.
- **Fork context** (`fork-context.ts`): agents spawned by nodes inherit fork context.
- **Error handling** (`failure-classifier.ts`): `TechnicalFailureError` aborts the graph (same
  as today). Agent-level errors are just results, routed by edges.
- **Acceptance** (`acceptance.ts`): agent nodes can specify acceptance levels.

## 9. Bundled agent catalog

Ships with the package using nicobailon/pi-subagents' proven pattern (live discovery from the
installed package, not scaffold-copy):

```ts
// extensions/agents.ts — addition
const BUNDLED_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "bundled-agents"
);
// Loaded as source: "builtin", lowest merge precedence
// (user/project agents with the same name shadow them)
```

`package.json` gets `"bundled-agents/"` in its `files` array.

### Bundled roles

| Agent | Role | Tools |
|---|---|---|
| `planner` | Decomposes task into plan; read-only | `read`, `grep`, `find`, `ls` |
| `architect` | Designs interfaces/contracts | `read`, `grep`, `find`, `ls` |
| `monitor` | Independent plan-feasibility review | `read`, `grep`, `find`, `ls` |
| `red` | Writes failing tests | `read`, `write`, `bash` |
| `green` | Implements to pass tests | `read`, `write`, `edit`, `bash` |
| `reviewer` | Independent code review | `read`, `grep`, `find`, `ls` |
| `researcher` | Read-only investigation | `read`, `grep`, `find`, `ls`, `bash` |
| `scout` | Quick codebase reconnaissance | `read`, `grep`, `find`, `ls` |
| `worker` | General implementation | `read`, `write`, `edit`, `bash`, `grep` |

Teams override/disable any of them via settings (`{ agents: { <name>: { disabled: true } } }`)
or shadow with a same-named project/user agent.

### Catalog visibility

The `workflow` tool's `promptGuidelines` include a roster summary (name + description per
discovered agent), refreshed at `session_start`. A `list_agents` tool provides on-demand catalog
access. This ensures the main agent knows what roles exist when composing a graph.

## 10. Dynamic team composition by the main agent

This is how "different task, different team" works:

1. **User gives the main agent a task** (e.g., "add OAuth to the API")
2. **Main agent analyzes the task** — its own reasoning, reading the agent catalog
3. **Main agent writes a graph-definition script** — selects only the roles this task needs,
   writes task-specific edge logic, picks where human/main-agent checkpoints go
4. **Main agent calls the `workflow` tool** with the script + initial args
5. **Tool validates** (AST + structural — before any agent spawns)
6. **Graph executor runs** — agents coordinate via routing + shared state
7. **Human/main-agent nodes pause** for input as the graph reaches them
8. **Graph terminates at END**, returns final state

For a different task ("fix this typo"), the main agent writes a one-node graph:
```js
export const meta = { name: "typo_fix", description: "Fix a typo" };
const g = graph();
g.node("fix", agent("worker", (s) => `Fix this typo: ${s.task}`));
g.start("fix");
g.edge("fix", END);
g.run({ task: args.task });
```

For a complex task, it writes a multi-node graph with conditional loops, escalation edges, and
human checkpoints. Same tool, same engine, different graph — dynamic team assembly as code.

### Can graphs be saved and reused?

Yes — same `saveWorkflow`/`loadWorkflow` pattern as today, adapted for graph scripts. A
reusable TDD graph can be saved and loaded with `loadWorkflow: "tdd_feature"`. The `/workflows`
TUI navigator lists saved graphs and shows live runs.

## 11. Human-in-the-loop

Two mechanisms, both pi-native (no Slack, no webhooks, no external services):

1. **`human()` nodes** — the graph explicitly includes a human checkpoint. The executor pauses,
   surfaces the prompt via `ctx.ui.confirm`/`select`/`input`, and resumes with the response. In
   headless mode: returns the `default` option, logs the question, never hangs.

2. **`mainAgent()` nodes** — the graph pauses for the main pi agent's judgment. The main agent
   sees the checkpoint message + current state, responds, graph resumes. This is how the human
   *indirectly* participates — by instructing the main agent, who is a node in the graph.

## 12. Persistence & resume

The graph executor journals every node execution to a JSONL file (adapting `journal.ts`):

```jsonl
{"type":"graph_run","runId":"...","scriptHash":"...","name":"tdd_feature","startedAt":...}
{"type":"node","seq":1,"nodeId":"planner","agentName":"planner","result":"...","tokens":1234,"durationMs":5678}
{"type":"node","seq":2,"nodeId":"architect","agentName":"architect","result":"...","tokens":2345,"durationMs":3456}
{"type":"node","seq":3,"nodeId":"green","agentName":"green","result":{"status":"blocked",...},"tokens":3456,"durationMs":6789}
```

On resume (`resumeRunId`):
- Script hash validated (if the graph script was edited, cache is invalidated)
- Completed nodes are skipped (result loaded from journal)
- Execution resumes from the last incomplete node
- State is reconstructed from the journal

## 13. The `workflow` tool (replaced)

```ts
// graph-tool.ts
export function createGraphWorkflowTool(options: WorkflowToolOptionsFull): ToolDefinition {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Execute a graph-based workflow that coordinates multiple agents. " +
      "Define nodes (agent/mainAgent/human) and edges (direct or conditional). " +
      "Agents coordinate through routing and shared state. " +
      "The main agent composes a different graph for each task.",
    parameters: Type.Object({
      script: Type.String({
        description:
          "Graph workflow script. Required header: export const meta = { name, description }. " +
          "Use graph() to create a graph, g.node() to define nodes, g.edge() for routing, g.run() to start. " +
          "Available node types: agent(name, promptFn), mainAgent(promptFn), human(prompt, opts?). " +
          "Available globals: graph, agent, mainAgent, human, END, args, JSON. Nothing else.",
      }),
      args: Type.Optional(Type.Any()),
      // ... maxIterations, tokenBudget, journalDir, resumeRunId, loadWorkflow, saveWorkflow
    }),
    // ... execute: validate → run graph → return final state
  });
}
```

The `subagent` tool stays unchanged alongside it for simple single/parallel delegation.

## 14. What was built

All six phases shipped. The module layout ended up slightly larger than planned, because two
concerns turned out to deserve their own files:

| Module | Role |
|---|---|
| `graph-dsl.ts` | Builder API and structural validation |
| `graph-validator.ts` | AST allowlist, sandbox, meta extraction |
| `graph-executor.ts` | The walk: run node, store result, evaluate edge |
| `graph-node-runner.ts` | Spawning and escalation parsing *(not planned separately)* |
| `graph-journal.ts` | Per-visit JSONL records and resume |
| `graph-run-context.ts` | Budget, artifacts, worktree |
| `graph-interactive.ts` | `human()` and `mainAgent()` handlers *(not planned separately)* |
| `graph-display-bridge.ts` | Graph walk → display model *(not planned separately)* |
| `graph-tool.ts` | The `workflow` tool |
| `agent-catalog.ts` | Roster visibility and `list_agents` |
| `agent-settings.ts` | Builtin override and disable |

`graph-node-runner.ts` exists because routing and spawning are genuinely separate concerns: the
executor knows nothing about agents, and the runner knows nothing about routing. They meet at one
function signature, which is what made the executor testable with scripted results.

`graph-display-bridge.ts` exists because the display model predates graphs and thinks in runs
containing numbered agents. Mapping a cyclic walk onto it is a real translation, not a pass-through.

### Divergences from the plan

**Resume turned out to be easy, not hard.** It had been deferred as needing a redesign, because the
imperative journal keyed its cache on `hash(prompt + options)` — and a prompt built from earlier
results changes its own key whenever anything upstream changes. A graph walk is an ordered sequence
of node executions with stable ids, so "what already ran" needs no heuristic. The feature fell out
of the data model rather than requiring one.

**Structured output was not needed.** The plan assumed agents would need `outputSchema` to produce
routable results. In practice, parsing a text protocol (`STATUS: blocked` / `BLOCKED_ON: x`) was
sufficient and much cheaper: no schema plumbing, no validation failures mid-run, and an agent that
wraps the block in prose still parses correctly.

**Agent results needed a `toString()`.** Prompt functions interpolate previous results
(`` `Implement:\n${s.architect}` ``), and a structured result renders as `[object Object]` — a
well-formed prompt containing nothing. Results carry a non-enumerable `toString()` returning the
agent's text, so prompts get text and edge conditions get fields. This had to be re-applied at the
journal boundary too, since `JSON.parse` on resume produces plain objects.

**Human answers needed provenance, not just a value.** A handler that resolves a default internally
and returns a bare string erases the difference between "the human chose hold" and "nobody was
watching, so hold was assumed". An edge reading the second as approval converts absence into
consent — the same class of failure as an agent mocking a test to show green. Handlers report
`{ answer, source }`, and node results carry `status: "ok" | "default" | "skipped"`.

**Tool failures must throw.** pi's agent loop derives a tool call's error status from whether
`execute()` threw; a returned `isError` field is never read. Returning one reported validation
failures to the model as *successes* whose text happened to describe a failure.

## 15. Testing

917 tests across 41 files. The counts matter less than what the suite is arranged to prove.

| Test file | Tests | What it establishes |
|---|---|---|
| `graph-validator.test.ts` | 55 | Allowlist, determinism, meta extraction, structural checks |
| `graph-sandbox-escape.test.ts` | 47 | Adversarial: 11 routes to a function constructor, 7 prototype routes, 16 ambient-authority names |
| `graph-dsl.test.ts` | 43 | Builder semantics, id validation, every `validate()` failure mode |
| `graph-executor.test.ts` | 40 | Traversal, routing, termination, cancellation, observability |
| `graph-node-runner.test.ts` | 36 | Escalation parsing, resolution, technical-vs-agent failure split |
| `graph-journal.test.ts` | 34 | Per-visit records, replay, all resume paths |
| `graph-run-context.test.ts` | 27 | Budget semantics, artifact config, worktree degradation |
| `graph-tool.test.ts` | 27 | Validation-before-spawn, reporting, save/load |
| `graph-interactive.test.ts` | 26 | Both dialog types, dismissal, headless non-hanging |
| `graph-display-bridge.test.ts` | 14 | Per-visit entries, preview cleanup, escalation-first |
| `graph-e2e-escalation.test.ts` | 13 | **The premise, end to end** |

### The tests that matter

`graph-e2e-escalation.test.ts` runs the real tool — real validation, sandbox, parsing, executor,
journal, display. Only the subprocess spawn is stubbed, because the point is to script what agents
*say*, not to test a model. It asserts:

- the walk loops (`architect → red → green → architect → red → green → reviewer`)
- the retrying implementer is prompted with the **revised** contract, not the original
- `BLOCKED_ON` decides *who* gets asked: `tests` routes to red, `contract` routes to architect
- an unresolved blocker stops at the cap rather than spinning

Disabling escalation parsing fails 8 of its 13 tests. That check matters: a test that passes whether
or not the mechanism works proves nothing.

`graph-sandbox-escape.test.ts` exists because 55 validator tests passed against a build that leaked
host intrinsics into the sandbox — `Object.prototype.__pwned = 42` inside a "sandboxed" script set
`__pwned` on the host's own objects. The unit tests asserted that the things we thought of were
blocked; they could say nothing about the things we did not think of.

### What repeatedly caught real defects

Not re-running the suite. Changing the *method*:

| Method | Found |
|---|---|
| Live pi session | `list_agents` returned its payload in a field pi never forwards |
| Adversarial probes | host prototype pollution through injected intrinsics |
| End-to-end test | `[object Object]` in every multi-step prompt |
| Resume test | the same bug on the replay path |
| Typechecking | `isError` is never read; failures reported as successes |
| Reading `index.ts` | `/workflows` permanently empty after the tool swap |
| Live TUI | a dead `(no phase)` level on every graph run |

The common root cause was verifying a *model of the system* rather than the system. Tests asserted
`output` where pi reads `content`; a spy that never bound to the module's own `fs`. Every fix is now
confirmed by reverting it and watching tests fail.

## 16. What this design deliberately does NOT include

- **No external frameworks.** No LangGraph, no LangChain, no XState (for now), no CrewAI. The
  graph executor is ~200 lines of our own code, designed for spawning pi subprocesses.
- **No persistent actors or mailboxes.** Agents are spawned when a node executes, run to
  completion, and their result goes into state. No idle agents watching for events. (Phase 8,
  deferred.)
- **No synchronous war rooms.** Multi-agent real-time conversation is not supported. Round-robin
  re-spawning could approximate it but is not in the initial build.
- **No on-the-fly agent synthesis.** The graph can only route to agents that exist in the
  catalog. Inventing new roles mid-run is Phase 8.
- **No Slack/webhook/external notification.** Human-in-the-loop is pi-native (`ctx.ui`) only.
- **No JSON-based graph definition.** Graphs are code (constrained DSL), not data — because
  real coordination routing is task-specific logic, not predictable configuration.
