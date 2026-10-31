# Supabase setup

The dashboard is a static GitHub Pages site. Supabase stores records across weeks and devices; email-and-password sign-in keeps each user's records private.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run `supabase-setup.sql`.
3. Copy the project URL and the project's publishable key (or legacy `anon` key) into `url` and `anonKey` in `supabase-config.js`. These browser keys are public; row-level security in the SQL script restricts data to the signed-in user. Never put a `service_role` key in this site.
4. In Supabase Authentication settings, disable public sign-ups so visitors cannot create new accounts.
5. Set a password for your existing account in Supabase Authentication, then sign in on the site with that account's email and password. The dashboard does not provide sign-up or passwordless sign-in.
6. Publish the files to GitHub Pages and open the site.
7. On your iPhone, open the dashboard link in Safari, tap **Share**, then **Add to Home Screen**. Launch the new Daymark icon for an app-like full-screen view.

The installed app and website use the same Supabase account and records. Changes sync through Supabase Realtime; the app refreshes records when a connection returns or you reopen it. Database edits require an internet connection and are not queued while offline.

The RLS policies in `supabase-setup.sql` require a password-authenticated session for every dashboard data operation. Supabase's email provider can still accept a direct OTP or magic-link request for an existing account; disabling public sign-ups does not turn off that endpoint. A passwordless session is denied access to dashboard records by the RLS policies. To apply this protection to an existing project, rerun the updated SQL script in the Supabase SQL Editor; it replaces the four existing record policies.

Tasks, habits, spending, calendar entries, and book records created after setup are stored in the `dashboard_records` table. Records are not shared between accounts. Existing records in the Canva Sheet are not automatically imported.
