-- Die Abschluss-Auswertung soll zeigen, wer sich waehrend des Quiz am meisten
-- umentschieden hat (Antwort mehrfach
-- gewechselt, seit Migration editable_responses_and_default_timer erlaubt,
-- solange die Frage offen ist). Dafuer ein neuer Zaehler change_count auf
-- responses, vom Scoring-Trigger mitgefuehrt statt vom Client gesetzt (gleiche
-- Ueberschreib-Logik wie is_correct/points_awarded/latency_ms, DevTools-sicher).
--
-- Reopen-Faelle (Frage wiederholt sich in einer spaeteren Runde, times_asked
-- erlaubt das): die responses-Zeile bleibt unter derselben question_id stehen
-- (Upsert), OHNE Reset wuerde eine Erstantwort in der neuen Runde faelschlich
-- als "Wechsel" gegenueber der letzten Antwort der VORrunde gezaehlt werden --
-- derselbe Fehler wie beim frisch/nicht-frisch-Bug (siehe quiz-state.js).
-- question_opened_at wird bei jedem (Wieder-)Oeffnen neu gestempelt, dient
-- hier als derselbe Cutoff: eine Antwort von VOR diesem Zeitpunkt zaehlt als
-- nicht vorhanden, die naechste ist also eine frische Erstantwort (change_count
-- startet wieder bei 0), kein Wechsel.

alter table public.responses
  add column change_count integer not null default 0;

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
  rel_error numeric;
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
    -- Frage wurde seit der zuletzt gespeicherten Antwort neu geoeffnet (Wieder-
    -- holung in einer spaeteren Runde): frische Erstantwort, kein Wechsel.
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
    if answer.correct_value = 0 then
      new.is_correct := (new.guess_value = 0);
      new.points_awarded := case when new.guess_value = 0 then answer.points else 0 end;
    else
      rel_error := abs(new.guess_value - answer.correct_value) / abs(answer.correct_value);
      new.points_awarded := round(answer.points * greatest(0, 1 - rel_error));
      new.is_correct := (new.points_awarded = answer.points);
    end if;
  end if;

  return new;
end;
$$;
