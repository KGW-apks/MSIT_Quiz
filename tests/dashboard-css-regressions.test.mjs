import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Statischer CSS-Regressionstest, kein Browser noetig (das Projekt hat bewusst
// keine Playwright/Puppeteer-Abhaengigkeit, siehe Projektnotiz "Live-Quiz-Tool").
// Faengt eine Regel-Klasse ab, die sich sonst leicht unbemerkt einschleicht:
// ein kleiner, fest bemessener Icon-Button (z.B. das Drilldown-Schliessen-X)
// erbt ohne eigenes padding den globalen `button { padding: 16px }`-Reset aus
// shared/styles.css. Auf einer 32x32px-Box laesst das keinen Platz fuer den
// Inhalt, der Inhalt (Text-Glyph oder SVG) rutscht dadurch sichtbar
// asymmetrisch aus der Mitte, ohne dass CSS dabei irgendeinen Fehler wirft.

const dashboardCssPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../docs/dashboard/dashboard.css'
);
const dashboardCss = readFileSync(dashboardCssPath, 'utf8');

function extractRuleBody(css, selector) {
  const match = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

test('.button-icon deklariert eigenes padding (ueberschreibt den globalen button-Reset explizit)', () => {
  const body = extractRuleBody(dashboardCss, 'button-icon');
  assert.ok(body, '.button-icon-Regel nicht in dashboard.css gefunden');
  assert.match(
    body,
    /padding\s*:/,
    '.button-icon muss ein eigenes padding setzen, sonst erbt es den globalen `button { padding: 16px }`-Reset ' +
      'aus shared/styles.css und der Inhalt (z.B. das Schliessen-X) rutscht auf einer 32x32px-Box asymmetrisch ' +
      'aus der Mitte'
  );
});
