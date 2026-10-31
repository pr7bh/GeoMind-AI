"""Evidence-based research synthesis.

Turns an execution's evidence digest into a structured answer. Every
finding cites evidence items, and every evidence item is read from a
workflow result (measured) or computed from such values (derived). Nothing
is re-run and no data is fetched.

Deterministic synthesis always runs. An optional LLM may only rewrite the
narrative: its statements are kept only when every number they contain
matches the evidence they cite and they make no claim about data GeoMind
does not have. Scores, rankings, findings and caveats are never changed by it.
"""

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.research import (
    CandidateInsight,
    ComparisonInsight,
    EvidenceItem,
    KeyFinding,
    Recommendation,
    ResearchSynthesis,
)
from app.services import suitability
from app.services.llm.base import LLMError, LLMProvider
from app.services.workflows import catalog

logger = logging.getLogger(__name__)

DATASET = "OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)"
CALCULATED = "GeoMind calculation (no external data)"
TOP_INSIGHTS = 5
MAX_EVIDENCE = 150
MAX_LLM_EVIDENCE = 80
LLM_TIMEOUT_MARGIN_SECONDS = 2.0

# Topics GeoMind has no data for; statements about them are never accepted.
UNSUPPORTED_TOPICS = re.compile(
    r"\b(population|residents|demograph\w*|zoning|land[- ]?(?:ownership|use|availability|price)|legal\w*|"
    r"permit\w*|traffic|travel[- ]time|drive[- ]time|demand|footfall|income|overall winner|best overall)\b",
    re.IGNORECASE,
)
NUMBER = re.compile(r"-?\d+(?:\.\d+)?")

METHODOLOGY = [
    "Every conclusion cites evidence items read from this execution's workflow results; nothing was re-run "
    "and no new data was fetched.",
    "Measured values are copied from the workflows; derived values (differences, the coverage class at a "
    "candidate point) are calculated from them.",
    "No confidence percentages are given: the workflows do not estimate statistical confidence. Quality "
    "reflects their completeness flags (for example truncated discovery).",
    "Areas are compared metric by metric; no overall winner is declared.",
    "Distances are straight-line distances to mapped OpenStreetMap features, not travel times.",
]


def _km(metres: float | None) -> str:
    return "n/a" if metres is None else f"{metres / 1000:.2f} km"


def _fmt(value: Any, unit: str | None) -> str:
    if value is None:
        return "missing"
    if unit == "m":
        return _km(value)
    if unit == "%":
        return f"{value:g}%"
    if unit == "per km²":
        return f"{value:.3f} per km²"
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


def _point(coords: list[float] | None) -> str:
    return f"({coords[1]:.4f}, {coords[0]:.4f})" if coords else "the selected location"


