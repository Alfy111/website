create table if not exists public.chat_presence (
  player text primary key check (char_length(player) between 1 and 40),
  updated_at timestamptz not null default now()
);

alter table public.chat_presence enable row level security;
revoke all on public.chat_presence from anon, authenticated;
grant select, insert, update on public.chat_presence to service_role;
