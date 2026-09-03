-- Harte Obergrenze fuer Registrierungen: schuetzt gegen Massen-Registrierung
-- (Skript-Missbrauch, DDoS-artiges Fluten), unabhaengig vom Supabase-seitigen
-- Anonymous-Sign-in-Rate-Limit (das nur pro IP/Stunde greift, nicht global).
-- 150 ist bewusst grosszuegig ueber der erwarteten Kohortengroesse, aber weit
-- unter jeder Groessenordnung, die die App noch sinnvoll darstellen koennte.
create or replace function public.enforce_participants_cap()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.participants) >= 150 then
    raise exception 'Teilnehmer-Obergrenze erreicht (150)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger participants_cap_before_insert
  before insert on public.participants
  for each row
  execute function public.enforce_participants_cap();
