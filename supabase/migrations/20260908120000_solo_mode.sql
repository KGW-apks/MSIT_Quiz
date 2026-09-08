-- Solo-Modus: Teilnehmer waehlen nach der Registrierung zwischen Team (bisheriges
-- Verhalten, unveraendert) und Solo. Solo laeuft komplett unabhaengig von der
-- Team-Singleton-Tabelle quiz_sessions (keine gemeinsame Frage, kein Presenter,
-- kein Passwort) -- bewusst zwei neue, eigene Tabellen statt quiz_sessions/
-- responses wiederzuverwenden: responses hat einen Unique-Constraint auf
-- (participant_id, question_id), der bei mehreren Solo-Laeufen oder einer Frage,
-- die sowohl solo als auch in einer Team-Runde beantwortet wird, sofort
-- kollidieren wuerde. Getrennte Tabellen halten Team-Code/-Daten unangetastet.
--
-- Sicherheitsmodell: anders als bei quiz_sessions (gemeinsamer Zustand, siehe
-- presenter_control_rpc) betrifft ein Solo-Lauf ausschliesslich die eigenen
-- Daten der spielenden Person -- kein Cheat-Vektor gegenueber anderen. Deshalb
-- reicht das einfache "eigene Zeile lesen/schreiben"-Muster wie bei
-- participants/responses, keine SECURITY-DEFINER-RPC mit Passwort noetig.
--
-- Schaetzfragen-Scoring: Teams "wer am naechsten liegt gewinnt" braucht mehrere
-- Spieler zum Vergleichen, im Solo gibt es die nicht. Stattdessen ein festes
-- Toleranzband: voller Punkt bei <= 10% relativer Abweichung vom korrekten Wert,
-- sonst 0 -- dieselbe binaere richtig/falsch-Logik wie bei Multiple-Choice.

create table public.solo_sessions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants (id) on delete cascade,
  -- cardinality() statt array_length(): array_length(array[]::uuid[], 1) liefert
  -- NULL (nicht 0), und "NULL > 0" gilt fuer einen Check-Constraint als erfuellt --
  -- ein leeres Array wuerde damit unbemerkt durchrutschen.
  question_ids uuid[] not null check (cardinality(question_ids) > 0),
  current_index integer not null default 0,
  status text not null default 'running' check (status in ('running', 'finished')),
  question_opened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index solo_sessions_participant_id_idx on public.solo_sessions (participant_id);

create table public.solo_responses (
  id uuid primary key default gen_random_uuid(),
  solo_session_id uuid not null references public.solo_sessions (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  selected_option text,
  guess_value numeric,
  is_correct boolean,
  points_awarded integer,
  latency_ms integer,
  answered_at timestamptz not null default now(),
  unique (solo_session_id, question_id)
);

create index solo_responses_solo_session_id_idx on public.solo_responses (solo_session_id);
create index solo_responses_participant_id_idx on public.solo_responses (participant_id);

-- Stempelt question_opened_at neu, sobald current_index weiterschaltet -- Basis
-- fuer latency_ms unten, gleiches Muster wie stamp_question_opened_at fuers Team.
create function public.stamp_solo_question_opened_at()
returns trigger
language plpgsql
as $$
begin
  if new.current_index is distinct from old.current_index then
    new.question_opened_at := now();
  end if;
  return new;
end;
$$;

create trigger solo_sessions_stamp_question_opened_at
  before update on public.solo_sessions
  for each row
  execute function public.stamp_solo_question_opened_at();

-- Serverseitiges Solo-Scoring, SECURITY DEFINER wie score_response() (question_answers
-- ist fuer keinen Client direkt lesbar). Anders als beim Team steht das Ergebnis
-- sofort beim Absenden fest, kein Vergleich mit anderen Antworten noetig, deshalb
-- kein zweistufiges Insert-dann-rescore wie bei rescore_estimation_responses.
create function public.score_solo_response()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  answer public.question_answers%rowtype;
  q public.questions%rowtype;
  opened_at timestamptz;
  rel_error numeric;
begin
  select * into answer from public.question_answers where question_id = new.question_id;
  if not found then
    raise exception 'Keine Loesung fuer Frage % hinterlegt', new.question_id;
  end if;

  select * into q from public.questions where id = new.question_id;

  select question_opened_at into opened_at
  from public.solo_sessions
  where id = new.solo_session_id;

  new.answered_at := now();
  new.latency_ms := case
    when opened_at is not null
    then greatest(0, extract(epoch from (new.answered_at - opened_at)) * 1000)::integer
    else null
  end;

  if q.question_type = 'multiple_choice' then
    new.is_correct := (new.selected_option = answer.correct_option);
    new.points_awarded := case when new.is_correct then answer.points else 0 end;

  elsif q.question_type = 'estimation' then
    if answer.correct_value = 0 then
      -- Randfall wie beim Team-Trigger: ohne Division nur eine exakte 0-Schaetzung richtig.
      new.is_correct := (new.guess_value = 0);
    else
      rel_error := abs(new.guess_value - answer.correct_value) / abs(answer.correct_value);
      new.is_correct := (rel_error <= 0.10);
    end if;
    new.points_awarded := case when new.is_correct then answer.points else 0 end;
  end if;

  return new;
end;
$$;

create trigger solo_responses_score_before_insert
  before insert on public.solo_responses
  for each row
  execute function public.score_solo_response();

-- RLS

alter table public.solo_sessions enable row level security;
alter table public.solo_responses enable row level security;

create policy solo_sessions_insert_own on public.solo_sessions
  for insert to authenticated
  with check (participant_id = auth.uid());

create policy solo_sessions_select_own on public.solo_sessions
  for select to authenticated
  using (participant_id = auth.uid());

-- Fortschritt (current_index/question_opened_at) und Abschluss (status/finished_at)
-- laufen als normales UPDATE der eigenen Zeile, kein RPC noetig (siehe Kommentar
-- oben: reine Eigendaten, kein Cheat-Vektor gegenueber anderen Teilnehmenden).
create policy solo_sessions_update_own on public.solo_sessions
  for update to authenticated
  using (participant_id = auth.uid())
  with check (participant_id = auth.uid());

create policy solo_responses_insert_own on public.solo_responses
  for insert to authenticated
  with check (participant_id = auth.uid());

create policy solo_responses_select_own on public.solo_responses
  for select to authenticated
  using (participant_id = auth.uid());

-- Reveal nach eigener Antwort: sobald jemand eine Frage im Solo-Modus (irgend-
-- einem eigenen Lauf) beantwortet hat, darf die Loesung dieser einen Frage
-- gelesen werden -- fuers sofortige Feedback nach dem Absenden und fuer die
-- Abschluss-Auswertung. Kein Vorab-Peeking moeglich: die Policy greift erst,
-- wenn bereits eine eigene solo_responses-Zeile zu genau dieser question_id
-- existiert (die wiederum nur nach dem Scoring-Trigger, also nach dem Absenden,
-- entsteht). Gleiches Reveal-nach-Antwort-Prinzip wie question_answers_select_after_finish
-- beim Team, nur an die eigene Antwort statt an den Session-Status gebunden.
create policy question_answers_select_after_own_solo_response on public.question_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.solo_responses sr
      where sr.question_id = question_answers.question_id
        and sr.participant_id = auth.uid()
    )
  );
