-- Live-Quiz-Tool: Kernschema, RLS und serverseitiges Scoring.

create table public.participants (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) > 0),
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  question_type text not null check (question_type in ('multiple_choice', 'estimation')),
  options jsonb,
  position integer not null unique,
  created_at timestamptz not null default now(),
  constraint options_only_for_multiple_choice check (
    (question_type = 'multiple_choice' and options is not null)
    or (question_type = 'estimation' and options is null)
  )
);

-- Singleton-Tabelle: genau eine Zeile pro Live-Event.
create table public.quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  current_question_id uuid references public.questions (id),
  status text not null default 'lobby' check (status in ('lobby', 'open', 'closed', 'finished')),
  question_opened_at timestamptz,
  created_at timestamptz not null default now()
);

-- Loesungen: RLS aktiv, bewusst keine einzige Policy.
-- Weder anon noch authenticated koennen diese Tabelle lesen oder schreiben,
-- nur der Scoring-Trigger (SECURITY DEFINER) und der service_role-Key.
create table public.question_answers (
  question_id uuid primary key references public.questions (id) on delete cascade,
  correct_option text,
  correct_value numeric,
  points integer not null default 100
);

create table public.responses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  selected_option text,
  guess_value numeric,
  is_correct boolean,
  points_awarded integer,
  latency_ms integer,
  answered_at timestamptz not null default now(),
  unique (participant_id, question_id)
);

create index responses_question_id_idx on public.responses (question_id);
create index responses_participant_id_idx on public.responses (participant_id);

-- Stempelt question_opened_at, sobald der Presenter auf eine neue Frage schaltet,
-- Grundlage fuer latency_ms im Scoring-Trigger unten.
create function public.stamp_question_opened_at()
returns trigger
language plpgsql
as $$
begin
  if new.current_question_id is distinct from old.current_question_id then
    new.question_opened_at := now();
  end if;
  return new;
end;
$$;

create trigger quiz_sessions_stamp_question_opened_at
  before update on public.quiz_sessions
  for each row
  execute function public.stamp_question_opened_at();

-- Serverseitiges Scoring fuer beide Fragetypen. SECURITY DEFINER, damit die Funktion
-- question_answers lesen kann, obwohl kein Client (auch nicht der einsendende) das darf.
-- Ueberschreibt is_correct/points_awarded/answered_at/latency_ms immer, unabhaengig davon,
-- was der Client im INSERT mitschickt (DevTools-Manipulation waere sonst trivial).
create function public.score_response()
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
  from public.quiz_sessions
  where current_question_id = new.question_id
  limit 1;

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
      -- Randfall aus der Projektnotiz (Division durch 0 bei relativer Abweichung):
      -- nur eine exakte Schaetzung von 0 zaehlt, gewaehlter Default, mit Knut noch abzustimmen.
      new.is_correct := (new.guess_value = 0);
      new.points_awarded := case when new.guess_value = 0 then answer.points else 0 end;
    else
      rel_error := abs(new.guess_value - answer.correct_value) / abs(answer.correct_value);
      new.points_awarded := round(answer.points * greatest(0, 1 - rel_error));
      new.is_correct := (new.points_awarded = answer.points);
    end if;
  end if;

  return new;
end;
$$;

create trigger responses_score_before_insert
  before insert on public.responses
  for each row
  execute function public.score_response();

-- RLS

alter table public.participants enable row level security;
alter table public.questions enable row level security;
alter table public.quiz_sessions enable row level security;
alter table public.question_answers enable row level security;
alter table public.responses enable row level security;

-- participants: jede:r legt nur die eigene Zeile an, alle duerfen alle Namen lesen
-- (Leaderboard/Dashboard brauchen die Namen anderer Teilnehmer).
create policy participants_insert_own on public.participants
  for insert to authenticated
  with check (id = auth.uid());

create policy participants_select_all on public.participants
  for select to authenticated
  using (true);

-- questions: nur lesen, keine Schreib-Policy. Fragen werden per Seed/SQL-Editor
-- mit service_role angelegt, nicht durch die App.
create policy questions_select_all on public.questions
  for select to authenticated
  using (true);

-- quiz_sessions: lesen und die laufende Frage umschalten duerfen alle authentifizierten
-- Clients. Presenter-Schutz laeuft ueber die nicht geteilte URL, nicht ueber RLS,
-- so wie in der Projektnotiz unter "Architekturentscheidungen" festgelegt.
create policy quiz_sessions_select_all on public.quiz_sessions
  for select to authenticated
  using (true);

create policy quiz_sessions_update_all on public.quiz_sessions
  for update to authenticated
  using (true)
  with check (true);

-- responses: eigene Antwort einsenden, alle Antworten lesen (Dashboard-Aggregation
-- laeuft rein clientseitig ueber die Realtime-Subscription, kein eigener Server).
create policy responses_insert_own on public.responses
  for insert to authenticated
  with check (participant_id = auth.uid());

create policy responses_select_all on public.responses
  for select to authenticated
  using (true);

-- question_answers bekommt bewusst keine einzige Policy.
