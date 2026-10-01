-- Keep the service-role compatibility probe aligned with the project schema.
-- The project tables shipped in 20260930153931 but that migration did not bump
-- this function, so deployed databases could be structurally current while
-- still reporting 20260927000000 at API startup.
create or replace function public.sindral_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select '20261001134245'::text $$;

revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
