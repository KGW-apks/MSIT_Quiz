-- pgTAP-Tests fuer Datenmodell, RLS und den Scoring-Trigger.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(24);

-- Fixtures: drei Teilnehmer, eine Multiple-Choice- und drei Schaetzfragen
-- (eine normale, eine mit correct_value = 0 als Randfall, eine fuer den
-- Gleichstand-Fall).

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user1@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user2@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'user3@test.local');

insert into public.participants (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'User Eins'),
  ('22222222-2222-2222-2222-222222222222', 'User Zwei'),
  ('33333333-3333-3333-3333-333333333333', 'User Drei');

-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164 (siehe
-- Migration import_fragenkatalog), Test-Fixtures duerfen dort nicht kollidieren.
insert into public.questions (id, prompt, question_type, options, position) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Hauptstadt von Frankreich?', 'multiple_choice', '["Berlin", "Paris", "Rom"]', 90001),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Wie viele Sterne hat die EU-Flagge?', 'estimation', null, 90002),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Randfall: korrekter Wert 0', 'estimation', null, 90003),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'Gleichstand-Fall', 'estimation', null, 90004),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'Fresh-Cutoff-Fall', 'estimation', null, 90005);

insert into public.question_answers (question_id, correct_option, correct_value, points) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Paris', null, 100),
  ('aaaaaaaa-0000-0000-0000-000000000002', null, 50, 100),
  ('aaaaaaaa-0000-0000-0000-000000000003', null, 0, 100),
  ('aaaaaaaa-0000-0000-0000-000000000004', null, 50, 100),
  ('aaaaaaaa-0000-0000-0000-000000000005', null, 50, 100);

insert into public.quiz_sessions (current_question_id, status) values (null, 'lobby');
update public.quiz_sessions set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000001', status = 'open';

-- 1+2: question_answers ist fuer authenticated unlesbar und unbeschreibbar (RLS ohne Policy).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select extensions.is(
  (select count(*)::int from public.question_answers),
  0,
  'question_answers liefert 0 Zeilen fuer authenticated (Loesung unlesbar)'
);

select extensions.throws_ok(
  $$ insert into public.question_answers (question_id, correct_option, points) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Berlin', 999) $$,
  '42501',
  null,
  'INSERT in question_answers wird von RLS blockiert'
);

reset role;
reset request.jwt.claims;

-- 3+4: Multiple-Choice richtig beantwortet.

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, selected_option)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Paris');

select extensions.is(
  (select is_correct from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  true,
  'Multiple-Choice: richtige Antwort -> is_correct = true'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  100,
  'Multiple-Choice: richtige Antwort -> volle Punktzahl'
);

reset role;
reset request.jwt.claims;

-- 5+6: Multiple-Choice falsch beantwortet.

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into public.responses (participant_id, question_id, selected_option)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'Berlin');

select extensions.is(
  (select is_correct from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  false,
  'Multiple-Choice: falsche Antwort -> is_correct = false'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0,
  'Multiple-Choice: falsche Antwort -> 0 Punkte'
);

reset role;
reset request.jwt.claims;

-- Frage 2 wird zur aktuell offenen Frage (responses_insert_own verlangt seit
-- der Retroactive-Answer-Fix-Migration, dass question_id == current_question_id
-- und status = 'open' ist).
update public.quiz_sessions set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000002', status = 'open';

-- 7+8: Client-Manipulation bei Schaetzfragen -- der Trigger ueberschreibt sie
-- weiterhin, aber jetzt auf null statt auf einen sofort berechneten Wert: wer
-- am naechsten dran ist, steht erst beim Schliessen fest (siehe
-- rescore_estimation_responses, Migration estimation_closest_wins).

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value, is_correct, points_awarded)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 40, true, 999);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  null,
  'Schaetzfrage direkt nach Insert: points_awarded bleibt null, Client-Manipulation (999) wird nicht uebernommen'
);

