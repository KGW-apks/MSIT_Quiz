-- pgTAP-Tests fuer den Presenter-Schutz: quiz_sessions darf nicht mehr direkt
-- von jedem authenticated Client veraendert werden, nur noch ueber die
-- passwortgeschuetzte Funktion presenter_control().
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(7);

-- quiz_sessions hat bereits genau eine Zeile (idempotenter Seed aus einer
-- frueheren Migration, status='lobby'), hier absichtlich keine eigene Zeile
-- anlegen (keine INSERT-Policy, und eine zweite Zeile wuerde die folgenden
-- Scalar-Subqueries auf quiz_sessions brechen).

-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164 (siehe
-- Migration import_fragenkatalog), Test-Fixtures duerfen dort nicht kollidieren.
insert into public.questions (id, prompt, question_type, options, position) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Testfrage', 'multiple_choice', '["A", "B"]', 90001);

insert into public.presenter_secret (id, secret_hash)
values (true, extensions.crypt('test-secret-123', extensions.gen_salt('bf')));

-- 1: Direktes UPDATE auf quiz_sessions ist fuer authenticated jetzt komplett
-- gesperrt (kein Ersatz-Policy nach dem Entfernen von quiz_sessions_update_all).
-- RLS ohne passende USING-Policy wirft dabei keinen Fehler, sondern filtert
-- die Zeile fuer das UPDATE einfach komplett heraus (0 betroffene Zeilen) --
-- deshalb hier auf unveraendertem Status pruefen statt auf eine Exception.

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

update public.quiz_sessions set status = 'open';

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'lobby',
  'Direktes UPDATE auf quiz_sessions hat keine Wirkung (RLS filtert die Zeile heraus, kein Presenter-Bypass mehr fuer normale Clients)'
);

-- 2: Falsches Presenter-Passwort wird abgelehnt.

select extensions.throws_ok(
  $$ select public.presenter_control('open', 'bbbbbbbb-0000-0000-0000-000000000001', 'falsches-passwort') $$,
  '28000',
  'Ungueltiges Presenter-Passwort',
  'presenter_control() lehnt ein falsches Passwort ab'
);

-- 3: Richtiges Passwort oeffnet die Frage.

select public.presenter_control('open', 'bbbbbbbb-0000-0000-0000-000000000001', 'test-secret-123');

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'open',
  'presenter_control(open, richtiges Passwort) setzt status auf open'
);

-- 4: Richtiges Passwort schliesst die Frage.

select public.presenter_control('close', null, 'test-secret-123');

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'closed',
  'presenter_control(close, richtiges Passwort) setzt status auf closed'
);

-- 5: Richtiges Passwort beendet das Quiz.

select public.presenter_control('finish', null, 'test-secret-123');

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'finished',
  'presenter_control(finish, richtiges Passwort) setzt status auf finished'
);

reset role;
reset request.jwt.claims;

-- 6+7: presenter_control('close', ...) stoesst rescore_estimation_responses()
-- fuer die gerade geschlossene Schaetzfrage automatisch mit an (Migration
-- estimation_closest_wins) -- hier ueber die echte Rpc getestet, nicht direkt
-- ueber die Funktion (das deckt scoring.test.sql bereits isoliert ab).
insert into public.questions (id, prompt, question_type, options, position) values
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Schaetzfrage fuer den Close-Test', 'estimation', null, 90002);

insert into public.question_answers (question_id, correct_value, points) values
  ('bbbbbbbb-0000-0000-0000-000000000002', 50, 100);

insert into auth.users (id, email) values
  ('bbbbbbbb-1111-0000-0000-000000000001', 'close-test-1@test.local'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'close-test-2@test.local');
insert into public.participants (id, display_name) values
  ('bbbbbbbb-1111-0000-0000-000000000001', 'Close Test Naeher'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'Close Test Weiter');

-- Test 5 hat das Quiz bereits auf 'finished' gesetzt; presenter_control('open')
-- lehnt das ohne Reset ab ("Quiz bereits beendet"). Direktes Zuruecksetzen
-- statt eines Umwegs ueber start_round/cancel_round, die hier nichts weiter
-- pruefen sollen.
update public.quiz_sessions set status = 'lobby';

select public.presenter_control('open', 'bbbbbbbb-0000-0000-0000-000000000002', 'test-secret-123');

set local role authenticated;
set local request.jwt.claims to '{"sub":"bbbbbbbb-1111-0000-0000-000000000001","role":"authenticated"}';
insert into public.responses (participant_id, question_id, guess_value)
values ('bbbbbbbb-1111-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 50);
reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"bbbbbbbb-1111-0000-0000-000000000002","role":"authenticated"}';
insert into public.responses (participant_id, question_id, guess_value)
values ('bbbbbbbb-1111-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 10);
reset role;
reset request.jwt.claims;

select public.presenter_control('close', null, 'test-secret-123');

select extensions.is(
  (select points_awarded from public.responses where participant_id = 'bbbbbbbb-1111-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  100,
  'presenter_control(close) stoesst das Schaetzfragen-Rescoring an: der naeher dran ist gewinnt'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = 'bbbbbbbb-1111-0000-0000-000000000002' and question_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  0,
  'presenter_control(close) stoesst das Schaetzfragen-Rescoring an: der weiter weg ist bekommt 0'
);

select * from extensions.finish();
rollback;
