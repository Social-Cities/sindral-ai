-- Expand the legacy single-PR task representation into per-repository records.
-- Legacy task columns remain during the compatibility window.
create table public.task_repositories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  repository text not null,
  branch text not null,
  base_branch text,
  merge_method text not null default 'squash' check (merge_method in ('squash', 'merge', 'rebase')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, repository)
);
create index task_repositories_user_task_idx on public.task_repositories(user_id, task_id);
create trigger task_repositories_updated_at before update on public.task_repositories for each row execute function public.set_updated_at();

create table public.pull_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  task_repository_id uuid not null references public.task_repositories(id) on delete cascade,
  repository text not null,
  url text not null unique,
  number integer not null check (number > 0),
  branch text not null,
  base_branch text not null,
  head_sha text check (head_sha is null or head_sha ~ '^[0-9a-fA-F]{40}$'),
  status text not null default 'open' check (status in ('open', 'merged', 'closed')),
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, repository)
);
create index pull_requests_user_task_idx on public.pull_requests(user_id, task_id);
create index pull_requests_url_idx on public.pull_requests(url);
create trigger pull_requests_updated_at before update on public.pull_requests for each row execute function public.set_updated_at();

-- Backfill one repository/PR from the legacy columns. Multi-repository tasks
-- could not previously persist more than one PR, so only known state is copied.
insert into public.task_repositories (user_id, task_id, repository, branch, base_branch)
select t.user_id, t.id, repo, coalesce(t.branch, 'sindral/' || lower(t.key)), t.base_branch
from public.tasks t
cross join lateral unnest(t.repos) with ordinality as selected(repo, position)
on conflict (task_id, repository) do nothing;

insert into public.pull_requests (user_id, task_id, task_repository_id, repository, url, number, branch, base_branch)
select t.user_id,
       t.id,
       tr.id,
       tr.repository,
       t.pr_url,
       (regexp_match(t.pr_url, '/pull/([0-9]+)'))[1]::integer,
       coalesce(t.branch, tr.branch),
       coalesce(t.base_branch, tr.base_branch, 'main')
from public.tasks t
join lateral (
  select record.* from public.task_repositories record
  where record.task_id = t.id
  order by record.created_at, record.id
  limit 1
) tr on true
where t.pr_url ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+$'
on conflict (task_id, repository) do nothing;

alter table public.task_repositories enable row level security;
alter table public.pull_requests enable row level security;
create policy task_repositories_select on public.task_repositories for select to authenticated using (user_id = (select auth.uid()));
create policy pull_requests_select on public.pull_requests for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.task_repositories, public.pull_requests from anon;
