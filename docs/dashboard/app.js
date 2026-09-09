// DOM-Verdrahtung + Chart.js um die getestete Aggregationslogik in
// shared/dashboard-state.js, shared/presenter-state.js und shared/quiz-timer.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.
//
// Dashboard und Presenter sind zwei Tabs derselben Seite (docs/presenter/
// leitet nur noch hierher um). Beide Tabs teilen sich einen einzigen
// Datenabruf und dieselben drei Realtime-Subscriptions (quiz_sessions/
// responses/participants), render() aktualisiert deshalb immer beide,
// unabhaengig davon welcher Tab sichtbar ist.

import { supabaseClient } from '../shared/supabase-client.js';
import { computeAutoCloseAt, shouldAutoClose } from '../shared/quiz-timer.js';
import { buildPresenterView, computeNextQuestionId } from '../shared/presenter-state.js';
import { installGlobalErrorHandlers, logError } from '../shared/error-log.js';
import {
  isRevealed,
  aggregateMultipleChoice,
  aggregateEstimation,
  computeLeaderboard,
  computeClosingStats,
  computeQuestionProgress,
  filterToRound,
  effectiveRoundQuestionIds,
} from '../shared/dashboard-state.js';

// 'dashboard' als source deckt beide Tabs ab (Presenter ist kein eigener
// Prozess mehr, siehe Kommentar oben); errorLogs.context.tab unterscheidet
// bei Bedarf, aus welchem Tab heraus der Fehler ausgeloest wurde.
installGlobalErrorHandlers('dashboard');

const VIEWS = ['loading', 'empty', 'main', 'error'];
const TYPE_LABEL = { multiple_choice: 'Multiple-Choice', estimation: 'Schätzung' };
const DASHBOARD_STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Ergebnis', finished: 'Quiz beendet' };
const PRESENTER_STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Frage geschlossen', finished: 'Quiz beendet' };
const BADGE_LABEL = { pending: '–', open: 'Live', closed: 'Geschlossen' };
const LEADERBOARD_TOP_N = 10; // deckt sich mit dem Rang-Farbverlauf bis Platz 10
const DEFAULT_ROUND_SIZE = 10;

let session = null;
let questions = [];
let participants = [];
let responses = [];
let roundQuestions = []; // questions der aktuellen Runde, in Auswahlreihenfolge (session.round_question_ids)
const revealedAnswers = new Map(); // question_id -> question_answers row, best-effort Cache
let errorLogs = []; // neueste zuerst, siehe loadErrorLogs()
let reviewQuestionId = null; // ausgewaehlte Frage im Review-Modus (nur wenn status === 'finished')

let questionChart = null;
let leaderboardChart = null;
let reviewChart = null;
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
  setInterval(renderCountdownOnly, 1000);
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
    // Noetig seit rescore_estimation_responses (Migration estimation_closest_wins):
    // beim Schliessen einer Schaetzfrage aktualisiert der Presenter is_correct/
    // points_awarded serverseitig per UPDATE fuer ALLE Antworten dieser Frage,
    // nicht nur die eigene. Ohne diesen Handler wuerden Leaderboard und Ergebnis-
    // Balken erst nach einem manuellen Reload den echten Gewinner zeigen.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'responses' }, (payload) => {
      const idx = responses.findIndex((r) => r.id === payload.new.id);
      if (idx !== -1) responses[idx] = payload.new;
      render();
    })
    .subscribe();

  supabaseClient
    .channel('participants-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants' }, (payload) => {
      participants.push(payload.new);
      render();
    })
    // Faengt ein Entfernen ueber ein zweites geoeffnetes Presenter-/Dashboard-
    // Fenster ab (removeParticipant spiegelt den eigenen Fall schon lokal,
    // dieser Handler ist fuer alle anderen offenen Tabs). payload.old traegt
    // ohne REPLICA IDENTITY FULL nur die Primary-Key-Spalte id, das reicht hier.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'participants' }, (payload) => {
      participants = participants.filter((p) => p.id !== payload.old.id);
      responses = responses.filter((r) => r.participant_id !== payload.old.id);
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
    renderReview();
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

