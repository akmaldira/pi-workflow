# Multi-Agent Coordination: Production Design

Status: **proposed, not yet implemented**
Author context: design discussion + research, see "Research basis" below
Audience: pi-workflow maintainers/contributors, and any team adopting pi-workflow for daily coding work

## 1. Problem statement

pi-workflow's `workflow` tool runs a script that calls `agent()`/`parallel()`/`pipeline()` in a
strictly forward data flow: plan → architect → red → green → reviewer, output of stage N feeds
stage N+1. In practice (ours and others', see Research basis) this breaks down in a specific,
recurring way:

1. An early-stage agent (planner/architect) produces a plan or contract that is *logically
   sound but underspecified or wrong* relative to what a later stage discovers when it actually
   tries to build against it.
2. The later agent (implementer) has no legitimate way to say "this is impossible as specified"
   and route the question back. Its only outcomes today are: succeed, silently return `null`
   (agent-level failure, swallowed), or throw (technical failure, aborts everything).
3. Under instruction-following pressure, the agent takes the path of least resistance: it mocks,
   stubs, or takes a shortcut to produce *something* that looks like success, rather than
   surfacing the real blocker.
4. Nothing downstream (a reviewer, an acceptance check) reliably catches this, because
   completion is largely self-reported (see `extensions/completion-guard.ts`, which currently
   just string-matches for words like "done" in the agent's own output).
5. There is no human in this loop at all today — a human can't be paged when an agent is
   genuinely stuck, and can't be the tiebreaker when two agents' claims conflict.

This document proposes a concrete, phased design to fix this, using primitives that are cheap to
build directly on pi-workflow's existing `vm`-sandboxed `workflow` engine — no external framework
dependency (see §7 for why).

## 2. Research basis (why these specific mechanisms, not others)

We evaluated LangGraph (both the JS/TS package and general graph-orchestration approach),
AutoGen/Microsoft Agent Framework, CrewAI, OpenAI Agents SDK, MetaGPT/ChatDev, and the general
actor-model pattern (XState). None are adopted (see §7). Instead, this design is built from
empirically-grounded patterns found during that research:

- **Blocked/escalate as a first-class outcome, not a failure.** AgentAsk (arXiv 2510.07593)
  treats every inter-agent handoff as a potential failure point and shows that inserting a
  targeted clarifying question at the handoff — only when needed — improves accuracy and
  robustness across coding/math/reasoning benchmarks, at **under 5% latency/cost overhead**.
  This is the strongest single piece of evidence behind §4.1.
- **A dedicated monitor/gate agent between planner and coder.** A 2026 study (arXiv 2510.10460)
  found the "planner-coder gap" — plan is sound but underspecified, coder misinterprets it —
  accounts for **75.3% of observed multi-agent coding failures**. Inserting a monitor agent that
  (a) explains the plan in more implementation-relevant detail and (b) validates generated code
  against the plan's intent repaired **40–89%** of identified failures. This is the basis for
  §4.2 (structured plan review gate) rather than a full standing coordinator from day one.
- **Mechanism over aspiration for contracts.** A real incident writeup (gosha70/code-copilot-team,
  "Plan Agent Contract Contradiction") documents a plan agent whose tool permissions *forbade*
  writes while shared rules told it to "emit" spec files — the contract was described in prose,
  not enforced by mechanism, and every downstream phase silently degraded instead of failing
  loudly. Root-cause language worth keeping: *"convention-by-aspiration vs.
  convention-by-mechanism."* This drives §4.3 (contract artifacts) and §4.5 (fail loud, not
  silent).
- **No agent grades its own homework.** Pact (jmcentire/pact) measured 79%→100% pass rate
  improvement on ICPC problems by making tests — not another agent's opinion — the sole judge of
  completion, with contracts-before-code as the enforced convention. This validates §4.4
  (independent verification) and confirms our existing `acceptance.ts` "verified" level is
  pointed the right direction, just not yet load-bearing everywhere.
- **A hard delegation-size threshold.** A production Claude Code plugin (coding-agent by Suraj
  Lab) found that without an explicit numeric threshold, an orchestrator will "quietly slide
  into implementation" itself. Their rule: >2 files or >30 lines forces delegation. This drives
  §4.6.
- **Anthropic's own agent-building guidance** explicitly recommends the *orchestrator-workers*
  topology (a central process dynamically delegates subtasks it can't predict in advance and
  synthesizes results) over heavier frameworks for exactly our situation — and explicitly warns
  against reaching for complex frameworks when simple composable patterns suffice. This is why
  every mechanism below is designed as an addition to the existing `agent()`/`workflow()`
  primitives, not a rewrite into a different execution model.

## 3. Design principles

1. **Escalation is a legitimate, first-class outcome — not a failure and not silent success.**
   An agent that identifies a real blocker and proposes how to resolve it should be *rewarded*
   by the system (its escalation gets routed and acted on), not punished (treated as it having
   failed the task).
2. **No agent adjudicates its own success.** Every "done" claim must be checked by something
   that has no stake in the claim being true — a different agent, a deterministic command, or a
   human. This generalizes the existing `acceptance.ts` "verified" level to be the default
   posture for implementation work, not an opt-in extra.
3. **Contracts are mechanisms, not prose.** Whatever a planner or architect promises must be
   checkable by code (file exists, matches schema, tool grants match described behavior), not
   just described in a system prompt and trusted.
4. **Fail loud, not silent.** A downstream stage that doesn't get the input it expects must
   raise, not quietly degrade to "proceed without it." (This is the single most repeated failure
   pattern across every real-world incident we researched.)
5. **The human is a participant, not just an approver of the final diff.** Specific, cheap
   escalation points exist where a human can be paged mid-run, not only at the very end.
6. **Build the smallest thing that empirically matters first.** We are not building a standing
   coordinator/actor system on day one. We are building the two mechanisms with the strongest
   direct evidence (escalation primitive, plan-review gate), then measuring before going further.

## 4. Phased design

### Phase 0 — Agent catalog: scaffolding + visibility

This phase exists because two things were wrong in the initial draft of this document, caught in
review and corrected here:

1. The `.pi/agents/*.md` files in this repo today (`planner`, `architect`, `monitor`, `red`,
   `green`, `reviewer`, plus the pre-existing `researcher`/`reviewer`/`scout`/`worker`) are
   **dev-time fixtures for this project's own test/dogfood setup, not something an installed
   copy of pi-workflow ships to a team's project.** `discoverAgents()`
   (`extensions/agents.ts`) only ever looks in `~/.pi/agent/agents` (user) and
   `<project>/.pi/agents` (project) — locations outside the installed npm package entirely. A
   team running `pi install npm:pi-workflow` today gets the tools/commands and **zero agents**;
   they'd have to hand-author every agent `.md` file themselves before any of Phases 1–6 is
   useful. That's a real gap this design failed to address, not something already solved.
2. The main pi agent — the one deciding *whether and how* to write a workflow script in the
   first place — has **no visibility into which agents exist** when it makes that decision. The
   `workflow` tool's `promptGuidelines` (`extensions/workflow-tool.ts`) explain `agent()`'s
   syntax but never enumerate available agents. The only place that catalog is surfaced today is
   the `/agents` command, which is a human-facing slash command (`ctx.ui.setWidget` output) —
   the LLM never sees it automatically. So while a *running script* can call any agent by name
   dynamically (this part was correctly analyzed in §10), the main agent choosing *which* agents
   a given task needs is working blind unless it happens to read the two agent directories
   itself, which nothing currently prompts it to do.

**What ships.**

1. **Bundled agent catalog + first-run scaffolding.** The package ships its own agent
   definitions in a `bundled-agents/` directory alongside `extensions/` (not under `.pi/agents/`,
   which is a discovery *location*, not a package-distribution mechanism). On `session_start`,
   the extension checks the project's `.pi/agents/` directory and copies in any bundled agent
   whose filename doesn't already exist there — non-destructively: never overwrites a file the
   team has since edited, renamed, or deliberately deleted. After the one-time copy, these are
   ordinary project agents, fully editable/removable like any other — nothing about them stays
   "owned" by the package once scaffolded. This directly answers your correction: they are
   **hardcoded, installed, ready-to-use agents**, not documentation examples a team has to
   reproduce by hand.
2. **Catalog-aware `workflow` tool description.** At the same `session_start` point where
   `discoverAgents()` is already called elsewhere in `index.ts`, build a compact roster string
   (name + one-line description per discovered agent, both user- and project-scope) and fold it
   into the `workflow` tool's `promptGuidelines` via `pi.registerTool()` (safe to call again —
   `pi.registerTool()` refreshes the tool's definition immediately in the same session per the
   extension API). This makes "here is who's available" ambient context every time the main
   agent considers using `workflow`, instead of something it has to go discover.
