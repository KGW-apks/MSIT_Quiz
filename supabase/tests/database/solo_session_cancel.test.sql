-- pgTAP-Test fuer den neuen "cancelled"-Status auf solo_sessions (Abbrechen-Button).
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(4);

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'cancel-test@test.local');

insert into public.participants (id, display_name) values
  ('44444444-4444-4444-4444-444444444444', 'Cancel Test');

insert into public.questions (id, prompt, question_type, options, position) values
  ('dddddddd-0000-0000-0000-000000000001', 'Cancel-Test-Frage', 'multiple_choice', '["A", "B"]', 91101);

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';

insert into public.solo_sessions (id, participant_id, question_ids)
values (
  'eeeeeeee-0000-0000-0000-000000000001',
  '44444444-4444-4444-4444-444444444444',
  array['dddddddd-0000-0000-0000-000000000001']::uuid[]
);

-- 1: eine laufende Solo-Session laesst sich per normalem UPDATE auf die eigene
-- Zeile abbrechen (kein RPC noetig, gleiches Muster wie das Beenden).
select extensions.lives_ok(
  $$ update public.solo_sessions set status = 'cancelled' where id = 'eeeeeeee-0000-0000-0000-000000000001' $$,
  'status = cancelled wird vom Check-Constraint akzeptiert'
);

select extensions.is(
  (select status from public.solo_sessions where id = 'eeeeeeee-0000-0000-0000-000000000001'),
  'cancelled',
  'Solo-Session steht nach dem Abbrechen auf cancelled'
);

-- 2: eine abgebrochene Session zaehlt nicht mehr als "running" (Resume-Filter
-- in tryResumeSoloSession() greift, ohne Sonderfall fuer cancelled noetig).
select extensions.is(
  (select count(*)::int from public.solo_sessions where id = 'eeeeeeee-0000-0000-0000-000000000001' and status = 'running'),
  0,
  'Abgebrochene Solo-Session gilt nicht mehr als laufend'
);

-- 3: ein beliebiger anderer Statuswert bleibt weiterhin abgelehnt.
select extensions.throws_ok(
  $$ update public.solo_sessions set status = 'abandoned' where id = 'eeeeeeee-0000-0000-0000-000000000001' $$,
  '23514',
  null,
  'Ein unbekannter Statuswert wird weiterhin vom Check-Constraint abgelehnt'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
