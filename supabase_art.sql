-- ART (African Robot Trader) schema. Run once in the Supabase SQL editor.
-- All tables are locked: RLS on, no policies, anon/authenticated roles revoked.
-- Only the server side (Next.js API routes + the worker) talks to them, with the service-role key.

create extension if not exists pgcrypto;

create table if not exists public.art_users (
  id          uuid primary key default gen_random_uuid(),
  wallet      text not null unique,          -- the wallet the user connected (base58 pubkey)
  tg_chat_id  bigint unique,                 -- set by /link CODE in Telegram
  tg_username text,
  created_at  timestamptz not null default now()
);

-- One trading vault per user. The secret key is SEALED to the worker's public key:
-- the web app can create it but can never read it back (only the worker holds the opening key).
create table if not exists public.art_vaults (
  user_id    uuid primary key references public.art_users(id) on delete cascade,
  address    text not null unique,
  sealed     jsonb not null,                 -- { v, epk, n, ct } see lib/seal.js
  created_at timestamptz not null default now()
);

-- Signed consent. Every row is a message the user signed with their own wallet.
create table if not exists public.art_consents (
  id         bigserial primary key,
  user_id    uuid not null references public.art_users(id) on delete cascade,
  version    text not null,
  message    text not null,
  signature  text not null,                  -- base64
  sig_kind   text not null default 'message',-- 'message' | 'tx' (Ledger fallback)
  limits     jsonb not null,                 -- { maxPositionSol, maxDailyLossPct, maxConcurrent, mode }
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists art_consents_user_idx on public.art_consents (user_id, created_at desc);
create unique index if not exists art_consents_msg_uq on public.art_consents (user_id, message);  -- a signed message can be stored once (replay guard)

create table if not exists public.art_settings (
  user_id            uuid primary key references public.art_users(id) on delete cascade,
  mode               text not null default 'medium' check (mode in ('easy','medium','hard')),
  paused             boolean not null default true,    -- starts paused; the user presses Start
  live               boolean not null default false,   -- false = paper trading
  max_position_sol   double precision not null default 0.05,
  max_daily_loss_pct double precision not null default 20,
  max_concurrent     integer not null default 1,
  size_usd           double precision,                 -- legacy (trade size now lives in each plan)
  plans              jsonb not null default '[]'::jsonb, -- the user's trading plans (entry/exit rules, trade size)
  active_plan        text,                             -- id of the plan that is switched on
  panic_at           timestamptz,                      -- "Stop and sell all" request
  public_profile     boolean not null default true,    -- listed on the leaderboard by default (profit, trades and active plan are visible); the user can hide
  handle             text,                             -- public name on the leaderboard (never the wallet)
  follow_user_id     uuid references public.art_users(id) on delete set null, -- auto-copy: whose active plan this user mirrors
  updated_at         timestamptz not null default now()
);

-- Upgrade block: makes this whole file safe to re-run on a database that already has the tables.
-- ("create table if not exists" skips existing tables, so new columns are added here.)
alter table public.art_settings add column if not exists size_usd double precision;
alter table public.art_settings add column if not exists plans jsonb not null default '[]'::jsonb;
alter table public.art_settings add column if not exists active_plan text;
alter table public.art_settings add column if not exists public_profile boolean not null default true;
alter table public.art_settings add column if not exists handle text;
alter table public.art_settings add column if not exists follow_user_id uuid references public.art_users(id) on delete set null;

create unique index if not exists art_settings_handle_uq on public.art_settings (lower(handle)) where handle is not null;
create index if not exists art_settings_follow_idx on public.art_settings (follow_user_id) where follow_user_id is not null;

-- Per-user bot state (open positions, daily counters, recent history), same shape the old single-user bot used.
create table if not exists public.art_state (
  user_id    uuid not null references public.art_users(id) on delete cascade,
  key        text not null,                            -- 'paper:positions' | 'live:positions' | 'live:daily' ...
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists public.art_trades (
  id            bigserial primary key,
  user_id       uuid not null references public.art_users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  paper         boolean not null,
  mode          text,
  mint          text not null,
  entry_reason  text,
  exit_reason   text,
  cost_sol      double precision,
  proceeds_sol  double precision,
  realized_sol  double precision,
  pct           double precision,
  hold_sec      integer,
  buy_sig       text,
  sell_sig      text,
  features      jsonb
);
create index if not exists art_trades_user_idx on public.art_trades (user_id, created_at desc);

-- Withdrawals: the user signs "send X SOL to MY connected wallet". The web API stores the request,
-- the worker re-verifies the signature and is the only thing that can move the vault funds.
create table if not exists public.art_withdrawals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.art_users(id) on delete cascade,
  to_address     text not null,
  amount_lamports bigint,                              -- null = everything
  message        text not null,
  signature      text not null,
  sig_kind       text not null default 'message',
  status         text not null default 'pending' check (status in ('pending','processing','done','failed','rejected')),
  tx_sig         text,
  error          text,
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);
create index if not exists art_withdrawals_status_idx on public.art_withdrawals (status, created_at);
create unique index if not exists art_withdrawals_msg_uq on public.art_withdrawals (message);  -- replay guard: the nonce is inside the message

-- Manual buys: the website stores "buy X SOL of this coin", the worker executes it inside the user's signed limits.
create table if not exists public.art_orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.art_users(id) on delete cascade,
  mint        text not null,
  size_sol    numeric not null,
  tp_pct      numeric,
  sl_pct      numeric,
  hold_min    numeric,
  status      text not null default 'pending' check (status in ('pending','processing','done','failed')),
  result      text,
  paper       boolean,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists art_orders_status_idx on public.art_orders (status, created_at);
create index if not exists art_orders_user_idx on public.art_orders (user_id, created_at desc);

create table if not exists public.art_link_codes (
  code       text primary key,
  user_id    uuid not null references public.art_users(id) on delete cascade,
  expires_at timestamptz not null
);

-- The worker reports in here every ~15 s so the website can tell users whether the robot service is running
-- and whether live trading is switched on for real.
create table if not exists public.art_worker (
  id            text primary key,
  beat          timestamptz not null default now(),
  live_enabled  boolean not null default false,
  version       text,
  accounts      integer not null default 0
);

-- Our own price history: the worker records every trade it sees on the live feed into 5-second candles and saves them
-- here so the website can draw charts without any outside chart service. Old rows are pruned after a day.
create table if not exists public.art_charts (
  mint        text primary key,
  name        text,
  symbol      text,
  uri         text,
  first_seen  timestamptz,
  mcap_sol    double precision,
  v_sol       double precision,
  migrated    boolean not null default false,
  bars        jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);
-- columns added later (safe to re-run on an existing database)
alter table public.art_charts add column if not exists created     boolean not null default false;
alter table public.art_charts add column if not exists migrated_at timestamptz;
alter table public.art_charts add column if not exists stats       jsonb;
alter table public.art_charts add column if not exists image       text;
alter table public.art_charts add column if not exists description text;
alter table public.art_charts add column if not exists thumb       text;          -- ~2 KB base64 WebP, made by the worker
alter table public.art_charts add column if not exists bars_1m     jsonb not null default '[]'::jsonb;   -- 1-minute candles, up to 6 hours
alter table public.art_charts add column if not exists bars_5m     jsonb not null default '[]'::jsonb;   -- 5-minute candles, up to 3 days
alter table public.art_charts add column if not exists trades      jsonb not null default '[]'::jsonb;   -- the last ~60 trades by everyone: [ms, 'b'|'s', sol, mcapSol, trader, sig]
alter table public.art_charts add column if not exists has_thumb   boolean not null default false;
alter table public.art_charts add column if not exists dev         text;
create index if not exists art_charts_updated_idx on public.art_charts (updated_at desc);
create index if not exists art_charts_first_seen_idx on public.art_charts (first_seen desc);
create index if not exists art_charts_vsol_idx on public.art_charts (v_sol desc);

alter table public.art_worker add column if not exists checks jsonb;  -- what the robot can reach (RPC, trade builder, price feed), refreshed every minute

do $$
declare t text;
begin
  foreach t in array array['art_users','art_vaults','art_consents','art_settings','art_state','art_trades','art_withdrawals','art_orders','art_link_codes','art_worker','art_charts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.art_consents_id_seq, public.art_trades_id_seq from anon, authenticated;
