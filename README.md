# Freeform Chat

A minimal two-player chat built with vanilla JavaScript, Vite, and Supabase. Enter one of the two PINs to open the shared conversation as that player. Messages are stored in Supabase and refresh from the cloud every two seconds. There are no email accounts or registrations.

## Set up the Supabase project

1. Create a Supabase project.
2. In **Project Settings → API**, copy the **Project URL** and **Publishable key** into a new `.env` file in the project root. Start from `.env.example`. The publishable key is intended for browser use; never use a secret or service-role key in `.env`.
3. Run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL Editor.
4. Install the Supabase CLI, log in, and link this folder to the project:

   ```sh
   supabase login
   supabase link --project-ref your-project-ref
   ```

5. Generate a VAPID key pair locally:

   ```sh
   npx --yes web-push@3.6.7 generate-vapid-keys --json
   ```

   Keep the private key secret. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (for example `mailto:you@example.com`) in Supabase Edge Function secrets, alongside `CHAT_PIN_1`, `CHAT_PIN_2`, `CHAT_PLAYER_1`, and `CHAT_PLAYER_2`. Never put the VAPID private key or service-role key in the frontend. The app fetches the matching public key from the PIN-checked function when enabling push.

   ```sh
   supabase secrets set CHAT_PIN_1=your-first-pin CHAT_PIN_2=your-second-pin CHAT_PLAYER_1=ashy CHAT_PLAYER_2=alfie VAPID_PUBLIC_KEY=your-public-key VAPID_PRIVATE_KEY=your-private-key VAPID_SUBJECT=mailto:you@example.com
   ```

6. Create the private push-subscription table. For a fresh project, run [`supabase/schema.sql`](./supabase/schema.sql). If the chat tables already exist, run only this migration in the SQL Editor:

   ```sql
   create table if not exists public.chat_push_subscriptions (
     endpoint text primary key check (char_length(endpoint) between 1 and 2048),
     player text not null check (char_length(player) between 1 and 40),
     subscription jsonb not null,
     notification_title text not null default 'Freeform Chat'
       check (char_length(notification_title) between 1 and 120),
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   );

   create table if not exists public.chat_message_reactions (
     message_id uuid not null references public.chat_messages (id) on delete cascade,
     player text not null check (char_length(player) between 1 and 40),
     reaction text not null check (reaction in ('heart', 'laugh', 'wow', 'sad', 'angry', 'like')),
     created_at timestamptz not null default now(),
     primary key (message_id, player, reaction)
   );

   alter table public.chat_message_reactions
     drop constraint if exists chat_message_reactions_pkey,
     add constraint chat_message_reactions_pkey primary key (message_id, player, reaction);

   alter table public.chat_message_reactions enable row level security;
   revoke all on public.chat_message_reactions from anon, authenticated;
   grant select, insert, update, delete on public.chat_message_reactions to service_role;

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

   create index if not exists chat_push_subscriptions_player_idx
     on public.chat_push_subscriptions (player);

   alter table public.chat_push_subscriptions enable row level security;
   revoke all on public.chat_push_subscriptions from anon, authenticated;
   grant select, insert, update, delete on public.chat_push_subscriptions to service_role;
   ```

7. Deploy (or redeploy after schema changes) the PIN-checked chat function:

   ```sh
   supabase functions deploy private-chat
   ```

   The project's service-role key is used only by the Edge Function and is never sent to the browser. The SQL schema blocks direct browser access to the messages table.

8. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Vercel. For local development, add them to `.env` and restart Vite.

The function rate-limits incorrect PIN attempts by source IP. Four-digit PINs are still low-entropy and this simple PIN gate is not suitable for highly sensitive conversations. The chat is shared between both PINs; each participant sees their own messages on the right.

Chat history is stored in Supabase, so it is available from other devices using the same project and PINs. The browser only keeps the PIN in memory while its chat is unlocked.

Use the photo button beside the message field to select one or more gallery images. Photos are sent through the message queue and stored in a private Supabase Storage bucket; the upload limit is 8 MB per image.

Messages show when the other participant has seen them. Swipe a message to the right to reply; the reply is attached to the sent message and shown as a quoted preview.

Long-press a message to focus it in place, show reactions above it, and open the vertical reply/copy actions alongside it. Tap the player name at the top left to open chat tools. Search is opened from its icon and displays full-message results with sender and date/time; select a result to jump to it in the conversation. The up/down buttons move through highlighted matches. **Photos** opens a three-column album; each photo includes a **Show in chat** action to jump to its message. Photo attachments can be previewed before sending, including images pasted from the clipboard. Tap a photo to open its full-size preview and download it. The chat header shows the other player's presence and the current streak. A green status means the account is active now; otherwise it shows elapsed seconds, minutes, hours, or days. A streak day requires both players to send at least one message that local calendar day. The red quick-exit button in the chat can be dragged to a preferred position.

On iOS, deploy to HTTPS, open the site in Safari, add it to the Home Screen, open the installed app, unlock the chat, and tap **Enable alerts** to grant push permission and register that device. Repeat on each device. Each incoming message sends its own push notification, so notifications can stack; chat content is not included. Alerts can be disabled independently on each device. Push display also depends on the device's notification and Focus settings.

The red X beside the message button is a quick exit: it replaces the current page with a Google search for “what's pax silica”. Browsers generally do not let a website close a tab it did not open. The search query is sent to Google, so this exit is intended as a visual screen change, not a way to erase browser or network history.