class _Builder:
    def __init__(self, execution_id: str, digest: dict[str, Any]):
        self.execution_id = execution_id
        self.digest = digest
        self.evidence: list[EvidenceItem] = []
        self.findings: list[KeyFinding] = []
        self.comparisons: list[ComparisonInsight] = []
        self.candidates: list[CandidateInsight] = []
        self.limitations: list[str] = []
        self.warnings: list[str] = []
        self.recommendations: list[Recommendation] = []
        self.methodology: list[str] = list(METHODOLOGY)

    def ev(self, evidence_id: str, capability: str, step: str | None, title: str, value: Any, unit: str | None,
           scope: str, method: str, *, kind: str = "measured", finding_type: str = "measurement",
           quality: str = "complete", limitations: list[str] | None = None, partial: bool = False,
           description: str | None = None, dataset: str = DATASET) -> str:
        if len(self.evidence) < MAX_EVIDENCE:
            self.evidence.append(EvidenceItem(
                evidence_id=evidence_id, source_execution_id=self.execution_id, source_step_id=step,
                capability_id=capability, finding_type=finding_type, kind=kind, title=title,
                description=description or f"{title}: {_fmt(value, unit)}.", observed_value=value, unit=unit,
                geographic_scope=scope, methodology=method, source_dataset=dataset, quality=quality,
                limitations=limitations or [], partial_or_truncated=partial,
            ))
        return evidence_id

    def finding(self, finding_id: str, title: str, conclusion: str, evidence_ids: list[str], explanation: str,
                scope: str, quality: str = "complete", caveats: list[str] | None = None) -> None:
        known = {e.evidence_id for e in self.evidence}
        cited = [e for e in evidence_ids if e in known]
        if not cited:
            return  # no evidence, no conclusion
        self.findings.append(KeyFinding(
            finding_id=finding_id, title=title, conclusion=conclusion, evidence_ids=cited,
            explanation=explanation, geographic_scope=scope, quality=quality, caveats=caveats or [],
        ))

    def recommend(self, text: str, evidence_ids: list[str]) -> None:
        self.recommendations.append(Recommendation(text=text, evidence_ids=evidence_ids))

    # Workflows

    def coverage(self, entry: dict[str, Any]) -> None:
        s, services = entry["summary"], entry.get("services") or {}
        step = entry["steps"].get("analyse")
        label = (services.get("label") or "services").lower()
        singular = (services.get("category") or "service").replace("_", " ")
        well, moderate = s["thresholds_m"]["well_covered"], s["thresholds_m"]["moderate"]
        scope = f"{s['radius_km']:g} km around Area A {_point(s['centre'])}"
        method = (f"{s['total_cells']} grid cells of {s['cell_size_m']} m; straight-line distance from each cell "
                  f"centroid to the nearest mapped {singular}; well covered ≤ {well / 1000:g} km, underserved > "
                  f"{moderate / 1000:g} km.")
        caveats = []
        if s.get("discovery_truncated"):
            caveats.append(f"{label.capitalize()} discovery was truncated, so some services may be missing and "
                           "coverage may look worse than it is near the edge.")
        if not s.get("search_margin_sufficient", True):
            caveats.append("The search did not extend far enough past the study edge; edge cells may be misclassified.")
        partial = bool(s.get("partial"))
        quality = "incomplete (" + "; ".join(caveats) + ")" if partial and caveats else ("incomplete" if partial else "complete")
        self.warnings += caveats

        ids = {
            "found": self.ev("coverage:services_found", "coverage", entry["steps"].get("find_services"),
                             f"{label.capitalize()} found for the coverage analysis", s["services_count"], "count",
                             f"Searched within {s.get('search_radius_km', s['radius_km']):g} km", method,
                             quality=quality, partial=bool(s.get("discovery_truncated")), limitations=caveats),
        }
        for cls in ("well_covered", "moderate", "underserved", "no_service_found"):
            if cls == "no_service_found" and not s["counts"][cls]:
                continue
            ids[cls] = self.ev(f"coverage:{cls}_pct", "coverage", step, f"{cls.replace('_', ' ').capitalize()} cells",
                               s["percentages"][cls], "%", scope, method, quality=quality, partial=partial)
        for key in ("average_distance_m", "max_distance_m"):
            if s.get(key) is not None:
                ids[key] = self.ev(f"coverage:{key}", "coverage", step,
                                   ("Average" if key.startswith("average") else "Maximum") + f" nearest-{singular} distance",
                                   s[key], "m", scope, method, quality=quality, partial=partial)

        if s["services_count"] == 0:
            self.finding("F-coverage", f"No mapped {label}",
                         f"No {label} are mapped in OpenStreetMap within the search area, so every cell is classed "
                         "'no service found'.", [ids["found"], ids.get("no_service_found", "")],
                         "No distances were calculated because there was nothing to measure to.", scope, quality, caveats)
            return
        pct = s["percentages"]
        self.finding(
            "F-coverage", f"{singular.capitalize()} coverage",
            f"{pct['underserved']:g}% of grid cells within {s['radius_km']:g} km are underserved (nearest {singular} "
            f"more than {moderate / 1000:g} km away) and {pct['well_covered']:g}% are well covered "
            f"(within {well / 1000:g} km).",
            [ids["underserved"], ids["well_covered"], ids["found"]] + [ids[k] for k in ("average_distance_m",) if k in ids],
            f"Based on {s['services_count']} mapped {label}; the average nearest distance is {_km(s.get('average_distance_m'))} "
            f"and the maximum is {_km(s.get('max_distance_m'))}.",
            scope, quality, ["Straight-line proximity; not travel time, road access or service capacity."] + caveats,
        )
        if pct["underserved"] > 0:
            self.recommend("Add the coverage layer to the map and inspect the underserved (red) cells to see where "
                           "existing services are farthest away.", [ids["underserved"]])
        self.methodology.append("Coverage: " + method)

    def comparison(self, entry: dict[str, Any]) -> None:
        thresholds = entry.get("thresholds", {})
        same_config = len(thresholds) == 2 and thresholds.get("a") == thresholds.get("b")
        step = entry["steps"].get("compare")
        areas = entry["areas"]
        method = "Identical grid, radius and thresholds for both areas; metrics compared one by one."
        for key in ("a", "b"):
            if areas.get(key, {}).get("metrics") is None:
                error = areas.get(key, {}).get("error") or "it did not run"
                self.warnings.append(f"Area {key.upper()} could not be analysed ({error}); its metrics are missing, not zero.")
        if not same_config and thresholds:
            self.warnings.append("The two areas were analysed with different settings, so their metrics are not compared directly.")

        for row in entry.get("metrics", []):
            unit, metric = row["unit"], row["label"]
            ids = []
            for key in ("a", "b"):
                if row[key] is not None:
                    metrics = areas[key]["metrics"]
                    ids.append(self.ev(
                        f"comparison:{row['key']}:{key}", "comparison", entry["steps"].get(f"area_{key}"),
                        f"{metric} (Area {key.upper()})", row[key], unit,
                        f"{metrics['radius_km']:g} km around Area {key.upper()} {_point(metrics['centre'])}", method,
                        quality="complete" if row["definitive"] else "indicative (incomplete data)",
                        partial=not row["definitive"],
                    ))
            comparable = row["a"] is not None and row["b"] is not None and same_config
            if comparable and row["difference"] is not None:
                ids.append(self.ev(f"comparison:{row['key']}:difference", "comparison", step,
                                   f"{metric} difference (A − B)", row["difference"], unit,
                                   "Area A vs Area B", "Difference of the two measured values.", kind="derived",
                                   finding_type="derived", partial=not row["definitive"]))
            if row["a"] is None or row["b"] is None:
                note = "Not comparable: at least one area is missing this measurement (missing, not zero)."
            elif not same_config:
                note = "Not comparable: the areas used different settings."
            elif not row["definitive"]:
                note = "Indicative only: discovery was truncated or coverage incomplete in at least one area."
            else:
                note = ("Higher is better." if row["higher_is_better"] else "Lower is better.")
            self.comparisons.append(ComparisonInsight(
                comparison_id=f"C-{row['key']}", metric=metric, unit=unit, a_value=row["a"], b_value=row["b"],
                difference=row["difference"], better=row["better"] if comparable else None, comparable=comparable,
                note=note, evidence_ids=ids,
            ))
            if comparable and row["key"] in ("underserved_pct", "average_distance_m", "well_covered_pct"):
                a, b = _fmt(row["a"], unit), _fmt(row["b"], unit)
                if row["better"] == "tie":
                    conclusion = f"Both areas measure the same on {metric.lower()} ({a})."
                else:
                    direction = "higher" if row["higher_is_better"] else "lower"
                    conclusion = (f"Area {row['better'].upper()} is better on {metric.lower()}: {a} in Area A vs "
                                  f"{b} in Area B ({direction} is better).")
                self.finding(
                    f"F-compare-{row['key']}", f"{metric}: Area A vs Area B", conclusion, ids,
                    "Measured with identical settings in both areas; this compares one metric and does not "
                    "make either area better overall.",
                    "Area A and Area B", "complete" if row["definitive"] else "indicative",
                    [] if row["definitive"] else ["Indicative only: incomplete data in at least one area."],
                )

    def suitability(self, entry: dict[str, Any], cross: dict[str, Any]) -> None:
        label = (entry.get("facility_label") or "facility").lower()
        scope = f"{entry['radius_km']:g} km around {_point(entry['centre'])}"
        step = entry["steps"].get("score")
        criteria = {c["id"]: c for c in entry["criteria"]}
        used = [c for c in entry["criteria"] if c["status"] == "used"]
        method = ("Weighted sum of 0–100 criterion scores: "
                  + ", ".join(f"{c['name'].lower()} ({c['weight'] * 100:.0f}%)" for c in used)
                  + f"; {entry['normalization']} normalisation; {entry['candidate_count']} analytical grid points.")
        complete = bool(entry.get("complete"))
        quality = "complete" if complete else "incomplete"
        caveat = "Analytical grid point, not a verified or available land parcel; check land, zoning and access separately."
        for line in entry.get("data_quality") or []:
            self.warnings.append(line)
        for c in entry["criteria"]:
            if c["status"] == "unavailable":
                self.warnings.append(f"Suitability criterion '{c['name']}' was unavailable ({c['note']}); "
                                     "its weight was redistributed to the others.")

        count_id = self.ev("suitability:scored", "suitability", step, "Candidates scored", entry["scored_count"],
                           "count", scope, method, quality=quality, partial=not complete,
                           description=f"{entry['scored_count']} of {entry['candidate_count']} candidates scored; "
                                       f"{entry['unscored_count']} unscored.")
        weight_ids = [self.ev(f"suitability:weight:{c['id']}", "suitability", step, f"Weight of {c['name'].lower()}",
                              c["weight"], "weight", scope, method, kind="assumption", finding_type="qualitative")
                      for c in used]
        top = entry.get("top") or []
        if not top:
            self.findings.append(KeyFinding(
                finding_id="F-suitability", title="No ranking", conclusion="No candidate could be scored.",
                evidence_ids=[count_id], explanation="Required data for every enabled criterion was missing.",
                geographic_scope=scope, quality="incomplete", caveats=[caveat]))
            return

        classes = (cross.get("candidate_coverage") or {}).get("classes", {})
        source = (cross.get("candidate_coverage") or {}).get("source")
        for candidate in top[:TOP_INSIGHTS]:
            cid = candidate["id"]
            ids = [self.ev(f"suitability:{cid}:score", "suitability", step, f"Suitability score of {cid}",
                           candidate["score"], "score (0–100)", f"Candidate {cid} {_point([candidate['lon'], candidate['lat']])}",
                           method, finding_type="ranking", quality=quality, partial=not complete)]
            parts = []
            for criterion_id, part in candidate["criteria"].items():
                name = criteria[criterion_id]["name"]
                ids.append(self.ev(f"suitability:{cid}:{criterion_id}", "suitability", step, f"{name} at {cid}",
                                   part["raw"], criteria[criterion_id]["unit"], f"Candidate {cid}", method,
                                   quality=quality, partial=bool(part.get("lower_bound")),
                                   limitations=["Lower bound: nothing found within the search."] if part.get("lower_bound") else []))
                parts.append(f"{name.lower()} {part['contribution']:g} points")
            if cid in classes and classes[cid]:
                ids.append(self.ev(f"cross:{cid}:coverage_class", "suitability", step,
                                   f"Coverage class of the grid cell containing {cid}", classes[cid].replace("_", " "),
                                   "class", f"Candidate {cid}",
                                   f"Point-in-cell lookup in the {'coverage' if source == 'coverage' else 'Area A comparison'} grid.",
                                   kind="derived", finding_type="derived"))
            self.candidates.append(CandidateInsight(
                candidate_id=cid, rank=candidate["rank"], tied=candidate["tied"], score=candidate["score"],
                coordinates=[candidate["lon"], candidate["lat"]], coverage_class=classes.get(cid),
                strengths=candidate["strengths"], weaknesses=candidate["weaknesses"],
                explanation=f"Score {candidate['score']:g}/100 from " + ", ".join(parts) + ".",
                evidence_ids=ids, caveat=caveat,
            ))

        first = top[0]
        top_ids = [f"suitability:{first['id']}:score"] + weight_ids[:3]
        if entry.get("tied_at_top", 1) > 1:
            tied = [c["id"] for c in top if c["score"] == first["score"]]
            conclusion = (f"{entry['tied_at_top']} analytical candidates share the highest score of {first['score']:g}/100 "
                          f"(including {', '.join(tied[:5])}); the scoring does not separate them.")
            self.recommend("Adjust the criterion weights or enable another criterion to separate the tied candidates.",
                           [f"suitability:{first['id']}:score"])
        else:
            conclusion = (f"Analytical candidate {first['id']} {_point([first['lon'], first['lat']])} has the highest "
                          f"suitability score for a new {label}: {first['score']:g}/100.")
            if len(top) > 1:
                top_ids.append(f"suitability:{top[1]['id']}:score")
        self.finding("F-suitability", f"Highest-scoring candidate for a new {label}", conclusion, top_ids,
                     (entry.get("top_comparison") or {}).get("text") or "Only one candidate was scored.",
                     scope, quality, [caveat])
        self.recommend(f"Verify land availability, zoning and road access for the top candidates before treating "
                       f"any of them as a site for a new {label}.", [f"suitability:{first['id']}:score"])
        self.methodology.append("Site suitability: " + method)

        if classes:
            shown = [c["id"] for c in top[:TOP_INSIGHTS] if classes.get(c["id"])]
            weak = [c for c in shown if classes[c] in ("underserved", "moderate", "no_service_found")]
            grid = "service coverage analysis" if source == "coverage" else "Area A coverage grid of the comparison"
            self.finding(
                "F-cross-coverage-suitability", "Where high-scoring candidates sit relative to existing coverage",
                f"{len(weak)} of the top {len(shown)} candidates lie in cells the {grid} classes as moderate or "
                f"underserved; {len(shown) - len(weak)} lie in well-covered cells.",
                [f"cross:{c}:coverage_class" for c in shown],
                "This links weaker existing coverage with high suitability. The suitability score already includes a "
                "'nearby service gap' criterion derived from the same coverage method, so the two results are related, "
                "not independent confirmation.",
                scope, quality, [caveat],
            )

    def nearby_count(self, entry: dict[str, Any]) -> None:
        sources, nearby = entry["sources"], entry.get("nearby") or {}
        source_label, target_label = sources["label"].lower(), (nearby.get("label") or "features").lower()
        radius = nearby.get("radius_km")
        step = entry["steps"].get("rank")
        scope = f"{sources['radius_km']:g} km around Area A"
        method = f"Distinct {target_label} within {radius:g} km of each {source_label[:-1] if source_label.endswith('s') else source_label}."
        complete = bool(entry.get("complete"))
        if sources.get("truncated"):
            self.warnings.append(f"{sources['label']} discovery was truncated; only the nearest {sources['returned']} were ranked.")
        if entry.get("unranked"):
            self.warnings.append(f"{len(entry['unranked'])} {source_label} could not be searched; their counts are unknown, not zero.")
        ranking = entry.get("ranking") or []
        if not ranking:
            return
        ids = []
        for r in ranking[:3] + entry.get("lowest", []):
            ids.append(self.ev(f"nearby:{r['id']}:count", "nearby_count", step, f"{target_label.capitalize()} near {r['name']}",
                               r["nearby_count"], "count", f"{radius:g} km around {r['name']}", method,
                               finding_type="ranking", quality="complete" if complete else "incomplete",
                               partial=bool(r.get("count_is_lower_bound")),
                               limitations=["Lower bound: the search hit a result limit."] if r.get("count_is_lower_bound") else []))
        best = ranking[0]
        tied = [r["name"] for r in ranking if r["rank"] == 1]
        conclusion = (f"{', '.join(tied)} {'share' if len(tied) > 1 else 'has'} the most {target_label} within {radius:g} km: "
                      f"{best['nearby_count']}{'+' if best['count_is_lower_bound'] else ''}.")
        self.finding("F-nearby-top", f"Most {target_label} near {source_label}", conclusion,
                     [f"nearby:{best['id']}:count"], f"Ranked {entry['ranking_size']} {source_label} by {method.lower()}",
                     scope, "complete" if complete else "incomplete")
        low = (entry.get("lowest") or ranking[-1:])[-1]
        if entry["ranking_size"] > 1 and low["id"] != best["id"]:
            self.finding("F-nearby-low", f"Least {target_label} support", f"{low['name']} has the fewest {target_label} "
                         f"within {radius:g} km: {low['nearby_count']}.", [f"nearby:{low['id']}:count"],
                         "Lowest count in the ranking.", scope, "complete" if complete else "incomplete")

    def tools(self, capability: str, entry: dict[str, Any]) -> None:
        for index, layer in enumerate(entry.get("layers", [])):
            if layer.get("kind") == "analysis":
                # Geometry GeoMind calculated itself (e.g. a buffer): no OSM data involved.
                ids = [self.ev(f"{capability}:{index}:geometry", capability, None, layer["name"], layer["name"], None,
                               "Around Area A", "Geodesic buffer calculated around Area A.", kind="derived",
                               finding_type="derived", dataset=CALCULATED)]
                self.finding(f"F-{capability}-{index}", layer["name"], f"{layer['name']} was created around Area A.",
                             ids, "A calculated geometry; it contains no mapped features by itself.", "Around Area A")
                continue
            ids = [self.ev(f"{capability}:{index}:count", capability, None, layer["name"], layer["feature_count"],
                           "count", "Around Area A", "OpenStreetMap discovery.")]
            for n, near in enumerate(layer["nearest"][:3]):
                ids.append(self.ev(f"{capability}:{index}:nearest:{n}", capability, None, f"Distance to {near['name']}",
                                   round(near["distance_km"] * 1000), "m", "From Area A", "Geodesic distance."))
            nearest = layer["nearest"][0] if layer["nearest"] else None
            self.finding(f"F-{capability}-{index}", layer["name"],
                         f"{layer['feature_count']} features found"
                         + (f"; the nearest is {nearest['name']} at {nearest['distance_km']:.2f} km." if nearest else "."),
                         ids, entry["message"][:300], "Around Area A")


