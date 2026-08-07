# Parallel Fan-Out: Option A — True Multi-Edge Graph (Gap Analysis)

**Status:** Deep-dive / gap analysis only. No implementation. Read alongside
`docs/PARALLEL-FANOUT-PLAN.md` (Option B).

## What Option A is

The "true graph" approach, in LangGraph's spirit: a node may have **multiple
outgoing edges**, and the executor runs every ready node concurrently within
a *superstep*. Fan-out is not a special node type — it's a property of the
edge structure.

```js
g.edge('scout', 'researcherA');
g.edge('scout', 'researcherB');              // second edge from same source — forbidden today
g.edge('researcherA', 'planner');
g.edge('researcherB', 'planner');            // fan-in: two edges into one node
```

The motivating difference from Option B: **dynamic fan-out**. With a `Send`
analogue, the number of parallel branches isn't known at graph-build time —
a node emits one branch per item in a runtime list ("one researcher per file
the scout found"). Option B can't express that; Option A can.

---

## The single structural assumption that Option A dismantles

Everything in this codebase is built on one invariant, and it's **enforced in
the DSL itself**, not just assumed:

```ts
// graph-dsl.ts, GraphBuilder.edge()
if (this.edges.has(from)) {
  throw new GraphDefinitionError(
    `Node "${from}" already has an outgoing edge. A node has at most one edge; use a conditional edge to branch.`,
  );
}
this.edges.set(from, { type: "conditional", from, condition: target });
```

The data model is `edges: Map<string, Edge>` — **one edge per source node
id**. Option A requires `Map<string, Edge[]>`. That single type change ripples
into every subsystem that reads edges. Below is each touch point, with the
exact code that breaks.

---

## Gap analysis, subsystem by subsystem

### 1. DSL (`graph-dsl.ts`)

**Today:**
```ts
edges: Map<string, Edge>;   // one per source
// edge(from, to) throws if from already has an edge
```

**Option A:**
```ts
edges: Map<string, Edge[]>;  // many per source
// edge(from, to) appends; a second call is legal
```

**What breaks:**
- The explicit "at most one edge" throw is removed. This is a **deliberate
  design decision currently enforced** — the error message tells authors to
  use a conditional edge to branch. Removing it changes the mental model the
  SKILL.md teaches (every example uses single edges + conditional routing).
- `GraphBuilder.validate()`'s reachability walk (`canReachEnd`,
  `isReachable`) assumes one successor per node. A multi-edge graph needs
  graph traversal over *all* successors, not the single `edge.to`.
- The "every node has an outgoing edge" check stays, but "an edge" now means
  "at least one in the array."

**Effort:** moderate. The type change is small; the validation rewrite is
real work because reachability over a multi-edge graph with conditional edges
is undecidable in general (the existing code already punts on this for
conditional edges — "Reachability is checked only when every edge is direct").
With multi-edge + conditional, the conservative reachability check gets
weaker or must be dropped.

### 2. Executor (`graph-executor.ts`)

**Today — the whole loop, 12 lines of essence:**
```ts
let current: string | EndSymbol = entry;
while (current !== END) {
  iterations++;
  const node = graph.nodes.get(current);
  const outcome = await runNode(node, state, { step, runId, signal });
  state[current] = outcome.result;                    // one result, one key
  if (outcome.technicalFailure) return finish("aborted", ...);
  const routed = resolveEdge(graph.edges.get(current), ...);  // ONE edge
  current = routed.target;                             // ONE next node
}
```

**Option A — the loop is no longer a loop over one node:**
A superstep model means: collect the set of *active* nodes (those whose
incoming edges are all satisfied), run them concurrently, wait for all, merge
their state updates, then compute the next active set. This is Pregel.

```ts
let frontier: Set<string> = new Set([entry]);
while (frontier.size > 0) {
  // Run all nodes in the frontier concurrently
  const outcomes = await Promise.all([...frontier].map(id => runNode(...)));
  // Merge: each node writes its keys — REDUCERS resolve collisions
  for (const {id, result} of outcomes) applyUpdate(state, id, result);
  // Next frontier: nodes whose ALL incoming edges come from completed nodes
  frontier = computeNextFrontier(...);
}
```

**What breaks:**
- `current = routed.target` (one next node) becomes `frontier = nextSet` (a
  set). The entire walk is restructured from a linear traversal to a
  topological-rounds traversal.
- **`state[nodeId] = result` (overwrite) is no longer sufficient.** If
  `researcherA` and `researcherB` both run in the same superstep and both
  want to contribute to what `planner` reads, they can't both write
  `state.research` — last-write-wins silently drops one. This is exactly the
  problem LangGraph solves with **reducers**: each state key has a merge
  function (`Annotated[list, add]`), and concurrent writes are merged, not
  overwritten.
- `resolveEdge(graph.edges.get(nodeId), ...)` (one `Edge`) becomes
  `resolveEdges(graph.edges.get(nodeId) ?? [], ...)` (an array). The return
  type changes from one target to a *set* of targets.
