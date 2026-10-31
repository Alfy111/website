create table if not exists public.chat_notes (
  player text primary key check (char_length(player) between 1 and 40),
  note text not null default '' check (char_length(note) <= 120),
  updated_at timestamptz not null default now()
);

alter table public.chat_notes enable row level security;
revoke all on public.chat_notes from anon, authenticated;
grant select, insert, update, delete on public.chat_notes to service_role;
