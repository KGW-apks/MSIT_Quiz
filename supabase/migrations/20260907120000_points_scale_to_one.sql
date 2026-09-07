-- Knuts Vorgabe 2026-09-07: Fragen sollen 1 Punkt geben statt 100, damit die
-- Zahlen (Leaderboard, Diagramme) im Kopf ueberschaubar bleiben. Alle Fragen
-- im Katalog stehen bisher einheitlich auf 100 (siehe import_fragenkatalog),
-- deshalb reicht ein pauschales Zuruecksetzen auf 1 statt einer differenzierten
-- Migration je Frage.
--
-- Nebenwirkung bei Schaetzfragen: score_response() rundet den Teilpunkt-Anteil
-- (points * (1 - relativer Fehler)) auf eine Ganzzahl. Bei points=1 kollabiert
-- das bisherige granulare Teilpunkte-System (z.B. 73 von 100 fuer eine nahe
-- Schaetzung) auf ein Alles-oder-nichts ab/unter 50% relativer Abweichung
-- (round() rundet ab 0.5 auf, sonst auf 0 ab). Multiple-Choice ist davon nicht
-- betroffen (war schon vorher binaer voll/0 Punkte).
alter table public.question_answers
  alter column points set default 1;

update public.question_answers
set points = 1
where points <> 1;
