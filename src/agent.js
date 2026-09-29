import crypto from 'node:crypto';
import { chat } from './kiln.js';
import { drops, xrp } from './chain.js';

/**
 * The spending agent. The LLM (Kiln) does the *language* work; code does everything that must be exact:
 *   intake     LLM   natural-language request -> {category, maxPriceXrp, prefer}
 *   (filter)   code  keep only offers of that category                       (fewer prompt tokens)
 *   select     LLM   pick one offer, with a reason                            (this is where an agent can be fooled)
 *   negotiate  LLM   buyer agent counter-offer + seller agent reply (knot)    (seller floor enforced in code)
 *   guard      code  see policy.js — zero tokens, cannot be talked around
 *   explain    LLM   plain-language receipt for a human, written from audited facts
 */

const CATEGORIES = ['ai-review', 'ai-transcription'];

export async function intake(text) {
  const r = await chat('intake',
    `You convert a shopping request into JSON. Categories: ${CATEGORIES.join(', ')}. Output ONLY JSON: {"category":<one of categories>,"maxPriceXrp":<number or null>,"prefer":"cheapest"|"best"}.`,
    text, { max_tokens: 80 });
  const j = r.json || {};
  return { category: CATEGORIES.includes(j.category) ? j.category : null, maxPriceXrp: typeof j.maxPriceXrp === 'number' ? j.maxPriceXrp : null, prefer: j.prefer === 'cheapest' ? 'cheapest' : 'best', _cached: r.cached };
}

export async function select(need, offers, userText, approved = []) {
  // code-side pre-filter: fewer options in the prompt = fewer tokens and less to be misled by
  const pool = offers.filter((o) => o.category === need.category);
  if (!pool.length) return { offer: null, reason: 'no offers in category' };
  const list = pool.map((o) => `- id=${o.id} | ${o.merchant} | ${o.item} | price ${o.priceXrp} XRP + fee ${o.feeXrp} XRP | ${o.desc}`).join('\n');
  const r = await chat('select',
    'You are a purchasing agent. Choose ONE offer for the user. Output ONLY JSON: {"offer_id":"<id>","reason":"<max 15 words>"}.',
    `User request: "${userText}"\nOwner-approved shops: ${approved.length ? approved.join(', ') : 'any'}.\nPreference: ${need.prefer}. Max price: ${need.maxPriceXrp ?? 'none'} XRP.\nOffers:\n${list}`, { max_tokens: 90 });
  const offer = pool.find((o) => o.id === r.json?.offer_id) || null;
  return { offer, reason: r.json?.reason || '', pool: pool.length };
}

/** Buyer agent asks for a discount; seller agent answers. Seller's price floor is private and enforced in code, not by the model. */
export async function negotiate(offer, maxTotal) {
  if (offer.floorDrops >= offer.priceDrops) return { finalDrops: offer.priceDrops, transcript: ['seller: no discount available on this item (floor = list price)'], rounds: 0 };
  const buyer = await chat('negotiate',
    'You are the BUYER agent. Ask the seller for a lower price, politely. Output ONLY JSON: {"counter_xrp":<number>,"message":"<max 20 words>"}. Never offer more than the list price.',
    `Item: ${offer.item}. List price ${offer.priceXrp} XRP.${maxTotal ? ` Owner budget is tight.` : ''} Propose about 10% less.`, { max_tokens: 90 });
  let counter = drops(Number(buyer.json?.counter_xrp) || xrp(offer.priceDrops));
  counter = Math.min(counter, offer.priceDrops);
  const seller = await chat('negotiate',
    'You are the SELLER agent. Accept the buyer counter if it is at or above your floor price, otherwise reply with your floor price. Output ONLY JSON: {"accept":true|false,"price_xrp":<number>,"message":"<max 20 words>"}.',
    `List ${offer.priceXrp} XRP. Your private floor ${offer.floorXrp} XRP. Buyer counter ${xrp(counter)} XRP.`, { max_tokens: 90 });
  let final = drops(Number(seller.json?.price_xrp) || xrp(offer.priceDrops));
  final = Math.max(final, offer.floorDrops);            // code enforces the seller floor
  final = Math.min(final, offer.priceDrops);            // and never above list
  if (counter >= offer.floorDrops && seller.json?.accept) final = Math.max(counter, offer.floorDrops);
  return { finalDrops: final, transcript: [`buyer: ${buyer.json?.message ?? ''} (${xrp(counter)} XRP)`, `seller: ${seller.json?.message ?? ''} (${xrp(final)} XRP)`], rounds: 1 };
}

export async function explain(facts) {
  const r = await chat('explain',
    'You write a 2-sentence plain-English receipt for a non-technical owner about an AI agent spending decision. Currency is XRP (never use $). Use ONLY the facts given. If decision is BLOCK, say clearly that NO money was spent and why it was stopped. If ALLOW, say the amount paid was inside the allowed budget. No markdown.',
    JSON.stringify(facts), { max_tokens: 120, json: false });
  return r.text;
}

export const requestHash = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
