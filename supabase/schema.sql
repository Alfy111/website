create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  player text not null check (char_length(player) between 1 and 40),
  content text not null default '',
  media_path text,
  reply_to uuid references public.chat_messages (id) on delete set null,
  seen_by text,
  seen_at timestamptz,
  constraint chat_messages_content_check check (
    (media_path is null and char_length(content) between 1 and 2000) or
    (media_path is not null and char_length(content) between 0 and 2000)
  ),
  created_at timestamptz not null default now()
);

alter table public.chat_messages
  add column if not exists media_path text,
  add column if not exists reply_to uuid references public.chat_messages (id) on delete set null,
  add column if not exists seen_by text,
  add column if not exists seen_at timestamptz,
  alter column content drop not null,
  alter column content set default '';

alter table public.chat_messages
  drop constraint if exists chat_messages_content_check,
  add constraint chat_messages_content_check check (
    (media_path is null and char_length(content) between 1 and 2000) or
    (media_path is not null and char_length(content) between 0 and 2000)
  );

create index if not exists chat_messages_created_at_idx
  on public.chat_messages (created_at);

alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;
grant select, insert, update on public.chat_messages to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-photos',
  'chat-photos',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.chat_message_reactions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  player text not null check (char_length(player) between 1 and 40),
  reaction text not null check (reaction in ('heart', 'laugh', 'wow', 'sad', 'angry', 'like')),
  created_at timestamptz not null default now(),
  primary key (message_id, player, reaction)
);

alter table public.chat_message_reactions enable row level security;
revoke all on public.chat_message_reactions from anon, authenticated;
grant select, insert, update, delete on public.chat_message_reactions to service_role;

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
