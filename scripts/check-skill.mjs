#!/usr/bin/env node
/**
 * Cross-check the skill file against the server's actual tool schemas.
 *
 * The skill is the text a calling agent reads to decide what this server can
 * do, so drift between it and the real surface is invisible until someone
 * happens to notice a capability they never knew existed. That is exactly how
 * `inspect`'s `focus` parameter went undocumented: the skill was written from
 * the changes being made rather than from the tool's full surface, so anything
 * untouched stayed unmentioned.
 *
 * Two directions, and they are not equally serious:
 *
 *   OMISSIONS — a real parameter or enum value the skill never names. The
 *   capability exists but no agent will reach for it. Reported as a warning,
 *   because some omissions are deliberate.
 *
 *   INVENTIONS — a parameter or tool the skill shows that does not exist, or a
 *   call whose arguments the schema would reject. An agent following the skill
 *   would emit a failing call. Reported as an error.
 *
 * Deliberate omissions are declared in ALLOWED_OMISSIONS below, so the check
 * stays quiet about choices already made and loud about new drift.
 *
 * Usage:
 *   npm run build && node scripts/check-skill.mjs
 *
 * Exit codes: 0 clean, 1 inventions found, 2 could not run.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist', 'index.js');
const SKILL = join(ROOT, '.claude', 'skills', 'claude-historian', 'SKILL.md');

/**
 * Parameters and enum values intentionally left out of the skill.
 *
 * Each needs a reason. An undocumented capability is a cost, so the bar for
 * adding one here is that naming it would make an agent's decision worse.
 */
const ALLOWED_OMISSIONS = {
  'transcript.format':
    'Text is the right default for an agent reading a transcript; naming the alternative invites a choice that does not need making.',
  'transcript.format=json': 'See transcript.format.',
};

function createClient() {
  const proc = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        /* ignore non-JSON */
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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, token) => new RegExp(`\\b${escape(token)}\\b`).test(text);

async function main() {
  if (!existsSync(SERVER)) {
    console.error(`Server not built: ${SERVER}\nRun: npm run build`);
    process.exit(2);
  }
  const skill = readFileSync(SKILL, 'utf-8');
  const { proc, send } = createClient();

  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'skill-check', version: '1' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await send('tools/list', {});
  proc.kill();

  const surface = {};
  for (const tool of listed.result.tools) {
    surface[tool.name] = tool.inputSchema?.properties ?? {};
  }

  const omissions = [];
  const inventions = [];

  // Direction 1 — real surface the skill never names.
  for (const [tool, params] of Object.entries(surface)) {
    for (const [name, def] of Object.entries(params)) {
      const key = `${tool}.${name}`;
      if (!mentions(skill, name) && !(key in ALLOWED_OMISSIONS)) omissions.push(key);
      for (const value of def.enum ?? []) {
        const vkey = `${key}=${value}`;
        if (!mentions(skill, value) && !(vkey in ALLOWED_OMISSIONS)) omissions.push(vkey);
      }
    }
  }

  // Direction 2 — calls the skill shows that the schema would reject.
  const names = Object.keys(surface).join('|');
  for (const [, tool, args] of skill.matchAll(new RegExp(`\`(${names})\\(([^\`]*)\\)\``, 'g'))) {
    for (const [, param] of args.matchAll(/(\w+)\s*:/g)) {
      if (!(param in surface[tool])) inventions.push(`${tool}(${param}: ...) — no such parameter`);
    }
  }
  for (const [, tool] of skill.matchAll(/`(\w+)\(/g)) {
    if (!(tool in surface) && !['search', 'inspect', 'transcript'].includes(tool)) {
      inventions.push(`${tool}() — no such tool`);
    }
  }

  const tools = Object.keys(surface).length;
  const params = Object.values(surface).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`\n  checked ${tools} tools, ${params} parameters against SKILL.md\n`);

  if (inventions.length) {
    console.log('  🔴 INVENTIONS — the skill describes something that does not exist:');
    for (const i of [...new Set(inventions)]) console.log(`     ${i}`);
    console.log('');
  }
  if (omissions.length) {
    console.log('  🟡 OMISSIONS — real capability the skill never names:');
    for (const o of omissions) console.log(`     ${o}`);
    console.log('     (intentional? add it to ALLOWED_OMISSIONS with a reason)\n');
  }
  if (!inventions.length && !omissions.length) {
    console.log('  🟢 skill matches the tool surface\n');
  }

  process.exit(inventions.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
