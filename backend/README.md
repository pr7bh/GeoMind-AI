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
