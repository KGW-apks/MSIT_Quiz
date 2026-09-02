// Reine Entscheidungslogik, ohne DOM/Supabase-Zugriff, damit sie ohne Browser testbar ist.

export function deriveViewState({ status, currentQuestion, myResponse }) {
  if (status === 'finished') {
    return { view: 'finished' };
  }
  if (status === 'lobby' || !currentQuestion) {
    return { view: 'lobby' };
  }
  if (myResponse) {
    return { view: 'waiting', question: currentQuestion };
  }
  if (status === 'open') {
    return { view: 'question', question: currentQuestion };
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
