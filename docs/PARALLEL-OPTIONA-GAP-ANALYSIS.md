# Parallel Fan-Out: Option A — True Multi-Edge Graph (Revised Design + Gap Analysis)

**Status:** Revised after design discussion. No implementation. Read alongside
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

## Design decisions from discussion (apply to both A and B)

These decisions emerged from the design discussion and apply regardless of
which parallel option is chosen. They resolve the largest objections in the
original gap analysis.

### Decision 1: Agent nodes get persisted pi sessions

**Today:** every graph node spawn is ephemeral — `pi --no-session`. A
revisited node (planner running again after worker escalates) is a completely
fresh spawn that sees only what the graph interpolates into its prompt. It
has zero memory of its own prior reasoning.

**The plumbing already exists but is dormant:** `sessionFile` flows through
`types.ts` → `execution.ts` → `pi-args.ts` → `pi --session <file>`. There's
even a `findLatestSessionFile()` helper in `utils.ts` — built, never called.

**New model:**
- **First spawn of a node:** inject the fork-summary (compaction-style
  structured summary of the parent session) into the system prompt as today,
  AND spawn with `--session <project-local-path>` so the session is persisted.
- **Revisit/escalation of the same node:** spawn with `--session <that same
  file>` — pi **resumes** the conversation. The agent remembers its full
  working process: files read, tool calls, reasoning, prior conclusions. The
  new turn (the escalation, the feedback) arrives as a new message in an
  ongoing conversation.
- **Session file location:** project-local, keyed by `(runId, nodeId)` —
  e.g. `.pi-workflow/sessions/<runId>/<nodeId>.jsonl`. Honors the constraint
  that subagent artifacts never touch `~/.pi/agent/sessions/`.
- **Non-agent nodes** (`human()`, `mainAgent()`): unaffected — they use
  `ctx.ui` / checkpoint back to the parent session, and have their own memory
  via the parent session. The pi-session model is agent-only.

**Why stateful + expensive is the right call** (per the design discussion):
agents that remember their own prior reasoning make better decisions on
revisit. The token cost of resuming a session is the cost of the agent
re-processing its prior conversation + new turn — a real cost, accepted
deliberately. The alternative (free but stateless) loses the agent's working
process, which is the whole point of revisiting rather than re-planning.

**This is an independently-shippable improvement** to the *current*
architecture, not just an Option A feature. Today's `red → green → red`
cycles would benefit immediately: the revisited `red` would remember the
tests it wrote and why, rather than starting fresh.

### Decision 2: Journal and sessions are complementary, not competing

Two memory layers, answering different questions:

| | Journal | Pi session |
|---|---|---|
| "What did the whole run do?" | ✅ the walk, routing, every node | ❌ only one agent |
| "What did this agent think about?" | ❌ only its final result text | ✅ full conversation |
| "Resume after a crash, cheaply?" | ✅ replay results, no model calls | ❌ must re-spawn |
| "Resume a revisited agent, with memory?" | ❌ stateless replay | ✅ conversation continues |

**On crash-resume:** the journal replays recorded node results into state to
rebuild *where the walk is* — free, deterministic, no model calls. Then the
*next* node to run resumes its pi session — one model call, stateful. You get
both: cheap deterministic walk-reconstruction AND stateful agent memory.

**The journal is never injected into agents.** An agent's prompt is built one
way: the executor calls the graph author's `promptFn(state)`, which reads the
in-memory `GraphState` object. The journal is a side-channel written to JSONL
on disk, read only by the resume mechanism and the `/workflows` display.
Recording the full `result` in the journal costs nothing in agent context
because agents don't read the journal.

**Agent context pollution is controlled at the `promptFn` level** — by what
the author interpolates (`${s.planner}`), not by what the journal records.
This is already the author's job today.

### Decision 3: Journal records parallel execution as flat-with-round

Not a tree — the journal is append-only JSONL, one event per line. A tree
needs parent/child pointers and "subtree complete" markers that fight the
medium.

**Approach:** add a `round` field (superstep index) to each node record.
Nodes that ran concurrently share the same `round`. `step` stays
unique-per-execution (preserves the "revisited node appears twice" property).

