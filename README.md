# Our little chat

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

5. In Supabase **Project Settings → Edge Functions → Secrets**, set `CHAT_PIN_1`, `CHAT_PIN_2`, `CHAT_PLAYER_1`, and `CHAT_PLAYER_2`. Use your two PINs and the desired player names. These are server-side secrets; do not commit them or put them in the frontend. The CLI is an alternative:

   ```sh
   supabase secrets set CHAT_PIN_1=your-first-pin CHAT_PIN_2=your-second-pin CHAT_PLAYER_1=ashy CHAT_PLAYER_2=alfey
   ```

6. Deploy the PIN-checked chat function:

   ```sh
   supabase functions deploy private-chat
   ```

   The project's service-role key is used only by the Edge Function and is never sent to the browser. The SQL schema blocks direct browser access to the messages table.

7. Restart Vite after creating `.env`, then run `npm run dev`.

The function rate-limits incorrect PIN attempts by source IP. Four-digit PINs are still low-entropy and this simple PIN gate is not suitable for highly sensitive conversations. The chat is shared between both PINs, and both participants' messages appear on the left.

Chat history is stored in Supabase, so it is available from other devices using the same project and PINs. The browser only keeps the PIN in memory while its chat is unlocked.

The red X beside the message button is a quick exit: it replaces the current page with a Google search for weather. Browsers generally do not let a website close a tab it did not open. The search query is sent to Google, so this exit is intended as a visual screen change, not a way to erase browser or network history.
