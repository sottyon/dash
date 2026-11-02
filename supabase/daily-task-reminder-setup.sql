create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.dashboard_task_reminders (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone_number text not null,
  time_zone text not null,
  enabled boolean not null default true,
  last_sent_on date
);

alter table public.dashboard_task_reminders enable row level security;
revoke all on public.dashboard_task_reminders from anon, authenticated;
grant all on public.dashboard_task_reminders to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'daymark-daily-task-reminder';

select cron.schedule(
  'daymark-daily-task-reminder',
  '0 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'daymark_supabase_url'
      ) || '/functions/v1/daily-task-reminder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'daymark_service_role_key'
        ),
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'daymark_service_role_key'
        )
      ),
      body := '{}'::jsonb
    );
  $job$
);
