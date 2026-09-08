import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPresenterView, computeNextQuestionId } from '../docs/shared/presenter-state.js';

const questions = [
  { id: 'q2', position: 2 },
  { id: 'q1', position: 1 },
  { id: 'q3', position: 3 },
];

// Erzeugt n Dummy-Teilnehmer, wenn ein Test nur die Anzahl braucht, nicht
// die Namen selbst (participantCount wird aus der uebergebenen
// participants-Liste abgeleitet statt separat durchgereicht).
function makeParticipants(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, display_name: `Teilnehmer ${i}` }));
}

test('keine Runde aktiv (round_question_ids null) -> keine Optionen, canStartRound true, canCancelRound false', () => {
  const view = buildPresenterView({ session: null, questions, responses: [], participants: [] });
  assert.equal(view.status, 'lobby');
  assert.equal(view.hasActiveRound, false);
  assert.deepEqual(view.options, []);
  assert.equal(view.current, null);
  assert.equal(view.canStartRound, true);
  assert.equal(view.canCancelRound, false);
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, false);
});

test('leeres round_question_ids-Array zaehlt wie keine aktive Runde', () => {
  const view = buildPresenterView({
    session: { status: 'lobby', current_question_id: null, round_question_ids: [] },
    questions,
    responses: [],
    participants: [],
  });
  assert.equal(view.hasActiveRound, false);
  assert.deepEqual(view.options, []);
});

test('current_question_id gesetzt, aber round_question_ids null (inkonsistenter Session-Zustand, z.B. nach manuellem DB-Reset) -> kein Crash, currentIndex faellt auf -1 zurueck', () => {
  const view = buildPresenterView({
    session: { status: 'open', current_question_id: 'q1', round_question_ids: null },
    questions,
    responses: [],
    participants: [],
  });
  assert.equal(view.hasActiveRound, false);
  assert.deepEqual(view.options, []);
  assert.equal(view.current.question.id, 'q1');
});

test('Optionen folgen der Rundenreihenfolge (Auswahlreihenfolge), nicht der Katalog-position, und tragen keinen Prompt-Text', () => {
  const view = buildPresenterView({
    session: { status: 'lobby', current_question_id: null, round_question_ids: ['q3', 'q1'] },
    questions,
    responses: [],
    participants: [],
  });
  assert.deepEqual(view.options.map((o) => o.id), ['q3', 'q1']);
  assert.deepEqual(view.options.map((o) => o.label), ['Frage 1', 'Frage 2']);
  assert.equal('prompt' in view.options[0], false);
  assert.equal(view.hasActiveRound, true);
});

test('Fragen ausserhalb der Runde tauchen nicht in den Optionen auf, auch wenn sie im Katalog existieren', () => {
  const view = buildPresenterView({
    session: { status: 'lobby', current_question_id: null, round_question_ids: ['q1'] },
    questions,
    responses: [],
    participants: [],
  });
  assert.deepEqual(view.options.map((o) => o.id), ['q1']);
});

test('status open mit current_question_id -> current traegt den vollen Prompt, isCurrent/alreadyAsked korrekt gesetzt', () => {
  const view = buildPresenterView({
    session: { status: 'open', current_question_id: 'q2', round_question_ids: ['q1', 'q2', 'q3'] },
    questions,
    responses: [],
    participants: makeParticipants(5),
  });
  assert.equal(view.current.question.id, 'q2');
  assert.equal(view.current.badge, 'open');
  assert.deepEqual(
    view.options.map((o) => [o.id, o.isCurrent, o.alreadyAsked]),
    [
      ['q1', false, true],
      ['q2', true, false],
      ['q3', false, false],
    ]
  );
  assert.equal(view.canClose, true);
  assert.equal(view.canFinish, true);
  assert.equal(view.canStartRound, false);
  assert.equal(view.canCancelRound, true);
});

