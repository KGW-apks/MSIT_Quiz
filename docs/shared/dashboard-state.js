// Reine Aggregations- und Auswertungslogik fuers Presenter-Dashboard.
// Kein DOM/Supabase/Chart.js-Zugriff, damit sie ohne Browser testbar ist.

// Reveal-Gate: die Ergebnisse der aktuellen Frage werden erst gezeigt, wenn sie
// nicht mehr "open" ist (siehe quiz-timer.js fuer die Auto-Close-Regel selbst).
export function isRevealed(session) {
  return session?.status === 'closed' || session?.status === 'finished';
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function nameLookup(participants) {
  const byId = new Map(participants.map((p) => [p.id, p.display_name]));
  return (participantId) => byId.get(participantId) ?? '?';
}

export function aggregateMultipleChoice({ question, responses, participants, correctOption = null }) {
  const options = question.options ?? [];
  const nameOf = nameLookup(participants);
  return options.map((option) => {
    const matching = responses.filter((r) => r.question_id === question.id && r.selected_option === option);
    return {
      label: option,
      count: matching.length,
      isCorrect: correctOption !== null && option === correctOption,
      voters: matching.map((r) => nameOf(r.participant_id)),
    };
  });
}

// Bis zu maxBars Balken, ein Balken pro genanntem Wert. Bei mehr verschiedenen
// Werten als maxBars wird stattdessen in gleich breite Bereiche gebucketet,
// damit der Graph bei sehr gestreuten Schaetzungen nicht unlesbar wird.
export function aggregateEstimation({ question, responses, participants, correctValue = null, maxBars = 12 }) {
  const nameOf = nameLookup(participants);
  const own = responses.filter((r) => r.question_id === question.id && typeof r.guess_value === 'number');

  if (own.length === 0) return { bars: [], binned: false };

  const distinct = [...new Set(own.map((r) => r.guess_value))].sort((a, b) => a - b);

  if (distinct.length <= maxBars) {
    return {
      binned: false,
      bars: distinct.map((value) => {
        const matching = own.filter((r) => r.guess_value === value);
        return {
          label: formatNumber(value),
          count: matching.length,
          isCorrect: correctValue !== null && value === correctValue,
          voters: matching.map((r) => nameOf(r.participant_id)),
        };
      }),
    };
  }

  const values = own.map((r) => r.guess_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / maxBars;
  const buckets = Array.from({ length: maxBars }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    responses: [],
  }));
  for (const response of own) {
    const idx = Math.min(maxBars - 1, Math.floor((response.guess_value - min) / width));
    buckets[idx].responses.push(response);
  }

  return {
    binned: true,
    bars: buckets.map((b) => ({
      label: `${formatNumber(b.from)}–${formatNumber(b.to)}`,
      count: b.responses.length,
      isCorrect: correctValue !== null && correctValue >= b.from && correctValue <= b.to,
      voters: b.responses.map((r) => nameOf(r.participant_id)),
    })),
  };
}

// Wie viele Fragen sind bereits abgeschlossen (durch), wie viele stehen noch aus.
// "Durch" heisst: geschlossen, oder eine frueher positionierte Frage als die
// aktuelle. Die laufende, noch offene Frage zaehlt bewusst noch nicht als durch.
export function computeQuestionProgress({ session, questions }) {
  const total = questions.length;
  if (!session || session.status === 'lobby' || !session.current_question_id) {
    return { done: 0, total };
  }
  if (session.status === 'finished') {
    return { done: total, total };
  }
  const current = questions.find((q) => q.id === session.current_question_id);
  if (!current) return { done: 0, total };
  const before = questions.filter((q) => q.position < current.position).length;
  return { done: session.status === 'closed' ? before + 1 : before, total };
}

export function computeLeaderboard({ participants, responses }) {
  return participants
    .map((participant) => {
      const mine = responses.filter((r) => r.participant_id === participant.id);
      const totalPoints = mine.reduce((sum, r) => sum + (r.points_awarded ?? 0), 0);
      const correctCount = mine.filter((r) => r.is_correct).length;
      const latencies = mine.filter((r) => r.latency_ms != null).map((r) => r.latency_ms);
      const avgLatencyMs = latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;
      return { participant, totalPoints, answeredCount: mine.length, correctCount, avgLatencyMs };
    })
    .sort((a, b) => b.totalPoints - a.totalPoints);
}

// Eine Punkte-Verlaufs-Reihe pro Teilnehmer, kumuliert ueber alle Fragen in
// Positions-Reihenfolge (fuers Liniendiagramm).
export function computePointsProgression({ participants, responses, questions }) {
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  return participants.map((participant) => {
    let running = 0;
    const series = ordered.map((question) => {
      const response = responses.find(
        (r) => r.participant_id === participant.id && r.question_id === question.id
      );
      running += response?.points_awarded ?? 0;
      return running;
    });
    return { participant, series };
  });
}

// Fuer die Abschluss-Auswertung: schnellste richtige Antwort ueber alle Fragen,
// und welche Frage die meisten falschen Antworten hatte.
export function computeClosingStats({ participants, responses, questions }) {
  let fastest = null;
  for (const r of responses) {
    if (r.is_correct && r.latency_ms != null && (fastest === null || r.latency_ms < fastest.latency_ms)) {
      fastest = r;
    }
  }

  const missesByQuestion = new Map();
  for (const r of responses) {
    if (r.is_correct === false) {
      missesByQuestion.set(r.question_id, (missesByQuestion.get(r.question_id) ?? 0) + 1);
    }
  }
  let hardest = null;
  for (const [questionId, misses] of missesByQuestion) {
    if (!hardest || misses > hardest.misses) hardest = { questionId, misses };
  }

  return {
    fastestCorrect: fastest
      ? {
          participant: participants.find((p) => p.id === fastest.participant_id) ?? null,
          latencyMs: fastest.latency_ms,
        }
      : null,
    hardestQuestion: hardest
      ? {
          question: questions.find((q) => q.id === hardest.questionId) ?? null,
          misses: hardest.misses,
        }
      : null,
  };
}
