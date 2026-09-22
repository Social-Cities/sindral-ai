begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

create temporary table webhook_claim as
select public.begin_webhook_delivery('delivery-1', 'issue_comment', repeat('a', 64)) as value;

select is((select value->>'state' from webhook_claim), 'acquired', 'first delivery acquires its processing lease');
select is(
  public.begin_webhook_delivery('delivery-1', 'issue_comment', repeat('a', 64))->>'state',
  'busy',
  'concurrent redelivery cannot run effects twice'
);
select throws_ok(
  $$select public.begin_webhook_delivery('delivery-1', 'issue_comment', repeat('b', 64))$$,
  '22023',
  'GitHub delivery ID was reused with different content',
  'delivery identifiers cannot be reused for another payload'
);

select lives_ok(
  format(
    'select public.finalize_webhook_delivery(%L, %L, %L::uuid, %L::jsonb)',
    'delivery-1',
    repeat('a', 64),
    (select value->>'token' from webhook_claim),
    '{"statusCode":200,"body":{"ok":true}}'
  ),
  'lease owner can finalize a delivery response'
);
select is(
  public.begin_webhook_delivery('delivery-1', 'issue_comment', repeat('a', 64))->'response'->>'statusCode',
  '200',
  'redelivery replays the stored response'
);

create temporary table abandoned_claim as
select public.begin_webhook_delivery('delivery-2', 'pull_request', repeat('c', 64)) as value;
select lives_ok(
  format(
    'select public.abandon_webhook_delivery(%L, %L, %L::uuid)',
    'delivery-2',
    repeat('c', 64),
    (select value->>'token' from abandoned_claim)
  ),
  'failed processing can abandon its lease'
);
select is(
  public.begin_webhook_delivery('delivery-2', 'pull_request', repeat('c', 64))->>'state',
  'acquired',
  'an abandoned delivery can be retried'
);

select ok(not has_table_privilege('authenticated', 'public.webhook_deliveries', 'SELECT'), 'browser role cannot read delivery records');
select ok(not has_function_privilege('authenticated', 'public.begin_webhook_delivery(text,text,text)', 'EXECUTE'), 'browser role cannot claim deliveries');
select ok(has_function_privilege('service_role', 'public.begin_webhook_delivery(text,text,text)', 'EXECUTE'), 'service role can claim deliveries');

select * from finish();
rollback;
