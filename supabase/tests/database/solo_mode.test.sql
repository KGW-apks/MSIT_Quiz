-- pgTAP-Tests fuer den Solo-Modus: RLS auf solo_sessions/solo_responses,
-- Solo-Scoring-Trigger (Multiple-Choice + Toleranzband bei Schaetzfragen),
-- Reveal-nach-eigener-Antwort auf question_answers.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(21);

-- Fixtures: zwei Teilnehmer, eine Multiple-Choice- und drei Schaetzfragen
-- (normal, Randfall correct_value = 0, Toleranzgrenze exakt 10%).

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'solo-user1@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'solo-user2@test.local');

insert into public.participants (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Solo User Eins'),
  ('22222222-2222-2222-2222-222222222222', 'Solo User Zwei');

insert into public.questions (id, prompt, question_type, options, position) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Hauptstadt von Frankreich?', 'multiple_choice', '["Berlin", "Paris", "Rom"]', 91001),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Schaetzfrage normal', 'estimation', null, 91002),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'Randfall: korrekter Wert 0', 'estimation', null, 91003),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'Toleranzgrenze exakt 10 Prozent', 'estimation', null, 91004);

insert into public.question_answers (question_id, correct_option, correct_value, points) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Paris', null, 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', null, 100, 1),
  ('bbbbbbbb-0000-0000-0000-000000000003', null, 0, 1),
  ('bbbbbbbb-0000-0000-0000-000000000004', null, 100, 1);

-- 1: question_answers ist vor jeder eigenen Antwort weiterhin unlesbar (Reveal-
-- nach-eigener-Antwort-Policy greift erst NACH einer eigenen solo_responses-Zeile).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select extensions.is(
  (select count(*)::int from public.question_answers),
  0,
  'question_answers vor der ersten eigenen Solo-Antwort weiterhin unlesbar'
);

reset role;
reset request.jwt.claims;

-- 2: fremde participant_id bei solo_sessions wird von RLS blockiert.

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select extensions.throws_ok(
  $$ insert into public.solo_sessions (participant_id, question_ids) values ('22222222-2222-2222-2222-222222222222', array['bbbbbbbb-0000-0000-0000-000000000001']::uuid[]) $$,
  '42501',
  null,
  'solo_sessions-INSERT mit fremder participant_id wird von RLS blockiert'
);

-- 3: eigene solo_sessions-Zeile anlegen (User 1, alle vier Fragen in der Runde).

insert into public.solo_sessions (id, participant_id, question_ids)
values (
  'cccccccc-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  array[
    'bbbbbbbb-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000003',
    'bbbbbbbb-0000-0000-0000-000000000004'
  ]::uuid[]
);

select extensions.ok(
  (select current_index from public.solo_sessions where id = 'cccccccc-0000-0000-0000-000000000001') = 0,
  'Neue Solo-Session startet bei current_index = 0'
);

reset role;
reset request.jwt.claims;

-- 4: User 2 sieht die Solo-Session von User 1 nicht (RLS select-own).

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select extensions.is(
  (select count(*)::int from public.solo_sessions where id = 'cccccccc-0000-0000-0000-000000000001'),
  0,
  'Fremde Solo-Session ist fuer einen anderen Teilnehmer unsichtbar (RLS select-own)'
);

reset role;
reset request.jwt.claims;

-- 5+6: Multiple-Choice richtig beantwortet -- sofortiges Scoring, kein Vergleich
-- mit anderen Antworten noetig (anders als beim Team).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.solo_responses (solo_session_id, participant_id, question_id, selected_option)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001', 'Paris');

