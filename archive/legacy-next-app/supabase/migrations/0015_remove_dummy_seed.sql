-- Start fresh: stop bootstrapping new sign-ups with dummy projects/teammates/
-- tasks/activity, and clean up the deterministic seed rows that previous
-- versions of bootstrap_workspace_for_user inserted.
--
-- The bootstrap function still creates the user's personal organization,
-- their org_members row, and their own "You" humans row — those are
-- load-bearing for the rest of the app.

-- ---------------------------------------------------------------------------
-- 1. Replace bootstrap_workspace_for_user with the minimal version.
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_workspace_for_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid_short text := substr(p_user::text, 1, 8);
  me_id text := p_user::text;
  email text;
  display_name text;
  v_org_id uuid;
  v_org_name text;
  v_org_slug text;
begin
  if exists (select 1 from humans where id = me_id) then
    return;
  end if;

  select u.email into email from auth.users u where u.id = p_user;
  display_name := coalesce(split_part(email, '@', 1), 'You');

  v_org_name := display_name || '''s workspace';
  v_org_slug := 'personal-' || uid_short;

  insert into organizations (name, slug, created_by)
    values (v_org_name, v_org_slug, p_user)
    on conflict (slug) do update set name = excluded.name
    returning id into v_org_id;

  insert into org_members (org_id, user_id, role)
    values (v_org_id, p_user, 'owner')
    on conflict (org_id, user_id) do nothing;

  insert into humans (id, name, hue, short, owner_id, org_id) values
    (me_id, display_name, 30, upper(substr(display_name, 1, 1)), p_user, v_org_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Delete deterministic seed rows left behind by older bootstrap runs.
--    Matching by id pattern keeps any user-created rows (which use slug- or
--    uuid-shaped ids) safe. Order respects foreign keys: activity → tasks
--    (cascades to task_plans/messages/files) → teammates → humans → projects.
-- ---------------------------------------------------------------------------

delete from activity  where id ~ '^f[1-6]-[0-9a-f]{8}$';

delete from tasks     where id ~ '^AGT-1[34][0-9]-[0-9a-f]{8}$';

delete from teammates where id ~ '^a[1-5]-[0-9a-f]{8}$';

delete from humans    where id ~ '^h[23]-[0-9a-f]{8}$';

delete from projects  where id ~ '^p[1-3]-[0-9a-f]{8}$';
