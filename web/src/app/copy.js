// The ONLY place user-facing strings for the owner app live. Plain words for non-technical owners: what is it, what should I do, what happens next.
// Jargon map (internal -> shown): mandate -> limits, dossier -> finding, run -> check, circuit open -> paused, retrying, decision -> request, ledger -> history.
export const BANNED = ['mandate', 'dossier', 'circuit', 'hash', 'epoch', 'calldata', 'ledger', 'nonce', 'payload', 'allowlist'];

export const ROUTES = { welcome: 'Welcome', home: 'Home', council: 'Council', approvals: 'Approvals', watch: 'Watch', vault: 'Vault', build: 'Build' };

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
  modeManualTitle: 'Manual: I approve each action',
  modeManualBody: 'The agent never acts on its own. Anything it wants to publish waits for your OK.',
  modeAutoTitle: 'Auto: it acts within my limits',
  modeAutoBody: 'The agent acts on its own, but only on a product the Council backs and only inside the limits on the Vault page. It also keeps its fuel topped up.',
  hold: 'Hold to approve',
  holding: 'Keep holding…',
  reject: 'Reject',
  emptyApprovals: 'Nothing is waiting for you.',
  emptyApprovalsHelp: 'When the agent wants to do something, it will show up here first.',
  nearStepsIntro: 'Approved. Now sign each step in your wallet, one after another. Your wallet may ask you to switch to the NEAR network, and the first time it asks for a one-time setup.',
  nearOn: 'The vault is on. The agent can now act, but only inside your limits.',
  nearNotOn: 'The limits are set, but the vault is not switched on yet.',
  nearOwnerOnly: 'This vault belongs to a different account, so these buttons are off.',
  nearAccept: 'Accept ownership',
  nearAcceptHelp: 'The current owner handed this vault to your wallet. Accepting makes you the owner.',
  nearSetupHint: 'The first signature is a one-time setup that lets the network send your later steps.',
  agentWaiting: 'Approved. The agent publishes it from its own vault, inside your limits, within a minute or two. This page updates when it is on the network.',
  agentNoVault: 'Approved. To publish it, the agent needs a vault with limits you set. Set one up on the Vault page, then it picks this up on its own.',
  agentHeld: 'Approved, but the agent held this one back. The reason is on the Activity page. You can reject it and ask again.',
  stop: 'Stop the agent',
  stopHelp: 'Stops the agent on the server, then asks your wallet to pause the vault on chain. You can start it again whenever you like.',
  resume: 'Start the agent again',
  // The Build page: the agents write an example page for a product the council backs.
  build: {
    intro: 'The agents write an example page for a product the council backs. You approve it, then you publish it.',
    queue: 'Waiting for a vote',
    queueHelp: 'Ranked by council score. The votes are recounted at every scheduled check; nobody votes on them by hand.',
    queueEmpty: 'No product has been scored yet. The council convenes after the first collection.',
    open: 'Open', selected: 'Selected', showAll: 'Show all', showFewer: 'Show fewer',
    pageBuilt: 'Page built', pagePublished: 'Published',
    steps: ['Council vote', 'Owner vote', 'Build', 'Publish'],
    voteNote: 'These are the stored scores. The bars replay them one by one; it is not a live vote.',
    watchWarn: 'The council said watch, not build. If you go ahead, the page is marked as built on the owner’s call.',
    ownerHelp: 'Your approval starts the build. It is saved in the audit log. It is not a transaction on chain.',
    connect: 'Connect the owner wallet to approve. Everyone else can look and replay.',
    pick: 'Pick a product first.',
    busy: 'A build is running.',
    buildIdle: 'Nothing has been built for this product yet.',
    buildDone: 'The page is built.',
    publishHelp: 'Publishing puts this exact version on the web at the public link. The page says it is an example, not a live service.',
    needBuild: 'Build the page first, then you can publish it.',
    publish: 'Publish', unpublish: 'Unpublish', publishing: 'Publishing…',
    linkPublic: 'Public link (always the latest published version)', linkExact: 'Link to this exact version',
    copy: 'Copy', copied: 'Link copied.',
    preview: 'Preview', replay: 'Replay', skip: 'Skip',
    replayLabel: 'Replay of a stored build. The page was written once by Gemini from stored evidence.',
    emptyPreview: 'No page has been built for this product yet. After you approve, the agents write one and it appears here.',
    reduced: 'Your system asks for less motion, so the replay is off and the page is shown as it is.',
    loadFail: 'Could not load the list of products.',
  },
};

