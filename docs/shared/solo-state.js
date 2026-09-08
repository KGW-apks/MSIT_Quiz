// Reine Entscheidungs-/Aggregationslogik fuers Solo-Quiz, ohne DOM/Supabase-
// Zugriff, damit sie ohne Browser testbar ist (gleiches Muster wie quiz-state.js
// und dashboard-state.js).

// Fisher-Yates-Shuffle, dann die ersten `count` Fragen. Wirft, statt still
// weniger als gewuenscht zurueckzugeben, damit ein zu hoher Wunsch (mehr Fragen
// als der Katalog hergibt) im UI klar als Fehler ankommt statt eine zu kurze
// Runde unbemerkt durchlaufen zu lassen.
export function pickRandomQuestions(questions, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Anzahl Fragen muss mindestens 1 sein');
  }
  if (count > questions.length) {
    throw new Error(`Nur ${questions.length} Fragen im Katalog vorhanden`);
  }
  const shuffled = [...questions];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function formatValue(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Menschlich lesbare Zusammenfassung der eigenen Antwort auf eine Frage, fuers
// Ergebnis-Panel direkt nach dem Absenden UND fuer die Abschluss-Auswertung.
export function describeAnswer(question, response, answer) {
  if (question.question_type === 'multiple_choice') {
    return {
      yourAnswer: response?.selected_option ?? null,
      correctAnswer: answer?.correct_option ?? null,
    };
  }
  return {
    yourAnswer: response?.guess_value != null ? formatValue(response.guess_value) : null,
    correctAnswer: answer?.correct_value != null ? formatValue(answer.correct_value) : null,
  };
}

// Fasst einen abgeschlossenen Solo-Lauf zusammen: Gesamtpunktzahl, Trefferquote,
// und eine Zeile pro Frage (in der Reihenfolge questionIds, das ist die
// Spielreihenfolge). Fehlt zu einer Frage eine Antwort (z.B. Lauf per Reload
// abgebrochen und nie beendet), zaehlt sie als nicht beantwortet statt den
// ganzen Aufruf zum Absturz zu bringen.
export function computeSoloResult({ questionIds, questions, responses, answers }) {
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const responseByQuestionId = new Map(responses.map((r) => [r.question_id, r]));
  const answerByQuestionId = new Map(answers.map((a) => [a.question_id, a]));

  const rows = questionIds.map((questionId) => {
    const question = questionById.get(questionId) ?? null;
    const response = responseByQuestionId.get(questionId) ?? null;
    const answer = answerByQuestionId.get(questionId) ?? null;
    const { yourAnswer, correctAnswer } = question
      ? describeAnswer(question, response, answer)
      : { yourAnswer: null, correctAnswer: null };
    return {
      question,
      isCorrect: response?.is_correct ?? false,
      pointsAwarded: response?.points_awarded ?? 0,
      latencyMs: response?.latency_ms ?? null,
      yourAnswer,
      correctAnswer,
    };
  });

  const totalCount = rows.length;
  const correctCount = rows.filter((r) => r.isCorrect).length;
  const totalPoints = rows.reduce((sum, r) => sum + r.pointsAwarded, 0);
  const latencies = rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  return {
    totalCount,
    correctCount,
    totalPoints,
    accuracyPct: totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0,
    avgLatencyMs,
    rows,
  };
}
