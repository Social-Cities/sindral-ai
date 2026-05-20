-- Per-user GitHub App installations. Records the installation_id GitHub
-- assigned when a user installed our App against their personal account or
-- an org they admin. Workers mint short-lived tokens from these rows via
-- the backend's /internal/github/installations/:installationId/token
-- endpoint instead of sharing a single PAT.

create table if not exists github_installations (
  id text primary key,                 -- our id, e.g. gh-inst-<short>
  owner_id uuid not null references auth.users(id) on delete cascade,
  installation_id bigint not null,     -- GitHub's installation_id
  account_login text not null,         -- "octocat" or "my-org"
  account_type text not null check (account_type in ('User','Organization')),
  account_id bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, installation_id)
);

create index if not exists github_installations_owner_idx
  on github_installations(owner_id);

alter table github_installations enable row level security;

create policy "owner read github_installations"
  on github_installations for select
  using (auth.uid() = owner_id);

create policy "owner write github_installations"
  on github_installations for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
