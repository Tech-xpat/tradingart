/** All database access for the worker, via the service-role key. Small and explicit so it can be faked in tests. */
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

function connect() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

function createDb(sb) {
  const ok = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };
  const byId = (rows, k = 'user_id') => new Map((rows || []).map((r) => [r[k], r]));
  return {
    async settingsRunning() { return ok(await sb.from('art_settings').select('*').eq('paused', false), 'settings'); },
    async settingsFor(ids) { return ids.length ? ok(await sb.from('art_settings').select('*').in('user_id', ids), 'settingsFor') : []; },
    async users(ids) { return ids.length ? byId(ok(await sb.from('art_users').select('*').in('id', ids), 'users'), 'id') : new Map(); },
    async vaults(ids) { return ids.length ? byId(ok(await sb.from('art_vaults').select('*').in('user_id', ids), 'vaults')) : new Map(); },
    async consents(ids) {
      if (!ids.length) return new Map();
      const rows = ok(await sb.from('art_consents').select('user_id,limits,created_at,revoked_at').in('user_id', ids).is('revoked_at', null).order('created_at', { ascending: false }), 'consents');
      const m = new Map();
      for (const r of rows || []) if (!m.has(r.user_id)) m.set(r.user_id, r.limits);
      return m;
    },
    async usersWithOpenPositions({ liveOnly = false } = {}) {
      const rows = ok(await sb.from('art_state').select('user_id,key,value').in('key', liveOnly ? ['live:positions'] : ['paper:positions', 'live:positions']), 'openPositions');
      return [...new Set((rows || []).filter((r) => Array.isArray(r.value) && r.value.length).map((r) => r.user_id))];
    },
    async getState(userId, key) {
      const rows = ok(await sb.from('art_state').select('value').eq('user_id', userId).eq('key', key).limit(1), 'getState');
      return rows && rows.length ? rows[0].value : null;
    },
    async setState(userId, key, value) {
      ok(await sb.from('art_state').upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }), 'setState');
    },
    async insertTrade(row) { ok(await sb.from('art_trades').insert(row), 'insertTrade'); },
    async updateSettings(userId, patch) { ok(await sb.from('art_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId), 'updateSettings'); },
    async userByChat(chatId) { const r = ok(await sb.from('art_users').select('*').eq('tg_chat_id', chatId).limit(1), 'userByChat'); return r && r[0] || null; },
    async linkChat(code, chatId, username) {
      const rows = ok(await sb.from('art_link_codes').select('*').eq('code', code).limit(1), 'linkCode');
      const row = rows && rows[0];
      if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
      ok(await sb.from('art_users').update({ tg_chat_id: chatId, tg_username: username || null }).eq('id', row.user_id), 'linkChat');
      ok(await sb.from('art_link_codes').delete().eq('code', code), 'linkCodeDelete');
      return row.user_id;
    },
    async unlinkChat(userId) { ok(await sb.from('art_users').update({ tg_chat_id: null, tg_username: null }).eq('id', userId), 'unlinkChat'); },
    async pendingWithdrawals() { return ok(await sb.from('art_withdrawals').select('*').eq('status', 'pending').order('created_at').limit(20), 'pendingWithdrawals'); },
    /** Atomically claim a pending withdrawal; false if someone else already did. */
    async claimWithdrawal(id) {
      const rows = ok(await sb.from('art_withdrawals').update({ status: 'processing' }).eq('id', id).eq('status', 'pending').select('id'), 'claimWithdrawal');
      return !!(rows && rows.length);
    },
    async finishWithdrawal(id, patch) { ok(await sb.from('art_withdrawals').update({ ...patch, processed_at: new Date().toISOString() }).eq('id', id), 'finishWithdrawal'); },
    async stuckWithdrawals() { return ok(await sb.from('art_withdrawals').select('id').eq('status', 'processing'), 'stuck'); },
    async adminStats() {
      const c = async (t, f) => { let q = sb.from(t).select('*', { count: 'exact', head: true }); if (f) q = f(q); const { count, error } = await q; if (error) throw new Error(error.message); return count || 0; };
      return { users: await c('art_users'), running: await c('art_settings', (q) => q.eq('paused', false)), live: await c('art_settings', (q) => q.eq('live', true).eq('paused', false)), trades: await c('art_trades') };
    },
  };
}

module.exports = { connect, createDb };