3. **`list_agents` tool** (distinct from the `/agents` *command*, which stays as the human-facing
   TUI view) — a small LLM-callable tool returning the same catalog on demand, for cases where
   the roster changed mid-session (a team added a new agent file) after the baked-in
   `promptGuidelines` snapshot from step 2 went stale.
4. **Explicit prompt guidance for composition, not just visibility.** Visibility alone doesn't
   guarantee the main agent varies its team per task rather than defaulting to the same shape out
   of habit. Add a `promptGuidelines` bullet along the lines of: "Before writing a workflow
   script, review the available agent catalog and select only the roles this specific task
   needs — do not default to running every catalog agent for every task; a one-file bug fix may
   need only `worker`, while a multi-component feature may need `planner → architect → monitor →
   red → green → reviewer` or a different subset entirely." This is the piece that actually
   answers "different task, different team" at the point where team composition is chosen, not
   just the (already-true) mechanical fact that a script *can* call any agent.

**Where in the codebase.**
- New `bundled-agents/*.md` directory, package-relative (resolved via `import.meta.url`, which
  jiti-loaded extensions can use to find their own install location — confirmed working; there is
  no existing pi mechanism for extensions to contribute a bundled agent search path the way
  `resources_discover` does for skill/prompt/theme paths, so scaffold-on-first-run is the correct
  approach here, not a missing engine feature to request upstream).
