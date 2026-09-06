-- pgTAP-Tests fuers Rundenkonzept: start_round waehlt bevorzugt noch nie
-- gestellte Fragen (times_asked), open zaehlt times_asked hoch und ist auf die
-- aktuelle Runde beschraenkt, cancel_round setzt sauber zurueck.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(17);

-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164 (siehe
-- Migration import_fragenkatalog), Test-Fixtures duerfen dort nicht kollidieren.
-- times_asked = -1 fuer die beiden "nie dran"-Fixtures: der echte Katalog liegt
-- permanent mit times_asked=0 in derselben Tabelle, -1 sortiert garantiert davor,
-- damit die Auswahl unten deterministisch bleibt statt vom Katalogstand abzuhaengen.
insert into public.questions (id, prompt, question_type, options, position, times_asked) values
  ('cccccccc-0000-0000-0000-000000000001', 'Schon oft dran', 'multiple_choice', '["A", "B"]', 90001, 5),
  ('cccccccc-0000-0000-0000-000000000002', 'Noch nie dran A', 'multiple_choice', '["A", "B"]', 90002, -1),
  ('cccccccc-0000-0000-0000-000000000003', 'Noch nie dran B', 'multiple_choice', '["A", "B"]', 90003, -1);

insert into public.presenter_secret (id, secret_hash)
values (true, extensions.crypt('test-secret-123', extensions.gen_salt('bf')));

-- Loesungen fuer alle drei Fragen, fuer den Review-Modus-Test unten (Migration
-- 20260906130000): question_answers muss nach 'finish' fuer ALLE Fragen der
-- Runde lesbar werden (002+003), nicht nur fuer current_question_id -- aber
-- weiterhin NICHT fuer eine Frage ausserhalb der Runde (001).
insert into public.question_answers (question_id, correct_option, points) values
  ('cccccccc-0000-0000-0000-000000000001', 'A', 100),
  ('cccccccc-0000-0000-0000-000000000002', 'A', 100),
  ('cccccccc-0000-0000-0000-000000000003', 'A', 100);

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- 1: round_size < 1 wird abgelehnt.
select extensions.throws_ok(
  $$ select public.presenter_control('start_round', null, 'test-secret-123', 0) $$,
  'P0001',
  'Rundengroesse muss mindestens 1 sein',
  'start_round lehnt Rundengroesse 0 ab'
);

-- 2: round_size groesser als vorhandene Fragen wird abgelehnt. Absichtlich ein
-- absurd hoher Wert statt einer exakten Katalog-Groesse: die echte questions-
-- Tabelle enthaelt inzwischen permanent den importierten Fragenkatalog (siehe
-- Migration import_fragenkatalog), die genaue Gesamtzahl ist fuer diesen Test
-- irrelevant und soll nicht mitgepflegt werden muessen. Nachrichtentext daher
-- nicht exakt geprueft (haengt vom Katalogstand ab), nur der Errcode.
select extensions.throws_ok(
  $$ select public.presenter_control('start_round', null, 'test-secret-123', 999999) $$,
  'P0001',
  null,
  'start_round lehnt zu grosse Rundengroesse ab'
);

-- 3: Bei round_size=2 und einer schon 5x gestellten Frage werden immer die
-- beiden noch nie gestellten gewaehlt, nie die mit times_asked=5 (deterministisch,
-- kein Zufalls-Flackern, weil times_asked strikt vor random() sortiert).
select public.presenter_control('start_round', null, 'test-secret-123', 2);

select extensions.is(
  (select round_question_ids @> array['cccccccc-0000-0000-0000-000000000002'::uuid, 'cccccccc-0000-0000-0000-000000000003'::uuid]
   from public.quiz_sessions limit 1),
  true,
  'start_round waehlt beide noch nie gestellten Fragen, nicht die schon oft gestellte'
);

select extensions.is(
  (select array_length(round_question_ids, 1) from public.quiz_sessions limit 1),
  2,
  'start_round waehlt genau round_size Fragen'
);

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'lobby',
  'start_round setzt status zurueck auf lobby'
);

select extensions.isnt(
  (select round_started_at from public.quiz_sessions limit 1),
  null,
  'start_round stempelt round_started_at (Cutoff fuers rundenbasierte Leaderboard, siehe dashboard-state.js)'
);

-- 3b: question_answers bleibt fuer BEIDE Runden-Fragen unlesbar, solange das
-- Quiz noch nicht komplett beendet ist (auch nachdem eine Frage geoeffnet wurde,
-- siehe Schritt 5 unten) -- Cheat-Schutz unveraendert.

