// Reine Entscheidungslogik, ohne DOM/Supabase-Zugriff, damit sie ohne Browser testbar ist.

// Seit 2026-09-04: solange die Frage offen ist, darf die Antwort beliebig oft
// geaendert werden (Knuts Vorgabe). "waiting" (fest eingereicht, keine Aenderung
// mehr moeglich) gibt es deshalb nur noch NACH dem Schliessen, nicht mehr schon
// waehrend status === 'open'. myResponse wird im question-view mitgegeben, damit
// die UI die zuletzt gespeicherte Auswahl vorbefuellen/markieren kann.
export function deriveViewState({ status, currentQuestion, myResponse }) {
  if (status === 'finished') {
    return { view: 'finished' };
  }
  if (status === 'lobby' || !currentQuestion) {
    return { view: 'lobby' };
  }
  if (status === 'open') {
    return { view: 'question', question: currentQuestion, myResponse: myResponse ?? null };
  }
  if (myResponse) {
    return { view: 'waiting', question: currentQuestion };
  }
  // status === 'closed', nie beantwortet: Frage verpasst.
  return { view: 'missed', question: currentQuestion };
}

// Deutsches Dezimalkomma zulassen, alles andere Ungueltige als null melden statt NaN durchzureichen.
export function parseGuessValue(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}
