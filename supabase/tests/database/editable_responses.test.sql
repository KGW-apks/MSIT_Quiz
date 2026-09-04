-- pgTAP-Tests fuer den 30s-Default-Timer und korrigierbare Antworten
-- (Migration editable_responses_and_default_timer). Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(6);

-- 1: neue Frage ohne explizites time_limit_seconds bekommt den Default 30.
-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164.
insert into public.questions (id, prompt, question_type, options, position) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'Default-Timer-Test', 'multiple_choice', '["A", "B"]', 90101);

select extensions.is(
  (select time_limit_seconds from public.questions where id = 'eeeeeeee-0000-0000-0000-000000000001'),
  30,
  'Neue Frage ohne explizites Zeitlimit bekommt den Default 30s'
);

-- 2: alle echten Katalog-Fragen (position < 90000, Test-Fixtures liegen daneben)
-- wurden per Migration einheitlich auf 30s gesetzt.
select extensions.is(
  (select count(*)::int from public.questions where position < 90000 and time_limit_seconds is distinct from 30),
  0,
  'Alle Katalog-Fragen (position < 90000) haben nach der Migration time_limit_seconds = 30'
);

-- Fixtures fuer die Antwort-Korrektur-Tests.
insert into auth.users (id, email) values
  ('eeeeeeee-1111-0000-0000-000000000001', 'edit-test-1@test.local');
insert into public.participants (id, display_name) values
  ('eeeeeeee-1111-0000-0000-000000000001', 'Edit Test Teilnehmer');

insert into public.questions (id, prompt, question_type, options, position) values
  ('eeeeeeee-0000-0000-0000-000000000002', 'Editierbare Antwort?', 'multiple_choice', '["A", "B"]', 90102);
insert into public.question_answers (question_id, correct_option, points) values
  ('eeeeeeee-0000-0000-0000-000000000002', 'B', 100);

insert into public.quiz_sessions (current_question_id, status) values (null, 'lobby')
  on conflict do nothing;
update public.quiz_sessions set current_question_id = 'eeeeeeee-0000-0000-0000-000000000002', status = 'open';

set local role authenticated;
set local request.jwt.claims to '{"sub":"eeeeeeee-1111-0000-0000-000000000001","role":"authenticated"}';

-- 3: erste Antwort (falsch).
insert into public.responses (participant_id, question_id, selected_option)
values ('eeeeeeee-1111-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000002', 'A');

select extensions.is(
  (select points_awarded from public.responses where participant_id = 'eeeeeeee-1111-0000-0000-000000000001' and question_id = 'eeeeeeee-0000-0000-0000-000000000002'),
  0,
  'Erste Antwort (falsch, A) -> 0 Punkte'
);

-- 4: waehrend die Frage noch offen ist, korrigiert der Teilnehmer per upsert
-- (on conflict do update) auf die richtige Antwort -> Trigger rechnet neu.
insert into public.responses (participant_id, question_id, selected_option)
values ('eeeeeeee-1111-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000002', 'B')
on conflict (participant_id, question_id) do update set selected_option = excluded.selected_option;

select extensions.is(
  (select points_awarded from public.responses where participant_id = 'eeeeeeee-1111-0000-0000-000000000001' and question_id = 'eeeeeeee-0000-0000-0000-000000000002'),
  100,
  'Korrigierte Antwort (B, waehrend die Frage offen ist) -> neu berechnet auf volle Punktzahl'
);

reset role;
reset request.jwt.claims;

-- Frage schliessen: danach darf nicht mehr korrigiert werden.
update public.quiz_sessions set status = 'closed';

set local role authenticated;
set local request.jwt.claims to '{"sub":"eeeeeeee-1111-0000-0000-000000000001","role":"authenticated"}';

-- 5: UPDATE-Versuch nach dem Schliessen betrifft 0 Zeilen (RLS filtert die
-- Zeile fuer das UPDATE heraus, kein Fehler, gleiches Muster wie bei quiz_sessions).
update public.responses set selected_option = 'A'
where participant_id = 'eeeeeeee-1111-0000-0000-000000000001' and question_id = 'eeeeeeee-0000-0000-0000-000000000002';

select extensions.is(
  (select selected_option from public.responses where participant_id = 'eeeeeeee-1111-0000-0000-000000000001' and question_id = 'eeeeeeee-0000-0000-0000-000000000002'),
  'B',
  'Korrektur-Versuch nach dem Schliessen der Frage bleibt wirkungslos (Antwort bleibt B)'
);

-- 6: is_correct bleibt entsprechend true (unveraendert seit der letzten
-- erlaubten Korrektur waehrend die Frage offen war).
select extensions.is(
  (select is_correct from public.responses where participant_id = 'eeeeeeee-1111-0000-0000-000000000001' and question_id = 'eeeeeeee-0000-0000-0000-000000000002'),
  true,
  'is_correct bleibt true, der blockierte Korrektur-Versuch hat nichts veraendert'
);

reset role;
reset request.jwt.claims;

select * from extensions.finish();
rollback;
