revoke delete on public.dashboard_records from public, anon, authenticated;
drop policy if exists "Users can delete their own dashboard records" on public.dashboard_records;

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
