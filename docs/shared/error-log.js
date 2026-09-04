// Client-seitiges Error-Logging: faengt JS-Fehler und fehlgeschlagene Supabase-Calls
// aus Teilnehmer- und Dashboard-Oberflaeche ein und schreibt sie in error_logs (RLS:
// jede Session darf eigene Fehler schreiben, nur Presenter/Dashboard duerfen lesen,
// siehe Migration add_error_logs). Ergaenzt Supabases eigene Postgres/API-Logs um eine
// client-seitige, live im Dashboard einsehbare Sicht.
//
// Diese Datei importiert supabase-client.js (braucht `window`) und ist deshalb wie
// supabase-client.js selbst nicht per node:test testbar. Die Dedupe/Obergrenze-Logik
// steckt bewusst in error-log-throttle.js, das keine Browser-Abhaengigkeit hat.

import { supabaseClient } from './supabase-client.js';
import { shouldLog } from './error-log-throttle.js';

const state = { lastMessage: null, lastLoggedAt: 0, loggedCount: 0 };

export async function logError(source, message, context = {}) {
  const now = Date.now();
  const text = String(message ?? 'Unbekannter Fehler').slice(0, 2000);
  if (!shouldLog({ message: text, now, state })) return;

  state.lastMessage = text;
  state.lastLoggedAt = now;
  state.loggedCount += 1;

  try {
    await supabaseClient.from('error_logs').insert({ source, message: text, context });
  } catch {
    // Fehler beim Fehler-Loggen selbst bewusst verschluckt, kein zweiter Fehlerkreislauf.
  }
}

// Faengt Fehler ab, die sonst nur in der Browser-Konsole des jeweiligen Geraets
// verschwinden wuerden: ungefangene Exceptions und rejected Promises ohne .catch.
export function installGlobalErrorHandlers(source) {
  window.addEventListener('error', (event) => {
    logError(source, event.message, {
      stack: event.error?.stack?.slice(0, 2000),
      filename: event.filename,
      line: event.lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logError(source, reason?.message ?? String(reason), { stack: reason?.stack?.slice(0, 2000) });
  });
}