- **`maxIterations` semantics change.** Today it counts node executions (a
  linear sequence). In a superstep model, does one superstep count as one
  iteration, or do the N concurrent nodes count as N? This is a real semantic
  decision that affects every existing test and the budget cap's meaning.
- **Cycle detection changes.** A cycle today is "we're about to run a node
  we've already run." In a superstep model, a cycle is "this superstep's
  frontier includes a node whose inputs depend on this superstep's outputs" —
  a data-dependency cycle, harder to detect and report legibly.

**Effort:** large. This is a rewrite of the executor's core, not an
extension. The existing loop's virtue (per its own header comment) is that
it's "deliberately small" — three lines of essence. A superstep executor is
substantially more complex and is precisely the "reimplement Pregel" path the
project's philosophy says to avoid.

### 3. Reducers — the concept Option A must import

This is the single biggest philosophical divergence. Today, state is a flat
`Record<string, unknown>` with **last-write-wins** overwrite semantics, and
this is a *feature* (the SKILL.md teaches "revisiting a node overwrites its
state entry — latest wins, for iterative refinement").

Option A's concurrent writes make last-write-wins a **silent data-loss bug**.
To be correct, state needs per-key merge functions:

```js
// LangGraph
class State(TypedDict):
    results: Annotated[list[str], add]   // concurrent appends merge
```

Our equivalent would be something like:
```js
g.state({
  research: { type: 'array', merge: 'append' },   // declare merge strategy
  plan: { merge: 'overwrite' },                     // default
});
```

**What this costs:**
- The DSL gains a state-schema declaration step that doesn't exist today.
  Currently state is implicit — `g.run({ task })` and whatever nodes write.
- The sandbox must expose merge functions (or the DSL declares them by name
  and the executor implements them). Either way, the "the script describes,
  the host executes" boundary gets a new responsibility.
- Every existing graph that relies on overwrite semantics keeps working only
  if the default reducer is `overwrite`. But then a user who *wants* parallel
  fan-in must explicitly annotate state keys — a new cognitive load and a new
  footgun (forget the annotation → silent loss, exactly the LangGraph warning
  in the fetched docs: "Without a reducer, the last write wins — which loses
  data in parallel scenarios").
- `rehydrateState` (journal resume) must re-apply merges in recorded order,
  not just overwrite. The replay loop `state[nodeId] = execution.result` is
  wrong under reducers.

**Effort:** large, and it's the load-bearing change. Everything else in
Option A is plumbing; reducers are the conceptual import that changes what
"state" *means* in this project.

### 4. `Send` / dynamic fan-out

The *reason* to accept Option A's cost is dynamic fan-out. Without it, Option
B's static `parallel({...})` covers the named-branches case with far less
machinery. So Option A must also add a `Send`-analogue:

```js
g.edge('scout', (state, result) => {
  // result is scout's findings; emit one branch per file
  return result.files.map(f => send('researcher', { file: f }));
});
```

**What this costs:**
- A `Send` value type in the DSL and a new edge-return contract (today an
  edge returns `string | END`; it would return `string | END | Send[]`).
- The executor must spawn subgraph instances per `Send`, each with its own
  state slot or a merged-into-parent state slot — this is genuinely complex
  (LangGraph runs each `Send` as an independent subgraph invocation).
- `mapWithConcurrencyLimit` reuse is possible but the *identity* of each
  spawned branch (which result goes to which state key) must be tracked, and
  the reducer merge must combine them. This is where reducers and `Send`
  intersect: `Send` produces N concurrent writes that *require* a reducer to
  not lose data.
- Journaling N dynamically-spawned branches under one logical step is a
  partial-completion problem even harder than Option B's atomic-step
  decision: the count isn't known at journal-write time.

**Effort:** very large. This is the part of LangGraph we'd be reimplementing
most faithfully, and it's the part with the least existing precedent in our
codebase.

### 5. Journal & resume (`graph-journal.ts`)

**Today:** "a graph walk is an ordered sequence of node executions with stable
ids; resume is a replay." This is the file's opening thesis and the reason
graph resume is "tractable where the imperative workflow's was not."

**Option A:**
- A superstep is not a single node execution; it's N concurrent ones. The
  journal must record all N (or record the superstep as one composite — but
  then partial completion is the Option B problem again, and worse because N
  is dynamic).
- `state[nodeId] = execution.result` (overwrite replay) is wrong under
  reducers — replay must re-run merges.
- `resumeFrom` (one node id) is meaningless when the next unit of work is a
  *frontier*. Resume must reconstruct the frontier from completed nodes — a
  topological-dependency computation that doesn't exist today.

**Effort:** large. The journal's clean "replay the sequence" model — the
project's stated advantage over the imperative workflow — is fundamentally a
*sequential* model. Supersteps are not sequential. This is the deepest
tension: Option A asks the resume system to stop being the thing it's
explicitly designed to be.

### 6. Display bridge (`graph-display-bridge.ts`)

**Today:** `activeIds: Map<number, number>` (one display agent per step).

**Option A:** N nodes active per superstep. Same change as Option B
(`Map<step, Map<branchId, id>>`), but the "branchId" is a node id, not a
named branch — and with `Send`, the set of active nodes isn't known until the
previous superstep's edge returns. The display must handle a dynamically
growing set of concurrent entries.

**Effort:** moderate. The manager already supports concurrent agents; the
bridge needs to track a set per superstep.

### 7. Worktree isolation (`worktree.ts` + `graph-run-context.ts`)

**Identical problem to Option B, worse.** Today: one worktree for the whole
run (`index: 0`). With concurrent nodes that may write, each needs its own
worktree. The `index` param exists but is unused.

**Option A-specific:** with `Send`, the number of concurrent write-capable
branches is dynamic — you'd allocate worktrees at `Send`-time, not
graph-build time. The reconciliation problem (two diffs against the same
base) is the same as Option B Phase 2, but you can't statically reject
write-capable agents because you don't know how many there will be.

**Effort:** the same unresolved design question as Option B Phase 2, with the
added difficulty that you can't sidestep it with a build-time read-only check.

### 8. Budget, depth guard, escalation

- **Budget:** counter, event-loop-serialized. Unchanged mechanically; but
  `maxIterations` semantics (per-node vs per-superstep) must be redefined.
- **Depth guard:** env-passed, per-process. Already race-free. Unchanged.
- **Escalation:** `parseAgentResult` per-node. Unchanged mechanically; the
  *routing* after a fan-out is where Option A's multi-target edges shine
  (each blocked node can route independently) — this is Option A's genuine
  coordination advantage.

---

## What Option A buys that Option B cannot

1. **Dynamic fan-out** (`Send`). The only feature that justifies the cost.
   "One researcher per file the scout found" is real and common.
2. **Independent routing per branch.** In Option B, one parallel node has one
   outgoing edge, so all branches share a routing decision. In Option A,
   `researcherA` and `researcherB` can route to different next nodes
   independently (`researcherA -> planner`, `researcherB -> human`). This is
   more expressive for heterogeneous fan-out.
3. **Fan-in to multiple targets.** Two branches can converge to different
   nodes (`A -> reviewA`, `B -> reviewB`), not just one `planner`.

If none of these are needed, Option B is strictly simpler for the same
coordination benefit.

---

## What Option A costs that Option B does not

| Concern | Option B | Option A |
|---|---|---|
| Edge data model | `Map<string, Edge>` unchanged | `Map<string, Edge[]>` — ripples everywhere |
| Executor core | one new `case "parallel"` | rewritten from linear walk to superstep rounds |
| State semantics | last-write-wins (unchanged) | must import **reducers** (per-key merge fns) |
| Dynamic fan-out | impossible | possible (the point) |
| Journal/resume | atomic step, replay works as-is | replay must re-merge; resume reconstructs frontiers |
| `maxIterations` | counts nodes (unchanged) | must redefine (per-superstep? per-node?) |
| Cycle detection | "revisiting a node" (simple) | data-dependency cycle (harder) |
| SKILL.md teaching | one new factory | new mental model: multi-edge + reducers + Send |
| Philosophy fit | extends our small executor | imports Pregel; contradicts "minimal custom" |
| Effort | moderate, additive | large, structural rewrite |

---

## The honest assessment

Option A is the "true graph" in the sense that fan-out becomes a property of
edges rather than a node type. That elegance is real. But the cost is paid in
the three places this project most wanted to keep simple:

1. **The executor's loop** — currently "deliberately small" (its own
   comment) — becomes a superstep scheduler.
2. **State** — currently flat overwrite, a *taught feature* — must import
   reducers, a concept with a documented silent-data-loss footgun.
3. **Resume** — currently "replay an ordered sequence," the explicit
   advantage over the imperative workflow — becomes frontier reconstruction
   with merge replay, which is not a sequence.

The project's `GRAPH-WORKFLOW-DESIGN.md` and the executor's header comment
both frame the design as a deliberate rejection of heavier coordination
frameworks ("No message bus, no dispatcher, no coordination tools inside the
agents — routing plus accumulated state is the whole mechanism"). Option A's
superstep model is a step back toward the machinery that was rejected.

**Recommendation if asked to choose:** ship Option B now. Reserve Option A
for the moment a user needs *dynamic* fan-out (unknown branch count at graph
build time) — that is the only capability Option A adds, and it's the one
that genuinely requires the superstep/reducer machinery. For static,
named-branch parallelism — the `scout -> (A | B) -> planner` case that
motivated this — Option B delivers the benefit without dismantling the
invariants the rest of the system is built on.

If Option A is ever pursued, it should be as a **separate executor** (e.g.
`graph-superstep-executor.ts`), not a rewrite of `graph-executor.ts`, so the
linear-walk graphs and their resume model keep working unchanged. The DSL
would need a way to opt into the superstep model (or a separate builder),
because the two execution models have incompatible state, resume, and
iteration semantics.