// DOM-Verdrahtung + Chart.js um die getestete Aggregationslogik in
// shared/dashboard-state.js, shared/presenter-state.js und shared/quiz-timer.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.
//
// Seit 2026-09-04 vereint diese Seite Dashboard UND Presenter als zwei Tabs
// (vorher zwei getrennte Seiten, docs/presenter/ leitet nur noch hierher um).
// Beide Tabs teilen sich einen einzigen Datenabruf und dieselben drei
// Realtime-Subscriptions (quiz_sessions/responses/participants), render()
// aktualisiert deshalb immer beide, unabhaengig davon welcher Tab sichtbar ist.

import { supabaseClient } from '../shared/supabase-client.js';
import { computeAutoCloseAt, shouldAutoClose } from '../shared/quiz-timer.js';
import { buildPresenterView } from '../shared/presenter-state.js';
import { installGlobalErrorHandlers, logError } from '../shared/error-log.js';
import {
  isRevealed,
  aggregateMultipleChoice,
  aggregateEstimation,
  computeLeaderboard,
  computePointsProgression,
  computeClosingStats,
  computeQuestionProgress,
} from '../shared/dashboard-state.js';

// 'dashboard' als source deckt beide Tabs ab (Presenter ist seit 2026-09-04 kein
// eigener Prozess mehr, siehe Kommentar oben); errorLogs.context.tab unterscheidet
// bei Bedarf, aus welchem Tab heraus der Fehler ausgeloest wurde.
installGlobalErrorHandlers('dashboard');

const VIEWS = ['loading', 'empty', 'main', 'error'];
const TYPE_LABEL = { multiple_choice: 'Multiple-Choice', estimation: 'Schätzung' };
const DASHBOARD_STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Ergebnis', finished: 'Quiz beendet' };
const PRESENTER_STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Frage geschlossen', finished: 'Quiz beendet' };
const BADGE_LABEL = { pending: '–', open: 'Live', closed: 'Geschlossen' };
const PROGRESSION_TOP_N = 6;
const LEADERBOARD_TOP_N = 10; // deckt sich mit dem Rang-Farbverlauf bis Platz 10
const DEFAULT_ROUND_SIZE = 10;

