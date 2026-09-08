// Reine Entscheidungslogik, ohne DOM/Supabase-Zugriff, damit sie ohne Browser testbar ist.

// Faengt Fragen-Wiederholungen ab (Runde 2 waehlt dieselbe Frage erneut, times_asked
// erlaubt das ausdruecklich): responses laeuft per Upsert auf (participant_id,
// question_id), die Zeile aus einer frueheren Runde bleibt also unter derselben
// question_id stehen. question_opened_at wird bei JEDEM (Wieder-)Oeffnen der Frage
// serverseitig neu gestempelt (Trigger stamp_question_opened_at), ist also der
// zuverlaessige Cutoff: eine Antwort von VOR diesem Zeitpunkt gehoert zu einer
// frueheren Runde und zaehlt fuer die aktuelle Anzeige als nicht vorhanden.
// Ohne diesen Cutoff wuerde bei einer Wiederholung die alte Antwort direkt
// vorausgewaehlt/eingeloggt, statt "frisch" zu starten.
function isFreshResponse(myResponse, questionOpenedAt) {
  if (!myResponse) return false;
  if (!questionOpenedAt) return true;
  return new Date(myResponse.answered_at).getTime() >= new Date(questionOpenedAt).getTime();
}

// Solange die Frage offen ist, darf die Antwort beliebig oft geaendert werden.
// "waiting" (fest eingereicht, keine Aenderung mehr moeglich) gibt es deshalb
// nur noch NACH dem Schliessen, nicht mehr schon waehrend status === 'open'.
// myResponse wird im question-view mitgegeben, damit
// die UI die zuletzt gespeicherte Auswahl vorbefuellen/markieren kann.
export function deriveViewState({ status, currentQuestion, myResponse, questionOpenedAt }) {
  if (status === 'finished') {
    return { view: 'finished' };
  }
  if (status === 'lobby' || !currentQuestion) {
    return { view: 'lobby' };
  }
  const fresh = isFreshResponse(myResponse, questionOpenedAt) ? myResponse : null;
  if (status === 'open') {
    return { view: 'question', question: currentQuestion, myResponse: fresh };
  }
  if (fresh) {
    return { view: 'waiting', question: currentQuestion };
  }
  // status === 'closed', nie (frisch) beantwortet: Frage verpasst.
  return { view: 'missed', question: currentQuestion };
}

// Deutsches Dezimalkomma zulassen, alles andere Ungueltige als null melden statt NaN durchzureichen.
export function parseGuessValue(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}
