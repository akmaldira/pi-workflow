---
name: pi-contracts
description: Document formal agreements between agents using the contract tool. Contracts are versioned Markdown files with frontmatter stored in .pi-workflow/contracts/. Types: api, interface, task, data, other. Lifecycle: draft → proposed → superseded.
---

# Pi Contracts Skill

The `contract` tool lets agents formally document agreements — what one party will produce and what another will consume. Contracts are stored in `.pi-workflow/contracts/` and available to all agents automatically.

## Quick Reference

```
contract(action: "list")
contract(action: "create", name: "...", type: "api", producer: "planner", consumer: "worker", content: "...")
contract(action: "get", id: "auth-api-v1")
contract(action: "edit", id: "auth-api-v1", oldText: "...", newText: "...")
contract(action: "propose", id: "auth-api-v1")
contract(action: "supersede", id: "auth-api-v1", name: "Auth API v2", content: "...")
```

## Actions

| Action | Required params | Description |
|--------|----------------|-------------|
| `list` | — | List all contracts with type, status, id, title |
| `create` | `name`, `type`, `producer`, `consumer`, `content` | Create a new `draft` contract |
| `get` | `id` | Read full contract content including frontmatter |
| `edit` | `id`, `oldText`, `newText` | Precision find-and-replace — draft contracts only |
| `propose` | `id` | Move `draft` → `proposed` (ready for review) |
| `supersede` | `id`, `name`, `content` | Create v+1, mark old as `superseded` |

## Contract Types

| Type | Use for |
|------|---------|
| `api` | REST/RPC endpoints, request/response schemas, auth |
| `interface` | Function signatures, TypeScript types, return values |
| `task` | What a subagent will deliver, acceptance criteria |
| `data` | Shape of data passed between agents or services |
| `other` | Anything that doesn't fit above |

## Lifecycle

```
draft  →  proposed  →  superseded
  ↑                        ↑
create                 supersede
```

- **draft**: work in progress, can be edited freely
- **proposed**: ready for review, no more edits (use supersede to revise)
- **superseded**: replaced by a newer version (read-only history)

## Format

Contracts are Markdown with YAML frontmatter. The `create` action handles frontmatter automatically. Write the body as plain Markdown:

```markdown
# Auth API Contract

## Endpoints

### POST /auth/login
- Request: `{ email: string, password: string }`
- Response 200: `{ token: string, expiresAt: string }`
- Response 401: `{ error: "invalid_credentials" }`

## Constraints
- JWT tokens, HS256, 1-hour TTL
- Passwords must never appear in logs
```

## Edit Precision

`edit` behaves like pi's built-in `edit` tool — `oldText` must match **exactly once** in the full file (including frontmatter). Errors if zero matches or multiple matches. Only works on `draft` contracts.

## Versioning

When you need to revise a `proposed` contract, use `supersede`:
1. It creates a new contract at v+1 with `status: draft`
2. It marks the old contract as `superseded`
3. The new contract inherits `type`, `producer`, `consumer` from the old one
4. Both remain on disk for audit history

## /contracts Command

Type `/contracts` in the TUI to open the interactive navigator — browse all contracts with type/status colour coding, read content with scroll.
