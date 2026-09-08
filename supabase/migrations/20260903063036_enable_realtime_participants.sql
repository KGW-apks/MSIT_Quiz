-- Presenter zeigt "X angemeldet" waehrend der Lobby-Phase live, damit
-- ersichtlich ist, wann alle da sind, bevor die erste Frage geoeffnet wird.
alter publication supabase_realtime add table public.participants;
