-- New Supabase API keys (sb_publishable_*, sb_secret_*) require explicit
-- GRANTs to the underlying Postgres roles — tables are no longer exposed
-- to PostgREST automatically. RLS from 0002_auth_scoping.sql still gates
-- visibility per-row; these grants only unlock the API surface.

grant usage on schema public to anon, authenticated, service_role;

-- secret key → service_role. Bypasses RLS. Used by the backend admin client
-- for signup / worker bookkeeping (agatha-teams-backend/src/supabase.ts).
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- publishable key + user JWT → authenticated. RLS narrows reads/writes to
-- auth.uid() = owner_id (or the parent task's owner for child tables).
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- Future tables/sequences/functions inherit the same grants automatically,
-- so new migrations don't need to repeat this block.
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;
