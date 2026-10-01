-- Store APNs device tokens registered by authenticated clients through the server.

create table public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios')),
  environment text not null check (environment in ('sandbox', 'production')),
  token text not null check (token ~ '^[0-9a-fA-F]{64,512}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  unique (platform, environment, token)
);
create index push_devices_user_idx on public.push_devices(user_id, enabled, last_registered_at desc);
create trigger push_devices_updated_at before update on public.push_devices for each row execute function public.set_updated_at();

alter table public.push_devices enable row level security;

-- Clients register devices through the server API. Service role bypasses RLS.

create or replace function public.sindral_schema_version()
returns text language sql stable as $$
  select '20261001150000';
$$;
revoke all on function public.sindral_schema_version() from public, anon, authenticated;
grant execute on function public.sindral_schema_version() to service_role;