const LINE_PALETTE = ['#22c55e', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#f87171'];

let session = null;
let questions = [];
let participants = [];
let responses = [];
let roundQuestions = []; // questions der aktuellen Runde, in Auswahlreihenfolge (session.round_question_ids)
const revealedAnswers = new Map(); // question_id -> question_answers row, best-effort Cache
let errorLogs = []; // neueste zuerst, siehe loadErrorLogs()

let questionChart = null;
let leaderboardChart = null;
let progressionChart = null;
let modalChart = null;

function showView(name) {
  for (const view of VIEWS) {
    document.getElementById(`view-${view}`).hidden = view !== name;
  }
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showView('error');
}

function failInit(action, error) {
  logError('dashboard', error.message, { action });
  showError(error.message);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

async function init() {
  const { data: { session: authSession } } = await supabaseClient.auth.getSession();
  if (!authSession) {
    const { error } = await supabaseClient.auth.signInAnonymously();
    if (error) {
      showError(error.message);
      return;
    }
  }

  const [
    { data: questionData, error: questionsError },
    { data: sessionRow, error: sessionError },
    { data: participantData, error: participantsError },
  ] = await Promise.all([
    supabaseClient.from('questions').select('*').order('position', { ascending: true }),
    supabaseClient.from('quiz_sessions').select('*').limit(1).maybeSingle(),
    supabaseClient.from('participants').select('*'),
  ]);

  if (questionsError) return failInit('load_questions', questionsError);
  if (sessionError) return failInit('load_session', sessionError);
  if (participantsError) return failInit('load_participants', participantsError);

  questions = questionData ?? [];
  if (questions.length === 0) {
    showView('empty');
    return;
  }

  session = sessionRow;
  participants = participantData ?? [];

  const { data: responseData, error: responsesError } = await supabaseClient.from('responses').select('*');
  if (responsesError) return failInit('load_responses', responsesError);
  responses = responseData ?? [];

  await loadErrorLogs();

  if (session && isRevealed(session) && session.current_question_id) {
    await ensureRevealedAnswer(session.current_question_id);
  }

  document.getElementById('round-size-input').value = Math.min(DEFAULT_ROUND_SIZE, questions.length);

  showView('main');
  initTabs();
  render();
  wireControls();
  subscribeRealtime();
  setInterval(tickCountdown, 1000);
  setInterval(autoCloseTick, 1000);
}

async function ensureRevealedAnswer(questionId) {
  if (revealedAnswers.has(questionId)) return revealedAnswers.get(questionId);
  const { data, error } = await supabaseClient
    .from('question_answers')
    .select('*')
    .eq('question_id', questionId)
    .maybeSingle();
  if (error || !data) return null;
  revealedAnswers.set(questionId, data);
  return data;
}

// --- Fehler-Log-Panel -------------------------------------------------------
// Zeigt Client-Fehler aus Teilnehmer- und Dashboard/Presenter-Oberflaeche live an
// (siehe shared/error-log.js). Nur diese Session (keine participants-Zeile) darf
// error_logs laut RLS ueberhaupt lesen, siehe Migration add_error_logs.

const ERROR_LOG_LIMIT = 30;

async function loadErrorLogs() {
  const { data, error } = await supabaseClient
    .from('error_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(ERROR_LOG_LIMIT);
  if (error) return; // kein failInit hier: ein Fehler beim Laden des Fehler-Logs soll nicht das ganze Dashboard blockieren
  errorLogs = data ?? [];
  renderErrorLog();
}

function renderErrorLog() {
  const badge = document.getElementById('error-log-count');
  badge.textContent = String(errorLogs.length);
  badge.classList.toggle('error-log-badge--nonzero', errorLogs.length > 0);

  const list = document.getElementById('error-log-list');
  document.getElementById('error-log-empty').hidden = errorLogs.length > 0;
  list.querySelectorAll('.error-log-entry').forEach((el) => el.remove());

  for (const entry of errorLogs) {
    const li = document.createElement('li');
    li.className = 'error-log-entry';
    const time = new Date(entry.created_at).toLocaleTimeString('de-DE');
    li.innerHTML = `
      <span class="error-log-time">${time}</span>
      <span class="error-log-source">${entry.source}</span>
      <span class="error-log-message"></span>
    `;
    li.querySelector('.error-log-message').textContent = entry.message;
    list.appendChild(li);
  }
}

function subscribeRealtime() {
  supabaseClient
    .channel('quiz-sessions-changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'quiz_sessions' }, async (payload) => {
      session = payload.new;
      if (isRevealed(session) && session.current_question_id) {
        await ensureRevealedAnswer(session.current_question_id);
      }
      render();
    })
    .subscribe();

  supabaseClient
    .channel('responses-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'responses' }, (payload) => {
      responses.push(payload.new);
      render();
    })
    .subscribe();

  supabaseClient
    .channel('participants-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants' }, (payload) => {
      participants.push(payload.new);
      render();
    })
    .subscribe();

  supabaseClient
    .channel('error-logs-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'error_logs' }, (payload) => {
      errorLogs = [payload.new, ...errorLogs].slice(0, ERROR_LOG_LIMIT);
      renderErrorLog();
    })
    .subscribe();
}

// --- Tabs ----------------------------------------------------------------

function initTabs() {
  const requested = new URLSearchParams(window.location.search).get('tab');
  const initialTab = requested === 'presenter' ? 'presenter' : 'dashboard';

  for (const button of document.querySelectorAll('.tab-button')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }

  switchTab(initialTab);
}