```jsonl
{"type":"node","step":1,"round":0,"nodeId":"scout","status":"ok","result":{...},"routedTo":"researcherA","sessionId":"r1/scout.jsonl"}
{"type":"node","step":2,"round":1,"nodeId":"researcherA","status":"ok","result":{...},"routedTo":"planner","sessionId":"r1/researcherA.jsonl"}
{"type":"node","step":3,"round":1,"nodeId":"researcherB","status":"ok","result":{...},"routedTo":"planner","sessionId":"r1/researcherB.jsonl"}
{"type":"round_complete","round":1,"nodeIds":["researcherA","researcherB"]}
{"type":"node","step":4,"round":2,"nodeId":"planner","status":"ok","result":{...},"routedTo":"END","sessionId":"r1/planner.jsonl"}
```

- `researcherA` and `researcherB` share `round: 1` — that's how you know they
  ran in parallel.
- `round_complete` is the **resume atomicity marker**: if a crash left it
  absent for round 1, resume knows the round didn't finish → re-run the whole
  round. This is the parallel equivalent of the current "re-run a whole node,
  never resume mid-agent" honesty, lifted one level.
- New per-node fields: `round`, `sessionId` (pi session file path, agent nodes
  only), `runId` (optional, aids debugging; already in the `graph_run` header).
- Resume replay is unchanged in shape: `for each execution:
  state[nodeId] = result` in recorded order, stopping at the last
  `round_complete`. The walk continues from the next round's frontier.

### Decision 4: Reducers are NOT required for static parallel branches

**This corrects the original gap analysis, which overstated the reducer
problem.**

The executor's automatic state write is always `state[nodeId] = result` —
keyed by the node's own id. `researcherA` → `state.researcherA`.
`researcherB` → `state.researcherB`. **Distinct keys, always. No collision,
no merge needed.** For static named-branch parallelism — the
`scout → (researcherA | researcherB) → planner` case — there is no shared
state and no reducer needed.

The reducer problem only genuinely appears with **`Send`** (dynamic fan-out,
unknown branch count, accumulating N results into one list-key) — which is
deferred. See the race-condition note below for the one edge case.

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
into every subsystem that reads edges.

---

## Revised gap analysis, subsystem by subsystem

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
  SKILL.md teaches.
- `GraphBuilder.validate()`'s reachability walk assumes one successor per
  node. A multi-edge graph needs traversal over *all* successors.
- The "every node has an outgoing edge" check stays, but "an edge" now means
  "at least one in the array."

**Effort:** moderate. The type change is small; the validation rewrite is
real work because reachability over a multi-edge graph with conditional edges
is undecidable in general (the existing code already punts on this for
conditional edges).

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

**Option A — the loop becomes a superstep scheduler:**
```ts
let frontier: Set<string> = new Set([entry]);
let round = 0;
while (frontier.size > 0) {
  round++;
  const outcomes = await Promise.all([...frontier].map(id => runNode(...)));
  // Each node writes under its OWN id — no collision, no reducer needed
  for (const {id, result} of outcomes) state[id] = result;
  // Collect all outgoing edges from every node in the round
  frontier = computeNextFrontier(frontier, graph.edges, outcomes);
}
```

**What breaks:**
- `current = routed.target` (one next node) becomes `frontier = nextSet` (a
  set). The walk is restructured from linear traversal to topological rounds.
- `resolveEdge(graph.edges.get(nodeId), ...)` (one `Edge`) becomes
  `resolveEdges(graph.edges.get(nodeId) ?? [], ...)` (an array). The return
  type changes from one target to a *set* of targets.
- **`maxIterations` semantics change.** Today it counts node executions.
  Recommend counting **rounds** — "exceeded 25 rounds" is more meaningful
  than "exceeded 25 node executions" when 3 were concurrent.
- **Cycle detection changes.** A cycle today is "about to run a node we've
  already run." In a superstep model, it's "this round's frontier includes a
  node whose inputs depend on this round's outputs" — a data-dependency
  cycle, harder to detect and report legibly.
- **Fan-in semantics.** When two edges point at the same target
  (`researcherA → planner`, `researcherB → planner`), `planner` runs only
  after *both* complete. The executor needs an in-degree tracker: a node
  becomes ready when all its incoming-edge sources have completed in prior
  rounds.

**Effort:** large. This is a rewrite of the executor's core, not an
extension. The existing loop's virtue (per its own header comment) is that
it's "deliberately small." A superstep executor is substantially more complex.

**What does NOT break (corrected from original analysis):** the
`state[nodeId] = result` write. Each concurrent node writes under its own id —
no collision. No reducer needed for the static case. See Decision 4 above.

### 3. Reducers — NOT required for static parallel (corrected)

**Original analysis said:** "Option A must import reducers — the single
biggest philosophical divergence."

