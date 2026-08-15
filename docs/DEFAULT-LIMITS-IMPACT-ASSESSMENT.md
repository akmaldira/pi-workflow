# Impact Assessment: Bash-Tool Timeout Gate + Turn-Budget Enforcement (Revised)

**Status:** 📋 Assessment only — no code changed. **Supersedes the original
version of this document**, which proposed a default node-level timeout.
That approach was replaced after discussion: the user's original,
intentional design decision — `ask_user_question` waits are unbounded and
subagents themselves have no process-level timeout, specifically so an
important human question can never be missed — stands. A node-level timeout
would have put that decision at risk (see §0). The revised plan achieves the
same goal (stop a hung `find /`-style command from stalling a graph forever)
with a strictly smaller, more precise mechanism: **gate the `bash` tool's
own `timeout` parameter, not the agent process.**

**Revised scope:**
1. **Bash-tool timeout gate — default 10 minutes.** A `tool_call` hook sets
   `event.input.timeout = 600` (seconds) on any `bash` call where the model
   didn't specify one itself. The model can still explicitly request a
   longer timeout for a command it knows will legitimately take longer.
2. **Turn-budget enforcement** — unchanged from the prior assessment:
   default `{maxTurns: 50, graceTurns: 2}`, enforced child-side by blocking
   tools at the cap (same mechanism as the existing, live tool-budget
   feature), with a parent-side kill only as a last-resort backstop.
3. Docs (README `maxTurns` bug fix, frontmatter reference, skill).

**Dropped from scope:** the default node-level (process) timeout and its
human-question-pause workaround. Not needed — see §0.

---

## 0. Why the pivot removes an entire risk category

The original assessment's single largest risk was that a default node
timeout could kill a child while a human question was still pending,
because `ask_user_question` is deliberately `timeoutMs: Infinity`
(`channel.ts`) with no detach exemption for `kind: "human"` (only
`supervisor` questions detach). Mitigating that required a "pause the timer
while a human question is outstanding" mechanism — extra logic, an extra
failure mode (what if the pause check itself is wrong?), and a change to
behavior the user had deliberately designed in earlier.

**The bash-tool gate needs none of that**, verified directly against pi's
bash tool source (`dist/core/tools/bash.js`):

- `ask_user_question` is a **custom tool**, not `bash`. The gate hook only
  triggers on `event.toolName === "bash"`. It cannot see or affect
  `ask_user_question` calls in any way — there is no code path where the
  two interact.
- The agent process itself is never touched. Only the **spawned child
  process of one bash command** gets a bound. Nothing about `runSingleAgent`,
  detach, or the parent's wait changes.
- **The failure surfaces at exactly the granularity we want**: pi's own
  bash tool already implements timeout cleanly —
  `setTimeout(() => { timedOut = true; killProcessTree(child.pid); }, timeoutMs)`
  — then throws `Error("timeout:N")`, which the tool's `execute()` catches
  and re-throws as `Error("...Command timed out after N seconds")`. This
  becomes a normal `isError: true` tool result, indistinguishable in shape
  from "command exited with code 1". **The model sees it as an ordinary
  tool failure and can react** (try a different command — which is exactly
  what should have happened in the incident: the reviewer had the correct
  `cd apps/experiment && uv run python` command available and would very
  plausibly have used it once the wrong approach failed fast instead of
  hanging silently for the rest of the session).

This means the entire "misclassified as OOM crash" risk from the original
assessment's §1.1 **does not apply either** — that risk was specific to
killing the *node process* via `SIGKILL`, which trips `FATAL_KILL_SIGNALS`
in `failure-classifier.ts`. A bash-tool timeout never kills the node
process; it kills one child process tree that pi's own tool already knows
how to reap cleanly. The resulting tool-result error flows through the
**existing, already-working** "non-zero exit / tool failure → agent-level,
routable" path in the classifier — no classifier changes needed for this
piece at all.

## 1. Mechanism verification (against pi's actual source)

