// The ONLY place user-facing strings for the owner app live. Plain words for non-technical owners: what is it, what should I do, what happens next.
// Jargon map (internal -> shown): mandate -> limits, dossier -> finding, run -> check, circuit open -> paused, retrying, decision -> request, ledger -> history.
export const BANNED = ['mandate', 'dossier', 'circuit', 'hash', 'epoch', 'calldata', 'ledger', 'nonce', 'payload', 'allowlist'];

export const ROUTES = { home: 'Home', approvals: 'Approvals', watch: 'Watch', vault: 'Vault' };

export const T = {
  brand: 'AutoNEAR',
  tagline: 'An AI agent that watches NEAR for you, and can only spend what you allow.',
  steps: [
    ['Watch', 'The agent reads GitHub, the NEAR forum, news and the chain around the clock and keeps score of what looks worth doing.'],
    ['Ask', 'When it wants to act, it asks you first. Or you let it act on its own, inside limits you set.'],
    ['Stay safe', 'It has its own small fuel tank of test funds. It can never go past your limits, and you can stop it any time.'],
  ],
  connect: 'Connect wallet',
  demo: 'Explore the demo',
  connecting: 'Check your wallet…',
  noWallet: 'No wallet found in this browser. Install a wallet such as MetaMask, or explore the demo.',
  signHint: 'You will be asked to sign a message. It is free and sends nothing on chain.',
  readOnly: 'This wallet is not the owner of the vault, so you can look around but not change anything.',
  contractWallet: 'Smart-contract wallets and multisigs cannot sign in here yet. Ask the operator for access.',
  testnet: 'Testnet only',
  demoBadge: 'Demo data',
  demoNote: 'Example data so you can see how it works. Nothing here is real or can be changed.',
  demoNoVault: 'No vault is connected yet, so the vault numbers and history below are examples. Your real requests and settings are shown as they are.',
  signOut: 'Disconnect',
  activity: 'Activity',
  modeManualTitle: 'I approve each action',
  modeManualBody: 'The agent never acts on its own. Anything it wants to publish waits for your OK.',
  modeAutoTitle: 'Let it act within my limits',
  modeAutoBody: 'The agent acts on its own, but only inside the limits on the Vault page. It also keeps its fuel topped up.',
  hold: 'Hold to approve',
  holding: 'Keep holding…',
  reject: 'Reject',
  emptyApprovals: 'Nothing is waiting for you.',
  emptyApprovalsHelp: 'When the agent wants to do something, it will show up here first.',
  nearStepsIntro: 'Approved. Now sign each step in your wallet, one after another. Your wallet may ask you to switch to the NEAR network, and the first time it asks for a one-time setup.',
  nearOwnerOnly: 'This vault belongs to a different account, so these buttons are off.',
  nearAccept: 'Accept ownership',
  nearAcceptHelp: 'The current owner handed this vault to your wallet. Accepting makes you the owner.',
  nearSetupHint: 'The first signature is a one-time setup that lets the network send your later steps.',
  stop: 'Stop the agent',
  stopHelp: 'Stops the agent on the server, then asks your wallet to pause the vault on chain. You can start it again whenever you like.',
  resume: 'Start the agent again',
};

export const CHAIN_NAMES = { 'evm:84532': 'Base Sepolia', 'evm:11155111': 'Sepolia', 'evm:421614': 'Arbitrum Sepolia', 'evm:11155420': 'OP Sepolia', 'evm:10143': 'Monad testnet', 'evm:97': 'BNB testnet', 'evm:31337': 'local test chain', 'near-testnet': 'NEAR testnet' };
export const chainName = (id) => CHAIN_NAMES[id] ?? String(id ?? 'a test network');

/** One plain sentence for a pending/finished request. */
export function describeDecision(d) {
  const net = chainName(d.chain_id);
  if (d.action === 'deploy_testnet') return { title: `Publish the proposals contract on ${net}`, why: 'A finding scored high enough that the agent prepared a ready-to-publish contract. It was built from checked source and tested.', cost: 'Test funds only' };
  if (d.action === 'grant_mandate') return { title: 'Set the agent’s spending limits', why: 'This sets how much fuel the agent may take from the vault and for what. You sign it with your wallet.', cost: 'A small network fee in test funds' };
  return { title: String(d.action ?? 'Request').replace(/_/g, ' '), why: 'The agent asks for your OK.', cost: '–' };
}

export const STATUS_WORD = { pending: 'Waiting for you', approved: 'Approved', executing: 'In progress', executed: 'Done', rejected: 'Rejected', expired: 'Expired', failed: 'Failed' };

/** A history line in plain words (vault ledger entry or audit). */
/** `money` = optional (base-units string) => '0.003 ETH'. Without it the amount is left out rather than shown as raw base units. */
export function historyLine(e, money) {
  const d = String(e.detail ?? '');
  const amt = e.amount && money ? ` (${money(e.amount)})` : '';
  if (e.kind === 'draw') return /^top-up/.test(d) ? 'The agent refilled its fuel tank' + amt : 'The agent took fuel to pay for an action' + amt;
  if (e.kind === 'deploy') return e.status === 'confirmed' ? 'The agent published a contract' : 'A contract publish did not go through';
  if (e.kind === 'activate') return 'Your limits were checked on chain and switched on';
  if (e.kind === 'anomaly') return 'The agent stopped itself because something did not add up';
  if (e.kind === 'refused') return d.startsWith('left for a human') ? 'The agent left a request for you' : 'The agent was stopped by its limits';
  if (e.kind === 'loop') return /resumed/.test(d) ? 'The agent was started' : /paused/.test(d) ? 'The agent was paused' : 'The agent did a routine step';
  return d.slice(0, 80) || 'Update';
}

export function homeLine({ demo, paused, mode, pending, vaultLive, sourcesOk, sourcesTotal, signing }) {
  if (paused) return ['The agent is stopped.', 'Nothing will happen until you start it again.'];
  if (pending > 0) return [`${pending} ${pending === 1 ? 'thing needs' : 'things need'} your OK.`, 'Open Approvals to look and decide.'];
  const watching = `Watching ${sourcesOk} of ${sourcesTotal} sources.`;
  if (demo) return [watching, 'The vault below is example data until you connect one.'];
  if (!vaultLive) return [watching, 'No vault is connected yet, so the agent can only watch.'];
  if (!signing) return [watching, 'The vault is ready, but the agent is not running on this server, so it can only watch.'];
  return mode === 'auto' ? [watching, 'Auto mode: it will act on its own inside your limits.'] : [watching, 'Manual mode: it will ask you before it acts. Nothing needs you now.'];
}
