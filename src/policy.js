import { NETWORK_FEE_DROPS, readRecords } from './chain.js';
import { hashMandate } from './mandate.js';

/**
 * THE GUARD. Pure code, zero LLM tokens. This is the only place where the boundary is enforced:
 * the agent (LLM) can *propose* anything, but a payment tx is only ever built if guard() returns ok.
 *
 * Boundary the agent must not cross (state is read from the XRPL ledger + the owner-signed mandate):
 *   1. the mandate was granted on-chain by the OWNER account (hash of the published JSON matches)
 *   2. the owner has not revoked it on-chain (kill switch)
 *   3. the deadline has not passed
 *   4. the payee ACCOUNT ADDRESS is on the mandate allowlist (display names are never trusted)
 *   5. price + merchant fee + network fee <= remaining budget (remaining = budget - all ALLOWed spend found on-chain)
 */
export async function chainState(mandate) {
  const h = hashMandate(mandate);
  const [ownerRecs, agentRecs] = await Promise.all([readRecords(mandate.owner), readRecords(mandate.agent)]);
  const granted = ownerRecs.find((r) => r.type === 'M' && r.data.h === h);
  const revoked = ownerRecs.find((r) => r.type === 'R' && r.data.h === h);
  const spent = agentRecs.filter((r) => r.type === 'D' && r.data.mh === h && r.data.v === 'ALLOW').reduce((s, r) => s + r.data.t, 0);
  return { hash: h, granted, revoked, spent };
}

export function guard(proposal, mandate, st, nowUnix = Math.floor(Date.now() / 1000)) {
  const reasons = [];
  if (!st.granted) reasons.push('MANDATE_NOT_ON_CHAIN');
  if (st.revoked) reasons.push('MANDATE_REVOKED');
  if (nowUnix > mandate.deadlineUnix) reasons.push('DEADLINE_PASSED');
  if (!mandate.allow.some((a) => a.addr === proposal.payee)) reasons.push('MERCHANT_NOT_ALLOWED');
  const total = proposal.priceDrops + proposal.feeDrops + NETWORK_FEE_DROPS;
  const remaining = mandate.budgetDrops - st.spent;
  if (total > remaining) reasons.push('BUDGET_EXCEEDED');
  return { ok: reasons.length === 0, reasons, totalDrops: total, remainingDrops: remaining, priceOnlyWithinBudget: proposal.priceDrops <= remaining };
}
