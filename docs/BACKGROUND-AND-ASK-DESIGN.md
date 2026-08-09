# Background Runs, the Request Broker, and Asking for Judgement

Status: **design agreed, implementation pending**
Supersedes: the `mainAgent()` node type (removed by this design)

---

## 1. The problem this fixes

Today a workflow run is a blocking tool call. The main agent sits inside `workflow`'s
`execute()` until the whole graph finishes. Three things follow from that, and all three
are wrong:

**`mainAgent()` is a lie.** The node type claims to hand a decision back to the main agent
mid-run. It cannot: the main agent is blocked inside the tool call that started the run, so
it has no turn in which to think. `graph-interactive.ts` says so in its own comment —
*"Since a tool cannot re-enter its own agent loop, the checkpoint is surfaced to the human
on the main agent's behalf: they answer as the session would."* It is a second `human()`
wearing a different label.

**Questions are modelled as topology.** An agent that needs to ask something has to escalate
to a `human()` node, and then an edge has to route the answer *back* to the asking node,
which re-enters and must reconstruct "why am I here again" from `state`. The question's
context lives in the agent's session; the answer arrives in the graph's state. Wrong place.
A question is not a routing decision.

**The user is blocked.** A twenty-minute graph is twenty minutes during which the user
cannot use their agent.

The fix has three parts: runs go to the background, a **broker** carries requests for
judgement between processes, and questions become **tools** rather than nodes.

---

## 2. Architecture

Subagents are separate OS processes (`spawn` of the pi CLI). The graph executor runs
in-process inside the extension. So there are two distances to cover, and they need
different transports:

```
  ┌─────────────────────── parent process (extension) ───────────────────────┐
  │                                                                          │
  │   graph executor ──────────────► RequestBroker ──┬──► ctx.ui  (the user)  │
  │   human() node ────────────────►      ▲          │                        │
  │                                       │          └──► sendMessage +       │
  │                                  fs poller            workflow_reply      │
  │                                       ▲               (the main agent)    │
  └───────────────────────────────────────┼──────────────────────────────────┘
                                          │  .pi-workflow/channels/<runId>/
                    ┌─────────────────────┴─────────────────────┐
                    │  child pi process (a subagent)            │
                    │    ask_human      ─┐                      │
                    │    ask_supervisor ─┴─► fs channel client  │
                    └───────────────────────────────────────────┘
```