select extensions.is(
  (select is_correct from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  null,
  'Schaetzfrage direkt nach Insert: is_correct bleibt null, Client-Manipulation ("true") wird nicht uebernommen'
);

reset role;
reset request.jwt.claims;

-- 9-12: Schaetzfrage schliessen (correct_value = 50): User1 trifft exakt (50),
-- User2 (oben, 40) liegt 10 daneben. rescore_estimation_responses laeuft im
-- echten Betrieb automatisch ueber presenter_control('close', ...) -- hier
-- direkt aufgerufen, weil dieser Test die Scoring-Logik isoliert prueft (die
-- Presenter-Rpc-Verdrahtung deckt presenter_control.test.sql ab).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 50);

reset role;
reset request.jwt.claims;

update public.quiz_sessions set status = 'closed';
select public.rescore_estimation_responses('aaaaaaaa-0000-0000-0000-000000000002');

select extensions.is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  100,
  'Schaetzfrage: exakter Treffer ist nach dem Schliessen der einzige Gewinner -> volle Punktzahl'
);

select extensions.is(
  (select is_correct from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  true,
  'Schaetzfrage: exakter Treffer -> is_correct = true nach dem Schliessen'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  0,
  'Schaetzfrage: weiter weg als der Gewinner -> 0 Punkte, kein Teilpunkte-Trostpreis mehr'
);

select extensions.is(
  (select is_correct from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  false,
  'Schaetzfrage: weiter weg als der Gewinner -> is_correct = false'
);

-- Frage 3 wird zur aktuell offenen Frage.
update public.quiz_sessions set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000003', status = 'open';

-- 13+14: Randfall correct_value = 0 -- funktioniert ohne Sonderfall-Code, weil
-- ein absoluter Abstand (statt einer relativen Fehlerformel) keine Division
-- braucht.

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 0);

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 5);

reset role;
reset request.jwt.claims;

update public.quiz_sessions set status = 'closed';
select public.rescore_estimation_responses('aaaaaaaa-0000-0000-0000-000000000003');

select extensions.is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  100,
  'Randfall correct_value=0: exakte Schaetzung 0 gewinnt'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '33333333-3333-3333-3333-333333333333' and question_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  0,
  'Randfall correct_value=0: daneben geschaetzt -> 0 Punkte'
);

-- Frage 3 bleibt current_question_id und status='closed' fuer Test 12 unten
-- (Retroactive-Answer-Fix-Migration), absichtlich nicht veraendert.

-- 12: Frage 3 wird geschlossen (current_question_id zeigt weiter auf sie, aber
-- status != 'open'). User 2 hat auf Frage 3 noch nicht geantwortet und
-- versucht es jetzt, nach dem Schliessen -> muss von RLS blockiert werden.
-- Das ist genau der Cheat, den die Retroactive-Answer-Fix-Migration verhindert:
-- ohne sie wuerde dieser INSERT durchgehen und der Trigger wuerde ganz normal
-- Punkte vergeben.
update public.quiz_sessions set status = 'closed';

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select extensions.throws_ok(
  $$ insert into public.responses (participant_id, question_id, guess_value) values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000003', 5) $$,
  '42501',
  null,
  'Antwort auf eine bereits geschlossene Frage wird von RLS blockiert (kein nachtraegliches Antworten nach Reveal)'
);

reset role;
reset request.jwt.claims;

-- Zurueck auf Frage 1 als aktuell offene Frage fuer die verbleibenden Tests.
update public.quiz_sessions set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000001', status = 'open';

-- 13: doppelte Antwort auf dieselbe Frage verletzt den Unique-Constraint.

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

insert into public.responses (participant_id, question_id, selected_option)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'Paris');

select extensions.throws_ok(
  $$ insert into public.responses (participant_id, question_id, selected_option) values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'Paris') $$,
  '23505',
  null,
  'Doppelte Antwort derselben Person auf dieselbe Frage wird abgelehnt'
);

-- 14: Antwort im Namen einer anderen Person wird von RLS blockiert.

select extensions.throws_ok(
  $$ insert into public.responses (participant_id, question_id, selected_option) values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'x') $$,
  '42501',
  null,
  'Antwort mit fremder participant_id wird von RLS blockiert'
);

