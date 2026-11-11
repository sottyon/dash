create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.dashboard_task_reminders (
  user_id uuid primary key references auth.users (id) on delete cascade,
  phone_number text not null,
  time_zone text not null,
  enabled boolean not null default true,
  last_sent_on date,
  consented_at timestamptz,
  consent_text_version text
);

alter table public.dashboard_task_reminders
  add column if not exists consented_at timestamptz,
  add column if not exists consent_text_version text;

alter table public.dashboard_task_reminders enable row level security;
revoke all on public.dashboard_task_reminders from anon, authenticated;
grant all on public.dashboard_task_reminders to service_role;

create or replace function public.get_dashboard_task_reminder()
returns table (phone_number text, time_zone text, enabled boolean, consented_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false) then
    raise insufficient_privilege using message = 'A password-authenticated session is required.';
  end if;

  return query
  select reminder.phone_number, reminder.time_zone, reminder.enabled, reminder.consented_at
  from public.dashboard_task_reminders as reminder
  where reminder.user_id = auth.uid();
end
$$;

create or replace function public.save_dashboard_task_reminder(
  p_phone_number text,
  p_time_zone text,
  p_consent boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := btrim(coalesce(p_phone_number, ''));
  v_time_zone text := btrim(coalesce(p_time_zone, ''));
  v_existing public.dashboard_task_reminders%rowtype;
  v_has_consent boolean := false;
begin
  if auth.uid() is null
    or not coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false) then
    raise insufficient_privilege using message = 'A password-authenticated session is required.';
  end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise invalid_parameter_value using message = 'Enter a phone number in E.164 format.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = v_time_zone
  ) then
    raise invalid_parameter_value using message = 'Choose a valid time zone.';
  end if;

  -- Consent is collected once per phone number. A user who already agreed for
  -- this number can change their time zone or resume reminders without
  -- re-consenting; a new number always requires fresh consent.
  select * into v_existing
  from public.dashboard_task_reminders
  where user_id = auth.uid();
  v_has_consent := found
    and v_existing.consented_at is not null
    and v_existing.phone_number = v_phone;

  if not v_has_consent and p_consent is distinct from true then
    raise check_violation using message = 'Consent is required to enable text reminders.';
  end if;

  insert into public.dashboard_task_reminders (
    user_id, phone_number, time_zone, enabled, consented_at, consent_text_version
  ) values (
    auth.uid(),
    v_phone,
    v_time_zone,
    true,
    case when v_has_consent then v_existing.consented_at else now() end,
    case when v_has_consent then v_existing.consent_text_version else 'sot-dash-sms-2026-11-11-v2' end
  )
  on conflict (user_id) do update
  set phone_number = excluded.phone_number,
      time_zone = excluded.time_zone,
      enabled = true,
      consented_at = excluded.consented_at,
      consent_text_version = excluded.consent_text_version;
end
$$;

create or replace function public.disable_dashboard_task_reminder()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false) then
    raise insufficient_privilege using message = 'A password-authenticated session is required.';
  end if;

  update public.dashboard_task_reminders
  set enabled = false
  where user_id = auth.uid();
end
$$;

revoke all on function public.get_dashboard_task_reminder() from public, anon, authenticated;
revoke all on function public.save_dashboard_task_reminder(text, text, boolean) from public, anon, authenticated;
revoke all on function public.disable_dashboard_task_reminder() from public, anon, authenticated;
grant execute on function public.get_dashboard_task_reminder() to authenticated;
grant execute on function public.save_dashboard_task_reminder(text, text, boolean) to authenticated;
grant execute on function public.disable_dashboard_task_reminder() to authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'daymark-daily-task-reminder';

select cron.schedule(
  'daymark-daily-task-reminder',
  '*/15 * * * *',
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
