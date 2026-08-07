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

### Decision 5: Superstep scheduler with true parallel execution (confirmed)

The executor moves from a linear single-pointer walk to a superstep
(bulk-synchronous parallel) scheduler:

- `frontier: Set<nodeId>` replaces `current: string`.
- Each round runs **all** ready nodes concurrently via `Promise.all` (matches
  the existing `subagent` parallel mode's `MAX_CONCURRENCY = 4` precedent).
- Nodes within a round are **barrier-isolated**: none sees another's result
  until the whole round finishes. This is *safer* than sequential-within-round,
  because it enforces sibling independence automatically — a malformed graph
  can't become order-dependent.

**Why true parallel over sequential-within-round:** the frontier computation,
in-degree tracking, and cycle re-enablement logic are identical in both. The
only difference is the run call — one `runNode` vs
`Promise.all([...frontier].map(runNode))`. By the stated criterion ("if only
a tiny difference, choose true parallel"), superstep is the choice. The cost
is accepted in full.

**`maxIterations` counts rounds.** Each round — regardless of how many nodes
ran in it — increments the counter once. The cap measures
synchronization-barrier depth, which is the real signal for a stuck cycle. A
round running 5 concurrent nodes doesn't burn 5× of the cap for making
forward progress.

**Open detail (display):** `iterations` today doubles as a "how much work"
number in the user message ("completed in N steps"). If a round runs 5
nodes and counts as 1, that meaning is lost. Proposal: keep `iterations`
(rounds) as the safety cap and add a separate `nodeExecutions` counter for
work-amount display/budget. Decision pending final confirmation.

### Decision 6: AND fan-in readiness rule with wave reset (Model 2)

A node is ready to run when **all** of its incoming edges' sources ran this
round **and** routed to it. This is "AND fan-in" — fan-in nodes wait for all
their predecessors, never run on partial data.

**Contrast with Model 1 (route-to = ready):** Model 1 would run a fan-in
node as soon as *any* predecessor routed to it, meaning a `reviewer` could
run on just `workerA`'s result while `workerB` was escalating — reviewing
incomplete work and acting concurrently with the re-planning. Model 2
prevents this; the framework guarantees a fan-in node sees all its inputs.

**Readiness rule (general, cumulative in-degree):**
- Each node has a static in-degree (count of incoming edges).
- We track a `remainingInDegree: Map<nodeId, number>` counter. A node enters
  the frontier when its remaining in-degree reaches 0.
- When a round completes, each fired edge `u → v` decrements
  `remainingInDegree[v]`. A conditional edge fires only if its condition
  selected `v`; a direct edge always fires.
- The **entry node** bypasses this (starts ready — it has no predecessors to
  wait for).
- This is the *general* (cumulative across rounds) version, chosen over the
  simple same-round version because it correctly handles diamonds where a
  node's predecessors finish in different rounds (e.g.
  `scout → researcherA → summarizer` and `scout → deepdive → summarizer`
  where deepdive takes an extra round). Same mechanism, more correct.

**Wave reset on back-edge (the cycle mechanic):** when a back-edge fires (a
node routes to an upstream node — e.g. `workerB → planner` escalation), the
subgraph **downstream of the back-edge target** is reset: every node in that
subgraph has its `remainingInDegree` restored to its static value, and the
prior wave's edge firings in that subgraph are forgotten. The next wave
starts clean from the back-edge target. This is what makes each pass through
a cycle independent and predictable rather than carrying forward stale
in-degree state.

**Worked example** (the case that motivated this decision):

```
planner ──→ workerA ──→ reviewer ──→ END
        └──→ workerB ──↗    └──→ planner (cycle)
```

| Round | Frontier | Runs | Routes | counter | Notes |
|---|---|---|---|---|---|
| 1 | {planner} | planner | workerA, workerB | 1 | entry |
| 2 | {workerA, workerB} | both concurrently | workerA→reviewer, workerB→planner | 2 | fan-out |
| 3 | {planner} | planner (re-plan) | workerA, workerB | 3 | reviewer NOT ready (1 of 2 edges fired); back-edge reset wipes workerA→reviewer |
| 4 | {workerA, workerB} | both concurrently | both→reviewer | 4 | wave restarted from planner |
| 5 | {reviewer} | reviewer | END | 5 | both edges fired → ready |
| 6 | {} | — | — | 6 | done |

`reviewer` never runs on partial data. The escalation loops cleanly:
workerB escalates → planner re-plans → both workers re-run → reviewer sees
complete work.

**Known limitation — wasteful sibling re-runs (accepted, deferred):** when
one branch of a fan-out escalates, *all* sibling branches re-run in the next
wave (`workerA` runs again in round 4 even though its round-2 work was
fine). This is the cost of Model 2's clean wave reset. The pi session model
(Decision 1) directly mitigates it: the re-running node **resumes its
session**, sees its prior work, and cheaply re-confirms rather than starting
fresh. The deeper optimization is **deferred homework** (see "Deferred
optimizations" below).

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

### 2. Executor (`graph-executor.ts`) — CONFIRMED design (superstep, Model 2)

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

**Confirmed: the loop becomes a superstep scheduler with true parallel
execution (Decisions 5 & 6).** The single `current` pointer becomes a
`frontier` set; each round runs all ready nodes concurrently via `Promise.all`:

```ts
let frontier: Set<string> = new Set([entry]);
let round = 0;
let nodeExecutions = 0;                       // work-amount counter (display)
while (frontier.size > 0) {
  round++;                                    // maxIterations counts rounds
  const outcomes = await Promise.all(
    [...frontier].map(id => runNode(graph.nodes.get(id), state, ...))
  );
  nodeExecutions += outcomes.length;
  // Each node writes under its OWN id — no collision, no reducer (Decision 4)
  for (const { id, result } of outcomes) state[id] = result;
  // Apply fired edges → decrement remaining in-degree; reset waves on back-edges
  frontier = computeNextFrontier(frontier, graph.edges, outcomes);
}
```

**The real work — `computeNextFrontier` (Decision 6):** this is the hardest
part of the superstep scheduler. It encodes the AND fan-in readiness rule and
the wave-reset mechanic:

- **In-degree tracking.** Each node has a static in-degree (count of
  incoming edges). A `remainingInDegree: Map<nodeId, number>` counter tracks
  how many predecessors still need to fire. A node enters the frontier when
  its remaining in-degree reaches 0. The entry node bypasses this (starts
  ready).
- **Edge firing.** After a round, each node's routing decision determines
  which outgoing edges "fired." Each fired edge `u → v` decrements
  `remainingInDegree[v]`. A conditional edge fires only if its condition
  selected `v`; a direct edge always fires.
- **Wave reset on back-edge.** When a fired edge targets a node upstream of
  its source (a cycle / escalation), the subgraph downstream of the target is
  reset: every reachable node's `remainingInDegree` is restored to its static
  value, and the prior wave's firings in that subgraph are forgotten. The
  next wave starts clean from the back-edge target. This is what makes each
  cycle pass independent (see the worked example in Decision 6).
- **Fan-in completion.** A fan-in node (`reviewer` with edges from both
  `workerA` and `workerB`) waits until all its predecessors fire in the same
  wave — it never runs on partial data.

**`resolveEdge` → `resolveEdges`:** the single-edge lookup
(`graph.edges.get(nodeId)`, one `Edge`) becomes an array lookup
(`graph.edges.get(nodeId) ?? []`). Each edge in the array is evaluated; a node
may route to multiple targets (fan-out) or one (conditional pick). The return
type changes from one target to a *set* of fired targets.

**`maxIterations` counts rounds (Decision 5).** Each round increments the
counter once regardless of concurrency. The cap measures synchronization
barrier depth — the real signal for a stuck cycle. A separate
`nodeExecutions` counter tracks total work for display/budget (pending final
confirmation on the one-vs-two-counter question).

**Cycle detection.** A cycle today is "about to run a node we've already
run." In the superstep model, cycle *detection* is largely subsumed by
`maxIterations`-on-rounds — a cycle that never resolves climbs rounds until
the cap. The `graph_result` error reports recent *rounds* (frontiers), not
just nodes, so the loop is visible.

**Effort:** large, **accepted in full** (per discussion). This is a rewrite
of the executor's core. Recommendation remains to implement it as a
**separate `graph-superstep-executor.ts`** rather than rewriting
`graph-executor.ts`, so linear-walk graphs (and their resume model) keep
working unchanged. The DSL opts into the superstep model.

**What does NOT break (Decision 4):** the `state[nodeId] = result` write.
Each concurrent node writes under its own id — no collision, no reducer
needed for the static case.

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
- Resume must also reconstruct the `remainingInDegree` counters (Decision 6)
  so it knows which nodes are ready, not just which ran. The `round_complete`
  marker records the frontier that finished, but the in-degree state must be
  recomputed by replaying which edges fired in each completed round.
- The `graph_result` record's `iterations` field: if `maxIterations` counts
  rounds, this must reflect rounds, not node executions. A separate
  `nodeExecutions` field mirrors the work-amount counter (Decision 5).

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

## Deferred optimizations (homework for later)

Accepted limitations of the confirmed design, to revisit after the core
superstep executor is working.

### 1. Wasteful sibling re-runs on escalation (Model 2 cost)

**The issue:** when one branch of a fan-out escalates (routes via a
back-edge), the wave reset makes *all* its siblings re-run in the next wave
— even siblings whose work was fine and whose inputs didn't change. In the
worked example (Decision 6), `workerA` runs again in round 4 because
`workerB` escalated in round 2.

**Current mitigation:** the pi session model (Decision 1). A re-running node
**resumes its session**, sees its prior work, and can cheaply re-confirm
("the new plan doesn't change my part") rather than redoing it from
scratch. The re-run is a one-turn resume, not a full re-spawn.

**Defer deeper optimization:** the principled fix is *change-tracking* —
skip re-running a node when the set of inputs it reads hasn't changed since
its last execution (differential / incremental computation). This is real
complexity (dependency analysis on what each node reads from `state`) and is
**deferred**. For now, the session-resume mitigation is accepted.

### 2. (Reserved for future homework items)

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
| Executor core | one new `case "parallel"` | superstep scheduler + `Promise.all` (CONFIRMED) | + dynamic branch spawning |
| Readiness rule | n/a (one successor) | AND fan-in + in-degree + wave reset (Decision 6) | same |
| State semantics | last-write-wins (unchanged) | last-write-wins (unchanged — distinct keys) | **reducers required** |
| Dynamic fan-out | impossible | impossible | possible (the point) |
| Journal/resume | atomic step, replay works | flat-with-round + `round_complete` (replay in-degree too) | + dynamic branch journaling |
| Pi session model | applies (independently shippable) | applies | applies |
| `maxIterations` | counts nodes (unchanged) | counts rounds (+ `nodeExecutions` for display, pending) | counts rounds |
| Cycle detection | "revisiting a node" (simple) | subsumed by rounds cap + `graph_result` reports frontiers | same |
| Sibling re-runs | n/a | wasteful on escalation (mitigated by sessions; deeper fix deferred) | same |
| Worktree (write-capable) | Phase 2 (deferred) | same | can't sidestep |
| Effort | moderate, additive | large, structural — ACCEPTED (separate executor file) | very large |

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

3. **The executor's loop must become a superstep scheduler — ACCEPTED
   (confirmed).** The current 12-line linear walk becomes a
   topological-rounds scheduler with `Promise.all` concurrency, in-degree
   tracking, AND fan-in readiness, and wave reset on back-edges (Decisions 5
   & 6). This is real complexity, accepted in full per discussion. It's the
   part that most conflicts with the "deliberately small" executor
   philosophy — mitigated by implementing it as a **separate
   `graph-superstep-executor.ts`** so the linear-walk graphs and their
   resume model keep working unchanged.

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
