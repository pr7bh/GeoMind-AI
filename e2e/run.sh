#!/usr/bin/env bash
# Browser regression suite: starts fake Overpass/LLM, a test backend and a
# Vite dev server on test ports, runs regression.cjs, then stops only the
# processes it started. Never touches the default dev ports (5173 / 8000).
#
#   cd e2e && npm install && ./run.sh
# Env: CHROME_PATH (default: macOS Google Chrome), E2E_*_PORT to move ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERPASS_PORT="${E2E_OVERPASS_PORT:-9100}"
LLM_PORT="${E2E_LLM_PORT:-9101}"
API_PORT="${E2E_API_PORT:-8001}"
WEB_PORT="${E2E_WEB_PORT:-5174}"
LOGS="$(mktemp -d)"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

for port in "$OVERPASS_PORT" "$LLM_PORT" "$API_PORT" "$WEB_PORT"; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use; set E2E_*_PORT to free ports." >&2
    exit 2
  fi
done

python3 "$ROOT/e2e/fake_overpass.py" "$OVERPASS_PORT" >"$LOGS/overpass.log" 2>&1 & PIDS+=($!)
python3 "$ROOT/e2e/fake_llm.py" "$LLM_PORT" >"$LOGS/llm.log" 2>&1 & PIDS+=($!)

(
  cd "$ROOT/backend"
  OVERPASS_URL="http://127.0.0.1:$OVERPASS_PORT/api/interpreter" \
  CORS_ORIGINS="http://localhost:$WEB_PORT" \
  LLM_PROVIDER=remote LLM_BASE_URL="http://127.0.0.1:$LLM_PORT/v1" LLM_API_KEY=e2e-test LLM_MODEL=fake-model \
  exec .venv/bin/uvicorn app.main:app --port "$API_PORT"
) >"$LOGS/backend.log" 2>&1 & PIDS+=($!)

(
  cd "$ROOT/frontend"
  # A placeholder key selects the CARTO basemaps (tiles are intercepted in the browser).
  VITE_CARTO_API_KEY=e2e-placeholder VITE_API_BASE_URL="http://127.0.0.1:$API_PORT" exec npx vite --port "$WEB_PORT" --strictPort
) >"$LOGS/vite.log" 2>&1 & PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$API_PORT/api/agent/status" >/dev/null && curl -sf "http://localhost:$WEB_PORT/" >/dev/null; then
    break
  fi
  sleep 0.5
done

E2E_WEB="http://localhost:$WEB_PORT" E2E_API="http://127.0.0.1:$API_PORT" E2E_OVERPASS="http://127.0.0.1:$OVERPASS_PORT" E2E_LLM="http://127.0.0.1:$LLM_PORT" \
  node "$ROOT/e2e/regression.cjs" || { status=$?; echo "Logs: $LOGS" >&2; exit "$status"; }
