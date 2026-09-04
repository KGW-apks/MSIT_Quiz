-- Live gegen das echte Projekt getestet (2026-09-04): jedes UPDATE auf
-- quiz_sessions in presenter_control() schlug mit "UPDATE requires a WHERE
-- clause" fehl, auch die unveraenderten Aktionen open/close/finish aus der
-- Tag-3-Migration. Postgres-Bordmittel (safeupdate-Extension oder aequivalente
-- Absicherung) verlangt offenbar eine WHERE-Klausel fuer jedes UPDATE, auch
-- innerhalb einer SECURITY DEFINER-Funktion. quiz_sessions ist eine echte
-- Singleton-Tabelle (immer genau eine Zeile), "where true" ist hier korrekt
-- und deklariert explizit "ja, wirklich die eine Zeile".
create or replace function public.presenter_control(
  action text,
  target_question_id uuid,
  presenter_secret text,
  round_size integer default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored_hash text;
  current_round uuid[];
  picked_ids uuid[];
  total_questions integer;
begin
  select secret_hash into stored_hash from public.presenter_secret where id = true;

  if stored_hash is null or extensions.crypt(presenter_secret, stored_hash) is distinct from stored_hash then
    raise exception 'Ungueltiges Presenter-Passwort' using errcode = '28000';
  end if;

  if action = 'open' then
    select round_question_ids into current_round from public.quiz_sessions limit 1;

    if current_round is not null and not (target_question_id = any(current_round)) then
      raise exception 'Frage ist nicht Teil der aktuellen Runde';
    end if;

    update public.quiz_sessions
    set current_question_id = target_question_id, status = 'open'
    where true;

    update public.questions
    set times_asked = times_asked + 1
    where id = target_question_id;

  elsif action = 'close' then
    update public.quiz_sessions set status = 'closed' where true;

  elsif action = 'finish' then
    update public.quiz_sessions set status = 'finished' where true;

  elsif action = 'start_round' then
    if round_size is null or round_size < 1 then
      raise exception 'Rundengroesse muss mindestens 1 sein';
    end if;

    select count(*) into total_questions from public.questions;
    if round_size > total_questions then
      raise exception 'Rundengroesse (%) groesser als die Anzahl vorhandener Fragen (%)', round_size, total_questions;
    end if;

    select array_agg(id) into picked_ids
    from (
      select id from public.questions
      order by times_asked asc, random()
      limit round_size
    ) as chosen;

    update public.quiz_sessions
    set round_question_ids = picked_ids, current_question_id = null, status = 'lobby'
    where true;

  elsif action = 'cancel_round' then
    update public.quiz_sessions
    set round_question_ids = null, current_question_id = null, status = 'lobby'
    where true;

  else
    raise exception 'Unbekannte Presenter-Aktion: %', action;
  end if;
end;
$$;
