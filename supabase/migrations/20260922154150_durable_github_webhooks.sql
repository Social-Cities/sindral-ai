create table public.webhook_deliveries (
  delivery_id text primary key,
  event_name text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  processing_token uuid not null,
  processing_started_at timestamptz not null default now(),
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.webhook_deliveries to service_role;

create function public.begin_webhook_delivery(p_delivery_id text, p_event_name text, p_payload_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.webhook_deliveries%rowtype;
  v_token uuid;
begin
  if p_delivery_id !~ '^[0-9A-Za-z-]{1,100}$' or p_event_name !~ '^[a-z_]{1,100}$' or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid GitHub delivery metadata';
  end if;
  v_token := gen_random_uuid();
  insert into public.webhook_deliveries (delivery_id, event_name, payload_hash, processing_token)
  values (p_delivery_id, p_event_name, p_payload_hash, v_token)
  on conflict (delivery_id) do nothing;

  select * into v_delivery from public.webhook_deliveries where delivery_id = p_delivery_id for update;
  if v_delivery.event_name <> p_event_name or v_delivery.payload_hash <> p_payload_hash then
    raise exception using errcode = '22023', message = 'GitHub delivery ID was reused with different content';
  end if;
  if v_delivery.response is not null then
    return jsonb_build_object('state', 'replay', 'token', null, 'response', v_delivery.response);
  end if;
  if v_delivery.processing_token <> v_token and v_delivery.processing_started_at > now() - interval '30 seconds' then
    return jsonb_build_object('state', 'busy', 'token', null, 'response', null);
  end if;
  if v_delivery.processing_token <> v_token then
    update public.webhook_deliveries
    set processing_token = v_token, processing_started_at = now()
    where delivery_id = p_delivery_id;
  end if;
  return jsonb_build_object('state', 'acquired', 'token', v_token, 'response', null);
end
$$;

create function public.finalize_webhook_delivery(p_delivery_id text, p_payload_hash text, p_token uuid, p_response jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.webhook_deliveries
  set response = p_response, completed_at = now()
  where delivery_id = p_delivery_id and payload_hash = p_payload_hash and processing_token = p_token and response is null;
  if not found then raise exception using errcode = '40001', message = 'GitHub delivery lease was superseded'; end if;
end
$$;

create function public.abandon_webhook_delivery(p_delivery_id text, p_payload_hash text, p_token uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.webhook_deliveries
  where delivery_id = p_delivery_id and payload_hash = p_payload_hash and processing_token = p_token and response is null;
$$;

revoke all on function public.begin_webhook_delivery(text, text, text) from public, anon, authenticated;
revoke all on function public.finalize_webhook_delivery(text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.abandon_webhook_delivery(text, text, uuid) from public, anon, authenticated;
grant execute on function public.begin_webhook_delivery(text, text, text) to service_role;
grant execute on function public.finalize_webhook_delivery(text, text, uuid, jsonb) to service_role;
grant execute on function public.abandon_webhook_delivery(text, text, uuid) to service_role;