export const CHAIN_NAMES = { 'evm:84532': 'Base Sepolia', 'evm:11155111': 'Sepolia', 'evm:421614': 'Arbitrum Sepolia', 'evm:11155420': 'OP Sepolia', 'evm:10143': 'Monad testnet', 'evm:97': 'BNB testnet', 'evm:31337': 'local test chain', 'near-testnet': 'NEAR testnet' };
export const chainName = (id) => CHAIN_NAMES[id] ?? String(id ?? 'a test network');


/**
 * A token amount for people: "25 USDC". `base` is the integer in the token's smallest unit (string, BigInt or safe integer), `decimals` the token's own.
 * Exact by default. With `max` the fraction is cut to that many digits, always rounded DOWN (a shown amount is never more than the real one).
 * Returns null when the input is not a whole number or the decimals are not usable, so a caller never prints a raw or invented number.
 */
export function tokenAmount(base, decimals, symbol, { max } = {}) {
  let b = null;
  try {
    if (typeof base === 'bigint') b = base;
    else if (typeof base === 'number' && Number.isSafeInteger(base)) b = BigInt(base);
    else if (typeof base === 'string' && /^-?\d+$/.test(base.trim())) b = BigInt(base.trim());
  } catch { b = null; }
  const dec = typeof decimals === 'string' && /^\d+$/.test(decimals) ? Number(decimals) : decimals;
  if (b === null || !Number.isInteger(dec) || dec < 0 || dec > 36) return null;
  const neg = b < 0n; const digits = (neg ? -b : b).toString().padStart(dec + 1, '0');
  const whole = digits.slice(0, digits.length - dec); let frac = dec ? digits.slice(digits.length - dec) : '';
  if (max !== undefined && frac.length > max) frac = frac.slice(0, Math.max(0, max)); // cut, never round
  frac = frac.replace(/0+$/, '');
  let text = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (frac) text += `.${frac}`;
  else if (max !== undefined && b !== 0n && /^0+$/.test(whole) && max > 0) text = `<0.${'0'.repeat(max - 1)}1`;
  else if (max !== undefined && b !== 0n && /^0+$/.test(whole)) text = '<1';
  return `${neg ? '-' : ''}${text}${symbol ? ` ${symbol}` : ''}`;
}

