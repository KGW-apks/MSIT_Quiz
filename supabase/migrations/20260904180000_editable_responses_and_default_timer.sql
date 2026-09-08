-- Zwei zusammenhaengende Aenderungen fuers automatische, Timer-getriebene
-- Rundenspiel: jede Frage bekommt standardmaessig 30 Sekunden, und
-- Teilnehmer duerfen ihre Antwort aendern, solange die Frage noch offen ist
-- (nicht mehr nur einmal einsenden).

-- 1) Zeitlimit: bisher optional und leer (nur per SQL-Editor gesetzt). Katalog
-- bekommt jetzt einheitlich 30s, neue Fragen ab jetzt per Default ebenfalls.
update public.questions set time_limit_seconds = 30 where time_limit_seconds is distinct from 30;
alter table public.questions alter column time_limit_seconds set default 30;

-- 2) Antworten korrigierbar machen: bisher nur INSERT erlaubt (unique
-- participant_id+question_id verhinderte ein zweites Mal). Die App wechselt
-- jetzt auf upsert() (on conflict do update), dafuer braucht es eine UPDATE-
-- Policy mit demselben "Frage ist noch offen"-Check wie beim INSERT, sonst
-- koennte man nach dem Schliessen (sobald die Loesung sichtbar wird) rueck-
-- wirkend seine Antwort auf die bekannte Loesung aendern.
create policy responses_update_own on public.responses
  for update to authenticated
  using (
    participant_id = auth.uid()
    and exists (
      select 1 from public.quiz_sessions qs
      where qs.current_question_id = question_id
        and qs.status = 'open'
    )
  )
  with check (
    participant_id = auth.uid()
    and exists (
      select 1 from public.quiz_sessions qs
      where qs.current_question_id = question_id
        and qs.status = 'open'
    )
  );

-- Scoring-Trigger muss jetzt auch bei UPDATE neu rechnen (answered_at/
-- latency_ms/is_correct/points_awarded fuer die zuletzt geaenderte Antwort),
-- nicht nur beim ersten INSERT. score_response() selbst braucht keine
-- Aenderung, sie berechnet ohnehin komplett aus new.* neu.
drop trigger responses_score_before_insert on public.responses;

create trigger responses_score_before_insert_or_update
  before insert or update on public.responses
  for each row
  execute function public.score_response();
