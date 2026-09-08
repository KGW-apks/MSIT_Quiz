-- Rundenkonzept: der Fragenkatalog waechst (116 Fragen), ein Live-Event nutzt
-- aber nur eine Teilmenge. "Runde starten" waehlt N Fragen aus, bevorzugt
-- solche, die insgesamt noch nie drankamen (times_asked), rein zufaellig
-- unter den jeweils gleich oft gestellten. Repeats erst, wenn alle einmal dran
-- waren. Presenter wird ausserdem ein Tab im Dashboard statt einer eigenen
-- Seite, Schreibrechte bleiben unveraendert exklusiv bei presenter_control().

alter table public.questions
  add column times_asked integer not null default 0;

alter table public.quiz_sessions
  add column round_question_ids uuid[];

-- presenter_control() bekommt einen neuen Parameter (round_size) und zwei neue
-- Aktionen. CREATE OR REPLACE reicht hier nicht: die Parameterliste aendert
-- sich (3 -> 4 Argumente), das waere sonst eine zusaetzliche Ueberladung statt
-- eines Ersatzes, und "open" braeuchte die neue Rundenlogik in beiden
-- Versionen. Deshalb explizit droppen und neu anlegen, Grant danach erneut.
drop function public.presenter_control(text, uuid, text);

create function public.presenter_control(
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

    -- Ist eine Runde aktiv, darf nur eine ihrer Fragen geoeffnet werden (schuetzt
    -- vor versehentlichem Griff in den vollen Katalog waehrend einer laufenden
    -- Runde). Ohne aktive Runde (round_question_ids ist null) bleibt das alte
    -- Verhalten erhalten: jede Frage direkt oeffnen, z.B. fuers schnelle Testen.
    if current_round is not null and not (target_question_id = any(current_round)) then
      raise exception 'Frage ist nicht Teil der aktuellen Runde';
    end if;

    update public.quiz_sessions
    set current_question_id = target_question_id, status = 'open';

    -- Zaehlt, wie oft eine Frage im Allgemeinen schon drankam (ueber alle
    -- Runden/Events hinweg), Grundlage fuer die Auswahl in start_round unten.
    update public.questions
    set times_asked = times_asked + 1
    where id = target_question_id;

  elsif action = 'close' then
    update public.quiz_sessions set status = 'closed';

  elsif action = 'finish' then
    update public.quiz_sessions set status = 'finished';

  elsif action = 'start_round' then
    if round_size is null or round_size < 1 then
      raise exception 'Rundengroesse muss mindestens 1 sein';
    end if;

    select count(*) into total_questions from public.questions;
    if round_size > total_questions then
      raise exception 'Rundengroesse (%) groesser als die Anzahl vorhandener Fragen (%)', round_size, total_questions;
    end if;

    -- Sortierung nach times_asked bevorzugt Fragen, die noch nie (oder seltener)
    -- drankamen; random() innerhalb derselben times_asked-Stufe macht die
    -- Auswahl unter den jeweils gleichwertigen Kandidaten komplett zufaellig.
    select array_agg(id) into picked_ids
    from (
      select id from public.questions
      order by times_asked asc, random()
      limit round_size
    ) as chosen;

    update public.quiz_sessions
    set round_question_ids = picked_ids, current_question_id = null, status = 'lobby';

  elsif action = 'cancel_round' then
    update public.quiz_sessions
    set round_question_ids = null, current_question_id = null, status = 'lobby';

  else
    raise exception 'Unbekannte Presenter-Aktion: %', action;
  end if;
end;
$$;

grant execute on function public.presenter_control(text, uuid, text, integer) to authenticated;
