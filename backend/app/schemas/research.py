"""Research plan request/response models (planning only; nothing is executed)."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PlanStatus = Literal["ready", "needs_input", "unsupported", "invalid"]
StepStatus = Literal["planned", "blocked", "ready"]
InputId = Literal["location", "compare_location", "category", "facility"]


class ResearchPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(..., min_length=1, max_length=2000)
    # Selected map location (Area A), [longitude, latitude].
    coordinates: list[float] | None = Field(default=None, min_length=2, max_length=2)
    # Second study area for comparisons (Area B), [longitude, latitude].
    compare_coordinates: list[float] | None = Field(default=None, min_length=2, max_length=2)
    # Optional extra context from the user (shown to the interpreter only).
    context: str | None = Field(default=None, max_length=1000)
    # "auto": rules first, then the configured LLM if the rules find nothing.
    # "rules": never call an LLM.
    interpreter: Literal["auto", "rules"] = "auto"
    # Research session to attach the plan to (needs the workspace header).
    session_id: str | None = Field(default=None, pattern=r"^ses-[0-9a-f]{16}$")


class MissingInput(BaseModel):
    id: InputId
    label: str
    reason: str
    # Frontend action that can supply it.
    action: Literal["pick_location", "pick_compare_location", "edit_question"]


class SelectedArea(BaseModel):
    id: Literal["a", "b"]
    label: str
    coordinates: list[float] | None
    required: bool


class ResearchStep(BaseModel):
    id: str
    capability_id: str
    # Existing tool that performs the step (workflow step tool or agent tool).
    tool: str
    title: str
    description: str
    execution_order: int
    dependencies: list[str]
    # Used when available; their failure must not block this step.
    optional_dependencies: list[str]
    # Ids of identical steps from other capabilities merged into this one.
    aliases: list[str] = Field(default_factory=list)
    # Validated tool arguments; never coordinates (those come from the areas).
    arguments: dict[str, Any]
    required_inputs: list[InputId]
    expected_outputs: list[str]
    status: StepStatus


class CapabilityUse(BaseModel):
    id: str
    title: str
    reason: str


class ResearchPlan(BaseModel):
    id: str
    title: str
    original_question: str
    objective: str
    status: PlanStatus
    interpretation: list[str]
    selected_areas: list[SelectedArea]
    assumptions: list[str]
    limitations: list[str]
    missing_inputs: list[MissingInput]
    clarification_questions: list[str]
    capabilities: list[CapabilityUse]
    steps: list[ResearchStep]
    # "rules" (deterministic) or "llm" (validated model interpretation).
    interpreter: Literal["rules", "llm"]
    executed: Literal[False] = False
    created_at: datetime
    # Server signature over the plan; execution rejects plans that changed.
    signature: str = ""


# Research synthesis (Milestone 9.3): conclusions built only from evidence.

FindingType = Literal["measurement", "derived", "ranking", "qualitative", "data_quality"]
EvidenceKind = Literal["measured", "derived", "interpretation", "assumption"]


class EvidenceItem(BaseModel):
    evidence_id: str
    source_execution_id: str
    source_step_id: str | None
    capability_id: str
    finding_type: FindingType
    # measured: read directly from a workflow result; derived: calculated
    # from measured values (e.g. a difference); interpretation/assumption.
    kind: EvidenceKind
    title: str
    description: str
    observed_value: float | int | str | None
    unit: str | None
    geographic_scope: str
    methodology: str
    source_dataset: str
    # Quality as reported by the workflow (e.g. "complete", "truncated");
    # no invented confidence percentages.
    quality: str
    limitations: list[str]
    partial_or_truncated: bool


class KeyFinding(BaseModel):
    finding_id: str
    title: str
    conclusion: str
    evidence_ids: list[str]
    explanation: str
    geographic_scope: str
    quality: str
    caveats: list[str]
    source: Literal["deterministic", "llm"] = "deterministic"


class ComparisonInsight(BaseModel):
    comparison_id: str
    metric: str
    unit: str
    a_value: float | int | None
    b_value: float | int | None
    difference: float | None
    better: Literal["a", "b", "tie"] | None
    comparable: bool
    note: str
    evidence_ids: list[str]


class CandidateInsight(BaseModel):
    candidate_id: str
    rank: int
    tied: bool
    score: float
    coordinates: list[float]
    coverage_class: str | None
    strengths: list[str]
    weaknesses: list[str]
    explanation: str
    evidence_ids: list[str]
    caveat: str


class Recommendation(BaseModel):
    text: str
    evidence_ids: list[str]
    source: Literal["deterministic", "llm"] = "deterministic"


class ResearchSynthesis(BaseModel):
    synthesis_id: str
    execution_id: str
    plan_id: str
    research_question: str
    title: str
    executive_summary: str
    overall_status: Literal["complete", "partial", "insufficient_evidence", "failed"]
    key_findings: list[KeyFinding]
    evidence: list[EvidenceItem]
    comparisons: list[ComparisonInsight]
    candidate_insights: list[CandidateInsight]
    limitations: list[str]
    assumptions: list[str]
    data_quality_warnings: list[str]
    unsupported_questions: list[str]
    recommendations: list[Recommendation]
    methodology: list[str]
    generated_at: datetime
    synthesis_mode: Literal["deterministic", "llm_assisted"]
    # LLM statements dropped because evidence did not support them.
    rejected_llm_claims: int = 0


class SynthesisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # "auto": deterministic, then improved by the configured LLM if any.
    mode: Literal["auto", "deterministic"] = "auto"


# Research sessions (Milestone 9.5): one investigation's metadata.

SessionStatus = Literal["draft", "planned", "running", "completed", "partial", "failed", "cancelled", "expired"]
SESSION_ID_PATTERN = r"^ses-[0-9a-f]{16}$"
WORKSPACE_PATTERN = r"^[A-Za-z0-9_-]{16,64}$"


class SessionStep(BaseModel):
    id: str
    title: str
    capability_id: str
    status: str
    summary: str
    error: str | None


class SessionResult(BaseModel):
    capability_id: str
    title: str
    outcome: str
    message: str
    layer_count: int


class SessionExecution(BaseModel):
    """Compact snapshot of an execution (no GIS payloads)."""

    execution_id: str
    status: str
    started_at: str | None
    finished_at: str | None
    steps: list[SessionStep]
    warnings: list[str]
    errors: list[str]
    results: list[SessionResult]


class ReportRecord(BaseModel):
    report_id: str
    session_id: str
    execution_id: str
    format: Literal["pdf", "docx"]
    generated_at: datetime
    size_bytes: int
    sha256: str
    # Report files are never stored: "regenerable" while the execution and
    # its insights are retained in memory, otherwise "unavailable".
    availability: Literal["regenerable", "unavailable"] = "unavailable"


class SessionAvailability(BaseModel):
    execution: Literal["none", "retained", "expired"]
    insights: Literal["not_generated", "available"]
    reports: Literal["none", "regenerable", "unavailable"]
    can_execute: bool
    note: str


class ResearchSession(BaseModel):
    """Stored session. `workspace` and `client_token` are never returned."""

    session_id: str
    workspace: str
    client_token: str | None = None
    title: str
    title_customised: bool = False
    question: str
    created_at: datetime
    updated_at: datetime
    status: SessionStatus
    warnings: list[str] = Field(default_factory=list)
    plan: ResearchPlan | None = None
    execution: SessionExecution | None = None
    insights: ResearchSynthesis | None = None
    reports: list[ReportRecord] = Field(default_factory=list)


class SessionSummary(BaseModel):
    session_id: str
    title: str
    question: str
    created_at: datetime
    updated_at: datetime
    status: SessionStatus
    insight_status: Literal["not_generated", "available"]
    report_count: int
    availability: SessionAvailability


class SessionDetail(SessionSummary):
    warnings: list[str]
    plan: ResearchPlan | None
    execution: SessionExecution | None
    insights: ResearchSynthesis | None
    reports: list[ReportRecord]


class SessionStorageInfo(BaseModel):
    kind: Literal["memory", "sqlite"]
    persistent: bool
    note: str


class SessionList(BaseModel):
    items: list[SessionSummary]
    total: int
    limit: int
    offset: int
    storage: SessionStorageInfo


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field("", max_length=2000)
    # Retries with the same token return the same session (no duplicates).
    client_token: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{8,64}$")


class SessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=120)
