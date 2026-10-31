"""Deterministic fake Overpass API for browser tests.

POST /api/interpreter answers by category around the query centre.
GET /mode/<name> switches behaviour: normal | fail_context | fail_all.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

MODE = {"value": "normal"}
OFFSETS = {
    "hospital": [(0.01, 0.0), (-0.025, 0.012), (0.0, -0.03)],
    "pharmacy": [(0.012, 0.001), (0.009, -0.001), (-0.021, 0.011)],
    "other": [(0.004, 0.006), (-0.015, -0.012)],
}


def respond(query):
    lat, lon = (float(v) for v in query.split("(around:")[1].split(")")[0].split(",")[1:3])
    if 'nwr["healthcare"]' in query:
        kind = "healthcare"
    else:
        match = re.search(r'"amenity"="(\w+)"', query) or re.search(r'\["\w+"="(\w+)"\]', query)
        kind = match[1] if match else "other"

    if MODE["value"] == "fail_all" or (MODE["value"] == "fail_context" and kind == "healthcare"):
        return None

    if kind == "healthcare":
        spots = [(dx, dy, "hospital") for dx, dy in OFFSETS["hospital"]] + [
            (dx, dy, "pharmacy") for dx, dy in OFFSETS["pharmacy"]
        ]
    else:
        spots = [(dx, dy, kind) for dx, dy in OFFSETS.get(kind, OFFSETS["other"])]
    return [
        {"type": "node", "id": 1000 + i, "lon": lon + dx, "lat": lat + dy,
         "tags": {"amenity": amenity, "name": f"Test {amenity} {i}"}}
        for i, (dx, dy, amenity) in enumerate(spots)
    ]


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
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        elements = respond(parse_qs(body)["data"][0])
        if elements is None:
            self.send_response(503)
            self.end_headers()
            return
        payload = json.dumps({"elements": elements, "osm3s": {"timestamp_osm_base": "2026-10-30T00:00:00Z"}})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload.encode())


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
