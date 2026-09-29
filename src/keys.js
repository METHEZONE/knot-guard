import fs from 'node:fs';
import path from 'node:path';
import { Wallet } from 'xrpl';
const dir = path.resolve(import.meta.dirname, '..', '.keys');
// owner = the human's wallet (ARCA user), agent = delegated hot wallet, merchants = seller wallets
export const ROLES = ['owner', 'agent', 'merchant_lumen', 'merchant_orbit', 'merchant_shadyshop'];
const file = (name) => path.join(dir, name + '.json');
export const hasKey = (name) => fs.existsSync(file(name));
export function saveSeed(name, seed) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(name), JSON.stringify({ seed }), { mode: 0o600 }); }
export function load(name) { return Wallet.fromSeed(JSON.parse(fs.readFileSync(file(name), 'utf8')).seed); }
export function all() { return Object.fromEntries(ROLES.filter(hasKey).map((r) => [r, load(r)])); }
