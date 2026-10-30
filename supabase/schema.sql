create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  player text not null check (char_length(player) between 1 and 40),
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_created_at_idx
  on public.chat_messages (created_at);

alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;
grant select, insert on public.chat_messages to service_role;

create table if not exists public.chat_typing (
  player text primary key check (char_length(player) between 1 and 40),
  is_typing boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.chat_typing enable row level security;
revoke all on public.chat_typing from anon, authenticated;
grant select, insert, update on public.chat_typing to service_role;

create table if not exists public.chat_push_subscriptions (
  endpoint text primary key check (char_length(endpoint) between 1 and 2048),
  player text not null check (char_length(player) between 1 and 40),
  subscription jsonb not null,
  notification_title text not null default 'Freeform Chat'
    check (char_length(notification_title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_push_subscriptions_player_idx
  on public.chat_push_subscriptions (player);

alter table public.chat_push_subscriptions enable row level security;
revoke all on public.chat_push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.chat_push_subscriptions to service_role;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table if not exists app_private.chat_pin_attempts (
  ip_hash text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz
);

create or replace function public.consume_chat_pin_attempt(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_allowed boolean;
begin
  insert into app_private.chat_pin_attempts (ip_hash)
  values (p_ip_hash)
  on conflict (ip_hash) do nothing;

  update app_private.chat_pin_attempts
  set
    attempts = case
      when blocked_until > pg_catalog.now() then attempts
      when window_started_at <= pg_catalog.now() - interval '10 minutes' then 1
      else attempts + 1
    end,
    window_started_at = case
      when blocked_until > pg_catalog.now() then window_started_at
      when window_started_at <= pg_catalog.now() - interval '10 minutes' then pg_catalog.now()
      else window_started_at
    end,
    blocked_until = case
      when blocked_until > pg_catalog.now() then blocked_until
      when window_started_at <= pg_catalog.now() - interval '10 minutes' then null
      when attempts + 1 >= 10 then pg_catalog.now() + interval '15 minutes'
      else null
    end
  where ip_hash = p_ip_hash
  returning blocked_until is null or blocked_until <= pg_catalog.now()
  into request_allowed;

  return coalesce(request_allowed, false);
end;
$$;

revoke all on function public.consume_chat_pin_attempt(text) from public, anon, authenticated;
grant execute on function public.consume_chat_pin_attempt(text) to service_role;