function switchTab(name) {
  for (const button of document.querySelectorAll('.tab-button')) {
    button.classList.toggle('is-active', button.dataset.tab === name);
  }
  // [hidden] traegt !important (siehe shared/styles.css, Kommentar dort),
  // gewinnt also immer gegen eine reine Klassen-Regel wie .tab-panel.is-active
  // { display: flex } -- Sichtbarkeit deshalb ueber .hidden steuern, nicht nur
  // ueber die Klasse (die bleibt rein fuers Nav-Button-Highlighting).
  document.getElementById('tab-dashboard').hidden = name !== 'dashboard';
  document.getElementById('tab-presenter').hidden = name !== 'presenter';

  const url = new URL(window.location.href);
  url.searchParams.set('tab', name);
  window.history.replaceState(null, '', url);
}

// --- Rendering (gemeinsam) -------------------------------------------------

function render() {
  roundQuestions = (session?.round_question_ids ?? [])
    .map((id) => questions.find((q) => q.id === id))
    .filter(Boolean);

  renderDashboard();
  renderPresenter();
}

// --- Rendering: Dashboard-Tab ----------------------------------------------

function renderDashboard() {
  document.getElementById('session-status').textContent = DASHBOARD_STATUS_LABEL[session?.status] ?? 'Lobby';
  document.getElementById('participant-count').textContent = `${participants.length} angemeldet`;

  renderQuestionProgressBar();
  renderHero();
  renderLeaderboard();
  renderProgression();
}

function renderQuestionProgressBar() {
  const roundQuestionIds = session?.round_question_ids ?? [];
  const { done, total } = computeQuestionProgress({ session, roundQuestionIds });
  const fill = document.getElementById('question-progress-fill');
  const label = document.getElementById('question-progress-label');
  if (total === 0) {
    fill.style.width = '0%';
    label.textContent = 'Noch keine Runde gestartet';
    return;
  }
  const pct = Math.round((done / total) * 100);
  fill.style.width = `${pct}%`;
  label.textContent = `${done} von ${total} Fragen`;
}

function currentQuestion() {
  if (!session?.current_question_id) return null;
  return questions.find((q) => q.id === session.current_question_id) ?? null;
}

function renderHero() {
  const question = currentQuestion();
  const showState = (name) => {
    for (const state of ['empty', 'question', 'finished']) {
      document.getElementById(`hero-${state}`).hidden = state !== name;
    }
  };

  if (session?.status === 'finished') {
    showState('finished');
    renderClosingStats();
    return;
  }

  if (!question) {
    showState('empty');
    return;
  }

  showState('question');
  document.getElementById('hero-type-badge').textContent = TYPE_LABEL[question.question_type] ?? question.question_type;
  document.getElementById('hero-prompt').textContent = question.prompt;

  const revealed = isRevealed(session);
  document.getElementById('hero-progress').hidden = revealed;
  document.getElementById('hero-result').hidden = !revealed;

  if (revealed) {
    renderQuestionResult(question);
  } else {
    renderQuestionProgress(question);
  }

  tickCountdown();
}

function renderQuestionProgress(question) {
  const answered = responses.filter((r) => r.question_id === question.id).length;
  const total = participants.length;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
  document.getElementById('hero-progress-fill').style.width = `${pct}%`;
  document.getElementById('hero-progress-label').textContent = `${answered} von ${total} haben abgestimmt`;
}

function renderQuestionResult(question) {
  const answer = revealedAnswers.get(question.id) ?? null;
  const responsesForQuestion = responses.filter((r) => r.question_id === question.id);

  let bars;
  if (question.question_type === 'multiple_choice') {
    bars = aggregateMultipleChoice({ question, responses, participants, correctOption: answer?.correct_option ?? null });
  } else {
    const result = aggregateEstimation({ question, responses, participants, correctValue: answer?.correct_value ?? null });
    bars = result.bars;
  }

  renderQuestionChart(bars);

  const callout = document.getElementById('hero-correct-callout');
  if (answer && question.question_type === 'multiple_choice') {
    callout.textContent = `Richtige Antwort: ${answer.correct_option}`;
  } else if (answer && question.question_type === 'estimation') {
    callout.textContent = `Richtiger Wert: ${answer.correct_value}`;
  } else {
    callout.textContent = '';
  }

  const correctCount = responsesForQuestion.filter((r) => r.is_correct).length;
  const total = responsesForQuestion.length;
  document.getElementById('hero-quick-stats').textContent =
    total > 0 ? `${correctCount} von ${total} richtig` : 'Noch keine Antworten';
}

