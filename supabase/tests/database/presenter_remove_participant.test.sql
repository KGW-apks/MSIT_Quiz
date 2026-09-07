-- pgTAP-Tests fuer presenter_remove_participant(): Presenter kann einen
-- Teilnehmer entfernen, aber nur mit korrektem Presenter-Passwort, und die
-- Antworten des entfernten Teilnehmers verschwinden per Cascade mit.
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(4);

insert into public.presenter_secret (id, secret_hash)
values (true, extensions.crypt('test-secret-123', extensions.gen_salt('bf')));

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'remove-test-1@test.local');
insert into public.participants (id, display_name) values
  ('dddddddd-0000-0000-0000-000000000001', 'Entfernbarer Teilnehmer');

-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164.
insert into public.questions (id, prompt, question_type, options, position) values
  ('dddddddd-0000-0000-0000-000000000002', 'Testfrage', 'multiple_choice', '["A", "B"]', 90201);
insert into public.question_answers (question_id, correct_option, points) values
  ('dddddddd-0000-0000-0000-000000000002', 'A', 100);

-- responses_insert_own verlangt zusaetzlich zu participant_id = auth.uid()
-- eine tatsaechlich offene Frage (siehe Migration
-- responses_require_open_question); als postgres (RLS-Bypass) direkt setzen,
-- statt den Umweg ueber presenter_control() zu nehmen.
update public.quiz_sessions
set current_question_id = 'dddddddd-0000-0000-0000-000000000002', status = 'open';

set local role authenticated;
set local request.jwt.claims to '{"sub":"dddddddd-0000-0000-0000-000000000001","role":"authenticated"}';

insert into public.responses (participant_id, question_id, selected_option) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002', 'A');

reset role;
reset request.jwt.claims;

-- 1: Falsches Presenter-Passwort wird abgelehnt, Teilnehmer bleibt bestehen.

select extensions.throws_ok(
  $$ select public.presenter_remove_participant('dddddddd-0000-0000-0000-000000000001', 'falsches-passwort') $$,
  '28000',
  'Ungueltiges Presenter-Passwort',
  'presenter_remove_participant() lehnt ein falsches Passwort ab'
);

select extensions.is(
  (select count(*)::int from public.participants where id = 'dddddddd-0000-0000-0000-000000000001'),
  1,
  'Teilnehmer bleibt nach abgelehntem Versuch bestehen'
);

-- 2: Richtiges Passwort entfernt den Teilnehmer.

select public.presenter_remove_participant('dddddddd-0000-0000-0000-000000000001', 'test-secret-123');

select extensions.is(
  (select count(*)::int from public.participants where id = 'dddddddd-0000-0000-0000-000000000001'),
  0,
  'presenter_remove_participant(richtiges Passwort) entfernt den Teilnehmer'
);

-- 3: Dessen Antworten verschwinden per "on delete cascade" mit.

select extensions.is(
  (select count(*)::int from public.responses where participant_id = 'dddddddd-0000-0000-0000-000000000001'),
  0,
  'Antworten des entfernten Teilnehmers werden per Cascade mitgeloescht'
);

select * from extensions.finish();
rollback;
