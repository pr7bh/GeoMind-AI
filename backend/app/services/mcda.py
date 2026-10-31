"""Deterministic multi-criteria decision analysis (weighted linear combination).

Pure functions with no I/O: weight validation, 0–100 normalisation, weighted
scores, stable ranking and plain-language explanations. A missing value is
never treated as zero: it either drops a criterion that no candidate has, or
leaves an individual candidate unscored.
"""

import math
from dataclasses import dataclass
from typing import Any

MAX_CRITERIA = 10
STRENGTH_SCORE = 66.0
WEAKNESS_SCORE = 33.0
# Scores equal at this precision share a rank.
SCORE_DECIMALS = 2


class MCDAError(ValueError):
    """Invalid MCDA input; the message is safe to show to users."""


@dataclass(frozen=True)
class Criterion:
    id: str
    name: str
    description: str
    unit: str
    higher_is_better: bool
    # "saturating": value / saturation, clamped to [0, 1]; "minmax": relative
    # to the lowest and highest candidate value.
    method: str = "saturating"
    saturation: float | None = None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "unit": self.unit,
            "higher_is_better": self.higher_is_better,
            "method": self.method,
            "saturation": self.saturation,
        }


def normalize_weights(weights: dict[str, Any], allowed: list[str]) -> dict[str, float]:
    """Validate raw weights and scale them to sum to 1.

    Zero weights disable a criterion. Order follows `allowed`.
    """
    if not weights:
        raise MCDAError("Enable at least one criterion.")
    if len(weights) > MAX_CRITERIA:
        raise MCDAError(f"At most {MAX_CRITERIA} criteria can be weighted.")

    unknown = sorted(set(weights) - set(allowed))
    if unknown:
        raise MCDAError(f"Unknown or unsupported criteria: {', '.join(unknown)}.")

    for key, value in weights.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise MCDAError(f"The weight for '{key}' must be a finite number.")
        if value < 0:
            raise MCDAError(f"The weight for '{key}' must not be negative.")

    total = float(sum(weights.values()))
    if total <= 0:
        raise MCDAError("At least one criterion needs a weight above zero.")

    return {key: weights[key] / total for key in allowed if weights.get(key, 0) > 0}


def normalize_values(values: list[float | None], criterion: Criterion) -> tuple[list[float | None], str | None]:
    """Map raw values to 0–100 (100 = most suitable). None stays None.

    Returns (scores, note); the note flags identical values under min–max.
    """
    present = [v for v in values if v is not None]
    if not present:
        return [None] * len(values), "unavailable"

    if criterion.method == "saturating":
        if not criterion.saturation or criterion.saturation <= 0:
            raise MCDAError(f"Criterion '{criterion.id}' needs a positive saturation value.")

        def score(v: float) -> float:
            share = min(max(v / criterion.saturation, 0.0), 1.0)
            return 100 * share if criterion.higher_is_better else 100 * (1 - share)

        return [None if v is None else round(score(v), SCORE_DECIMALS) for v in values], None

    if criterion.method != "minmax":
        raise MCDAError(f"Unknown normalisation method '{criterion.method}'.")

    low, high = min(present), max(present)
    if math.isclose(low, high, rel_tol=1e-9, abs_tol=1e-9):
        # No variation: the criterion cannot tell candidates apart.
        return [None if v is None else 50.0 for v in values], "no_variation"

    def scaled(v: float) -> float:
        share = (v - low) / (high - low)
        return 100 * share if criterion.higher_is_better else 100 * (1 - share)

    return [None if v is None else round(scaled(v), SCORE_DECIMALS) for v in values], None


