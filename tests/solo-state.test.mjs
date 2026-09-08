import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRandomQuestions, describeAnswer, computeSoloResult } from '../docs/shared/solo-state.js';

const QUESTIONS = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, position: i }));

test('pickRandomQuestions: liefert genau count Fragen', () => {
  const picked = pickRandomQuestions(QUESTIONS, 4);
  assert.equal(picked.length, 4);
});

test('pickRandomQuestions: alle zurueckgegebenen Fragen sind eindeutig und stammen aus dem Katalog', () => {
  const picked = pickRandomQuestions(QUESTIONS, 6);
  const ids = picked.map((q) => q.id);
  assert.equal(new Set(ids).size, 6);
  for (const id of ids) {
    assert.ok(QUESTIONS.some((q) => q.id === id));
  }
});

test('pickRandomQuestions: count = gesamter Katalog liefert alle Fragen (nur Reihenfolge gemischt)', () => {
  const picked = pickRandomQuestions(QUESTIONS, QUESTIONS.length);
  assert.equal(picked.length, QUESTIONS.length);
  assert.equal(new Set(picked.map((q) => q.id)).size, QUESTIONS.length);
});

test('pickRandomQuestions: count = 0 wirft', () => {
  assert.throws(() => pickRandomQuestions(QUESTIONS, 0));
});

test('pickRandomQuestions: count > Katalogsgroesse wirft', () => {
  assert.throws(() => pickRandomQuestions(QUESTIONS, 11));
});

test('pickRandomQuestions: negative oder nicht-ganzzahlige count wirft', () => {
  assert.throws(() => pickRandomQuestions(QUESTIONS, -1));
  assert.throws(() => pickRandomQuestions(QUESTIONS, 2.5));
});

test('describeAnswer: multiple_choice gibt gewaehlte und korrekte Option zurueck', () => {
  const question = { question_type: 'multiple_choice' };
  const response = { selected_option: 'Berlin' };
  const answer = { correct_option: 'Paris' };
  assert.deepEqual(describeAnswer(question, response, answer), {
    yourAnswer: 'Berlin',
    correctAnswer: 'Paris',
  });
});

test('describeAnswer: estimation formatiert Ganzzahlen ohne Nachkommastellen', () => {
  const question = { question_type: 'estimation' };
  const response = { guess_value: 42 };
  const answer = { correct_value: 100 };
  assert.deepEqual(describeAnswer(question, response, answer), {
    yourAnswer: '42',
    correctAnswer: '100',
  });
});

test('describeAnswer: estimation ohne Antwort/Loesung liefert null statt Absturz', () => {
  const question = { question_type: 'estimation' };
  assert.deepEqual(describeAnswer(question, null, null), {
    yourAnswer: null,
    correctAnswer: null,
  });
});

test('computeSoloResult: aggregiert Punkte, Trefferquote und Zeilen in Spielreihenfolge', () => {
  const questions = [
    { id: 'q1', question_type: 'multiple_choice', prompt: 'A?' },
    { id: 'q2', question_type: 'estimation', prompt: 'B?' },
  ];
  const responses = [
    { question_id: 'q1', selected_option: 'X', is_correct: true, points_awarded: 1, latency_ms: 1000 },
    { question_id: 'q2', guess_value: 40, is_correct: false, points_awarded: 0, latency_ms: 2000 },
  ];
  const answers = [
    { question_id: 'q1', correct_option: 'X' },
    { question_id: 'q2', correct_value: 100 },
  ];

  const result = computeSoloResult({ questionIds: ['q1', 'q2'], questions, responses, answers });

  assert.equal(result.totalCount, 2);
  assert.equal(result.correctCount, 1);
  assert.equal(result.totalPoints, 1);
  assert.equal(result.accuracyPct, 50);
  assert.equal(result.avgLatencyMs, 1500);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].question.id, 'q1');
  assert.equal(result.rows[1].question.id, 'q2');
});

test('computeSoloResult: fehlende Antwort zaehlt als falsch/0 Punkte statt Absturz', () => {
  const questions = [{ id: 'q1', question_type: 'multiple_choice', prompt: 'A?' }];
  const result = computeSoloResult({ questionIds: ['q1'], questions, responses: [], answers: [] });

  assert.equal(result.totalCount, 1);
  assert.equal(result.correctCount, 0);
  assert.equal(result.totalPoints, 0);
  assert.equal(result.accuracyPct, 0);
  assert.equal(result.avgLatencyMs, null);
  assert.equal(result.rows[0].isCorrect, false);
});

test('computeSoloResult: leere Fragenliste liefert accuracyPct 0 statt Division durch 0', () => {
  const result = computeSoloResult({ questionIds: [], questions: [], responses: [], answers: [] });
  assert.equal(result.totalCount, 0);
  assert.equal(result.accuracyPct, 0);
  assert.deepEqual(result.rows, []);
});
