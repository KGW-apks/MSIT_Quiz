// DOM-Verdrahtung um die getestete Zustandslogik in shared/presenter-state.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { buildPresenterView } from '../shared/presenter-state.js';

const VIEWS = ['loading', 'empty', 'presenter', 'error'];

const BADGE_LABEL = { pending: '–', open: 'Live', closed: 'Geschlossen' };
const TYPE_LABEL = { multiple_choice: 'Multiple-Choice', estimation: 'Schätzung' };
const STATUS_LABEL = { lobby: 'Lobby', open: 'Frage läuft', closed: 'Frage geschlossen', finished: 'Quiz beendet' };

let session = null;
let questions = [];
let responses = [];
let sessionRowId = null;
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
  sessionRowId = sessionRow?.id ?? null;

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
      <td>${row.responseCount}</td>
      <td></td>
    `;
    tr.children[3].appendChild(badge);
    tr.children[5].appendChild(actionButton);
    tbody.appendChild(tr);
  }

  const finishButton = document.getElementById('finish-button');
  finishButton.disabled = !view.canFinish;

  showView('presenter');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function wireControls() {
  document.getElementById('finish-button').addEventListener('click', () => finishQuiz());
}

async function openQuestion(questionId) {
  const { error } = await supabaseClient
    .from('quiz_sessions')
    .update({ current_question_id: questionId, status: 'open' })
    .eq('id', sessionRowId);
  if (error) showToast(error.message);
}

async function closeQuestion() {
  const { error } = await supabaseClient
    .from('quiz_sessions')
    .update({ status: 'closed' })
    .eq('id', sessionRowId);
  if (error) showToast(error.message);
}

async function finishQuiz() {
  const { error } = await supabaseClient
    .from('quiz_sessions')
    .update({ status: 'finished' })
    .eq('id', sessionRowId);
  if (error) showToast(error.message);
}

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
