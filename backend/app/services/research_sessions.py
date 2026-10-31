"""Research sessions: metadata for one investigation (plan → execution → insights → reports).

Sessions hold compact metadata only: the signed plan, a step timeline,
result summaries, the evidence-based insights and report metadata. GIS
payloads stay in the execution (memory, 30 minutes) and report files are
never stored, so reports can only be regenerated while their execution is
retained.

Storage is pluggable:
- memory (default): lost when the server restarts or sleeps;
- sqlite (RESEARCH_SESSION_STORE=sqlite:///path.db): survives restarts only
  if that file's disk does. Render Free's disk is ephemeral.

There is no authentication. Sessions are scoped by a random workspace key
the browser sends; it keeps browsers' lists apart but is not access control.
"""

import hashlib
import os
import secrets
import sqlite3
import threading
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any

from app.schemas.research import (
    ReportRecord,
    ResearchPlan,
    ResearchSession,
    ResearchSynthesis,
    SessionAvailability,
    SessionDetail,
    SessionExecution,
    SessionResult,
    SessionStep,
    SessionStorageInfo,
    SessionSummary,
)

MAX_SESSIONS_PER_WORKSPACE = 50
MAX_SESSIONS_TOTAL = 500
MAX_REPORTS_PER_SESSION = 20
MAX_INSIGHTS_BYTES = 256 * 1024
MAX_TEXT = 300
MEMORY_TTL = timedelta(hours=24)
SQLITE_TTL = timedelta(days=30)
EXECUTION_STATUS = {
    "queued": "running", "running": "running", "completed": "completed",
    "completed_with_warnings": "completed", "partial": "partial", "failed": "failed", "cancelled": "cancelled",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _short(text: Any, limit: int = MAX_TEXT) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _title(question: str) -> str:
    question = " ".join(question.split())
    return _short(question, 80) or "Untitled research"


# Stores

class SessionStore(ABC):
    kind: str
    persistent: bool
    ttl: timedelta

    @abstractmethod
    def get(self, session_id: str) -> ResearchSession | None: ...

    @abstractmethod
    def save(self, session: ResearchSession) -> None: ...

    @abstractmethod
    def delete(self, session_id: str) -> bool: ...

    @abstractmethod
    def for_workspace(self, workspace: str) -> list[ResearchSession]: ...

    @abstractmethod
    def all_ids_by_age(self) -> list[tuple[str, str, datetime]]: ...

    def info(self) -> SessionStorageInfo:
        if self.kind == "memory":
            note = ("Sessions are kept in server memory for up to 24 hours and are lost when the server restarts "
                    "or sleeps. They are not permanently saved.")
        else:
            note = ("Sessions are saved to a SQLite file for up to 30 days. They survive restarts only if that "
                    "file's disk does (Render Free disks are wiped on every deploy and restart).")
        return SessionStorageInfo(kind=self.kind, persistent=self.persistent, note=note)

    def prune(self) -> None:
        """Drop expired sessions, then the oldest beyond the size limits."""
        rows = self.all_ids_by_age()  # oldest first: (id, workspace, updated_at)
        cutoff = _now() - self.ttl
        keep = []
        for session_id, workspace, updated in rows:
            if updated < cutoff:
                self.delete(session_id)
            else:
                keep.append((session_id, workspace))
        per_workspace: dict[str, list[str]] = {}
        for session_id, workspace in keep:
            per_workspace.setdefault(workspace, []).append(session_id)
        for ids in per_workspace.values():
            for session_id in ids[: max(len(ids) - MAX_SESSIONS_PER_WORKSPACE, 0)]:
                self.delete(session_id)
        remaining = [s for s, _ in keep if self.get(s) is not None]
        for session_id in remaining[: max(len(remaining) - MAX_SESSIONS_TOTAL, 0)]:
            self.delete(session_id)


class MemorySessionStore(SessionStore):
    kind, persistent, ttl = "memory", False, MEMORY_TTL

    def __init__(self):
        self._items: dict[str, ResearchSession] = {}

    def get(self, session_id):
        session = self._items.get(session_id)
        return session.model_copy(deep=True) if session else None

    def save(self, session):
        self._items[session.session_id] = session.model_copy(deep=True)

    def delete(self, session_id):
        return self._items.pop(session_id, None) is not None

    def for_workspace(self, workspace):
        return [s.model_copy(deep=True) for s in self._items.values() if s.workspace == workspace]

    def all_ids_by_age(self):
        return sorted(((s.session_id, s.workspace, s.updated_at) for s in self._items.values()), key=lambda r: r[2])


class SQLiteSessionStore(SessionStore):
    kind, persistent, ttl = "sqlite", True, SQLITE_TTL

    def __init__(self, path: str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        with self._lock, self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS research_sessions ("
                "session_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)"
            )
            self._db.execute("CREATE INDEX IF NOT EXISTS research_sessions_workspace ON research_sessions (workspace)")

    def get(self, session_id):
        with self._lock:
            row = self._db.execute("SELECT data FROM research_sessions WHERE session_id = ?", (session_id,)).fetchone()
        return ResearchSession.model_validate_json(row[0]) if row else None

    def save(self, session):
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO research_sessions (session_id, workspace, updated_at, data) VALUES (?, ?, ?, ?)",
                (session.session_id, session.workspace, session.updated_at.isoformat(), session.model_dump_json()),
            )

    def delete(self, session_id):
        with self._lock, self._db:
            return self._db.execute("DELETE FROM research_sessions WHERE session_id = ?", (session_id,)).rowcount > 0

    def for_workspace(self, workspace):
        with self._lock:
            rows = self._db.execute("SELECT data FROM research_sessions WHERE workspace = ?", (workspace,)).fetchall()
        return [ResearchSession.model_validate_json(r[0]) for r in rows]

    def all_ids_by_age(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT session_id, workspace, updated_at FROM research_sessions ORDER BY updated_at"
            ).fetchall()
        return [(r[0], r[1], datetime.fromisoformat(r[2])) for r in rows]


def create_store(config: str | None) -> SessionStore:
    """RESEARCH_SESSION_STORE: unset/"memory", or "sqlite:///absolute/or/relative.db"."""
    if not config or config == "memory":
        return MemorySessionStore()
    if config.startswith("sqlite:///"):
        return SQLiteSessionStore(config.removeprefix("sqlite:///"))
    raise ValueError("RESEARCH_SESSION_STORE must be 'memory' or 'sqlite:///path/to/file.db'.")


STORE: SessionStore = create_store(os.getenv("RESEARCH_SESSION_STORE"))


# Lifecycle

def new_session_id() -> str:
    return f"ses-{secrets.token_hex(8)}"


def create(workspace: str, question: str, client_token: str | None) -> tuple[ResearchSession, bool]:
    """Returns (session, created). The same client token returns the same session."""
    STORE.prune()
    if client_token:
        existing = next((s for s in STORE.for_workspace(workspace) if s.client_token == client_token), None)
        if existing:
            return existing, False
    now = _now()
    session = ResearchSession(
        session_id=new_session_id(), workspace=workspace, client_token=client_token,
        title=_title(question), question=question.strip(), created_at=now, updated_at=now,
        status="draft",
    )
    STORE.save(session)
    STORE.prune()
    return session, True


def get(session_id: str, workspace: str) -> ResearchSession | None:
    session = STORE.get(session_id)
    if session is None or session.workspace != workspace:
        return None  # another workspace's session is indistinguishable from a missing one
    if session.updated_at < _now() - STORE.ttl:
        STORE.delete(session_id)
        return None
    return session


def _touch(session: ResearchSession) -> None:
    session.updated_at = _now()
    STORE.save(session)


def attach_plan(session: ResearchSession, plan: ResearchPlan) -> ResearchSession:
    session.plan = plan
    session.question = plan.original_question
    if not session.title_customised:
        session.title = _title(plan.original_question)
    if session.status in ("draft", "planned"):
        session.status = "planned"
    _touch(session)
    return session


def attach_execution(session: ResearchSession, execution_id: str) -> None:
    session.execution = SessionExecution(
        execution_id=execution_id, status="queued", started_at=None, finished_at=None,
        steps=[], warnings=[], errors=[], results=[],
    )
    session.insights = None
    session.status = "running"
    _touch(session)


def snapshot(public: dict[str, Any]) -> SessionExecution:
    return SessionExecution(
        execution_id=public["execution_id"],
        status=public["status"],
        started_at=public.get("started_at"),
        finished_at=public.get("finished_at"),
        steps=[
            SessionStep(id=s["id"], title=_short(s["title"]), capability_id=s["capability_id"], status=s["status"],
                        summary=_short(s["summary"]), error=_short(s["error"]) if s["error"] else None)
            for s in public["steps"]
        ],
        warnings=[_short(w) for w in public["warnings"][:20]],
        errors=[_short(e) for e in public["errors"][:20]],
        results=[
            SessionResult(capability_id=r["capability_id"], title=r["title"], outcome=r["outcome"],
                          message=_short(r["message"], 1500), layer_count=r.get("layer_count", 0))
            for r in public.get("results", [])
        ],
    )


def _linked(execution) -> ResearchSession | None:
    """The session that owns this execution, if it still points at it."""
    session_id = getattr(execution, "session_id", None)
    session = STORE.get(session_id) if session_id else None
    if session is None or session.execution is None or session.execution.execution_id != execution.id:
        return None
    return session


def record_execution(execution) -> None:
    session = _linked(execution)
    if session is None:
        return
    public = execution.public()
    session.execution = snapshot(public)
    session.status = EXECUTION_STATUS.get(public["status"], "running")
    session.warnings = [_short(w) for w in public["warnings"][:20]]
    _touch(session)


def record_insights(execution, synthesis: ResearchSynthesis) -> None:
    session = _linked(execution)
    if session is None:
        return
    if len(synthesis.model_dump_json()) <= MAX_INSIGHTS_BYTES:
        session.insights = synthesis
    else:
        session.warnings = (session.warnings + ["The insights were too large to keep with the session."])[-20:]
    _touch(session)


def record_report(execution, fmt: str, content: bytes) -> ReportRecord | None:
    session = _linked(execution)
    if session is None:
        return None
    record = ReportRecord(
        report_id=f"rpt-{uuid.uuid4().hex[:12]}", session_id=session.session_id, execution_id=execution.id,
        format=fmt, generated_at=_now(), size_bytes=len(content), sha256=hashlib.sha256(content).hexdigest(),
    )
    session.reports = (session.reports + [record])[-MAX_REPORTS_PER_SESSION:]
    _touch(session)
    return record


def rename(session: ResearchSession, title: str) -> ResearchSession:
    session.title = " ".join(title.split())[:120]
    session.title_customised = True
    _touch(session)
    return session


def delete(session: ResearchSession) -> bool:
    return STORE.delete(session.session_id)


# Read models (availability is computed, never stored)

def availability(session: ResearchSession, registry) -> tuple[str, SessionAvailability, Any]:
    """(display status, availability, live execution or None)."""
    live = registry.get(session.execution.execution_id) if session.execution else None
    status = session.status
    if session.execution is None:
        execution_state = "none"
    elif live is not None:
        execution_state = "retained"
        status = EXECUTION_STATUS.get(live.status, status)
    else:
        execution_state = "expired"
        if status == "running":
            status = "expired"  # interrupted, e.g. by a restart
    report_ok = (live is not None and live.finished and live.status not in ("failed", "cancelled")
                 and bool(live.syntheses))
    reports = "none" if not session.reports else ("regenerable" if report_ok else "unavailable")
    plan_ok = session.plan is not None and session.plan.status == "ready"
    can_execute = plan_ok and status in ("planned",) and _plan_signature_valid(session.plan)
    if execution_state == "expired":
        note = ("The execution data has expired (kept in memory for 30 minutes, lost on restart). The plan, results "
                "summary and any insights below are kept with the session; to download reports again, run the "
                "research again.")
    elif execution_state == "retained":
        note = "The execution data is still in memory: insights and reports can be generated now."
    elif session.plan is not None and not can_execute and session.plan.status == "ready":
        note = "This plan was created before the server restarted; plan the research again to run it."
    else:
        note = "Nothing has been executed yet."
    return status, SessionAvailability(
        execution=execution_state, insights="available" if session.insights else "not_generated",
        reports=reports, can_execute=can_execute, note=note,
    ), live


def _plan_signature_valid(plan: ResearchPlan) -> bool:
    from app.services import research_planner

    return research_planner.verify_plan(plan)


def summary(session: ResearchSession, registry) -> SessionSummary:
    status, available, _ = availability(session, registry)
    return SessionSummary(
        session_id=session.session_id, title=session.title, question=session.question,
        created_at=session.created_at, updated_at=session.updated_at, status=status,
        insight_status="available" if session.insights else "not_generated",
        report_count=len(session.reports), availability=available,
    )


def detail(session: ResearchSession, registry) -> SessionDetail:
    base = summary(session, registry)
    _, _, live = availability(session, registry)
    execution = session.execution
    if live is not None and execution is not None:
        execution = snapshot(live.public())  # fresher than the stored snapshot
    reports = [r.model_copy(update={"availability": _report_availability(r, registry)}) for r in session.reports]
    return SessionDetail(
        **base.model_dump(), warnings=session.warnings, plan=session.plan, execution=execution,
        insights=session.insights, reports=list(reversed(reports)),
    )


def _report_availability(record: ReportRecord, registry) -> str:
    live = registry.get(record.execution_id)
    ok = live is not None and live.finished and live.status not in ("failed", "cancelled") and bool(live.syntheses)
    return "regenerable" if ok else "unavailable"


def list_sessions(workspace: str, registry, limit: int, offset: int, status: str | None, query: str | None):
    STORE.prune()
    items = [summary(s, registry) for s in STORE.for_workspace(workspace)]
    if status:
        items = [s for s in items if s.status == status]
    if query:
        needle = query.lower()
        items = [s for s in items if needle in s.title.lower() or needle in s.question.lower()]
    items.sort(key=lambda s: (s.updated_at, s.session_id), reverse=True)
    return items[offset: offset + limit], len(items)

