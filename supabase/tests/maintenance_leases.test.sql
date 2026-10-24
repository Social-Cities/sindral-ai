begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

select ok((select relrowsecurity from pg_class where oid = 'public.maintenance_leases'::regclass), 'maintenance leases have RLS');
select ok(not has_table_privilege('anon', 'public.maintenance_leases', 'SELECT'), 'anonymous clients cannot read leases');
select ok(not has_table_privilege('authenticated', 'public.maintenance_leases', 'UPDATE'), 'browser clients cannot overwrite leases');
select ok(not has_function_privilege('anon', 'public.acquire_maintenance_lease(text, integer)', 'EXECUTE'), 'anonymous clients cannot acquire leases');
select ok(not has_function_privilege('authenticated', 'public.acquire_maintenance_lease(text, integer)', 'EXECUTE'), 'browser clients cannot acquire leases');
select ok(not has_function_privilege('authenticated', 'public.release_maintenance_lease(text, uuid)', 'EXECUTE'), 'browser clients cannot release leases');

set local role service_role;
select isnt(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'service acquires the lease');
select is(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'second invocation cannot acquire a live lease');
select public.release_maintenance_lease('test-sweep', gen_random_uuid());
select is(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'incorrect token cannot release the lease');
select public.release_maintenance_lease('test-sweep', (select token from public.maintenance_leases where name = 'test-sweep'));
select isnt(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'correct token releases the lease');
create temporary table old_lease as select token from public.maintenance_leases where name = 'test-sweep';
update public.maintenance_leases set expires_at = clock_timestamp() - interval '1 second' where name = 'test-sweep';
select isnt(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'abandoned lease expires and can be acquired again');
select isnt((select token from public.maintenance_leases where name = 'test-sweep'), (select token from old_lease), 'successor receives a new token');
select public.release_maintenance_lease('test-sweep', (select token from old_lease));
select is(public.acquire_maintenance_lease('test-sweep', 360), null::uuid, 'stale owner cannot release successor lease');
select throws_ok($$select public.acquire_maintenance_lease('invalid', 0)$$, 'P0001', 'Maintenance lease TTL must be between 1 and 3600 seconds', 'zero TTL is rejected');
select throws_ok($$select public.acquire_maintenance_lease('invalid', 3601)$$, 'P0001', 'Maintenance lease TTL must be between 1 and 3600 seconds', 'unbounded TTL is rejected');

select * from finish();
rollback;
