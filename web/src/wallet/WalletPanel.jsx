// EVM signing step. Lazy-loaded from Approval.jsx so wagmi + viem stay OUT of the initial bundle.
// Human signing is a real wallet action: this component only builds the transaction for the wallet to confirm.
// Nothing here signs, simulates a signature, or holds a key.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useConnect, useConnection, useConnectors, useDeployContract, useDisconnect, usePublicClient, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi';
import { encodeDeployData, formatGwei } from 'viem';
import { api } from '../api.js';
import { Chip, ErrorPanel, Icon, Skeleton } from '../ui.jsx';
import { walletConfig, chainById, chainIdOf } from './config.js';
import { buildConstructorArgs, sha256Hex } from './ctor.js';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '–');

// wagmi's <Hydrate> runs onMount() on EVERY render when ssr is off; with reconnectOnMount=false that wipes live connections.
// So the provider tree is created once (stable element identity) and live props reach Inner through context instead.
const PropsCtx = createContext(null);
export default function WalletPanel(props) {
  const tree = useMemo(() => (
    <WagmiProvider config={walletConfig()} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}><Inner /></QueryClientProvider>
    </WagmiProvider>
  ), []);
  return <PropsCtx.Provider value={props}>{tree}</PropsCtx.Provider>;
}

function Inner() {
  const { decision, token, onHash, receiptBusy } = useContext(PropsCtx);
  const targetId = chainIdOf(decision.chain_id);
  const target = chainById(targetId);
  const conn = useConnection();
  const connectors = useConnectors();
  const { connect, isPending: connecting, error: connectErr, variables: connVars } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchErr } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: targetId ?? undefined });

  // ---- deploy data (operator-only, only released for an approved decision) ----
  const [dd, setDd] = useState({ loading: false, data: null, error: null });
  useEffect(() => {
    if (!token || decision.effectiveStatus !== 'approved') return undefined;
    let live = true;
    setDd({ loading: true, data: null, error: null });
    api(`/api/decisions/${decision.id}/deploy-data`).then((data) => live && setDd({ loading: false, data, error: null })).catch((error) => live && setDd({ loading: false, data: null, error }));
    return () => { live = false; };
  }, [decision.id, decision.effectiveStatus, token]);

  const ctor = useMemo(() => (dd.data ? buildConstructorArgs(dd.data.abi, dd.data.registry) : null), [dd.data]);
  const [bytecodeSha, setBytecodeSha] = useState('');
  useEffect(() => { if (dd.data?.bytecode) sha256Hex(dd.data.bytecode).then(setBytecodeSha).catch(() => setBytecodeSha('')); }, [dd.data]);

  const onTarget = conn.isConnected && conn.chainId === targetId;
  // The approval bound ONE signer address; the server will reject a deployment from anyone else.
  const bound = decision.bound_signer ?? '';
  const signerOk = Boolean(conn.address) && conn.address.toLowerCase() === bound.toLowerCase();
  const data = useMemo(() => {
    if (!dd.data?.bytecode || !ctor?.ok) return null;
    try { return encodeDeployData({ abi: dd.data.abi, bytecode: dd.data.bytecode, args: ctor.args }); } catch { return null; }
  }, [dd.data, ctor]);

  // ---- gas estimate: a real eth_estimateGas against the target chain RPC from the connected account ----
  const [gas, setGas] = useState({ state: 'idle' });
  useEffect(() => {
    if (!data || !onTarget || !publicClient || !conn.address) { setGas({ state: 'idle' }); return undefined; }
    let live = true; setGas({ state: 'loading' });
    (async () => {
      try {
        const [units, price] = await Promise.all([publicClient.estimateGas({ account: conn.address, data }), publicClient.getGasPrice().catch(() => null)]);
        if (live) setGas({ state: 'ok', units, price });
      } catch (e) { if (live) setGas({ state: 'error', message: e.shortMessage ?? e.message }); }
    })();
    return () => { live = false; };
  }, [data, onTarget, publicClient, conn.address]);

  // ---- send ----
  const { deployContract, isPending: signing, error: signErr, data: hash, reset } = useDeployContract();
  const mined = useWaitForTransactionReceipt({ hash, chainId: targetId ?? undefined });
  const [forwarded, setForwarded] = useState('');
  useEffect(() => { if (hash && mined.isSuccess && forwarded !== hash) { setForwarded(hash); onHash(hash); } }, [hash, mined.isSuccess, forwarded, onHash]);

  const sign = () => deployContract({ abi: dd.data.abi, bytecode: dd.data.bytecode, args: ctor.args, chainId: targetId });

  if (!target) return <div className="banner risk" role="alert"><Icon name="alert" /><div>The wallet layer has no configured chain for <span className="mono-v">{decision.chain_id}</span>. Use the tx-hash field below to record a deployment you signed elsewhere.</div></div>;

  const cannotWhy = !conn.isConnected ? 'Connect a wallet first.' : !signerOk ? `This decision is bound to ${short(bound)}. Switch the wallet account to that address.` : !onTarget ? `Switch the wallet to ${target.name} (${target.id}).` : !dd.data ? 'Deploy data not loaded.' : !ctor?.ok ? 'Constructor arguments could not be derived.' : null;

  return (
    <div className="stack">
      <div className="wp-head">
        <div>
          <div className="eyebrow">Target chain</div>
          <div className="wp-chain"><b>{target.name}</b> <span className="mono-v faint">chain id {target.id}</span></div>
        </div>
        <Chip tone="mineral" title="No mainnet chain is configured in this console">testnet / local only</Chip>
      </div>

      {/* 1. connect */}
      <section aria-labelledby="wp-c" className="wp-step">
        <h3 id="wp-c" className="wp-h"><span className="wp-n">1</span> Connect your wallet</h3>
        {conn.isConnected ? (
          <div className="stack-s">
            <dl className="kv">
              <dt>Account</dt><dd className="mono-v" data-testid="wp-address">{conn.address}</dd>
              <dt>Wallet</dt><dd>{conn.connector?.name ?? 'injected'}</dd>
              <dt>Bound signer</dt><dd className="mono-v">{bound || '–'} {signerOk ? <Chip tone="ok">connected account matches</Chip> : <Chip tone="bad">connected account differs</Chip>}</dd>
              <dt>Wallet chain</dt><dd className="mono-v">{conn.chainId}{onTarget ? <> <Chip tone="ok">matches</Chip></> : <> <Chip tone="warn">wrong chain</Chip></>}</dd>
            </dl>
            <div className="row">
              {!onTarget && <button className="btn primary" disabled={switching} onClick={() => switchChain({ chainId: targetId })}>{switching ? 'Waiting for wallet…' : `Switch to ${target.name}`}</button>}
              <button className="btn" onClick={() => { reset(); disconnect(); }}>Disconnect</button>
            </div>
            {switchErr && <p className="err-t" role="alert">{switchErr.shortMessage ?? switchErr.message}</p>}
          </div>
        ) : (
          <div className="stack-s">
            {connectors.length ? (
              <div className="wp-wallets" role="group" aria-label="Detected wallets">
                {connectors.map((c) => (
                  <button key={c.uid} className="btn wp-wallet" disabled={connecting} onClick={() => connect({ connector: c })}>
                    {c.icon ? <img src={c.icon} alt="" width="20" height="20" /> : <Icon name="wallet" size={18} />}
                    <span>{c.id === 'injected' ? 'Browser wallet' : c.name}</span>
                    {connecting && connVars?.connector?.uid === c.uid && <span className="faint">connecting…</span>}
                  </button>
                ))}
              </div>
            ) : <p className="dim">No browser wallet detected (EIP-6963 discovery found none). Install or unlock a wallet extension, or sign with Foundry and paste the transaction hash below.</p>}
            {connectErr && <p className="err-t" role="alert">{connectErr.shortMessage ?? connectErr.message}</p>}
          </div>
        )}
      </section>

      {/* 2. deploy data + preview */}
      <section aria-labelledby="wp-p" className="wp-step">
        <h3 id="wp-p" className="wp-h"><span className="wp-n">2</span> Review the exact transaction</h3>
        {dd.loading && <Skeleton h={120} />}
        {dd.error && <ErrorPanel error={dd.error} what="deploy data" />}
        {dd.data && ctor && (
          <div className="stack-s">
            <dl className="kv">
              <dt>Action</dt><dd>Contract creation (no <span className="mono-v">to</span> address), value 0</dd>
              <dt>Chain</dt><dd className="mono-v">{target.name} · {target.id}</dd>
              <dt>Attested artifact</dt><dd className="mono-v">{dd.data.artifactHash}</dd>
              <dt>Creation bytecode</dt><dd className="mono-v">{dd.data.bytecode ? `${(dd.data.bytecode.length - 2) / 2} bytes · sha256 ${bytecodeSha || 'computing…'}` : 'not provided by the API'}</dd>
              <dt>Expected runtime sha256</dt><dd className="mono-v">{dd.data.expectedDeployedBytecodeSha256 ?? '–'}</dd>
            </dl>
            <div className="eyebrow">Constructor arguments</div>
            {ctor.rows.length > 0 && (
              <div className="scroll-x"><table className="tbl"><thead><tr><th>Input</th><th>Type</th><th>From</th><th>Value</th></tr></thead>
                <tbody>{ctor.rows.map((r) => <tr key={r.name}><td className="mono-v">{r.name}</td><td className="mono-v">{r.type}</td><td className="mono-v faint">{r.source}</td><td className="mono-v" style={{ overflowWrap: 'anywhere' }}>{r.value}</td></tr>)}</tbody></table></div>
            )}
            {ctor.errors.map((e) => <p key={e} className="err-t" role="alert">{e}</p>)}
            <div className="row" aria-live="polite">
              <span className="eyebrow">Estimated gas</span>
              {gas.state === 'ok' && <span className="mono-v" data-testid="gas">{gas.units.toString()} units{gas.price ? ` · ~${formatGwei(gas.price)} gwei` : ''} · eth_estimateGas on {target.name}</span>}
              {gas.state === 'loading' && <span className="faint">estimating…</span>}
              {gas.state === 'error' && <span className="err-t">estimate failed: {gas.message}</span>}
              {gas.state === 'idle' && <span className="faint">connect on {target.name} to estimate</span>}
            </div>
          </div>
        )}
        {!dd.loading && !dd.data && !dd.error && <p className="dim">{token ? 'Deploy data is released only for an approved decision.' : 'Deploy data needs the operator token.'}</p>}
      </section>

      {/* 3. sign */}
      <section aria-labelledby="wp-s" className="wp-step">
        <h3 id="wp-s" className="wp-h"><span className="wp-n">3</span> Sign in your wallet</h3>
        <p className="dim" style={{ margin: 0 }}>Your wallet will show the final prompt. AutoNEAR never sees a key and cannot sign for you.</p>
        <div className="row">
          <button className="btn primary" onClick={sign} disabled={Boolean(cannotWhy) || signing || Boolean(hash)} aria-describedby={cannotWhy ? 'wp-why' : undefined}>
            <Icon name="wallet" size={16} />{signing ? 'Confirm in your wallet…' : 'Deploy from my wallet'}
          </button>
          {cannotWhy && <span id="wp-why" className="help">{cannotWhy}</span>}
        </div>
        {signErr && <p className="err-t" role="alert">{signErr.shortMessage ?? signErr.message}</p>}
        {hash && (
          <div className="stack-s" aria-live="polite">
            <dl className="kv"><dt>Tx hash</dt><dd className="mono-v" data-testid="wp-hash">{hash}</dd></dl>
            {mined.isLoading && <p className="faint">Waiting for the transaction to be mined…</p>}
            {mined.isError && <p className="err-t" role="alert">Could not read the receipt from the chain RPC: {mined.error?.shortMessage ?? mined.error?.message}. You can still verify by pasting the hash below.</p>}
            {mined.isSuccess && <p className="dim">{receiptBusy ? 'Mined. Asking the API to verify it on-chain…' : 'Mined. Sent to the API for verification (see result below).'}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