function renderQuestionChart(bars) {
  const ctx = document.getElementById('question-chart').getContext('2d');
  const labels = bars.map((b) => b.label);
  const data = bars.map((b) => b.count);
  const colors = bars.map((b) => (b.isCorrect ? gradient(ctx, '#4ade80', '#16a34a') : gradient(ctx, '#60a5fa', '#1d4ed8')));
  const voters = bars.map((b) => b.voters ?? []);

  const tooltipCallbacks = {
    afterLabel: (item) => formatVoterLines(voters[item.dataIndex]),
  };

  if (!questionChart) {
    questionChart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 8, maxBarThickness: 64 }] },
      options: chartBaseOptions({ showLegend: false, tooltipCallbacks }),
    });
    return;
  }

  questionChart.data.labels = labels;
  questionChart.data.datasets[0].data = data;
  questionChart.data.datasets[0].backgroundColor = colors;
  questionChart.options.plugins.tooltip.callbacks = tooltipCallbacks;
  questionChart.update();
}

// Chart.js-Tooltip-Callback: Zeilen fuer die Namen, die auf diesen Balken
// entfallen sind, damit man beim Hoovern sieht wer wie abgestimmt hat.
function formatVoterLines(names) {
  if (!names || names.length === 0) return ['Noch niemand'];
  const maxShown = 8;
  const shown = names.slice(0, maxShown);
  const lines = [];
  for (let i = 0; i < shown.length; i += 3) {
    lines.push(shown.slice(i, i + 3).join(', '));
  }
  if (names.length > maxShown) lines.push(`+${names.length - maxShown} weitere`);
  return lines;
}

function renderClosingStats() {
  const stats = computeClosingStats({ participants, responses, questions });
  const el = document.getElementById('closing-stats');
  const parts = [];
  if (stats.fastestCorrect?.participant) {
    parts.push(
      `<p><strong>Schnellste richtige Antwort:</strong> ${escapeHtml(stats.fastestCorrect.participant.display_name)} (${(stats.fastestCorrect.latencyMs / 1000).toFixed(1)}s)</p>`
    );
  }
  if (stats.hardestQuestion?.question) {
    parts.push(
      `<p><strong>Schwerste Frage:</strong> ${escapeHtml(stats.hardestQuestion.question.prompt)} (${stats.hardestQuestion.misses}× falsch beantwortet)</p>`
    );
  }
  el.innerHTML = parts.join('') || '<p class="muted">Noch keine Auswertung möglich.</p>';
}

function renderLeaderboard() {
  const leaderboard = computeLeaderboard({ participants, responses });
  const top = leaderboard.slice(0, LEADERBOARD_TOP_N);

  document.getElementById('leaderboard-empty').hidden = leaderboard.length > 0;
  document.getElementById('leaderboard-chart-wrap').hidden = leaderboard.length === 0;

  if (leaderboard.length > 0) {
    renderLeaderboardChart(document.getElementById('leaderboard-chart'), top, {
      instance: leaderboardChart,
      instanceSetter: (c) => (leaderboardChart = c),
    });
  }

  document.getElementById('leaderboard-drilldown').onclick = () => openLeaderboardDrilldown(leaderboard);
}

// Gold/Silber/Bronze fuer die Top 3, danach ein Blauverlauf: Platz 4 hellblau,
// ab Platz 10 (und dahinter) Mitternachtsblau. Metallic-Look fuer die Top 3
// per dreistufigem Gradient (hell-mittel-dunkel statt nur zwei Stops).
const RANK_GOLD = ['#fef3c7', '#fbbf24', '#b45309'];
const RANK_SILVER = ['#f8fafc', '#cbd5e1', '#64748b'];
const RANK_BRONZE = ['#fde8d1', '#e0975a', '#7c4a1e'];

