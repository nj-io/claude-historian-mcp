#!/usr/bin/env node
/**
 * Relevance + latency evaluation harness for claude-historian.
 *
 * Fixtures are ONE-DIRECTIONAL RECALL PINS, not result snapshots:
 *
 *   "query Q must return a hit attributable to session S within the top K"
 *
 * Pinned at sessionId level (never message uuid) so that changes which
 * legitimately alter result *sets* — stopword stripping, envelope exclusion,
 * scope recomposition, subagent roll-up — cannot produce false failures.
 * A genuinely relevant pinned hit survives all of them, so a red pin is a
 * real recall regression.
 *
 * Reports recall@k, MRR (rank of the pinned hit) and latency. Precision is
 * deliberately absent: it is not measurable without labelled judgements for
 * every query x result pair.
 *
 * KNOWN RANKING WEAKNESS, surfaced by this harness and not yet addressed:
 * scores tie pervasively and nothing caps how much of a result set one session
 * or one file may occupy. A phrase query returned 12 of its top 15 hits at
 * exactly 57.2, and a subagent query was crowded out entirely by 60+
 * identically-scored messages from a single parent transcript. Ordering among
 * equals is therefore arbitrary, and a genuinely relevant record can be pushed
 * out of the window by near-duplicates of one neighbour. This is a scoring
 * problem, not a retrieval one — the records are found, they just do not
 * surface — and fixing it means changing how results are ranked and
 * diversified.
 *
 * Usage:
 *   node scripts/eval.mjs                     # local fixtures if present, else sample
 *   node scripts/eval.mjs --fixtures <path>
 *   node scripts/eval.mjs --baseline          # write results as the new baseline
 *   node scripts/eval.mjs --json              # machine-readable output
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist', 'index.js');
const LOCAL_FIXTURES = join(ROOT, 'test', 'fixtures', 'queries.local.json');
const SAMPLE_FIXTURES = join(ROOT, 'test', 'fixtures', 'queries.sample.json');
const BASELINE = join(ROOT, 'test', 'fixtures', 'baseline.local.json');

/** Extra results fetched to absorb self-session rows removed after retrieval. */
const SELF_EXCLUSION_HEADROOM = 20;

/** The session running this eval; its rows are excluded from pin matching. */
const SELF_SESSION = process.env.CLAUDE_CODE_SESSION_ID ?? '';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const writeBaseline = argv.includes('--baseline');
const fixturesArg = argv.indexOf('--fixtures');
const fixturesPath =
  fixturesArg !== -1
    ? argv[fixturesArg + 1]
    : existsSync(LOCAL_FIXTURES)
      ? LOCAL_FIXTURES
      : SAMPLE_FIXTURES;

// ── MCP stdio client ────────────────────────────────────────────────

function createClient() {
  const proc = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Decode as UTF-8 at the stream, not by concatenating Buffers. Appending a
  // Buffer to a string decodes each chunk independently, so a multi-byte
  // character straddling a chunk boundary becomes U+FFFD and silently corrupts
  // the JSON — which showed up as phantom recall failures on the largest
  // responses, the ones most likely to span chunks.
  proc.stdout.setEncoding('utf8');
  const pending = new Map();
  let buf = '';
  let nextId = 0;

  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* server may emit non-JSON on stderr-ish paths; ignore */
      }
    }
  });

  const send = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  return { proc, send };
}

/**
 * Recover the JSON body from the server's decorated box output.
 * formatter.fmt() prefixes each body line with "  │   " or "  └   ".
 */
function unwrap(text) {
  // Strip exactly one box prefix per line. A filter+slice loses any body line
  // that does not carry the prefix, and corrupts the JSON when message content
  // itself quotes box characters — which happens as soon as this tool's own
  // output ends up in the history it searches.
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^ {2}[│└] {3}/.test(l));
  if (start === -1) return null;
  const body = lines
    .slice(start)
    .map((l) => (/^ {2}[│└] {3}/.test(l) ? l.slice(6) : l))
    .join('\n');
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Collect rows in rank order as {session, content} pairs. */
function rowsInRankOrder(payload) {
  if (!payload) return [];
  // detail_level:"raw" emits a bare array of CompactMessage; the summary and
  // detailed modes wrap rows under results/messages/sessions.
  const rows = Array.isArray(payload)
    ? payload
    : (payload.results ?? payload.messages ?? payload.sessions ?? []);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    session: String(row.sessionId ?? row.session ?? row.session_id ?? row.id ?? ''),
    content: String(row.content ?? row.c ?? ''),
  }));
}

/** A pin matches on full id or short prefix, in either direction. */
function matchesPin(actual, expected) {
  if (!actual || !expected) return false;
  return actual.startsWith(expected) || expected.startsWith(actual);
}

