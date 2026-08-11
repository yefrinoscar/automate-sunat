# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Local-first browser automation tool (Express + Playwright backend, React + Vite frontend) that scrapes Falabella Seller Center sales and fills SUNAT invoice forms. See `README.md` for full description.

### Quick reference

| Action | Command |
|---|---|
| Install deps | `npm install && npm --prefix frontend install` |
| Install Playwright | `npm run pw:install` |
| Dev (both servers) | `npm run dev` |
| Server tests | `npm run test:server` |
| Frontend tests | `npm run test:web` |
| All tests | `npm test` |
| Typecheck | `npm run typecheck` |
| Production start | `npm start` |

### Non-obvious caveats

- A `.env` file is required at the repo root. The app reads `SITE_PROFILE_PATH` (defaults to `./config/custom-profile.json`). Without the profile file the server crashes on startup.
- `npm run dev` starts both the Express backend (port 3030) and the Vite frontend dev server (port 5173) via `concurrently`. The Vite server proxies `/api` to the backend. The frontend waits for the backend to be healthy before starting (via `tools/wait-for-server.mjs`).
- Playwright runs in headless mode when `HEADFUL=false` in `.env`. In Cloud Agent environments always use `HEADFUL=false`.
- The backend uses SQLite via `better-sqlite3` (auto-created at `data/automation.db`). No external database is needed.
- External credentials (`SELLER_USERNAME`, `SELLER_PASSWORD`, `SUNAT_USERNAME`, `SUNAT_PASSWORD`, `SUNAT_RUC`) are only needed for real end-to-end automation runs against Falabella/SUNAT. Tests and local dev work without them.
- No linter (ESLint) is configured; `npm run typecheck` is the primary static analysis tool.
