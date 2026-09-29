// AUDIT: reconstruct "was this payment inside what the owner allowed?" from records alone.
// Inputs: an XRPL tx hash (+ the published mandate JSON, whose hash the owner wrote on-chain).
// No agent logs, no trust in the agent. The LLM only *narrates*; the verdict is computed in code.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { cfg } from './config.js';
import { getTxFacts, readRecords, close, xrp, NETWORK_FEE_DROPS, explorerTx } from './chain.js';
import { hashMandate } from './mandate.js';
import { explain } from './agent.js';
import { energyReport, resetUsage } from './kiln.js';

const mdir = path.join(cfg.dataDir, 'mandates');
const mandates = fs.readdirSync(mdir).map((f) => JSON.parse(fs.readFileSync(path.join(mdir, f), 'utf8')));
const byHash = Object.fromEntries(mandates.map((m) => [hashMandate(m), m]));

export async function auditTx(hash, { narrate = true } = {}) {
  const f = await getTxFacts(hash);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (!f.ok || !f.record || f.record.type !== 'D') return { hash, error: 'not a knot1 decision record' };
  const d = f.record.data;
  const mandate = byHash[d.mh];
  add('mandate JSON found and its SHA-256 equals the hash in the record', !!mandate, d.mh.slice(0, 16) + '…');
  if (!mandate) return { hash, checks, verdict: 'UNVERIFIABLE' };
  const ownerRecs = await readRecords(mandate.owner);
  const agentRecs = await readRecords(mandate.agent);
  const grant = ownerRecs.find((r) => r.type === 'M' && r.data.h === d.mh);
  add('mandate was granted on-chain by the OWNER account', !!grant, grant ? explorerTx(grant.hash) : 'no grant found');
  add('decision was signed by the agent account named in the mandate', f.signer === mandate.agent, f.signer);
  const revokedBefore = ownerRecs.find((r) => r.type === 'R' && r.data.h === d.mh && r.closeTime <= f.closeTime);
  const inTime = f.closeTime <= mandate.deadlineUnix;
  const spentBefore = agentRecs.filter((r) => r.type === 'D' && r.data.mh === d.mh && r.data.v === 'ALLOW' && r.hash !== hash && r.closeTime <= f.closeTime).reduce((s, r) => s + r.data.t, 0);
  const allowed = mandate.allow.some((a) => a.addr === d.pa);
  const shouldStop = [];
  if (revokedBefore) shouldStop.push('MANDATE_REVOKED');
  if (!inTime) shouldStop.push('DEADLINE_PASSED');
  if (!allowed) shouldStop.push('MERCHANT_NOT_ALLOWED');
  if (d.t > mandate.budgetDrops - spentBefore) shouldStop.push('BUDGET_EXCEEDED');

  let verdict;
  if (d.v === 'ALLOW') {
    add('money moved to an allow-listed payee address', !!f.payment && mandate.allow.some((a) => a.addr === f.payment.to), f.payment?.to);
    add('paid amount equals price + merchant fee recorded', f.payment?.drops === d.p + d.f, `${xrp(f.payment?.drops ?? 0)} XRP`);
    add('within remaining budget (incl. fees)', d.t <= mandate.budgetDrops - spentBefore, `${xrp(d.t)} <= ${xrp(mandate.budgetDrops - spentBefore)} XRP`);
    add('before the deadline', inTime, new Date(f.closeTime * 1000).toISOString());
    add('not revoked at that time', !revokedBefore, revokedBefore ? explorerTx(revokedBefore.hash) : 'no revoke');
    verdict = checks.every((c) => c.ok) ? 'COMPLIANT' : 'VIOLATION';
  } else {
    add('no funds moved (memo-only record)', !f.payment, 'AccountSet with memo');
    const claimed = d.rc; const ok = claimed.every((r) => shouldStop.includes(r)) && claimed.length > 0;
    add('every recorded stop reason is independently true', ok, `recorded ${claimed.join(',')} | recomputed ${shouldStop.join(',') || 'none'}`);
    verdict = checks.every((c) => c.ok) ? 'STOP JUSTIFIED' : 'STOP UNJUSTIFIED';
  }
  const facts = { verdict, decision: d.v, merchant: d.m, item: d.it, priceXrp: xrp(d.p), feeXrp: xrp(d.f), budgetXrp: xrp(mandate.budgetDrops), reasons: d.rc, failedChecks: checks.filter((c) => !c.ok).map((c) => c.name) };
  const story = narrate ? await explain(facts) : '';
  return { hash, explorer: explorerTx(hash), label: d.id, mandate: mandate.id, decision: d.v, reasons: d.rc, verdict, checks, story };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetUsage();
  const runs = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'runs.json'), 'utf8')).runs;
  const hashes = process.argv[2] ? [process.argv[2]] : runs.map((r) => r.txHash);
  const out = [];
  for (const h of hashes) { const a = await auditTx(h); out.push(a); console.log(`\n${a.label}  ${a.decision}  =>  ${a.verdict}\n  ${a.explorer}`); for (const c of a.checks) console.log(`   ${c.ok ? '✔' : '✘'} ${c.name}  [${c.detail}]`); console.log('   "' + a.story + '"'); }
  const e = energyReport();
  fs.writeFileSync(path.join(cfg.dataDir, 'audit-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), audits: out, explainUsage: e }, null, 2));
  console.log('\nexplain-flow usage:', JSON.stringify(e.rows));
  await close();
}
