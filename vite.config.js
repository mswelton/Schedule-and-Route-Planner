import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'api');

/**
 * Runs the `api/*.js` Vercel functions inside the Vite dev server, so
 * `npm run dev` behaves like production without needing the Vercel CLI.
 *
 * Vercel gives handlers a parsed `req.body` and Express-style `res` helpers;
 * this reproduces just enough of that shape.
 */
function vercelApiDev() {
  return {
    name: 'vercel-api-dev',
    // `apply: 'serve'` keeps this whole plugin — including the env loading
    // below — out of the production build.
    apply: 'serve',

    /**
     * Put the server-side variables from .env.local into `process.env`.
     *
     * Vite only exposes VITE_-prefixed variables, and only on
     * `import.meta.env` — it deliberately never writes to `process.env`. The
     * api/ handlers are ordinary Node code reading `process.env`, so without
     * this they see nothing in dev and every request fails on a missing key.
     * `vercel dev` and the deployed functions do this for us; the Vite dev
     * server does not.
     *
     * The empty prefix loads every variable, which is the point: the keys we
     * need here are exactly the un-prefixed ones Vite keeps out of the client
     * bundle. That bundle is unaffected — Vite only ever inlines
     * `import.meta.env.VITE_*` into client code.
     */
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || process.cwd(), '');
      for (const [key, value] of Object.entries(env)) {
        // A real shell variable always wins over a .env file.
        if (process.env[key] === undefined) process.env[key] = value;
      }
    },

    configureServer(server) {
      if (!existsSync(apiDir)) return;
      const routes = new Set(
        readdirSync(apiDir)
          .filter((f) => f.endsWith('.js'))
          .map((f) => `/api/${f.replace(/\.js$/, '')}`)
      );

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!routes.has(url.pathname)) return next();

        try {
          const mod = await server.ssrLoadModule(path.join(apiDir, `${url.pathname.slice(5)}.js`));

          req.query = Object.fromEntries(url.searchParams);
          // Every verb that can carry a body, not just the two the app used
          // first: a request whose body is silently dropped here looks like a
          // handler bug and is a miserable half hour to track down.
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');
            req.body = raw ? JSON.parse(raw) : {};
          }

          res.status = (code) => {
            res.statusCode = code;
            return res;
          };
          res.json = (payload) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
            return res;
          };
          res.send = (payload) => {
            res.end(payload);
            return res;
          };

          await mod.default(req, res);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), vercelApiDev()],
  server: { port: 5173 },
});
