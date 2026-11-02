# Supabase setup

The dashboard is a static GitHub Pages site. Supabase stores records across weeks and devices; email-and-password sign-in keeps each user's records private.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run `supabase-setup.sql`.
3. Copy the project URL and the project's publishable key (or legacy `anon` key) into `url` and `anonKey` in `supabase-config.js`. These browser keys are public; row-level security in the SQL script restricts data to the signed-in user. Never put a `service_role` key in this site.
4. In Supabase Authentication settings, disable public sign-ups so visitors cannot create new accounts.
5. In **Authentication > URL Configuration**, set the Site URL to `https://sottyon.github.io/dash/` and add that same URL to the allowed redirect URLs.
6. Set a password for your existing Supabase account, then sign in on the site with that account's email and password. The dashboard does not provide sign-up or passwordless sign-in. Your GitHub password is separate from your Supabase dashboard password.
7. Publish the files to GitHub Pages and open the site.
8. On your iPhone, open the dashboard link in Safari, tap **Share**, then **Add to Home Screen**. Launch the new Daymark icon for an app-like full-screen view.

## Google Calendar

The calendar panel can read, create, update, and delete events on your Google **primary calendar**. It requests the `calendar.events` permission. Events are fetched when the dashboard opens or returns to the foreground, and refreshed about every three minutes while it is open; this static GitHub Pages site cannot receive Google's server-side push notifications while closed.

To connect it:

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. If the app remains in testing mode, add your Google account as a test user; Google may require you to reconnect periodically while the app is unverified.
3. Create an OAuth client ID for a **Web application**. Add `https://sottyon.github.io` as an authorized JavaScript origin (origins must not include `/dash/`).
4. Put the client ID—not a client secret—in the `googleClientId` field in `supabase-config.js`, publish the update to GitHub Pages, then connect from either calendar view and grant access.

The OAuth client ID is public browser configuration; never put the OAuth client secret in this repository. Google Calendar access tokens stay in memory and are not saved to local storage, so reconnect after reloading the site. Dashboard calendar edits apply directly to events on the primary Google Calendar; they are not duplicated into Supabase.

If you cannot sign in, use **Forgot password?** on the dashboard login form. Supabase sends a recovery link to the account email; open it in the browser, choose a new password, then return to the dashboard and sign in. The redirect URL in step 5 must be allowed for the recovery link to return to the site.

The installed app and website use the same Supabase account and records. Changes sync through Supabase Realtime; the app refreshes records when a connection returns or you reopen it. Dashboard edits made offline are stored in the iPhone's local IndexedDB and sent to Supabase when a connection returns. Open the dashboard online at least once before relying on offline use so the app shell and saved records are cached. The sidebar shows how many edits are waiting to sync; keep the app open after reconnecting until it reports live sync. Offline edits are stored on that device and are not available on another device until they sync. If the same record is edited on another device while this iPhone is offline, the iPhone's queued version is applied when it reconnects. Google Calendar events still require a connection. The sidebar also reports save and refresh errors; “Saved to Supabase, but refresh failed” means the database confirmed the write, but the page could not reload its records yet.

The RLS policies in `supabase-setup.sql` require a password-authenticated session for every dashboard data operation. Supabase's email provider can still accept a direct OTP or magic-link request for an existing account; disabling public sign-ups does not turn off that endpoint. A passwordless session is denied access to dashboard records by the RLS policies. To apply this protection to an existing project, rerun the updated SQL script in the Supabase SQL Editor; it replaces the four existing record policies.

Tasks, habits, spending, and book records created after setup are stored in the `dashboard_records` table. Dashboard tasks have Work or Personal labels, a separately saved task-notes section, and completion celebrations; the overview card links to the checklist and shows its outstanding Work/Personal counts. Weekly expenses include their category and selected account; monthly category budgets are also stored as dashboard records and sync across devices. Credit cards, checking accounts, and individual savings buckets have editable starting balances and dates. Expenses dated on or after an account's starting-balance date update its displayed balance: card expenses increase the card balance, while checking and savings expenses reduce their selected account or bucket. The monthly spending page compares each category's recorded expenses with its budget. The Book Tracker searches Open Library and Apple Books online; search results are not saved until added to the shelf. Books added to the shelf and their reading statuses sync across the website and iPhone app through Supabase. Google Calendar events remain in Google Calendar. Supabase records are not shared between accounts, and existing records in the Canva Sheet are not automatically imported.

## Daily task texts

The optional daily task reminder runs in Supabase, so it does not depend on the iPhone app being open. The included Edge Function checks hourly and sends at 8 AM in each configured user's time zone, including during daylight-saving changes. It texts up to 25 incomplete Work and Personal tasks, or a no-open-tasks message. Text-message rates and a Twilio account/number are required. The reminder is not active until you complete these setup steps:

1. In your Twilio account, obtain an Account SID, Auth Token, and SMS-capable sending number. Add them as Edge Function secrets in the Supabase Dashboard; do not put the values in this repository or share them in chat.
2. Deploy the function from the repository root with `supabase functions deploy daily-task-reminder`.
3. Store your project URL and service-role JWT in Supabase Vault. Replace the placeholders locally with values from your Supabase project; never commit them:
   `select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'daymark_supabase_url');`
   `select vault.create_secret('YOUR_SERVICE_ROLE_JWT', 'daymark_service_role_key');`
4. Open `supabase/daily-task-reminder-setup.sql` from the repository in a text editor, copy the file's entire SQL contents, paste those contents into a new Supabase SQL Editor query, and run the query. The SQL Editor cannot execute a repository file path by itself; do not paste the path as the query.
5. Find your account UUID under **Authentication > Users**, then add a reminder row in the SQL Editor. Replace the placeholders with your UUID and phone number in E.164 format:
   `insert into public.dashboard_task_reminders (user_id, phone_number, time_zone) values ('YOUR_AUTH_USER_UUID', '+15551234567', 'America/New_York') on conflict (user_id) do update set phone_number = excluded.phone_number, time_zone = excluded.time_zone, enabled = true;`
   The reminder table has row-level security enabled with no client access policies; only the service role used by the Edge Function can read phone numbers.

To pause reminders, set that user's `enabled` column to `false` in the SQL Editor. The scheduled job checks the configured time zone and sends at most one reminder per local date.
