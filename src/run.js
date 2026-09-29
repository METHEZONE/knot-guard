import { payWithRecord, writeRecord, xrp, explorerTx } from './chain.js';
import { intake, select, negotiate, requestHash } from './agent.js';
import { chainState, guard } from './policy.js';
import { hashMandate } from './mandate.js';
import { catalog } from './market.js';
import { usage } from './kiln.js';
import { load } from './keys.js';

const snapshotUsage = () => JSON.parse(JSON.stringify(usage));
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((f) => [f, { calls: b[f].calls - (a[f]?.calls || 0), prompt: b[f].prompt - (a[f]?.prompt || 0), completion: b[f].completion - (a[f]?.completion || 0), cacheHits: b[f].cacheHits - (a[f]?.cacheHits || 0) }]).filter(([, v]) => v.calls || v.cacheHits));

/**
 * One end-to-end purchase attempt for `mandate`.
 * forced: skip the LLM and inject a hard-coded proposal (simulates a hijacked / prompt-injected agent) to prove the guard is code, not prompt.
 */
export async function purchase({ label, text, mandate, forced = null, aware = true }) {
  const agent = load('agent');
  const before = snapshotUsage();
  const log = [];
  const offers = catalog().offers;
  const mh = hashMandate(mandate);
  let need = null, sel = null, offer = null, neg = null;

  if (forced) {
    offer = offers.find((o) => o.id === forced);
    sel = { offer, reason: 'FORCED (simulated hijacked agent)' };
  } else {
    need = await intake(text); log.push(`intake -> ${JSON.stringify({ category: need.category, maxPriceXrp: need.maxPriceXrp, prefer: need.prefer })}`);
    if (!need.category) return finish('NO_CATEGORY');
    // policy-aware planning: the agent knows the owner's allowlist and only shows the LLM offers it may actually buy (fewer tokens, less attack surface).
    // aware=false simulates a naive agent that shows the LLM every listing -- used to demonstrate the guard against prompt injection.
    const visible = aware ? offers.filter((o) => mandate.allow.some((a) => a.addr === o.payee)) : offers;
    sel = await select(need, visible, text, aware ? mandate.allow.map((a) => a.name) : []); offer = sel.offer;
    log.push(`select -> ${offer?.id ?? 'none'} (${sel.reason})`);
    if (!offer) return finish('NO_OFFER');
  }

  // PRE-FLIGHT: run the guard at list price BEFORE spending inference on negotiation.
  let st = await chainState(mandate);
  const proposalAt = (priceDrops) => ({ payee: offer.payee, priceDrops, feeDrops: offer.feeDrops });
  let g = guard(proposalAt(offer.priceDrops), mandate, st);
  const hard = g.reasons.filter((r) => r !== 'BUDGET_EXCEEDED');
  let finalPrice = offer.priceDrops;
  if (hard.length) { log.push(`preflight: hard stop ${hard.join(',')} -> negotiation skipped (0 tokens)`); }
  else if (offer.floorDrops < offer.priceDrops) {
    neg = await negotiate(offer, true); finalPrice = neg.finalDrops; log.push(...neg.transcript);
  } else if (g.reasons.length) log.push('preflight: over budget and no discount possible -> negotiation skipped (0 tokens)');

  // FINAL GUARD on fresh chain state
  st = await chainState(mandate);
  g = guard(proposalAt(finalPrice), mandate, st);
  return finish(g.ok ? null : g.reasons);

  async function finish(early) {
    const reasons = Array.isArray(early) ? early : early ? [early] : [];
    const v = reasons.length ? 'BLOCK' : 'ALLOW';
    const price = offer ? (typeof finalPrice === 'number' ? finalPrice : offer.priceDrops) : 0;
    const fee = offer?.feeDrops ?? 0;
    const rec = { mh, id: label, v, rc: reasons, m: offer?.merchant ?? '-', it: offer?.id ?? '-', pa: offer?.payee ?? '-', p: price, f: fee, t: price + fee + 12, rq: requestHash(text || 'forced') };
    let tx;
    if (v === 'ALLOW') tx = await payWithRecord(agent, offer.payee, price + fee, 'D', rec);
    else tx = await writeRecord(agent, 'D', rec);
    const after = snapshotUsage();
    return { label, text: text || '(forced proposal)', forced: !!forced, verdict: v, reasons, merchant: offer?.merchant, item: offer?.item, priceXrp: xrp(price), feeXrp: xrp(fee), totalXrp: xrp(rec.t),
      remainingBeforeXrp: xrp((mandate.budgetDrops - (st?.spent ?? 0))), txHash: tx.hash, explorer: explorerTx(tx.hash), log, tokens: delta(before, after), aware: forced ? null : aware, mandateId: mandate.id, mandateHash: mh };
  }
}
