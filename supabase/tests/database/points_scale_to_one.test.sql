-- pgTAP-Tests fuer die Punkte-Umstellung von 100 auf 1 (Migration
-- points_scale_to_one, Knuts Vorgabe 2026-09-07).
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(2);

-- 1: neue question_answers-Zeile ohne explizite points bekommt den Default 1.
-- position bewusst hoch (9xxxx): der echte Fragenkatalog belegt 1-164.
insert into public.questions (id, prompt, question_type, options, position) values
  ('ffffffff-0000-0000-0000-000000000001', 'Default-Punkte-Test', 'multiple_choice', '["A", "B"]', 90301);

insert into public.question_answers (question_id, correct_option) values
  ('ffffffff-0000-0000-0000-000000000001', 'A');

select extensions.is(
  (select points from public.question_answers where question_id = 'ffffffff-0000-0000-0000-000000000001'),
  1,
  'Neue question_answers-Zeile ohne explizite points bekommt den Default 1'
);

-- 2: alle echten Katalog-Fragen (position < 90000, Test-Fixtures liegen daneben)
-- wurden per Migration einheitlich auf 1 Punkt gesetzt.
select extensions.is(
  (
    select count(*)::int
    from public.question_answers qa
    join public.questions q on q.id = qa.question_id
    where q.position < 90000 and qa.points is distinct from 1
  ),
  0,
  'Alle Katalog-Fragen (position < 90000) haben nach der Migration points = 1'
);

select * from extensions.finish();
rollback;
