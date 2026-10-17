/**
 * Token art and metadata live on IPFS (or a pinning service). Single gateways are slow or rate-limited, so we
 * try several. Everything here runs on the server (no browser CORS limits) and only touches known hosts.
 */
export const IMAGE_HOSTS = [
  /(^|\.)ipfs\.io$/, /(^|\.)cf-ipfs\.com$/, /(^|\.)cloudflare-ipfs\.com$/, /(^|\.)dweb\.link$/, /(^|\.)w3s\.link$/, /(^|\.)nftstorage\.link$/,
  /(^|\.)pinata\.cloud$/, /(^|\.)mypinata\.cloud$/, /(^|\.)dexscreener\.com$/, /(^|\.)pump\.fun$/, /(^|\.)arweave\.net$/, /(^|\.)irys\.xyz$/,
  /(^|\.)ipfs\.sphere\.so$/, /(^|\.)nftstorage\.link$/, /(^|\.)filebase\.io$/, /(^|\.)4everland\.io$/, /(^|\.)gateway\.irys\.xyz$/, /(^|\.)ipfs\.dweb\.link$/,
];
export const hostAllowed = (h: string) => IMAGE_HOSTS.some((r) => r.test(h));

const GATEWAYS = ['https://ipfs.io', 'https://cf-ipfs.com', 'https://dweb.link', 'https://w3s.link', 'https://nftstorage.link', 'https://gateway.pinata.cloud'];

/** "/ipfs/<cid>/<path>" for ipfs:// links, gateway URLs and subdomain-style gateways; otherwise null. */
export function ipfsPath(raw: string): string | null {
  if (raw.startsWith('ipfs://')) return '/ipfs/' + raw.slice(7).replace(/^ipfs\//, '');
  let u: URL; try { u = new URL(raw); } catch { return null; }
  const m = u.pathname.match(/^\/ipfs\/(.+)$/);
  if (m) return `/ipfs/${m[1]}`;
  const sub = u.hostname.match(/^([a-z0-9]{46,}|baf[a-z0-9]{40,})\.ipfs\./i); // <cid>.ipfs.dweb.link
  if (sub) return `/ipfs/${sub[1]}${u.pathname === '/' ? '' : u.pathname}`;
  return null;
}

/** Candidate URLs to try, best first: the original link (if on a known host), then public gateways. */
export function candidates(raw: string): string[] {
  const out: string[] = [];
  const path = ipfsPath(raw);
  if (/^https:\/\//.test(raw)) { try { if (hostAllowed(new URL(raw).hostname)) out.push(raw); } catch { /* skip */ } }
  if (path) for (const g of GATEWAYS) { const u = g + path; if (!out.includes(u)) out.push(u); }
  return out;
}

/** One candidate: follows redirects by hand, only to allowed hosts. Resolves null on any failure. */
async function tryOne(start: string, opts: { accept: string; maxBytes: number }, signal: AbortSignal): Promise<{ buf: Buffer; type: string } | null> {
  let url = start;
  try {
    for (let hop = 0; hop < 4; hop++) {
      if (!hostAllowed(new URL(url).hostname)) return null;
      const r = await fetch(url, { signal, redirect: 'manual', headers: { accept: opts.accept } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location')!, url).toString(); continue; }
      if (!r.ok) return null;
      if (Number(r.headers.get('content-length') || 0) > opts.maxBytes) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > opts.maxBytes ? null : { buf, type: r.headers.get('content-type') || '' };
    }
  } catch { /* aborted or unreachable */ }
  return null;
}

/**
 * Ask several gateways AT THE SAME TIME and take the first that answers, within one overall deadline (default 7 s,
 * under Vercel's 10 s function limit). The slow ones are cancelled.
 */
export async function fetchFirst(raw: string, opts: { accept: string; maxBytes: number; totalMs?: number; maxTries?: number }): Promise<{ buf: Buffer; type: string } | null> {
  const tries = candidates(raw).slice(0, opts.maxTries ?? 7);
  if (!tries.length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.totalMs ?? 7000);
  try {
    return await new Promise((resolve) => {
      let left = tries.length;
      for (const u of tries) {
        tryOne(u, opts, ctl.signal).then((got) => { if (got) resolve(got); else if (--left === 0) resolve(null); });
      }
    });
  } finally { clearTimeout(timer); ctl.abort(); }
}
