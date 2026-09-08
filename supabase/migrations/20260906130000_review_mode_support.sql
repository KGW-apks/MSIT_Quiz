-- Traegt drei Live-Test-Befunde nach:
--
-- 1. Leaderboard soll rundenbasiert sein, nicht ueber die gesamte Historie
--    summieren. Ein einfacher Filter auf round_question_ids reicht aber nicht:
--    wiederholt sich eine Frage in einer spaeteren Runde (times_asked erlaubt
--    das), bleibt die alte responses-Zeile (Upsert auf participant_id+question_id)
--    unter derselben question_id stehen und wuerde sonst weiter mitzaehlen, auch
--    wenn in der neuen Runde gar nicht neu geantwortet wurde. Deshalb ein neuer
--    Zeitstempel round_started_at, gestempelt bei start_round, als Cutoff.
--
-- 2. Review-Modus (siehe Projektnotiz "Offene Punkte"): nach "Quiz beenden"
--    soll der Presenter im Dashboard durch alle Fragen der abgeschlossenen
--    Runde blaettern und die Verteilung sehen koennen, nicht nur fuer die
--    zuletzt gestellte. Die bestehende Policy question_answers_select_after_close
--    oeffnet eine Loesung nur, wenn sie current_question_id ist -- fuer frueher
--    gestellte Fragen der Runde bleibt sie also gesperrt. Neue Policy oeffnet
--    zusaetzlich alle Fragen der Runde, sobald das Quiz komplett beendet ist.

alter table public.quiz_sessions
  add column round_started_at timestamptz;

create or replace function public.presenter_control(
  action text,
  target_question_id uuid,
  presenter_secret text,
  round_size integer default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored_hash text;
  current_round uuid[];
  current_status text;
  current_qid uuid;
  picked_ids uuid[];
  total_questions integer;
begin
  select secret_hash into stored_hash from public.presenter_secret where id = true;

  if stored_hash is null or extensions.crypt(presenter_secret, stored_hash) is distinct from stored_hash then
    raise exception 'Ungueltiges Presenter-Passwort' using errcode = '28000';
  end if;

  if action = 'open' then
    select round_question_ids, status, current_question_id
      into current_round, current_status, current_qid
      from public.quiz_sessions limit 1;

    if current_status = 'finished' then
      raise exception 'Quiz bereits beendet, keine neue Frage oeffenbar';
    end if;

    if current_status = 'open' and current_qid = target_question_id then
      return;
    end if;

    if current_round is not null and not (target_question_id = any(current_round)) then
      raise exception 'Frage ist nicht Teil der aktuellen Runde';
    end if;

    update public.quiz_sessions
    set current_question_id = target_question_id, status = 'open'
    where true;

    update public.questions
    set times_asked = times_asked + 1
    where id = target_question_id;

  elsif action = 'close' then
    update public.quiz_sessions set status = 'closed' where true;

  elsif action = 'finish' then
    update public.quiz_sessions set status = 'finished' where true;

  elsif action = 'start_round' then
    if round_size is null or round_size < 1 then
      raise exception 'Rundengroesse muss mindestens 1 sein';
    end if;

    select count(*) into total_questions from public.questions;
    if round_size > total_questions then
      raise exception 'Rundengroesse (%) groesser als die Anzahl vorhandener Fragen (%)', round_size, total_questions;
    end if;

    select array_agg(id) into picked_ids
    from (
      select id from public.questions
      order by times_asked asc, random()
      limit round_size
    ) as chosen;

    -- Neu: round_started_at auf jetzt gestempelt, Cutoff fuers rundenbasierte
    -- Leaderboard (siehe computeLeaderboard in dashboard-state.js).
    update public.quiz_sessions
    set round_question_ids = picked_ids, current_question_id = null, status = 'lobby', round_started_at = now()
    where true;

  elsif action = 'cancel_round' then
    update public.quiz_sessions
    set round_question_ids = null, current_question_id = null, status = 'lobby'
    where true;

  else
    raise exception 'Unbekannte Presenter-Aktion: %', action;
  end if;
end;
$$;

create policy question_answers_select_after_finish on public.question_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.quiz_sessions
      where quiz_sessions.status = 'finished'
        and question_answers.question_id = any(quiz_sessions.round_question_ids)
    )
  );
