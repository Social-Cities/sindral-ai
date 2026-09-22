begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email)
values ('51000000-0000-4000-8000-000000000051', 'artifact-owner@example.test');
insert into public.tasks (id, user_id, key, title, state)
values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'ART-1', 'Artifact task', 'implement');

select has_column('public', 'task_artifacts', 'storage_path', 'artifact metadata includes a private storage path');
select has_column('public', 'task_artifacts', 'byte_size', 'artifact metadata includes byte size');

select lives_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'small.md', 'text/markdown', '# Small', 7)$$,
  'legacy and small artifacts remain inline'
);
select lives_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, storage_path, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'large.md', 'text/markdown', null, 'owner/task/hash', 70000)$$,
  'large artifact metadata can point at private storage'
);
select throws_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, storage_path, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'both.md', 'text/markdown', 'content', 'owner/task/both', 7)$$,
  '23514',
  'new row for relation "task_artifacts" violates check constraint "task_artifacts_content_location"',
  'an artifact cannot be both inline and stored'
);
select throws_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, storage_path, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'neither.md', 'text/markdown', null, null, 7)$$,
  '23514',
  'new row for relation "task_artifacts" violates check constraint "task_artifacts_content_location"',
  'an artifact must have exactly one content location'
);
select throws_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, storage_path, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'too-large.md', 'text/markdown', null, 'owner/task/too-large', 1000001)$$,
  '23514',
  'new row for relation "task_artifacts" violates check constraint "task_artifacts_byte_size"',
  'artifact metadata enforces the byte limit'
);
select throws_ok(
  $$insert into public.task_artifacts (task_id, user_id, name, content_type, content, storage_path, byte_size)
    values ('52000000-0000-4000-8000-000000000052', '51000000-0000-4000-8000-000000000051', 'duplicate.md', 'text/markdown', null, 'owner/task/hash', 70000)$$,
  '23505',
  'duplicate key value violates unique constraint "task_artifacts_storage_path_unique"',
  'one storage object maps to one artifact row'
);

delete from public.task_artifacts where storage_path = 'owner/task/hash';
select is(
  (select count(*) from public.artifact_storage_deletions where storage_path = 'owner/task/hash'),
  1::bigint,
  'deleting stored metadata durably queues object cleanup'
);

select * from finish();
rollback;
