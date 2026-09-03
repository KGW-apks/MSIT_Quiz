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
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 99, participantCount: 1, now: Date.now() }),
    false
  );
});

test('shouldAutoClose: alle Teilnehmer haben geantwortet -> true, auch vor Zeitablauf', () => {
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: new Date().toISOString() };
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 5, participantCount: 5, now: Date.now() }),
    true
  );
});

test('shouldAutoClose: 0 Teilnehmer loest nicht faelschlich aus (0 >= 0 waere sonst true)', () => {
  const session = { status: 'open', current_question_id: 'q2', question_opened_at: new Date().toISOString() };
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 0, participantCount: 0, now: Date.now() }),
    false
  );
});

test('shouldAutoClose: Zeit abgelaufen -> true', () => {
  const openedAt = new Date(Date.now() - 30_000).toISOString();
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: openedAt };
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 1, participantCount: 10, now: Date.now() }),
    true
  );
});

test('shouldAutoClose: weder Zeit abgelaufen noch alle geantwortet -> false', () => {
  const openedAt = new Date().toISOString();
  const session = { status: 'open', current_question_id: 'q1', question_opened_at: openedAt };
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 1, participantCount: 10, now: Date.now() }),
    false
  );
});

test('shouldAutoClose: kein Zeitlimit und nicht alle geantwortet -> false, wartet auf manuelles Schliessen', () => {
  const openedAt = new Date(Date.now() - 100_000).toISOString();
  const session = { status: 'open', current_question_id: 'q2', question_opened_at: openedAt };
  assert.equal(
    shouldAutoClose({ session, questions, responseCount: 1, participantCount: 10, now: Date.now() }),
    false
  );
});
