// Reine Entscheidungslogik fuers Presenter-View, ohne DOM/Supabase-Zugriff.
//
// Seit 2026-09-04 zeigt der Presenter nicht mehr alle Runden-Fragen als volle
// Tabelle mit Prompt-Text an (Knuts Vorgabe: Mitschueler sehen per Screenshare
// mit, wie er startet, kuenftige Fragen sollen vorher nicht lesbar sein).
// Statt "rows" gibt es jetzt "options" (nur Nummer + Status, fuers Dropdown)
// und "current" (die aktuell offene/geschlossene Frage inkl. vollem Prompt,
// der ist sicher zu zeigen, das Publikum sieht ihn zeitgleich im Dashboard).

export function buildPresenterView({ session, questions, responses, participantCount }) {
  const status = session?.status ?? 'lobby';
  const currentQuestionId = session?.current_question_id ?? null;
  const roundIds = session?.round_question_ids ?? null;
  const hasActiveRound = Array.isArray(roundIds) && roundIds.length > 0;

  const byId = new Map(questions.map((question) => [question.id, question]));
  const roundQuestions = hasActiveRound
    ? roundIds.map((id) => byId.get(id)).filter(Boolean)
    : [];
  const currentIndex = currentQuestionId ? roundIds.indexOf(currentQuestionId) : -1;

  const options = roundQuestions.map((question, index) => ({
    id: question.id,
    label: `Frage ${index + 1}`,
    isCurrent: question.id === currentQuestionId,
    // Positionsbasiert wie der Dashboard-Fortschrittsbalken (computeQuestionProgress):
    // akzeptierte Vereinfachung, kein eigenes Rundentracking in der DB. Springt
    // der Presenter bewusst zurueck, zeigt das vorruebergehend falsch an.
    alreadyAsked: currentIndex >= 0 && index < currentIndex,
  }));

  const current = currentQuestionId
    ? {
        question: byId.get(currentQuestionId) ?? null,
        badge: status === 'open' || status === 'closed' ? status : 'pending',
        responseCount: responses.filter((r) => r.question_id === currentQuestionId).length,
      }
    : null;

  return {
    status,
    hasActiveRound,
    options,
    current,
    participantCount,
    canClose: status === 'open',
    canFinish: status === 'open' || status === 'closed',
    // Eine neue Runde ueberschreibt die Auswahl der laufenden, deshalb erst
    // wieder erlaubt, wenn keine Runde aktiv ist oder das Quiz schon beendet wurde.
    canStartRound: !hasActiveRound || status === 'finished',
    canCancelRound: hasActiveRound && status !== 'finished',
  };
}

// Naechste Frage der Runde nach der aktuellen (Auswahlreihenfolge aus
// round_question_ids), oder null wenn keine Runde aktiv ist oder die aktuelle
// bereits die letzte war. Grundlage fuers automatische Weiterschalten nach
// dem Reveal (siehe app.js: scheduleAutoAdvance).
export function computeNextQuestionId({ session }) {
  const ids = session?.round_question_ids ?? [];
  const currentId = session?.current_question_id ?? null;
  if (!currentId) return null;
  const index = ids.indexOf(currentId);
  if (index === -1 || index === ids.length - 1) return null;
  return ids[index + 1];
}
