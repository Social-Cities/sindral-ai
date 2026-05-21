-- Projects can pin which GitHub App installation should be used for repo
-- operations (clone, push, PR open/comment/merge). Nullable so existing
-- projects keep working with the GH_TOKEN env-var fallback until the user
-- connects their account. set null on delete so removing the installation
-- doesn't cascade into the project row — the project just falls back to
-- the dev-only env fallback.

alter table projects
  add column if not exists github_installation_id text
    references github_installations(id) on delete set null;

create index if not exists projects_github_installation_idx
  on projects(github_installation_id);
