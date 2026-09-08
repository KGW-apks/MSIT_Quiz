// DOM-Verdrahtung um die getestete Zustandslogik in shared/quiz-state.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { deriveViewState, parseGuessValue } from '../shared/quiz-state.js';
import { computeAutoCloseAt } from '../shared/quiz-timer.js';
import { installGlobalErrorHandlers, logError } from '../shared/error-log.js';
import { pickRandomQuestions, describeAnswer, computeSoloResult } from '../shared/solo-state.js';

// error_logs verlangt eine authentifizierte Session (RLS): ein Fehler VOR erfolgreichem
// signInAnonymously (z.B. Netzwerkausfall genau in dem Moment) landet deshalb nur in der
// Browser-Konsole des Geraets, nicht im Dashboard-Log. Alles danach (inkl. Ablehnung durch
// die 150er-Teilnehmerobergrenze) ist erfasst.
installGlobalErrorHandlers('participant');

const VIEWS = [
  'loading', 'register', 'mode-select', 'solo-setup', 'solo-question', 'solo-result',
  'lobby', 'question', 'waiting', 'missed', 'finished', 'error',
];

let me = null; // { id, display_name }
let ringQuestionId = null; // welche Frage der Timer-Ring zuletzt gestartet hat, verhindert Neustart bei jedem Resubmit
let ringToken = 0; // pro startTimerRing()-Aufruf hochgezaehlt, macht laufende Retries/Observer aus einem vorherigen Aufruf wirkungslos
let ringSizeObserver = null; // ResizeObserver-Netz aus startTimerRing, muss vor jedem neuen Aufruf sauber abgehaengt werden

let allQuestionsCache = null; // kompletter Fragenkatalog, einmal geladen (Solo braucht ihn fuer Auswahl+Anzeige), aendert sich nicht waehrend einer Session
let soloSession = null; // aktuelle solo_sessions-Zeile { id, question_ids, current_index, status, ... }
let soloResultChart = null;

function showView(name) {
  for (const view of VIEWS) {
    document.getElementById(`view-${view}`).hidden = view !== name;
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showView('error');
}

async function init() {
  wireModeAndSoloListeners();
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    const { data: participant, error } = await supabaseClient
      .from('participants')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle();

    if (error) {
      logError('participant', error.message, { action: 'load_participant' });
      showError(error.message);
      return;
    }

    if (participant) {
      me = participant;
      await afterAuthenticated();
      return;
    }
  }

  showView('register');
  document.getElementById('register-form').addEventListener('submit', onRegister);
}

// Nach Login/Registrierung: laeuft bereits eine unbeendete Solo-Runde (z.B. Reload
// mitten im Lauf), dort fortsetzen statt sie stillschweigend zu verlieren. Sonst
// zur Modus-Auswahl.
async function afterAuthenticated() {
  const resumed = await tryResumeSoloSession();
  if (resumed) return;
  showModeSelect();
}

async function tryResumeSoloSession() {
  const { data, error } = await supabaseClient
    .from('solo_sessions')
    .select('*')
    .eq('participant_id', me.id)
    .eq('status', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logError('participant', error.message, { action: 'load_solo_session' });
    return false;
  }
  if (!data) return false;

  try {
    await loadAllQuestions();
  } catch (err) {
    logError('participant', err.message ?? String(err), { action: 'load_questions_for_solo_resume' });
    return false;
  }

  soloSession = data;
  renderSoloQuestion();
  return true;
}

function showModeSelect() {
  document.getElementById('mode-select-name').textContent = `Angemeldet als ${me.display_name}`;
  showView('mode-select');
}

