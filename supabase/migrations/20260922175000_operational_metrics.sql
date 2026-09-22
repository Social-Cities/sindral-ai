create or replace function public.sindral_operational_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'taskStates', coalesce((
      select jsonb_object_agg(grouped.state, grouped.count)
      from (select state, count(*)::integer as count from public.tasks group by state) grouped
    ), '{}'::jsonb),
    'jobStatuses', coalesce((
      select jsonb_object_agg(grouped.status, grouped.count)
      from (select status, count(*)::integer as count from public.jobs group by status) grouped
    ), '{}'::jsonb),
    'workerCount', (select count(*)::integer from public.workers),
    'oldestWorkerHeartbeatAgeSeconds', coalesce((
      select greatest(0, extract(epoch from (now() - min(last_seen_at))))::double precision from public.workers
    ), 0)
  )
$$;

create or replace function public.sindral_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select '20260922175000'::text $$;

revoke all on function public.sindral_operational_snapshot() from public, anon, authenticated;
grant execute on function public.sindral_operational_snapshot() to service_role;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
