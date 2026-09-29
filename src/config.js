import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
// tiny .env loader (no dependency)
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
export const cfg = {
  root,
  dataDir: path.join(root, 'data'),
  xrplWs: process.env.XRPL_WS || 'wss://s.altnet.rippletest.net:51233',
  faucetHost: process.env.XRPL_FAUCET || 'faucet.altnet.rippletest.net',
  network: 'XRPL Testnet',
  kilnKey: process.env.KILN_API_KEY,
  kilnBase: process.env.KILN_BASE_URL || 'https://api.bricksum.com/v1',
  // The hackathon brief asks for gpt-oss-120b. On 2026-09-30 Kiln's gateway lists it as "coming soon"
  // (HTTP 404 model_not_found), so the model is configurable and we fall back to what Kiln serves.
  kilnModel: process.env.KILN_MODEL || 'gpt-oss-120b',
  kilnFallbackModel: process.env.KILN_FALLBACK_MODEL || 'qwen3-32b',
  // Energy model ASSUMPTIONS (Kiln exposes no energy telemetry). Joules per generated/processed token.
  // Clearly labelled assumptions, override via env. See README "Energy estimate".
  jPerTokenNpu: Number(process.env.J_PER_TOKEN_NPU || 0.35),
  jPerTokenGpu: Number(process.env.J_PER_TOKEN_GPU || 1.2),
};
