-- Rebrand from Agatha Teams to Sindral AI.
-- Migrations 0002 and 0013 seeded demo projects with repo='agatha/<name>'.
-- This migration updates those seeded rows in-place so existing demo data
-- reflects the new brand. Only touches rows that still match the old values
-- so re-running on databases without the demo data is a no-op.

update projects
set repo = 'sindral/' || split_part(repo, '/', 2)
where repo like 'agatha/%';