# Deterministic synthesis

def deterministic(execution_id: str, digest: dict[str, Any]) -> ResearchSynthesis:
    builder = _Builder(execution_id, digest)
    capabilities, cross = digest["capabilities"], digest.get("cross", {})

    for capability in ("comparison", "coverage", "nearby_count", "suitability"):
        entry = capabilities.get(capability)
        if not entry:
            continue
        if capability == "coverage" and entry.get("summary"):
            builder.coverage(entry)
        elif capability == "comparison" and entry.get("areas"):
            builder.comparison(entry)
        elif capability == "suitability" and entry.get("top") is not None:
            builder.suitability(entry, cross)
        elif capability == "nearby_count" and entry.get("sources"):
            builder.nearby_count(entry)
    for capability, entry in capabilities.items():
        if capability not in ("comparison", "coverage", "nearby_count", "suitability"):
            builder.tools(capability, entry)
    for capability, entry in capabilities.items():
        if entry["outcome"] == "failed":
            builder.warnings.append(f"{entry['title']} did not produce results; nothing is concluded from it.")

    # Comparison + suitability: different questions, kept apart.
    if "comparison" in capabilities and builder.candidates:
        refs = [e for e in ("comparison:underserved_pct:a", "comparison:underserved_pct:b") if any(x.evidence_id == e for x in builder.evidence)]
        builder.finding(
            "F-scope-comparison-suitability", "Existing coverage vs candidate suitability",
            "The comparison measures existing coverage in both areas; candidate sites were scored only around Area A. "
            "The suitability ranking therefore does not say which area needs a new facility more.",
            refs + [f"suitability:{builder.candidates[0].candidate_id}:score"],
            "Read the coverage comparison for where service is weaker, and the suitability ranking for where in "
            "Area A a site scores best on the chosen criteria.",
            "Area A and Area B",
        )

    execution = digest["execution"]
    for error in execution.get("errors", []):
        builder.warnings.append(error)
    if execution["status"] == "cancelled":
        builder.warnings.append("The research was cancelled; only steps that finished before cancellation are used.")

    unsupported = [
        f"{suitability.UNSUPPORTED_CRITERIA[key].capitalize()}: not analysed. GeoMind has no data for it, so no conclusion is drawn."
        for key in catalog.unsupported_criteria(digest["question"])
    ]
    limitations = [
        "All findings come from mapped OpenStreetMap features; unmapped facilities are not included.",
        "Distances are straight-line, not travel time; capacity, quality and opening hours of services are not considered.",
    ] + [line for line in digest.get("plan_limitations", []) if line not in unsupported]

    substantive = [f for f in builder.findings]
    partial = any(e.partial_or_truncated for e in builder.evidence) or bool(builder.warnings) \
        or execution["status"] not in ("completed",)
    if not substantive:
        status = "failed" if execution["status"] in ("failed", "cancelled") else "insufficient_evidence"
    else:
        status = "partial" if partial else "complete"

    summary = _summary(builder.findings, status)
    titles = [capabilities[c]["title"] for c in capabilities]
    return ResearchSynthesis(
        synthesis_id="rs-" + hashlib.sha256(f"{execution_id}:deterministic".encode()).hexdigest()[:12],
        execution_id=execution_id,
        plan_id=digest["plan_id"],
        research_question=digest["question"],
        title="Research insights: " + " + ".join(titles),
        executive_summary=summary,
        overall_status=status,
        key_findings=builder.findings,
        evidence=builder.evidence,
        comparisons=builder.comparisons,
        candidate_insights=builder.candidates,
        limitations=limitations,
        assumptions=list(digest.get("assumptions", [])),
        data_quality_warnings=list(dict.fromkeys(builder.warnings)),
        unsupported_questions=unsupported,
        recommendations=builder.recommendations,
        methodology=builder.methodology,
        generated_at=datetime.now(timezone.utc),
        synthesis_mode="deterministic",
    )


