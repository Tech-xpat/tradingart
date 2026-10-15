import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';
import { env, LIMITS } from '@/lib/env';
import { solBalance } from '@/lib/chain';
import { solUsd } from '@/lib/price';
import { defaultPlans } from '@/lib/planrules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authed({ limit: [90, 60_000] }, async ({ session }) => {
  const sb = db();
  const [user, vault, settings, consent, withdrawals] = await Promise.all([
    sb.from('art_users').select('id,wallet,tg_chat_id,tg_username,created_at').eq('id', session.userId).single(),
    sb.from('art_vaults').select('address,created_at').eq('user_id', session.userId).maybeSingle(),
    sb.from('art_settings').select('*').eq('user_id', session.userId).single(),
    sb.from('art_consents').select('id,version,limits,created_at').eq('user_id', session.userId).is('revoked_at', null).order('created_at', { ascending: false }).limit(1),
    sb.from('art_withdrawals').select('id,amount_lamports,status,tx_sig,error,created_at').eq('user_id', session.userId).order('created_at', { ascending: false }).limit(5),
  ]);
  const v = must(vault, 'vault');
  let settingsRow: any = must(settings, 'settings');
  // first visit (or an account from before plans existed): give the user the two starter plans
  if (!Array.isArray(settingsRow.plans) || settingsRow.plans.length === 0) {
    const plans = defaultPlans();
    await sb.from('art_settings').update({ plans, active_plan: plans[0].id, updated_at: new Date().toISOString() }).eq('user_id', session.userId);
    settingsRow = { ...settingsRow, plans, active_plan: plans[0].id };
  }
  return json({
    wallet: session.wallet,
    telegramLinked: !!must(user, 'user').tg_chat_id,
    vault: v ? { address: v.address, balanceSol: await solBalance(v.address) } : null,
    settings: settingsRow,
    consent: must(consent, 'consent')[0] || null,
    withdrawals: must(withdrawals, 'withdrawals'),
    liveEnabled: env.liveEnabled,
    solUsd: await solUsd(),
    limits: LIMITS,
  });
});
