// Human-side console: grant a budget, watch what the agent does, press STOP, read receipts, audit any tx.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { all } from './keys.js';
import { balance, readRecords, xrp, drops, explorerTx, explorerAddr } from './chain.js';
import { buildMandate, grantMandate, revokeMandate, hashMandate } from './mandate.js';
import { purchase } from './run.js';
import { auditTx } from './audit.js';
import { catalog } from './market.js';
import { energyReport, currentModel, ensureModel } from './kiln.js';

const k = all();
const mdir = path.join(cfg.dataDir, 'mandates');
const loadMandates = () => (fs.existsSync(mdir) ? fs.readdirSync(mdir).map((f) => JSON.parse(fs.readFileSync(path.join(mdir, f), 'utf8'))) : []);
const send = (res, code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

async function state() {
  await ensureModel();
  const [ownerRecs, agentRecs, ob, ab] = await Promise.all([readRecords(k.owner.address), readRecords(k.agent.address), balance(k.owner.address), balance(k.agent.address)]);
  const mandates = loadMandates().map((m) => {
    const h = hashMandate(m);
    const granted = ownerRecs.find((r) => r.type === 'M' && r.data.h === h);
    const revoked = ownerRecs.find((r) => r.type === 'R' && r.data.h === h);
    const spent = agentRecs.filter((r) => r.type === 'D' && r.data.mh === h && r.data.v === 'ALLOW').reduce((s, r) => s + r.data.t, 0);
    return { id: m.id, hash: h, budgetXrp: xrp(m.budgetDrops), spentXrp: xrp(spent), allow: m.allow.map((a) => a.name), deadline: new Date(m.deadlineUnix * 1000).toISOString(), expired: Date.now() / 1000 > m.deadlineUnix, revoked: !!revoked, onChain: !!granted, grantTx: granted && explorerTx(granted.hash), revokeTx: revoked && explorerTx(revoked.hash) };
  });
  const decisions = agentRecs.filter((r) => r.type === 'D').map((r) => ({ hash: r.hash, explorer: explorerTx(r.hash), mandate: r.data.mh.slice(0, 8), label: r.data.id, verdict: r.data.v, reasons: r.data.rc, merchant: r.data.m, totalXrp: xrp(r.data.t), at: r.closeTime })).reverse();
  return { network: cfg.network, model: currentModel() + (currentModel() !== cfg.kilnModel ? ' (gpt-oss-120b not served by Kiln yet)' : ''), owner: { addr: k.owner.address, url: explorerAddr(k.owner.address), xrp: ob }, agent: { addr: k.agent.address, url: explorerAddr(k.agent.address), xrp: ab },
    mandates: mandates.reverse(), decisions, shops: catalog().offers.map((o) => ({ id: o.id, merchant: o.merchant, item: o.item, priceXrp: o.priceXrp, feeXrp: o.feeXrp })), usage: energyReport() };
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(cfg.root, 'web', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, await state());
    if (req.method === 'POST' && u.pathname === '/api/grant') {
      const b = await body(req);
      const allow = (b.allow || []).map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), addr: k['merchant_' + id].address }));
      const m = buildMandate({ id: 'ui-' + Date.now().toString(36), owner: k.owner.address, agent: k.agent.address, budgetDrops: drops(Number(b.budgetXrp)), allow, deadlineUnix: Math.floor(Date.now() / 1000) + Number(b.minutes || 60) * 60, purpose: b.purpose || 'UI grant' });
      const g = await grantMandate(k.owner, m);
      return send(res, 200, { id: m.id, tx: explorerTx(g.tx.hash) });
    }
    if (req.method === 'POST' && u.pathname === '/api/revoke') {
      const b = await body(req); const m = loadMandates().find((x) => x.id === b.id);
      const r = await revokeMandate(k.owner, m, 'owner pressed STOP in console');
      return send(res, 200, { tx: explorerTx(r.tx.hash) });
    }
    if (req.method === 'POST' && u.pathname === '/api/purchase') {
      const b = await body(req); const m = loadMandates().find((x) => x.id === b.id);
      const r = await purchase({ label: 'ui-' + Date.now().toString(36), text: b.text, mandate: m, aware: b.aware !== false, forced: b.forced || null });
      return send(res, 200, r);
    }
    if (req.method === 'POST' && u.pathname === '/api/audit') { const b = await body(req); return send(res, 200, await auditTx(b.hash)); }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(Number(process.env.PORT || 4791), () => console.log('knot Guard console on http://localhost:' + (process.env.PORT || 4791)));