def _summary(findings: list[KeyFinding], status: str) -> str:
    if status == "failed":
        return "The research did not produce results, so no conclusions can be drawn."
    if status == "insufficient_evidence":
        return "The completed steps did not produce enough evidence for conclusions."
    lines = [f.conclusion for f in findings[:3]]
    if status == "partial":
        lines.append("Some results are incomplete; see the data-quality warnings before relying on them.")
    return " ".join(lines)


# LLM-assisted narrative (validated)

class _LLMItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(..., min_length=1, max_length=600)
    evidence_ids: list[str] = Field(..., min_length=1, max_length=10)


class _LLMExplanation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    finding_id: str = Field(..., max_length=80)
    explanation: str = Field(..., min_length=1, max_length=800)


class _LLMNarrative(BaseModel):
    model_config = ConfigDict(extra="forbid")
    executive_summary: str = Field(..., min_length=1, max_length=1500)
    finding_explanations: list[_LLMExplanation] = Field(default_factory=list, max_length=20)
    connections: list[_LLMItem] = Field(default_factory=list, max_length=5)
    recommendations: list[_LLMItem] = Field(default_factory=list, max_length=5)


NARRATIVE_TOOL = {
    "type": "function",
    "function": {
        "name": "write_research_narrative",
        "description": "Rewrite the findings as a clear narrative. Use only the supplied evidence values.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["executive_summary"],
            "properties": {
                "executive_summary": {"type": "string", "maxLength": 1500},
                "finding_explanations": {
                    "type": "array", "maxItems": 20,
                    "items": {"type": "object", "additionalProperties": False, "required": ["finding_id", "explanation"],
                              "properties": {"finding_id": {"type": "string"}, "explanation": {"type": "string"}}},
                },
                "connections": {
                    "type": "array", "maxItems": 5,
                    "items": {"type": "object", "additionalProperties": False, "required": ["text", "evidence_ids"],
                              "properties": {"text": {"type": "string"}, "evidence_ids": {"type": "array", "items": {"type": "string"}}}},
                },
                "recommendations": {
                    "type": "array", "maxItems": 5,
                    "items": {"type": "object", "additionalProperties": False, "required": ["text", "evidence_ids"],
                              "properties": {"text": {"type": "string"}, "evidence_ids": {"type": "array", "items": {"type": "string"}}}},
                },
            },
        },
    },
}

