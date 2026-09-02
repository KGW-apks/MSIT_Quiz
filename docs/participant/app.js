// DOM-Verdrahtung um die getestete Zustandslogik in shared/quiz-state.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { deriveViewState, parseGuessValue } from '../shared/quiz-state.js';

const VIEWS = ['loading', 'register', 'lobby', 'question', 'waiting', 'missed', 'finished', 'error'];

let me = null; // { id, display_name }

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
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    const { data: participant, error } = await supabaseClient
      .from('participants')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle();

    if (error) {
      showError(error.message);
      return;
    }

    if (participant) {
      me = participant;
      await startQuizFlow();
      return;
    }
  }

  showView('register');
  document.getElementById('register-form').addEventListener('submit', onRegister);
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
    await startQuizFlow();
  } catch (err) {
    submitButton.disabled = false;
    showToast(err.message ?? String(err));
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

  const state = deriveViewState({ status: quizSession.status, currentQuestion, myResponse });

  if (state.view === 'question') {
    renderQuestion(state.question);
  }

  showView(state.view);
}

function renderQuestion(question) {
  document.getElementById('question-prompt-small').textContent = question.prompt;
  const container = document.getElementById('question-options');
  container.innerHTML = '';

  if (question.question_type === 'multiple_choice') {
    const buttons = [];
    for (const option of question.options) {
      const button = document.createElement('button');
      button.className = 'option-button';
      button.textContent = option;
      button.addEventListener('click', async () => {
        buttons.forEach((b) => (b.disabled = true));
        const ok = await submitResponse(question.id, { selected_option: option });
        if (!ok) buttons.forEach((b) => (b.disabled = false));
      });
      buttons.push(button);
      container.appendChild(button);
    }
    return;
  }

  const form = document.createElement('form');
  form.innerHTML = `
    <input id="guess-input" type="text" inputmode="decimal" placeholder="Deine Schaetzung" required>
    <button type="submit">Absenden</button>
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
    if (!ok) submitButton.disabled = false;
  });
  container.appendChild(form);
}

async function submitResponse(questionId, payload) {
  const { error } = await supabaseClient.from('responses').insert({
    participant_id: me.id,
    question_id: questionId,
    ...payload,
  });

  if (error) {
    showToast(`Antwort nicht angekommen: ${error.message}`);
    return false;
  }

  showView('waiting');
  return true;
}

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
