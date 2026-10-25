begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table legacy_design_fixture as select $legacy${"id": "41000000-0000-4000-8000-000000000001", "name": "Claude Design", "entryStepId": "todo", "steps": [{"id": "todo", "type": "human"}, {"id": "design", "type": "agent", "engine": "claude", "output": "design", "model": "custom-model", "prompt": "Create or revise a real Claude Design artifact for this brief:\n{{task_description}}\n\nFeedback to address:\n{{feedback}}\n\nUse Claude Design's built-in design capability. Work on the SAME external artifact across turns. Consult the restored conversation and exported files before changing anything. If retrying an interrupted operation, reconcile the existing artifact before publishing; never blindly create another design.\nAsk focused questions in your result when requirements are unclear. Preserve the current design while explaining what input is needed.\nExport a complete preview and implementation source into the output directory. Explain the design intent, component and token choices, interactions, responsive behavior, empty/loading/error states, open questions, and implementation acceptance criteria.\nInspect reference repositories when available, but do not modify them, commit, push, or create a PR. Design source belongs only in the design workspace.\nIf Design access, login, consent, or exports are unavailable, report the specific setup problem. Never invent a URL, claim success from a screenshot you did not export, or replace Claude Design with an independently generated local page."}, {"id": "review", "type": "human"}], "edges": []}$legacy$::jsonb as workflow;
insert into auth.users(id,email) values ('41000000-0000-4000-8000-000000000000','design-upgrade@example.test');
insert into public.workflows(id,user_id,name,definition) select
  '41000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000000','Claude Design',workflow from legacy_design_fixture;
insert into public.workflows(id,user_id,name,definition) select
  '41000000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000000','My custom design',
  jsonb_set(workflow, '{steps,1,prompt}', '"Use my custom design process"'::jsonb) from legacy_design_fixture;
insert into public.tasks(id,user_id,key,title,state,pinned_workflow,version) select
  '41000000-0000-4000-8000-000000000003','41000000-0000-4000-8000-000000000000','UPGRADE-1','Active design','design-review',workflow,7 from legacy_design_fixture;
insert into public.tasks(id,user_id,key,title,state,pinned_workflow) select
  '41000000-0000-4000-8000-000000000004','41000000-0000-4000-8000-000000000000','UPGRADE-2','Approved design','done',workflow from legacy_design_fixture;
insert into public.jobs(id,user_id,task_id,kind,step_id,payload,status) select
  '41000000-0000-4000-8000-000000000005','41000000-0000-4000-8000-000000000000','41000000-0000-4000-8000-000000000003','agent','design',
  jsonb_build_object('kind','agent','step',jsonb_set(workflow->'steps'->1,'{prompt}',to_jsonb((workflow->'steps'->1->>'prompt') || E'\n\nTask contract and saved conversation'))),'queued' from legacy_design_fixture;
insert into public.jobs(id,user_id,task_id,kind,step_id,payload,status) select
  '41000000-0000-4000-8000-000000000006','41000000-0000-4000-8000-000000000000','41000000-0000-4000-8000-000000000003','agent','design',
  jsonb_build_object('kind','agent','step',workflow->'steps'->1),'claimed' from legacy_design_fixture;
insert into public.jobs(id,user_id,task_id,kind,step_id,payload,status) select
  '41000000-0000-4000-8000-000000000008','41000000-0000-4000-8000-000000000000','41000000-0000-4000-8000-000000000004','agent','design',
  jsonb_build_object('kind','agent','step',workflow->'steps'->1),'completed' from legacy_design_fixture;
insert into public.design_revisions(id,user_id,task_id,job_id,result,approved_at) values
  ('41000000-0000-4000-8000-000000000007','41000000-0000-4000-8000-000000000000','41000000-0000-4000-8000-000000000004','41000000-0000-4000-8000-000000000008','{"kind":"design","designUrl":"https://claude.ai/design/existing"}',now());

do $replay$
declare
  statement text;
  migration_statements text[];
begin
  select statements into strict migration_statements from supabase_migrations.schema_migrations where version = '20261025202507';
  foreach statement in array migration_statements loop execute statement; end loop;
end;
$replay$;

select is((select name from public.workflows where id='41000000-0000-4000-8000-000000000001'),'App Design','renames the shipped workflow');
select is((select definition->>'id' from public.workflows where id='41000000-0000-4000-8000-000000000001'),'41000000-0000-4000-8000-000000000001','preserves the workflow identity');
select is((select definition->'steps'->1->>'model' from public.workflows where id='41000000-0000-4000-8000-000000000001'),'custom-model','preserves the selected model');
select ok((select starts_with(definition->'steps'->1->>'prompt','Design and prototype an app') from public.workflows where id='41000000-0000-4000-8000-000000000001'),'uses coding tools for preview generation');
select is((select definition->'steps'->0->>'id' from public.workflows where id='41000000-0000-4000-8000-000000000001'),'todo','preserves step ordering');
select is((select definition->'steps'->1->>'prompt' from public.workflows where id='41000000-0000-4000-8000-000000000002'),'Use my custom design process','preserves customized prompts');
select is((select pinned_workflow->>'name' from public.tasks where id='41000000-0000-4000-8000-000000000003'),'App Design','upgrades active pinned workflows');
select is((select version from public.tasks where id='41000000-0000-4000-8000-000000000003'),8::bigint,'fences concurrent task mutations');
select is((select pinned_workflow from public.tasks where id='41000000-0000-4000-8000-000000000004'),(select workflow from legacy_design_fixture),'preserves completed task history');
select ok((select starts_with(payload->'step'->>'prompt','Design and prototype an app') and right(payload->'step'->>'prompt',length(E'\n\nTask contract and saved conversation')) = E'\n\nTask contract and saved conversation' from public.jobs where id='41000000-0000-4000-8000-000000000005'),'upgrades queued prompts and retains appended context');
select ok((select starts_with(payload->'step'->>'prompt','Design and prototype an app') and status = 'claimed' from public.jobs where id='41000000-0000-4000-8000-000000000006'),'upgrades leased work without changing its lifecycle');
select is((select payload->'step'->>'prompt' from public.jobs where id='41000000-0000-4000-8000-000000000008'),(select workflow->'steps'->1->>'prompt' from legacy_design_fixture),'preserves completed job history');
select is((select result->>'designUrl' from public.design_revisions where id='41000000-0000-4000-8000-000000000007'),'https://claude.ai/design/existing','preserves earlier approved designs');

-- Running the data upgrade again cannot overwrite customization or bump versions.
do $replay$
declare
  statement text;
  migration_statements text[];
begin
  select statements into strict migration_statements from supabase_migrations.schema_migrations where version = '20261025202507';
  foreach statement in array migration_statements loop execute statement; end loop;
end;
$replay$;
select is((select version from public.tasks where id='41000000-0000-4000-8000-000000000003'),8::bigint,'the upgrade is idempotent');
select * from finish();
rollback;
