// DOM-Verdrahtung um die getestete Zustandslogik in shared/presenter-state.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { buildPresenterView } from '../shared/presenter-state.js';
import { computeAutoCloseAt, shouldAutoClose } from '../shared/quiz-timer.js';

const VIEWS = ['loading', 'empty', 'presenter', 'error'];

const BADGE_LABEL = { pending: '–', open: 'Live', closed: 'Geschlossen' };
const TYPE_LABEL = { multiple_choice: 'Multiple-Choice', estimation: 'Schätzung' };
const STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Frage geschlossen', finished: 'Quiz beendet' };

let session = null;
let questions = [];
let responses = [];
let currentParticipantCount = 0;

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
  // Presenter braucht wie der Teilnehmer eine authentifizierte Session fuer die
  // RLS-Policies (alle Tabellen sind "to authenticated"), aber ohne sichtbares
  // Login und ohne eigene Zeile in participants (kein Leaderboard-Eintrag).
  const { data: { session: authSession } } = await supabaseClient.auth.getSession();
  if (!authSession) {
    const { error } = await supabaseClient.auth.signInAnonymously();
    if (error) {
      showError(error.message);
      return;
    }
  }

  const [{ data: questionData, error: questionsError }, { data: sessionRow, error: sessionError }] = await Promise.all([
    supabaseClient.from('questions').select('*').order('position', { ascending: true }),
    supabaseClient.from('quiz_sessions').select('*').limit(1).maybeSingle(),
  ]);

  if (questionsError) {
    showError(questionsError.message);
    return;
  }
  if (sessionError) {
    showError(sessionError.message);
    return;
  }

  questions = questionData ?? [];
  if (questions.length === 0) {
    showView('empty');
    return;
  }

  session = sessionRow;

  const [{ data: responseData, error: responsesError }, { count: participantCount, error: participantsError }] = await Promise.all([
    supabaseClient.from('responses').select('*'),
    supabaseClient.from('participants').select('*', { count: 'exact', head: true }),
  ]);

  if (responsesError) {
    showError(responsesError.message);
    return;
  }
  if (participantsError) {
    showError(participantsError.message);
    return;
  }

  responses = responseData ?? [];

  render(participantCount ?? 0);
  wireControls();
  subscribeRealtime();
  setInterval(autoCloseTick, 1000);
}

// Laeuft jede Sekunde: schliesst die offene Frage automatisch, wenn ihr Zeitlimit
// abgelaufen ist oder alle Teilnehmer schon geantwortet haben (siehe shared/quiz-timer.js).
// Selbstbegrenzend: sobald status != 'open' ist, greift die Regel nicht mehr,
// kein extra Flag noetig gegen doppeltes Schliessen.
let autoCloseInFlight = false;

function autoCloseTick() {
  if (autoCloseInFlight) return;
  const dueForAutoClose = shouldAutoClose({
    session,
    questions,
    responseCount: responses.filter((r) => r.question_id === session?.current_question_id).length,
    participantCount: currentParticipantCount,
    now: Date.now(),
  });
  if (!dueForAutoClose) {
    renderCountdownOnly();
    return;
  }
  autoCloseInFlight = true;
  closeQuestion().finally(() => {
    autoCloseInFlight = false;
  });
}

// Zaehlt die Sekundenanzeige der offenen Zeile jede Sekunde runter, ohne die
// ganze Tabelle neu aufzubauen (render() wuerde bei jedem Tick alle Buttons/Listener
// neu erzeugen, unnoetig fuer eine reine Zahlenanzeige).
function renderCountdownOnly() {
  const deadline = computeAutoCloseAt({ session, questions });
  const el = document.querySelector('[data-countdown]');
  if (!el) return;
  if (deadline === null) {
    el.textContent = '';
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${secondsLeft}s`;
}

function subscribeRealtime() {
  supabaseClient
    .channel('presenter-quiz-sessions')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'quiz_sessions' },
      (payload) => {
        session = payload.new;
        render();
      }
    )
    .subscribe();

  supabaseClient
    .channel('presenter-responses')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'responses' },
      (payload) => {
        responses.push(payload.new);
        render();
      }
    )
    .subscribe();

  supabaseClient
    .channel('presenter-participants')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'participants' },
      () => render(currentParticipantCount + 1)
    )
    .subscribe();
}

function render(participantCountOverride) {
  const participantCount = participantCountOverride ?? currentParticipantCount;
  currentParticipantCount = participantCount;

  const view = buildPresenterView({ session, questions, responses, participantCount });

  document.getElementById('session-status').textContent = STATUS_LABEL[view.status] ?? view.status;
  document.getElementById('participant-count').textContent = `${view.participantCount} angemeldet`;

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

  const finishButton = document.getElementById('finish-button');
  finishButton.disabled = !view.canFinish;

  showView('presenter');
  renderCountdownOnly();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function wireControls() {
  document.getElementById('finish-button').addEventListener('click', () => finishQuiz());
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

async function callPresenterControl(action, targetQuestionId) {
  const { error } = await supabaseClient.rpc('presenter_control', {
    action,
    target_question_id: targetQuestionId,
    presenter_secret: getPresenterSecret(),
  });
  if (error) {
    // Falsches Passwort gecacht -> beim naechsten Versuch neu abfragen statt
    // dauerhaft mit demselben falschen Wert zu scheitern.
    sessionStorage.removeItem('presenterSecret');
    showToast(error.message);
  }
}

async function openQuestion(questionId) {
  await callPresenterControl('open', questionId);
}

async function closeQuestion() {
  await callPresenterControl('close', null);
}

async function finishQuiz() {
  await callPresenterControl('finish', null);
}

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