function metallicGradient(ctx, stops) {
  const g = ctx.createLinearGradient(0, 0, 0, 260);
  g.addColorStop(0, stops[0]);
  g.addColorStop(0.55, stops[1]);
  g.addColorStop(1, stops[2]);
  return g;
}

function blueShadeForRank(rank) {
  const t = Math.min(1, Math.max(0, (rank - 4) / 6)); // Platz 4 -> 0, Platz 10+ -> 1
  const h = 199 + 32 * t;
  const s = 92 - 42 * t;
  const l = 74 - 54 * t;
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;
}

function rankBarColor(ctx, rank) {
  if (rank === 1) return metallicGradient(ctx, RANK_GOLD);
  if (rank === 2) return metallicGradient(ctx, RANK_SILVER);
  if (rank === 3) return metallicGradient(ctx, RANK_BRONZE);
  return blueShadeForRank(rank);
}

function renderLeaderboardChart(canvasEl, leaderboard, { instance, instanceSetter }) {
  const ctx = canvasEl.getContext('2d');
  const labels = leaderboard.map((e) => e.participant.display_name);
  const data = leaderboard.map((e) => e.totalPoints);
  const colors = leaderboard.map((_, i) => rankBarColor(ctx, i + 1));

  const tooltipCallbacks = {
    title: (items) => `Platz ${items[0].dataIndex + 1} · ${items[0].label}`,
    label: (item) => `${item.formattedValue} Punkte`,
    afterLabel: (item) => {
      const entry = leaderboard[item.dataIndex];
      const accuracy = entry.answeredCount > 0 ? `${entry.correctCount}/${entry.answeredCount} richtig` : 'noch keine Antwort';
      const latency = entry.avgLatencyMs != null ? `Ø ${(entry.avgLatencyMs / 1000).toFixed(1)}s` : null;
      return latency ? `${accuracy} · ${latency}` : accuracy;
    },
  };
  const options = chartBaseOptions({ showLegend: false, tooltipCallbacks });
  options.onClick = (_event, elements) => {
    if (elements.length === 0) return;
    openParticipantDrilldown(leaderboard[elements[0].index].participant);
  };
  options.onHover = (event, elements) => {
    if (event.native?.target) event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
  };

  if (!instance) {
    const chart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 8, maxBarThickness: 56 }] },
      options,
    });
    instanceSetter(chart);
    return;
  }

  instance.data.labels = labels;
  instance.data.datasets[0].data = data;
  instance.data.datasets[0].backgroundColor = colors;
  instance.options.onClick = options.onClick;
  instance.options.onHover = options.onHover;
  instance.options.plugins.tooltip.callbacks = tooltipCallbacks;
  instance.update();
}

function renderProgression() {
  const progression = computePointsProgression({ participants, responses, roundQuestions });
  const byPoints = [...progression].sort(
    (a, b) => (b.series.at(-1) ?? 0) - (a.series.at(-1) ?? 0)
  );
  const top = byPoints.slice(0, PROGRESSION_TOP_N);

  const hasData = roundQuestions.some((q) => responses.some((r) => r.question_id === q.id));
  document.getElementById('progression-empty').hidden = hasData;
  document.getElementById('progression-chart-wrap').hidden = !hasData;

  if (hasData) {
    renderProgressionChart(document.getElementById('progression-chart'), top, { instanceSetter: (c) => (progressionChart = c), instance: progressionChart });
  }

  document.getElementById('progression-drilldown').onclick = () => openProgressionDrilldown(byPoints);
}

