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

// Wie viele Fragen der aktuellen RUNDE sind bereits abgeschlossen (durch), wie
// viele stehen noch aus. "Durch" heisst: geschlossen, oder eine Frage, die in
// der Runden-Auswahlreihenfolge vor der aktuellen liegt. roundQuestionIds ist
// session.round_question_ids (Reihenfolge = Auswahlreihenfolge aus start_round,
// dieselbe Reihenfolge, in der der Presenter die Zeilen sieht). Katalog-position
// ist hier bewusst NICHT die Grundlage: die Runde ist eine zufaellige Teilmenge
// des wachsenden Katalogs, Positionen darin sind nicht fortlaufend/aussagekraeftig.
export function computeQuestionProgress({ session, roundQuestionIds }) {
  const ids = roundQuestionIds ?? [];
  const total = ids.length;
  if (!session || session.status === 'lobby' || !session.current_question_id) {
    return { done: 0, total };
  }
  if (session.status === 'finished') {
    return { done: total, total };
  }
  const currentIndex = ids.indexOf(session.current_question_id);
  if (currentIndex === -1) return { done: 0, total };
  return { done: session.status === 'closed' ? currentIndex + 1 : currentIndex, total };
}

// Filtert responses auf die AKTUELLE Runde: sowohl question_id muss Teil der
// Runde sein, als auch answered_at nicht vor deren Start liegen. Der zweite
// Teil ist noetig, weil eine wiederholte Frage (times_asked erlaubt das) unter
// derselben question_id die alte Antwortzeile aus einer frueheren Runde stehen
// laesst (responses laeuft per Upsert auf participant_id+question_id) -- ohne
// den Zeit-Cutoff wuerde die als in dieser Runde beantwortet mitzaehlen, auch
// wenn hier gar nicht neu geantwortet wurde.
export function filterToRound(responses, { roundQuestionIds, roundStartedAt }) {
  if (!roundQuestionIds) return responses;
  const idSet = new Set(roundQuestionIds);
  const startedAtMs = roundStartedAt ? new Date(roundStartedAt).getTime() : null;
  return responses.filter((r) => {
    if (!idSet.has(r.question_id)) return false;
    if (startedAtMs !== null && new Date(r.answered_at).getTime() < startedAtMs) return false;
    return true;
  });
}

// Reveal-Gate gilt jetzt auch fuers Leaderboard, nicht nur fuers Ergebnis-Diagramm
// der laufenden Frage: Multiple-Choice-Antworten werden sofort bei Insert gewertet
// (score_response()-Trigger), ohne diesen Filter waere der Punktestand also live
// mitgelaufen, waehrend die Frage noch offen ist -- auf dem projizierten Dashboard
// fuer alle sichtbar, ein Schummel-Vektor. Nur die AKTUELL
// offene Frage wird ausgeblendet, bereits geschlossene Fragen derselben Runde
// zaehlen normal weiter.
export function computeLeaderboard({ participants, responses, roundQuestionIds = null, roundStartedAt = null, session = null }) {
  const roundResponses = filterToRound(responses, { roundQuestionIds, roundStartedAt })
    .filter((r) => isRevealed(session) || !session?.current_question_id || r.question_id !== session.current_question_id);
  return participants
    .map((participant) => {
      const mine = roundResponses.filter((r) => r.participant_id === participant.id);
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

// Fuer die Abschluss-Auswertung, jeweils nur ueber die AKTUELLE Runde (gleicher
// Rundenfilter wie beim Leaderboard, gleicher Grund: sonst zaehlt eine
// wiederholte Frage die alte Antwort aus einer frueheren Runde mit).
//
// "Schwerste Frage" bewusst umbenannt zu mostMissedQuestion/"am haeufigsten
// falsch beantwortet": "schwerste Frage" suggeriert Schwierigkeit als objektive
// Eigenschaft der Frage, obwohl es nur eine simple Fehlerzaehlung ueber genau
// diese Teilnehmer in genau dieser Runde ist.
export function computeClosingStats({ participants, responses, questions, roundQuestionIds = null, roundStartedAt = null }) {
  const roundResponses = filterToRound(responses, { roundQuestionIds, roundStartedAt });
  let fastest = null;
  for (const r of roundResponses) {
    if (r.is_correct && r.latency_ms != null && (fastest === null || r.latency_ms < fastest.latency_ms)) {
      fastest = r;
    }
  }

  const missesByQuestion = new Map();
  for (const r of roundResponses) {
    if (r.is_correct === false) {
      missesByQuestion.set(r.question_id, (missesByQuestion.get(r.question_id) ?? 0) + 1);
    }
  }
  let mostMissed = null;
  for (const [questionId, misses] of missesByQuestion) {
    if (!mostMissed || misses > mostMissed.misses) mostMissed = { questionId, misses };
  }

  // Wer hat waehrend der Runde am meisten die Antwort gewechselt.
  // change_count kommt serverseitig vom Scoring-Trigger
  // (siehe Migration track_answer_changes), zaehlt schon korrekt auf 0 zurueck,
  // wenn eine Frage in dieser Runde frisch (wieder-)geoeffnet wurde -- kein
  // zusaetzlicher Rundenbezug hier noetig, roundResponses filtert nur die
  // Fragen dieser Runde selbst.
  const changesByParticipant = new Map();
  for (const r of roundResponses) {
    if (!r.change_count) continue;
    changesByParticipant.set(r.participant_id, (changesByParticipant.get(r.participant_id) ?? 0) + r.change_count);
  }
  let mostIndecisive = null;
  for (const [participantId, changeCount] of changesByParticipant) {
    if (!mostIndecisive || changeCount > mostIndecisive.changeCount) mostIndecisive = { participantId, changeCount };
  }

  return {
    fastestCorrect: fastest
      ? {
          participant: participants.find((p) => p.id === fastest.participant_id) ?? null,
          latencyMs: fastest.latency_ms,
        }
      : null,
    mostMissedQuestion: mostMissed
      ? {
          question: questions.find((q) => q.id === mostMissed.questionId) ?? null,
          misses: mostMissed.misses,
        }
      : null,
    mostIndecisive: mostIndecisive
      ? {
          participant: participants.find((p) => p.id === mostIndecisive.participantId) ?? null,
          changeCount: mostIndecisive.changeCount,
        }
      : null,
  };
}
