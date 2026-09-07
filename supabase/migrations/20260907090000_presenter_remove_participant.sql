-- Presenter kann einen Teilnehmer aus der laufenden Session entfernen (z.B.
-- falsch angemeldet, stoert das Quiz). Gleiches Schutzmuster wie
-- presenter_control() (siehe presenter_control_rpc): SECURITY DEFINER, geprueft
-- gegen presenter_secret, kein direkter DELETE fuer Clients (keine eigene
-- delete-Policy auf participants noetig). Der zugehoerige auth.users-Eintrag
-- bleibt bestehen (kein Zugriff auf das Auth-Schema hier); ueber
-- "on delete cascade" auf responses.participant_id verschwinden dessen
-- Antworten mit. Wer entfernt wurde, muesste sich als neuer Teilnehmer neu
-- anmelden, um wieder mitzumachen.

create function public.presenter_remove_participant(
  target_participant_id uuid,
  presenter_secret text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored_hash text;
begin
  select secret_hash into stored_hash from public.presenter_secret where id = true;

  if stored_hash is null or extensions.crypt(presenter_secret, stored_hash) is distinct from stored_hash then
    raise exception 'Ungueltiges Presenter-Passwort' using errcode = '28000';
  end if;

  delete from public.participants where id = target_participant_id;
end;
$$;

grant execute on function public.presenter_remove_participant(uuid, text) to authenticated;
