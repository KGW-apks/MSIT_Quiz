-- Client-seitiges Error-Logging: faengt JS-Fehler und fehlgeschlagene Supabase-Calls
-- aus Teilnehmer- und Dashboard/Presenter-Oberflaeche ein, damit Fehler im Livebetrieb
-- nachvollziehbar sind (bisher verschwanden sie nur in der Browser-Konsole des jeweiligen
-- Geraets). Ergaenzt Supabases eigene Postgres/API-Logs, die nur Server-, keine
-- Client-Fehler erfassen.
--
-- Kein Fremdschluessel auf participants: waehrend der Registrierung (signInAnonymously
-- erfolgreich, participants-Insert schlaegt fehl) existiert noch keine participants-Zeile
-- fuer die eigene auth.uid(), ein FK wuerde genau den Fehler verschlucken, der geloggt
-- werden soll. user_id ist deshalb ein reines, unvalidiertes uuid-Feld.
create table public.error_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source in ('participant', 'dashboard')),
  user_id uuid not null default auth.uid(),
  message text not null,
  context jsonb
);

create index error_logs_created_at_idx on public.error_logs (created_at desc);

alter table public.error_logs enable row level security;

-- Jede authentifizierte Session (Teilnehmer wie Presenter/Dashboard, gleicher stiller
-- Anonymous-Auth) darf eigene Fehler melden. user_id kommt per Default aus auth.uid(),
-- die Check-Klausel verhindert nur, dass ein Client fremde user_id vortaeuscht.
create policy error_logs_insert_own on public.error_logs
  for insert to authenticated
  with check (user_id = auth.uid());

-- Lesbar nur fuer Nicht-Teilnehmer-Sessions (Presenter/Dashboard). Es gibt keine eigene
-- Presenter-Rolle im Schema, die Unterscheidung laeuft ueberall gleich: der Presenter
-- authentifiziert sich wie ein Teilnehmer, legt aber nie eine participants-Zeile an.
create policy error_logs_select_non_participant on public.error_logs
  for select to authenticated
  using (not exists (select 1 from public.participants where participants.id = auth.uid()));

alter publication supabase_realtime add table public.error_logs;
