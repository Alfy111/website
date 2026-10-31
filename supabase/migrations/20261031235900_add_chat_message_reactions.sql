create table if not exists public.chat_message_reactions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  player text not null check (char_length(player) between 1 and 40),
  reaction text not null check (
    reaction in ('heart', 'laugh', 'wow', 'sad', 'angry', 'like')
  ),
  created_at timestamptz not null default now(),
  primary key (message_id, player, reaction)
);

alter table public.chat_message_reactions enable row level security;
revoke all on public.chat_message_reactions from anon, authenticated;
grant select, insert, update, delete on public.chat_message_reactions to service_role;
