// Gap-filler between a chain adapter and what the core/loop needs. the Mandate Vault spec fixes the BINDING adapter interface; the core also needs a few
// more methods (preview, estimateFee, signerOptions, deployTarget, planSteps; see src/vault/index.js). src/vault/evm.js implements all of them natively.
// For any adapter that lacks one (today: src/vault/near.js, which has previewDraw/previewDeploy but not the rest), this file supplies a documented
// fallback. A method the adapter DOES define always wins. NONE of the NEAR fallbacks has been exercised against a NEAR node: they are derived from
// src/agent/near-signer.js (gas constants and fee formula) and scripts/near-vault-deploy.sh (CLI syntax).
import { jsonRpc } from '../chains/common.js';
import { UNITS, formatUnits } from './units.js';

const TGAS = 10n ** 12n;
// Mirrors DEFAULT_GAS and gasPriceMultiplier (1.5) in src/agent/near-signer.js createNearSigner: worst-case fee = attached gas x gas price x 1.5.
const NEAR_GAS = { draw: 50n * TGAS, deploy: 300n * TGAS };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const code = (r) => String(r ?? '').replace(/^E_/, '').split(/[:\s]/)[0];

export function completeAdapter(protocol, a) {
  if (!a || protocol !== 'near') return a;
  const out = { ...a };
  const networkIdOf = (net) => (net.id === 'near-testnet' ? 'testnet' : 'unsupported');
  if (typeof a.preview !== 'function' && typeof a.previewDraw === 'function' && typeof a.previewDeploy === 'function') {
    out.preview = async (kind, { net, vault, amount, template, nameOrSalt, fetchImpl }) => code(kind === 'draw'
      ? await a.previewDraw({ net, vault, amount: String(amount), fetchImpl })
      : await a.previewDeploy({ net, vault, template: String(template).replace(/^0x/, ''), name: nameOrSalt, fetchImpl }));
  }
  if (typeof a.estimateFee !== 'function') {
    out.estimateFee = async ({ net, call, fetchImpl }) => {
      const price = BigInt((await jsonRpc('launch', net.rpc, 'gas_price', [null], { fetchImpl })).gas_price);
      const gas = NEAR_GAS[call.method]; if (!gas) throw new Error(`no gas figure for method ${call.method}`);
      return { gas, price, worstCaseFee: (gas * price * 150n + 99n) / 100n };
    };
  }
  if (typeof a.signerOptions !== 'function') out.signerOptions = ({ net, fetchImpl, extra = {} }) => ({ rpcUrl: net.rpc, networkId: networkIdOf(net), fetchImpl, role: 'launch', ...extra });
  if (typeof a.deployTarget !== 'function') {
    out.deployTarget = ({ decision, vault }) => {
      const payload = typeof decision.payload === 'string' ? JSON.parse(decision.payload) : decision.payload;
      const acct = payload?.registry?.contractAccount;
      if (typeof acct !== 'string' || !acct.endsWith(`.${vault}`)) throw new Error(`NEAR deploys through the vault create {name}.${vault}: payload.registry.contractAccount must be a sub-account of the vault`);
      const name = acct.slice(0, -(vault.length + 1));
      if (typeof a.validSubName === 'function' && !a.validSubName(name)) throw new Error(`"${name}" is not a valid vault sub-account name`);
      return { nameOrSalt: name, predicted: acct };
    };
  }
  if (typeof a.planSteps !== 'function') {
    out.planSteps = ({ net, payload, vault }) => {
      const net_ = networkIdOf(net); const m = payload.mandate; const owner = payload.vault.owner; const agent = payload.agent.account;
      const call = (method, args) => `near contract call-function as-transaction ${shq(vault)} ${method} json-args ${shq(JSON.stringify(args))} prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${shq(owner)} network-config ${net_} sign-with-keychain send`;
      const send = (to, amountYocto) => `near tokens ${shq(owner)} send-near ${shq(to)} '${formatUnits(amountYocto, UNITS.near.decimals)} NEAR' network-config ${net_} sign-with-keychain send`;
      const steps = payload.templates.map((t) => ({
        who: 'human', title: `allow_template: ${t.label}`, note: `Owner allowlists template ${t.templateId} (sha256 of the attested wasm) with the init args fixed in this decision. Sub-account deposit ${formatUnits(t.deposit, 24)} NEAR is charged to the budget and is unrecoverable (the sub-account has no keys).`,
        cli: call('allow_template', { template_id: t.templateId, label: t.label, deposit: String(t.deposit), init_args: t.initMaterial ?? {}, init_gas: '30000000000000' }),
      }));
      steps.push({
        who: 'human', title: 'set_mandate', note: `Binds the agent ${agent}. expires_at (${m.expiresAt}) must still satisfy now < expires_at <= now + 30 days when you send this, otherwise the vault panics E_BadMandate: propose again. All amounts are yoctoNEAR.`,
        cli: call('set_mandate', { agent, expires_at: m.expiresAt, per_draw_cap: m.perDrawCap, period_secs: m.periodSecs, period_cap: m.periodCap, total_cap: m.totalCap, max_deploys: Number(m.maxDeploys) }),
      });
      steps.push({ who: 'human', title: `Fund the vault with ${formatUnits(payload.fund.amount, 24)} NEAR`, note: 'Plain transfer to the vault account. Gifts only; you can withdraw everything back at any time.', cli: send(vault, BigInt(payload.fund.amount)) });
      steps.push({ who: 'human', title: 'Seed the agent account so it exists and can pay gas for its first draw', note: `The agent's implicit account ${agent} only exists on-chain once funded; it pays gas for its OWN draw.`, cli: send(agent, 100000000000000000000000n) });
      return steps;
    };
  }
  return out;
}
