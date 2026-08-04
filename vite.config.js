import { defineConfig } from 'vite';
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
    apply: 'serve',
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
          if (req.method === 'POST' || req.method === 'PUT') {
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
