# Parallel Fan-Out: Option B — `parallel()` Composite Node

**Status:** ❌ **NOT PURSUED — superseded by Option A.**

Option A (true multi-edge graph with a superstep executor) was implemented
instead; see `docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md`, which is the design of
record. Fan-out is now expressed by giving a node several outgoing edges
rather than by a `parallel()` composite node, so the API below does not exist.

This document is kept only as a record of the alternative that was weighed:
Option B preserved the one-edge-per-node invariant at the cost of making
parallelism a special node type, and it could not give branches independent
routing — which is what escalation from inside a branch requires.

## Goal

Allow a workflow graph to run multiple agents concurrently — e.g.
`scout -> (researcherA | researcherB) -> planner` — without restructuring the
existing single-edge-per-node execution model.

## The approach in one sentence

Add a new node type, `parallel(...)`, that the executor treats as **one node,
one step**, but whose body runs N branches concurrently via host-side
`Promise.all`. The composite result is stored under the node's id and flows
into the next edge exactly like any other node's result.

## Why this is the safe bet

The entire graph subsystem — executor, journal, resume, budget, display
bridge, escalation parsing — is built on one invariant:

> One node → one edge → one next node. `state[nodeId] = result` (overwrite).
> The walk is an ordered sequence of steps.

Option B preserves that invariant. A parallel node is still one step. Nothing
that reads `graph.edges.get(nodeId)` (a single `Edge`) needs to change. Compare
Option A, which must turn `Map<string, Edge>` into `Map<string, Edge[]>` and
redefine what a "step" means — see the gap analysis.

This is also honest to the project's stated philosophy: a minimal custom
executor, not a LangGraph/Pregel reimplementation. We're extending our own
small model, not importing supersteps and reducers.

---

## DSL surface

### New factory

```js
export const meta = {
  name: 'parallel_research',
  description: 'Scout, then two researchers in parallel, then planner'
};
const g = graph();

g.node('scout', agent('scout', (s) => `Locate files for: ${args.task}`));

g.node('research', parallel({
  researcherA: agent('researcher', (s) => `Deep-dive auth area. Scout notes:\n${s.scout}`),
  researcherB: agent('researcher', (s) => `Deep-dive API area. Scout notes:\n${s.scout}`),
}));

g.node('planner', agent('planner', (s) =>
  `Synthesize a plan from both analyses:\nA:\n${s.research.branches.researcherA.text}\nB:\n${s.research.branches.researcherB.text}`));

g.edge('scout', 'research');
g.edge('research', 'planner');
g.edge('planner', END);
g.run({ task: args.task });
```

### Type changes (`graph-dsl.ts`)

```ts
export interface ParallelBranchDef {
  agentName: string;
  promptFn: PromptFn;
}

export interface ParallelNodeDef {
  type: "parallel";
  /** Named branches. Order preserved for display. */
  branches: Record<string, ParallelBranchDef>;
}

// NodeDef union gains a member:
export type NodeDef =
  | AgentNodeDef
  | MainAgentNodeDef
  | HumanNodeDef
  | ParallelNodeDef;        // NEW

export function parallel(
  branches: Record<string, ParallelBranchDef>
): ParallelNodeDef { /* validate non-empty, valid branch keys, return def */ }
```

**Constraints enforced in `parallel()`:**
- At least one branch.
- Branch keys are valid node-id-style identifiers (reused `assertValidNodeId`).
- Each branch is an `agent(...)` def (not `human`/`mainAgent`/nested `parallel`
  in v1 — see "Out of scope" below).

### Structural validation (`GraphBuilder.validate`)

Existing checks that need a new branch:
- "Every node has an outgoing edge" — already key-agnostic, works as-is.
- "Edge target exists" — already works.
- **NEW:** recurse into a parallel node's branches and validate each is a
  well-formed `AgentNodeDef` (has `agentName`, `promptFn` is a function).
- **NEW:** branch keys must not collide with node ids in the same graph
  (they're not nodes, but exposing them in `state.research.branches.X`
  means a node id equal to a branch key would be confusing — reject it early).

No change to the reachability/END-reachability logic: a parallel node has
exactly one outgoing edge like every other node, so the existing direct-edge
reachability walk still works.

### Sandbox (`graph-validator.ts`)

Add `"parallel"` to the sandbox globals object (one line, next to `agent`).
The AST validator's identifier allowlist gets `parallel` added.

**No async/await concerns.** The script still never executes anything —
`parallel({...})` is a synchronous factory returning a plain object, exactly
like `agent()` and `human()`. The 1-second sandbox timeout is unaffected.

---

## Executor (`graph-executor.ts`)

The `runNode` injection already abstracts "how a node runs." The executor's
walk loop is untouched. The change is inside `graph-node-runner.ts`'s
`createNodeRunner`, which dispatches on `node.def.type`:

