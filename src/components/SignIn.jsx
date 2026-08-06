import { useState } from 'react';
import { signIn } from '../lib/auth.js';

/**
 * Sign-in gate. The same Supabase account as the main hoof-tracker app —
 * the planner reads that practice data, so it is the same login.
 */
export default function SignIn({ configError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      // No navigation needed — App is listening for the auth state change.
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app signin-page">
      <header className="app-header">
        <img src="/thc-logo.svg" alt="The Hoof Clinic" className="logo" />
        <div>
          <h1>Route Planner</h1>
          <p className="muted small">Turn a day's stops into a timed itinerary.</p>
        </div>
      </header>

      <section className="panel signin">
        <h2>Sign in</h2>
        <p className="muted small">Use your usual Hoof Clinic login.</p>

        {configError ? (
          <p className="error">
            {configError}
            <br />
            <span className="small">
              Check <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> are set on the
              server, then redeploy.
            </span>
          </p>
        ) : (
          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                autoComplete="username"
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>

            {error && <p className="error">{error}</p>}
          </form>
        )}
      </section>
    </div>
  );
}
