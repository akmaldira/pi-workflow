---
name: pi-contracts
description: Document formal agreements between agents using the contract tool. Contracts are versioned Markdown files with frontmatter stored in .pi-workflow/contracts/. Types: api, interface, task, data, other. Lifecycle: draft → proposed → superseded.
---

# Pi Contracts Skill

The `contract` tool lets agents formally document agreements — what one party will produce and what another will consume. Contracts are stored in `.pi-workflow/contracts/` and available to all agents automatically.

## ⚠️ Core Discipline Rules

These rules prevent coordination failures:

**If you are the producer (writing the contract):**
1. `create` the contract as a draft
2. `edit` it until it is complete and accurate
3. **Always call `propose` when you are done** — this is the signal to all other agents that the contract is final and ready to act on
4. Never leave a contract in `draft` if other agents are waiting to use it

**If you are the consumer (reading the contract):**
1. Always check `status` before acting on a contract
2. **Only rely on `proposed` contracts** — a `draft` may still be changing
3. If the contract you need is still `draft`, wait or ask the producer to propose it
4. If you find an error in a `proposed` contract, tell the producer to `supersede` it — do not act on a spec you know is wrong

**Why this matters:** a `draft` contract is work in progress. Another agent acting on a draft may build the wrong thing because the spec was not finished. `proposed` is the explicit signal: "this is final."

---

## Quick Reference

```
contract(action: "list")
contract(action: "create", name: "...", type: "api", producer: "planner", consumer: "worker", content: "...")
contract(action: "get", id: "auth-api")
contract(action: "edit", id: "auth-api", oldText: "...", newText: "...")
contract(action: "propose", id: "auth-api")
contract(action: "supersede", id: "auth-api", name: "Auth API v2", content: "...")
```

---

## Actions

| Action | Required params | Who calls it | Description |
|--------|----------------|--------------|-------------|
| `list` | — | anyone | List all contracts with type, status, id, title |
| `create` | `name`, `type`, `producer`, `consumer`, `content` | producer | Create a new `draft` contract |
| `get` | `id` | anyone | Read full contract content including frontmatter |
| `edit` | `id`, `oldText`, `newText` | producer | Precision find-and-replace — **draft only** |
| `propose` | `id` | producer | Move `draft` → `proposed` — **call this when done writing** |
| `supersede` | `id`, `name`, `content` | producer | Create v+1 draft, mark old as `superseded` |

---

## Contract Types

| Type | Use for |
|------|---------|
| `api` | REST/RPC endpoints, request/response schemas, auth |
| `interface` | Function signatures, TypeScript types, return values |
| `task` | What a subagent will deliver, acceptance criteria |
| `data` | Shape of data passed between agents or services |
| `other` | Anything that doesn't fit above |

---

## Lifecycle

```
create → draft → edit (repeat) → propose → proposed
                                                ↓
                                           supersede
                                                ↓
                                  superseded (old) + new draft (v+1)
```

- **draft**: work in progress — editable, not yet reliable for consumers
- **proposed**: final and ready — consumers can safely act on this
- **superseded**: replaced by a newer version — kept on disk for audit history

---

## Full Coordination Example

This is the typical pattern across agents in a workflow:

### Step 1 — Planner creates and proposes the contract

```
# Planner agent

contract(action: "create",
  name: "Auth API",
  type: "api",
  producer: "worker",
  consumer: "reviewer",
  content: """
# Auth API Contract

## Endpoints

### POST /auth/login
- Request: { email: string, password: string }
- Response 200: { token: string, expiresAt: string }
- Response 401: { error: "invalid_credentials" }

## Constraints
- JWT HS256, 1-hour TTL
- Passwords never logged
""")
→ id: auth-api

# Done writing — signal it is final
contract(action: "propose", id: "auth-api")
→ Contract "auth-api" is now proposed.
```

### Step 2 — Worker reads the contract before starting

```
# Worker agent

contract(action: "list")
→ [api] [proposed] auth-api — Auth API Contract

# Status is proposed — safe to act on
contract(action: "get", id: "auth-api")
→ full spec

# Now implement exactly what the contract says
```

### Step 3 — Reviewer verifies against the same contract

```
# Reviewer agent

contract(action: "get", id: "auth-api")
→ same spec the worker read

# Check worker output against this spec
```

### Step 4 — If the spec needs to change

```
# Producer discovers spec was wrong after proposing

contract(action: "supersede",
  id: "auth-api",
  name: "Auth API v2",
  content: "# Auth API v2\n\n...revised...")
→ Contract "auth-api" superseded. New contract: auth-api-v2.md (v2)

# auth-api.md is now superseded (kept for history)
# auth-api-v2.md is a fresh draft

contract(action: "edit", id: "auth-api-v2", oldText: "...", newText: "...")
contract(action: "propose", id: "auth-api-v2")
```

---

## Edit Precision

`edit` behaves like pi's built-in `edit` tool:
- `oldText` must match **exactly once** in the full file (including frontmatter)
- Error if zero matches → you have the wrong text
- Error if multiple matches → add more surrounding context to make it unique
- **Only works on `draft` contracts** — attempting to edit a `proposed` contract returns an error

---

## Versioning

`supersede` is the only way to revise a `proposed` contract:
1. Creates a new contract at v+1 with `status: draft`
2. Marks the old contract as `superseded`
3. Inherits `type`, `producer`, `consumer` from the old contract automatically
4. Records `supersedes: <oldId>` in the new contract's frontmatter
5. Both files stay on disk — complete audit trail of what was agreed and when

---

## /contracts Command

Type `/contracts` in the TUI to open the interactive navigator:
- List view: type (colour-coded) · status · id · title · updated date
- Reader: full Markdown + frontmatter with scroll
- Keys: ↑↓/jk navigate · enter open · esc back · r refresh · q quit
