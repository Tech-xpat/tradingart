/**
 * A tiny in-memory stand-in for Supabase's PostgREST, just enough for the real supabase-js client used by the
 * web app and the worker: eq/neq/in/is filters, order, limit, insert/update/delete/upsert, unique indexes.
 */
import http from 'http';
import { randomUUID } from 'crypto';

type Row = Record<string, any>;
const UNIQUE: Record<string, string[][]> = {
  art_users: [['wallet'], ['tg_chat_id']], art_vaults: [['user_id'], ['address']], art_settings: [['user_id']],
  art_consents: [['user_id', 'message']], art_withdrawals: [['message']], art_link_codes: [['code']], art_state: [['user_id', 'key']],
};
const DEFAULTS: Record<string, () => Row> = {
  art_users: () => ({ id: randomUUID(), tg_chat_id: null, tg_username: null, created_at: new Date().toISOString() }),
  art_vaults: () => ({ created_at: new Date().toISOString() }),
  art_settings: () => ({ mode: 'medium', paused: true, live: false, max_position_sol: 0.05, max_daily_loss_pct: 20, max_concurrent: 1, plans: [], active_plan: null, panic_at: null, updated_at: new Date().toISOString() }),
  art_consents: () => ({ id: Math.floor(Math.random() * 1e9), sig_kind: 'message', created_at: new Date().toISOString(), revoked_at: null }),
  art_withdrawals: () => ({ id: randomUUID(), status: 'pending', sig_kind: 'message', amount_lamports: null, tx_sig: null, error: null, created_at: new Date().toISOString(), processed_at: null }),
  art_state: () => ({ updated_at: new Date().toISOString() }),
  art_trades: () => ({ id: Math.floor(Math.random() * 1e9), created_at: new Date().toISOString() }),
  art_link_codes: () => ({}),
};

export function startFakePostgrest(port: number) {
  const tables: Record<string, Row[]> = {};
  const T = (n: string) => (tables[n] ||= []);
  const matcher = (q: URLSearchParams) => {
    const conds: ((r: Row) => boolean)[] = [];
    q.forEach((v, k) => {
      if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) return;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      const eq = (r: Row) => String(r[k]) === val;
      if (op === 'eq') conds.push(eq);
      else if (op === 'neq') conds.push((r) => !eq(r));
      else if (op === 'is') conds.push((r) => (val === 'null' ? r[k] == null : r[k] === (val === 'true')));
      else if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')); conds.push((r) => set.includes(String(r[k]))); }
    });
    return (r: Row) => conds.every((c) => c(r));
  };
  const conflict = (table: string, row: Row, ignore?: Row) => (UNIQUE[table] || []).some((cols) => cols.every((c) => row[c] != null) && T(table).some((o) => o !== ignore && cols.every((c) => o[c] === row[c])));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const table = url.pathname.replace('/rest/v1/', '');
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const wantsOne = (req.headers.accept || '').includes('pgrst.object');
      const rep = String(req.headers.prefer || '').includes('return=representation');
      const body = raw ? JSON.parse(raw) : null;
      const match = matcher(url.searchParams);
      const out = (rows: Row[], status = 200) => {
        if (wantsOne) return rows.length === 1 ? send(status, rows[0]) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
        return send(status, rows);
      };
      if (req.method === 'GET') {
        let rows = T(table).filter(match);
        const order = url.searchParams.get('order');
        if (order) { const [c, d] = order.split('.'); rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (d === 'desc' ? -1 : 1)); }
        const lim = url.searchParams.get('limit'); if (lim) rows = rows.slice(0, Number(lim));
        return out(rows.map((r) => ({ ...r })));
      }
      if (req.method === 'POST') {
        const upsert = String(req.headers.prefer || '').includes('merge-duplicates');
        const items: Row[] = Array.isArray(body) ? body : [body];
        const made: Row[] = [];
        for (const it of items) {
          const row = { ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...it };
          if (upsert) {
            const existing = T(table).find((o) => (UNIQUE[table] || []).some((cols) => cols.every((c) => o[c] === row[c])));
            if (existing) { Object.assign(existing, it); made.push(existing); continue; }
          }
          if (conflict(table, row)) return send(409, { code: '23505', message: `duplicate key value violates unique constraint on ${table}` });
          T(table).push(row); made.push(row);
        }
        return rep ? out(made.map((r) => ({ ...r })), 201) : send(201, null);
      }
      if (req.method === 'PATCH') {
        const rows = T(table).filter(match);
        rows.forEach((r) => Object.assign(r, body));
        return rep ? out(rows.map((r) => ({ ...r }))) : send(204, null);
      }
      if (req.method === 'DELETE') {
        const keep = T(table).filter((r) => !match(r)); const gone = T(table).length - keep.length; tables[table] = keep;
        return rep ? send(200, []) : send(204, gone ? null : null);
      }
      send(405, { message: 'unsupported' });
    });
  });
  return new Promise<{ tables: Record<string, Row[]>; close: () => void }>((resolve) => server.listen(port, '127.0.0.1', () => resolve({ tables, close: () => server.close() })));
}