- `extensions/index.ts`'s existing `session_start` handler: add the scaffold-copy step (present
  vs. absent check per filename, copy if absent, skip if present — same idempotent pattern
  already used for `pi.setActiveTools()` in that same handler) and the catalog-string build step
  feeding into `pi.registerTool(workflowTool)`.
- New `extensions/agent-catalog.ts`: `scaffoldBundledAgents(projectDir)` (copy-if-absent),
  `buildAgentCatalogSummary(discovery)` (formats the roster string for `promptGuidelines`), and
  the `list_agents` tool definition — kept in a new file rather than growing `index.ts` further,
  consistent with the project's existing one-concern-per-file convention.

**Why this is Phase 0, not folded into Phase 1.** Every later phase assumes a team actually has
usable agents and the main agent can see them — without this, Phases 1–6 are correct in the
abstract but unusable in practice on a fresh install. It has zero dependency on the escalation
primitive (Phase 1) or anything else, so it can and should ship first, independent of every other
phase's timeline.

### Phase 1 — Escalation primitive (`agent()` third outcome)

**What.** Extend the subagent contract so an agent can report `blocked` instead of being forced
into success/failure. Concretely, a subagent's structured output gains a new shape:

```ts
// New result shape alongside the existing plain-string result.
interface AgentBlockedResult {
  status: "blocked";
  blockedOn?: string;       // suggested role/agent name to route to, e.g. "architect"
  reason: string;           // what specifically is contradictory/impossible
  evidence?: string[];      // concrete pointers: file:line, failing command output, etc.
  proposedFix?: string;     // the agent's own best guess at a resolution, if it has one
}
```

The child process signals this the same way it already signals structured output today (see
`extensions/structured-output.ts` / `readStructuredOutput`) — a well-known tool call or
sentinel file the harness reads back, not a new IPC channel. `runSubagentForWorkflow` /
`execution.ts` decode it and hand it back to `workflow.ts`'s `agent()` as a distinguishable
return value (not a string, not `null`, not a thrown error).

**Where in the codebase.**
- `extensions/structured-output.ts`: add the `blocked` shape alongside existing single-output
  handling.
- `extensions/workflow.ts`'s `agent()`: currently returns `Promise<string>` on success, `null` on
  agent-level failure (swallowed in the `catch`), rethrows `TechnicalFailureError`. Add a third
  branch: if the child reports `blocked`, return the `AgentBlockedResult` object as-is (still a
  successful `agent()` call, script author decides what to do with it) rather than treating it as
  an error.
- Workflow scripts opt into handling it: `const r = await agent(...)`; `if (r && typeof r ===
  "object" && r.status === "blocked") { ... }`. No change required to scripts that don't care —
  they'll just get an object instead of a string if they don't check, which is a script-authoring
  concern, not a runtime one. (Longer term, `workflow-api.md` reference doc gets a helper like
  `isBlocked(result)` to make this ergonomic.)
- Agent frontmatter: add an optional `canEscalate: true` (default true) so a specific agent type
  can be pinned to never escalate (e.g. a pure read-only reviewer that should never claim to be
  blocked on writing something it was never asked to write).

**Why this is safe to ship first.** It's purely additive — no existing script behavior changes,
`agent()`'s existing string/`null`/throw contract is untouched, this is a new possible return
shape. Matches the "under 5% overhead, plug-and-play" profile from the AgentAsk research: cheap,
isolated, no dependency on any of the later phases.

**What a workflow script looks like using it (illustrative, TDD example from our discussion):**

