alter table public.chat_messages
  add column if not exists edited_at timestamptz;