// Multiple-Choice-Optionen sind oft ganze Saetze (siehe Fragenkatalog), Chart.js
// rotiert/ueberlappt lange einzeilige X-Achsen-Labels sonst unlesbar. Fix:
// Labels als Zeilen-Array statt einzelner String, Chart.js rendert ein Array
// automatisch mehrzeilig.
function wrapChartLabel(label, maxCharsPerLine = 18) {
  const words = String(label).split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Gemeinsamer Balken-Renderer fuer die laufende Frage (hero) UND den
// Review-Modus (siehe renderReviewChart) -- gleiche Darstellung, zwei Canvases.
function renderBarsChart(canvasEl, bars, { instance, instanceSetter }) {
  const ctx = canvasEl.getContext('2d');
  const labels = bars.map((b) => wrapChartLabel(b.label));
  const data = bars.map((b) => b.count);
  const colors = bars.map((b) => (b.isCorrect ? gradient(ctx, '#4ade80', '#16a34a') : gradient(ctx, '#60a5fa', '#1d4ed8')));
  const voters = bars.map((b) => b.voters ?? []);

  const tooltipCallbacks = {
    afterLabel: (item) => formatVoterLines(voters[item.dataIndex]),
  };

  if (!instance) {
    const chart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 8, maxBarThickness: 64 }] },
      options: chartBaseOptions({ showLegend: false, tooltipCallbacks }),
    });
    instanceSetter(chart);
    return;
  }

  instance.data.labels = labels;
  instance.data.datasets[0].data = data;
  instance.data.datasets[0].backgroundColor = colors;
  instance.options.plugins.tooltip.callbacks = tooltipCallbacks;
  instance.update();
}

function renderQuestionChart(bars) {
  renderBarsChart(document.getElementById('question-chart'), bars, {
    instance: questionChart,
    instanceSetter: (c) => (questionChart = c),
  });
}

function renderReviewChart(bars) {
  renderBarsChart(document.getElementById('review-chart'), bars, {
    instance: reviewChart,
    instanceSetter: (c) => (reviewChart = c),
  });
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
  const stats = computeClosingStats({
    participants,
    responses,
    questions,
    roundQuestionIds: session?.round_question_ids ?? null,
    roundStartedAt: session?.round_started_at ?? null,
  });
  const el = document.getElementById('closing-stats');
  const parts = [];
  if (stats.fastestCorrect?.participant) {
    parts.push(
      `<p><strong>Schnellste richtige Antwort:</strong> ${escapeHtml(stats.fastestCorrect.participant.display_name)} (${(stats.fastestCorrect.latencyMs / 1000).toFixed(1)}s)</p>`
    );
  }
  if (stats.mostMissedQuestion?.question) {
    parts.push(
      `<p><strong>Am häufigsten falsch beantwortet:</strong> ${escapeHtml(stats.mostMissedQuestion.question.prompt)} (${stats.mostMissedQuestion.misses}× falsch)</p>`
    );
  }
  if (stats.mostIndecisive?.participant && stats.mostIndecisive.changeCount > 0) {
    parts.push(
      `<p><strong>Am meisten umentschieden:</strong> ${escapeHtml(stats.mostIndecisive.participant.display_name)} (${stats.mostIndecisive.changeCount}× die Antwort gewechselt)</p>`
    );
  }
  el.innerHTML = parts.join('') || '<p class="muted">Noch keine Auswertung möglich.</p>';
}

