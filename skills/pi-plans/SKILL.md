---
name: pi-plans
description: Create and manage structured plans using the plan tool. Plans are Markdown files stored in .pi-workflow/plans/ and are available in all modes including plan mode.
---

# Pi Plans Skill

The `plan` tool lets you create, read, edit, list, and delete Markdown plans stored in `.pi-workflow/plans/`. It works in **all modes** — including plan mode where `write`/`edit` are blocked.

## Quick Reference

```
plan(action: "list")                          # see all plans
plan(action: "create", name: "...", content: "...markdown...")
plan(action: "get", id: "my-plan-id")
plan(action: "edit", id: "my-plan-id", oldText: "...", newText: "...")
plan(action: "delete", id: "my-plan-id")
```

## Actions

| Action | Required params | Description |
|--------|----------------|-------------|
| `list` | — | List all plans with id, name, last updated |
| `create` | `name`, `content` | Create a new plan; returns the assigned `id` |
| `get` | `id` | Read full plan content |
| `edit` | `id`, `oldText`, `newText` | Precision find-and-replace — `oldText` must match exactly once |
| `delete` | `id` | Permanently remove a plan |

## Plan Format

Plans are plain Markdown. Start with an `# H1` heading as the title — the tool reads it as the plan name in listings.

```markdown
# Refactor Authentication Module

## Goal
Replace the legacy session cookie approach with JWT tokens.

## Approach
1. Audit current session handling in `auth/session.ts`
2. Design the JWT payload schema
3. Implement token issuing and validation
4. Update all protected routes

## Open Questions
- Token expiry strategy: sliding window or fixed TTL?
- Where to store the refresh token?
```

## Edit Precision

`edit` behaves like pi's built-in `edit` tool — `oldText` must be an exact match that appears **once only** in the plan. If it matches zero times you get an error; if it matches multiple times you must provide more context. This makes edits safe and predictable.

## Plan IDs

The id is auto-derived from the name as a URL slug (e.g. `"Refactor Auth"` → `refactor-auth`). If a collision occurs, a timestamp suffix is added. Always use `list` to get the exact id before calling `get`/`edit`/`delete`.

## /plans Command

Type `/plans` in the TUI to open the interactive plan navigator — browse all plans, read content, scroll with ↑/↓.