function renderProgressionChart(canvasEl, series, { instance, instanceSetter, legend = true }) {
  // Rundenrelative Nummerierung (#1, #2, ...), nicht die Katalog-position: die
  // Runde ist eine zufaellige Teilmenge, Katalogpositionen waeren hier luecken-
  // haft und ohne Aussage ueber die tatsaechliche Reihenfolge in dieser Runde.
  const labels = roundQuestions.map((_, i) => `#${i + 1}`);
  const datasets = series.map((s, i) => ({
    label: s.participant.display_name,
    data: s.series,
    borderColor: LINE_PALETTE[i % LINE_PALETTE.length],
    backgroundColor: LINE_PALETTE[i % LINE_PALETTE.length],
    tension: 0.3,
    pointRadius: 3,
    borderWidth: 2,
  }));

  if (!instance) {
    const chart = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: chartBaseOptions({ showLegend: legend }),
    });
    instanceSetter(chart);
    return;
  }

  instance.data.labels = labels;
  instance.data.datasets = datasets;
  instance.update();
}

function chartBaseOptions({ showLegend, tooltipCallbacks = {} }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 500 },
    plugins: {
      legend: {
        display: showLegend,
        position: 'top',
        labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } },
      },
      tooltip: {
        backgroundColor: '#1e293b',
        titleColor: '#f1f5f9',
        bodyColor: '#f1f5f9',
        padding: 10,
        callbacks: tooltipCallbacks,
      },
    },
    scales: {
      x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.08)' } },
      y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.08)' }, beginAtZero: true },
    },
  };
}