SYSTEM_PROMPT = (
    "You write GIS research narratives. Use only the evidence provided; cite evidence ids. Do not add numbers, "
    "coordinates, datasets or facts that are not in the evidence. Do not change scores or rankings. Do not declare "
    "an overall winner between areas. Population, land, zoning, traffic and travel-time data were not analysed: do "
    "not discuss them. Keep caveats about incomplete data. Call write_research_narrative once."
)


def _allowed_numbers(items: list[EvidenceItem]) -> list[float]:
    numbers: list[float] = []
    for item in items:
        value = item.observed_value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            numbers += [float(value), float(value) * 100]
            if item.unit == "m":
                numbers.append(float(value) / 1000)
        for text in (item.title, item.description, item.geographic_scope):
            numbers += [float(n) for n in NUMBER.findall(text)]
    return numbers


def _numbers_supported(text: str, items: list[EvidenceItem]) -> bool:
    allowed = _allowed_numbers(items)
    for token in NUMBER.findall(text):
        decimals = len(token.split(".")[1]) if "." in token else 0
        value = float(token)
        if not any(round(a, decimals) == value or abs(a - value) < 1e-9 for a in allowed):
            return False
    return True


def _acceptable(text: str, items: list[EvidenceItem]) -> bool:
    return bool(items) and not UNSUPPORTED_TOPICS.search(text) and _numbers_supported(text, items)


