import { Client, Wallet, xrpToDrops, dropsToXrp, convertStringToHex, convertHexToString } from 'xrpl';
import { cfg } from './config.js';

// XRPL Testnet: native Memos (our on-chain records), native Payments (settlement), public faucet.
export const NETWORK_FEE_DROPS = 12;                  // typical XRPL tx fee ~10-12 drops; charged to the agent in addition to the payment
export const xrp = (d) => Number(dropsToXrp(String(d)));
export const drops = (x) => Number(xrpToDrops(String(x)));
export const RIPPLE_EPOCH = 946684800;

let client;
export async function api() {
  if (client?.isConnected()) return client;
  client = new Client(cfg.xrplWs);
  await client.connect();
  return client;
}
export async function close() { if (client?.isConnected()) await client.disconnect(); }

// A record written on-chain: Memo{ MemoType: hex("knot1/<TYPE>"), MemoData: hex(compact json) }
const memo = (type, obj) => ({ Memo: { MemoType: convertStringToHex('knot1/' + type), MemoData: convertStringToHex(JSON.stringify(obj)) } });
function decodeMemos(memos = []) {
  for (const { Memo: m } of memos) {
    try {
      const t = convertHexToString(m.MemoType || '');
      if (!t.startsWith('knot1/')) continue;
      return { type: t.slice(6), data: JSON.parse(convertHexToString(m.MemoData || '')) };
    } catch {}
  }
  return null;
}

async function submit(wallet, tx) {
  const c = await api();
  const res = await c.submitAndWait(tx, { wallet, autofill: true });
  const r = res.result.meta.TransactionResult;
  if (r !== 'tesSUCCESS') throw new Error('tx failed ' + r);
  return { hash: res.result.hash, ledger: res.result.ledger_index, closeTime: (res.result.date ?? 0) + RIPPLE_EPOCH };
}

/** record-only tx (mandate grant, revoke, BLOCK decision): AccountSet with a knot1 memo (no balance change) */
export const writeRecord = (wallet, type, obj) => submit(wallet, { TransactionType: 'AccountSet', Account: wallet.address, Memos: [memo(type, obj)] });

/** payment + decision record in ONE tx: either both land or neither */
export const payWithRecord = (wallet, to, amountDrops, type, obj) =>
  submit(wallet, { TransactionType: 'Payment', Account: wallet.address, Destination: to, Amount: String(amountDrops), Memos: [memo(type, obj)] });

export const pay = (wallet, to, amountDrops) => submit(wallet, { TransactionType: 'Payment', Account: wallet.address, Destination: to, Amount: String(amountDrops) });

export async function balance(address) {
  const c = await api();
  try { return Number(await c.getXrpBalance(address)); } catch { return 0; }
}

export async function fund(role) {           // XRPL testnet faucet (no account needed)
  const c = await api();
  const { wallet, balance: b } = await c.fundWallet(null, { faucetHost: cfg.faucetHost });
  return { wallet, balance: b };
}

/** Read + parse every knot1 record in an account's history. The chain is the source of truth. */
export async function readRecords(address, { limit = 200 } = {}) {
  const c = await api();
  const out = [];
  let marker;
  do {
    const r = await c.request({ command: 'account_tx', account: address, limit: Math.min(limit, 200), forward: true, marker });
    for (const t of r.result.transactions) {
      const tx = t.tx_json || t.tx; if (!tx) continue;
      if (!t.validated) continue;
      const rec = decodeMemos(tx.Memos);
      if (!rec || tx.Account !== address) continue;
      out.push({ hash: t.hash || tx.hash, ledger: t.ledger_index || tx.ledger_index, closeTime: (t.close_time_iso ? Date.parse(t.close_time_iso) / 1000 : (tx.date ?? 0) + RIPPLE_EPOCH), ...rec,
        payment: tx.TransactionType === 'Payment' ? { to: tx.Destination, drops: Number(tx.DeliverMax ?? tx.Amount) } : null });
    }
    marker = r.result.marker;
  } while (marker && out.length < limit);
  return out;
}

/** Fetch a tx by hash and reconstruct facts from the ledger alone */
export async function getTxFacts(hash) {
  const c = await api();
  const r = (await c.request({ command: 'tx', transaction: hash })).result;
  const tx = r.tx_json || r;
  const closeTime = r.close_time_iso ? Date.parse(r.close_time_iso) / 1000 : (r.date ?? tx.date ?? 0) + RIPPLE_EPOCH;
  return { hash, ledger: r.ledger_index, closeTime, signer: tx.Account, feeDrops: Number(tx.Fee), ok: r.meta?.TransactionResult === 'tesSUCCESS', validated: !!r.validated,
    record: decodeMemos(tx.Memos), payment: tx.TransactionType === 'Payment' ? { from: tx.Account, to: tx.Destination, drops: Number(tx.DeliverMax ?? tx.Amount ?? 0) } : null };
}
export const explorerTx = (h) => `https://testnet.xrpl.org/transactions/${h}`;
export const explorerAddr = (a) => `https://testnet.xrpl.org/accounts/${a}`;