```js
export const meta = { name: "tdd_feature", description: "plan -> architect -> red -> green -> review" };

phase("plan");
const plan = await agent("planner: draft implementation plan for X");

phase("architect");
let contract = await agent(`architect: design interfaces for: ${plan}`);

phase("red");
const tests = await agent(`red: write failing tests against contract:\n${contract}`);

phase("green");
let attempt = 0;
let green = await agent(`green: implement to pass tests:\n${tests}`);

while (green?.status === "blocked" && attempt < 2) {
  attempt++;
  log(`green blocked: ${green.reason}`);
  // Route the escalation back to whoever it names (or architect by default)
  const target = green.blockedOn || "architect";
  const resolution = await agent(`${target}: green implementer reports a blocker:\n${green.reason}\n\nEvidence: ${green.evidence?.join("\n")}\n\nProposed fix: ${green.proposedFix}\n\nPlease revise the contract or clarify.`);
  contract = resolution; // contract artifact gets updated, see Phase 3
  green = await agent(`green: implement to pass tests (contract revised):\n${tests}\n\nRevised contract:\n${contract}`);
}
```

This is the direct fix for the exact scenario you described: green hits a wall, escalates to
architect by name, gets a revision, retries — instead of mocking to escape the deadlock. Note
this is still just JS control flow in the existing sandbox — no new execution model.

### Phase 2 — Plan review gate (monitor agent between planner and coder)

**What.** Before an implementer stage starts, an independent gate reviews the plan/contract for
structural feasibility and intent-fidelity, and can send it back for revision *before* real
implementation work begins — catching the "red hits a wall" scenario at the cheapest possible
point (before red exists), per the 75.3%-of-failures finding.