reset role;
reset request.jwt.claims;

-- 15: latency_ms wird ab question_opened_at berechnet.

select extensions.ok(
  (select latency_ms from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001') >= 0,
  'latency_ms fuer die aktiv geschaltete Frage ist gesetzt und nicht negativ'
);

-- 16: latency_ms bleibt NULL, wenn eine Frage bei Insert-Zeitpunkt nicht die
-- aktuelle ist (Trigger-Eigenschutz). Ueber service_role getestet (RLS
-- umgangen), weil ein normaler authenticated-Client diesen Fall dank der
-- Retroactive-Answer-Fix-Migration ohnehin nicht mehr erreichen kann:
-- current_question_id steht inzwischen auf Frage 1, Frage 2 ist also nicht
-- mehr aktuell.
set local role service_role;

insert into public.responses (participant_id, question_id, guess_value)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000002', 50);

select extensions.is(
  (select latency_ms from public.responses where participant_id = '33333333-3333-3333-3333-333333333333' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  null,
  'latency_ms bleibt NULL fuer eine Frage, die bei Insert-Zeitpunkt nicht current_question_id war'
);

reset role;

-- 17-19: Gleichstand -- zwei Teilnehmer gleich weit weg bekommen BEIDE den
-- Punkt, kein Losentscheid.

update public.quiz_sessions
set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000004', status = 'open', round_question_ids = null
where true;

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004', 40);

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000004', 60);

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000004', 100);

reset role;
reset request.jwt.claims;

update public.quiz_sessions set status = 'closed';
select public.rescore_estimation_responses('aaaaaaaa-0000-0000-0000-000000000004');

select extensions.is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  100,
  'Gleichstand: User1 (Abstand 10) bekommt den Punkt'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  100,
  'Gleichstand: User2 (ebenfalls Abstand 10) bekommt den Punkt genauso, kein Losentscheid'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '33333333-3333-3333-3333-333333333333' and question_id = 'aaaaaaaa-0000-0000-0000-000000000004'),
  0,
  'Gleichstand: User3 (Abstand 50, weiter weg) bekommt keinen Punkt'
);

-- 20+21: "Fresh"-Cutoff -- eine Antwort von VOR der aktuellen Oeffnung (z.B.
-- aus einer frueheren Runde, times_asked erlaubt Wiederholungen) darf nicht in
-- die Abstandsberechnung einfliessen, selbst wenn sie naeher am korrekten Wert
-- liegt als jede frische Antwort. Trigger kurzzeitig deaktiviert, um
-- answered_at gezielt in die Vergangenheit zu legen (score_response() wuerde
-- es sonst bei jedem Insert/Update auf now() zurücksetzen) -- simuliert eine
-- stale Zeile aus einer Vorrunde, ohne den zeitlichen Ablauf einer echten
-- zweiten Rundenoeffnung nachbauen zu muessen.

update public.quiz_sessions
set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000005', status = 'open', question_opened_at = now()
where true;

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000005', 999);

reset role;
reset request.jwt.claims;

alter table public.responses disable trigger responses_score_before_insert_or_update;

update public.responses
set answered_at = now() - interval '1 hour'
where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000005';

alter table public.responses enable trigger responses_score_before_insert_or_update;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000005', 45);

reset role;
reset request.jwt.claims;

update public.quiz_sessions set status = 'closed';
select public.rescore_estimation_responses('aaaaaaaa-0000-0000-0000-000000000005');

select extensions.is(
  (select points_awarded from public.responses where participant_id = '33333333-3333-3333-3333-333333333333' and question_id = 'aaaaaaaa-0000-0000-0000-000000000005'),
  100,
  'Fresh-Cutoff: die einzige frische Antwort gewinnt automatisch (Abstand 5)'
);

select extensions.is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000005'),
  null,
  'Fresh-Cutoff: die stale Antwort (Abstand 0, waere sonst der klare Gewinner) bleibt von der Neuberechnung unberuehrt'
);

select * from extensions.finish();
rollback;
