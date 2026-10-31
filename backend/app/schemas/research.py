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
