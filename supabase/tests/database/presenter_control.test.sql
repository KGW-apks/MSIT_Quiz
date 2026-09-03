-- pgTAP-Tests fuer den Presenter-Schutz: quiz_sessions darf nicht mehr direkt
-- von jedem authenticated Client veraendert werden, nur noch ueber die
-- passwortgeschuetzte Funktion presenter_control().
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(5);

-- quiz_sessions hat bereits genau eine Zeile (idempotenter Seed aus einer
-- frueheren Migration, status='lobby'), hier absichtlich keine eigene Zeile
-- anlegen (keine INSERT-Policy, und eine zweite Zeile wuerde die folgenden
-- Scalar-Subqueries auf quiz_sessions brechen).

insert into public.questions (id, prompt, question_type, options, position) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Testfrage', 'multiple_choice', '["A", "B"]', 1);

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

select * from extensions.finish();
rollback;
