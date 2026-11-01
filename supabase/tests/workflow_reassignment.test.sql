begin;
create extension if not exists pgtap with schema extensions;
select plan(22);
insert into auth.users(id,email) values
('a1000000-0000-4000-8000-000000000001','move-a@example.test'),
('b1000000-0000-4000-8000-000000000002','move-b@example.test');
insert into public.workflows(id,user_id,name,definition) values
('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','Destination','{}'),
('b2000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000002','Foreign','{}');
insert into public.tasks(id,user_id,key,title,state,plan,last_error) values
('a3000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','MOVE-1','Move me','failure','# Preserve me','Old failure');
insert into public.jobs(user_id,task_id,kind,step_id,payload) values
('a1000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','agent','old','{"kind":"agent"}');

create function pg_temp.assign_workflow(p_key text, p_version bigint, p_step text default 'human', p_user uuid default 'a1000000-0000-4000-8000-000000000001', p_workflow uuid default 'a2000000-0000-4000-8000-000000000001')
returns jsonb language sql as $$
select public.reassign_task_workflow(
  p_user_id => p_user, p_task_id => 'a3000000-0000-4000-8000-000000000001', p_expected_version => p_version,
  p_idempotency_key => p_key, p_request_hash => repeat(left(p_key,1),64),
  p_next_state => case when p_step='agent' then 'planning' else 'plan-review' end,
  p_next_step_id => p_step, p_failed_step_id => null, p_pin_workflow => true,
  p_pinned_workflow => jsonb_build_object('id',p_workflow,'steps','[{"id":"human","type":"human","state":"plan-review"},{"id":"agent","type":"agent","state":"planning"}]'::jsonb),
  p_event => '{"type":"workflow-reassigned","detail":{}}',
  p_job => case when p_step='agent' then '{"kind":"agent","stepId":"agent","payload":{"kind":"agent"}}'::jsonb else null end,
  p_cancel_queued => true, p_workflow_id => p_workflow, p_platforms => null
) $$;

set local role service_role;
select is(pg_temp.assign_workflow('aaaa-human-command',0)->'task'->>'state','plan-review','service role can move to a human checkpoint');
reset role;
select is((select workflow_id::text from public.tasks where key='MOVE-1'),'a2000000-0000-4000-8000-000000000001','assignment changes workflow id');
select is((select pinned_workflow->>'id' from public.tasks where key='MOVE-1'),'a2000000-0000-4000-8000-000000000001','assignment pins the destination');
select is((select current_step_id from public.tasks where key='MOVE-1'),'human','assignment selects the human step');
select is((select version from public.tasks where key='MOVE-1'),1::bigint,'assignment increments version');
select is((select last_error from public.tasks where key='MOVE-1'),null::text,'assignment clears the old error');
select is((select plan from public.tasks where key='MOVE-1'),'# Preserve me','assignment preserves the plan');
select is((select count(*) from public.jobs where task_id='a3000000-0000-4000-8000-000000000001' and status='cancelled'),1::bigint,'assignment cancels queued work');
select is(pg_temp.assign_workflow('aaaa-human-command',0)->>'replayed','true','assignment replays an old request');
select is((select count(*) from public.task_events where task_id='a3000000-0000-4000-8000-000000000001'),1::bigint,'replay does not add events');
select is(pg_temp.assign_workflow('bbbb-agent-command',1,'agent')->'task'->>'state','planning','assignment enters an agent step');
select is((select count(*) from public.jobs where task_id='a3000000-0000-4000-8000-000000000001' and status='queued'),1::bigint,'assignment queues the selected agent once');
select is(pg_temp.assign_workflow('bbbb-agent-command',1,'agent')->>'replayed','true','agent dispatch replays safely');
select is((select count(*) from public.jobs where task_id='a3000000-0000-4000-8000-000000000001'),2::bigint,'retry does not duplicate agent jobs');
select throws_ok($$select pg_temp.assign_workflow('cccc-stale-command',0)$$,'40001',null,'stale assignment is rejected');
select throws_ok($$select pg_temp.assign_workflow('dddd-foreign-command',2,'human','a1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002')$$,'42501',null,'foreign workflows are rejected');
select throws_ok($$select pg_temp.assign_workflow('eeee-foreign-task',2,'human','b1000000-0000-4000-8000-000000000002')$$,'42501',null,'foreign tasks are rejected');
select throws_ok($$select pg_temp.assign_workflow('ffff-unknown-step',2,'unknown')$$,'22023',null,'unknown steps are rejected');
update public.jobs set status='running' where task_id='a3000000-0000-4000-8000-000000000001' and status='queued';
select throws_ok($$select pg_temp.assign_workflow('aaaa-running-command',2)$$,'40001',null,'running work prevents assignment');
select is((select current_step_id from public.tasks where key='MOVE-1'),'agent','failed assignment leaves the current step intact');
select ok(not has_function_privilege('authenticated','public.reassign_task_workflow(uuid,uuid,bigint,text,text,text,text,text,boolean,jsonb,jsonb,jsonb,boolean,uuid,text[])','EXECUTE'),'authenticated browsers cannot call the assignment RPC');
select ok(not has_function_privilege('anon','public.reassign_task_workflow(uuid,uuid,bigint,text,text,text,text,text,boolean,jsonb,jsonb,jsonb,boolean,uuid,text[])','EXECUTE'),'anonymous callers cannot call the assignment RPC');
select * from finish();
rollback;
