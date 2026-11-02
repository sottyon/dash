create table if not exists public.dashboard_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  record jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_records_user_id_idx
  on public.dashboard_records (user_id);

grant select, insert, update on public.dashboard_records to authenticated;
revoke delete on public.dashboard_records from public, anon, authenticated;

alter table public.dashboard_records enable row level security;

drop policy if exists "Users can read their own dashboard records" on public.dashboard_records;
drop policy if exists "Users can create their own dashboard records" on public.dashboard_records;
drop policy if exists "Users can update their own dashboard records" on public.dashboard_records;
drop policy if exists "Users can delete their own dashboard records" on public.dashboard_records;

create policy "Users can read their own dashboard records"
  on public.dashboard_records for select to authenticated
  using (
    (select auth.uid()) = user_id
    and coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false)
  );

create policy "Users can create their own dashboard records"
  on public.dashboard_records for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false)
  );

create policy "Users can update their own dashboard records"
  on public.dashboard_records for update to authenticated
  using (
    (select auth.uid()) = user_id
    and coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false)
  )
  with check (
    (select auth.uid()) = user_id
    and coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false)
  );

create or replace function public.delete_dashboard_record(record_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not coalesce((auth.jwt()->'amr') @> '[{"method":"password"}]'::jsonb, false) then
    raise insufficient_privilege using message = 'A password-authenticated session is required.';
  end if;

  delete from public.dashboard_records
  where id = record_id and user_id = auth.uid();
  return found;
end
$$;

revoke all on function public.delete_dashboard_record(uuid) from public, anon, authenticated;
grant execute on function public.delete_dashboard_record(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dashboard_records'
  ) then
    alter publication supabase_realtime add table public.dashboard_records;
  end if;
end
$$;
