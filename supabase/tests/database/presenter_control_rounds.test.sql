-- pgTAP-Tests fuers Rundenkonzept: start_round waehlt bevorzugt noch nie
-- gestellte Fragen (times_asked), open zaehlt times_asked hoch und ist auf die
-- aktuelle Runde beschraenkt, cancel_round setzt sauber zurueck.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(11);

insert into public.questions (id, prompt, question_type, options, position, times_asked) values
  ('cccccccc-0000-0000-0000-000000000001', 'Schon oft dran', 'multiple_choice', '["A", "B"]', 1, 5),
  ('cccccccc-0000-0000-0000-000000000002', 'Noch nie dran A', 'multiple_choice', '["A", "B"]', 2, 0),
  ('cccccccc-0000-0000-0000-000000000003', 'Noch nie dran B', 'multiple_choice', '["A", "B"]', 3, 0);

insert into public.presenter_secret (id, secret_hash)
values (true, extensions.crypt('test-secret-123', extensions.gen_salt('bf')));

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- 1: round_size < 1 wird abgelehnt.
select extensions.throws_ok(
  $$ select public.presenter_control('start_round', null, 'test-secret-123', 0) $$,
  'P0001',
  'Rundengroesse muss mindestens 1 sein',
  'start_round lehnt Rundengroesse 0 ab'
);

-- 2: round_size groesser als vorhandene Fragen wird abgelehnt.
select extensions.throws_ok(
  $$ select public.presenter_control('start_round', null, 'test-secret-123', 4) $$,
  'P0001',
  'Rundengroesse (4) groesser als die Anzahl vorhandener Fragen (3)',
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
  1,
  'open zaehlt times_asked der geoeffneten Frage um 1 hoch'
);

-- 6: cancel_round setzt Runde, laufende Frage und Status zurueck, times_asked bleibt stehen.
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
  1,
  'cancel_round nimmt bereits gezaehltes times_asked nicht zurueck (die Frage war real dran)'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
