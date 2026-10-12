import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let client: SupabaseClient | null = null;
/** Service-role client. Server only: never import this from a client component. */
export function db(): SupabaseClient {
  if (!client) client = createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
/** Unwrap a Supabase result or throw. Rows are untyped on purpose: the schema lives in supabase_art.sql. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function must(r: { data: any; error: { message: string } | null }, what: string): any {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