```ts
async function runNode(node, state, ctx): Promise<NodeRunOutcome> {
  switch (node.def.type) {
    case "agent":     return runAgentNode(node, node.def.agentName, buildPrompt(...), ctx.signal);
    case "human":     return runHumanNode(...);
    case "mainAgent": return runMainAgentNode(...);
    case "parallel":  return runParallelNode(node, state, ctx);   // NEW
  }
}
```

### `runParallelNode`

```ts
async function runParallelNode(node, state, ctx): Promise<NodeRunOutcome> {
  const def = node.def as ParallelNodeDef;
  const entries = Object.entries(def.branches);

  const branchResults = await mapWithConcurrencyLimit(
    entries,
    MAX_BRANCH_CONCURRENCY,          // reuse the existing cap pattern from index.ts
    async ([name, branch]) => {
      // Each branch resolves its own agent (with escalation injection),
      // builds its prompt from the SAME state, and spawns.
      const resolved = resolveGraphAgent(branch.agentName, options.cwd, { agentScope });
      if (!resolved.agent) {
        return { name, error: resolved.error, technicalFailure: true };
      }
      const single = await spawnAgent(options.cwd, withEscalationProtocol(resolved.agent),
        branch.promptFn(state), { runId, index: nextSpawnIndex(), signal, ... });
      return { name, result: parseAgentResult(textOf(single), branch.agentName), single };
    },
  );

  // Roll up into one composite result.
  const branches: Record<string, AgentNodeResult> = {};
  let anyBlocked = false;
  let anyTechnical = false;
  let firstError: string | undefined;
  let totalTokens = 0;
  for (const b of branchResults) {
    branches[b.name] = b.result;
    if (b.result.status === "blocked") anyBlocked = true;
    if (b.technicalFailure) { anyTechnical = true; if (!firstError) firstError = b.error; }
    totalTokens += b.single?.usage?.totalTokens ?? 0;
  }

  const composite: ParallelNodeResult = {
    status: anyTechnical ? "error"
          : anyBlocked   ? "blocked"
          :                 "ok",
    branches,
  };

  return {
    result: composite,
    tokens: totalTokens,
    technicalFailure: anyTechnical,   // aborts the graph (matches existing policy)
    error: firstError,
  };
}
```

**Key decisions, made explicit:**

1. **All branches read the same `state` snapshot.** They do not see each
   other's in-progress results — there is no shared-key write race because the
   composite result is assembled by our code after all branches finish, not
   by two nodes racing to write `state.foo`. This is the property that lets us
   skip LangGraph's reducer concept entirely.

2. **`technicalFailure` if any branch crashes** (spawn error, bad config).
   This matches the existing policy: a technical failure aborts the graph;
   an agent-level failure (a branch reporting `blocked`) is a normal result the
   edge routes on. We do not abort the whole fan-out because one branch
   escalated — that would discard the work the other branches already paid
   for.

3. **`status` roll-up is a convenience.** The edge sees `result.branches` for
   full fidelity and `result.status` for the common case. This matches the
   project's stance that edges own coordination policy.

### Result type (`graph-node-runner.ts`)

```ts
export interface ParallelNodeResult {
  status: "ok" | "blocked" | "error";
  branches: Record<string, AgentNodeResult>;  // each has {status, blockedOn, text, ...}
}
```

### Edge condition example (routing after fan-out)

```js
g.edge('research', (state, result) => {
  // result is the ParallelNodeResult
  if (result.status === 'error') return END;          // technical — already aborts, defensive
  if (result.status === 'blocked') {
    // Route to whoever owns the first blocker, or to a human
    const blocked = Object.entries(result.branches).find(([,b]) => b.status === 'blocked');
    if (blocked[1].blockedOn === 'information') return 'human';
    return 'planner';  // let planner see the partial results
  }
  return 'planner';
});
```

---

## Journal & resume (`graph-journal.ts`)

**Decision: the parallel node is one atomic step.**

A `node` journal record is written once, after all branches complete, with
the composite `result`. The per-branch `AgentNodeResult`s live inside that one
record's `result.branches`.

**Why atomic, not per-branch:** the existing resume model is a *replay of an
ordered sequence of steps*. If branches were separate sub-steps, a crash
mid-fan-out creates a partial-completion problem: which branches re-run? The
existing model's honesty is that it re-runs a whole node rather than resuming
mid-agent. A parallel node is one node; if it didn't fully complete and get
journaled, the whole thing re-runs on resume. Simpler, and consistent.

**No journal schema change.** The `GraphJournalNodeRecord.result` is typed
`unknown` already; a composite object fits. The only addition is
`nodeType: "parallel"` in the discriminated union.

Resume: `rehydrateState` already does `state[nodeId] = record.result` — works
unchanged for a composite result.

---

## Worktree isolation (`graph-run-context.ts` + `worktree.ts`)

**This is the sharpest edge. Read it twice before implementing.**

Today: `createWorktree(cwd, runId, 0)` — the **entire graph run shares one
worktree** (`index: 0` hardcoded). If `researcherA` and `researcherB` both have
write tools and run concurrently against that same directory, you get exactly
the clobbering race worktree isolation exists to prevent — just relocated.

