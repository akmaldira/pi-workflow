# Premature Fan-In Execution Under Staggered Retries (Deferred)

**Status:** 🟡 **Known limitation, deferred.** Root cause understood, workaround
available and recommended today, executor-level fix scoped but **not
implemented**. Revisit if the no-escape retry idiom becomes common enough
that per-graph gate-node boilerplate is a real cost.

**Reported by:** third-party workflow author, `create-input-json-v4-extractor-to-per-track-pass-to-assemble.md`
run `graph-1786775430267` (case 8907)
**Investigated:** this session — mechanism independently verified against
`extensions/graph-executor.ts`, reproduced live with `runSuperstepGraph` +
`buildGraphFromScript`, extended beyond the original report's findings.
**Related:** `docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md` (superstep/claims design),
`2f4cb5d5` (wave-reset per-source claim fix — this is what makes the
self-correction reliable, not what causes the prematurity).

---

## TL;DR

A fan-in node whose incoming edges come from conditional retry loops can fire
**before all of its sources have produced their final (post-retry) value**,
because claim release is branch-independent: a source releases its claim on
every node its conditional edge could have targeted the moment it fires,
regardless of which branch it actually took. This is not a bug in the sense
of broken code — it is the direct, provable consequence of a deliberately
pessimistic design decision that prevents a worse failure (permanent
deadlock) elsewhere. It is self-correcting today via the existing wave-reset
fix (`2f4cb5d5`), costs at most one extra fan-in execution in every
configuration tested (not provably bounded, see §5), and — independently
verified in this investigation, beyond what the original report checked —
**nothing downstream of the fan-in node can ever observe the premature
output**, because any downstream consumer is swept into the same reset
subgraph. There is a per-graph workaround available today (restore gate
nodes) that eliminates the issue entirely, and a scoped, narrower
executor-level fix is possible for one specific retry shape, described in
§6, but not implemented.

---

## 1. Symptom

In a 5-way direct fan-in graph (`plan → 5×(scout→extract→[retry loop])→assemble`,
no intermediate gate nodes — the "v5" topology), `assemble` executed once
while two of the five extractor tracks were still inside their retry loops,
using stale pre-retry state for those two tracks. The graph then
self-corrected: the retry back-edges re-armed exactly the claims belonging to
the still-retrying tracks (not the already-clean ones), the extractors
re-ran, and `assemble` re-ran with complete data. Final output quality was
unaffected — the corrected re-run's output is what a downstream reviewer
node graded and what the run reported as final.

## 2. Root cause

### 2.1 The mechanism (verified directly against code, not inferred from the trace)

Three claim-tracking behaviors combine to produce this:

**(a) Release-on-run is branch-independent.** `resolveEdges` in
`extensions/graph-executor.ts` releases every statically-claimed candidate of
a conditional edge when that edge fires — not just the one branch it actually
selected:

```ts
// This edge claimed every node it might select, so every one of those
// claims is released now that it has decided — including the ones it
// passed over, which would otherwise never become ready.
for (const candidate of conditionalTargetsOf(graph, edge.from)) resolved.add(candidate);
```

A claim therefore answers "has this source fired at all", not "did this
source's *chosen* branch include me". When `extract_X`'s conditional edge
fires toward `extract_X_retry`, its claim on `assemble` — the sibling
candidate it did *not* pick — is released in the same instant.

**(b) Selection is a one-way latch.** Readiness requires
`totalClaims(bySource) === 0 && selected.has(node) && !executed.has(node)`
(`computeNextFrontier`, step 5). `assemble` becomes `selected` the first time
*any* clean track routes to it directly, and nothing un-selects it except a
reset that includes `assemble` itself in the reset subgraph. Once the last
outstanding claim (from a still-retrying track, released per (a) above) hits
zero, `assemble` fires — even though that release happened via the retry
branch, not the success branch.

**(c) The completion criterion does not care about "genuinely done" vs
"claims exhausted".** `while (frontier.size > 0)` is the only halting
condition; there is no separate notion of "all sources reached their true
final state" distinct from "all sources have fired at least once toward this
node".

### 2.2 Why it self-corrects, and why that is guaranteed (not luck)

The retry back-edge (`extract_X_retry → extract_X`) triggers a wave reset
whose subgraph is everything forward-reachable from `extract_X`. The
per-source restore added in `2f4cb5d5` re-arms **only** claims whose *source*
is itself inside that reset subgraph — so `assemble`'s claim from the
retrying track is restored, but claims already released by clean sibling
tracks are left alone (they cannot be re-earned; their source already ran to
completion). This is exactly why the self-correction is structural, not
probabilistic: it falls directly out of the same fix that resolved the
wave-reset deadlock, applied to a different symptom of the same
branch-independent release design.

