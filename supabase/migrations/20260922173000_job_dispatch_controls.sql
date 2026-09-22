-- Let the server exclude side-effecting job kinds while atomically claiming
-- other work. This is used by the automatic-merge kill switch.
drop function if exists public.claim_jobs(uuid, uuid, integer);

create function public.claim_jobs(
  p_user_id uuid,
  p_worker_id uuid,
  p_max integer,
  p_allowed_kinds text[] default null
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with eligible as (
    select j.id, j.task_id, j.created_at,
           row_number() over (partition by j.task_id order by j.created_at, j.id) as rn
    from public.jobs j
    where j.user_id = p_user_id
      and j.status = 'queued'
      and (p_allowed_kinds is null or j.kind = any(p_allowed_kinds))
      and not exists (
        select 1 from public.jobs o
        where o.task_id = j.task_id and o.status in ('claimed', 'running', 'applying')
      )
  ), picked as (
    select e.id from eligible e
    where e.rn = 1
    order by e.created_at, e.id
    limit greatest(1, least(coalesce(p_max, 1), 10))
  ), locked as (
    select j.id from public.jobs j
    where j.id in (select id from picked) and j.status = 'queued'
    order by j.id
    for update skip locked
  )
  update public.jobs j
  set status = 'claimed',
      worker_id = p_worker_id,
      claimed_at = now(),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '90 seconds'
  from locked l
  where j.id = l.id
  returning j.*;
end
$$;

revoke all on function public.claim_jobs(uuid, uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_jobs(uuid, uuid, integer, text[]) to service_role;
