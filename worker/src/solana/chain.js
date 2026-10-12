/** Chain reads for ANY owner address (the old bot read a single global wallet). */
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { rpc } = require('./rpc');

const pk = (a) => (typeof a === 'string' ? new PublicKey(a) : a);

async function getSolLamports(owner) {
  return BigInt(await rpc((c) => c.getBalance(pk(owner), 'confirmed')));
}
async function getSolBalance(owner) {
  return Number(await getSolLamports(owner)) / LAMPORTS_PER_SOL;
}
async function getTokenBalance(owner, mint) {
  const res = await rpc((c) => c.getParsedTokenAccountsByOwner(pk(owner), { mint: new PublicKey(mint) }, 'confirmed'));
  let raw = 0n, decimals = null;
  for (const a of res.value) { const ta = a.account.data.parsed.info.tokenAmount; raw += BigInt(ta.amount); decimals = ta.decimals; }
  return { raw, decimals, ui: decimals == null ? 0 : Number(raw) / 10 ** decimals };
}
async function getMintInfo(mint) {
  const info = await rpc((c) => c.getParsedAccountInfo(new PublicKey(mint), 'confirmed'));
  const parsed = info && info.value && info.value.data && info.value.data.parsed;
  if (!parsed || parsed.type !== 'mint') throw new Error('not a token mint');
  return { mintAuthority: parsed.info.mintAuthority || null, freezeAuthority: parsed.info.freezeAuthority || null, decimals: parsed.info.decimals };
}

module.exports = { getSolLamports, getSolBalance, getTokenBalance, getMintInfo, LAMPORTS_PER_SOL };
