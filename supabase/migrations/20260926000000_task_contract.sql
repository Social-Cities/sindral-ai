-- Durable task contracts let every workflow step use the same definition of done.
alter table public.tasks
  add column outcome text not null default '',
  add column acceptance_criteria text not null default '';

-- Match the application's Markdown parser during rollout: ATX headings at any
-- level and emphasized headings are accepted. Plan content wins; description
-- is only a fallback, so unrelated ticket prose is never appended to a plan.
create function pg_temp.extract_task_contract_section(markdown text, wanted text)
returns text
language plpgsql
as $$
declare
  line text;
  heading text[];
  normalized text;
  active boolean := false;
  active_level integer := 0;
  content text := '';
begin
  if markdown is null or markdown = '' then return null; end if;
  foreach line in array regexp_split_to_array(markdown, E'\r?\n') loop
    heading := regexp_match(line, '^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$');
    if heading is not null then
      normalized := lower(regexp_replace(btrim(heading[2]), '[:#]+$', ''));
      if (wanted = 'outcome' and normalized in ('outcome', 'desired outcome'))
        or (wanted = 'acceptance' and normalized in ('acceptance criteria', 'acceptance criterion')) then
        active := true;
        active_level := length(heading[1]);
      elsif active and length(heading[1]) <= active_level then
        exit;
      end if;
      continue;
    end if;

    heading := regexp_match(line, '^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$');
    if heading is not null then
      normalized := lower(regexp_replace(btrim(heading[1]), '[:#]+$', ''));
      if (wanted = 'outcome' and normalized in ('outcome', 'desired outcome'))
        or (wanted = 'acceptance' and normalized in ('acceptance criteria', 'acceptance criterion')) then
        active := true;
        active_level := 1;
      elsif active then
        exit;
      end if;
      continue;
    end if;

    if active then content := content || line || E'\n'; end if;
  end loop;
  return nullif(btrim(content), '');
end
$$;

update public.tasks
set outcome = coalesce(
  pg_temp.extract_task_contract_section(plan, 'outcome'),
  pg_temp.extract_task_contract_section(description, 'outcome'),
  ''
),
acceptance_criteria = coalesce(
  pg_temp.extract_task_contract_section(plan, 'acceptance'),
  pg_temp.extract_task_contract_section(description, 'acceptance'),
  ''
);

create or replace function public.sindral_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select '20260926000000'::text $$;

revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