select extensions.is(
  (select is_correct from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  true,
  'Solo Multiple-Choice: richtige Antwort -> is_correct = true, sofort (kein Rescore noetig)'
);

select extensions.is(
  (select points_awarded from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  1,
  'Solo Multiple-Choice: richtige Antwort -> volle Punktzahl'
);

-- 7: question_answers ist jetzt fuer GENAU diese Frage lesbar (Reveal nach eigener Antwort).

select extensions.is(
  (select correct_option from public.question_answers where question_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  'Paris',
  'question_answers fuer die eigene beantwortete Frage jetzt lesbar (Reveal nach eigener Antwort)'
);

-- 8: eine andere, noch nicht beantwortete Frage bleibt weiterhin unlesbar.

select extensions.is(
  (select count(*)::int from public.question_answers where question_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  0,
  'question_answers fuer eine noch nicht beantwortete Frage bleibt unlesbar'
);

reset role;
reset request.jwt.claims;

-- 9: current_index weiterschalten (eigene Zeile) stempelt question_opened_at neu.

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

update public.solo_sessions set current_index = 1 where id = 'cccccccc-0000-0000-0000-000000000001';

select extensions.ok(
  (select question_opened_at from public.solo_sessions where id = 'cccccccc-0000-0000-0000-000000000001') > now() - interval '5 seconds',
  'question_opened_at wird beim Weiterschalten von current_index frisch gestempelt'
);

-- 10: Schaetzfrage 2 (correct_value = 100), Schaetzung 95 -> 5% Abweichung, innerhalb Toleranz.

insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 95);

select extensions.is(
  (select is_correct from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  true,
  'Solo Schaetzfrage: 5% Abweichung liegt innerhalb der 10%-Toleranz -> richtig'
);

select extensions.is(
  (select points_awarded from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  1,
  'Solo Schaetzfrage innerhalb Toleranz -> volle Punktzahl'
);

update public.solo_sessions set current_index = 2 where id = 'cccccccc-0000-0000-0000-000000000001';

-- 11+12: Randfall correct_value = 0 -- nur eine exakte 0-Schaetzung zaehlt (keine
-- Division fuer eine relative Toleranz moeglich).

insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000003', 0);

select extensions.is(
  (select is_correct from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000003'),
  true,
  'Randfall correct_value=0: exakte Schaetzung 0 -> richtig'
);

update public.solo_sessions set current_index = 3 where id = 'cccccccc-0000-0000-0000-000000000001';

-- 13+14: Toleranzgrenze exakt bei 10% (correct_value = 100, Schaetzung 90 -> rel_error = 0.10,
-- <= 0.10 zaehlt noch als richtig), Schaetzung 89 (rel_error = 0.11) faellt knapp raus.

insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value)
values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000004', 90);

select extensions.is(
  (select is_correct from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000004'),
  true,
  'Toleranzgrenze: rel_error = 0.10 (Schaetzung 90 bei correct_value 100) zaehlt noch als richtig'
);

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into public.solo_sessions (id, participant_id, question_ids)
values (
  'cccccccc-0000-0000-0000-000000000002',
  '22222222-2222-2222-2222-222222222222',
  array['bbbbbbbb-0000-0000-0000-000000000004']::uuid[]
);

insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value)
values ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000004', 89);

select extensions.is(
  (select is_correct from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000002' and question_id = 'bbbbbbbb-0000-0000-0000-000000000004'),
  false,
  'Toleranzgrenze: rel_error = 0.11 (Schaetzung 89 bei correct_value 100) liegt knapp ausserhalb -> falsch'
);

select extensions.is(
  (select points_awarded from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000002' and question_id = 'bbbbbbbb-0000-0000-0000-000000000004'),
  0,
  'Toleranzgrenze ueberschritten -> 0 Punkte'
);

-- 15: User 2 hat Frage 1 nie beantwortet, sieht deren Loesung also weiterhin nicht
-- (Reveal-Policy haengt an der eigenen Antwort, nicht an der von User 1).

select extensions.is(
  (select count(*)::int from public.question_answers where question_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  0,
  'question_answers fuer eine von User 2 nie beantwortete Frage bleibt unlesbar, obwohl User 1 sie schon aufgedeckt hat'
);

-- 16: doppelte Antwort auf dieselbe Frage im selben Solo-Lauf verletzt den Unique-Constraint.

select extensions.throws_ok(
  $$ insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value) values ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000004', 100) $$,
  '23505',
  null,
  'Doppelte Antwort auf dieselbe Frage im selben Solo-Lauf wird abgelehnt'
);

-- 17: fremde participant_id bei solo_responses wird von RLS blockiert.

select extensions.throws_ok(
  $$ insert into public.solo_responses (solo_session_id, participant_id, question_id, guess_value) values ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 50) $$,
  '42501',
  null,
  'solo_responses-INSERT mit fremder participant_id wird von RLS blockiert'
);

reset role;
reset request.jwt.claims;

-- 18: latency_ms wird ab solo_sessions.question_opened_at berechnet und ist nicht negativ.

select extensions.ok(
  (select latency_ms from public.solo_responses where solo_session_id = 'cccccccc-0000-0000-0000-000000000001' and question_id = 'bbbbbbbb-0000-0000-0000-000000000001') >= 0,
  'latency_ms fuer eine Solo-Antwort ist gesetzt und nicht negativ'
);

-- 19: Solo-Lauf beenden (eigene Zeile, normales UPDATE, kein RPC noetig).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

update public.solo_sessions
set status = 'finished', finished_at = now()
where id = 'cccccccc-0000-0000-0000-000000000001';

select extensions.is(
  (select status from public.solo_sessions where id = 'cccccccc-0000-0000-0000-000000000001'),
  'finished',
  'Eigene Solo-Session laesst sich per normalem UPDATE auf finished setzen'
);

-- 20: question_ids darf nicht leer sein (Check-Constraint).

select extensions.throws_ok(
  $$ insert into public.solo_sessions (participant_id, question_ids) values ('11111111-1111-1111-1111-111111111111', array[]::uuid[]) $$,
  '23514',
  null,
  'Eine Solo-Session ohne Fragen wird vom Check-Constraint abgelehnt'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
