-- Optionales Zeitlimit pro Frage fuers Presenter-Dashboard: laeuft die Zeit ab,
-- schliesst der Presenter die Frage automatisch. NULL = kein Auto-Timer, nur
-- manuelles Schliessen oder "alle haben abgestimmt". Wird wie die Fragen selbst
-- per SQL-Editor gesetzt, nicht ueber die App.
alter table public.questions add column time_limit_seconds integer check (time_limit_seconds is null or time_limit_seconds > 0);
