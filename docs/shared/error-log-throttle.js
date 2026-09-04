// Reine Dedupe/Obergrenze-Entscheidung fuers Error-Logging, getrennt von error-log.js
// (das importiert supabase-client.js und braucht damit `window`), damit sie ohne
// Browser mit node:test pruefbar ist. Siehe error-log.js fuer den Kontext.

export const MAX_LOGS_PER_SESSION = 20;
export const DEDUPE_WINDOW_MS = 5000;

// state: { lastMessage, lastLoggedAt, loggedCount }.
export function shouldLog({ message, now, state }) {
  if (state.loggedCount >= MAX_LOGS_PER_SESSION) return false;
  if (message === state.lastMessage && now - state.lastLoggedAt < DEDUPE_WINDOW_MS) return false;
  return true;
}