// ── Runner ──────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(SERVER)) {
    console.error(`Server not built: ${SERVER}\nRun: npm run build`);
    process.exit(2);
  }
  if (!existsSync(fixturesPath)) {
    console.error(`No fixtures at ${fixturesPath}`);
    process.exit(2);
  }

  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf-8'));
  const { proc, send } = createClient();

  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'historian-eval', version: '1' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const results = [];

  for (const fx of fixtures) {
    const k = fx.expect_within_top ?? 10;
    // Self-session rows are filtered client-side, after retrieval. Asking for
    // exactly k would let the running conversation crowd the pin out of the
    // window before exclusion ever runs — and it does, because this session
    // grows as the eval is developed. Retrieval depth must exceed k.
    const depth = fx.exclude_current === false ? k : k + SELF_EXCLUSION_HEADROOM;
    const args = {
      query: fx.query,
      scope: fx.scope ?? 'conversations',
      // raw is the only mode that reliably exposes sessionId before Phase 4,
      // and stays correct after it. Keeps the harness stable across phases.
      detail_level: 'raw',
      limit: depth,
      ...(fx.args ?? {}),
    };

    const started = Date.now();
    const res = await send('tools/call', { name: fx.tool ?? 'search', arguments: args });
    const ms = Date.now() - started;

    const text = res.result?.content?.[0]?.text ?? '';
    let rows = rowsInRankOrder(unwrap(text));

    // Observer effect: authoring a fixture writes its query phrase into the
    // transcript of the session doing the authoring, which is itself part of
    // the searchable corpus. A pin could then be satisfied by the conversation
    // that created it rather than by the history it is meant to prove.
    // Rows from the running session are therefore discarded by default.
    if (SELF_SESSION && fx.exclude_current !== false) {
      rows = rows.filter((r) => !matchesPin(r.session, SELF_SESSION));
    }

    // A pin requires the right session AND, when specified, that the matched
    // row actually contains the phrase. Without the content check a
    // session-level pin can pass on unrelated content in the same session —
    // which silently hides exactly the recall gaps this harness exists to catch.
    const needle = fx.expect_content_contains?.toLowerCase();
    const rank = rows.findIndex(
      (r) =>
        matchesPin(r.session, fx.expect_session) &&
        (!needle || r.content.toLowerCase().includes(needle)),
    );

    // Scoping fixtures assert containment: every row must come from the
    // expected session/scope, not merely that it appears somewhere.
    const offScope = fx.expect_all_from_session
      ? rows.filter((r) => r.session && !matchesPin(r.session, fx.expect_all_from_session))
      : [];

    const hit = rank !== -1 && rank < k && offScope.length === 0 && rows.length > 0;

    results.push({
      id: fx.id,
      query: fx.query,
      expect_session: fx.expect_session,
      expected_fail_until: fx.expected_fail_until ?? null,
      k,
      rank: rank === -1 ? null : rank + 1,
      hit,
      ms,
      returned: rows.length,
      off_scope: offScope.length,
      error: res.result?.isError ? text.slice(0, 200) : null,
    });
  }

  proc.kill();

  // ── Scoring ───────────────────────────────────────────────────────
  const live = results.filter((r) => !r.expected_fail_until);
  const deferred = results.filter((r) => r.expected_fail_until);

  const hits = live.filter((r) => r.hit);
  const recall = live.length ? hits.length / live.length : 0;
  const mrr = live.length
    ? live.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) / live.length
    : 0;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const summary = {
    fixtures: fixturesPath,
    live: live.length,
    deferred: deferred.length,
    recall: Number(recall.toFixed(3)),
    mrr: Number(mrr.toFixed(3)),
    latency_median_ms: median,
    latency_p95_ms: p95,
    latency_total_ms: latencies.reduce((a, b) => a + b, 0),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(`\n  fixtures: ${fixturesPath}\n`);
    for (const r of results) {
      const state = r.expected_fail_until
        ? r.hit
          ? '🟢 EARLY'
          : `⏸  deferred → ${r.expected_fail_until}`
        : r.hit
          ? `🟢 rank ${r.rank}/${r.k}`
          : '🔴 MISS';
      console.log(`  ${state.padEnd(26)} ${String(r.ms).padStart(6)}ms  ${r.id}`);
      if (r.error) console.log(`      error: ${r.error}`);
    }
    console.log(
      `\n  recall@k ${summary.recall}   MRR ${summary.mrr}   ` +
        `median ${summary.latency_median_ms}ms   p95 ${summary.latency_p95_ms}ms` +
        `   (${summary.deferred} deferred)\n`,
    );
  }

  // ── Baseline comparison ───────────────────────────────────────────
  if (writeBaseline) {
    writeFileSync(BASELINE, JSON.stringify({ summary, results }, null, 2));
    console.log(`  baseline written → ${BASELINE}\n`);
    return;
  }

  if (existsSync(BASELINE)) {
    const prev = JSON.parse(readFileSync(BASELINE, 'utf-8'));
    const prevById = new Map(prev.results.map((r) => [r.id, r]));
    const regressions = live.filter((r) => {
      const p = prevById.get(r.id);
      return p && p.hit && !r.hit;
    });
    if (regressions.length) {
      console.log(`  🔴 RECALL REGRESSIONS vs baseline (${regressions.length}):`);
      for (const r of regressions) console.log(`     ${r.id} — "${r.query}"`);
      console.log('');
      process.exitCode = 1;
    } else {
      console.log(
        `  🟢 no recall regressions vs baseline ` +
          `(recall ${prev.summary.recall} → ${summary.recall}, ` +
          `median ${prev.summary.latency_median_ms}ms → ${summary.latency_median_ms}ms)\n`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