- `bashSchema` (`bash.js`): `timeout: Type.Optional(Type.Number({description: "Timeout in seconds (optional, no default timeout)"}))` — confirms no built-in default exists today, and that units are **seconds**, not ms.
- `resolveTimeoutMs`: converts to ms, validates `> 0` and finite, caps at `Number.MAX_SAFE_INTEGER`-scale (`2_147_483_647` ms, i.e. effectively no meaningful cap for our purposes).
- Extension surface confirmed in `docs/extensions.md`'s own worked example
  for exactly this pattern:
  ```ts
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      event.input.command = `source ~/.profile\n${event.input.command}`;
      if (event.input.command.includes("rm -rf")) {
        return { block: true, reason: "Dangerous command", terminate: true };
      }
    }
  });
  ```
  Mutating `event.input` in place for a `bash` call is documented, supported
  behavior — this is not a fragile or unofficial technique. Guarantees
  documented: "Mutations to `event.input` affect the actual tool execution",
  "No re-validation is performed after your mutation".

## 2. Design

```ts
pi.on("tool_call", (event) => {
  if (event.toolName === "bash" && event.input?.timeout === undefined) {
    event.input.timeout = 600; // seconds — 10 minutes, per requirement
  }
});
```

- **Only fills the gap.** A model-specified `timeout` (e.g. it deliberately
  requests 30 min for a known-long build) is never overridden — this
  matches the "agent frontmatter/explicit request always wins over
  defaults" principle applied at the tool-call level instead of the
  agent-config level.
- **Registered once, applies everywhere `bash` is available** — main agent,
  every subagent, nested levels — same "registered once per pi process, pi
  injects the extension path into every spawned child" mechanism already
  used by the blank-stop guard (`pi-args.ts` runtimeExtensions;
  `registerBlankStopGuard` pattern in `index.ts` is the template to follow).
- **Disable/override surface:** add `defaultBashTimeoutSeconds?: number | null`
  to `AgentSettings` (`agent-settings.ts`), same precedence pattern as
  `blankStopGuard` (`null` disables, absent → default applies). This lets a
  project raise or remove the default if it has commands that legitimately
  need longer and whose authors won't reliably pass `timeout` themselves.

## 3. Blast radius (this piece only)

| Consumer | Today | After change | Breaks? |
|---|---|---|---|
| `bash` tool, model-specified `timeout` | honored as given | unchanged (gate only fills gaps) | No |
| `bash` tool, no `timeout` given | unbounded | capped at 600s (or settings override) | New bound where none existed — intended, this is the fix |
| `ask_user_question` | `timeoutMs: Infinity`, no detach for human kind | **completely untouched** — different tool, hook scoped to `toolName === "bash"` | No interaction possible |
| `ask_supervisor` | detach on `expectsReply` | untouched | No interaction |
| Agent/subagent process lifetime | unbounded (by design) | unbounded (by design) — **unchanged**, exactly as the user intended | No |
| Failure classifier | bash non-zero exit → agent-level (existing path) | bash timeout → same existing agent-level path (new error text, same class) | No new branch needed |
| Graph nodes | a hung bash call stalls the node forever | a hung bash call fails after 10 min; node completes with a routable agent-level result the edge can act on | Fixes the actual incident |
| Plain `subagent` tool calls | same unbounded exposure | same fix applies (hook is process-wide, not graph-specific) | Bonus coverage, no extra work |
| Legitimate long-running commands (builds, big test suites, large `find` in a real narrow path) | unbounded | capped at 10 min unless the model explicitly passes a longer `timeout`, or the project raises the default via settings | **Real behavior change** — flagged below |
| Tests | none reference bash `timeout` defaults | new unit tests for the hook; no existing test depends on unbounded bash | No break found |

### 3.1 The one genuine risk: legitimate long bash commands

Unlike the dropped node-timeout plan, this real risk is narrow and
self-mitigating: models are not in the habit of passing `timeout` proactively
today (nothing has ever required it), so the *first* time a project hits a
genuinely long command (e.g. a slow `npm install`, a large test suite) it
will fail at 10 minutes with a clear, actionable error
("Command timed out after 600 seconds") rather than hang silently. The model
can retry with an explicit longer `timeout` in the same turn — this is a
one-command learning cost, not a systemic failure, and it is strictly better
than the status quo of an undetectable infinite hang. The project-level
settings override exists precisely for teams that hit this often enough to
want a higher default.

## 4. Turn-budget enforcement — unchanged from prior assessment

Everything from the original assessment's turn-budget analysis carries over
unmodified, since it was never about agent-level process timeouts:

