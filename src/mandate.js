import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { writeRecord } from './chain.js';

const dir = path.join(cfg.dataDir, 'mandates');
export const canonical = (o) => JSON.stringify(sortKeys(o));
const sortKeys = (o) => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o;
export const hashMandate = (m) => crypto.createHash('sha256').update(canonical(m)).digest('hex');

/**
 * A Mandate is what the human signs: how much the agent may spend, at whom, and until when.
 * The full JSON is published off-chain (data/mandates/*.json); its SHA-256 is written on-chain by the OWNER wallet,
 * so anyone can later check "these were the exact terms the owner granted".
 */
export function buildMandate({ id, owner, agent, budgetDrops, allow, deadlineUnix, purpose }) {
  return { v: 1, id, owner, agent, budgetDrops, allow, deadlineUnix, purpose };
}

export async function grantMandate(ownerKp, mandate) {
  const h = hashMandate(mandate);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mandate.id + '.json'), JSON.stringify(mandate, null, 2));
  const tx = await writeRecord(ownerKp, 'M', { h, id: mandate.id, ag: mandate.agent, b: mandate.budgetDrops, d: mandate.deadlineUnix, n: mandate.allow.length });
  return { hash: h, tx };
}

export async function revokeMandate(ownerKp, mandate, reason = 'owner pressed STOP') {
  const h = hashMandate(mandate);
  const tx = await writeRecord(ownerKp, 'R', { h, id: mandate.id, why: reason.slice(0, 80) });
  return { hash: h, tx };
}

export const loadMandate = (id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
