# Freeform Chat

A minimal two-player chat built with vanilla JavaScript, Vite, and Supabase. Enter one of the two PINs to open the shared conversation as that player. Messages are stored in Supabase and refresh from the cloud every five seconds. There are no email accounts or registrations.

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

   Keep the private key secret. Add the public key to `.env` as `VITE_VAPID_PUBLIC_KEY` and to your Vercel environment variables. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (for example `mailto:you@example.com`) in Supabase Edge Function secrets, alongside `CHAT_PIN_1`, `CHAT_PIN_2`, `CHAT_PLAYER_1`, and `CHAT_PLAYER_2`. Never put the VAPID private key or service-role key in the frontend.

   ```sh
   supabase secrets set CHAT_PIN_1=your-first-pin CHAT_PIN_2=your-second-pin CHAT_PLAYER_1=ashy CHAT_PLAYER_2=alfey VAPID_PUBLIC_KEY=your-public-key VAPID_PRIVATE_KEY=your-private-key VAPID_SUBJECT=mailto:you@example.com
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

   create index if not exists chat_push_subscriptions_player_idx
     on public.chat_push_subscriptions (player);

   alter table public.chat_push_subscriptions enable row level security;
   revoke all on public.chat_push_subscriptions from anon, authenticated;
   grant select, insert, update, delete on public.chat_push_subscriptions to service_role;
   ```

7. Deploy the PIN-checked chat function:

   ```sh
   supabase functions deploy private-chat
   ```

   The project's service-role key is used only by the Edge Function and is never sent to the browser. The SQL schema blocks direct browser access to the messages table.

8. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_VAPID_PUBLIC_KEY` in Vercel. For local development, add them to `.env` and restart Vite.

The function rate-limits incorrect PIN attempts by source IP. Four-digit PINs are still low-entropy and this simple PIN gate is not suitable for highly sensitive conversations. The chat is shared between both PINs; each participant sees their own messages on the right.

Chat history is stored in Supabase, so it is available from other devices using the same project and PINs. The browser only keeps the PIN in memory while its chat is unlocked.

On iOS, deploy to HTTPS, open the site in Safari, add it to the Home Screen, open the installed app, unlock the chat, and tap **Enable alerts** to grant push permission and register that device. Repeat on each device. Push alerts use the editable title and a generic message body; the chat content is not included in the notification. Subscriptions are removed when alerts are disabled from the same device.

The red X beside the message button is a quick exit: it replaces the current page with a Google search for weather. Browsers generally do not let a website close a tab it did not open. The search query is sent to Google, so this exit is intended as a visual screen change, not a way to erase browser or network history.
