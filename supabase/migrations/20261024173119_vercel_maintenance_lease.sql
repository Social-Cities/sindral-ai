-- Service-only coordination for cron invocations and rolling server deployments.
create table public.maintenance_leases (
  name text primary key,
  token uuid not null,
  expires_at timestamptz not null
);
alter table public.maintenance_leases enable row level security;
revoke all on public.maintenance_leases from public, anon, authenticated;
grant select, insert, update, delete on public.maintenance_leases to service_role;

create function public.acquire_maintenance_lease(p_name text, p_ttl_seconds integer)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token uuid;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'Maintenance lease TTL must be between 1 and 3600 seconds';
  end if;
  insert into public.maintenance_leases as lease (name, token, expires_at)
  values (p_name, gen_random_uuid(), clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set token = excluded.token, expires_at = excluded.expires_at
    where lease.expires_at <= clock_timestamp()
  returning token into v_token;
  return v_token;
end
$$;

create function public.release_maintenance_lease(p_name text, p_token uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.maintenance_leases where name = p_name and token = p_token;
$$;

revoke all on function public.acquire_maintenance_lease(text, integer) from public, anon, authenticated;
revoke all on function public.release_maintenance_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_maintenance_lease(text, integer) to service_role;
grant execute on function public.release_maintenance_lease(text, uuid) to service_role;

create or replace function public.sindral_schema_version()
returns text language sql stable security invoker set search_path = ''
as $$ select '20261024173119'::text $$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