async function onRegister(event) {
  event.preventDefault();
  const nameInput = document.getElementById('name-input');
  const name = nameInput.value.trim();
  if (!name) return;

  const submitButton = event.target.querySelector('button');
  submitButton.disabled = true;

  try {
    const { data: signInData, error: signInError } = await supabaseClient.auth.signInAnonymously();
    if (signInError) throw signInError;

    const userId = signInData.user.id;
    const { error: insertError } = await supabaseClient
      .from('participants')
      .insert({ id: userId, display_name: name });
    if (insertError) throw insertError;

    me = { id: userId, display_name: name };
    await afterAuthenticated();
  } catch (err) {
    submitButton.disabled = false;
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'register' });
    showToast(message);
  }
}

async function startQuizFlow() {
  document.getElementById('lobby-name').textContent = `Angemeldet als ${me.display_name}`;

  // Erst den aktuellen Stand normal abfragen, danach erst subscriben,
  // sonst verpasst ein spaeter beitretender Client eine schon offene Frage.
  const { data: quizSession, error } = await supabaseClient
    .from('quiz_sessions')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) {
    showError(error.message);
    return;
  }

  await renderForSession(quizSession);

  supabaseClient
    .channel('quiz-session-changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'quiz_sessions' },
      (payload) => renderForSession(payload.new)
    )
    .subscribe();
}

async function renderForSession(quizSession) {
  if (!quizSession) {
    showView('lobby');
    return;
  }

  let currentQuestion = null;
  let myResponse = null;

  if (quizSession.current_question_id) {
    const [{ data: question }, { data: response }] = await Promise.all([
      supabaseClient.from('questions').select('*').eq('id', quizSession.current_question_id).single(),
      supabaseClient
        .from('responses')
        .select('*')
        .eq('participant_id', me.id)
        .eq('question_id', quizSession.current_question_id)
        .maybeSingle(),
    ]);
    currentQuestion = question;
    myResponse = response;
  }

  const state = deriveViewState({
    status: quizSession.status,
    currentQuestion,
    myResponse,
    questionOpenedAt: quizSession.question_opened_at,
  });

  if (state.view === 'question') {
    renderQuestion(state.question, state.myResponse);
    // showView() MUSS vor startTimerRing() laufen: der Ring liest die reale
    // Groesse von #timer-ring per getBoundingClientRect(), die ist 0x0, solange
    // die Section noch [hidden] ist.
    showView(state.view);
    // Ring nur bei einer tatsaechlich NEUEN Frage (neu)starten, nicht bei jedem
    // Resubmit-Re-Render derselben Frage (siehe handleOptionClick/submitResponse
    // oben, die rufen renderForSession nicht erneut auf, genau deshalb).
    if (ringQuestionId !== state.question.id) {
      ringQuestionId = state.question.id;
      const deadline = computeAutoCloseAt({ session: quizSession, questions: [state.question] });
      startTimerRing(deadline);
    }
    return;
  }

  ringQuestionId = null;
  showView(state.view);
}

