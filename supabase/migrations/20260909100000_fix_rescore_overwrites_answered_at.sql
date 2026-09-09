-- Bug gefunden beim Live-Test der Mercedes-Bonusfrage (2026-09-09): Knut und
-- Knut2 hatten nach dem Schliessen der Frage denselben answered_at-Zeitstempel
-- und dieselbe latency_ms, obwohl sie zu verschiedenen Zeiten geantwortet
-- hatten. Ursache: score_response() feuert "before insert or update" auf
-- responses und hat answered_at/latency_ms bisher UNBEDINGT bei jedem Update
-- auf now() neu gesetzt. rescore_estimation_responses() (Migration
-- estimation_closest_wins) macht beim Schliessen einer Schaetzfrage ein reines
-- UPDATE ... SET is_correct, points_awarded auf ALLE Antworten dieser Frage --
-- das loest denselben Trigger erneut aus und ueberschreibt dabei die echte
-- Antwortzeit mit dem Zeitpunkt des Schliessens. Betraf jede Schaetzfrage im
-- Quiz, nicht nur die Bonusfrage.
--
-- Fix: answered_at/latency_ms werden nur noch dann neu gestempelt, wenn
-- tatsaechlich neu geantwortet wurde (Insert, echter Wechsel von
-- selected_option/guess_value, oder eine frische Erstantwort nach einem
-- Wieder-Oeffnen der Frage) -- exakt dieselben drei Faelle, die auch schon
-- change_count als "echte neue Antwort" erkennt. Ein reines
-- Korrektheits-Update ohne Aenderung der Antwort selbst (der rescore-Fall)
-- laesst answered_at/latency_ms jetzt unangetastet.

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
    new.answered_at := now();
  elsif opened_at is not null and old.answered_at < opened_at then
    new.change_count := 0;
    new.answered_at := now();
  elsif new.selected_option is distinct from old.selected_option
     or new.guess_value is distinct from old.guess_value then
    new.change_count := coalesce(old.change_count, 0) + 1;
    new.answered_at := now();
  else
    -- Kein echter Antwort-Wechsel (z.B. rescore_estimation_responses' reines
    -- is_correct/points_awarded-Update): Antwortzeit bleibt die urspruengliche.
    new.change_count := old.change_count;
    new.answered_at := old.answered_at;
  end if;

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

-- Bestehende, durch den Bug verfaelschte Zeilen reparieren, soweit noch
-- rekonstruierbar: die zwei Antworten auf die Mercedes-Bonusfrage vom
-- Live-Test (beide auf denselben Zeitstempel/Latenz kollabiert). Die echten
-- individuellen Antwortzeiten sind nicht mehr rekonstruierbar (der Bug hat sie
-- overschrieben, bevor dieser Fix kam) -- die Zeilen bleiben stehen, weil sie
-- fuer die Korrektheitsbewertung (is_correct/points_awarded) weiterhin
-- richtig sind, nur latency_ms/answered_at sind fuer diese beiden konkreten
-- Zeilen ab jetzt als "unsicher" zu behandeln. Kein Rueckbau-Skript noetig,
-- die Frage wird nach der Praesentation ohnehin komplett geloescht (siehe
-- Migration bonus_mercedes_question).
