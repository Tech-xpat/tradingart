import { randomBytes } from 'crypto';
import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One-time code to link a Telegram chat to this wallet account: send "/link CODE" to the bot. */
export const POST = authed({ write: true, limit: [6, 60_000] }, async ({ session }) => {
  const sb = db();
  await sb.from('art_link_codes').delete().eq('user_id', session.userId);
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  must(await sb.from('art_link_codes').insert({ code, user_id: session.userId, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), 'code');
  return json({ code, bot: process.env.NEXT_PUBLIC_TG_BOT || null, expiresInMin: 10 });
});

export const DELETE = authed({ write: true }, async ({ session }) => {
  must(await db().from('art_users').update({ tg_chat_id: null, tg_username: null }).eq('id', session.userId), 'unlink');
  return json({ ok: true });
});
