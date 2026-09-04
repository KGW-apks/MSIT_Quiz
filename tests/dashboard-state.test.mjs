import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRevealed,
  aggregateMultipleChoice,
  aggregateEstimation,
  computeLeaderboard,
  computePointsProgression,
  computeClosingStats,
  computeQuestionProgress,
} from '../docs/shared/dashboard-state.js';

test('isRevealed: nur closed/finished gelten als aufgedeckt', () => {
  assert.equal(isRevealed({ status: 'open' }), false);
  assert.equal(isRevealed({ status: 'lobby' }), false);
  assert.equal(isRevealed({ status: 'closed' }), true);
  assert.equal(isRevealed({ status: 'finished' }), true);
  assert.equal(isRevealed(null), false);
});

test('aggregateMultipleChoice: zaehlt pro Option, markiert die richtige, sammelt Waehler-Namen', () => {
  const question = { id: 'q1', options: ['Berlin', 'Paris', 'Rom'] };
  const participants = [
    { id: 'p1', display_name: 'Anna' },
    { id: 'p2', display_name: 'Ben' },
    { id: 'p3', display_name: 'Chris' },
  ];
  const responses = [
    { question_id: 'q1', selected_option: 'Paris', participant_id: 'p1' },
    { question_id: 'q1', selected_option: 'Paris', participant_id: 'p2' },
    { question_id: 'q1', selected_option: 'Berlin', participant_id: 'p3' },
    { question_id: 'q2', selected_option: 'Paris', participant_id: 'p1' }, // andere Frage, zaehlt nicht mit
  ];
  const result = aggregateMultipleChoice({ question, responses, participants, correctOption: 'Paris' });
  assert.deepEqual(result, [
    { label: 'Berlin', count: 1, isCorrect: false, voters: ['Chris'] },
    { label: 'Paris', count: 2, isCorrect: true, voters: ['Anna', 'Ben'] },
    { label: 'Rom', count: 0, isCorrect: false, voters: [] },
  ]);
});

test('aggregateMultipleChoice: unbekannte participant_id faellt auf "?" zurueck statt zu crashen', () => {
  const question = { id: 'q1', options: ['Ja'] };
  const responses = [{ question_id: 'q1', selected_option: 'Ja', participant_id: 'geloescht' }];
  const result = aggregateMultipleChoice({ question, responses, participants: [], correctOption: 'Ja' });
  assert.deepEqual(result[0].voters, ['?']);
});

test('aggregateEstimation: wenige verschiedene Werte -> ein Balken pro Wert, sortiert, mit Waehler-Namen', () => {
  const question = { id: 'q1' };
  const participants = [
    { id: 'p1', display_name: 'Anna' },
    { id: 'p2', display_name: 'Ben' },
    { id: 'p3', display_name: 'Chris' },
  ];
  const responses = [
    { question_id: 'q1', guess_value: 12, participant_id: 'p1' },
    { question_id: 'q1', guess_value: 10, participant_id: 'p2' },
    { question_id: 'q1', guess_value: 12, participant_id: 'p3' },
  ];
  const result = aggregateEstimation({ question, responses, participants, correctValue: 12 });
  assert.equal(result.binned, false);
  assert.deepEqual(result.bars, [
    { label: '10', count: 1, isCorrect: false, voters: ['Ben'] },
    { label: '12', count: 2, isCorrect: true, voters: ['Anna', 'Chris'] },
  ]);
});

test('aggregateEstimation: keine Antworten -> leere Balken', () => {
  const result = aggregateEstimation({ question: { id: 'q1' }, responses: [], participants: [] });
  assert.deepEqual(result, { bars: [], binned: false });
});

test('aggregateEstimation: viele verschiedene Werte -> Buckets statt Einzelwerte, Waehler pro Bucket gesammelt', () => {
  const question = { id: 'q1' };
  const participants = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, display_name: `P${i}` }));
  const responses = participants.map((p, i) => ({ question_id: 'q1', guess_value: i, participant_id: p.id }));
  const result = aggregateEstimation({ question, responses, participants, maxBars: 5 });
  assert.equal(result.binned, true);
  assert.equal(result.bars.length, 5);
  const totalCount = result.bars.reduce((sum, b) => sum + b.count, 0);
  assert.equal(totalCount, 20);
  const totalVoters = result.bars.reduce((sum, b) => sum + b.voters.length, 0);
  assert.equal(totalVoters, 20);
});

test('computeLeaderboard: summiert Punkte, sortiert absteigend, berechnet Trefferquote und Latenz', () => {
  const participants = [
    { id: 'p1', display_name: 'A' },
    { id: 'p2', display_name: 'B' },
  ];
  const responses = [
    { participant_id: 'p1', points_awarded: 100, is_correct: true, latency_ms: 1000 },
    { participant_id: 'p1', points_awarded: 0, is_correct: false, latency_ms: 2000 },
    { participant_id: 'p2', points_awarded: 200, is_correct: true, latency_ms: 500 },
  ];
  const result = computeLeaderboard({ participants, responses });
  assert.equal(result[0].participant.id, 'p2');
  assert.equal(result[0].totalPoints, 200);
  assert.equal(result[1].participant.id, 'p1');
  assert.equal(result[1].totalPoints, 100);
  assert.equal(result[1].correctCount, 1);
  assert.equal(result[1].answeredCount, 2);
  assert.equal(result[1].avgLatencyMs, 1500);
});

