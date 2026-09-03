-- Dashboard braucht die Loesung fuers Reveal (Balkendiagramm markiert die richtige
-- Antwort, Schaetzfragen zeigen den korrekten Wert). question_answers hatte bisher
-- bewusst gar keine Policy (Cheat-Schutz waehrend der laufenden Frage).
-- Diese Policy oeffnet die Zeile NUR, wenn die Frage nicht mehr die aktive,
-- offene Frage ist, sondern bereits geschlossen wurde: exakt der Reveal-Moment,
-- nicht frueher. Waehrend eine Frage "open" ist, bleibt sie weiterhin komplett
-- unlesbar, unabhaengig davon was current_question_id gerade ist.
create policy question_answers_select_after_close on public.question_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.quiz_sessions
      where quiz_sessions.current_question_id = question_answers.question_id
        and quiz_sessions.status in ('closed', 'finished')
    )
  );