-- 4: 'open' fuer eine Frage AUSSERHALB der aktuellen Runde wird abgelehnt.
select extensions.throws_ok(
  $$ select public.presenter_control('open', 'cccccccc-0000-0000-0000-000000000001', 'test-secret-123') $$,
  'P0001',
  'Frage ist nicht Teil der aktuellen Runde',
  'open lehnt eine Frage ausserhalb der aktuellen Runde ab'
);

-- 5: 'open' fuer eine Frage INNERHALB der Runde funktioniert und zaehlt times_asked hoch.
select public.presenter_control('open', 'cccccccc-0000-0000-0000-000000000002', 'test-secret-123');

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'open',
  'open innerhalb der Runde setzt status auf open'
);

select extensions.is(
  (select times_asked from public.questions where id = 'cccccccc-0000-0000-0000-000000000002'),
  0,
  'open zaehlt times_asked der geoeffneten Frage um 1 hoch (Fixture-Start -1, siehe oben)'
);

-- 5b: 'open' ein zweites Mal fuer DIESELBE, bereits offene Frage (Doppelklick
-- oder doppelter Netzwerk-Retry, siehe Migration prevent_duplicate_open_increment)
-- ist ein No-Op: times_asked bleibt stehen statt ein zweites Mal hochzuzaehlen.
select public.presenter_control('open', 'cccccccc-0000-0000-0000-000000000002', 'test-secret-123');

select extensions.is(
  (select times_asked from public.questions where id = 'cccccccc-0000-0000-0000-000000000002'),
  0,
  'ein zweites open auf dieselbe schon offene Frage zaehlt times_asked NICHT nochmal hoch'
);

-- 5c: solange das Quiz noch laeuft, bleibt question_answers fuer die gesamte
-- Runde unlesbar, auch fuer die gerade offene Frage 002 (Cheat-Schutz waehrend
-- 'open', unveraendert -- die neue Policy greift erst ab 'finished').
select extensions.is(
  (select count(*)::int from public.question_answers),
  0,
  'question_answers bleibt waehrend der laufenden Runde komplett unlesbar'
);

-- 6: 'open' NACH Quiz-Ende (status = 'finished') wird abgelehnt, statt die
-- Runde erneut aufzureissen (Timer/Auto-Advance liefen sonst nochmal komplett
-- durch, siehe Migration prevent_reopen_after_finish). Nutzt die aus Schritt 3
-- noch aktive Runde weiter, kein neuer start_round noetig (der waere hier
-- nicht deterministisch, sobald times_asked der Fixtures nicht mehr bei -1 liegt).
select public.presenter_control('finish', null, 'test-secret-123');

-- 6b: Review-Modus (Migration 20260906130000): nach 'finish' werden BEIDE
-- Runden-Fragen lesbar (002 = current_question_id, aber auch 003, die nie
-- current_question_id war) -- genau der Bug, den die neue Policy behebt.
-- Frage 001 ausserhalb der Runde bleibt weiterhin gesperrt.
select extensions.is(
  (select count(*)::int from public.question_answers),
  2,
  'question_answers wird nach finish fuer beide Runden-Fragen lesbar (auch die nie geoeffnete 003)'
);

select extensions.is(
  (select count(*)::int from public.question_answers where question_id = 'cccccccc-0000-0000-0000-000000000001'),
  0,
  'question_answers bleibt nach finish fuer eine Frage ausserhalb der Runde gesperrt'
);

select extensions.throws_ok(
  $$ select public.presenter_control('open', 'cccccccc-0000-0000-0000-000000000002', 'test-secret-123') $$,
  'P0001',
  'Quiz bereits beendet, keine neue Frage oeffenbar',
  'open nach finish wird abgelehnt, auch fuer eine Frage innerhalb der Runde'
);

-- 7: cancel_round setzt Runde, laufende Frage und Status zurueck, times_asked
-- bleibt stehen -- funktioniert unveraendert auch direkt nach 'finished' (Schritt 6).
select public.presenter_control('cancel_round', null, 'test-secret-123');

select extensions.is(
  (select round_question_ids from public.quiz_sessions limit 1),
  null,
  'cancel_round loescht die aktuelle Rundenauswahl'
);

select extensions.is(
  (select status from public.quiz_sessions limit 1),
  'lobby',
  'cancel_round setzt status zurueck auf lobby'
);

select extensions.is(
  (select times_asked from public.questions where id = 'cccccccc-0000-0000-0000-000000000002'),
  0,
  'cancel_round nimmt bereits gezaehltes times_asked nicht zurueck (die Frage war real dran)'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
