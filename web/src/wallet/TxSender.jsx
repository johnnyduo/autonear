// EVM signing step for a mandate grant. Lazy-loaded from views/vault/Grant.jsx so wagmi + viem stay OUT of the initial bundle.
// Human signing is a real wallet action: this component only hands the exact plan transactions to the wallet to confirm.
// Nothing here signs, simulates a signature, or holds a key. It is never mounted in fixture mode.
import { createContext, useContext, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useConnect, useConnection, useConnectors, useDisconnect, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi';
import { Chip, Icon } from '../ui.jsx';
import { walletConfig, chainById, chainIdOf } from './config.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '–');
const PropsCtx = createContext(null);

// Same provider-once pattern as WalletPanel (wagmi's <Hydrate> re-runs onMount on every render when ssr is off).
export default function TxSender(props) {
  const tree = useMemo(() => (
    <WagmiProvider config={walletConfig()} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}><Inner /></QueryClientProvider>
    </WagmiProvider>
  ), []);
  return <PropsCtx.Provider value={props}>{tree}</PropsCtx.Provider>;
}

function Inner() {
  const { txs, decision } = useContext(PropsCtx);
  const targetId = chainIdOf(decision.chain_id); const target = chainById(targetId);
  const conn = useConnection(); const connectors = useConnectors();
  const { connect, isPending: connecting, error: connectErr } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchErr } = useSwitchChain();
  const bound = decision.bound_signer ?? '';
  const signerOk = Boolean(conn.address) && Boolean(bound) && conn.address.toLowerCase() === bound.toLowerCase();
  const onTarget = conn.isConnected && conn.chainId === targetId;
  if (!target) return <div className="banner risk" role="alert"><Icon name="alert" /><div>The wallet layer has no configured testnet for <span className="mono-v">{decision.chain_id}</span>. Sign with your own CLI instead; the server verifies the same way.</div></div>;
  const why = !conn.isConnected ? 'Connect a wallet first.' : !signerOk ? `This decision is bound to ${short(bound) || 'a signer'}. Switch the wallet account to that address.` : !onTarget ? `Switch the wallet to ${target.name} (${target.id}).` : null;
  return (
    <div className="stack">
      <div className="wp-head"><div><div className="eyebrow">Target chain</div><div className="wp-chain"><b>{target.name}</b> <span className="mono-v faint">chain id {target.id}</span></div></div><Chip tone="mineral">testnet / local only</Chip></div>
      <div className="wp-step">
        <h4 className="wp-h">Connect your wallet</h4>
        {conn.isConnected ? (
          <div className="stack-s">
            <dl className="kv"><dt>Account</dt><dd className="mono-v">{conn.address}</dd><dt>Bound signer</dt><dd className="mono-v">{bound || '–'} {signerOk ? <Chip tone="ok">account matches</Chip> : <Chip tone="bad">account differs</Chip>}</dd><dt>Wallet chain</dt><dd className="mono-v">{conn.chainId} {onTarget ? <Chip tone="ok">matches</Chip> : <Chip tone="warn">wrong chain</Chip>}</dd></dl>
            <div className="row">
              {!onTarget && <button className="btn primary" disabled={switching} onClick={() => switchChain({ chainId: targetId })}>{switching ? 'Waiting for wallet…' : `Switch to ${target.name}`}</button>}
              <button className="btn" onClick={() => disconnect()}>Disconnect</button>
            </div>
            {switchErr && <p className="err-t" role="alert">{switchErr.shortMessage ?? switchErr.message}</p>}
          </div>
        ) : connectors.length ? (
          <div className="wp-wallets" role="group" aria-label="Detected wallets">
            {connectors.map((c) => <button key={c.uid} className="btn wp-wallet" disabled={connecting} onClick={() => connect({ connector: c })}>{c.icon ? <img src={c.icon} alt="" width="20" height="20" /> : <Icon name="wallet" size={18} />}<span>{c.id === 'injected' ? 'Browser wallet' : c.name}</span></button>)}
          </div>
        ) : <p className="dim">No browser wallet detected. Install or unlock a wallet extension, or send these calls with Foundry <span className="mono-v">cast send</span>; the server only looks at chain state.</p>}
        {connectErr && <p className="err-t" role="alert">{connectErr.shortMessage ?? connectErr.message}</p>}
      </div>
      <ol className="vt-sends">{txs.map((t, i) => <SendRow key={t.key} n={i + 1} t={t} targetId={targetId} why={why} />)}</ol>
      <p className="help" style={{ margin: 0 }}>Send them in order. Your wallet shows the final prompt; AutoNEAR never sees a key. A mined transaction is not an activation: step 3 below shows what the server then reads from the chain.</p>
    </div>
  );
}

function SendRow({ n, t, targetId, why }) {
  const { sendTransaction, isPending, error, data: hash } = useSendTransaction();
  const mined = useWaitForTransactionReceipt({ hash, chainId: targetId });
  const blocked = !t.ok ? 'Blocked: this transaction did not pass the cross-check with the approved decision.' : why;
  const go = () => sendTransaction({ to: t.tx.to, data: t.tx.data && t.tx.data !== '0x' ? t.tx.data : undefined, value: BigInt(t.tx.value ?? '0'), chainId: targetId });
  return (
    <li className="vt-send-i">
      <div className="row"><b>{n}. {t.title}</b>
        <button className="btn primary" onClick={go} disabled={Boolean(blocked) || isPending || Boolean(hash)} aria-describedby={blocked ? `why-${t.key}` : undefined}><Icon name="wallet" size={16} />{isPending ? 'Confirm in your wallet…' : hash ? 'Sent' : `Send step ${n}`}</button></div>
      {blocked && <span id={`why-${t.key}`} className="help">{blocked}</span>}
      {error && <p className="err-t" role="alert">{error.shortMessage ?? error.message}</p>}
      {hash && <div className="stack-s" aria-live="polite"><span className="mono-v">tx {hash}</span>{mined.isLoading && <span className="faint">Waiting to be mined…</span>}{mined.isSuccess && <span className="dim">Mined in block {String(mined.data?.blockNumber)}. {mined.data?.status === 'reverted' ? <b className="err-t">The transaction REVERTED.</b> : null}</span>}{mined.isError && <span className="err-t">Could not read the receipt: {mined.error?.shortMessage ?? mined.error?.message}</span>}</div>}
    </li>
  );
}
