-- Schaetzfragen-Scoring umgestellt: nicht mehr eine prozentuale
-- Teilpunkte-Formel (die nach der Punkte-Umstellung auf 1
-- ohnehin nur noch 0/1 unterscheiden konnte, siehe Migration
-- points_scale_to_one), sondern "wer am naechsten dran ist, bekommt den
-- Punkt; bei Gleichstand bekommen alle Punkte, die den Abstand halten".
--
-- Wer am naechsten liegt, steht erst fest, wenn ALLE Antworten da sind --
-- das kann der insert/update-Trigger score_response() nicht wissen (andere
-- Teilnehmer antworten moeglicherweise erst spaeter, waehrend die Frage noch
-- offen ist). Deshalb rechnet score_response() fuer Schaetzfragen ab jetzt
-- gar nichts mehr vor: is_correct/points_awarded bleiben null, bis die neue
-- Funktion rescore_estimation_responses() sie beim Schliessen (presenter_control:
-- close) fuer ALLE Antworten dieser Frage auf einmal nachtraegt. Multiple-
-- Choice ist unveraendert (dort steht die Korrektheit pro Antwort sofort fest).
--
-- Nebeneffekt: die Sonderbehandlung fuer correct_value = 0 (frueher noetig
-- wegen Division durch 0 in der relativen Fehlerformel) entfaellt komplett --
-- ein absoluter Abstand braucht keine Division und funktioniert bei 0 genauso
-- wie bei jedem anderen Wert.

create or replace function public.score_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  answer public.question_answers%rowtype;
  q public.questions%rowtype;
  opened_at timestamptz;
begin
  select * into answer from public.question_answers where question_id = new.question_id;
  if not found then
    raise exception 'Keine Loesung fuer Frage % hinterlegt', new.question_id;
  end if;

  select * into q from public.questions where id = new.question_id;

  select question_opened_at into opened_at
  from public.quiz_sessions
  where current_question_id = new.question_id
  limit 1;

  if TG_OP = 'INSERT' then
    new.change_count := 0;
  elsif opened_at is not null and old.answered_at < opened_at then
    new.change_count := 0;
  elsif new.selected_option is distinct from old.selected_option
     or new.guess_value is distinct from old.guess_value then
    new.change_count := coalesce(old.change_count, 0) + 1;
  else
    new.change_count := old.change_count;
  end if;

  new.answered_at := now();
  new.latency_ms := case
    when opened_at is not null
    then greatest(0, extract(epoch from (new.answered_at - opened_at)) * 1000)::integer
    else null
  end;

  if q.question_type = 'multiple_choice' then
    new.is_correct := (new.selected_option = answer.correct_option);
    new.points_awarded := case when new.is_correct then answer.points else 0 end;

  elsif q.question_type = 'estimation' then
    -- Nur bei einem NEUEN oder GEAENDERTEN Tipp zuruecksetzen (absichtlich
    -- unbestimmt bis zum Schliessen, siehe rescore_estimation_responses).
    -- rescore_estimation_responses aendert guess_value NICHT, nur is_correct/
    -- points_awarded -- ohne dieses Guard wuerde dieser selbe Trigger (er
    -- feuert bei JEDEM Update auf responses) das gerade berechnete Ergebnis
    -- sofort wieder auf null zuruecksetzen, noch bevor es geschrieben wird.
    if new.guess_value is distinct from old.guess_value then
      new.is_correct := null;
      new.points_awarded := null;
    end if;
  end if;

  return new;
end;
$$;

-- "Fresh"-Cutoff (answered_at >= question_opened_at) noetig, weil eine Frage
-- sich in einer spaeteren Runde wiederholen kann (times_asked): die alte
-- responses-Zeile aus einer Vorrunde bleibt sonst stehen (Upsert auf
-- participant_id+question_id) und wuerde faelschlich mitgerechnet, obwohl in
-- DIESER Runde gar nicht neu geantwortet wurde (gleiches Muster wie
-- change_count oben und computeLeaderboard in dashboard-state.js).
create function public.rescore_estimation_responses(target_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct_value numeric;
  v_points integer;
  v_opened_at timestamptz;
begin
  select correct_value, points into v_correct_value, v_points
  from public.question_answers
  where question_id = target_question_id;

  -- Keine Loesung, keine numerische correct_value (Multiple-Choice), oder
  -- target_question_id null (Frage nie geoeffnet) -> nichts zu tun.
  if v_correct_value is null then
    return;
  end if;

  select question_opened_at into v_opened_at
  from public.quiz_sessions
  where current_question_id = target_question_id;

  with fresh as (
    select id, abs(guess_value - v_correct_value) as distance
    from public.responses
    where question_id = target_question_id
      and guess_value is not null
      and (v_opened_at is null or answered_at >= v_opened_at)
  ),
  best as (
    select min(distance) as min_distance from fresh
  )
  update public.responses r
  set is_correct = (f.distance = b.min_distance),
      points_awarded = case when f.distance = b.min_distance then v_points else 0 end
  from fresh f, best b
  where r.id = f.id;
end;
$$;

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

    if current_status = 'open' and current_qid = target_question_id then
      return;
    end if;

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
    select current_question_id into current_qid from public.quiz_sessions limit 1;

    update public.quiz_sessions set status = 'closed' where true;

    -- Neu: Schaetzfragen-Scoring steht erst jetzt fest, alle Antworten sind da.
    perform public.rescore_estimation_responses(current_qid);

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
    set round_question_ids = picked_ids, current_question_id = null, status = 'lobby', round_started_at = now()
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
