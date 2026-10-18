/**
 * Per-coin warning icons, built only from public chain data and the coin's own text. Each check is one of
 * ok (looks fine) / warn / bad / unknown (could not be checked). None of this proves a coin is safe: it only
 * surfaces the common warning signs so they are visible at a glance.
 */
export type Level = 'ok' | 'warn' | 'bad' | 'unknown';
export type Flag = { key: 'mint' | 'freeze' | 'holders' | 'dev' | 'phish'; icon: string; label: string; level: Level; text: string };
export type SafetyInput = {
  mintAuthority: string | null | undefined; freezeAuthority: string | null | undefined; known: boolean;
  top1Pct: number | null; top10Pct: number | null;
  devKnown: boolean; devPct: number | null;
  text: string;
};

const PHISH = /(airdrop|claim (your|now|free)|connect (your )?wallet|giveaway|double your|seed ?phrase|private ?key|verify (your )?wallet|free (sol|tokens?|mint)|whitelist now|send .{0,12}sol)/i;
const BAD_LINK = /(bit\.ly|t\.co\/|tinyurl|\.(xyz|top|click|gq|tk|ml|cf)\/|https?:\/\/[^\s]*(claim|airdrop|verify)[^\s]*)/i;

export function assess(i: SafetyInput): Flag[] {
  const out: Flag[] = [];
  out.push(!i.known ? { key: 'mint', icon: '🔒', label: 'Mint', level: 'unknown', text: 'Could not read the token settings.' }
    : i.mintAuthority ? { key: 'mint', icon: '🔒', label: 'Mint', level: 'bad', text: 'Someone can still create more of this token (mint authority is active).' }
    : { key: 'mint', icon: '🔒', label: 'Mint', level: 'ok', text: 'Nobody can create more of this token.' });
  out.push(!i.known ? { key: 'freeze', icon: '❄️', label: 'Freeze', level: 'unknown', text: 'Could not read the token settings.' }
    : i.freezeAuthority ? { key: 'freeze', icon: '❄️', label: 'Freeze', level: 'bad', text: 'Someone can freeze holders (freeze authority is active).' }
    : { key: 'freeze', icon: '❄️', label: 'Freeze', level: 'ok', text: 'Nobody can freeze your tokens.' });
  if (i.top10Pct == null) out.push({ key: 'holders', icon: '🐋', label: 'Holders', level: 'unknown', text: 'Could not read the biggest holders.' });
  else {
    const lv: Level = i.top1Pct! >= 25 || i.top10Pct >= 60 ? 'bad' : i.top1Pct! >= 12 || i.top10Pct >= 40 ? 'warn' : 'ok';
    out.push({ key: 'holders', icon: '🐋', label: 'Holders', level: lv, text: `Biggest wallet holds ${i.top1Pct!.toFixed(1)}%, top 10 hold ${i.top10Pct.toFixed(1)}% (pools and the pump.fun curve are not counted).` });
  }
  if (!i.devKnown) out.push({ key: 'dev', icon: '👤', label: 'Dev', level: 'unknown', text: 'We did not see this coin launch, so the developer wallet is unknown.' });
  else if (i.devPct == null) out.push({ key: 'dev', icon: '👤', label: 'Dev', level: 'unknown', text: 'Could not read the developer wallet balance.' });
  else out.push({ key: 'dev', icon: '👤', label: 'Dev', level: i.devPct >= 15 ? 'bad' : i.devPct >= 6 ? 'warn' : 'ok', text: i.devPct <= 0.01 ? 'The developer holds none of the token now (sold or moved it).' : `The developer wallet still holds ${i.devPct.toFixed(1)}% of the supply.` });
  const t = i.text || '';
  const bad = PHISH.test(t) || BAD_LINK.test(t);
  out.push({ key: 'phish', icon: '🎣', label: 'Phishing', level: t ? (bad ? 'bad' : 'ok') : 'unknown', text: !t ? 'No description to check.' : bad ? 'The description contains wording or links typical of wallet-drain scams. Do not connect your wallet to anything it links to.' : 'No scam wording or suspicious links in the description.' });
  return out;
}

/**
 * pump.fun's bonding-curve account stores the creator's wallet. Layout: 8-byte discriminator, five u64 numbers (40 bytes),
 * one bool, then the 32-byte creator. Returns base58 or null when the account is too short or the key is all zeros.
 */
export function parseCreator(data: Uint8Array | null | undefined, toBase58: (b: Uint8Array) => string): string | null {
  if (!data || data.length < 81) return null;
  const k = data.slice(49, 81);
  if (k.every((x) => x === 0)) return null;
  return toBase58(k);
}
export type DevInfo = { address: string; pct: number | null; sol: number | null; source: 'launch' | 'chain' };
