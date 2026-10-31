alter table public.chat_presence
  add column if not exists is_active boolean not null default false;
