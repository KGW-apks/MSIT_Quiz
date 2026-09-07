import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAutoCloseAt, shouldAutoClose } from '../docs/shared/quiz-timer.js';

const questions = [
  { id: 'q1', time_limit_seconds: 20 },
  { id: 'q2', time_limit_seconds: null },
];

test('computeAutoCloseAt: kein Session-Objekt -> null', () => {
  assert.equal(computeAutoCloseAt({ session: null, questions }), null);
});

test('computeAutoCloseAt: status nicht open -> null', () => {
  const session = { status: 'closed', current_question_id: 'q1', question_opened_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(computeAutoCloseAt({ session, questions }), null);
});

test('computeAutoCloseAt: Frage ohne time_limit_seconds -> null', () => {
  const session = { status: 'open', current_question_id: 'q2', question_opened_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(computeAutoCloseAt({ session, questions }), null);
});

test('computeAutoCloseAt: open mit Zeitlimit -> question_opened_at + limit', () => {
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: '2026-01-01T00:00:00.000Z' };
  const expected = new Date('2026-01-01T00:00:00.000Z').getTime() + 20_000;
  assert.equal(computeAutoCloseAt({ session, questions }), expected);
});

test('shouldAutoClose: status nicht open -> immer false', () => {
  const session = { status: 'closed', current_question_id: 'q1', question_opened_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(shouldAutoClose({ session, questions, now: Date.now() }), false);
});

test('shouldAutoClose: alle haben geantwortet, Zeit aber noch nicht abgelaufen -> false (fester Timer, kein Fruehschluss)', () => {
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: new Date().toISOString() };
  assert.equal(shouldAutoClose({ session, questions, now: Date.now() }), false);
});

test('shouldAutoClose: Zeit abgelaufen -> true', () => {
  const openedAt = new Date(Date.now() - 30_000).toISOString();
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: openedAt };
  assert.equal(shouldAutoClose({ session, questions, now: Date.now() }), true);
});

test('shouldAutoClose: Zeit noch nicht abgelaufen -> false', () => {
  const openedAt = new Date().toISOString();
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: openedAt };
  assert.equal(shouldAutoClose({ session, questions, now: Date.now() }), false);
});

test('shouldAutoClose: kein Zeitlimit -> false, wartet auf manuelles Schliessen', () => {
  const openedAt = new Date(Date.now() - 100_000).toISOString();
  const session = { status: 'open', current_question_id: 'q2', question_opened_at: openedAt };
  assert.equal(shouldAutoClose({ session, questions, now: Date.now() }), false);
});
