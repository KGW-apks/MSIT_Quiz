// Reine Entscheidungslogik fuers Presenter-View, ohne DOM/Supabase-Zugriff.
//
// Die Fragenliste zeigt nicht mehr den ganzen Katalog (der waechst, aktuell
// 116 Fragen), sondern nur die per "Runde starten" ausgewaehlte Teilmenge
// (session.round_question_ids, Reihenfolge = Auswahlreihenfolge aus der DB).
// Ohne aktive Runde gibt es nichts zu steuern, canStartRound zeigt dann den
// Weg dorthin.

export function buildPresenterView({ session, questions, responses, participantCount }) {
  const status = session?.status ?? 'lobby';
  const currentQuestionId = session?.current_question_id ?? null;
  const roundIds = session?.round_question_ids ?? null;
  const hasActiveRound = Array.isArray(roundIds) && roundIds.length > 0;

  const byId = new Map(questions.map((question) => [question.id, question]));
  const roundQuestions = hasActiveRound
    ? roundIds.map((id) => byId.get(id)).filter(Boolean)
    : [];

  const rows = roundQuestions.map((question) => {
    const isCurrent = question.id === currentQuestionId;
    const badge = isCurrent && (status === 'open' || status === 'closed') ? status : 'pending';
    const responseCount = responses.filter((r) => r.question_id === question.id).length;
    return { question, badge, responseCount };
  });

  return {
    status,
    hasActiveRound,
    rows,
    participantCount,
    canClose: status === 'open',
    canFinish: status === 'open' || status === 'closed',
    // Eine neue Runde ueberschreibt die Auswahl der laufenden, deshalb erst
    // wieder erlaubt, wenn keine Runde aktiv ist oder das Quiz schon beendet wurde.
    canStartRound: !hasActiveRound || status === 'finished',
    canCancelRound: hasActiveRound && status !== 'finished',
  };
}