/** Strings for paying people from the vault (Vault page section, the form, empty states, errors). */
export const P = {
  title: 'Payments',
  testToken: 'Test token',
  intro: 'The vault can pay the people on the list below, in the tokens below, never past the limits. Every payment needs your OK first.',
  introAuto: ' In Auto mode the agent may also send a payment on its own, still inside the limits.',
  balance: 'In the vault',
  balanceUnknown: 'unknown right now',
  atMost: 'At most', eachPay: 'for each payment', every: 'every', perPeriodFallback: 'per period', inTotal: 'in total',
  left: '{x} left',
  leftNone: 'nothing left',
  usedPeriod: 'Used this period',
  usedTotal: 'Used in total',
  maxNow: 'The most you can pay right now: {x}.',
  people: 'People it may pay',
  noPeople: 'Nobody is on the list yet, so the vault cannot pay anyone.',
  noTokens: 'No token is set up yet, so the vault cannot pay anyone.',
  notApproved: 'This token is on the vault but not in the limits you approved, so it cannot be used here.',
  recent: 'Recent payments',
  noRecent: 'No payments yet.',
  colWhen: 'When', colTo: 'To', colAmount: 'Amount', colState: 'State', colNote: 'For',
  seeIt: 'see it on the network',
  formTitle: 'Pay someone',
  formHelp: 'This only asks. The money moves after you approve it on the Approvals page, and the agent sends it from the vault.',
  fToken: 'Token', fPayee: 'Pay to', fAmount: 'Amount', fNote: 'Note (optional)', fMore: 'More', fRef: 'Your own reference (optional)',
  fAmountHint: 'In whole tokens, for example 25 or 12.5. Up to {n} decimal places.',
  fNoteHint: 'Shown with the payment. Up to 128 bytes.',
  fSubmit: 'Ask for this payment', fSending: 'Sending…',
  fPickPayee: 'Choose a person',
  fEnter: 'Enter an amount.',
  fFormat: 'Use digits only, like 25 or 12.5.',
  fZero: 'The amount must be more than zero.',
  fPlaces: '{s} has at most {n} decimal places.',
  fAbove: 'That is more than the vault may pay right now. The most is {x}.',
  fNoRoom: 'The limits leave no room for a payment right now.',
  fNote2: 'The note is too long. Keep it under 128 bytes.',
  fRef2: 'The reference is too long. Keep it under 128 bytes.',
  fPayeeNeeded: 'Choose who to pay.',
  fLow: 'The vault holds less than this right now. The agent will hold the payment back until it has enough.',
  sentTitle: 'Request sent',
  sent: 'Now approve it on the Approvals page. Nothing is paid until you do.',
  sentAgain: 'This exact request is already waiting for your approval.',
  open: 'Open Approvals',
  offNoBuild: 'This vault was not set up for payments, so there is nothing to pay from.',
  offNotOn: 'The vault is not switched on yet. Finish the limits first, then you can pay.',
  offPaused: 'The vault or the agent is stopped. Start it again to pay.',
  offNone: 'Set up at least one token and one person first.',
  signIn: 'Connect your wallet to pay someone.',
  whyNoNote: 'The vault pays this person once you approve. The agent sends it, inside your limits.',
  stateWord: { pending: 'Waiting for your OK', approved: 'Approved, sending soon', executing: 'Sending now', executed: 'Paid', rejected: 'Rejected', expired: 'Expired', failed: 'Did not go through' },
  homeLine: 'Payments',
  homePaid: '{x} paid so far',
  homeWaiting: '{n} waiting for your OK',
  homeNone: 'No payments yet',
  errAuth: 'Sign in with the vault owner’s wallet first, then try again.',
  errNetwork: 'The server could not be reached. Nothing was sent. Try again in a moment.',
  errDemo: 'This is demo data, so nothing was sent.',
  errToken: 'That token is not on the vault’s list, so it cannot be paid.',
  errPayee: 'That person is not on the vault’s list, so they cannot be paid.',
  errOver: 'That is above the limit for one payment.',
  errOverMost: 'That is above the limit for one payment. The most is {x}.',
  errNotOn: 'The vault is not switched on for payments yet. Check the limits above, then try again.',
  errRead: 'The vault could not be read just now. Try again in a moment.',
  errAmount: 'Enter an amount above zero.',
  errNote: 'The note or reference is too long. Keep each under 128 bytes.',
  errState: 'The vault is not ready for this payment right now.',
  errGeneric: 'The request was not accepted. Nothing was sent. Try again, or ask whoever runs the server.',
  // The agent's state for an approved payment (mirrors agentWaiting / agentHeld / agentNoVault for publishes).
  waiting: 'Approved. The agent sends the payment from its vault within a minute or two. This page updates when it is done.',
  sending: 'The agent is sending this payment now. This page updates when it is done.',
  held: 'Approved, but the agent held this payment back. The reason is on the Activity page. You can reject it and ask again.',
  noVault: 'Approved. To send it, the agent needs a switched-on vault that is set up to pay this person in this token. Check the Payments section on the Vault page.',
  seeWhy: 'See why', openVault: 'Open Vault',
  // History lines
  paid: 'Paid {x} to {to}',
  paidSomeone: 'A payment was sent from the vault',
  refused: 'A payment was refused: {r}',
  unsure: 'A payment could not be confirmed: {r}',
};
const fill = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
export const pfill = fill;

/** Plain words for a failed or refused payment, from the server's note about it. Never echoes the raw note. */
export function payReason(detail) {
  const d = String(detail ?? '');
  if (/per-?payment cap|PerPayCap/i.test(d)) return 'it is above the limit for one payment';
  if (/period|PeriodCap/.test(d) && /budget|cap/i.test(d)) return 'the budget for this period is used up';
  if (/total budget|TotalCap/.test(d)) return 'the total budget for this token is used up';
  if (/payee is not|PayeeNotAllowed/.test(d)) return 'that person is not on the vault’s list';
  if (/token is not|TokenNotAllowed/.test(d)) return 'that token is not on the vault’s list';
  if (/vault holds|InsufficientBalance|has no spendable/.test(d)) return 'the vault does not hold enough of the token';
  if (/not registered/.test(d)) return 'that person has not set up an account for the token yet';
  if (/paused|Paused/.test(d)) return 'the vault is paused';
  if (/revoked or expired|MandateInactive|NoMandate/.test(d)) return 'the agent’s limits are off or have run out';
  if (/fee/.test(d)) return 'the network fee looked too high';
  if (/token refused/.test(d)) return 'the token refused it, and the vault gave the budget back';
  if (/rejected by the vault/.test(d)) return 'the vault itself refused it, and nothing moved';
  return 'the vault’s rules did not allow it';
}
const payUnsure = (d) => /verification FAILED|unknown outcome|never saved|NOT released|no receipt/i.test(String(d));

