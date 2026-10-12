import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Kill switch: pause, and tell the worker to close every open trade. */
export const POST = authed({ write: true, limit: [10, 60_000] }, async ({ session }) => {
  must(await db().from('art_settings').update({ paused: true, panic_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('user_id', session.userId), 'panic');
  return json({ ok: true });
});