- Turn count is **per node execution** — fresh on every retry/escalation
  (every execution is a new child process; verified in `execution.ts` /
  `runSingleAgent`). No counter persists across retries.
- Enforced **child-side**, copying the live, proven tool-budget mechanism
  (`subagent-prompt-runtime.ts`'s `registerToolBudget`): at `maxTurns`,
  block all tools with a wrap-up instruction ("produce your final answer
  now") so the model exits normally with real output — no kill in the
  common case.
- A parent-side kill remains only as a hard backstop at
  `maxTurns + graceTurns`, for a model that ignores the block entirely.
  **This is the only place a classifier-ordering fix is still needed**:
  `result.turnBudgetExceeded` must be set and checked in
  `classifySingleResultFailure` **before** the `aborted`/`FATAL_KILL_SIGNALS`
  checks, exactly as designed in the prior assessment — this part of that
  document's §1.1/§2 analysis is unchanged and still required.
- Frontmatter `turnBudget` always wins over the new default; resolved at
  the `runSingleAgent` choke point so both graph nodes and plain
  `subagent` tool calls get the same coverage (the plain-call gap identified
  in the prior assessment's §1.4 is still real and still fixed by this).
- **Bundled-agent policy question carries over unchanged**: `reviewer`
  (`{maxTurns: 12, graceTurns: 2}`) is tight relative to what a hard case can
  legitimately need — recommend raising to `{maxTurns: 20, graceTurns: 3}`
  before enforcement goes live. Still needs explicit sign-off.

## 5. Consumer-by-consumer for turn budget (unchanged table, restated for completeness)

| Consumer | Today | After change | Breaks? |
|---|---|---|---|
| Graph nodes | budget advisory only (dead import) | enforced, child-side block + backstop, routable | Behavior change, aligned with requirements |
| Plain `subagent` tool | frontmatter `turnBudget` silently ignored | same enforcement as graph nodes | New bound where none existed — intended |
| Detached children (post-`ask_supervisor`) | no budget interaction observed | child-side blocker still active inside the child; parent-side backstop timer does not apply post-detach (matches existing detach semantics — parent no longer supervises timing) | No change |
| Blank-stop guard | nudges add turns, uncounted | nudges now consume budget turns | No break; bounded interaction, an improvement |
| `maxIterations` (45 rounds) | outer bound on graph retries | unchanged | No change |
| Tool budget | live, unaffected | unaffected | No change |

## 6. Implementation plan

1. **Bash-tool timeout gate**: new small extension module (or addition to
   an existing tool-related one), registered once, `tool_call` hook scoped
   to `toolName === "bash"`, fills `timeout` only when absent, default 600
   seconds. Settings override key added to `AgentSettings`.
2. **Turn budget**: child-side enforcement via `TURN_BUDGET_ENV` (mirroring
   `TOOL_BUDGET_ENV`) plumbed through `pi-args.ts`; parent-side backstop
   kill + `turnBudgetExceeded` flag; classifier ordering fix (checked before
   `aborted`/signal/provider-error).
3. **Docs**: README custom-agent example fix (`maxTurns: 15` →
   `turnBudget: {...}`), frontmatter reference tables, `SKILL.md`, new
   settings keys documented, this assessment referenced from the PR.
4. **Tests**:
   - Bash gate: default injected when absent; model-specified timeout
     preserved; settings override; hook scoped to `bash` only (does not
     touch `ask_user_question`/`ask_supervisor`/other tools); works inside
     graph nodes and plain subagent calls alike (process-wide registration).
   - Turn budget: fresh-counter-per-execution; child-side block behavior;
     backstop kill path; classifier ordering (budget-exceeded not
     misclassified as aborted); frontmatter override on the previously-gap
     plain-subagent-tool path; settings disable.

## 7. Explicitly out of scope (unchanged)

- Guard changes (total nudge budget / escalation nudge) — rejected by user.
- Default node-level (process) timeout — **replaced by this document's
  bash-tool gate approach**; not implemented.
- Any change to `command`-node timeouts, tool budget, `maxIterations`,
  blank-stop guard, or `ask_user_question`/`ask_supervisor` semantics.
- Project-side mitigations (permission systems, prompting against
  `find /`) — owned by the project, not this extension.
