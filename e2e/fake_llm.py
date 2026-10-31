"""Fake OpenAI-compatible chat completions endpoint for browser tests.

First call asks for discover_features; once a tool result is present it
answers. GET /mode/slow delays answers (for cancellation), /mode/normal resets.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = {"value": "normal"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/mode/"):
            MODE["value"] = self.path.split("/mode/", 1)[1]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(MODE["value"].encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if MODE["value"] == "slow":
            time.sleep(20)
        if any(m.get("role") == "tool" for m in body.get("messages", [])):
            message = {"role": "assistant", "content": "The fake model found hospitals near the selected location."}
        else:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "discover_features", "arguments": json.dumps({"category": "hospital", "radius_km": 5})},
                }],
            }
        payload = json.dumps({"choices": [{"index": 0, "message": message, "finish_reason": "stop"}]})
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # the backend cancelled the request


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
