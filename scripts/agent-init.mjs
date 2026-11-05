// Create the agent's own TESTNET keys if missing (idempotent) and print ONLY public addresses + funding instructions.
//   node scripts/agent-init.mjs          create missing keys, print addresses
//   node scripts/agent-init.mjs --print  print addresses; never create or modify anything
// Private keys are never printed. Keys live in data/agent.keys.json (mode 0600, gitignored) unless
// AGENT_EVM_PRIVATE_KEY / AGENT_NEAR_PRIVATE_KEY are set (env wins).
import { loadKeystore, KeystoreError } from '../src/agent/keystore.js';

const args = new Set(process.argv.slice(2));
if ([...args].some((a) => a !== '--print' && a !== '--help' && a !== '-h')) { console.error('usage: node scripts/agent-init.mjs [--print]'); process.exit(2); }
if (args.has('--help') || args.has('-h')) { console.log('usage: node scripts/agent-init.mjs [--print]\n  --print  show addresses only; do not create or modify keys'); process.exit(0); }
const printOnly = args.has('--print');

let ks;
try {
  const before = loadKeystore({ create: false });
  ks = printOnly ? before : loadKeystore({ create: true });
  const created = !printOnly && (!before.evm || !before.near);
  const v = ks.publicView();
  console.log(printOnly ? 'AutoNEAR agent wallet (read-only view)' : created ? 'AutoNEAR agent wallet: created missing keys' : 'AutoNEAR agent wallet: keys already present, nothing changed');
  console.log(`key file : ${ks.path} (mode 0600, gitignored; env AGENT_EVM_PRIVATE_KEY / AGENT_NEAR_PRIVATE_KEY override it)`);
  console.log('');
  if (v.evm) console.log(`EVM address        : ${v.evm.address}   [key source: ${v.evm.source}]`); else console.log('EVM address        : (no key; run without --print to create)');
  if (v.near) {
    console.log(`NEAR account       : ${v.near.account}   [key source: ${v.near.source}]`);
    console.log(`NEAR public key    : ${v.near.publicKey}`);
  } else console.log('NEAR account       : (no key; run without --print to create)');
  console.log('\nFunding (TESTNET ONLY; this agent never holds mainnet funds):');
  console.log('  1. The OWNER sets a mandate on the vault binding the agent: EVM set_mandate(agent = the EVM address above); NEAR set_mandate(agent = the NEAR account above).');
  console.log('  2. The agent needs a small seed balance to pay gas for its FIRST draw: send a few cents of testnet ETH to the EVM address on the vault\'s chain,');
  console.log('     and/or ~0.1 testnet NEAR to the NEAR implicit account (it only exists on-chain once funded). After that, gas comes from vault draws.');
  console.log('  3. Never paste a private key into chat, issues or logs. Verify with: node scripts/agent-init.mjs --print');
} catch (e) {
  const msg = ks ? ks.redact(e).message : (e instanceof KeystoreError ? e.message : 'failed to load keystore');
  console.error(`agent-init: ${msg}`);
  process.exit(1);
}
