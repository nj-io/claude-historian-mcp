# Fork notes

This is `nj-io/claude-historian-mcp`, a fork of
[`Vvkmnn/claude-historian-mcp`](https://github.com/Vvkmnn/claude-historian-mcp) (MIT).

It is maintained as a working tool rather than as a staging area for upstream
pull requests. `master` is the version that runs; `upstream/master` is merged in
when there is something worth taking.

```
git fetch upstream && git merge upstream/master
```

The MCP client runs `dist/index.js` from this checkout directly, so `npm run
build` is the whole deployment. Consuming Claude sessions must be restarted to
pick up a new binary — each spawns its own server process at startup.

## What diverges from upstream

**Scoping.** `search` takes `session_id` and a structured `project` filter.
`session_id: "current"` resolves from `CLAUDE_CODE_SESSION_ID`, which Claude Code
exports into every MCP server it spawns, and reads one file instead of the
corpus. `inspect` and `transcript` accept `"current"` too.

**Subagent transcripts are searchable.** File discovery is recursive, so
`<sessionId>/subagents/**` is included — roughly half the corpus by bytes, and
previously unreachable at any speed. Subagent records carry their *parent's*
`sessionId` with `isSidechain: true` and their own `agentId`; hits roll up to one
row per parent session naming the contributing agents, because a single session
can spawn over a thousand of them.

Recursion is a separate function from `findJsonlFiles` and only conversation
search opts in. The subagent directory is named after its parent session, so a
recursive listing would let session lookup by prefix resolve to an agent
transcript, and would add thousands of phantom entries to session listings.

**Results carry provenance.** Every hit includes `session` and
`sourceFile:sourceLine`, so it can be followed up with `inspect` or `transcript`.

**Scan cost.** A record-type gate skips records with no message (~24% of bytes).
The file-level pre-filter scans undecoded buffers; only lines containing a term
are decoded. Query splitting is unified in `splitQueryTerms`, which strips
stopwords and is shared by the pre-filter and the scorer so the two cannot
disagree. `timeframe` filters files by mtime before opening them.

**`scope: "all"` covers conversations, plans, config and memories only.**
`errors`, `sessions` and `tools` each run an independent full-corpus pass with
pre-filter terms so common they barely filter, which made the default scope the
slowest operation offered. They remain available by name.

**Tool surface.** The ten deprecated stub tools are removed. The instructions
blob and parameter descriptions are written around scope and cost, since static
text is the only channel through which a calling agent learns what to reach for.

## Evaluation

`scripts/eval.mjs` measures recall and latency against real history.

```
npm run build && node scripts/eval.mjs
node scripts/eval.mjs --baseline     # record current results as the reference
```

Fixtures are one-directional recall pins — "query Q must return a hit from
session S within top K" — pinned at session level so that changes which
legitimately alter result *sets* cannot produce false failures.

`test/fixtures/queries.local.json` and `baseline.local.json` are gitignored:
they contain real session ids and queries drawn from private work, and this is a
public fork. `queries.sample.json` is synthetic and asserts server contract only,
so a fresh clone gets a smoke test rather than a recall measurement.

Rows from the session running the eval are excluded from pin matching. Authoring
a fixture writes its query into that session's transcript, which is part of the
searchable corpus, so a pin could otherwise be satisfied by the conversation that
created it.

## Known weakness, unfixed

Scores tie pervasively — one phrase query returned 12 of its top 15 hits at
exactly 57.2 — and nothing caps how much of a result set one session or file may
occupy. Ordering among equals is therefore arbitrary, and a relevant record can
be pushed out of the window by near-duplicates of one neighbour. Retrieval is
sound; the records are found and simply do not surface.

Fixing this means replacing the hand-tuned additive scoring, which is deliberately
out of scope here. The fixture `subagent/audio-placeholder` is kept failing as a
standing signal.

## Rejected approaches

**A derived index (SQLite FTS5, or an extracted-text sidecar).** Would take
corpus-wide search to well under a second. Rejected: session scoping already
takes the common case to ~30ms, and an index costs a second source of truth, a
single-writer lease across the many server processes one machine runs, and a
plaintext copy of every conversation on disk. `node:sqlite` on Node 22 also has
no FTS5, so it would require pinning Node ≥24 or taking a native dependency.

**Shelling out to ripgrep.** No `rg` binary is reachable from a child process —
the one in a Claude Code shell is a function wrapping the bundled copy. Portable
`/usr/bin/grep` over this corpus takes ~30s, slower than the current engine.

**Resolving `"current"` by newest mtime when the environment variable is stale.**
Rejected: with several sessions open, the newest file in a project routinely
belongs to a different live conversation, so the guess returns one session's
transcript to another. Unresolvable is an explicit error instead.
