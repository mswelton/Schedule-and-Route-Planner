/**
 * Browser-side Supabase Auth.
 *
 * Named `auth.js` rather than `supabase.js` on purpose: `lib/supabase.js` is
 * the *server* module holding the service-role key, and two files with the
 * same name either side of that boundary is an easy mistake to make.
 *
 * The project URL and anon key are fetched from `/api/config` at first use
 * rather than baked in at build time, so nothing here needs a `VITE_` variable.
 * The client is created once and shared; Supabase persists the session in
 * localStorage and refreshes it, so signing in on the ute's phone lasts.
 */

import { createClient } from '@supabase/supabase-js';

let clientPromise = null;

export function supabaseClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const res = await fetch('/api/config');
      const config = await res.json().catch(() => ({}));
      if (!res.ok || !config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error(
          config.error || 'The server has not been configured with Supabase credentials.'
        );
      }
      return createClient(config.supabaseUrl, config.supabaseAnonKey);
    })();

    // Don't cache a failed lookup — a missing env var is usually fixed by a
    // redeploy, and the user should be able to retry without a hard refresh.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/** The current access token, or null when signed out. */
export async function accessToken() {
  const supabase = await supabaseClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

export async function signIn(email, password) {
  const supabase = await supabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  const supabase = await supabaseClient();
  await supabase.auth.signOut();
}
