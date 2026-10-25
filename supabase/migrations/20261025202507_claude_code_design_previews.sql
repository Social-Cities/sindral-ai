-- Upgrade only the shipped Design prompt. Preserve customized steps, workflow IDs,
-- model choices, conversation history, approved revisions, and frozen handoffs.
-- Temporary helpers never become part of the exposed database API.
create function pg_temp.upgrade_design_step(step jsonb) returns jsonb
language plpgsql set search_path = '' as $function$
declare
  old_prompt constant text := $old$Create or revise a real Claude Design artifact for this brief:
{{task_description}}

Feedback to address:
{{feedback}}

Use Claude Design's built-in design capability. Work on the SAME external artifact across turns. Consult the restored conversation and exported files before changing anything. If retrying an interrupted operation, reconcile the existing artifact before publishing; never blindly create another design.
Ask focused questions in your result when requirements are unclear. Preserve the current design while explaining what input is needed.
Export a complete preview and implementation source into the output directory. Explain the design intent, component and token choices, interactions, responsive behavior, empty/loading/error states, open questions, and implementation acceptance criteria.
Inspect reference repositories when available, but do not modify them, commit, push, or create a PR. Design source belongs only in the design workspace.
If Design access, login, consent, or exports are unavailable, report the specific setup problem. Never invent a URL, claim success from a screenshot you did not export, or replace Claude Design with an independently generated local page.$old$;
  new_prompt constant text := $new$Design and prototype an app for this brief:
{{task_description}}

Feedback to address:
{{feedback}}

Use your file editing and coding tools to create a polished, interactive UI prototype directly in the design workspace. Sindral renders the saved preview files. Do not invoke /design or require Claude artifact publishing, Design templates, or an external editor.
Continue the SAME design across turns. Consult the restored conversation, specification, and workspace files before changing anything. If retrying an interrupted operation, reconcile the existing files before repeating work. Earlier instructions in the conversation requiring a remote Design artifact are obsolete.
Ask focused questions in your result when requirements are unclear. Preserve the current design while explaining what input is needed.
Write a complete, self-contained HTML preview with inline CSS and JavaScript for each screen into the output directory, alongside any implementation source and assets. Previews must work offline without package installation, external fonts, CDNs, network calls, a dev server, or a build step. Include realistic sample content, accessible controls, responsive layouts, and working navigation or interaction states. Reuse reference design tokens and components when available.
Explain the design intent, component and token choices, interactions, responsive behavior, empty/loading/error states, open questions, and implementation acceptance criteria.
Inspect reference repositories when available, but do not modify them, commit, push, or create a PR. Design source belongs only in the design workspace.
Return designUrl: null. Never invent a hosted URL or claim success without writing the preview files. Report authentication or tool failures clearly.$new$;
  prompt text := step->>'prompt';
begin
  if step->>'output' = 'design' and coalesce(step->>'engine', 'claude') = 'claude'
    and (prompt = old_prompt or starts_with(prompt, old_prompt || E'\n\n')) then
    return jsonb_set(step, '{prompt}', to_jsonb(new_prompt || substr(prompt, length(old_prompt) + 1)));
  end if;
  return step;
end;
$function$;

create function pg_temp.upgrade_design_workflow(workflow jsonb) returns jsonb
language plpgsql set search_path = '' as $function$
declare
  steps jsonb;
begin
  if jsonb_typeof(workflow->'steps') is distinct from 'array' then return workflow; end if;
  select coalesce(jsonb_agg(pg_temp.upgrade_design_step(value) order by ordinality), '[]'::jsonb)
    into steps from jsonb_array_elements(workflow->'steps') with ordinality;
  if steps = workflow->'steps' then return workflow; end if;
  workflow := jsonb_set(workflow, '{steps}', steps);
  if workflow->>'name' = 'Claude Design' then
    workflow := jsonb_set(workflow, '{name}', '"App Design"'::jsonb);
  end if;
  return workflow;
end;
$function$;

update public.workflows
set definition = pg_temp.upgrade_design_workflow(definition),
    name = pg_temp.upgrade_design_workflow(definition)->>'name'
where definition is distinct from pg_temp.upgrade_design_workflow(definition);

-- In-flight tasks keep their graph and identity while gaining the new generation
-- instructions. Completed tasks retain their historical workflow snapshot.
update public.tasks
set pinned_workflow = pg_temp.upgrade_design_workflow(pinned_workflow), version = version + 1
where state not in ('done', 'wont-do')
  and pinned_workflow is distinct from pg_temp.upgrade_design_workflow(pinned_workflow);

-- Preserve appended context and lease fields. Include leased jobs so work requeued
-- after the protocol upgrade also uses the new prompt. Historical jobs stay intact.
update public.jobs
set payload = jsonb_set(payload, '{step}', pg_temp.upgrade_design_step(payload->'step'))
where kind = 'agent' and status in ('queued', 'claimed', 'running')
  and payload->'step' is distinct from pg_temp.upgrade_design_step(payload->'step');

drop function pg_temp.upgrade_design_workflow(jsonb);
drop function pg_temp.upgrade_design_step(jsonb);

create or replace function public.sindral_schema_version() returns text
language sql stable security invoker set search_path = ''
as $$ select '20261025202507'::text $$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