### 2.3 New finding beyond the original report: downstream nodes are provably shielded

The original report did not check whether a node downstream of `assemble`
(e.g. a `reviewer`) could observe the premature output. This investigation
did: a `reviewer` node added after `assemble` in the reproduction **never**
fired on the premature round. It is swept into the identical reset subgraph
as `assemble` (being forward-reachable from the same back-edge target), so
its premature `selected`/claim state is undone in the same reset that
undoes `assemble`'s. This means the guarantee is stronger than "the
assembler's *own* output eventually gets fixed" — it is "nothing anywhere
downstream can ever see the premature output," which follows structurally
from the same per-source reset mechanism, not from re-checking the file
contents after the fact.

## 3. Live reproduction (evidence, not just trace-reading)

Reproduced with the real production code path — `buildGraphFromScript` (AST
target analysis, exactly what the `workflow` tool always uses) +
`runSuperstepGraph` — using the report's exact topology (two staggered
retrying tracks, one resolving early, one late via extra delay hops).

Round-by-round:

```
round 5: [extract_machine, extract_messstelle]         claims after: 0
round 6: [extract_messstelle_retry, assemble]           ← PREMATURE, same round as the retry back-edge
round 7: [extract_messstelle]
round 8: [assemble]                                      ← corrected re-run
```

State `assemble` actually saw on each execution (captured directly from the
sandbox state object, not inferred):

```
Round 6 (premature): extract_messstelle: "messstelle#1"   ← stale, pre-retry value
Round 8 (corrected):  extract_messstelle: "messstelle#2"   ← post-retry, final value
```

This confirms the report's central mechanism claim exactly.

## 4. Is this a race condition / data-corruption risk?

**No**, and this is worth stating precisely because it was the first
concern raised. Rounds are a strict barrier: `Promise.all` over the whole
frontier resolves fully, and every node's `executed` status is finalized,
before the next frontier is even computed. The two `assemble` executions in
the reproduction were round 6 and round 8 — never concurrent. If `assemble`
(or any fan-in node reachable this way) only **overwrites** one output
artifact with its full current snapshot, last-write-wins is correct and safe:
the round-8 write simply lands after the round-6 write completes, and
nothing downstream can read the round-6 write before it is superseded
(§2.3).

**This safety claim is conditional**, however: it depends on the fan-in
node's side effects being idempotent / overwrite-safe. A fan-in node that
appends to a log, increments a counter, calls an external API, or performs
any other non-idempotent action **will** run that action twice under this
behavior. That is a correctness problem independent of this document's
scope — any graph author using this pattern should audit what their fan-in
node actually does beyond returning a value.

## 5. Cost — softer than the original report implies

The original report frames the cost as "one extra assemble execution",
generalized from the single run it observed. This investigation tested that
claim by varying the stagger pattern significantly (a third retrying track,
tracks needing 2–3 retries instead of 1, deeply staggered delay chains
forcing separate release events) and could not construct a configuration
producing more than one premature fire — every variant collapsed to at most
one premature execution before the final correct one. This is because a
firing source releases **all** claims it holds on a target in one pass
(the duplicate-edge fix from `2f4cb5d5`), so once a track's release has
satisfied the fan-in node's outstanding claims, later sibling releases don't
re-trigger separate premature fires; a premature fire only recurs after a
fresh reset+re-release cycle, and resets from multiple in-flight retries
tend to coalesce rather than stack.

**This should be treated as an empirical observation across the
configurations tested, not a proven bound.** No invariant in the code
guarantees "at most one" as a hard ceiling; it held in every case
constructed during this investigation, including deliberately adversarial
timing, but that is not a proof.

## 6. Fix options

### 6.1 Executor-level fix: not viable in general (verified, not assumed)

The naive version — "only release the claim on the branch actually chosen"
— was checked directly and found to reopen a **worse** failure than the one
being fixed: a bounded-retry-then-give-up pattern (a track that exhausts
retries and routes to an `escalate` node instead of ever reaching the fan-in
node) would strand that claim forever, since the completion criterion
(`while frontier.size > 0`) does not care about stranded claims on nodes
that never became ready — the run would "complete" with the fan-in node
never having run at all. This is strictly worse (silent permanent
under-execution vs. an extra, self-correcting execution) and rules out a
blanket executor change.

### 6.2 Graph-level fix (recommended, available today, zero executor risk)

Restore the v4 pass-gate pattern: an intermediate node between each track's
extractor and the fan-in node, reachable **only** on that track's true
success branch:

```js
g.edge("extract_X", (s, r) => needsRetry(r) ? "extract_X_retry" : "pass_X");
g.edge("pass_X", "assemble");
```

