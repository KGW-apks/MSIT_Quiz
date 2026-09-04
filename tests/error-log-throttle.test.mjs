import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLog, MAX_LOGS_PER_SESSION, DEDUPE_WINDOW_MS } from '../docs/shared/error-log-throttle.js';

function freshState() {
  return { lastMessage: null, lastLoggedAt: 0, loggedCount: 0 };
}

test('shouldLog: erster Fehler wird immer geloggt', () => {
  assert.equal(shouldLog({ message: 'Boom', now: 1000, state: freshState() }), true);
});

test('shouldLog: gleiche Nachricht innerhalb des Dedupe-Fensters wird unterdrueckt', () => {
  const state = { lastMessage: 'Boom', lastLoggedAt: 1000, loggedCount: 1 };
  assert.equal(shouldLog({ message: 'Boom', now: 1000 + DEDUPE_WINDOW_MS - 1, state }), false);
});

test('shouldLog: gleiche Nachricht nach Ablauf des Dedupe-Fensters wird wieder geloggt', () => {
  const state = { lastMessage: 'Boom', lastLoggedAt: 1000, loggedCount: 1 };
  assert.equal(shouldLog({ message: 'Boom', now: 1000 + DEDUPE_WINDOW_MS, state }), true);
});

test('shouldLog: unterschiedliche Nachrichten sofort hintereinander werden beide geloggt', () => {
  const state = { lastMessage: 'Boom', lastLoggedAt: 1000, loggedCount: 1 };
  assert.equal(shouldLog({ message: 'Anderer Fehler', now: 1000, state }), true);
});

test('shouldLog: Session-Obergrenze greift, verhindert eine Fehlerschleife von tausenden Zeilen', () => {
  const state = { lastMessage: null, lastLoggedAt: 0, loggedCount: MAX_LOGS_PER_SESSION };
  assert.equal(shouldLog({ message: 'Neuer Fehler', now: 999_999, state }), false);
});

test('shouldLog: knapp unter der Obergrenze wird noch geloggt', () => {
  const state = { lastMessage: null, lastLoggedAt: 0, loggedCount: MAX_LOGS_PER_SESSION - 1 };
  assert.equal(shouldLog({ message: 'Noch ein Fehler', now: 999_999, state }), true);
});
