-- Ohne das hier feuert postgres_changes nie: Tabellen sind standardmaessig
-- nicht Teil der supabase_realtime-Publication.
alter publication supabase_realtime add table public.quiz_sessions;
