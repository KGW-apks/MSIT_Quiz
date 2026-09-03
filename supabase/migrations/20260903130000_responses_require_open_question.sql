-- Bisher pruefte die Insert-Policy auf responses nur, dass die eigene
-- participant_id verwendet wird, nicht ob die Frage gerade offen ist. Damit
-- konnte jemand nach dem Schliessen einer Frage (sobald question_answers per
-- Reveal-Policy lesbar wird) rueckwirkend eine "Antwort" mit der jetzt
-- bekannten Loesung einreichen und volle Punktzahl kassieren, ohne live
-- mitgespielt zu haben. Fix: Insert nur noch erlaubt, wenn diese Frage
-- tatsaechlich die aktuell offene ist.
drop policy responses_insert_own on public.responses;

create policy responses_insert_own on public.responses
  for insert to authenticated
  with check (
    participant_id = auth.uid()
    and exists (
      select 1
      from public.quiz_sessions qs
      where qs.current_question_id = question_id
        and qs.status = 'open'
    )
  );
