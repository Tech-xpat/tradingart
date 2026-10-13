import { NextRequest, NextResponse } from 'next/server';
import { env } from './env';
import { readSession, Session } from './session';

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export const fail = (message: string, status = 400) => json({ error: message }, status);

/** Best-effort in-memory limiter (per server instance). Put a shared limiter (Upstash, Vercel WAF) in front for production. */
const hits = new Map<string, number[]>();
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > max;
}
export const ipOf = (req: NextRequest) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'ip';

/** The host the browser actually used to reach us (behind Vercel/Railway proxies too). */
export function hostOf(req: NextRequest): string {
  const h = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host || '';
  return h.split(',')[0].trim().toLowerCase();
}

/** Domain used in the sign-in text: the host the user is really on. */
export function siteDomain(req: NextRequest): string {
  return hostOf(req) || env.domain;
}

/** CSRF: state-changing requests must come from our own origin (the host we were reached on, or the configured domain). */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return !env.isProd; // browsers always send Origin on cross-site POSTs; allow tools in dev
  try {
    const host = new URL(origin).host.toLowerCase();
    return host === hostOf(req) || host === env.domain;
  } catch { return false; }
}

type Ctx = { req: NextRequest; session: Session };
/** Wrap a route: origin check, rate limit, session required, errors become JSON. */
export function authed(opts: { limit?: [number, number]; write?: boolean }, fn: (c: Ctx) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      if (opts.write && !sameOrigin(req)) return fail('bad origin', 403);
      const session = await readSession();
      if (!session) return fail('not signed in', 401);
      const [max, win] = opts.limit || [60, 60_000];
      if (rateLimited(`${req.nextUrl.pathname}:${session.userId}`, max, win)) return fail('slow down', 429);
      return await fn({ req, session });
    } catch (e: any) {
      console.error(req.nextUrl.pathname, e?.message || e);
      return fail('server error', 500);
    }
  };
}