function gradient(ctx, from, to) {
  const g = ctx.createLinearGradient(0, 0, 0, 220);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

// --- Countdown (nur Anzeige im Dashboard-Tab; ausgeloest wird das Schliessen
// vom Presenter-Tab, siehe autoCloseTick weiter unten) ---

function tickCountdown() {
  const question = currentQuestion();
  const badge = document.getElementById('hero-timer');
  if (!question || isRevealed(session)) {
    badge.hidden = true;
    return;
  }
  const deadline = computeAutoCloseAt({ session, questions });
  if (deadline === null) {
    badge.hidden = true;
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  badge.hidden = false;
  badge.textContent = `${secondsLeft}s`;
  badge.classList.toggle('hero-timer--urgent', secondsLeft <= 5);
}

// --- Rendering: Presenter-Tab ----------------------------------------------

function renderPresenter() {
  const view = buildPresenterView({ session, questions, responses, participantCount: participants.length });

  document.getElementById('presenter-session-status').textContent = PRESENTER_STATUS_LABEL[view.status] ?? view.status;
  document.getElementById('presenter-participant-count').textContent = `${view.participantCount} angemeldet`;

  document.getElementById('no-round-hint').hidden = view.hasActiveRound;
  document.getElementById('question-table-wrap').hidden = !view.hasActiveRound;

  const tbody = document.getElementById('question-rows');
  tbody.innerHTML = '';

  for (const row of view.rows) {
    const tr = document.createElement('tr');

    const badge = document.createElement('span');
    badge.className = `row-badge row-badge--${row.badge}`;
    badge.textContent = BADGE_LABEL[row.badge];

    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    if (row.badge === 'open') {
      actionButton.textContent = 'Schließen';
      actionButton.addEventListener('click', () => closeQuestion());
    } else {
      actionButton.textContent = 'Öffnen';
      actionButton.addEventListener('click', () => openQuestion(row.question.id));
    }

    tr.innerHTML = `
      <td>${row.question.position}</td>
      <td>${escapeHtml(row.question.prompt)}</td>
      <td>${TYPE_LABEL[row.question.question_type] ?? row.question.question_type}</td>
      <td></td>
      <td class="muted"${row.badge === 'open' ? ' data-countdown' : ''}></td>
      <td>${row.responseCount}</td>
      <td></td>
    `;
    tr.children[3].appendChild(badge);
    tr.children[6].appendChild(actionButton);
    tbody.appendChild(tr);
  }

  document.getElementById('finish-button').disabled = !view.canFinish;
  document.getElementById('start-round-button').disabled = !view.canStartRound;
  document.getElementById('round-size-input').disabled = !view.canStartRound;
  document.getElementById('cancel-round-button').disabled = !view.canCancelRound;

  const askedCount = questions.filter((q) => q.times_asked > 0).length;
  document.getElementById('round-catalog-hint').textContent =
    `Katalog: ${questions.length} Fragen, davon ${askedCount} schon mindestens einmal gestellt.`;
  document.getElementById('round-size-input').max = String(questions.length);

  renderCountdownOnly();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Laeuft jede Sekunde: schliesst die offene Frage automatisch, wenn ihr Zeitlimit
// abgelaufen ist oder alle Teilnehmer schon geantwortet haben (siehe shared/quiz-timer.js).
// Selbstbegrenzend: sobald status != 'open' ist, greift die Regel nicht mehr,
// kein extra Flag noetig gegen doppeltes Schliessen. Laeuft unabhaengig davon,
// welcher Tab gerade sichtbar ist, wie zuvor auf der eigenen Presenter-Seite.
let autoCloseInFlight = false;

function autoCloseTick() {
  if (autoCloseInFlight) return;
  const dueForAutoClose = shouldAutoClose({
    session,
    questions,
    responseCount: responses.filter((r) => r.question_id === session?.current_question_id).length,
    participantCount: participants.length,
    now: Date.now(),
  });
  if (!dueForAutoClose) return;
  autoCloseInFlight = true;
  closeQuestion().finally(() => {
    autoCloseInFlight = false;
  });
}

// Zaehlt die Sekundenanzeige der offenen Zeile jede Sekunde runter, ohne die
// ganze Tabelle neu aufzubauen (renderPresenter() wuerde bei jedem Tick alle
// Buttons/Listener neu erzeugen, unnoetig fuer eine reine Zahlenanzeige).
function renderCountdownOnly() {
  const deadline = computeAutoCloseAt({ session, questions });
  const el = document.querySelector('#tab-presenter [data-countdown]');
  if (!el) return;
  if (deadline === null) {
    el.textContent = '';
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${secondsLeft}s`;
}

function wireControls() {
  document.getElementById('finish-button').addEventListener('click', () => finishQuiz());

  document.getElementById('start-round-button').addEventListener('click', () => {
    const size = parseInt(document.getElementById('round-size-input').value, 10);
    if (!Number.isFinite(size) || size < 1) {
      showToast('Bitte eine gueltige Rundengroesse eingeben.');
      return;
    }
    startRound(size);
  });

  document.getElementById('cancel-round-button').addEventListener('click', () => {
    if (!window.confirm('Aktuelle Runde wirklich abbrechen? Die laufende Frage wird zurueckgesetzt.')) return;
    cancelRound();
  });
}

// quiz_sessions ist fuer direkte Schreibzugriffe gesperrt (siehe Migration
// presenter_control_rpc): jede Aenderung laeuft ueber diese RPC mit einem
// Presenter-Passwort, sonst koennte jeder Teilnehmer ueber denselben
// Anonymous-Auth-Zugang das Quiz kapern. Das Passwort wird einmal pro
// Browser-Sitzung abgefragt und in sessionStorage gecacht, nicht in
// localStorage, damit es nicht ueber Neustarts hinweg auf dem Geraet bleibt.
function getPresenterSecret() {
  let secret = sessionStorage.getItem('presenterSecret');
  if (!secret) {
    secret = window.prompt('Presenter-Passwort:') ?? '';
    sessionStorage.setItem('presenterSecret', secret);
  }
  return secret;
}

// Gibt true bei Erfolg zurueck, false bei einem Fehler (Passwort oder Validierung).
async function callPresenterControl(action, targetQuestionId, roundSize = null) {
  const { error } = await supabaseClient.rpc('presenter_control', {
    action,
    target_question_id: targetQuestionId,
    presenter_secret: getPresenterSecret(),
    round_size: roundSize,
  });
  if (error) {
    // Nur bei falschem Passwort (errcode 28000) den Cache loeschen, damit beim
    // naechsten Versuch neu abgefragt wird. Andere Fehler (z.B. eine ungueltige
    // Rundengroesse, oder "Frage nicht Teil der Runde") sind Validierungsfehler,
    // das Passwort selbst war richtig und bleibt gecacht.
    if (error.code === '28000') {
      sessionStorage.removeItem('presenterSecret');
    }
    // Bewusst auch falsche Passwoerter geloggt (nicht nur echte Server-Fehler):
    // wiederholte 28000-Eintraege im Log waeren ein Kaperungsversuch, siehe
    // Architekturentscheidung zum Presenter-Schutz. shouldLog() dedupt ohnehin.
    logError('dashboard', error.message, { action: `presenter_control:${action}`, tab: 'presenter' });
    showToast(error.message);
    return false;
  }
  return true;
}

async function openQuestion(questionId) {
  const ok = await callPresenterControl('open', questionId);
  if (!ok) return;
  // Optimistisches Update statt einer eigenen Realtime-Subscription auf questions:
  // times_asked wird serverseitig in derselben RPC hochgezaehlt (siehe Migration
  // quiz_rounds), und Presenter ist ohnehin die einzige schreibende Instanz.
  const question = questions.find((q) => q.id === questionId);
  if (question) question.times_asked = (question.times_asked ?? 0) + 1;
}

async function closeQuestion() {
  await callPresenterControl('close', null);
}

async function finishQuiz() {
  await callPresenterControl('finish', null);
}

async function startRound(roundSize) {
  await callPresenterControl('start_round', null, roundSize);
}

async function cancelRound() {
  await callPresenterControl('cancel_round', null);
}

// --- Drilldowns (Dashboard-Tab) --------------------------------------------

function openModal(title, bodyBuilder) {
  document.getElementById('drilldown-title').textContent = title;
  const body = document.getElementById('drilldown-body');
  body.innerHTML = '';
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
  bodyBuilder(body);
  document.getElementById('drilldown-overlay').hidden = false;
}

function closeModal() {
  document.getElementById('drilldown-overlay').hidden = true;
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
}

function openLeaderboardDrilldown(leaderboard) {
  openModal('Gesamt-Leaderboard', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'drilldown-chart-wrap';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    renderLeaderboardChart(canvas, leaderboard, { instance: null, instanceSetter: (c) => (modalChart = c) });
  });
}

function openParticipantDrilldown(participant) {
  openModal(participant.display_name, (body) => {
    const table = document.createElement('table');
    table.className = 'drilldown-table';
    table.innerHTML = '<thead><tr><th>#</th><th>Frage</th><th>Ergebnis</th><th>Punkte</th><th>Zeit</th></tr></thead>';
    const tbody = document.createElement('tbody');
    roundQuestions.forEach((question, i) => {
      const response = responses.find((r) => r.participant_id === participant.id && r.question_id === question.id);
      const tr = document.createElement('tr');
      const resultLabel = !response ? '–' : response.is_correct ? '✓ richtig' : '✗ falsch';
      const latency = response?.latency_ms != null ? `${(response.latency_ms / 1000).toFixed(1)}s` : '–';
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td></td>
        <td class="${response?.is_correct ? 'is-correct' : response ? 'is-wrong' : ''}">${resultLabel}</td>
        <td>${response?.points_awarded ?? '–'}</td>
        <td>${latency}</td>
      `;
      tr.children[1].textContent = question.prompt;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  });
}

function openProgressionDrilldown(allSeries) {
  openModal('Punkte-Verlauf — alle Teilnehmer', (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'drilldown-chart-wrap';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    body.appendChild(wrap);
    renderProgressionChart(canvas, allSeries, {
      instance: null,
      instanceSetter: (c) => (modalChart = c),
      legend: allSeries.length <= 12,
    });
  });
}

document.getElementById('drilldown-close').addEventListener('click', closeModal);
document.getElementById('drilldown-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'drilldown-overlay') closeModal();
});

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