One broker. Two inbound transports (direct call, filesystem). Two outbound sinks (the user's
TUI, the main agent's conversation). Every feature below is a (source, sink) pair over this
broker.

### Why the filesystem for the child leg

It is not a lazy choice. Child agents are separate processes, so "in-process" is not
available; the only question is which IPC transport.

| Transport | Assessment |
|---|---|
| **Filesystem + polling** | Chosen. Proven in `pi-subagents`. Survives a crashed child (leaves a readable artifact, not a dangling FD). Debuggable with `cat`. |
| stdio | The child's stdout is already the JSONL protocol stream and stdin carries the task. Multiplexing request/reply through it means a framing protocol on a stream parsed for two other purposes. Fragile. |
| Unix socket / named pipe | Cleaner than polling, but still a filesystem path that can be orphaned — the same reset concern, plus more failure modes (EPIPE, half-open). |
| localhost HTTP | Port allocation, auth, firewall. Worse on every axis. |

The reset concern is answered by placement and lifecycle, not by transport choice:

- Channel dirs live at `.pi-workflow/channels/<runId>/` — the **same tree** as journals and
  sessions, so anything that cleans that tree cleans these.
- Deleted on run completion, in a `finally`.
- **Startup sweep**: on extension load, any `channels/<runId>/` whose run is not active is
  deleted. Restarting pi is a full reset.
- Age sweep for channels belonging to no known run.
- `/workflows` gains a `Clear stale channels` action.

Crucially, **the `human()` node and the executor never touch the filesystem** — they are in
the parent process and call `broker.ask()` directly. The fs leg is one adapter behind the
broker interface, not the architecture.

---

## 3. Background execution

There is no foreground mode. A `background` parameter would create a matrix of "does this
feature work in this mode", a dual code path in the tool, and a double-delivery guard, in
exchange for a mode in which `ask_supervisor` provably cannot work.

`workflow` parses and validates the script, starts the run, and returns immediately:

```
Workflow "tdd_feature" started in the background.
  runId: tdd-feature-a3f91c
  nodes: architect → red → green → reviewer
You will be notified when it completes. Use workflow_status to check on it meanwhile.
```

The turn ends. The user is free.

**The graph's return value stops being the tool result.** It arrives later as an injected
message:

```ts
pi.sendMessage(
  { customType: "workflow-result", content, display: true },
  { triggerTurn: true, deliverAs: "followUp" },
);
```

`deliverAs: "followUp"` means that if the user is mid-turn, the result is queued and
delivered after — never interrupting. `triggerTurn: true` makes the main agent actually
act on it rather than merely displaying it.

Because the result no longer returns inline, the delivered message must carry everything
the tool result carries today: final state, per-node summary, failure reason, token spend.

Delivery is installed once (`installResultDelivery`) and is idempotent across `/reload` via
a flag plus a mutable holder on the manager, since the manager outlives extension
generations.

### Concurrent runs

Allowed, with limits. Our journal, sessions, and navigator are already `runId`-keyed, so
there is no collision at the storage layer. But there are four real costs:

- **Worktree collision** — two runs touching the same paths.
- **Budget** — token budget is per-run; N runs is N× spend with no global view.
- **TUI contention** — two runs both wanting a dialog. The broker queues them, so every
  dialog title carries `[run: tdd-a3f]` to say who is asking.
- **Process count** — 3 runs × 4-wide fan-out = 12 child pi processes.

Therefore: **`maxConcurrentRuns`, default 3**, settings-tunable. The 4th is rejected with an
error listing the active runs. A **same-name guard** rejects starting `tdd` while `tdd` is
already running unless explicitly overridden — that case is almost always an accidental
double-submit.

---

## 4. The request broker

One record type covers every kind of request:

```ts
interface PendingRequest {
  id: string;
  runId: string;
  nodeId?: string;
  agent?: string;
  kind: "human" | "supervisor";
  questions: Question[];        // 1..4; the human node uses exactly one
  expectsReply: boolean;        // false = fire-and-forget progress note
  createdAt: number;
  expiresAt?: number;           // supervisor only — see below
}
```

**FIFO queue.** Dialogs are modal, so only one may be open. Concurrent asks queue.

**Coalescing window (~300ms).** Requests arriving within the window of an opening dialog
join it as extra tabs, since the dialog is already multi-question. This catches the common
case — a fan-out where several agents ask at once — cheaply. Asks arriving later still queue.

**Journaling.** Every request and answer is journaled with its `source`
(`human` / `default` / `cancelled` / `supervisor` / `timeout`), so `/workflows` can show it
and resume can replay it.

### Expiry: asymmetric on purpose

**Human requests never expire.** The user is watching the run; a countdown that silently
picks a default while they are reading the question is hostile. Escape hatches are explicit:
dismissing the dialog (Esc) makes a `human()` node fall to its `default` and makes
`ask_human` return `cancelled: true`. The run remains abortable from `/workflows`.

**Supervisor requests expire (default 10 min).** The main agent receives the question via
a `workflow-agent-question` message and MUST answer using the `workflow_reply` tool — replying
in prose does not reach the child. To make this unambiguous:

- The message text uses `**Mandatory action required:**` and explicitly says `You MUST call the workflow_reply tool`.
- The `workflow_reply` tool has `promptSnippet` and `promptGuidelines` in its definition, and is activated via `setActiveTools` on `session_start` so those guidelines are included in the system prompt.

On expiry the child receives *"No supervisor answer within Xs; proceed on your best judgement or emit BLOCKED_ON."* Pending supervisor requests appear in the `/wf` status widget so a stuck one is visible rather than silent.

---

## 5. `human()` node vs `ask_human` tool — the distinction

These look similar and are not. Getting this wrong is how the current design went wrong, so
the boundary is stated once here and repeated in SKILL.md and README.

> **`human()` is a gate in the workflow. `ask_human` is a question during work.**

| | `human()` node | `ask_human` tool |
|---|---|---|
| **Belongs to** | the graph topology | the agent doing the work |
| **Exists at** | graph-authoring time | any moment the agent needs it |
| **Question is** | fixed by the workflow author | composed by the agent |
| **Answer goes to** | shared state, keyed by node id | the asking agent's own session |
| **Effect** | routes the walk via edges | the agent keeps going |
| **Blocks** | the entire walk | only that one agent |
| **Use for** | approval gates, go/no-go before a destructive step | ambiguity, preferences, missing requirements |

A `human()` node exists so that the graph **cannot route past it**. If approval were only a
tool the agent may or may not call, it would be a suggestion; as a node it is structural.
Deploy gates and destructive migrations want that guarantee.

An `ask_human` call exists because the agent hit something only a person can resolve. It is
not a routing decision, so it must not be topology. Modelling it as a node forces the answer
into shared state and forces the asking node to be re-entered — the very defect this
document removes.

**Rule of thumb:** if you knew the question when you wrote the graph, it is a node. If the
agent discovered it while working, it is a tool.

---

## 6. `ask_supervisor`

The main agent is the only participant that has seen the whole conversation — what the user
asked for, what was rejected, what was decided three turns ago. A subagent forked from a
compaction summary does not have that. `ask_supervisor` reaches it.

```ts
ask_supervisor({ reason: "need_decision" | "progress_update", message: string })
```

`need_decision` blocks the calling agent and expects a reply. `progress_update` sets
`expectsReply: false` — fire-and-forget, surfaced in the parent conversation, does not block.

The parent side injects the question with `triggerTurn: true` so the main agent thinks about
it, and answers via a `workflow_reply({requestId, answer})` tool. This only works because
the run is in the background: a blocked main agent cannot answer.

---

## 7. `ask_user_question` — full parity

Built to full `rpiv-ask-user-question` parity, deliberately. A trimmed version would mean
keeping that extension installed alongside a worse duplicate of it. It is registered
**unconditionally for the main agent** (so it is available in ordinary conversation, not
only during runs) and **additionally for child agents** via the channel.

```ts
ask_user_question({
  questions: [{
    question: string,          // full text, ends with "?"
    header: string,            // tab chip label, max 16 chars
    options: [{
      label: string,           // 1-5 words, max 60 chars
      description: string,     // the trade-off this choice represents
      preview?: string,        // markdown rendered beside the options
    }],                        // 2-4 options
    multiSelect?: boolean,
  }],                          // 1-4 questions
})
```

Returns `{ answers: [{questionIndex, kind: "option"|"custom"|"chat"|"multi", answer, selected?, notes?, preview?}], cancelled, error? }`.

Features: tab bar (`Tab` to switch), single- and multi-select (`Space` toggles, `Next →`
sentinel, selections persist across tab switches), preview pane laid out side-by-side or
stacked by terminal width, per-option notes (`n`), an **"Other"** free-text fallback, a
**Chat row** on every tab (`kind: "chat"` — the user rejects the options and redirects
instead), a Submit tab reviewing all answers and warning about unanswered ones, and
terminal-row-aware overflow scrolling with ↑/↓/↕ indicators.

Errors are **returned, not thrown**: `no_ui`, `no_questions`, `empty_options`,
`too_many_questions`, `duplicate_question`, `duplicate_option_label`, `reserved_label`.
Reserved labels: `"Other"`, `"Type something."`, `"Chat about this"`, `"Next →"`.

Requires `ctx.ui.custom()`, so it is `ctx.mode === "tui"` only; RPC and print modes fall
back to sequential `select`/`input`. **i18n is out of scope** — that is a separate package's
concern.

The same component renders a `human()` node that carries `options`, so the two look
identical to the user. One component, one interaction model.

`ask_human` is the thin child-side wrapper around this schema, routed through the broker.

---

## 8. Guarding against ask-instead-of-escalate

`ask_human` gives agents an easy way to avoid thinking, and it can quietly replace the
`BLOCKED_ON` vocabulary that makes edge routing work. The auto-injected escalation protocol
gains an explicit boundary:

> Use `ask_human` **only** for information that only the user can supply — a preference, an
> ambiguous requirement, a business decision. If another agent in the graph could resolve it
> — a wrong contract, a broken test, a missing dependency — escalate with `BLOCKED_ON:
> <category>` instead. Asking the user to do another agent's job wastes their time and
> defeats the routing.

---

## 9. Removing `mainAgent()`

Deleted: the node type, `createMainAgentHandler`, the `onMainAgent` handler slot, and the
`"mainAgent"` variant of `InteractiveSource`. The validator emits a targeted error rather
than a generic unknown-identifier failure:

```
mainAgent() was removed. To bring the main agent's judgement into a run, call the
ask_supervisor tool from inside an agent instead — it reaches the real session.
```

`human()` is simultaneously re-routed through the broker instead of calling `ctx.ui`
directly, because a background run has no `ctx.ui` and the node would otherwise fall
silently to its default — a gate that stops gating, which is worse than no gate.
`pi-dynamic-workflows` documents exactly this degradation for their equivalent `checkpoint()`.

---

## 10. Task breakdown

**Phase A — Background execution**
1. `WorkflowManager.startInBackground()` → `{runId, promise}`, detached, catch-guarded
2. `installResultDelivery()` — `complete`/`error`/`aborted` → `sendMessage`, idempotent across `/reload`
3. `graph-tool.ts`: validate-then-detach, new result text, inline await path removed
4. Concurrency: `maxConcurrentRuns` (default 3), same-name guard, clear rejections
5. Tests: detach, delivery content, cap, `/reload` idempotency

**Phase B — Broker core**
6. `request-broker.ts` — types, FIFO queue, coalescing window, resolve/cancel/expire
7. User sink (`ctx.ui`, no expiry)
8. Supervisor sink (`sendMessage` + `workflow_reply` + expiry)
9. Journal requests/answers with `source`; render in `/workflows`

**Phase C — Filesystem transport**
10. Channel layout, atomic writes, 64KB cap
11. Parent poller (≤500ms) → broker; reply → file
12. Child client: env detection, reply polling, abort-aware
13. `pi-args.ts` — pass channel env to children
14. Cleanup: run-end, startup sweep, age sweep, `/workflows` action

**Phase D — `ask_user_question` component**
15. Scaffold via `ctx.ui.custom()`: tabs, sticky header/hints, overflow scroll
16. Single-select + "Other"
17. Multi-select: checkboxes, `Space`, `Next →`, persistence
18. Preview pane, responsive layout
19. Per-option notes, Chat row
20. Submit tab, review, unanswered warnings, non-TUI fallback

**Phase E — Tools**
21. `ask_user_question` for the main agent; `ask_human` for children
22. `ask_supervisor` — reasons, expiry, child-registered
23. Escalation-protocol boundary text

**Phase F — Removal and documentation**
24. Delete `mainAgent()` and its handler; targeted validator error
25. Re-route `human()` through the broker
26. SKILL.md, README, bundled workflows, `/wf` directive, examples — including the
    node-vs-tool distinction from §5
