-- Bisher durfte laut RLS JEDE authentifizierte Session (auch ein normaler
-- Teilnehmer, nicht nur der Presenter) quiz_sessions beliebig veraendern
-- (`using (true) with check (true)`), weil Presenter und Teilnehmer dieselbe
-- stille Anonymous-Auth teilen und es keine eigene Presenter-Identitaet gibt.
-- Wer im Browser die Netzwerk-Requests des Presenters sieht, koennte sie 1:1
-- nachbauen und das Quiz fuer alle kapern (Fragen ueberspringen, vorzeitig
-- beenden). Fix, ohne ein eigenes Login-System einzufuehren: quiz_sessions
-- wird fuer direkte Schreibzugriffe komplett gesperrt (kein Ersatz-Policy,
-- gleiches Muster wie question_answers), Aenderungen laufen nur noch ueber
-- die SECURITY DEFINER-Funktion presenter_control(), die ein geheimes
-- Presenter-Passwort prueft (gehasht abgelegt, per pgcrypto).

drop policy quiz_sessions_update_all on public.quiz_sessions;

create extension if not exists pgcrypto with schema extensions;

-- Singleton-Tabelle fuer den Passwort-Hash. RLS aktiv, bewusst keine Policy:
-- fuer keinen Client lesbar oder schreibbar, nur ueber SECURITY DEFINER unten
-- oder den service_role-Key (Passwort wird einmalig per SQL-Editor gesetzt).
create table public.presenter_secret (
  id boolean primary key default true check (id),
  secret_hash text not null
);
alter table public.presenter_secret enable row level security;

create function public.presenter_control(
  action text,
  target_question_id uuid,
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

  if action = 'open' then
    update public.quiz_sessions
    set current_question_id = target_question_id, status = 'open';
  elsif action = 'close' then
    update public.quiz_sessions set status = 'closed';
  elsif action = 'finish' then
    update public.quiz_sessions set status = 'finished';
  else
    raise exception 'Unbekannte Presenter-Aktion: %', action;
  end if;
end;
$$;

grant execute on function public.presenter_control(text, uuid, text) to authenticated;
