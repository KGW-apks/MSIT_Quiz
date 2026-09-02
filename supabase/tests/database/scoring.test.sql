-- pgTAP-Tests fuer Datenmodell, RLS und den Scoring-Trigger.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

-- Fixtures: drei Teilnehmer, eine Multiple-Choice- und zwei Schaetzfragen
-- (eine normale, eine mit correct_value = 0 als Randfall).

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user1@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'user2@test.local'),
  ('33333333-3333-3333-3333-333333333333', 'user3@test.local');

insert into public.participants (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'User Eins'),
  ('22222222-2222-2222-2222-222222222222', 'User Zwei'),
  ('33333333-3333-3333-3333-333333333333', 'User Drei');

insert into public.questions (id, prompt, question_type, options, position) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Hauptstadt von Frankreich?', 'multiple_choice', '["Berlin", "Paris", "Rom"]', 1),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Wie viele Sterne hat die EU-Flagge?', 'estimation', null, 2),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Randfall: korrekter Wert 0', 'estimation', null, 3);

insert into public.question_answers (question_id, correct_option, correct_value, points) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Paris', null, 100),
  ('aaaaaaaa-0000-0000-0000-000000000002', null, 50, 100),
  ('aaaaaaaa-0000-0000-0000-000000000003', null, 0, 100);

insert into public.quiz_sessions (current_question_id, status) values (null, 'lobby');
update public.quiz_sessions set current_question_id = 'aaaaaaaa-0000-0000-0000-000000000001', status = 'open';

-- 1+2: question_answers ist fuer authenticated unlesbar und unbeschreibbar (RLS ohne Policy).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.question_answers),
  0,
  'question_answers liefert 0 Zeilen fuer authenticated (Loesung unlesbar)'
);

select throws_ok(
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

select is(
  (select is_correct from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  true,
  'Multiple-Choice: richtige Antwort -> is_correct = true'
);

select is(
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

select is(
  (select is_correct from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  false,
  'Multiple-Choice: falsche Antwort -> is_correct = false'
);

select is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  0,
  'Multiple-Choice: falsche Antwort -> 0 Punkte'
);

-- 7: Client-Manipulation wird vom Trigger ueberschrieben, nicht uebernommen.

insert into public.responses (participant_id, question_id, guess_value, is_correct, points_awarded)
values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 40, true, 999);

select is(
  (select points_awarded from public.responses where participant_id = '22222222-2222-2222-2222-222222222222' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  80,
  'Vom Client mitgeschicktes is_correct/points_awarded wird vom Trigger ueberschrieben (10 von 50 daneben -> 80 Punkte)'
);

reset role;
reset request.jwt.claims;

-- 8+9: Schaetzfrage exakt getroffen (User 1, correct_value = 50).

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 50);

select is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  100,
  'Schaetzfrage: exakter Treffer -> volle Punktzahl'
);

select is(
  (select is_correct from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  true,
  'Schaetzfrage: exakter Treffer -> is_correct = true'
);

-- 10+11: Randfall correct_value = 0.

insert into public.responses (participant_id, question_id, guess_value)
values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 0);

select is(
  (select points_awarded from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  100,
  'Randfall correct_value=0: exakte Schaetzung 0 -> volle Punktzahl'
);

reset role;
reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

insert into public.responses (participant_id, question_id, guess_value)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 5);

select is(
  (select points_awarded from public.responses where participant_id = '33333333-3333-3333-3333-333333333333' and question_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  0,
  'Randfall correct_value=0: daneben geschaetzt -> 0 Punkte statt Division durch 0'
);

-- 12: doppelte Antwort auf dieselbe Frage verletzt den Unique-Constraint.

insert into public.responses (participant_id, question_id, selected_option)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'Paris');

select throws_ok(
  $$ insert into public.responses (participant_id, question_id, selected_option) values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000001', 'Paris') $$,
  '23505',
  null,
  'Doppelte Antwort derselben Person auf dieselbe Frage wird abgelehnt'
);

-- 13: Antwort im Namen einer anderen Person wird von RLS blockiert.

select throws_ok(
  $$ insert into public.responses (participant_id, question_id, selected_option) values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'x') $$,
  '42501',
  null,
  'Antwort mit fremder participant_id wird von RLS blockiert'
);

reset role;
reset request.jwt.claims;

-- 14+15: latency_ms wird ab question_opened_at berechnet, ist bei nie aktiv geschalteten Fragen NULL.

select ok(
  (select latency_ms from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000001') >= 0,
  'latency_ms fuer die aktiv geschaltete Frage ist gesetzt und nicht negativ'
);

select is(
  (select latency_ms from public.responses where participant_id = '11111111-1111-1111-1111-111111111111' and question_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  null,
  'latency_ms bleibt NULL fuer eine Frage, die nie current_question_id war'
);

select * from finish();
rollback;
