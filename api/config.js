/**
 * GET /api/config
 *
 * The one deliberately public endpoint: it hands the browser the Supabase
 * project URL and anon key so it can run the sign-in flow.
 *
 * Why an endpoint rather than a `VITE_SUPABASE_ANON_KEY` build-time variable
 * (the usual Supabase pattern): keeping it server-side means every variable in
 * this project stays un-prefixed and set in exactly one place. Vercel scopes
 * environment variables per environment and a change needs a redeploy, so
 * "one place" is worth more here than saving a request. The anon key itself is
 * publishable by design — RLS is what protects the data — so serving it is not
 * the part that matters. Nothing else belongs in this response.
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error: 'SUPABASE_URL and SUPABASE_ANON_KEY must be set as server environment variables.',
    });
  }

  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json({ supabaseUrl, supabaseAnonKey });
}
