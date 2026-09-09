-- Temporaere Bonus-Schaetzfrage nur fuer Knuts Abschlusspraesentation, kein
-- Teil des kuratierten 117er-Fragenkatalogs. Siehe Vault-Notiz "Fragenkatalog"
-- im Live-Quiz-Tool-Projekt, Abschnitt "Bonus-Frage (temporaer, nur fuer die
-- Praesentation)". Antwort (164) wurde real gegen die Rohtranskripte unter
-- C:\Users\wichm\Videos\MSIT ausgezaehlt (Sprecher-Tag "Instructor: Marcel De
-- Sutter", Teilstring "mercedes" case-insensitive, 121 von 127 Aufzeichnungen
-- lagen als Transkript vor).
--
-- position = 9001 bewusst weit ausserhalb des Katalog-Nummernraums (1-164),
-- damit sie nie mit einer echten Katalogfrage kollidiert. tier_primary =
-- 'BONUS' markiert sie als Sonderfall, kein Wert aus dem T1-T5-Schema.
--
-- WICHTIG: presenter_control() erlaubt "open" nur fuer Fragen, die in
-- quiz_sessions.round_question_ids stehen, sobald eine Runde aktiv ist. Diese
-- Frage muss darum am Praesentationstag manuell in die laufende Runde
-- eingefuegt werden, z.B.:
--
--   update public.quiz_sessions
--   set round_question_ids = round_question_ids || array['4c80b204-db00-448d-9ec5-81ffedee6d70']::uuid[]
--   where true;
--
-- Nach der Praesentation kann die Frage wieder entfernt werden (siehe
-- Kommentar am Ende dieser Datei).

insert into public.questions (id, prompt, question_type, options, position, tier_primary, tier_secondary) values
  ('4c80b204-db00-448d-9ec5-81ffedee6d70', 'Wie oft hat Marcel insgesamt das Wort "Mercedes" in unserer Ausbildung erwähnt?', 'estimation', null, 9001, 'BONUS', null);

insert into public.question_answers (question_id, correct_option, correct_value, points) values
  ('4c80b204-db00-448d-9ec5-81ffedee6d70', null, 164.0, 1);

-- Rueckbau nach der Praesentation (nicht Teil dieser Migration, nur als
-- Rezept dokumentiert, da die Frage bewusst temporaer ist):
--
--   delete from public.question_answers where question_id = '4c80b204-db00-448d-9ec5-81ffedee6d70';
--   delete from public.questions where id = '4c80b204-db00-448d-9ec5-81ffedee6d70';
