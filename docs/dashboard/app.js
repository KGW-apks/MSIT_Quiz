// DOM-Verdrahtung + Chart.js um die getestete Aggregationslogik in
// shared/dashboard-state.js und shared/quiz-timer.js. Diese Datei selbst ist
// reine UI-Verdrahtung ohne eigene Entscheidungslogik und bewusst nicht
// durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { computeAutoCloseAt } from '../shared/quiz-timer.js';
import {
  isRevealed,
  aggregateMultipleChoice,
  aggregateEstimation,
  computeLeaderboard,
  computePointsProgression,
  computeClosingStats,
  computeQuestionProgress,
} from '../shared/dashboard-state.js';

const VIEWS = ['loading', 'empty', 'dashboard', 'error'];
const TYPE_LABEL = { multiple_choice: 'Multiple-Choice', estimation: 'Schätzung' };
const STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Ergebnis', finished: 'Quiz beendet' };
const PROGRESSION_TOP_N = 6;
const LEADERBOARD_TOP_N = 10; // deckt sich mit dem Rang-Farbverlauf bis Platz 10

const LINE_PALETTE = ['#22c55e', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#f87171'];

let session = null;
let questions = [];
let participants = [];
let responses = [];
const revealedAnswers = new Map(); // question_id -> question_answers row, best-effort Cache

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

  if (questionsError) return showError(questionsError.message);
  if (sessionError) return showError(sessionError.message);
  if (participantsError) return showError(participantsError.message);

  questions = questionData ?? [];
  if (questions.length === 0) {
    showView('empty');
    return;
  }

  session = sessionRow;
  participants = participantData ?? [];

  const { data: responseData, error: responsesError } = await supabaseClient.from('responses').select('*');
  if (responsesError) return showError(responsesError.message);
  responses = responseData ?? [];

  if (session && isRevealed(session) && session.current_question_id) {
    await ensureRevealedAnswer(session.current_question_id);
  }

  showView('dashboard');
  render();
  subscribeRealtime();
  setInterval(tickCountdown, 1000);
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

function subscribeRealtime() {
  supabaseClient
    .channel('dashboard-quiz-sessions')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'quiz_sessions' }, async (payload) => {
      session = payload.new;
      if (isRevealed(session) && session.current_question_id) {
        await ensureRevealedAnswer(session.current_question_id);
      }
      render();
    })
    .subscribe();

  supabaseClient
    .channel('dashboard-responses')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'responses' }, (payload) => {
      responses.push(payload.new);
      render();
    })
    .subscribe();

  supabaseClient
    .channel('dashboard-participants')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'participants' }, (payload) => {
      participants.push(payload.new);
      render();
    })
    .subscribe();
}

// --- Rendering ---------------------------------------------------------

function render() {
  document.getElementById('session-status').textContent = STATUS_LABEL[session?.status] ?? 'Lobby';
  document.getElementById('participant-count').textContent = `${participants.length} angemeldet`;

  renderQuestionProgressBar();
  renderHero();
  renderLeaderboard();
  renderProgression();
}

// Fortschritt ueber das GESAMTE Quiz (wie viele Fragen sind durch), nicht zu
// verwechseln mit renderQuestionProgress() weiter unten, die die Antwortquote
// der einen gerade laufenden Frage zeigt.
function renderQuestionProgressBar() {
  const { done, total } = computeQuestionProgress({ session, questions });
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('question-progress-fill').style.width = `${pct}%`;
  document.getElementById('question-progress-label').textContent = `${done} von ${total} Fragen`;
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
  const progression = computePointsProgression({ participants, responses, questions });
  const byPoints = [...progression].sort(
    (a, b) => (b.series.at(-1) ?? 0) - (a.series.at(-1) ?? 0)
  );
  const top = byPoints.slice(0, PROGRESSION_TOP_N);

  const hasData = questions.some((q) => responses.some((r) => r.question_id === q.id));
  document.getElementById('progression-empty').hidden = hasData;
  document.getElementById('progression-chart-wrap').hidden = !hasData;

  if (hasData) {
    renderProgressionChart(document.getElementById('progression-chart'), top, { instanceSetter: (c) => (progressionChart = c), instance: progressionChart });
  }

  document.getElementById('progression-drilldown').onclick = () => openProgressionDrilldown(byPoints);
}

function renderProgressionChart(canvasEl, series, { instance, instanceSetter, legend = true }) {
  const labels = questions.map((q) => `#${q.position}`);
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

// --- Countdown (nur Anzeige, ausgeloest wird das Schliessen vom Presenter) ---

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

// --- Drilldowns ----------------------------------------------------------

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
    const ordered = [...questions].sort((a, b) => a.position - b.position);
    const table = document.createElement('table');
    table.className = 'drilldown-table';
    table.innerHTML = '<thead><tr><th>#</th><th>Frage</th><th>Ergebnis</th><th>Punkte</th><th>Zeit</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const question of ordered) {
      const response = responses.find((r) => r.participant_id === participant.id && r.question_id === question.id);
      const tr = document.createElement('tr');
      const resultLabel = !response ? '–' : response.is_correct ? '✓ richtig' : '✗ falsch';
      const latency = response?.latency_ms != null ? `${(response.latency_ms / 1000).toFixed(1)}s` : '–';
      tr.innerHTML = `
        <td>${question.position}</td>
        <td></td>
        <td class="${response?.is_correct ? 'is-correct' : response ? 'is-wrong' : ''}">${resultLabel}</td>
        <td>${response?.points_awarded ?? '–'}</td>
        <td>${latency}</td>
      `;
      tr.children[1].textContent = question.prompt;
      tbody.appendChild(tr);
    }
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById('drilldown-close').addEventListener('click', closeModal);
document.getElementById('drilldown-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'drilldown-overlay') closeModal();
});

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
