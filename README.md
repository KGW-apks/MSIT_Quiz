# MSIT Live-Quiz-Tool

Live-Quiz-Tool fuer eine Praesentation per Zoom: Teilnehmer:innen nehmen per
Smartphone teil (Name eingeben, keine sichtbare Auth-UI), waehrend im
Presenter-Dashboard Fragen gesteuert werden und sich Live-Diagramme sowie ein
Leaderboard aufbauen.

## Architektur

- **Frontend**: Vanilla HTML/CSS/JavaScript (ES-Module), `supabase-js` per
  CDN, kein Build-Step. Chart.js fuer die Live-Diagramme.
- **Backend**: [Supabase](https://supabase.com) (Postgres, Row Level
  Security, Realtime, Anonymous Auth). Scoring und Presenter-Steuerung laufen
  serverseitig (Trigger bzw. `SECURITY DEFINER`-Funktionen), nie clientseitig.
- **Hosting**: statisch, `docs/` als GitHub-Pages-Publish-Root.

### Sicherheitsmodell

- Der `anon`-Key in `docs/shared/supabase-client.js` ist bewusst oeffentlich;
  die eigentliche Absicherung laeuft ueber Row Level Security, nicht ueber
  Geheimhaltung des Keys.
- Loesungen (`question_answers`) sind per RLS fuer jeden Client unlesbar,
  Scoring liest sie ausschliesslich ueber eine `SECURITY DEFINER`-Funktion.
- Schreibende Presenter-Aktionen (Frage oeffnen/schliessen, Runde starten,
  Teilnehmer entfernen) laufen ausschliesslich ueber `SECURITY DEFINER`-RPCs,
  die ein gehashtes Presenter-Passwort pruefen (`presenter_control`,
  `presenter_remove_participant`). Direkte Schreibzugriffe auf die
  betroffenen Tabellen sind per RLS gesperrt.

## Projektstruktur

```
docs/                     GitHub Pages Publish-Root
├── shared/                Supabase-Client, gemeinsames CSS, reine Logikmodule
├── participant/           Mobile-first: Registrierung, Frage/Antwort, Timer-Ring
├── presenter/              Redirect-Stub auf dashboard/?tab=presenter
└── dashboard/              Dashboard + Presenter-Steuerung (zwei Tabs einer Seite)

supabase/
├── migrations/             Schema, RLS-Policies, Trigger, RPCs (chronologisch)
└── tests/database/         pgTAP-Tests gegen die Migrationen

tests/                     node:test-Suite fuer die reine Zustands-/Aggregationslogik
```

Reine Entscheidungs- und Aggregationslogik (`docs/shared/*-state.js`,
`quiz-timer.js`, `error-log-throttle.js`) ist bewusst von DOM- und
Supabase-Zugriff getrennt und dadurch ohne Browser testbar. Die `app.js`-
Dateien in `participant/` und `dashboard/` sind reine UI-Verdrahtung ohne
eigene Entscheidungslogik.

## Voraussetzungen

- [Node.js](https://nodejs.org) (fuer die Test-Suite, kein Build-Step noetig)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (fuer lokale
  Datenbank, Migrationen und pgTAP-Tests)
- Docker (von der Supabase CLI fuer die lokale Instanz benoetigt)

## Lokale Entwicklung

```bash
supabase start              # lokale Supabase-Instanz (Postgres, Auth, Realtime)
supabase db reset            # Migrationen einspielen
npm test                     # reine JS-Logik: node:test
npx supabase test db --local # Datenbank-Logik: pgTAP
```

Frontend lokal ausliefern (statischer Server auf `docs/`), z. B.:

```bash
python -m http.server 8791 --directory docs
```

## Datenmodell

| Tabelle | Zweck |
|---|---|
| `participants` | Teilnehmer:in, `id` = `auth.uid()` der Anonymous-Session |
| `questions` | Fragenkatalog (`multiple_choice` / `estimation`), `times_asked` fuer die Rundenauswahl |
| `quiz_sessions` | Singleton-Zeile fuer den laufenden Event-Zustand (Status, laufende Frage, aktive Runde) |
| `question_answers` | Loesungen, per RLS fuer keinen Client lesbar |
| `responses` | Antworten je Teilnehmer:in und Frage, Scoring serverseitig vom Trigger gesetzt |

## Deployment

GitHub Pages auf den Ordner `docs/`. Nach dem Event werden Supabase-Projekt
und Hosting wieder abgebaut — das ist Teil des Sicherheitsmodells, nicht nur
Aufraeumen.