test('computeLeaderboard: Teilnehmer ohne Antworten bekommt 0 Punkte und null-Latenz', () => {
  const result = computeLeaderboard({ participants: [{ id: 'p1', display_name: 'A' }], responses: [] });
  assert.deepEqual(result, [{ participant: { id: 'p1', display_name: 'A' }, totalPoints: 0, answeredCount: 0, correctCount: 0, avgLatencyMs: null }]);
});

test('computePointsProgression: kumuliert Punkte in der uebergebenen Rundenreihenfolge, nicht nach position', () => {
  const participants = [{ id: 'p1' }];
  const roundQuestions = [
    { id: 'q2', position: 2 },
    { id: 'q1', position: 1 },
  ];
  const responses = [
    { participant_id: 'p1', question_id: 'q1', points_awarded: 50 },
    { participant_id: 'p1', question_id: 'q2', points_awarded: 30 },
  ];
  const result = computePointsProgression({ participants, responses, roundQuestions });
  assert.deepEqual(result, [{ participant: { id: 'p1' }, series: [30, 80] }]);
});

test('computePointsProgression: fehlende Antwort zaehlt als 0, Reihe bleibt gleich lang wie Rundengroesse', () => {
  const participants = [{ id: 'p1' }];
  const roundQuestions = [{ id: 'q1', position: 1 }, { id: 'q2', position: 2 }];
  const responses = [{ participant_id: 'p1', question_id: 'q1', points_awarded: 50 }];
  const result = computePointsProgression({ participants, responses, roundQuestions });
  assert.deepEqual(result[0].series, [50, 50]);
});

test('computePointsProgression: keine Runde (leere Liste) -> leere Reihe pro Teilnehmer', () => {
  const result = computePointsProgression({ participants: [{ id: 'p1' }], responses: [], roundQuestions: [] });
  assert.deepEqual(result, [{ participant: { id: 'p1' }, series: [] }]);
});

test('computeClosingStats: findet schnellste richtige Antwort und schwerste Frage', () => {
  const participants = [{ id: 'p1', display_name: 'Schnell' }, { id: 'p2', display_name: 'Langsam' }];
  const questions = [{ id: 'q1', prompt: 'Frage 1' }, { id: 'q2', prompt: 'Frage 2' }];
  const responses = [
    { participant_id: 'p1', question_id: 'q1', is_correct: true, latency_ms: 500 },
    { participant_id: 'p2', question_id: 'q1', is_correct: true, latency_ms: 1500 },
    { participant_id: 'p1', question_id: 'q2', is_correct: false, latency_ms: 900 },
    { participant_id: 'p2', question_id: 'q2', is_correct: false, latency_ms: 800 },
  ];
  const result = computeClosingStats({ participants, responses, questions });
  assert.equal(result.fastestCorrect.participant.display_name, 'Schnell');
  assert.equal(result.fastestCorrect.latencyMs, 500);
  assert.equal(result.hardestQuestion.question.prompt, 'Frage 2');
  assert.equal(result.hardestQuestion.misses, 2);
});

test('computeClosingStats: keine Antworten -> beide Werte null', () => {
  const result = computeClosingStats({ participants: [], responses: [], questions: [] });
  assert.deepEqual(result, { fastestCorrect: null, hardestQuestion: null });
});

const progressRoundIds = ['q1', 'q2', 'q3'];

test('computeQuestionProgress: kein Session-Objekt, lobby oder keine Runde -> 0 von N', () => {
  assert.deepEqual(computeQuestionProgress({ session: null, roundQuestionIds: progressRoundIds }), { done: 0, total: 3 });
  assert.deepEqual(
    computeQuestionProgress({ session: { status: 'lobby', current_question_id: null }, roundQuestionIds: progressRoundIds }),
    { done: 0, total: 3 }
  );
  assert.deepEqual(computeQuestionProgress({ session: { status: 'lobby' }, roundQuestionIds: null }), { done: 0, total: 0 });
});

test('computeQuestionProgress: status open -> Fragen davor (in Rundenreihenfolge) zaehlen als durch, die laufende noch nicht', () => {
  const session = { status: 'open', current_question_id: 'q2' };
  assert.deepEqual(computeQuestionProgress({ session, roundQuestionIds: progressRoundIds }), { done: 1, total: 3 });
});

test('computeQuestionProgress: status closed -> die laufende Frage zaehlt jetzt mit dazu', () => {
  const session = { status: 'closed', current_question_id: 'q2' };
  assert.deepEqual(computeQuestionProgress({ session, roundQuestionIds: progressRoundIds }), { done: 2, total: 3 });
});

test('computeQuestionProgress: status finished -> alle Fragen durch, unabhaengig von current_question_id', () => {
  const session = { status: 'finished', current_question_id: 'q1' };
  assert.deepEqual(computeQuestionProgress({ session, roundQuestionIds: progressRoundIds }), { done: 3, total: 3 });
});

test('computeQuestionProgress: erste Frage offen -> 0 durch', () => {
  const session = { status: 'open', current_question_id: 'q1' };
  assert.deepEqual(computeQuestionProgress({ session, roundQuestionIds: progressRoundIds }), { done: 0, total: 3 });
});
