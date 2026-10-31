begin;
select plan(10);
insert into auth.users(id,email) values ('93000000-0000-4000-8000-000000000093','task-platforms@example.test');
insert into public.projects(id,user_id,name,project_type,platforms) values ('94000000-0000-4000-8000-000000000094','93000000-0000-4000-8000-000000000093','Mobile','mobile-app',array['ios','android','web']);
insert into public.workflows(id,user_id,name,definition) values
('95000000-0000-4000-8000-000000000095','93000000-0000-4000-8000-000000000093','Mobile','{"mobilePlatforms":["ios","android"]}'),
('95000000-0000-4000-8000-000000000096','93000000-0000-4000-8000-000000000093','Standard','{}');
insert into public.tasks(user_id,key,title,project_id,workflow_id,pinned_workflow,state) values
('93000000-0000-4000-8000-000000000093','SCOPE-1','Pending','94000000-0000-4000-8000-000000000094','95000000-0000-4000-8000-000000000095',null,'todo'),
('93000000-0000-4000-8000-000000000093','SCOPE-2','Running','94000000-0000-4000-8000-000000000094','95000000-0000-4000-8000-000000000095','{"mobilePlatforms":["android"]}','implement-android'),
('93000000-0000-4000-8000-000000000093','SCOPE-3','Standard','94000000-0000-4000-8000-000000000094','95000000-0000-4000-8000-000000000096',null,'todo');
select is((select platforms from public.tasks where key='SCOPE-3' and user_id='93000000-0000-4000-8000-000000000093'),null::text[],'standard tasks default to no platform scope');
-- Replay only the data backfill to prove pending/running scope migration behavior.
do $replay$
declare statement text; found_backfill boolean := false;
begin
  for statement in select unnest(statements) from supabase_migrations.schema_migrations where version='20261031173740' loop
    if position('update public.tasks t set platforms' in statement) > 0 then execute statement; found_backfill := true; end if;
  end loop;
  if not found_backfill then raise exception 'Platform backfill statement missing'; end if;
end $replay$;
select is((select platforms from public.tasks where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'),array['ios','android','web'],'pending mobile tasks snapshot project defaults');
select is((select platforms from public.tasks where key='SCOPE-2' and user_id='93000000-0000-4000-8000-000000000093'),array['android'],'running tasks retain pinned scope');
select is((select platforms from public.tasks where key='SCOPE-3' and user_id='93000000-0000-4000-8000-000000000093'),null::text[],'non-mobile workflow does not inherit mobile project platforms');
select lives_ok($$update public.tasks set platforms=array['ios','web'] where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'$$,'task supports a platform subset');
select throws_ok($$update public.tasks set platforms='{}' where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'$$,'23514',null,'empty selections are rejected');
select throws_ok($$update public.tasks set platforms=array['ios','ios'] where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'$$,'23514',null,'duplicate selections are rejected');
select throws_ok($$update public.tasks set platforms=array['windows'] where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'$$,'23514',null,'unknown selections are rejected');
select throws_ok($$update public.tasks set platforms=array[null]::text[] where key='SCOPE-1' and user_id='93000000-0000-4000-8000-000000000093'$$,'23514',null,'null platform entries are rejected');
select ok(not has_function_privilege('authenticated','public.create_design_implementation_task(uuid,jsonb,uuid,uuid,text)','EXECUTE'),'handoff creation remains server-only');
select * from finish();
rollback;
