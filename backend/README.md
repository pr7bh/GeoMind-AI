# GeoMind AI — Backend

FastAPI service for spatial analysis, OpenStreetMap discovery, routing and the
Ask AI agent. It keeps no state on disk and needs no database, Redis or worker.

## Local development

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # edit as needed
.venv/bin/uvicorn app.main:app --reload --env-file .env
.venv/bin/pytest -q
```

### Optional: local LLM with Ollama

Ollama is for local development only.

```bash
ollama pull llama3.1          # any model with tool-calling support
```

Then in `backend/.env`:

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

Without an LLM (`LLM_PROVIDER=none`), Ask AI still handles direct requests
such as "Find hospitals within 5 km" (with a selected map location) and routes
between picked points. Open-ended questions explain that no LLM is configured.

## Deploying on Render (Free web service)

- Root directory: `backend`
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Environment:
  - `PYTHON_VERSION=3.12` (all pinned packages ship Linux wheels for 3.12)
  - `CORS_ORIGINS=https://<your-app>.vercel.app`
  - `LLM_PROVIDER=remote`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` for the
    agent, or `LLM_PROVIDER=none`

Do not set `LLM_PROVIDER=ollama` on Render; nothing is installed or downloaded
at build time, and no model runs on the server.

Frontend (Vercel): set `VITE_API_BASE_URL=https://<your-service>.onrender.com`.

## Agent API

- `POST /api/agent/chat` — JSON response (`message`, `steps`, `layers`, `mode`, …)
- `POST /api/agent/chat/stream` — the same, as newline-delimited JSON events
  (`thinking`, `tool_started`, `tool_finished`, then `result` or `error`)
- `GET /api/agent/status` — whether an LLM is configured (no URLs or keys)

Agent tools: `discover_features`, `find_nearest_features`, `create_buffer`,
`spatial_query`. Location always comes from the user's selected map point.
Limits: 3 tool rounds by default (+1 final answer call), 3 tool calls per
round, 200 discovered features, 2000-character messages, 6000-character tool
results sent to the model, 90-second overall timeout.

## Research API (plan → execute → insights → report)

All research endpoints live under `/api/research` and work without an LLM.
Executions, their evidence and their insights are kept **in memory only**
for 30 minutes (and are lost when the server restarts or sleeps); after that
the endpoints below return `404` asking you to run the research again.

| Step | Endpoint | Notes |
| --- | --- | --- |
| Plan | `POST /plan` | Validated, server-signed plan; nothing runs. |
| Execute | `POST /execute` | Body `{"plan": <plan from /plan>}`; streams NDJSON progress. |
| Status | `GET /executions/{id}` | Step states and summaries (no GIS payloads). |
| Cancel | `POST /executions/{id}/cancel` | Keeps completed steps. |
| Insights | `POST /executions/{id}/synthesize` | Body `{"mode": "auto"}` or `"deterministic"`; evidence-based, never re-runs. |
| Report | `POST /executions/{id}/report` | Body `{"format": "pdf"}` or `"docx"`; returns the file. |
| Sessions | `POST/GET /sessions`, `GET/PATCH/DELETE /sessions/{id}`, `GET /sessions/{id}/reports` | Workspace and report history (below). |

### Research reports

Reports are built from the execution's retained plan, evidence digest and
the insights already generated for it; no workflow is re-run and no data is
fetched. Generate insights first, then:

```bash
curl -X POST http://127.0.0.1:8000/api/research/executions/<execution_id>/report \
  -H 'Content-Type: application/json' -d '{"format": "pdf"}' -o report.pdf
```

- Formats: `pdf` (`application/pdf`, ReportLab) and `docx`
  (Word, python-docx). Both are generated in memory and never stored.
- Sections: cover, executive summary, research objectives and parameters,
  methodology (executed workflows only), key findings with evidence,
  comparative analysis and site suitability (when run), evidence register,
  data quality and limitations, conclusions and next steps, sources and
  attribution.
- Errors: `404` unknown or expired execution; `409` still running, failed,
  cancelled, no insights yet, or insights without evidence-supported
  findings; `422` invalid format or inconsistent report data.
- Limitations: no maps or images (the evidence digest deliberately keeps no
  geometry); the PDF uses the Bitstream Vera font bundled with ReportLab, so
  characters it lacks (for example non-Latin scripts) are replaced in the PDF
  but preserved in DOCX.
- Dependencies: `reportlab` and `python-docx` (in `requirements.txt`);
  `pypdf` is used only by the tests (`requirements-dev.txt`).

### Research sessions (workspace and report history)

A session records one investigation: question, title, the signed plan, a
compact step timeline and result summaries, the evidence-based insights and
report metadata. It never stores GIS geometry, map layers or report files.

Lifecycle: `draft` (created) → `planned` (`POST /plan` with `session_id`) →
`running` (`POST /execute` with `session_id`) → `completed`, `partial`,
`failed` or `cancelled`. Insights and reports update the session that owns
the execution automatically. `expired` means a session was still running
when its execution data disappeared (for example a restart).

Every session request needs an `X-GeoMind-Workspace` header (16–64 of
`A–Z a–z 0–9 _ -`). The frontend generates a random key per browser and keeps
it in `localStorage`. **This is not authentication**: GeoMind has no user
accounts, so sessions are not private. The key only keeps different browsers'
lists apart; anyone who has it can read those sessions. Another workspace's
session behaves exactly like a missing one (`404`).

```bash
H='X-GeoMind-Workspace: my-local-workspace-key'
curl -X POST localhost:8000/api/research/sessions -H "$H" -H 'Content-Type: application/json' \
  -d '{"question": "Hospital coverage", "client_token": "retry-token-123"}'
curl "localhost:8000/api/research/sessions?limit=20&offset=0&status=completed&q=hospital" -H "$H"
curl localhost:8000/api/research/sessions/ses-0123456789abcdef -H "$H"
curl -X PATCH localhost:8000/api/research/sessions/ses-0123456789abcdef -H "$H" \
  -H 'Content-Type: application/json' -d '{"title": "Delhi hospital study"}'
curl -X DELETE localhost:8000/api/research/sessions/ses-0123456789abcdef -H "$H"
```

- Creating with the same `client_token` returns the same session, so retries do
  not duplicate. A plan can only be executed in the session it belongs to.
- Limits: 50 sessions per workspace, 500 in total, 20 report records per
  session, insights up to 256 KB; oldest sessions are removed first. Lists are
  paginated (`limit` ≤ 50).
- Report history: records keep format, time, size and SHA-256. Files are not
  stored, so a report is `regenerable` only while its execution is in memory
  (30 minutes; lost on restart); otherwise it is `unavailable` and the research
  must be run again. Session details compute availability on every request.
- Reopening a session never re-runs analysis or contacts Overpass.

### Session storage

| `RESEARCH_SESSION_STORE` | Behaviour |
| --- | --- |
| unset or `memory` (default) | Server memory, up to 24 hours. Lost on restart or sleep. |
| `sqlite:///path/to/sessions.db` | SQLite file (Python standard library), up to 30 days. |

SQLite survives restarts only if its file does. On Render Free the disk is
ephemeral (wiped on every deploy, restart and sleep), so the default memory
store is the honest choice there; durable sessions need a persistent disk or
a future database store behind the same interface. Plans are signed with a
per-process key (`RESEARCH_PLAN_SECRET` can fix it), so after a restart saved
plans must be planned again before they can run, and executions (with their
evidence) are gone even when the session itself is kept.