**Phase 1 (v1, read-only branches):** require parallel branches to be
read-only agents. Validate at graph-build time that every branch agent's
`tools` allowlist contains no write/edit/bash-mutating tools (reuse the
existing `tools` frontmatter). Reject a parallel node whose branches can
write. This sidesteps the merge problem entirely and covers the motivating
use case (parallel research/scout).

**Phase 2 (v2, write-capable branches):** one worktree per branch, using the
already-present `index` parameter (`createWorktree(cwd, runId, branchIndex)`).
The plumbing half-exists; what's missing is the policy: two branches produce
two diffs against the same base. Options for reconciliation:
- (a) Auto-merge the patches. Fragile; conflicts abort the graph.
- (b) Hand both patches to the downstream node and let it decide (e.g.
  `planner` reads both and picks/composes). Honest, pushes complexity to the
  graph author. **Recommended.**
- (c) Sequentialize write branches (defeats the point).

Recommendation: ship Phase 1 only. Document the constraint. Defer Phase 2
until a real user hits it — the read-only case is the common one and the
write case has an unresolved design question that shouldn't be guessed at.

---

## Display bridge (`graph-display-bridge.ts`)

Current: `activeIds: Map<number, number>` — one display agent per step.

Change to `Map<number, Map<string, number>>` — keyed by `(step, branchName)`.
- `nodeStarted` for a parallel node calls `markAgentStart` once per branch,
  labeling each `${nodeId}/${branchName} (${agentName})`.
- `nodeCompleted` marks each branch's display agent.
- A parallel node that's resumed (already journaled) produces no new display
  entries — same as today's agent nodes.

The underlying `WorkflowManager` already supports multiple simultaneous
agents in its `agents` array (the `subagent` tool's parallel mode already
relies on this). No manager change needed.

---

## Budget, depth guard, escalation

- **Budget:** `BudgetTracker.record()` is a counter; concurrent `await`
  continuations are still serialized by the JS event loop (single-threaded).
  Each branch calls `context.recordNode` (or the runner aggregates tokens —
  one decision point; recommend aggregating into one `node` record). No
  threading concern.
- **Depth guard:** `PI_SUBAGENT_DEPTH` is passed as spawned-process *env*,
  not shared mutable state. Each concurrent child reads its own env at
  start. Already race-free. No change.
- **Escalation:** `withEscalationProtocol()` is applied per-branch (each
  branch agent gets it). `parseAgentResult` runs per-branch text. No change
  to the protocol; the composite just aggregates.

---

## Tests

1. **DSL/validator** (`graph-dsl.test.ts`, `graph-validator.test.ts`):
   - `parallel({...})` builds a `ParallelNodeDef`.
   - Empty branches, bad branch keys, non-agent branch defs rejected.
   - Branch key colliding with a node id rejected.
   - Reachability still checked (parallel node has one outgoing edge).
2. **Executor** (`graph-executor.test.ts`):
   - Parallel node runs branches via `Promise.all`, returns composite.
   - One branch blocked → composite `status: "blocked"`, other branch results
     preserved in `branches`.
   - One branch technical failure → `technicalFailure: true` → graph aborts.
   - `mapWithConcurrencyLimit` cap respected (mock 5 branches, cap 4).
3. **Journal/resume** (`graph-journal.test.ts`):
   - One `node` record per parallel step, composite result inside.
   - Resume replays the atomic record; no partial-branch state.
4. **Worktree** (`worktree.test.ts` + new):
   - v1: parallel node with a write-capable branch is rejected at build time.
5. **Display** (`graph-display-bridge.test.ts`):
   - N `markAgentStart` calls, N `markAgentEnd` calls, distinct ids.
6. **E2E escalation** (`graph-e2e-escalation.test.ts`):
   - Two researcher branches, one emits `STATUS: blocked`, edge routes on
     `result.branches.researcherA.blockedOn`.
7. **Sandbox escape** (`graph-sandbox-escape.test.ts`):
   - `parallel` is in the allowlist; no new escape vector (it's a plain
     factory returning a plain object).

---

## Out of scope (deferred)

- Nested `parallel` inside `parallel` — no v1. YAGNI until asked.
- `human`/`mainAgent` as parallel branches — they're interactive by nature;
  concurrent prompts are a UX problem, not a fan-out problem.
- Dynamic fan-out ("N workers, count unknown until runtime") — this is
  LangGraph's `Send`. It's the real Option A territory. Option B is
  static fan-out: you name the branches at graph-build time.
- Write-capable parallel branches (Phase 2 worktree work above).

---

## Migration / compatibility

- Additive. Existing graphs unchanged — no `parallel` node, no behavior change.
- No new tool parameter; the workflow tool's schema is untouched.
- `saveWorkflow`/`loadWorkflow` unaffected (the script text contains the new
  `parallel()` call; it's just more script).