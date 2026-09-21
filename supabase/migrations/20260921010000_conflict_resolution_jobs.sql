-- Permit dedicated, worker-owned conflict-resolution jobs. Existing rows and
-- clients remain compatible; this only expands the allowed job kind values.
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
  add constraint jobs_kind_check
  check (kind in ('agent', 'rebase-stack', 'resolve-rebase-conflict', 'merge-pull-requests'));