async def llm_assisted(base: ResearchSynthesis, provider: LLMProvider, timeout: float) -> ResearchSynthesis:
    """Improve the narrative; on any failure return the deterministic synthesis with a note."""
    evidence = {e.evidence_id: e for e in base.evidence}
    payload = {
        "question": base.research_question,
        "status": base.overall_status,
        "findings": [{"finding_id": f.finding_id, "conclusion": f.conclusion, "evidence_ids": f.evidence_ids} for f in base.key_findings],
        "evidence": [
            {"id": e.evidence_id, "title": e.title, "value": e.observed_value, "unit": e.unit,
             "scope": e.geographic_scope, "quality": e.quality}
            for e in base.evidence[:MAX_LLM_EVIDENCE]
        ],
        "warnings": base.data_quality_warnings[:10],
    }
    try:
        response = await asyncio.wait_for(
            provider.chat(
                [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": json.dumps(payload, default=str)}],
                [NARRATIVE_TOOL],
            ),
            timeout=timeout,
        )
        calls = [c for c in response.tool_calls if c.name == "write_research_narrative"]
        if len(calls) != 1 or calls[0].arguments is None:
            raise ValueError("the model did not return a narrative")
        narrative = _LLMNarrative.model_validate(calls[0].arguments)
    except (LLMError, ValueError, ValidationError, asyncio.TimeoutError) as exc:
        reason = "it timed out" if isinstance(exc, asyncio.TimeoutError) else "its response was invalid or unavailable"
        logger.info("LLM synthesis not used: %s", exc)
        return base.model_copy(update={"methodology": base.methodology + [
            f"An AI narrative was requested but not used ({reason}); this is the deterministic synthesis."]})

    accepted, rejected = 0, 0
    update: dict[str, Any] = {}
    findings = [f.model_copy() for f in base.key_findings]

    summary_items = [evidence[i] for f in base.key_findings for i in f.evidence_ids]
    if _acceptable(narrative.executive_summary, summary_items):
        summary = narrative.executive_summary.strip()
        if base.overall_status != "complete" and not re.search(r"\b(incomplete|partial|missing)\b", summary, re.I):
            summary += " Some results are incomplete; see the data-quality warnings."
        update["executive_summary"] = summary
        accepted += 1
    else:
        rejected += 1

    by_id = {f.finding_id: f for f in findings}
    for item in narrative.finding_explanations:
        finding = by_id.get(item.finding_id)
        if finding and _acceptable(item.explanation, [evidence[i] for i in finding.evidence_ids]):
            finding.explanation = item.explanation.strip()
            accepted += 1
        else:
            rejected += 1

    for index, item in enumerate(narrative.connections):
        cited = [evidence[i] for i in item.evidence_ids if i in evidence]
        if len(cited) == len(item.evidence_ids) and _acceptable(item.text, cited):
            findings.append(KeyFinding(
                finding_id=f"F-llm-connection-{index + 1}", title="Connection between findings",
                conclusion=item.text.strip(), evidence_ids=item.evidence_ids,
                explanation="AI-written connection; every number in it matches the cited evidence.",
                geographic_scope=", ".join(sorted({e.geographic_scope for e in cited}))[:200],
                quality="interpretation", caveats=["Interpretation of the cited evidence, not a new measurement."],
                source="llm",
            ))
            accepted += 1
        else:
            rejected += 1

    recommendations = list(base.recommendations)
    for item in narrative.recommendations:
        cited = [evidence[i] for i in item.evidence_ids if i in evidence]
        if len(cited) == len(item.evidence_ids) and _acceptable(item.text, cited):
            recommendations.append(Recommendation(text=item.text.strip(), evidence_ids=item.evidence_ids, source="llm"))
            accepted += 1
        else:
            rejected += 1

    if not accepted:
        return base.model_copy(update={
            "rejected_llm_claims": rejected,
            "methodology": base.methodology + ["An AI narrative was generated but none of it matched the evidence, so it was not used."],
        })
    return base.model_copy(update={
        **update,
        "key_findings": findings,
        "recommendations": recommendations,
        "synthesis_mode": "llm_assisted",
        "synthesis_id": "rs-" + hashlib.sha256(f"{base.execution_id}:llm".encode()).hexdigest()[:12],
        "rejected_llm_claims": rejected,
        "methodology": base.methodology + [
            "Narrative text was improved by an AI model; statements were kept only if every number matched the "
            f"cited evidence ({accepted} kept, {rejected} rejected). Findings, scores and caveats are unchanged."
        ],
    })


async def synthesize(execution_id: str, digest: dict[str, Any], provider: LLMProvider | None,
                     llm_timeout_seconds: float) -> ResearchSynthesis:
    base = deterministic(execution_id, digest)
    if provider is None or base.overall_status in ("failed", "insufficient_evidence"):
        return base
    return await llm_assisted(base, provider, llm_timeout_seconds + LLM_TIMEOUT_MARGIN_SECONDS)
