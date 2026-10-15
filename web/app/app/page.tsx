'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { useSign } from '@/components/useSign';
import { api, short, Sheet, type Me } from './shared';
import TokensTab from './Tokens';
import RobotTab from './Robot';

type SheetKind = null | 'fund' | 'withdraw' | 'perm';

export default function Dashboard() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const sign = useSign();
  const [tab, setTab] = useState<'tokens' | 'robot'>('tokens');
  const [me, setMe] = useState<Me | null>(null);
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [menu, setMenu] = useState(false);
  const wallet58 = publicKey?.toBase58() || null;

  const say = (kind: 'ok' | 'err', text: string) => setFlash({ kind, text });
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setFlash(null);
    try { await fn(); } catch (e: any) { say('err', e?.message || 'Something went wrong'); } finally { setBusy(null); }
  };

  const refresh = useCallback(async () => {
    try { const m = await api<Me>('/api/me'); setMe(m); setAuth('in'); return m; } catch (e: any) { if (e.status === 401) { setMe(null); setAuth('out'); } return null; }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (auth !== 'in') return; const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [auth, refresh]);
  useEffect(() => { if (!menu) return; const k = () => setMenu(false); window.addEventListener('click', k); return () => window.removeEventListener('click', k); }, [menu]);

  const signedWallet = me?.wallet || null;
  const mismatch = auth === 'in' && connected && wallet58 && signedWallet && wallet58 !== signedWallet;

  const signIn = () => run('signin', async () => {
    if (!wallet58) throw new Error('Connect a wallet first');
    const { message } = await api<{ message: string }>(`/api/auth/nonce?wallet=${wallet58}`);
    const proof = await sign(message);
    await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ wallet: wallet58, message, proof }) });
    await refresh(); setTab('robot');
  });
  const signOut = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setMe(null); setAuth('out'); setMenu(false); };

  /* ───── deposit / withdraw ───── */
  const [fundAmt, setFundAmt] = useState('0.1');
  const [wAmt, setWAmt] = useState('');
  const [wTo, setWTo] = useState('');
  const [wPreview, setWPreview] = useState<{ message: string } | null>(null);
  const fund = () => run('fund', async () => {
    if (!publicKey || !me?.vault) throw new Error('No vault');
    const amount = Number(fundAmt);
    if (!(amount > 0)) throw new Error('Enter an amount in SOL');
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(me.vault.address), lamports: Math.round(amount * 1e9) }));
    const sig = await sendTransaction(tx, connection);
    setSheet(null);
    say('ok', `Sent. It shows in the vault after confirmation (${sig.slice(0, 8)}…).`);
    setTimeout(refresh, 6000); setTimeout(refresh, 15000);
  });
  const reviewWithdraw = () => run('wreview', async () => {
    if (!me) return;
    const amt = wAmt.trim() === '' ? 'ALL' : wAmt.trim();
    const to = wTo.trim() || me.wallet;
    setWPreview(await api<{ message: string }>(`/api/withdraw/challenge?amount=${encodeURIComponent(amt)}&to=${encodeURIComponent(to)}`));
  });
  const signWithdraw = () => run('withdraw', async () => {
    if (!wPreview) return;
    const proof = await sign(wPreview.message);
    await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ message: wPreview.message, proof }) });
    setWPreview(null); setWAmt(''); setWTo(''); setSheet(null); await refresh(); say('ok', 'Withdrawal requested. The worker sends it shortly.');
  });

  const running = !!me && !!me.vault && !!me.consent && !me.settings.paused;
  const hasVault = !!me?.vault;
  const closeSheet = useRef(() => { setSheet(null); setWPreview(null); });

  return (
    <div className="art">
      <div className="wrap">
        <div className="top">
          <a className="brand" href="/"><span className="mark" />ART</a>
          <nav className="navtabs" aria-label="Sections">
            <button className={tab === 'tokens' ? 'on' : ''} onClick={() => setTab('tokens')}>Tokens</button>
            <button className={tab === 'robot' ? 'on' : ''} onClick={() => setTab('robot')}>Robot</button>
          </nav>
          <span className="grow" />
          {auth === 'in' && <button className={`rstat ${running ? 'on' : 'off'}`} onClick={() => setTab('robot')} aria-label={running ? 'Robot is trading' : 'Robot is off'}><i />{running ? 'Trading' : 'Off'}</button>}
          {auth === 'in' && me ? (
            <div className="menuwrap" onClick={(e) => e.stopPropagation()}>
              <button className="chip" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{short(me.wallet)} ▾</button>
              {menu && (
                <div className="menu" role="menu">
                  <button role="menuitem" disabled={!hasVault} onClick={() => { setSheet('fund'); setMenu(false); }}>＋ Deposit</button>
                  <button role="menuitem" disabled={!hasVault} onClick={() => { setSheet('withdraw'); setMenu(false); }}>↗ Withdraw</button>
                  <button role="menuitem" onClick={() => { setSheet('perm'); setMenu(false); }}>ⓘ Permissions</button>
                  <hr />
                  <button role="menuitem" onClick={signOut}>Sign out</button>
                </div>
              )}
            </div>
          ) : <WalletMultiButton />}
        </div>

        {flash && <div className={`note ${flash.kind === 'err' ? 'err' : 'ok'}`} role="status">{flash.text}</div>}
        {mismatch && (
          <div className="note err">You are signed in as <span className="mono">{short(signedWallet!)}</span> but your wallet switched to <span className="mono">{short(wallet58!)}</span>.{' '}
            <button className="btn btn-ghost sm" onClick={signOut}>Sign out and switch</button></div>
        )}

        {tab === 'tokens' && <TokensTab />}

        {tab === 'robot' && (
          <>
            {auth === 'checking' && <div className="hero"><span className="eyebrow">Loading…</span></div>}
            {auth === 'out' && (
              <div className="hero">
                <span className="eyebrow">African Robot Trader · Solana</span>
                <h1>Your robot,<br />your limits.</h1>
                {!connected ? <button className="btn btn-gold" aria-label="Connect wallet" onClick={() => setVisible(true)}>Connect wallet</button>
                  : <button className="btn btn-gold" aria-label="Sign in" disabled={!!busy} onClick={signIn}>{busy === 'signin' ? 'Check your wallet…' : `Sign in ${wallet58 ? short(wallet58) : ''}`}</button>}
                <p style={{ marginTop: 14 }}>
                  {!connected ? 'Connect any Solana wallet. Connecting only shares your public address.'
                    : <>Sign one message to prove this wallet is yours. <b>It does not move funds and gives ART no permission to spend anything.</b></>}
                </p>
                <details><summary>Which wallets work?</summary>
                  <p style={{ marginTop: 10 }}>Anything that follows the Solana Wallet Standard is detected automatically: Phantom, Solflare, Backpack, Coinbase, Trust, Ledger and more. On Android, wallet apps connect through Mobile Wallet Adapter. On iPhone, open this page inside your wallet app&apos;s browser. Wallets that only support other chains (EVM-only) cannot sign for Solana.</p>
                </details>
              </div>
            )}
            {auth === 'in' && me && !mismatch && <RobotTab me={me} refresh={refresh} run={run} busy={busy} say={say} sign={sign} openSheet={(k) => setSheet(k)} />}
          </>
        )}

        <footer>Trading digital assets carries a high risk of loss. ART does not promise profit. The vault is a wallet that ART&apos;s trading service controls so it can trade while you are away; it is not a bank account and is not insured. Only fund what you can afford to lose. Token listings are live market data, not recommendations.</footer>
      </div>

      {sheet === 'fund' && me?.vault && (
        <Sheet title="Deposit to your vault" onClose={closeSheet.current}>
          <p>Your wallet asks you to approve one transfer to your vault. After that, the robot trades with the vault balance and never asks you to approve a trade. You can also copy the vault address and send from any exchange. Leave a little for network fees. You can take it all back whenever you like.</p>
          <div className="addr"><span style={{ flex: 1 }}>{me.vault.address}</span><button className="btn btn-ghost sm" onClick={() => navigator.clipboard?.writeText(me.vault!.address)}>Copy</button></div>
          <span className="lbl">Amount in SOL</span>
          <div className="row">
            <input className="field" style={{ maxWidth: 180 }} inputMode="decimal" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} aria-label="Amount in SOL" />
            <button className="btn btn-gold" disabled={!!busy} onClick={fund}>{busy === 'fund' ? 'Check your wallet…' : 'Deposit from my wallet'}</button>
          </div>
        </Sheet>
      )}

      {sheet === 'withdraw' && me && (
        <Sheet title="Withdraw" onClose={closeSheet.current}>
          <p>Send funds from your vault to your connected wallet (<span className="mono">{short(me.wallet)}</span>) or to any Solana address you paste. You sign the exact destination, so nothing can change it afterwards. If you have open live trades, press “Stop and sell all” first.</p>
          {!wPreview ? (
            <>
              <span className="lbl">Send to</span>
              <input className="field" placeholder={`My wallet (${short(me.wallet)}) or paste another Solana address`} value={wTo} onChange={(e) => setWTo(e.target.value)} aria-label="Destination address" />
              {wTo.trim() !== '' && wTo.trim() !== me.wallet && <p className="hint warn">Check every character. Transfers on Solana cannot be reversed.</p>}
              <span className="lbl" style={{ marginTop: 10 }}>Amount</span>
              <div className="row"><input className="field" style={{ maxWidth: 220 }} placeholder="Amount in SOL, blank = all" inputMode="decimal" value={wAmt} onChange={(e) => setWAmt(e.target.value)} />
                <button className="btn btn-ghost" disabled={!!busy} onClick={reviewWithdraw}>Review withdrawal</button></div>
            </>
          ) : (
            <>
              <span className="lbl">Your wallet will ask you to sign this</span>
              <div className="msg">{wPreview.message}</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-gold" disabled={!!busy} onClick={signWithdraw}>{busy === 'withdraw' ? 'Waiting for your wallet…' : 'Sign and withdraw'}</button>
                <button className="btn btn-ghost" onClick={() => setWPreview(null)}>Cancel</button>
              </div>
            </>
          )}
          {me.withdrawals.slice(0, 6).map((w) => (
            <div className="feed" key={w.id}>
              <div><b>{w.amount_lamports ? `${(Number(w.amount_lamports) / 1e9).toFixed(4)} SOL` : 'All'}</b><span>{new Date(w.created_at).toLocaleString()}{w.error ? ` · ${w.error}` : ''}{w.tx_sig ? <> · <a href={`https://solscan.io/tx/${w.tx_sig}`} target="_blank" rel="noreferrer">view</a></> : null}</span></div>
              <strong className={w.status === 'done' ? 'up' : w.status === 'failed' || w.status === 'rejected' ? 'dn' : ''}>{w.status}</strong>
            </div>
          ))}
        </Sheet>
      )}

      {sheet === 'perm' && (
        <Sheet title="What you sign, and what it can do" onClose={closeSheet.current}>
          <div className="perm"><i>1</i><div><b>Connect</b><span>Shares your public address. Cannot move funds.</span></div></div>
          <div className="perm"><i>2</i><div><b>Sign in</b><span>A message that proves you own the wallet. Moves nothing, grants nothing.</span></div></div>
          <div className="perm"><i>3</i><div><b>Sign your limits</b><span>A message that sets the most the robot may risk. It lets ART&apos;s service trade <u>from your vault only</u>, never from your own wallet.</span></div></div>
          <div className="perm"><i>4</i><div><b>Fund the vault</b><span>A normal transfer you approve in your wallet. The only time your own wallet sends SOL.</span></div></div>
          <div className="perm"><i>5</i><div><b>Withdraw</b><span>A message you sign. The vault then sends funds to the address you signed (your wallet or one you paste), and nowhere else.</span></div></div>
          <p style={{ marginTop: 12 }}>Solana has no “unlimited spending approval” on your main wallet, and ART never asks for one. To end ART&apos;s access completely: Stop and sell all, withdraw everything, sign out.</p>
        </Sheet>
      )}
    </div>
  );
}
