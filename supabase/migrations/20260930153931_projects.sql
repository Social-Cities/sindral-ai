-- First-class project grouping for repository-backed work.
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);
create index projects_user_updated_idx on public.projects(user_id, updated_at desc);
create trigger projects_updated_at before update on public.projects for each row execute function public.set_updated_at();

create table public.project_repositories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  repository text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, repository)
);
create index project_repositories_user_project_idx on public.project_repositories(user_id, project_id);
create index project_repositories_repository_idx on public.project_repositories(user_id, repository);
create trigger project_repositories_updated_at before update on public.project_repositories for each row execute function public.set_updated_at();

alter table public.tasks add column project_id uuid references public.projects(id) on delete set null;
create index tasks_user_project_idx on public.tasks(user_id, project_id, updated_at desc) where project_id is not null;

alter table public.projects enable row level security;
alter table public.project_repositories enable row level security;

create policy projects_select on public.projects for select to authenticated using (user_id = (select auth.uid()));
create policy project_repositories_select on public.project_repositories for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.projects, public.project_repositories from anon;
