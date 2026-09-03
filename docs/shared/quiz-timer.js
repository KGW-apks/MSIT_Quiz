// Reine Auto-Close-Regel, von Presenter (loest aus) und Dashboard (zeigt Countdown) geteilt.
// Kein DOM/Supabase-Zugriff, damit sie ohne Browser testbar ist.

// Zeitpunkt (ms seit Epoch), zu dem die aktuell offene Frage automatisch schliessen soll,
// oder null wenn kein Zeitlimit gilt bzw. gerade keine Frage offen ist.
export function computeAutoCloseAt({ session, questions }) {
  if (!session || session.status !== 'open' || !session.current_question_id || !session.question_opened_at) {
    return null;
  }
  const question = questions.find((q) => q.id === session.current_question_id);
  if (!question || question.time_limit_seconds == null) return null;
  return new Date(session.question_opened_at).getTime() + question.time_limit_seconds * 1000;
}

// Auto-Close-Regel aus der Projektnotiz: Zeit abgelaufen ODER alle registrierten
// Teilnehmer haben schon geantwortet (fruehreveal, niemand muss auf die Uhr warten).
export function shouldAutoClose({ session, questions, responseCount, participantCount, now }) {
  if (!session || session.status !== 'open') return false;
  if (participantCount > 0 && responseCount >= participantCount) return true;
  const deadline = computeAutoCloseAt({ session, questions });
  return deadline !== null && now >= deadline;
}