function renderQuestion(question, myResponse) {
  document.getElementById('question-prompt-small').textContent = question.prompt;
  document.getElementById('answer-saved-hint').hidden = true;
  const container = document.getElementById('question-options');
  container.innerHTML = '';

  if (question.question_type === 'multiple_choice') {
    const buttons = [];
    for (const option of question.options) {
      const button = document.createElement('button');
      button.className = 'option-button';
      button.classList.toggle('option-button--selected', myResponse?.selected_option === option);
      button.textContent = option;
      button.addEventListener('click', () => handleOptionClick(question.id, option, buttons, button));
      buttons.push(button);
      container.appendChild(button);
    }
    return;
  }

  const form = document.createElement('form');
  const currentGuess = myResponse?.guess_value ?? '';
  form.innerHTML = `
    <input id="guess-input" type="text" inputmode="decimal" placeholder="Deine Schaetzung" value="${currentGuess}" required>
    <button type="submit">${myResponse ? 'Aendern' : 'Absenden'}</button>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = document.getElementById('guess-input').value;
    const value = parseGuessValue(raw);
    if (value === null) {
      showToast('Bitte eine gueltige Zahl eingeben.');
      return;
    }
    const submitButton = form.querySelector('button');
    submitButton.disabled = true;
    const ok = await submitResponse(question.id, { guess_value: value });
    submitButton.disabled = false;
    if (ok) {
      submitButton.textContent = 'Aendern';
      showSavedHint();
    }
  });
  container.appendChild(form);
}

// Buttons bleiben klickbar (anders als vorher): solange die Frage offen ist,
// darf man sich umentscheiden. Ein Klick auf die bereits gewaehlte Option
// sendet sie harmlos erneut (upsert ist idempotent).
async function handleOptionClick(questionId, option, allButtons, clickedButton) {
  allButtons.forEach((b) => (b.disabled = true));
  const ok = await submitResponse(questionId, { selected_option: option });
  allButtons.forEach((b) => (b.disabled = false));
  if (ok) {
    allButtons.forEach((b) => b.classList.toggle('option-button--selected', b === clickedButton));
    showSavedHint();
  }
}

function showSavedHint() {
  const hint = document.getElementById('answer-saved-hint');
  hint.hidden = false;
}

// SVG-Rahmen um #question-options, der sich ueber die verbleibende Zeit
// schliesst (stroke-dashoffset von "leer" auf "voll gezeichnet"). Nutzt die
// Web Animations API statt CSS-@keyframes, weil Dasharray/-offset von der
// tatsaechlichen Containergroesse abhaengen, die erst zur Laufzeit feststeht.
function startTimerRing(deadline) {
  const wrap = document.getElementById('timer-ring');
  const svg = wrap.querySelector('.timer-ring-svg');
  const rect = wrap.querySelector('.timer-ring-rect');

  rect.getAnimations().forEach((a) => a.cancel());
  if (ringSizeObserver) {
    ringSizeObserver.disconnect();
    ringSizeObserver = null;
  }
  const token = ++ringToken; // macht ein Retry/Observer aus einem ueberholten Aufruf (Frage schon gewechselt) wirkungslos

  if (deadline === null) {
    wrap.classList.add('timer-ring--inactive');
    return;
  }
  wrap.classList.remove('timer-ring--inactive');

  measureAndDrawRing(wrap, svg, rect, deadline, token);
}

// getBoundingClientRect() direkt nach showView() liefert auf manchen Geraeten
// vereinzelt 0x0 (Layout/Web-Fonts noch nicht fertig), wodurch der Ring fuer
// die ganze Frage unsichtbar bliebe. Fix in drei Stufen, jede haert die
// vorherige nur ab, kein Dauer-Polling:
// 1) sofort messen, 2) nach zwei rAF nochmal (Layout ist dann garantiert
// fertig gemalt), 3) ResizeObserver als letztes Netz fuer den seltenen Fall,
// dass selbst das noch zu frueh ist (z.B. verzoegertes Font-Nachladen).
function measureAndDrawRing(wrap, svg, rect, deadline, token) {
  const { width, height } = wrap.getBoundingClientRect();
  if (width > 0 && height > 0) {
    drawRing(wrap, svg, rect, deadline, width, height);
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== ringToken) return; // zwischenzeitlich neue Frage/neuer Ring gestartet
      const size = wrap.getBoundingClientRect();
      if (size.width > 0 && size.height > 0) {
        drawRing(wrap, svg, rect, deadline, size.width, size.height);
        return;
      }
      const observer = new ResizeObserver((entries) => {
        if (token !== ringToken) {
          observer.disconnect();
          return;
        }
        const { width: w, height: h } = entries[0].contentRect;
        if (w > 0 && h > 0) {
          observer.disconnect();
          if (ringSizeObserver === observer) ringSizeObserver = null;
          drawRing(wrap, svg, rect, deadline, w, h);
        }
      });
      ringSizeObserver = observer;
      observer.observe(wrap);
    });
  });
}

function drawRing(wrap, svg, rect, deadline, width, height) {
  const inset = 2;
  const w = Math.max(1, width - inset * 2);
  const h = Math.max(1, height - inset * 2);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  rect.setAttribute('x', String(inset));
  rect.setAttribute('y', String(inset));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  rect.setAttribute('rx', '14');

  const perimeter = 2 * (w + h);
  rect.style.strokeDasharray = String(perimeter);

  const remainingMs = Math.max(0, deadline - Date.now());
  rect.animate(
    [{ strokeDashoffset: perimeter }, { strokeDashoffset: 0 }],
    { duration: remainingMs, easing: 'linear', fill: 'forwards' }
  );
}

async function submitResponse(questionId, payload) {
  const { error } = await supabaseClient
    .from('responses')
    .upsert(
      { participant_id: me.id, question_id: questionId, ...payload },
      { onConflict: 'participant_id,question_id' }
    );

  if (error) {
    logError('participant', error.message, { action: 'submit_response', question_id: questionId });
    showToast(`Antwort nicht angekommen: ${error.message}`);
    return false;
  }

  return true;
}

// --- Solo-Modus ---
// Eigenstaendiger Ablauf ohne quiz_sessions/presenter_control: eigenes Tempo
// (Antworten, sofort Ergebnis sehen, per "Weiter" selbst zur naechsten Frage),
// kein Timer, kein Warten auf andere. Siehe solo-state.js fuer die getestete
// Logik (Fragenauswahl, Auswertungs-Aggregation) und die Migration
// 20260908120000_solo_mode.sql fuers Datenmodell/RLS/Scoring.

function wireModeAndSoloListeners() {
  document.getElementById('mode-select-team').addEventListener('click', () => startQuizFlow());
  document.getElementById('mode-select-solo').addEventListener('click', () => startSoloSetup());
  document.getElementById('solo-setup-form').addEventListener('submit', onStartSolo);
  document.getElementById('solo-again-button').addEventListener('click', () => {
    soloSession = null;
    startSoloSetup();
  });
  document.getElementById('solo-back-button').addEventListener('click', () => {
    soloSession = null;
    showModeSelect();
  });
}

async function loadAllQuestions() {
  if (allQuestionsCache) return allQuestionsCache;
  const { data, error } = await supabaseClient.from('questions').select('*');
  if (error) throw error;
  allQuestionsCache = data;
  return allQuestionsCache;
}

async function startSoloSetup() {
  try {
    const questions = await loadAllQuestions();
    const input = document.getElementById('solo-question-count');
    input.max = String(questions.length);
    input.value = String(Math.min(10, questions.length));
    document.getElementById('solo-setup-hint').textContent = `${questions.length} Fragen im Katalog verfuegbar.`;
    showView('solo-setup');
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'load_questions_for_solo_setup' });
    showToast(message);
  }
}

async function onStartSolo(event) {
  event.preventDefault();
  const input = document.getElementById('solo-question-count');
  const count = Number(input.value);
  const submitButton = event.target.querySelector('button');
  submitButton.disabled = true;

  try {
    const questions = await loadAllQuestions();
    const picked = pickRandomQuestions(questions, count);
    const { data, error } = await supabaseClient
      .from('solo_sessions')
      .insert({ participant_id: me.id, question_ids: picked.map((q) => q.id) })
      .select()
      .single();
    if (error) throw error;

    soloSession = data;
    renderSoloQuestion();
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'start_solo_session' });
    showToast(message);
  } finally {
    submitButton.disabled = false;
  }
}

function currentSoloQuestion() {
  const id = soloSession.question_ids[soloSession.current_index];
  return allQuestionsCache.find((q) => q.id === id);
}

function renderSoloQuestion() {
  const question = currentSoloQuestion();
  const total = soloSession.question_ids.length;

  document.getElementById('solo-progress').textContent = `Frage ${soloSession.current_index + 1} von ${total}`;
  document.getElementById('solo-question-prompt').textContent = question.prompt;
  document.getElementById('solo-feedback').hidden = true;

  const container = document.getElementById('solo-question-options');
  container.innerHTML = '';

  if (question.question_type === 'multiple_choice') {
    for (const option of question.options) {
      const button = document.createElement('button');
      button.className = 'option-button';
      button.textContent = option;
      button.addEventListener('click', () => submitSoloAnswer(question, { selected_option: option }));
      container.appendChild(button);
    }
  } else {
    const form = document.createElement('form');
    form.innerHTML = `
      <input id="solo-guess-input" type="text" inputmode="decimal" placeholder="Deine Schaetzung" required>
      <button type="submit">Absenden</button>
    `;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = document.getElementById('solo-guess-input').value;
      const value = parseGuessValue(raw);
      if (value === null) {
        showToast('Bitte eine gueltige Zahl eingeben.');
        return;
      }
      submitSoloAnswer(question, { guess_value: value });
    });
    container.appendChild(form);
  }

  showView('solo-question');
}

async function submitSoloAnswer(question, payload) {
  const container = document.getElementById('solo-question-options');
  container.querySelectorAll('button, input').forEach((el) => (el.disabled = true));

  try {
    const { data: response, error } = await supabaseClient
      .from('solo_responses')
      .insert({
        solo_session_id: soloSession.id,
        participant_id: me.id,
        question_id: question.id,
        ...payload,
      })
      .select()
      .single();
    if (error) throw error;

    // Erst nach dem eigenen Insert lesbar (Reveal-nach-eigener-Antwort-Policy,
    // siehe Migration), deshalb erst jetzt und nicht schon beim Fragen-Rendern abfragen.
    const { data: answer, error: answerError } = await supabaseClient
      .from('question_answers')
      .select('correct_option, correct_value')
      .eq('question_id', question.id)
      .single();
    if (answerError) throw answerError;

    showSoloFeedback(question, response, answer);
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'submit_solo_response', question_id: question.id });
    showToast(message);
    container.querySelectorAll('button, input').forEach((el) => (el.disabled = false));
  }
}

function showSoloFeedback(question, response, answer) {
  const { yourAnswer, correctAnswer } = describeAnswer(question, response, answer);

  const status = document.getElementById('solo-feedback-status');
  status.textContent = response.is_correct ? 'Richtig!' : 'Leider falsch';
  status.classList.toggle('status-badge--error', !response.is_correct);

  document.getElementById('solo-feedback-detail').textContent =
    question.question_type === 'multiple_choice'
      ? `Richtige Antwort: ${correctAnswer}`
      : `Deine Schaetzung: ${yourAnswer} · Richtiger Wert: ${correctAnswer}`;

  const isLast = soloSession.current_index >= soloSession.question_ids.length - 1;
  const nextButton = document.getElementById('solo-next-button');
  nextButton.textContent = isLast ? 'Auswertung ansehen' : 'Weiter';
  nextButton.onclick = isLast ? finishSoloSession : advanceSoloSession;

  document.getElementById('solo-feedback').hidden = false;
}

async function advanceSoloSession() {
  try {
    const { data, error } = await supabaseClient
      .from('solo_sessions')
      .update({ current_index: soloSession.current_index + 1 })
      .eq('id', soloSession.id)
      .select()
      .single();
    if (error) throw error;

    soloSession = data;
    renderSoloQuestion();
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'advance_solo_session' });
    showToast(message);
  }
}

async function finishSoloSession() {
  try {
    const { data, error } = await supabaseClient
      .from('solo_sessions')
      .update({ status: 'finished', finished_at: new Date().toISOString() })
      .eq('id', soloSession.id)
      .select()
      .single();
    if (error) throw error;

    soloSession = data;
    await renderSoloResult();
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'finish_solo_session' });
    showToast(message);
  }
}

async function renderSoloResult() {
  try {
    const questionIds = soloSession.question_ids;
    const [{ data: responses, error: responsesError }, { data: answers, error: answersError }] = await Promise.all([
      supabaseClient.from('solo_responses').select('*').eq('solo_session_id', soloSession.id),
      supabaseClient.from('question_answers').select('*').in('question_id', questionIds),
    ]);
    if (responsesError) throw responsesError;
    if (answersError) throw answersError;

    const questions = questionIds.map((id) => allQuestionsCache.find((q) => q.id === id));
    const result = computeSoloResult({ questionIds, questions, responses, answers });

    document.getElementById('solo-result-summary').textContent = `${result.totalPoints} von ${result.totalCount} Punkten`;
    document.getElementById('solo-result-detail').textContent =
      `${result.accuracyPct}% richtig beantwortet` +
      (result.avgLatencyMs != null ? ` · im Schnitt ${(result.avgLatencyMs / 1000).toFixed(1)}s pro Frage` : '');

    showView('solo-result');
    renderSoloResultList(result.rows);
    scheduleSoloChartRender(result.rows);
  } catch (err) {
    const message = err.message ?? String(err);
    logError('participant', message, { action: 'load_solo_result' });
    showToast(message);
  }
}

// Chart.js (responsive:true) misst beim Erzeugen die reale Groesse des
// Elternknotens (.solo-chart-wrap); direkt nach showView() hat der Browser das
// Layout nach dem Entfernen von [hidden] manchmal noch nicht fertig berechnet,
// der Chart bekaeme dann Breite 0 und bliebe unsichtbar (per Browser-Test
// gefunden). Gleiches Drei-Stufen-Netz wie measureAndDrawRing/startTimerRing
// weiter oben: sofort messen, zwei rAF abwarten, ResizeObserver als letztes
// Netz fuer den seltenen Fall, dass selbst das noch zu frueh ist.
function scheduleSoloChartRender(rows) {
  const wrap = document.querySelector('.solo-chart-wrap');
  const immediate = wrap.getBoundingClientRect();
  if (immediate.width > 0 && immediate.height > 0) {
    renderSoloChart(rows);
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const size = wrap.getBoundingClientRect();
      if (size.width > 0 && size.height > 0) {
        renderSoloChart(rows);
        return;
      }
      const observer = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) {
          observer.disconnect();
          renderSoloChart(rows);
        }
      });
      observer.observe(wrap);
    });
  });
}

// Balkendiagramm statt Kreisdiagramm (Projektkonvention, siehe Dashboard),
// fester Hoehen-Wrapper (.solo-chart-wrap) gegen den bekannten Chart.js-
// Resize-Feedback-Loop bei responsive:true + maintainAspectRatio:false.
function renderSoloChart(rows) {
  const ctx = document.getElementById('solo-result-chart').getContext('2d');
  const labels = rows.map((_, i) => `F${i + 1}`);
  const data = rows.map((r) => r.pointsAwarded);
  const colors = rows.map((r) => (r.isCorrect ? '#22c55e' : '#ef4444'));

  if (soloResultChart) {
    soloResultChart.data.labels = labels;
    soloResultChart.data.datasets[0].data = data;
    soloResultChart.data.datasets[0].backgroundColor = colors;
    soloResultChart.update();
    return;
  }

  soloResultChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 8, maxBarThickness: 40 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8', precision: 0 }, beginAtZero: true, grid: { color: 'rgba(148,163,184,0.08)' } },
      },
    },
  });
}

function renderSoloResultList(rows) {
  const container = document.getElementById('solo-result-list');
  container.innerHTML = '';
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = `solo-result-row ${row.isCorrect ? 'solo-result-row--correct' : 'solo-result-row--incorrect'}`;

    const prompt = document.createElement('p');
    prompt.className = 'solo-result-row-prompt';
    prompt.textContent = `${index + 1}. ${row.question?.prompt ?? '?'}`;

    const answers = document.createElement('p');
    answers.className = 'solo-result-row-answers';
    answers.textContent = `Deine Antwort: ${row.yourAnswer ?? '–'} · Richtig: ${row.correctAnswer ?? '–'}`;

    item.append(prompt, answers);
    container.appendChild(item);
  });
}

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
