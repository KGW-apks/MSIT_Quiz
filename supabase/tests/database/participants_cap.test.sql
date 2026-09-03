-- pgTAP-Test fuer die Registrierungs-Obergrenze (Schutz gegen Massen-Registrierung).
-- Ausfuehren: npx supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select extensions.plan(3);

-- 149 Teilnehmer anlegen (knapp unter der Grenze von 150).

do $$
declare
  i int;
  fake_id uuid;
begin
  for i in 1..149 loop
    fake_id := gen_random_uuid();
    insert into auth.users (id, email) values (fake_id, 'cap-test-' || i || '@test.local');
    insert into public.participants (id, display_name) values (fake_id, 'Cap Test ' || i);
  end loop;
end;
$$;

select extensions.is(
  (select count(*)::int from public.participants),
  149,
  '149 Teilnehmer wurden angelegt (unterhalb der Obergrenze)'
);

-- Der 150. Teilnehmer ist noch erlaubt (Grenze liegt bei >= 150).

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-000000000150', 'cap-test-150@test.local');

select extensions.lives_ok(
  $$ insert into public.participants (id, display_name) values ('cccccccc-0000-0000-0000-000000000150', 'Cap Test 150') $$,
  'Teilnehmer Nummer 150 wird noch akzeptiert (Grenze noch nicht ueberschritten)'
);

-- Der 151. Teilnehmer muss an der Obergrenze scheitern.

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-000000000151', 'cap-test-151@test.local');

select extensions.throws_ok(
  $$ insert into public.participants (id, display_name) values ('cccccccc-0000-0000-0000-000000000151', 'Cap Test 151') $$,
  'P0001',
  'Teilnehmer-Obergrenze erreicht (150)',
  'Teilnehmer Nummer 151 wird durch die Obergrenze abgelehnt'
);

select * from extensions.finish();
rollback;
