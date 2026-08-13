---
name: claude-historian
description: Use to search this conversation's own earlier history, to check whether you already have an answer before WebSearch, to find past fixes when stuck on an error, or to recall past sessions and file changes when entering a familiar project.
---

# Claude Historian

Search conversation history before starting fresh. You may already have the answer.

## Scope first

The history is gigabytes. An unscoped search reads all of it; a session-scoped
one reads a single file. Choose the narrowest scope that can hold the answer:

| Reach | Call | Cost |
|-------|------|------|
| This conversation | `search(query: "...", session_id: "current")` | ~30ms |
| This project | `search(query: "...", project: "current")` | seconds |
| A named project | `search(query: "...", project: "likewiki")` | seconds |
| Everything | `search(query: "...")` | slowest |

**"What did we discuss earlier?", "what did I say about X?", "did we already try
this?" are all `session_id: "current"`.** Reaching for a global search to answer a
question about the current conversation is the most common and most expensive
mistake.

## When to Use

**Asked about earlier in this conversation** → `search(query: "...", session_id: "current")`.

**Before WebSearch** → `search(query: "...", scope: "similar")` or `scope: "conversations"`. Past solutions beat web results.

**Stuck on an error** → `search(query: "<error message>", scope: "errors")`. Finds past fixes with code.

**Entering a familiar project** → `search(scope: "sessions")` for recent work, `search(query: "...", scope: "plans")` for past decisions.

**Working on a familiar file** → `search(scope: "files", filepath: "src/index.ts")`. Shows past changes with context.

## Quick Reference

| Situation | Tool Call |
|-----------|----------|
| Earlier in this conversation | `search(query: "...", session_id: "current")` |
| Error with no obvious cause | `search(query: "<error>", scope: "errors")` |
| "Have I done this before?" | `search(query: "...", scope: "similar")` |
| Working on familiar file | `search(scope: "files", filepath: "...")` |
| Need past design reasoning | `search(query: "...", scope: "plans")` |
| What did I do last session? | `search(scope: "sessions")` |
| Successful tool workflows | `search(scope: "tools")` |
| General search | `search(query: "...", scope: "conversations")` |
| Deep-dive into a session | `inspect(session_id: "...")` — takes an id from any result, or `"current"` |
| Just the files/tools/fixes from a session | `inspect(session_id: "...", focus: "files")` — also `tools`, `solutions` |
| What were we just talking about? | `transcript(session_id: "current", latest: 10)` — the last N messages |
| Full text of a session | `transcript(session_id: "current")` — human/assistant text only |
| Rules, skills, CLAUDE.md | `search(query: "...", scope: "config")` |
| Task management history | `search(query: "...", scope: "tasks")` |
| Memories across sessions | `search(query: "...", scope: "memories")` |

## Key Parameters

- **`session_id`**: `"current"` for this conversation, or a full id / short prefix from a result. The cheapest way to search by far.
- **`project`**: `"current"`, a bare name (`"likewiki"`), or an absolute path. Matched as a whole path segment, not a substring.
- **`scope`**: `all` (default) covers conversations plus plans, config and memories. `errors`, `sessions`, `tools`, `files`, `similar` and `tasks` are **not** in `all` — name them explicitly.
- **`timeframe`**: `today`, `yesterday`, `week`, `last-week`, `month`, `last-month`. Other values are ignored silently, so `"7d"` filters nothing. Narrowing here also makes the search faster.
- **`limit`**: Number of results (default 10).
- **`focus`** (inspect): `all` (default), or narrow a session summary to `files`, `tools` or `solutions`.
- **`latest`** / **`max_messages`** (transcript): read the last N messages, or the first N. `latest` wins if both are given.
- **`detail_level`**: `summary` (default), `detailed` for full content and context, `raw` for the underlying records.

## Reading results

Every result carries `session` and `source` (`file:line`). Use them to follow up:
`inspect(session_id)` for a summary of that session, `transcript(session_id)` for
its full text. A hit is a starting point, not the whole answer.

Delegated work is included. Subagent hits roll up to their parent session and
list the agents that produced them, so a `via` field means the match came from
inside delegated work rather than the parent conversation.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Global search for something in this conversation | `session_id: "current"` — orders of magnitude cheaper |
| Going straight to WebSearch | Check historian first — past solutions are more relevant |
| Vague queries | Use specific terms: error messages, file paths, tool names |
| Expecting `scope: "all"` to include errors | It does not. Use `scope: "errors"` — it also has dedicated fix extraction |
| Long keyword-dump queries | Filler words are stripped, so extra words rarely help. 3-5 specific terms |
| `timeframe: "7d"` | Not a supported value; use `"week"` |
