-- A service-role-only compatibility probe lets the API prove both database
-- connectivity and migration level before it starts accepting traffic.
create or replace function public.sindral_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '20260922174000'::text
$$;

revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
