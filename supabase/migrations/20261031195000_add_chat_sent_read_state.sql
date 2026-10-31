create table if not exists public.chat_sent_read_state (
  viewer_player text primary key check (char_length(viewer_player) between 1 and 40),
  last_viewed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_sent_read_state enable row level security;
revoke all on public.chat_sent_read_state from anon, authenticated;
grant select, insert, update on public.chat_sent_read_state to service_role;
