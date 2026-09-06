// DOM-Verdrahtung um die getestete Zustandslogik in shared/quiz-state.js.
// Diese Datei selbst ist reine UI-Verdrahtung ohne eigene Entscheidungslogik
// und bewusst nicht durch eine automatisierte Test-Suite abgedeckt.

import { supabaseClient } from '../shared/supabase-client.js';
import { deriveViewState, parseGuessValue } from '../shared/quiz-state.js';
import { computeAutoCloseAt } from '../shared/quiz-timer.js';
import { installGlobalErrorHandlers, logError } from '../shared/error-log.js';

// error_logs verlangt eine authentifizierte Session (RLS): ein Fehler VOR erfolgreichem
// signInAnonymously (z.B. Netzwerkausfall genau in dem Moment) landet deshalb nur in der
// Browser-Konsole des Geraets, nicht im Dashboard-Log. Alles danach (inkl. Ablehnung durch
// die 150er-Teilnehmerobergrenze) ist erfasst.
installGlobalErrorHandlers('participant');

const VIEWS = ['loading', 'register', 'lobby', 'question', 'waiting', 'missed', 'finished', 'error'];

let me = null; // { id, display_name }
let ringQuestionId = null; // welche Frage der Timer-Ring zuletzt gestartet hat, verhindert Neustart bei jedem Resubmit
let ringToken = 0; // pro startTimerRing()-Aufruf hochgezaehlt, macht laufende Retries/Observer aus einem vorherigen Aufruf wirkungslos
let ringSizeObserver = null; // ResizeObserver-Netz aus startTimerRing, muss vor jedem neuen Aufruf sauber abgehaengt werden

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
      logError('participant', error.message, { action: 'load_participant' });
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

  const state = deriveViewState({ status: quizSession.status, currentQuestion, myResponse });

  if (state.view === 'question') {
    renderQuestion(state.question, state.myResponse);
    // showView() MUSS vor startTimerRing() laufen: der Ring liest die reale
    // Groesse von #timer-ring per getBoundingClientRect(), die ist 0x0, solange
    // die Section noch [hidden] ist (Bug 2026-09-04, per Browser-Test gefunden).
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

// getBoundingClientRect() direkt nach showView() lieferte auf einem echten
// Handy vereinzelt 0x0 (Layout/Web-Fonts noch nicht fertig, im lokalen
// Desktop-Browser-Test nicht reproduzierbar), wodurch der Ring fuer die ganze
// Frage unsichtbar blieb (Bug vom 2026-09-06, kein Retry vorhanden). Fix in
// drei Stufen, jede haert die vorherige nur ab, kein Dauer-Polling:
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

showView('loading');
init().catch((err) => showError(err.message ?? String(err)));