**Corrected:** for static named-branch parallelism, there is no shared state.
Each branch's result lands under its own `nodeId` key. The planner reads
`s.researcherA` and `s.researcherB` — distinct keys, no merge.

Reducers are only required for:
- **`Send` (dynamic fan-out):** N branches of unknown count accumulating
  into one list-key. This is the genuine reducer case — deferred.
- **Author-written shared keys in parallel edges:** see the race-condition
  note below.

**Effort for the static case:** zero. No reducer machinery needed.
**Effort for the `Send` case:** large (deferred — see section 4).

### 4. `Send` / dynamic fan-out (deferred)

The *reason* to accept Option A's full cost is dynamic fan-out. Without it,
Option B's static `parallel({...})` covers the named-branches case.

```js
g.edge('scout', (state, result) => {
  return result.files.map(f => send('researcher', { file: f }));
});
```

**What this costs (when eventually pursued):**
- A `Send` value type in the DSL; edge returns `string | END | Send[]`.
- The executor spawns subgraph instances per `Send`, each with its own state
  slot.
- **This is where reducers become genuinely required:** N dynamically-spawned
  branches writing to a shared accumulation key need a merge function.
- Journaling N dynamically-spawned branches is a partial-completion problem
  harder than the static case: the count isn't known at journal-write time.

**Status:** deferred. Not part of the initial Option A implementation. The
static multi-edge case (scout → (A | B) → planner) does not need `Send`.

### 5. Journal & resume (`graph-journal.ts`) — revised

**Today:** "a graph walk is an ordered sequence of node executions with stable
ids; resume is a replay." The journal's opening thesis.

**Option A with the design decisions above:**
- Recording: flat-with-round (Decision 3). Each node record gains `round`,
  `sessionId`. A `round_complete` marker follows each finished round.
- Resume: replay node results into state in recorded order, stopping at the
  last `round_complete`. The walk continues from the next round's frontier.
  `resumeFrom` (one node id) becomes `resumeFromRound` (a round index) or a
  frontier set.
- **Agent memory on resume:** the journal rebuilds *where the walk is* (free,
  deterministic). The *next* node to run resumes its pi session (one model
  call, stateful — Decision 1). The two layers are complementary (Decision 2).

**What breaks:**
- `resumeFrom: string` (one node id) is meaningless when the next unit is a
  *round*. Resume must reconstruct the frontier from completed rounds — a
  topological-dependency computation.
- The `graph_result` record's `iterations` field: if `maxIterations` counts
  rounds, this must reflect rounds, not node executions.

**Effort:** moderate. The recording format change is small (add fields, add
`round_complete`). The resume-logic change is real (frontier reconstruction)
but bounded — the `round_complete` marker makes "where did we stop" unambiguous.

### 6. Display bridge (`graph-display-bridge.ts`)

**Today:** `activeIds: Map<number, number>` (one display agent per step).

**Option A:** N nodes active per round. Change to `Map<round, Map<nodeId,
id>>` — call `markAgentStart` per concurrent node, labeling each
`${nodeId} (${agentName})`. The underlying `WorkflowManager` already supports
concurrent agents in its `agents` array (the `subagent` tool's parallel mode
relies on this). No manager change needed.

**Effort:** moderate.

### 7. Worktree isolation (`worktree.ts` + `graph-run-context.ts`)

**Identical problem to Option B.** Today: one worktree for the whole run
(`index: 0` hardcoded). With concurrent write-capable nodes, each needs its
own worktree. The `index` param exists but is unused.

**Option A-specific (only if `Send` is pursued):** with dynamic fan-out, the
number of concurrent write-capable branches is unknown at build time — you'd
allocate worktrees at `Send`-time. The reconciliation problem (two diffs
against the same base) can't be sidestepped with a build-time read-only check.

**For the static case:** same as Option B Phase 1 — require parallel branches
to be read-only (validate at build time), or one worktree per branch using
the existing `index` param. Defer write-capable parallel branches.

**Effort:** moderate for static; unresolved design question for `Send`.

### 8. Budget, depth guard, escalation

- **Budget:** counter, event-loop-serialized. Unchanged mechanically.
  `maxIterations` semantics redefined to count rounds.
- **Depth guard:** env-passed, per-process. Already race-free. Unchanged.
- **Escalation:** `parseAgentResult` per-node, `withEscalationProtocol`
  per-branch. Unchanged mechanically. The *routing* after a fan-out is where
  Option A's multi-target edges shine — each blocked node can route
  independently (`researcherA → human`, `researcherB → planner`). This is
  Option A's genuine coordination advantage over Option B.

