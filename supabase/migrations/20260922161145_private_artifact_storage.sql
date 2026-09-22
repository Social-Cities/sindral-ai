-- Large non-code artifacts live in private Supabase Storage. This table keeps
-- only owner-scoped metadata; the service creates and configures the bucket via
-- the Storage API because managed Supabase projects restrict storage-schema SQL.
alter table public.task_artifacts
  add column storage_path text,
  add column byte_size integer;

update public.task_artifacts
set byte_size = octet_length(content);

alter table public.task_artifacts
  alter column byte_size set not null,
  alter column content drop not null,
  drop constraint task_artifacts_size,
  add constraint task_artifacts_byte_size check (byte_size between 0 and 1000000),
  add constraint task_artifacts_content_location check (
    (content is not null and storage_path is null and byte_size = octet_length(content))
    or
    (content is null and storage_path is not null)
  ),
  add constraint task_artifacts_storage_path_unique unique (storage_path);

-- Storage and Postgres cannot share a transaction. Record object deletion work
-- transactionally whenever artifact metadata is deleted so transient Storage
-- failures remain retryable instead of creating silent orphans.
create table public.artifact_storage_deletions (
  storage_path text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table public.artifact_storage_deletions enable row level security;
revoke all on public.artifact_storage_deletions from anon, authenticated;
grant select, delete on public.artifact_storage_deletions to service_role;

create function public.enqueue_artifact_storage_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.storage_path is not null then
    insert into public.artifact_storage_deletions (storage_path, user_id)
    values (old.storage_path, old.user_id)
    on conflict (storage_path) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.enqueue_artifact_storage_deletion() from public, anon, authenticated;
grant execute on function public.enqueue_artifact_storage_deletion() to service_role;

create trigger task_artifact_storage_delete
after delete on public.task_artifacts
for each row execute function public.enqueue_artifact_storage_deletion();
