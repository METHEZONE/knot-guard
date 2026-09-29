// One-time: create + fund the 5 XRPL testnet accounts (owner, agent, 3 merchants) from the public faucet.
import { fund, balance, close, pay } from './chain.js';
import { ROLES, hasKey, saveSeed, load } from './keys.js';
for (const role of ROLES) {
  if (hasKey(role)) { console.log(role, load(role).address, 'exists,', await balance(load(role).address), 'XRP'); continue; }
  const { wallet, balance: b } = await fund(role);
  saveSeed(role, wallet.seed);
  console.log(role, wallet.address, 'funded', b, 'XRP');
}
await close();