test('status closed mit current_question_id -> current.badge closed, Schliessen nicht mehr moeglich', () => {
  const view = buildPresenterView({
    session: { status: 'closed', current_question_id: 'q2', round_question_ids: ['q1', 'q2', 'q3'] },
    questions,
    responses: [],
    participants: makeParticipants(5),
  });
  assert.equal(view.current.badge, 'closed');
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, true);
});

test('status finished -> current bleibt gesetzt (letzte Frage), aber keine Aktion mehr moeglich, neue Runde startbar', () => {
  const view = buildPresenterView({
    session: { status: 'finished', current_question_id: 'q3', round_question_ids: ['q1', 'q2', 'q3'] },
    questions,
    responses: [],
    participants: makeParticipants(5),
  });
  assert.equal(view.current.badge, 'pending');
  assert.equal(view.canClose, false);
  assert.equal(view.canFinish, false);
  assert.equal(view.canStartRound, true);
  assert.equal(view.canCancelRound, false);
});

test('responseCount (current) zaehlt nur Antworten der aktuellen Frage', () => {
  const responses = [
    { question_id: 'q1' },
    { question_id: 'q1' },
    { question_id: 'q2' },
  ];
  const view = buildPresenterView({
    session: { status: 'open', current_question_id: 'q1', round_question_ids: ['q1', 'q2', 'q3'] },
    questions,
    responses,
    participants: makeParticipants(10),
  });
  assert.equal(view.current.responseCount, 2);
});

test('participantCount wird aus der Laenge der participants-Liste abgeleitet', () => {
  const view = buildPresenterView({ session: null, questions: [], responses: [], participants: makeParticipants(17) });
  assert.equal(view.participantCount, 17);
});

test('participants: leere Liste -> leeres Array, keine Fehler', () => {
  const view = buildPresenterView({ session: null, questions: [], responses: [], participants: [] });
  assert.deepEqual(view.participants, []);
});

test('participants: jeder Eintrag traegt id und name (aus display_name), sonst nichts', () => {
  const view = buildPresenterView({
    session: null,
    questions: [],
    responses: [],
    participants: [{ id: 'p1', display_name: 'Bea' }],
  });
  assert.deepEqual(view.participants, [{ id: 'p1', name: 'Bea' }]);
});

test('participants: alphabetisch nach Namen sortiert, unabhaengig von der Eingabe-Reihenfolge', () => {
  const view = buildPresenterView({
    session: null,
    questions: [],
    responses: [],
    participants: [
      { id: 'p3', display_name: 'Charlie' },
      { id: 'p1', display_name: 'Anna' },
      { id: 'p2', display_name: 'Bea' },
    ],
  });
  assert.deepEqual(view.participants.map((p) => p.name), ['Anna', 'Bea', 'Charlie']);
});

test('computeNextQuestionId: keine current_question_id -> null', () => {
  assert.equal(computeNextQuestionId({ session: { current_question_id: null, round_question_ids: ['q1', 'q2'] } }), null);
});

test('computeNextQuestionId: mittendrin -> naechste id in Rundenreihenfolge', () => {
  assert.equal(
    computeNextQuestionId({ session: { current_question_id: 'q1', round_question_ids: ['q1', 'q2', 'q3'] } }),
    'q2'
  );
});

test('computeNextQuestionId: letzte Frage der Runde -> null', () => {
  assert.equal(
    computeNextQuestionId({ session: { current_question_id: 'q3', round_question_ids: ['q1', 'q2', 'q3'] } }),
    null
  );
});

test('computeNextQuestionId: current_question_id nicht in round_question_ids -> null', () => {
  assert.equal(
    computeNextQuestionId({ session: { current_question_id: 'qX', round_question_ids: ['q1', 'q2'] } }),
    null
  );
});

test('computeNextQuestionId: keine Runde aktiv (round_question_ids null) -> null', () => {
  assert.equal(computeNextQuestionId({ session: { current_question_id: 'q1', round_question_ids: null } }), null);
});
