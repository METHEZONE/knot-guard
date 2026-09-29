import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

// Per-flow token accounting: every Kiln call is tagged with a flow name.
export const usage = {};           // flow -> {calls, prompt, completion, reasoning, cached_hits, latencyMs}
const cacheFile = path.join(cfg.dataDir, 'kiln-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
export const callLog = [];         // every actual API call (proof of usage)
let activeModel = null;

export function resetUsage() { for (const k of Object.keys(usage)) delete usage[k]; callLog.length = 0; }

async function rawCall(model, messages, { max_tokens, temperature }) {
  const t0 = Date.now();
  const res = await fetch(cfg.kilnBase + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.kilnKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens, temperature }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - t0 };
}

async function pickModel() {
  if (activeModel) return activeModel;
  // Probe the requested model first; fall back to what Kiln actually serves.
  const probe = await rawCall(cfg.kilnModel, [{ role: 'user', content: 'ping' }], { max_tokens: 1, temperature: 0 });
  activeModel = probe.status === 200 ? cfg.kilnModel : cfg.kilnFallbackModel;
  if (activeModel !== cfg.kilnModel) console.warn(`[kiln] ${cfg.kilnModel} not served (HTTP ${probe.status}: ${probe.body?.error?.code}); using ${activeModel}`);
  return activeModel;
}
export const currentModel = () => activeModel;
export const ensureModel = () => pickModel();

/** chat(): one Kiln call. `flow` labels the token bucket. Deterministic (temp 0) + cached to avoid re-inference. */
export async function chat(flow, system, user, { max_tokens = 220, json = true, useCache = true } = {}) {
  const model = await pickModel();
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user + '\n/no_think' },   // Qwen3 switch: skip chain-of-thought tokens
  ];
  const key = crypto.createHash('sha256').update(model + JSON.stringify(messages) + max_tokens).digest('hex');
  const u = (usage[flow] ||= { calls: 0, cacheHits: 0, prompt: 0, completion: 0, reasoning: 0, latencyMs: 0 });
  if (useCache && cache[key]) { u.cacheHits++; return { text: cache[key].text, json: tryJson(cache[key].text), cached: true, model }; }
  let r = await rawCall(model, messages, { max_tokens, temperature: 0 });
  if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 1500)); r = await rawCall(model, messages, { max_tokens, temperature: 0 }); }
  if (r.status !== 200) throw new Error(`Kiln ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const us = r.body.usage || {};
  u.calls++; u.prompt += us.prompt_tokens || 0; u.completion += us.completion_tokens || 0;
  u.reasoning += us.completion_tokens_details?.reasoning_tokens || 0; u.latencyMs += r.ms;
  const text = (r.body.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  callLog.push({ at: new Date().toISOString(), flow, model, id: r.body.id, prompt_tokens: us.prompt_tokens, completion_tokens: us.completion_tokens, reasoning_tokens: us.completion_tokens_details?.reasoning_tokens || 0, ms: r.ms });
  cache[key] = { text }; fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return { text, json: tryJson(text), cached: false, model };
}

function tryJson(t) {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function energyReport() {
  const rows = []; let tot = 0;
  for (const [flow, u] of Object.entries(usage)) {
    const tokens = u.prompt + u.completion;
    tot += tokens;
    rows.push({ flow, calls: u.calls, cacheHits: u.cacheHits, prompt: u.prompt, completion: u.completion, reasoning: u.reasoning, total: tokens,
      npuJ: +(tokens * cfg.jPerTokenNpu).toFixed(1), gpuJ: +(tokens * cfg.jPerTokenGpu).toFixed(1), avgMs: u.calls ? Math.round(u.latencyMs / u.calls) : 0 });
  }
  return { model: activeModel, assumptions: { jPerTokenNpu: cfg.jPerTokenNpu, jPerTokenGpu: cfg.jPerTokenGpu, note: 'ASSUMED values; Kiln exposes no energy telemetry' }, rows,
    totalTokens: tot, totalNpuJ: +(tot * cfg.jPerTokenNpu).toFixed(1), totalGpuJ: +(tot * cfg.jPerTokenGpu).toFixed(1) };
}