This is **not** the planner dry-running its own plan (see the "planner shouldn't grade its own
plan" conclusion from our discussion) — it's a distinct, disinterested role.

**Where in the codebase.**
- New optional workflow helper: `reviewPlan(planText, options)` — a thin wrapper around `agent()`
  that spawns a `monitor` (or user-named) agent whose sole job is: does this plan reference real
  files/symbols in the repo, are its interfaces internally consistent, does it look
  implementable as stated. Returns the same `blocked`-or-approved shape as Phase 1, so it
  composes with the same retry-loop pattern.
- The `monitor` agent this phase needs already exists by this point — it's one of the six bundled,
  auto-scaffolded roles from Phase 0 (§9), with frontmatter scoped to read-only tools plus repo
  search; it must never be able to write, only assess. Phase 2 adds no new agent file of its own.
- This is otherwise a **script-level convention**, not a new engine feature — Phase 2 needs zero
  changes to `workflow.ts`'s runtime once Phase 1 ships. It's a documented pattern (`SKILL.md`
  gets a new "Plan review gate" section) plus the optional `reviewPlan()` helper.

**Why phase 2, not phase 1.** It only pays off once Phase 1's escalation shape exists (the
monitor's "send it back" signal *is* a `blocked` result), so it's sequenced after.

### Phase 3 — Contract artifacts (mechanism, not prose)

**What.** When a workflow revises a plan/contract in response to an escalation (Phase 1's loop),
that revision should be a real, inspectable artifact with a changelog — not just a string that
gets threaded through subsequent prompts and then disappears from view.

**Where in the codebase.**
- Reuse the existing `.pi-workflow/artifacts/` infrastructure (`extensions/artifacts.ts`, already
  writes `input.md`/`output.md`/`events.jsonl`/`transcript.jsonl`/`metadata.json` per agent run)
  — add a new artifact kind, `contract.md`, written per-workflow-run (not per-agent), with each
  revision appended as a dated section rather than overwritten. New helper:
  `writeContractRevision(runCwd, runId, revisionText, reason)` in `artifacts.ts`.
- New optional `contract` global exposed inside the workflow sandbox (alongside `agent`,
  `parallel`, `pipeline`, `log`, `phase`, `budget`) with `contract.read()` / `contract.revise(text,
  reason)`. This makes "read the live contract, not the stale prompt text" a first-class
  operation scripts can use, and gives the `/workflows` TUI a natural place to surface "contract
  was revised — see diff" during a run (reusing the existing live-JSONL-transcript display
  machinery already built for agent output).
- No change to `runWorkflow()`'s core loop — this is a new sandboxed global function alongside
  the existing ones, following the same pattern as `budget` (`Object.freeze({...})` passed into
  `vm.createContext`).

**Why this matters even though it's "just a file".** Per the code-copilot-team incident:
contracts described only in prose drift silently. Writing the contract to disk with a visible
revision history means (a) it's inspectable after the fact for debugging exactly like a real
design doc, (b) a human watching the `/workflows` TUI can see a contract changed mid-run and
intervene, (c) it gives Phase 2's monitor agent something concrete to diff against on each pass
instead of re-reading a wall of prompt text.

### Phase 4 — Independent, non-bypassable completion verification

**What.** Tighten `extensions/completion-guard.ts` and `extensions/acceptance.ts` so that
implementation-intent agent runs (per `extensions/task-intent.ts`'s existing
`classifyTaskMutationIntent`) default to acceptance level `checked` or `verified` rather than
relying on `evaluateCompletionMutationGuard`'s current keyword-matching self-report, which
provides no actual signal (an agent that mocks something and says "all done" passes it exactly as
well as one that did the work correctly — this is a real, demonstrated gap in the current code,
not a hypothetical).

**Where in the codebase.**
- `extensions/task-intent.ts`'s `taskMayMutate()` already classifies whether a task looks like
  implementation work. Wire its result into `resolveEffectiveAcceptance()`
  (`extensions/acceptance.ts`) as an additional signal for auto-inferred acceptance level, not
  just the existing agent-name regex (`/\bworker\b/`).
- `evaluateCompletionMutationGuard` should stop being used as a completion signal on its own; at
  most it's a cheap pre-filter, with the real gate being `acceptance.ts`'s `verify` commands
  (already-existing `AcceptanceVerifyCommand` — actual shell commands like `npm test`, executed
  and checked, not self-reported).
- Document in `SKILL.md`: for any agent whose task classifies as `implementation`, default
  `acceptance: "checked"` unless the caller explicitly opts down (mirrors Pact's "tests are the
  only judge" philosophy, using our existing verify-command machinery rather than adding a new
  one).

**Why this is additive, not a breaking change.** `acceptance.ts` already has the full
`attested`/`checked`/`verified` level machinery and `resolveEffectiveAcceptance()` auto-inference
hook — this phase changes *inference defaults and wiring*, not the acceptance system's shape.

### Phase 5 — Delegation-size threshold + human escalation points

**What.** Two small, concrete guardrails, cheap to add, high leverage per the research:

1. **Hard delegation threshold.** When the *main* pi session (not a subagent) is about to
   directly write/edit more than N files or M lines in one turn, `/workflow` mode (already
   shipped, see `extensions/workflow-mode.ts`) should be the recommended/nudged path — surfaced
   as a `before_agent_start` or `tool_call` advisory, not a hard block, since pi-workflow's
   existing philosophy is budget *tracking* not enforcement. Exact thresholds configurable, default
   mirrors coding-agent's finding (2 files / 30 lines).
2. **Human escalation as a workflow primitive.** New optional sandboxed global,
   `askHuman(question, options)`, backed by `ctx.ui.confirm`/`ctx.ui.select`/`ctx.ui.input`
   (already used elsewhere in the codebase, e.g. `extensions/index.ts`'s `confirmProjectAgents`
   flow) when `ctx.hasUI` is true. When a `blocked` result (Phase 1) exhausts its retry budget
   without resolution, or when a workflow script explicitly wants a human decision (e.g. "approve
   this destructive action", "pick between two valid interpretations"), it calls `askHuman()`
   instead of silently giving up or guessing. In headless/`--mode json` runs (`ctx.hasUI ===
   false`), `askHuman()` degrades to: log the question, return the caller-provided `default`, and
   flag it prominently in the final workflow result summary — never hangs indefinitely, per the
   existing headless-mode caveat already documented in `SKILL.md`.

**Where in the codebase.**
- `extensions/workflow-tool.ts`: `createWorkflowTool()` already receives `ctx` and constructs
  `runWorkflow()`'s options — thread `ctx.ui` down as a new `WorkflowRunOptions.ui` field (only
  `confirm`/`select`/`input`/`notify`, matching the subset already used).
- `extensions/workflow.ts`: `askHuman` global added to `vm.createContext(...)` alongside the
  others, implemented via the threaded `ui` option with the headless-degrade behavior above.

**Scope note: pi-native only.** `askHuman()` is deliberately scoped to pi's own UI surface
(`ctx.ui`) and nothing else — no Slack webhook, no external notification channel, no separate
approval service. This keeps the mechanism dependency-free and consistent with running entirely
inside a `pi` session (TUI or headless), which is the only environment this project targets. If a
team later wants remote/async approval (e.g. paging someone not at the terminal), that's a
separate integration a team can layer on top of `askHuman()`'s existing `ctx.hasUI === false`
degrade path themselves — not something this design needs to build or maintain.

### Phase 6 (later, not now) — Standing coordinator / actor model

This is the "wild" tier from our earlier discussion: persistent, addressable agents with an
inbox, a coordinator with authority to re-staff and re-route, dynamic team composition,
synchronous "war rooms" for high-severity conflicts. We are explicitly **not** building this now.

Reasons to defer:
- Phases 1–5 directly address the concrete failure mode described (plan/contract not catching up
  to reality, implementer stuck with no legitimate way out) with much less new surface area, and
  have direct empirical backing for the *specific* mechanisms (escalation primitive, monitor
  gate) rather than the *general* approach (standing coordinator).
- A standing coordinator introduces real new failure modes of its own (ping-pong escalation
  loops, a coordinator that becomes a bottleneck or gets confused) that are exactly as hard to
  debug as the problem it's meant to solve, and we have no evidence yet that Phases 1–5 are
  insufficient.
- If we do build it later, XState (see §7) is the one piece of external, dependency-light,
  LLM-agnostic infrastructure worth evaluating for the actor/mailbox substrate — but that's a
  separate future design doc, gated on Phases 1–5 being shipped, used, and found wanting.

## 5. What ships in what order

| Phase | New engine surface | New docs/examples | Depends on |
|---|---|---|---|
| 0. Agent catalog: scaffolding + visibility | `bundled-agents/*.md`, `scaffoldBundledAgents()`, `buildAgentCatalogSummary()`, `list_agents` tool in new `agent-catalog.ts` | README/SKILL.md: bundled roster list, first-run scaffolding note | none |
| 1. Escalation primitive | `AgentBlockedResult` shape in `structured-output.ts`, third `agent()` return branch in `workflow.ts` | `workflow-api.md`: `isBlocked()` helper, escalation-loop example | none |
| 2. Plan review gate | none (pure script convention) | `SKILL.md` "Plan review gate" section | Phase 1 (+ Phase 0 for the `monitor` agent to exist) |
| 3. Contract artifacts | `contract` sandboxed global, `writeContractRevision()` in `artifacts.ts` | `workflow-api.md`: `contract.read()/revise()` reference | Phase 1 (revisions are usually escalation responses) |
| 4. Verification tightening | `taskMayMutate()` wired into `resolveEffectiveAcceptance()` | `SKILL.md`: default acceptance for implementation tasks | none (independent of 0–3) |
| 5. Human escalation + delegation threshold | `askHuman` sandboxed global, `ui` threaded into `WorkflowRunOptions` | `SKILL.md`: `askHuman()` reference, headless-degrade behavior | Phase 1 (mainly triggered by exhausted `blocked` retries) |
| 6. Standing coordinator | — deferred — | — deferred — | 0–5 shipped + real usage evidence |

Phase 0 has no dependency on anything and should ship first — every later phase assumes a team
already has usable, visible agents. Phases 1 and 4 have no interdependency and can be built in
parallel once Phase 0 lands. Phase 2 and 3 both build on Phase 1's shape (Phase 2 additionally
needs Phase 0's `monitor` agent to exist). Phase 5 is mostly independent but its most common
trigger (exhausted blocked retries) is more useful once Phase 1 exists.

## 6. Testing strategy

Following the project's existing convention (every extension module has a matching
`tests/*.test.ts`, currently 530 tests across 32 files):

