// Der publishable Key ist bewusst oeffentlich (jeder Client bekommt ihn),
// die eigentliche Sperre laeuft ueber RLS in der Migration, nicht ueber Geheimhaltung des Keys.
const SUPABASE_URL = 'https://gqjztqpuvcvtnptyntkr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_014OQcqBSJJlD2zNqRG_KQ_DxyYU7DH';

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