---

## Race-condition note (to document later in SKILL.md / README)

**Context:** edge conditions can mutate `state` (the SKILL.md teaches this
for visit counters: `state.rounds = (state.rounds ?? 0) + 1`). If two
parallel branches' edges both write the *same* custom key in the same round,
the second overwrites the first.

**Why it's not a true race:** JavaScript is single-threaded. Edge conditions
evaluate after a node completes, and in a superstep model they'd be evaluated
serially after the round finishes. So it's deterministic last-write-wins
(order-dependent), not a concurrent race.

**The footgun:** an author who writes `state.findings = ...` from two
parallel branches silently loses one. This is an author decision, not a
framework bug — but it should be documented.

**Action item (when implementation is complete):** add a warning to SKILL.md
and README that parallel branches should not write shared state keys from
their edge conditions. Each branch's result lands under its own `nodeId`
automatically and safely; custom shared keys in parallel edges are
last-write-wins and may silently drop data. If accumulation is needed, use
distinct keys per branch and let a downstream node combine them, or wait for
the `Send` + reducer mechanism (deferred).

---

## What Option A buys that Option B cannot

1. **Dynamic fan-out** (`Send`). The only feature that justifies the full
   cost. "One researcher per file the scout found" is real and common.
   *(Deferred — not part of initial Option A.)*
2. **Independent routing per branch.** In Option B, one parallel node has one
   outgoing edge, so all branches share a routing decision. In Option A,
   `researcherA` and `researcherB` can route to different next nodes
   independently.
3. **Fan-in to multiple targets.** Two branches can converge to different
   nodes, not just one `planner`.

For the static case alone (no `Send`), the advantage over Option B is
**independent per-branch routing** — narrower than the original analysis
implied.

---

## Revised cost comparison

| Concern | Option B | Option A (static) | Option A (+ Send, deferred) |
|---|---|---|---|
| Edge data model | `Map<string, Edge>` unchanged | `Map<string, Edge[]>` | same |
| Executor core | one new `case "parallel"` | superstep scheduler | + dynamic branch spawning |
| State semantics | last-write-wins (unchanged) | last-write-wins (unchanged — distinct keys) | **reducers required** |
| Dynamic fan-out | impossible | impossible | possible (the point) |
| Journal/resume | atomic step, replay works | flat-with-round + `round_complete` | + dynamic branch journaling |
| Pi session model | applies (independently shippable) | applies | applies |
| `maxIterations` | counts nodes (unchanged) | counts rounds | counts rounds |
| Cycle detection | "revisiting a node" (simple) | data-dependency cycle | same |
| Worktree (write-capable) | Phase 2 (deferred) | same | can't sidestep |
| Effort | moderate, additive | large, structural | very large |

---

## Revised honest assessment

The original analysis named three hard objections. After the design
discussion, two are resolved and one remains:

1. **~~State must import reducers~~ — RESOLVED.** For static parallel
   branches, each node writes under its own id. No shared state, no reducers.
   The reducer problem is real only for `Send` (deferred).

2. **~~Resume is fundamentally sequential~~ — RESOLVED.** The journal records
   flat-with-round + `round_complete` markers. Resume replays to the last
   completed round (free, deterministic), then the next node resumes its pi
   session (stateful). The journal's "replay the sequence" model extends
   cleanly to "replay the rounds." The pi session model adds agent memory
   that the journal alone couldn't provide.

3. **The executor's loop must become a superstep scheduler — REMAINS.** This
   is the genuine, unavoidable cost of Option A. The current 12-line linear
   walk becomes a topological-rounds scheduler with frontier computation and
   in-degree tracking. This is real complexity, and it's the part that most
   conflicts with the project's "deliberately small" executor philosophy.

**Revised recommendation:**
- The pi session model (Decision 1) should be shipped **independently** — it
  improves the current architecture's cycle support without any parallel
  work. This is the highest-value, lowest-risk change.
- For static parallel branches, Option B remains simpler (one new node type,
  no executor rewrite). Option A's only static-case advantage is independent
  per-branch routing.
- Option A's full value (dynamic fan-out via `Send`) is deferred. When
  pursued, it should be a **separate executor** (`graph-superstep-executor.ts`),
  not a rewrite of `graph-executor.ts`, so linear-walk graphs keep working.
  The DSL would need a way to opt into the superstep model (or a separate
  builder), because the two execution models have incompatible iteration
  semantics (rounds vs. steps).