- **Phase 0**: unit tests for `scaffoldBundledAgents()` (copies missing files, never overwrites
  an existing file with the same name, idempotent on repeated calls); unit tests for
  `buildAgentCatalogSummary()` (formats a `discoverAgents()` result into the expected
  `promptGuidelines` string, handles zero-agents and many-agents cases); unit tests for the
  `list_agents` tool (returns current catalog, reflects agents added after the tool was first
  registered — this is the main reason it exists alongside the baked-in snapshot).
- **Phase 1**: unit tests for the new `agent()` branch (mock `agentRunner.run()` returning a
  `blocked` shape, assert `agent()` returns it un-thrown, un-swallowed); unit tests for
  `structured-output.ts`'s new decode path.
- **Phase 2**: no new runtime tests needed (pure convention); integration test using the existing
  mock-`pi`-harness pattern (see `tests/workflow-mode.test.ts`) to verify the bundled `monitor.md`
  agent (shipped via Phase 0) parses correctly via `discoverAgents()`.
- **Phase 3**: unit tests for `writeContractRevision()` (append-not-overwrite behavior, changelog
  format); unit tests for the `contract` sandboxed global (mirrors existing `budget` global
  tests).
- **Phase 4**: unit tests for `resolveEffectiveAcceptance()`'s new `taskMayMutate()` wiring
  (already has a test file, extend it).
- **Phase 5**: unit tests for `askHuman()`'s headless-degrade path (`ctx.hasUI === false` →
  returns default, never hangs) — this is the one with the highest risk of a silent bug (a hang in
  headless mode), so needs explicit coverage; TUI-path tests can mock `ui.select`/`ui.confirm`
  the same way `tests/workflow-mode.test.ts` mocks `pi`.
- Add one **end-to-end scenario test** modeling the exact TDD case from our discussion: a fake
  `agentRunner` where the "green" stage returns `blocked` on the first call and succeeds on the
  second (after a simulated architect revision), asserting the workflow's final result reflects
  the retry, not a silent mock/failure.

## 7. Why not adopt an existing framework (recap of research findings)

