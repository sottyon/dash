create table if not exists public.dashboard_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  record jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_records_user_id_idx
  on public.dashboard_records (user_id);

grant select, insert, update, delete on public.dashboard_records to authenticated;

alter table public.dashboard_records enable row level security;

create policy "Users can read their own dashboard records"
  on public.dashboard_records for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own dashboard records"
  on public.dashboard_records for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own dashboard records"
  on public.dashboard_records for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own dashboard records"
  on public.dashboard_records for delete to authenticated
  using ((select auth.uid()) = user_id);

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