function renderLeaderboard() {
  const leaderboard = computeLeaderboard({
    participants,
    responses,
    roundQuestionIds: effectiveRoundQuestionIds(session),
    roundStartedAt: session?.round_started_at ?? null,
    session,
  });
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

// --- Review-Modus -----------------------------------------------------------
// Nach "Quiz beenden" durch die Fragen der abgeschlossenen Runde blaettern und
// sehen, wie abgestimmt wurde -- rein lesend, ruehrt quiz_sessions/current_question_id
// nicht an (das ist der Live-Steuerungspfad, siehe openQuestion). question_answers
// ist fuer alle Runden-Fragen erst lesbar, seit Migration 20260906130000 die
// Reveal-Policy auf "Quiz komplett beendet" erweitert hat (vorher nur die zuletzt
// gestellte Frage).
function renderReview() {
  const panel = document.getElementById('review-panel');
  if (roundQuestions.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const select = document.getElementById('review-picker');
  const previousValue = select.value;
  select.innerHTML = '';
  roundQuestions.forEach((q, i) => {
    const el = document.createElement('option');
    el.value = q.id;
    el.textContent = `${i + 1}. ${q.prompt}`;
    select.appendChild(el);
  });

  if (roundQuestions.some((q) => q.id === previousValue)) {
    reviewQuestionId = previousValue;
  } else if (!roundQuestions.some((q) => q.id === reviewQuestionId)) {
    reviewQuestionId = roundQuestions[0].id;
  }
  select.value = reviewQuestionId;

  renderReviewResult(reviewQuestionId);
}

async function renderReviewResult(questionId) {
  const question = questions.find((q) => q.id === questionId);
  if (!question) return;
  const answer = await ensureRevealedAnswer(questionId);

  // Zwischenzeitlich per Dropdown weitergeklickt, waehrend die Antwort noch
  // lud: verworfenes veraltetes Ergebnis nicht mehr rendern.
  if (reviewQuestionId !== questionId) return;

  let bars;
  if (question.question_type === 'multiple_choice') {
    bars = aggregateMultipleChoice({ question, responses, participants, correctOption: answer?.correct_option ?? null });
  } else {
    const result = aggregateEstimation({ question, responses, participants, correctValue: answer?.correct_value ?? null });
    bars = result.bars;
  }
  renderReviewChart(bars);

  const callout = document.getElementById('review-correct-callout');
  if (answer && question.question_type === 'multiple_choice') {
    callout.textContent = `Richtige Antwort: ${answer.correct_option}`;
  } else if (answer && question.question_type === 'estimation') {
    callout.textContent = `Richtiger Wert: ${answer.correct_value}`;
  } else {
    callout.textContent = '';
  }

  const responsesForQuestion = responses.filter((r) => r.question_id === question.id);
  const correctCount = responsesForQuestion.filter((r) => r.is_correct).length;
  const total = responsesForQuestion.length;
  document.getElementById('review-quick-stats').textContent =
    total > 0 ? `${correctCount} von ${total} richtig` : 'Keine Antworten';
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
      // maxRotation: 0 verhindert, dass Chart.js die (dank wrapChartLabel schon
      // kurzen) Zeilen zusaetzlich noch schraeg dreht -- genau das hatte die
      // langen Multiple-Choice-Optionen unlesbar ueberlappen lassen.
      x: { ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: false }, grid: { color: 'rgba(148,163,184,0.08)' } },
      // precision: 0 zwingt Chart.js auf ganzzahlige Achsenschritte. Ohne das
      // wählt Chart.js bei kleinen Maximalwerten (z.B. 2 Stimmen, oder 1 Punkt
      // nach der Punkte-Umstellung auf 1/Frage) von sich aus Dezimalschritte
      // wie 0.5 -- unsinnig fuer Stimmenzahlen und Punkte, die nur ganzzahlig
      // vorkommen.
      y: { ticks: { color: '#94a3b8', precision: 0 }, grid: { color: 'rgba(148,163,184,0.08)' }, beginAtZero: true },
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
  const view = buildPresenterView({ session, questions, responses, participants });

  document.getElementById('presenter-session-status').textContent = PRESENTER_STATUS_LABEL[view.status] ?? view.status;
  document.getElementById('presenter-participant-count').textContent = `${view.participantCount} angemeldet`;

  renderParticipantsList(view.participants);

  document.getElementById('no-round-hint').hidden = view.hasActiveRound;
  document.getElementById('question-picker-wrap').hidden = !view.hasActiveRound;

  renderQuestionPicker(view.options);

  const panel = document.getElementById('current-question-panel');
  panel.hidden = !view.current;
  if (view.current) {
    const badge = document.getElementById('current-question-badge');
    badge.className = `row-badge row-badge--${view.current.badge}`;
    badge.textContent = BADGE_LABEL[view.current.badge];
    document.getElementById('current-question-prompt').textContent = view.current.question?.prompt ?? '';
    document.getElementById('current-question-responses').textContent = `${view.current.responseCount} Antworten`;
    document.getElementById('close-question-button').disabled = !view.canClose;
  }

  document.getElementById('finish-button').disabled = !view.canFinish;
  document.getElementById('reset-to-lobby-button').disabled = !view.canResetToLobby;
  document.getElementById('start-round-button').disabled = !view.canStartRound;
  document.getElementById('round-size-input').disabled = !view.canStartRound;
  document.getElementById('cancel-round-button').disabled = !view.canCancelRound;

  const askedCount = questions.filter((q) => q.times_asked > 0).length;
  document.getElementById('round-catalog-hint').textContent =
    `Katalog: ${questions.length} Fragen, davon ${askedCount} schon mindestens einmal gestellt.`;
  document.getElementById('round-size-input').max = String(questions.length);

  renderCountdownOnly();
}

// Alphabetisch sortierte Liste aus buildPresenterView, je Zeile ein Entfernen-
// Button. Neu aufgebaut bei jedem render() statt diffend aktualisiert, wie
// auch renderErrorLog/renderQuestionPicker das handhaben -- die Liste bleibt
// klein genug (Obergrenze 150 Teilnehmer, siehe Migration participants_cap),
// dass ein kompletter Rebuild nicht spuerbar ist.
function renderParticipantsList(list) {
  const container = document.getElementById('presenter-participants-list');
  document.getElementById('presenter-participants-empty').hidden = list.length > 0;
  container.innerHTML = '';

  for (const participant of list) {
    const li = document.createElement('li');
    li.className = 'participant-row';
    li.innerHTML = `
      <span class="participant-name"></span>
      <button type="button" class="button-secondary participant-remove-button">Entfernen</button>
    `;
    li.querySelector('.participant-name').textContent = participant.name;
    li.querySelector('.participant-remove-button').addEventListener('click', () => removeParticipant(participant));
    container.appendChild(li);
  }
}

// participants ist fuer direkte Deletes gesperrt (keine delete-Policy, gleiches
// Muster wie quiz_sessions): laeuft ueber presenter_remove_participant() mit
// demselben Presenter-Passwort wie callPresenterControl, siehe Migration
// presenter_remove_participant. Cascade loescht dessen responses server-
// seitig mit, hier lokal gespiegelt, damit Dashboard-Aggregationen (Leader-
// board, Balken) sofort ohne Reload konsistent bleiben.
async function removeParticipant(participant) {
  if (!window.confirm(`"${participant.name}" wirklich entfernen? Abgegebene Antworten gehen verloren.`)) return;

  const { error } = await supabaseClient.rpc('presenter_remove_participant', {
    target_participant_id: participant.id,
    presenter_secret: getPresenterSecret(),
  });
  if (error) {
    if (error.code === '28000') {
      sessionStorage.removeItem('presenterSecret');
    }
    logError('dashboard', error.message, { action: 'presenter_remove_participant', tab: 'presenter' });
    showToast(error.message);
    return;
  }

  participants = participants.filter((p) => p.id !== participant.id);
  responses = responses.filter((r) => r.participant_id !== participant.id);
  render();
}

// Dropdown zeigt bewusst nur "Frage N" (+ Status), nie den Prompt-Text: Mit-
// schueler sehen per Screenshare mit, wie die Runde gesteuert wird, kommende
// Fragen sollen vorher nicht lesbar sein. Der
// volle Text erscheint erst im current-question-panel, sobald eine Frage
// tatsaechlich offen ist -- das Publikum sieht sie dann ohnehin zeitgleich
// im Dashboard-Tab.
function renderQuestionPicker(options) {
  const select = document.getElementById('question-picker');
  const previousValue = select.value;
  select.innerHTML = '';

  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.isCurrent
      ? `${option.label} (aktuell)`
      : option.alreadyAsked
        ? `${option.label} (gestellt)`
        : option.label;
    select.appendChild(el);
  }

  // Auswahl erhalten, wenn die Option noch existiert (z.B. beim Umschalten
  // zwischen Tabs), sonst auf die aktuelle Frage springen, damit "Oeffnen"
  // nie versehentlich eine veraltete id trifft.
  if (options.some((o) => o.id === previousValue)) {
    select.value = previousValue;
  } else {
    select.value = options.find((o) => o.isCurrent)?.id ?? options[0]?.id ?? '';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Laeuft jede Sekunde: schliesst die offene Frage automatisch, sobald ihr Zeitlimit
// abgelaufen ist (siehe shared/quiz-timer.js), fester Timer, kein Fruehschluss mehr.
// Selbstbegrenzend: sobald status != 'open' ist, greift die Regel nicht mehr,
// kein extra Flag noetig gegen doppeltes Schliessen. Laeuft unabhaengig davon,
// welcher Tab gerade sichtbar ist, wie zuvor auf der eigenen Presenter-Seite.
let autoCloseInFlight = false;

function autoCloseTick() {
  if (autoCloseInFlight) return;
  const dueForAutoClose = shouldAutoClose({ session, questions, now: Date.now() });
  if (!dueForAutoClose) return;
  autoCloseInFlight = true;
  closeQuestion({ interactive: false }).finally(() => {
    autoCloseInFlight = false;
  });
}

// Zaehlt die Presenter-Timer-Badge jede Sekunde runter, ohne renderPresenter()
// komplett neu aufzurufen (das wuerde Dropdown/Listener unnoetig neu aufbauen).
// Gleiche "rot in den letzten 5s"-Regel wie beim Dashboard-Hero-Timer (tickCountdown).
function renderCountdownOnly() {
  const deadline = computeAutoCloseAt({ session, questions });
  const el = document.getElementById('current-question-timer');
  if (deadline === null) {
    el.hidden = true;
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.hidden = false;
  el.textContent = `${secondsLeft}s`;
  el.classList.toggle('hero-timer--urgent', secondsLeft <= 5);
}

function wireControls() {
  document.getElementById('finish-button').addEventListener('click', () => finishQuiz());
  document.getElementById('reset-to-lobby-button').addEventListener('click', () => {
    if (!window.confirm('Zurueck zur Lobby? Teilnehmer sehen wieder den Begruessungsbildschirm, die Abschluss-Auswertung dieser Runde ist danach nicht mehr einsehbar.')) return;
    cancelRound();
  });
  document.getElementById('close-question-button').addEventListener('click', () => closeQuestion());
  document.getElementById('open-question-button').addEventListener('click', () => {
    const id = document.getElementById('question-picker').value;
    if (id) openQuestion(id);
  });

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

  document.getElementById('review-picker').addEventListener('change', (event) => {
    reviewQuestionId = event.target.value;
    renderReviewResult(reviewQuestionId);
  });
}

// quiz_sessions ist fuer direkte Schreibzugriffe gesperrt (siehe Migration
// presenter_control_rpc): jede Aenderung laeuft ueber diese RPC mit einem
// Presenter-Passwort, sonst koennte jeder Teilnehmer ueber denselben
// Anonymous-Auth-Zugang das Quiz kapern. Das Passwort wird einmal pro
// Browser-Sitzung abgefragt und in sessionStorage gecacht, nicht in
// localStorage, damit es nicht ueber Neustarts hinweg auf dem Geraet bleibt.
// interactive=false (Auto-Close/Auto-Advance/Auto-Finish, siehe unten) fragt nie per
// window.prompt() nach: ein Hintergrund-Timer hat keine User-Geste, manche Browser
// lehnen prompt() dort mit "prompt() is not supported" rundweg ab. Ohne
// gecachtes Passwort bleibt die Automatik dann diesen Tick einfach aus,
// bis der Presenter einmal manuell interagiert (z.B. frisch geladene Seite mit bereits
// abgelaufenem Timer) -- kein neuer Fehlerzustand, siehe die bereits dokumentierte
// "Bekannte Grenze" zum Reload waehrend eines laufenden Timers.
function getPresenterSecret({ interactive = true } = {}) {
  let secret = sessionStorage.getItem('presenterSecret');
  if (!secret && interactive) {
    secret = window.prompt('Presenter-Passwort:') ?? '';
    sessionStorage.setItem('presenterSecret', secret);
  }
  return secret;
}

// Gibt true bei Erfolg zurueck, false bei einem Fehler (Passwort, Validierung, oder
// kein gecachtes Passwort bei einem nicht-interaktiven Aufruf).
async function callPresenterControl(action, targetQuestionId, roundSize = null, { interactive = true } = {}) {
  const presenterSecret = getPresenterSecret({ interactive });
  if (!presenterSecret && !interactive) return false;
  const { error } = await supabaseClient.rpc('presenter_control', {
    action,
    target_question_id: targetQuestionId,
    presenter_secret: presenterSecret,
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

// --- Auto-Advance ------------------------------------------------------
// Nach dem Schliessen einer Frage (per Timer oder manuell) oeffnet sich die
// naechste Frage der Runde von selbst, nach einer kurzen Anzeigezeit fuers
// Reveal (Timer-getriebenes Rundenspiel ohne Klick pro Frage).
// REVEAL_DWELL_MS ist eine eigene Setzung (gewaehlt, kein Sachzwang) -- lang
// genug, um die aufgedeckte Verteilung/Loesung im Dashboard kurz lesen zu
// koennen, ohne das Tempo der Runde zu sehr zu bremsen.
const REVEAL_DWELL_MS = 6000;
let advanceTimer = null;

function clearScheduledAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function scheduleAutoAdvance() {
  clearScheduledAdvance();
  const nextId = computeNextQuestionId({ session });
  const closedQuestionId = session?.current_question_id;
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    // Guard gegen zwischenzeitliches manuelles Eingreifen (Runde abgebrochen,
    // andere Frage geoeffnet, ...): nur weiterschalten, wenn der Zustand seit
    // dem Schliessen unveraendert ist.
    if (session?.status !== 'closed' || session?.current_question_id !== closedQuestionId) return;
    // Letzte Frage der Runde (kein nextId mehr): automatisch beenden statt
    // auf den manuellen "Quiz beenden"-Klick zu warten, damit Presenter und
    // Teilnehmer von selbst auf dem Abschlussbildschirm landen.
    if (nextId) {
      openQuestion(nextId, { interactive: false });
    } else {
      finishQuiz({ interactive: false });
    }
  }, REVEAL_DWELL_MS);
}

async function openQuestion(questionId, { interactive = true } = {}) {
  clearScheduledAdvance();
  const ok = await callPresenterControl('open', questionId, null, { interactive });
  if (!ok) return;
  // Optimistisches Update statt einer eigenen Realtime-Subscription auf questions:
  // times_asked wird serverseitig in derselben RPC hochgezaehlt (siehe Migration
  // quiz_rounds), und Presenter ist ohnehin die einzige schreibende Instanz.
  const question = questions.find((q) => q.id === questionId);
  if (question) question.times_asked = (question.times_asked ?? 0) + 1;
}

async function closeQuestion({ interactive = true } = {}) {
  const ok = await callPresenterControl('close', null, null, { interactive });
  if (ok) scheduleAutoAdvance();
}

async function finishQuiz({ interactive = true } = {}) {
  clearScheduledAdvance();
  await callPresenterControl('finish', null, null, { interactive });
}

async function startRound(roundSize) {
  clearScheduledAdvance();
  await callPresenterControl('start_round', null, roundSize);
}

// Wird von zwei Buttons genutzt: "Abbrechen" waehrend einer laufenden Runde
// und "Zurueck zur Lobby" nach status='finished' (siehe canResetToLobby) --
// beides braucht denselben Reset (Runde+Frage leeren, status auf 'lobby').
async function cancelRound() {
  clearScheduledAdvance();
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
  openModal('Leaderboard — aktuelle Runde', (body) => {
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
    // Rundenfilter wie beim Leaderboard: sonst schlaegt bei einer wiederholten
    // Frage die alte Antwort aus einer frueheren Runde hier durch.
    const roundResponses = filterToRound(responses, {
      roundQuestionIds: roundQuestions.map((q) => q.id),
      roundStartedAt: session?.round_started_at ?? null,
    });
    // Reveal-Gate wie beim Leaderboard (computeLeaderboard): die aktuell offene,
    // noch nicht geschlossene Frage zeigt hier nie richtig/falsch oder Punkte,
    // sonst verraet dieser Drilldown live, wer schon richtig/falsch geantwortet
    // hat, waehrend andere noch abstimmen.
    roundQuestions.forEach((question, i) => {
      const response = roundResponses.find((r) => r.participant_id === participant.id && r.question_id === question.id);
      const isOpenQuestion = question.id === session?.current_question_id && !isRevealed(session);
      const resultLabel = isOpenQuestion ? '…' : !response ? '–' : response.is_correct ? '✓ richtig' : '✗ falsch';
      const latency = isOpenQuestion || response?.latency_ms == null ? '–' : `${(response.latency_ms / 1000).toFixed(1)}s`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td></td>
        <td class="${!isOpenQuestion && response?.is_correct ? 'is-correct' : !isOpenQuestion && response ? 'is-wrong' : ''}">${resultLabel}</td>
        <td>${isOpenQuestion ? '–' : response?.points_awarded ?? '–'}</td>
        <td>${latency}</td>
      `;
      tr.children[1].textContent = question.prompt;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  });
}

document.getElementById('drilldown-close').addEventListener('click', closeModal);
document.getElementById('drilldown-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'drilldown-overlay') closeModal();
});

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