- **LangGraph (JS/TS, `@langchain/langgraph`)**: requires `@langchain/core` as a mandatory peer
  dependency, which pulls in `js-tiktoken`, `langsmith`, `zod`, `mustache`, `p-queue`, and a full
  message/prompt/runnable object model. There is no "just the graph" npm package independent of
  that — the "you don't need LangChain to use LangGraph" claim refers to the higher-level
  `langchain` package, not `@langchain/core`. This is exactly the "big framework we don't need"
  problem stated up front. The genuinely useful ideas (`interrupt()`/`Command(resume=...)`,
  checkpointer-by-thread-id) are cheap to reimplement directly on our own `vm` sandbox + journal
  without the dependency (see Phase 5's `askHuman()`, which is our version of `interrupt()`).
- **AutoGen/Microsoft Agent Framework, CrewAI, OpenAI Agents SDK, Claude Agent SDK**: same
  category — Python-or-heavier-JS frameworks with their own object models, none closer fits than
  what pi already gives us as a CLI-subprocess agent harness.
- **MetaGPT/ChatDev**: not adoptable directly (Python, tied to their own agent runtime), but their
  founding motivation (structured artifacts over lossy prose handoffs) directly informs Phase 3.
- **XState**: the one piece of external infra judged worth a future look, specifically for the
  deferred Phase 6 actor/mailbox substrate — it's dependency-light and has no LLM-specific
  coupling, unlike everything else evaluated. Not needed for Phases 1–5.
- **Anthropic's "Building Effective Agents"**: explicitly recommends composable patterns over
  frameworks and specifically endorses the orchestrator-workers topology we already have — this
  design keeps that shape and extends it, rather than replacing it.

## 8. Decisions (resolved)

These were open questions in the initial draft; resolved by the team:

1. **No external escalation channels.** `askHuman()` is pi-native only (`ctx.ui`) — no Slack,
   webhook, or other external notification integration in scope, ever, unless a specific team
   builds it themselves on top of the degrade path. Keeps the mechanism dependency-free. See the
   "Scope note: pi-native only" callout in Phase 5.
2. **`contract.md` is per-run.** One contract file per workflow run
   (`.pi-workflow/artifacts/runs/<runId>/contract.md`), matching the existing per-run artifact
   convention (`getArtifactPaths()` in `artifacts.ts`). No cross-run/project-level contract —
   if a team wants a decision to persist across runs, that's an explicit human action (copy
   relevant context into the next run's initial prompt or a checked-in doc), not something the
   engine does automatically.
3. **Pre-built agent catalog ships with the package, bundled and auto-scaffolded, not just
   documented.** See §9 below and Phase 0 — planner, architect, monitor, red, green, and reviewer
   agents ship inside the package and are copied into a team's `.pi/agents/` automatically on
   first run, so a team gets a working roster immediately after `pi install`, not a "write your
   own from these examples" exercise.

Phase 2's monitor agent (and the other new catalog roles in §9) still need real prompt tuning
through actual dogfooding on a live TDD-style workflow before being considered production-ready
— shipping the frontmatter files is necessary but not sufficient; Phase 2 isn't "done" until
someone has run it against a real feature and the escalation loop actually resolved a genuine
contract mismatch, not just passed a unit test of the plumbing.

## 9. Pre-built agent catalog

Correction from the initial draft: these are **not documentation examples a team reproduces by
hand** — per Phase 0, they are bundled `.md` files that ship inside the pi-workflow package and
get copied into a team's `.pi/agents/` automatically on first run (scaffold-if-absent, never
overwrite). A team that runs `pi install npm:pi-workflow` gets all six roles below, ready to use,
without writing a single frontmatter file themselves. From that point on they behave exactly like
any other project agent — fully theirs to edit, rename, or delete; nothing about them stays
"owned" by the package after the one-time scaffold copy, and nothing about them is special-cased
in the engine (`discoverAgents()`/`AgentConfig` treat them identically to a hand-authored agent).

These are a **starting roster, not a fixed cast** — see §10 for how the *main agent* selects a
task-appropriate subset of them (or agents a team has added beyond this set) per run, rather than
always using all of them or always using the same subset.

