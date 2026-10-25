begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email) values
('31000000-0000-4000-8000-000000000001','design-a@example.test'),
('32000000-0000-4000-8000-000000000002','design-b@example.test');
insert into public.tasks(id,user_id,key,title,state) values
('33000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000001','DESIGN-1','Design','designing');
insert into public.jobs(id,user_id,task_id,kind,step_id,payload,status,attempt,lease_token,lease_expires_at) values
('34000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000003','agent','design','{"kind":"agent","step":{"output":"design"}}','claimed',1,'35000000-0000-4000-8000-000000000005',now()+interval '90 seconds');

select lives_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','append',
'{"key":{"projectKey":"sindral-task-33000000-0000-4000-8000-000000000003","sessionId":"36000000-0000-4000-8000-000000000006"},"entries":[{"type":"assistant","uuid":"entry-1","message":"Keep the sidebar"}]}')$$,'writes an active design transcript');
select lives_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','append',
'{"key":{"projectKey":"sindral-task-33000000-0000-4000-8000-000000000003","sessionId":"36000000-0000-4000-8000-000000000006"},"entries":[{"type":"assistant","uuid":"entry-1","message":"Keep the sidebar"}]}')$$,'retrying a batch succeeds');
select is((select count(*) from public.design_session_entries where task_id='33000000-0000-4000-8000-000000000003'),1::bigint,'deduplicates transcript retries');
select is((public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','load',
'{"key":{"projectKey":"sindral-task-33000000-0000-4000-8000-000000000003","sessionId":"36000000-0000-4000-8000-000000000006"},"after":0}')->'entries'->0->>'message'),'Keep the sidebar','loads the saved conversation');
select throws_ok($$select public.design_session_command('32000000-0000-4000-8000-000000000002','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','read','{}')$$,'23505','Design job lease has expired or been superseded','denies cross-tenant recovery');
select throws_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',2,'35000000-0000-4000-8000-000000000005','read','{}')$$,'23505','Design job lease has expired or been superseded','denies a stale job attempt');
select throws_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','load',
'{"key":{"projectKey":"another-task","sessionId":"36000000-0000-4000-8000-000000000006"}}')$$,'23505','Session workspace does not match the assigned task','denies a different task workspace');
select lives_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','checkpoint','{"sessionId":"36000000-0000-4000-8000-000000000006","files":[]}')$$,'stores a workspace checkpoint');
select is(public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','read','{}')->'checkpoint'->>'sessionId','36000000-0000-4000-8000-000000000006','restores the native session identifier');
update public.jobs set cancel_requested_at=now() where id='34000000-0000-4000-8000-000000000004';
select throws_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','read','{}')$$,'23505','Design job lease has expired or been superseded','cancelled workers cannot mutate or load session state');
update public.jobs set cancel_requested_at=null, lease_expires_at=now()-interval '1 second' where id='34000000-0000-4000-8000-000000000004';
select throws_ok($$select public.design_session_command('31000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000004',1,'35000000-0000-4000-8000-000000000005','read','{}')$$,'23505','Design job lease has expired or been superseded','expired workers cannot mutate or load session state');

insert into public.design_revisions(id,user_id,task_id,job_id,result) values
('37000000-0000-4000-8000-000000000007','31000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000003','34000000-0000-4000-8000-000000000004','{"kind":"design","specification":"Approved dashboard"}');
select throws_ok($$select public.create_design_implementation_task('31000000-0000-4000-8000-000000000001','{"key":"BUILD-1","title":"Implement","repos":[]}',
'37000000-0000-4000-8000-000000000007','38000000-0000-4000-8000-000000000008','hash')$$,'23505','Approve this design revision before creating an implementation task','requires explicit approval');
update public.tasks set state='design-review', version=1 where id='33000000-0000-4000-8000-000000000003';
select throws_ok($$select public.approve_design_revision('31000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000003','37000000-0000-4000-8000-000000000007',0)$$,'23505','Design changed; refresh before approving','rejects a stale approval');
select ok(public.approve_design_revision('31000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000003','37000000-0000-4000-8000-000000000007',1)->>'approved_at' is not null,'records the approved revision');
select lives_ok($$select public.create_design_implementation_task('31000000-0000-4000-8000-000000000001','{"key":"BUILD-1","title":"Implement","repos":[]}',
'37000000-0000-4000-8000-000000000007','38000000-0000-4000-8000-000000000008','hash')$$,'atomically creates an implementation and its snapshot');
select lives_ok($$select public.create_design_implementation_task('31000000-0000-4000-8000-000000000001','{"key":"BUILD-1","title":"Implement","repos":[]}',
'37000000-0000-4000-8000-000000000007','38000000-0000-4000-8000-000000000008','hash')$$,'replays creation without another task');
select is((select count(*) from public.tasks where user_id='31000000-0000-4000-8000-000000000001' and key='BUILD-1'),1::bigint,'keeps one implementation task');
delete from public.tasks where id='33000000-0000-4000-8000-000000000003';
select is((select snapshot->'result'->>'specification' from public.design_handoffs where user_id='31000000-0000-4000-8000-000000000001'),'Approved dashboard','source deletion preserves the frozen handoff');
select ok(not has_table_privilege('authenticated','public.design_session_entries','SELECT'),'browser roles cannot read raw transcripts');
select ok(not has_function_privilege('authenticated','public.design_session_command(uuid,uuid,integer,uuid,text,jsonb)','EXECUTE'),'browser roles cannot invoke worker persistence');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.design_sessions'::regclass,'public.design_session_entries'::regclass,'public.design_revisions'::regclass,'public.design_handoffs'::regclass)),'all design tables enable RLS');
select * from finish();
rollback;