def score_candidates(
    candidates: list[dict[str, Any]],
    criteria: dict[str, Criterion],
    weights: dict[str, float],
) -> dict[str, Any]:
    """Score and rank candidates.

    `candidates`: [{"id": str, "values": {criterion_id: raw | None}}].
    `weights`: normalised weights (sum 1) for the enabled criteria.

    A criterion with no value for any candidate is dropped and the remaining
    weights are renormalised (and reported). A candidate missing a value for
    a criterion that others have is left unscored rather than given zero.
    """
    columns = {cid: [c["values"].get(cid) for c in candidates] for cid in weights}
    dropped = [cid for cid, column in columns.items() if all(v is None for v in column)]
    active = {cid: w for cid, w in weights.items() if cid not in dropped}
    if not active:
        raise MCDAError("None of the enabled criteria could be evaluated with the available data.")

    total = sum(active.values())
    effective = {cid: w / total for cid, w in active.items()}

    normalised, notes = {}, {}
    for cid in effective:
        normalised[cid], note = normalize_values(columns[cid], criteria[cid])
        if note:
            notes[cid] = note

    scored, unscored = [], []
    for index, candidate in enumerate(candidates):
        missing = [cid for cid in effective if normalised[cid][index] is None]
        breakdown = {}
        for cid, weight in effective.items():
            value = normalised[cid][index]
            breakdown[cid] = {
                "raw": candidate["values"].get(cid),
                "normalized": value,
                "weight": round(weight, 4),
                "contribution": None if value is None else round(value * weight, SCORE_DECIMALS),
            }

        entry = {"id": candidate["id"], "criteria": breakdown}
        if missing:
            entry["reason"] = "Missing data for: " + ", ".join(criteria[cid].name for cid in missing) + "."
            unscored.append(entry)
            continue

        entry["score"] = round(sum(v["normalized"] * effective[cid] for cid, v in breakdown.items()), SCORE_DECIMALS)
        scored.append(entry)

    # Stable: score descending, then candidate id.
    scored.sort(key=lambda e: (-e["score"], e["id"]))
    for position, entry in enumerate(scored):
        if position and entry["score"] == scored[position - 1]["score"]:
            entry["rank"] = scored[position - 1]["rank"]
        else:
            entry["rank"] = position + 1
    for position, entry in enumerate(scored):
        neighbours = scored[max(position - 1, 0):position] + scored[position + 1:position + 2]
        entry["tied"] = any(other["score"] == entry["score"] for other in neighbours)

    for entry in scored:
        entry.update(explain(entry, criteria))

    return {
        "ranked": scored,
        "unscored": unscored,
        "weights": {cid: round(w, 4) for cid, w in effective.items()},
        "requested_weights": {cid: round(w, 4) for cid, w in weights.items()},
        "dropped_criteria": dropped,
        "normalization_notes": notes,
    }


def explain(entry: dict[str, Any], criteria: dict[str, Criterion]) -> dict[str, Any]:
    """Strengths and weaknesses from normalised criterion scores."""
    strengths, weaknesses = [], []
    for cid, part in entry["criteria"].items():
        value = part["normalized"]
        if value is None:
            continue
        if value >= STRENGTH_SCORE:
            strengths.append(f"{criteria[cid].name}: strong ({value:g}/100)")
        elif value <= WEAKNESS_SCORE:
            weaknesses.append(f"{criteria[cid].name}: weak ({value:g}/100)")
    return {"strengths": strengths, "weaknesses": weaknesses}


def compare_pair(a: dict[str, Any], b: dict[str, Any], criteria: dict[str, Criterion]) -> dict[str, Any]:
    """Contribution differences between two scored candidates, largest first."""
    rows = []
    for cid in a["criteria"]:
        ca, cb = a["criteria"][cid]["contribution"], b["criteria"][cid]["contribution"]
        rows.append({
            "criterion": cid,
            "name": criteria[cid].name,
            "a": ca,
            "b": cb,
            "difference": None if ca is None or cb is None else round(ca - cb, SCORE_DECIMALS),
        })
    rows.sort(key=lambda r: (-(abs(r["difference"]) if r["difference"] is not None else -1), r["criterion"]))

    leading = next((r for r in rows if r["difference"]), None)
    if a["score"] == b["score"]:
        text = f"{a['id']} and {b['id']} have the same score ({a['score']:g})."
    elif leading is None:
        text = f"{a['id']} and {b['id']} differ only by rounding."
    else:
        higher = a["id"] if a["score"] > b["score"] else b["id"]
        text = (
            f"{higher} scores {abs(a['score'] - b['score']):.2f} points higher; the largest difference is "
            f"{leading['name'].lower()} ({abs(leading['difference']):.2f} points in favour of "
            f"{a['id'] if leading['difference'] > 0 else b['id']})."
        )
    return {"a": a["id"], "b": b["id"], "score_difference": round(a["score"] - b["score"], SCORE_DECIMALS), "rows": rows, "text": text}
