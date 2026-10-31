# Supabase setup

The dashboard is a static GitHub Pages site. Supabase stores records across weeks and devices; email magic-link sign-in keeps each user's records private.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run `supabase-setup.sql`.
3. Copy the project URL and the project's publishable key (or legacy `anon` key) into `url` and `anonKey` in `supabase-config.js`. These browser keys are public; row-level security in the SQL script restricts data to the signed-in user. Never put a `service_role` key in this site.
4. In Supabase Authentication URL Configuration, add `https://sottyon.github.io/dash/` to the allowed redirect URLs.
5. Publish the files to GitHub Pages, open the site, and sign in with your email. Supabase sends a one-time sign-in link.

Tasks, habits, spending, calendar entries, and book records created after setup are stored in the `dashboard_records` table. Records are not shared between accounts. Existing records in the Canva Sheet are not automatically imported.
