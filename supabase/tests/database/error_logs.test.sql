-- pgTAP-Tests fuer error_logs: eigene Fehler melden dürfen, fremde user_id nicht
-- vortaeuschen koennen, und nur Nicht-Teilnehmer (Presenter/Dashboard) duerfen lesen.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(4);

-- Ein echter Teilnehmer (mit participants-Zeile) und eine Presenter/Dashboard-Session
-- (gleiche Anonymous-Auth, aber bewusst keine participants-Zeile, siehe Projektmuster).
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'error-log-test-participant@test.local'),
  ('dddddddd-0000-0000-0000-000000000002', 'error-log-test-presenter@test.local');

insert into public.participants (id, display_name) values
  ('dddddddd-0000-0000-0000-000000000001', 'Error Log Test Teilnehmer');

set local role authenticated;
set local request.jwt.claims to '{"sub":"dddddddd-0000-0000-0000-000000000001","role":"authenticated"}';

-- 1: Teilnehmer darf einen eigenen Fehler melden (user_id kommt per Default aus auth.uid()).
select extensions.lives_ok(
  $$ insert into public.error_logs (source, message) values ('participant', 'Testfehler eigene Session') $$,
  'Teilnehmer darf einen eigenen Fehler in error_logs eintragen'
);

-- 2: Teilnehmer darf keine fremde user_id vortaeuschen.
select extensions.throws_ok(
  $$ insert into public.error_logs (source, message, user_id) values ('participant', 'Spoofing-Versuch', 'dddddddd-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'Teilnehmer kann keine fremde user_id vortaeuschen (RLS-Verletzung)'
);

-- 3: Teilnehmer selbst darf error_logs nicht lesen (nur Presenter/Dashboard).
select extensions.is(
  (select count(*)::int from public.error_logs),
  0,
  'Teilnehmer sieht keine error_logs-Zeilen (RLS filtert alles heraus)'
);

reset role;
reset request.jwt.claims;

-- 4: Presenter/Dashboard-Session (keine participants-Zeile) sieht den zuvor eingetragenen Fehler.
set local role authenticated;
set local request.jwt.claims to '{"sub":"dddddddd-0000-0000-0000-000000000002","role":"authenticated"}';

select extensions.is(
  (select count(*)::int from public.error_logs),
  1,
  'Presenter/Dashboard-Session (keine participants-Zeile) sieht den geloggten Fehler'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
