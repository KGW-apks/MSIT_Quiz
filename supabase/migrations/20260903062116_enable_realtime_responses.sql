-- Noetig fuer den Live-Antwortzaehler im Presenter-View: ohne das feuert
-- postgres_changes fuer responses nie (gleicher Grund wie bei quiz_sessions).
alter publication supabase_realtime add table public.responses;

-- Presenter-View braucht die eine Session-Zeile, um current_question_id/status
-- umschalten zu koennen. quiz_sessions hat bewusst keine INSERT-Policy (nur die
-- eine Zeile soll je existieren), also wird sie hier einmalig, idempotent geseedet.
insert into public.quiz_sessions (status)
select 'lobby'
where not exists (select 1 from public.quiz_sessions);
