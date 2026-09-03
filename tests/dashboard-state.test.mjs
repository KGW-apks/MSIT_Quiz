import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRevealed,
  aggregateMultipleChoice,
  aggregateEstimation,
  computeLeaderboard,
  computePointsProgression,
  computeClosingStats,
} from '../docs/shared/dashboard-state.js';

test('isRevealed: nur closed/finished gelten als aufgedeckt', () => {
  assert.equal(isRevealed({ status: 'open' }), false);
  assert.equal(isRevealed({ status: 'lobby' }), false);
  assert.equal(isRevealed({ status: 'closed' }), true);
  assert.equal(isRevealed({ status: 'finished' }), true);
  assert.equal(isRevealed(null), false);
});

test('aggregateMultipleChoice: zaehlt pro Option, markiert die richtige', () => {
  const question = { id: 'q1', options: ['Berlin', 'Paris', 'Rom'] };
  const responses = [
    { question_id: 'q1', selected_option: 'Paris' },
    { question_id: 'q1', selected_option: 'Paris' },
    { question_id: 'q1', selected_option: 'Berlin' },
    { question_id: 'q2', selected_option: 'Paris' }, // andere Frage, zaehlt nicht mit
  ];
  const result = aggregateMultipleChoice({ question, responses, correctOption: 'Paris' });
  assert.deepEqual(result, [
    { label: 'Berlin', count: 1, isCorrect: false },
    { label: 'Paris', count: 2, isCorrect: true },
    { label: 'Rom', count: 0, isCorrect: false },
  ]);
});

test('aggregateEstimation: wenige verschiedene Werte -> ein Balken pro Wert, sortiert', () => {
  const question = { id: 'q1' };
  const responses = [
    { question_id: 'q1', guess_value: 12 },
    { question_id: 'q1', guess_value: 10 },
    { question_id: 'q1', guess_value: 12 },
  ];
  const result = aggregateEstimation({ question, responses, correctValue: 12 });
  assert.equal(result.binned, false);
  assert.deepEqual(result.bars, [
    { label: '10', count: 1, isCorrect: false },
    { label: '12', count: 2, isCorrect: true },
  ]);
});

test('aggregateEstimation: keine Antworten -> leere Balken', () => {
  const result = aggregateEstimation({ question: { id: 'q1' }, responses: [] });
  assert.deepEqual(result, { bars: [], binned: false });
});

test('aggregateEstimation: viele verschiedene Werte -> Buckets statt Einzelwerte', () => {
  const question = { id: 'q1' };
  const responses = Array.from({ length: 20 }, (_, i) => ({ question_id: 'q1', guess_value: i }));
  const result = aggregateEstimation({ question, responses, maxBars: 5 });
  assert.equal(result.binned, true);
  assert.equal(result.bars.length, 5);
  const totalCount = result.bars.reduce((sum, b) => sum + b.count, 0);
  assert.equal(totalCount, 20);
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

test('computePointsProgression: kumuliert Punkte in Positions-Reihenfolge', () => {
  const participants = [{ id: 'p1' }];
  const questions = [
    { id: 'q2', position: 2 },
    { id: 'q1', position: 1 },
  ];
  const responses = [
    { participant_id: 'p1', question_id: 'q1', points_awarded: 50 },
    { participant_id: 'p1', question_id: 'q2', points_awarded: 30 },
  ];
  const result = computePointsProgression({ participants, responses, questions });
  assert.deepEqual(result, [{ participant: { id: 'p1' }, series: [50, 80] }]);
});

test('computePointsProgression: fehlende Antwort zaehlt als 0, Reihe bleibt gleich lang wie Fragenzahl', () => {
  const participants = [{ id: 'p1' }];
  const questions = [{ id: 'q1', position: 1 }, { id: 'q2', position: 2 }];
  const responses = [{ participant_id: 'p1', question_id: 'q1', points_awarded: 50 }];
  const result = computePointsProgression({ participants, responses, questions });
  assert.deepEqual(result[0].series, [50, 50]);
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
