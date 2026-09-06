import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveViewState, parseGuessValue } from '../docs/shared/quiz-state.js';

test('lobby: status lobby -> lobby view', () => {
  assert.deepEqual(
    deriveViewState({ status: 'lobby', currentQuestion: null, myResponse: null }),
    { view: 'lobby' }
  );
});

test('lobby: status open aber noch keine currentQuestion geladen -> lobby view', () => {
  assert.deepEqual(
    deriveViewState({ status: 'open', currentQuestion: null, myResponse: null }),
    { view: 'lobby' }
  );
});

test('finished: status finished gewinnt unabhaengig vom Rest', () => {
  assert.deepEqual(
    deriveViewState({ status: 'finished', currentQuestion: { id: 'q1' }, myResponse: { id: 'r1' } }),
    { view: 'finished' }
  );
});

test('open ohne Antwort -> question view, myResponse null', () => {
  const q = { id: 'q1', prompt: 'Test?' };
  assert.deepEqual(
    deriveViewState({ status: 'open', currentQuestion: q, myResponse: null }),
    { view: 'question', question: q, myResponse: null }
  );
});

test('open mit Antwort -> weiterhin question view (Antwort noch aenderbar), myResponse wird mitgegeben', () => {
  const q = { id: 'q1' };
  const response = { id: 'r1', selected_option: 'A' };
  assert.deepEqual(
    deriveViewState({ status: 'open', currentQuestion: q, myResponse: response }),
    { view: 'question', question: q, myResponse: response }
  );
});

test('closed ohne Antwort -> missed view', () => {
  const q = { id: 'q1' };
  assert.deepEqual(
    deriveViewState({ status: 'closed', currentQuestion: q, myResponse: null }),
    { view: 'missed', question: q }
  );
});

test('closed mit Antwort -> waiting view', () => {
  const q = { id: 'q1' };
  assert.deepEqual(
    deriveViewState({ status: 'closed', currentQuestion: q, myResponse: { id: 'r1' } }),
    { view: 'waiting', question: q }
  );
});

// Bug 2026-09-06: wiederholt sich eine Frage in einer spaeteren Runde (gleiche
// question_id, responses laeuft per Upsert), darf die alte Antwort aus der
// Vorrunde nicht als "schon beantwortet" durchschlagen. question_opened_at wird
// bei jedem (Wieder-)Oeffnen neu gestempelt und ist der Cutoff.
test('open mit Antwort von VOR question_opened_at (Wiederholungs-Frage) -> question view, myResponse wird verworfen', () => {
  const q = { id: 'q1' };
  const staleResponse = { id: 'r1', selected_option: 'A', answered_at: '2026-09-01T10:00:00Z' };
  assert.deepEqual(
    deriveViewState({
      status: 'open',
      currentQuestion: q,
      myResponse: staleResponse,
      questionOpenedAt: '2026-09-06T10:00:00Z',
    }),
    { view: 'question', question: q, myResponse: null }
  );
});

test('open mit Antwort von NACH question_opened_at -> myResponse bleibt erhalten', () => {
  const q = { id: 'q1' };
  const freshResponse = { id: 'r1', selected_option: 'A', answered_at: '2026-09-06T10:00:05Z' };
  assert.deepEqual(
    deriveViewState({
      status: 'open',
      currentQuestion: q,
      myResponse: freshResponse,
      questionOpenedAt: '2026-09-06T10:00:00Z',
    }),
    { view: 'question', question: q, myResponse: freshResponse }
  );
});

test('closed mit Antwort von VOR question_opened_at (Wiederholungs-Frage) -> missed statt waiting', () => {
  const q = { id: 'q1' };
  const staleResponse = { id: 'r1', selected_option: 'A', answered_at: '2026-09-01T10:00:00Z' };
  assert.deepEqual(
    deriveViewState({
      status: 'closed',
      currentQuestion: q,
      myResponse: staleResponse,
      questionOpenedAt: '2026-09-06T10:00:00Z',
    }),
    { view: 'missed', question: q }
  );
});

test('parseGuessValue: gueltige Ganzzahl', () => {
  assert.equal(parseGuessValue('42'), 42);
});

test('parseGuessValue: deutsches Dezimalkomma', () => {
  assert.equal(parseGuessValue('3,5'), 3.5);
});

test('parseGuessValue: englischer Dezimalpunkt', () => {
  assert.equal(parseGuessValue('3.5'), 3.5);
});

test('parseGuessValue: leer oder nur Leerzeichen -> null', () => {
  assert.equal(parseGuessValue(''), null);
  assert.equal(parseGuessValue('   '), null);
});

test('parseGuessValue: keine Zahl -> null', () => {
  assert.equal(parseGuessValue('abc'), null);
});

test('parseGuessValue: negative Zahl erlaubt', () => {
  assert.equal(parseGuessValue('-5'), -5);
});
