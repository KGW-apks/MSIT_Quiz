-- 'open' auf einer Frage, die bereits die aktuelle offene Frage ist (Presenter
-- klickt "Oeffnen" zweimal schnell hintereinander, oder ein Netzwerk-Retry
-- schickt denselben RPC-Call erneut), zaehlte times_asked bei JEDEM Aufruf um
-- 1 hoch, nicht nur beim tatsaechlichen Wechsel auf eine neue Frage: zwei
-- identische presenter_control('open', <gleiche id>, ...)-Aufrufe hinter-
-- einander liessen times_asked von 0 auf 2 springen statt auf 1. Das verzerrt
-- start_round's "bevorzugt am wenigsten gestellte Frage"-Auswahl auf Dauer.
-- Guard: ist die Zielfrage schon die aktuell offene, ist 'open' ein reines
-- No-Op.
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
  current_status text;
  current_qid uuid;
  picked_ids uuid[];
  total_questions integer;
begin
  select secret_hash into stored_hash from public.presenter_secret where id = true;

  if stored_hash is null or extensions.crypt(presenter_secret, stored_hash) is distinct from stored_hash then
    raise exception 'Ungueltiges Presenter-Passwort' using errcode = '28000';
  end if;

  if action = 'open' then
    select round_question_ids, status, current_question_id
      into current_round, current_status, current_qid
      from public.quiz_sessions limit 1;

    if current_status = 'finished' then
      raise exception 'Quiz bereits beendet, keine neue Frage oeffenbar';
    end if;

    -- Neu: dieselbe Frage ist schon offen -> No-Op statt times_asked erneut
    -- hochzuzaehlen. Faengt Doppelklick und doppelten Netzwerk-Retry ab, ohne
    -- ein zusaetzliches Client-seitiges Debouncing vorauszusetzen.
    if current_status = 'open' and current_qid = target_question_id then
      return;
    end if;

    if current_round is not null and not (target_question_id = any(current_round)) then
      raise exception 'Frage ist nicht Teil der aktuellen Runde';
    end if;

    update public.quiz_sessions
    set current_question_id = target_question_id, status = 'open'
    where true;

    -- Zaehlt, wie oft eine Frage im Allgemeinen schon drankam (ueber alle
    -- Runden/Events hinweg), Grundlage fuer die Auswahl in start_round unten.
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