| Agent | Role | Tools | Notes |
|---|---|---|---|
| `planner` | Decomposes a task into a plan; read-only, no implementation | read-only (`read`, `grep`, `find`, `ls`) | Never given write tools, so it structurally cannot slide into implementation (mirrors coding-agent's finding). |
| `architect` | Turns a plan into concrete interfaces/contracts | read-only + `contract.revise()` (Phase 3) | Owns the contract artifact; the only role that should call `contract.revise()` in a typical script, by convention not enforcement. |
| `monitor` | Independent plan-feasibility gate (Phase 2) | read-only, repo search | Never implements, never grades its own output — reviews architect's contract before implementation starts. |
| `red` | Writes failing tests against a contract | `read`, `write` (tests only, by prompt convention), `bash` (test runner) | Scoped by prompt to test files. |
| `green` | Implements to make tests pass | `read`, `write`, `edit`, `bash` | The role most likely to hit the "blocked" case (Phase 1) — its frontmatter should have `canEscalate: true` (the default). |
| `reviewer` | Independent code review, no self-grading | read-only | Included in the bundled set for discoverability alongside the newer roles above. |

A team is expected to add their own roles to this roster over time (a `security_specialist`, a
`migration_specialist`, a domain-specific reviewer) the same way they'd add any project agent —
the bundled six are a floor to get started productively on day one, not a ceiling.

## 10. Does this design support dynamically assembling a team per problem?

Corrected answer from the initial draft: **partially yes, partially no — and the initial draft
overclaimed on the "yes" part by only checking one of the two capabilities this actually
requires.** There are three distinct tiers here, worth separating precisely:

**Tier 1 — a running script can call any agent dynamically. (True, already, unchanged from the
initial draft.)** `agent()`'s resolution (`resolveAgent()` in `extensions/workflow-tool.ts`)
looks up any discovered agent by name on every call — there's no fixed "team" object instantiated
once at the start of a run. A script can branch mid-run and call an agent it didn't use earlier,
including one named by an escalation's `blockedOn` field that wasn't part of the original plan:

```js
// Illustrative: team composition decided at runtime, not hardcoded upfront
const plan = await agent("planner: ...");

// Only bring in a security specialist if the plan actually touches auth
const needsSecurityReview = /auth|session|token|password/i.test(plan);
let contract = await agent("architect: design interfaces for: " + plan);
if (needsSecurityReview) {
  contract = await agent("security_specialist: review this contract for auth concerns:\n" + contract);
}

// If green escalates to a role that wasn't in the original team, just call it —
// agent() resolves by name from the full discovered agent catalog every time,
// there's no pre-declared roster to update.
let green = await agent("green: implement:\n" + contract);
if (green?.status === "blocked") {
  const target = green.blockedOn || "architect"; // could name ANY discovered agent, not just the ones used so far
  contract = await agent(`${target}: green is blocked:\n${green.reason}`);
  green = await agent("green: retry:\n" + contract);
}
```

**Tier 2 — the main agent can see and choose an appropriate subset of the roster before writing
the script. (False as originally designed — this is exactly the gap you caught. Fixed by Phase
0.)** Tier 1 being true says nothing about whether the *main pi agent*, at the point it decides
whether and how to write a workflow script, actually knows the roster exists or is prompted to
vary its choice per task. Before Phase 0, the `workflow` tool's guidelines describe `agent()`'s
syntax but never enumerate available agents, and the only catalog view (`/agents`) is a
human-facing command the LLM never sees automatically — so in practice the main agent was either
guessing agent names or defaulting to habitually reaching for the same one or two it happened to
remember, regardless of what the task actually needed. Phase 0 closes this specific gap: a
catalog summary baked into the `workflow` tool's guidelines, a `list_agents` tool for on-demand
refresh, and an explicit instruction to select a task-appropriate subset rather than defaulting.
With Phase 0 shipped, tiers 1 and 2 together are what actually deliver "different task, different
team" — a bug fix might get `worker` alone, a multi-component feature might get `planner →
architect → monitor → red → green → reviewer`, a schema change might additionally pull in a
`migration_specialist` a team added beyond the bundled six (§9) — with the *choice* made
knowingly by the main agent reading the catalog, not by accident or by only ever remembering the
same names.

**Tier 3 — the system decides team composition for you, autonomously, without any human or script
author having written that branch in advance, and can synthesize entirely new agent roles on the
fly. (Not supported, and deliberately out of scope — this is Phase 6 territory, unchanged from
the initial draft.)** This is the more radical version from our earlier "wild" discussion: a
standing coordinator that looks at an unfamiliar problem and decides on its own "this needs a
role that doesn't exist yet," authors a new agent definition, and adds it to the roster mid-run
without a human or script author having anticipated that possibility at all. That requires
something with actual staffing *authority* at runtime, not just visibility — a materially
different, larger piece of infrastructure than Phase 0's "make the existing choice informed"
fix. Deferred for the same reasons as before: no evidence yet that Tiers 1+2 are insufficient,
and it introduces its own new failure modes (an agent inventing unnecessary specialist roles,
cost/scope creep) that need their own design work, not a quick add-on here.

**Summary of what changed in this correction.** The initial draft answered "yes" based on Tier 1
alone and didn't check Tier 2 at all — which is the tier that actually matters for "when the main
agent is given a task, it can compose the team that task needs," since Tier 1 only governs what a
script can do *after* the main agent has already decided what to write. Tier 2 is now Phase 0,
sequenced first, with no dependency on any other phase. Tier 3 remains correctly deferred to
Phase 6.
