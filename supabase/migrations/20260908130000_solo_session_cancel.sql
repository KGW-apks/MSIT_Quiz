-- Teilnehmer sollen eine laufende Solo-Runde abbrechen und zur Modus-Auswahl
-- zurueckkehren koennen (Knuts Fund beim Live-Testen: bisher nur durch
-- Beantworten aller Fragen verlassbar). Dritter Status "cancelled" statt
-- einfach "finished" zu missbrauchen: haelt abgebrochene und tatsaechlich
-- abgeschlossene Laeufe sauber auseinander, falls spaeter mal ausgewertet
-- wird, wie viele Solo-Runden durchgespielt wurden. tryResumeSoloSession()
-- filtert ohnehin nur auf status = 'running', "cancelled" braucht dort keine
-- Sonderbehandlung.

alter table public.solo_sessions
  drop constraint solo_sessions_status_check;

alter table public.solo_sessions
  add constraint solo_sessions_status_check check (status in ('running', 'finished', 'cancelled'));
