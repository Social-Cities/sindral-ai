begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

select is(public.sindral_schema_version(), '20260922174000', 'database reports the server-compatible migration version');
select ok(not has_function_privilege('authenticated', 'public.sindral_schema_version()', 'EXECUTE'), 'browser role cannot call the compatibility probe');
select ok(has_function_privilege('service_role', 'public.sindral_schema_version()', 'EXECUTE'), 'service role can call the compatibility probe');

select * from finish();
rollback;