`pass_X` only becomes `selected` when the success branch is actually taken —
never on a retry-branch firing — so `assemble`'s claim on that source stays
pending until a genuinely final success. This is not a mitigation of the
staleness window; it removes the staleness window entirely, by construction.
No timing dependency, no "usually one extra execution" — provably zero
premature fires. Cost: one near-free `fn` node and one extra hop per track
that needs this guarantee. This is the recommended action for any graph
author who wants "never happens" starting now.

### 6.3 Narrower executor-level fix (scoped, NOT implemented)

A real fix is possible for one specific, staticly-provable retry shape: a
retry loop with **no escape branch at all** — i.e. the retry node's only
outgoing edge is an unconditional direct edge straight back to the source,
with no conditional branch, no give-up/escalate target, nothing else it
could ever do.

**The correct test is stricter than "the retry edge is unconditional".**
An early version of this idea considered by-branch-unconditionality alone,
which is insufficient: the danger case is a retry chain where some *later*
node in the chain has a give-up branch, even if the immediate retry edge
itself looks unconditional. The safe test must prove that **every** path
out of the fired branch's reachable subgraph, with zero exceptions,
eventually re-enters the source node — i.e. the source is a mandatory
checkpoint on every possible continuation of that branch. Whenever any
conditional branch, give-up edge, or statically-unreadable target exists
anywhere in that reachable subgraph, the check must fail closed and the
executor must fall back to today's immediate-release behavior. Getting this
analysis wrong in the unsafe direction reintroduces exactly the deadlock in
§6.1; getting it wrong in the overly conservative direction just forgoes the
optimization for cases that would have been safe.

**Under this fix, only the plain no-escape retry-loop shape changes
behavior**: `assemble` fires exactly once, only after every track's true
final branch has been taken, no premature execution, no self-correction
needed because there is nothing to correct. Every other shape (any retry
chain with a give-up branch, any statically-unreadable conditional target,
any graph built via raw `GraphBuilder` without AST analysis) is completely
unaffected — same pessimistic release, same possible premature fire, same
existing self-correction.

**Storage/compatibility is favorable, not a blocker:** "withheld" and "not
yet fired" are indistinguishable in the existing claim representation
(`Map<target, Map<source, count>>`) — this needs no new journal schema, no
resume-path changes; resume-mid-cycle already snapshots exactly the state
this fix would produce.

**Why this is not a quick patch:** it touches `resolveEdges`/claim-release
logic — the same small, heavily-shared, central code area where two subtle
bugs were already found and fixed in `2f4cb5d5` (wave-reset claim bleed,
duplicate-edge claim mismatch). Comparable rigor would be required: a
correct "mandatory checkpoint" reachability analysis, dedicated tests for
the confined-loop case, an explicit test proving the give-up case still
releases immediately (i.e. proof no deadlock was introduced), full
regression against the existing wave-reset/duplicate-edge test suite,
resume-mid-cycle correctness, and the unanalyzable-edge fallback path.
Existing tests using the plain no-escape retry-loop shape (e.g. the
staggered-reset tests in `tests/graph-superstep-executor.test.ts`) assert on
round/claim counts that this fix would change and would need re-auditing,
not just re-running.

It is also a **partial** fix by design — it only benefits the no-escape
retry idiom. Any workflow using retry-with-give-up gets zero benefit and
keeps today's behavior unchanged.

## 7. Decision (this session)

**Deferred.** No code changed. The graph-level workaround (§6.2, restore v4
pass gates) is the recommended immediate action for any graph that needs
"never happens" today, and does not require or wait on this document.

Revisit the narrower executor-level fix (§6.3) if the no-escape retry idiom
turns out common enough across graphs that per-graph gate-node boilerplate
becomes a recurring cost worth removing centrally. If picked back up, the
prerequisite is a full impact assessment and design pass with the same
rigor as `2f4cb5d5`, not an incremental patch on top of this document's
sketch.

## 8. References

- `extensions/graph-executor.ts` — `resolveEdges`, `computeNextFrontier`,
  `computeStaticClaims` (claim release, wave reset, readiness)
- `2f4cb5d5` — wave-reset per-source claim fix; the reason self-correction
  here is reliable rather than probabilistic
- `docs/PARALLEL-OPTIONA-GAP-ANALYSIS.md` — superstep/claims design context
- `tests/graph-superstep-executor.test.ts` — `staggeredResetScript` /
  `retryOnceRunner`, the closest existing test scaffold to this
  investigation's reproduction
- Third-party report: `create-input-json-v4-extractor-to-per-track-pass-to-assemble.md`,
  run `graph-1786775430267` (case 8907)
