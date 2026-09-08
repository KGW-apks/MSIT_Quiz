-- Zwei Schaetzfragen aus dem Fragenkatalog-Import hatten keinen exakten
-- Punktwert im Katalogtext (Frage 22: nur "ueber 50 %" ohne Obergrenze,
-- Frage 154: ein Bereich "480-500x"), deshalb vorlaeufig mit 50 bzw. 490
-- importiert (siehe Fragenkatalog-Notiz, Korrektur-Log Punkt 7). Diese
-- Migration setzt die tatsaechlich im Kurs genannten Werte: 70 % (Frage 22)
-- und 500x (Frage 154). Frage 22 zusaetzlich umformuliert, weil der alte
-- Fragetext den McKinsey-Vergleichswert (30 %) unnoetig mit hineinzog.

update public.questions
set prompt = 'Im Kurs wurde unter Berufung auf McKinsey genannt, dass einzelne KI-Use-Cases deutlich häufiger scheitern als klassische IT-Projekte. Wie hoch ist der Anteil an Projekten die scheitern?'
where position = 22;

update public.question_answers
set correct_value = 70.0
where question_id = (select id from public.questions where position = 22);

update public.question_answers
set correct_value = 500.0
where question_id = (select id from public.questions where position = 154);
