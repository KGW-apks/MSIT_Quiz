import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPresenterView } from '../docs/shared/presenter-state.js';

const questions = [
  { id: 'q2', position: 2 },
  { id: 'q1', position: 1 },
  { id: 'q3', position: 3 },
];

test('kein Session-Objekt -> lobby, alle Fragen pending, keine Aktion moeglich', () => {
  const view = buildPresenterView({ session: null, questions, responses: [], participantCount: 0 });
  assert.equal(view.status, 'lobby');
  assert.deepEqual(view.rows.map((r) => r.badge), ['pending', 'pending', 'pending']);
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, false);
});

test('Zeilen werden nach position sortiert, unabhaengig von der Eingabereihenfolge', () => {
  const view = buildPresenterView({ session: { status: 'lobby', current_question_id: null }, questions, responses: [], participantCount: 0 });
  assert.deepEqual(view.rows.map((r) => r.question.id), ['q1', 'q2', 'q3']);
});

test('status open mit current_question_id -> diese Zeile badge open, Rest pending', () => {
  const view = buildPresenterView({
    session: { status: 'open', current_question_id: 'q2' },
    questions,
    responses: [],
    participantCount: 5,
  });
  const byId = Object.fromEntries(view.rows.map((r) => [r.question.id, r.badge]));
  assert.deepEqual(byId, { q1: 'pending', q2: 'open', q3: 'pending' });
  assert.equal(view.canClose, true);
  assert.equal(view.canFinish, true);
});

test('status closed mit current_question_id -> diese Zeile badge closed, Schliessen nicht mehr moeglich', () => {
  const view = buildPresenterView({
    session: { status: 'closed', current_question_id: 'q2' },
    questions,
    responses: [],
    participantCount: 5,
  });
  const byId = Object.fromEntries(view.rows.map((r) => [r.question.id, r.badge]));
  assert.deepEqual(byId, { q1: 'pending', q2: 'closed', q3: 'pending' });
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, true);
});

test('status finished -> alle Zeilen wieder pending, keine Aktion mehr moeglich', () => {
  const view = buildPresenterView({
    session: { status: 'finished', current_question_id: 'q3' },
    questions,
    responses: [],
    participantCount: 5,
  });
  assert.deepEqual(view.rows.map((r) => r.badge), ['pending', 'pending', 'pending']);
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, false);
});

test('responseCount zaehlt nur Antworten der jeweiligen Frage', () => {
  const responses = [
    { question_id: 'q1' },
    { question_id: 'q1' },
    { question_id: 'q2' },
  ];
  const view = buildPresenterView({
    session: { status: 'open', current_question_id: 'q1' },
    questions,
    responses,
    participantCount: 10,
  });
  const byId = Object.fromEntries(view.rows.map((r) => [r.question.id, r.responseCount]));
  assert.deepEqual(byId, { q1: 2, q2: 1, q3: 0 });
});

test('participantCount wird unveraendert durchgereicht', () => {
  const view = buildPresenterView({ session: null, questions: [], responses: [], participantCount: 17 });
  assert.equal(view.participantCount, 17);
});
