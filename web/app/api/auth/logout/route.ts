import { NextRequest } from 'next/server';
import { json, fail, sameOrigin } from '@/lib/api';
import { COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return fail('bad origin', 403);
  const res = json({ ok: true });
  res.cookies.set(COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