/** Map an error from POST /api/payments (ApiError: status, code, message) to one plain sentence. The raw server text is never shown. */
export function payError(e, { maxPayment } = {}) {
  const m = String(e?.message ?? ''); const st = e?.status; const code = e?.code;
  if (code === 'fixture') return P.errDemo;
  if (st === 0 || code === 'network') return P.errNetwork;
  if (st === 401 || code === 'auth') return P.errAuth;
  if (/memo|reference/.test(m) && /at most/.test(m)) return P.errNote;
  if (/above the per-payment cap/.test(m)) { const cap = maxPayment ?? null; return cap ? fill(P.errOverMost, { x: cap }) : P.errOver; }
  if (/payees?\b/.test(m) && /(not one of|not on|must be)/.test(m)) return P.errPayee;
  if (/not one of the tokens|on-chain allowlist|token must be/.test(m)) return P.errToken;
  if (/amount must be/.test(m)) return P.errAmount;
  if (/could not be read just now/.test(m)) return P.errRead;
  if (/not active|no vault is attached|no token payouts|not the payouts build|not attached|more than one vault/.test(m)) return P.errNotOn;
  if (st === 409 || code === 'state') return P.errState;
  return P.errGeneric;
}

/** One plain sentence for a pending/finished request. */
export function describeDecision(d) {
  const net = chainName(d.chain_id);
  if (d.action === 'deploy_testnet') return { title: `Publish the proposals contract on ${net}`, why: 'A finding scored high enough that the agent prepared a ready-to-publish contract. It was built from checked source and tested.', cost: 'Test funds only' };
  if (d.action === 'grant_mandate') return { title: 'Set the agent’s spending limits', why: 'This sets how much fuel the agent may take from the vault and for what. You sign it with your wallet.', cost: 'A small network fee in test funds' };
  if (d.action === 'pay_testnet') {
    const p = d.payload ?? {}; const amt = tokenAmount(p.amount, p.decimals, p.symbol);
    return { title: `Pay ${amt ?? 'an amount'} to ${p.payee ?? 'someone'}`, why: p.memo ? `For: ${p.memo}` : P.whyNoNote, cost: amt ? `${amt} from the vault (test money)` : 'Test money from the vault' };
  }
  return { title: String(d.action ?? 'Request').replace(/_/g, ' '), why: 'The agent asks for your OK.', cost: '–' };
}

export const STATUS_WORD = { pending: 'Waiting for you', approved: 'Approved', executing: 'In progress', executed: 'Done', rejected: 'Rejected', expired: 'Expired', failed: 'Failed' };

/** A history line in plain words (vault ledger entry or audit). */
/** `money` = optional (base-units string) => '0.003 ETH'. Without it the amount is left out rather than shown as raw base units. */
/** `payOf` = optional (entry) => { amount, decimals, symbol, payee } for a payment entry; without it the line says a payment happened, not how much. */
export function historyLine(e, money, payOf) {
  const d = String(e.detail ?? '');
  const amt = e.amount && money ? ` (${money(e.amount)})` : '';
  if (e.kind === 'draw') return /^top-up/.test(d) ? 'The agent refilled its fuel tank' + amt : 'The agent took fuel to pay for an action' + amt;
  if (e.kind === 'deploy') return e.status === 'confirmed' ? 'The agent published a contract' : 'A contract publish did not go through';
  if (e.kind === 'activate') return 'Your limits were checked on chain and switched on';
  if (e.kind === 'anomaly') return 'The agent stopped itself because something did not add up';
  if (e.kind === 'pay') {
    if (e.status === 'confirmed') {
      const p = payOf?.(e) ?? {}; const amt = tokenAmount(p.amount ?? e.amount, p.decimals, p.symbol); const to = p.payee ?? /\bto ([a-z0-9._-]+)/.exec(d)?.[1];
      return amt && to ? fill(P.paid, { x: amt, to }) : P.paidSomeone;
    }
    return fill(payUnsure(d) ? P.unsure : P.refused, { r: payUnsure(d) ? 'the agent stopped itself until someone has checked the network' : payReason(d) });
  }
  if (e.kind === 'refused' && /^payment of .* not sent|^payment refused/.test(d)) return fill(P.refused, { r: payReason(d) });
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
