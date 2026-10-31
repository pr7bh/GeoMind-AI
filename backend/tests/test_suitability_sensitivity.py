"""Milestone 8 scoring sensitivity: how weights drive scores and rankings.

These pin the current methodology (weighted linear combination of 0–100
criterion scores); they do not tune it.
"""

import itertools
import random

import pytest

from app.services import mcda, suitability

CENTRE = (77.2167, 28.6315)
D, G, N = suitability.DISTANCE, suitability.GAP, suitability.DENSITY


def feature(fid, lon, lat, **tags):
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"display_name": fid, "tags": tags},
    }


def found(features, radius_km):
    return {
        "category": "x", "label": "X", "search_radius_km": radius_km, "total_found": len(features),
        "returned": len(features), "truncated": False, "features": features,
    }


EXISTING = found([feature("node/1", 77.2267, 28.6315), feature("node/2", 77.19, 28.65)], 10)
# Healthcare clustered north-east, so density disagrees with distance in places.
CONTEXT = found(
    [feature(f"node/{10 + i}", 77.24 + 0.004 * (i % 4), 28.65 + 0.004 * (i // 4), amenity="clinic") for i in range(12)],
    7,
)


def analyse(weights=None, context=CONTEXT, **options):
    return suitability.analyse(CENTRE, "hospital", 5, EXISTING, context, weights, **options)


def by_id(result):
    return {entry["id"]: entry for entry in result["ranked"]}


def test_equal_weights_score_is_the_mean():
    result = analyse({D: 1, G: 1, N: 1})
    assert result["weights"] == {D: pytest.approx(1 / 3, abs=1e-4), G: pytest.approx(1 / 3, abs=1e-4), N: pytest.approx(1 / 3, abs=1e-4)}
    for entry in result["ranked"]:
        mean = sum(part["normalized"] for part in entry["criteria"].values()) / 3
        assert entry["score"] == pytest.approx(mean, abs=0.02)


def test_unequal_weights_follow_the_formula():
    result = analyse({D: 1, G: 2, N: 7})
    assert result["weights"] == {D: 0.1, G: 0.2, N: 0.7}
    for entry in result["ranked"]:
        parts = entry["criteria"]
        expected = 0.1 * parts[D]["normalized"] + 0.2 * parts[G]["normalized"] + 0.7 * parts[N]["normalized"]
        assert entry["score"] == pytest.approx(expected, abs=0.02)


@pytest.mark.parametrize("criterion", [D, G, N])
def test_single_criterion_score_equals_its_normalised_value(criterion):
    result = analyse({criterion: 5})
    assert result["weights"] == {criterion: 1.0}
    for entry in result["ranked"]:
        assert list(entry["criteria"]) == [criterion]
        assert entry["score"] == entry["criteria"][criterion]["normalized"]


def test_disabled_criteria_do_not_affect_scores():
    enabled = analyse({D: 1, G: 1})
    zeroed = analyse({D: 1, G: 1, N: 0})
    assert [(e["id"], e["score"]) for e in enabled["ranked"]] == [(e["id"], e["score"]) for e in zeroed["ranked"]]
    status = {c["id"]: c["status"] for c in zeroed["criteria"]}
    assert status[N] == "disabled" and status[suitability.PHARMACY] == "disabled"


def test_missing_criterion_redistributes_proportionally():
    result = analyse({D: 1, G: 3, N: 4}, context=None, context_error="failed")
    assert result["requested_weights"] == {D: 0.125, G: 0.375, N: 0.5}
    assert result["weights"] == {D: 0.25, G: 0.75}  # ratio D:G kept at 1:3
    assert result["weight_total"] == 1.0
    # Same as running without that criterion at all.
    direct = analyse({D: 1, G: 3}, context=None)
    assert [(e["id"], e["score"]) for e in result["ranked"]] == [(e["id"], e["score"]) for e in direct["ranked"]]


def test_identical_measurements_tie_and_order_by_id():
    criteria = {"a": mcda.Criterion("a", "A", "", "m", True, "minmax", None), "b": mcda.Criterion("b", "B", "", "count", False, "saturating", 10)}
    rows = [{"id": f"c-{i:02d}", "values": {"a": 7.0, "b": 3}} for i in range(12)]
    result = mcda.score_candidates(rows, criteria, {"a": 0.5, "b": 0.5})
    assert {e["score"] for e in result["ranked"]} == {60.0}  # mean of 50 (no variation) and 70
    assert {e["rank"] for e in result["ranked"]} == {1} and all(e["tied"] for e in result["ranked"])
    assert [e["id"] for e in result["ranked"]] == sorted(r["id"] for r in rows)
    assert result["normalization_notes"] == {"a": "no_variation"}


def test_ranking_is_stable_under_input_order():
    criteria = {"a": mcda.Criterion("a", "A", "", "m", True, "saturating", 10)}
    rows = [{"id": f"c-{i:02d}", "values": {"a": i % 3}} for i in range(30)]
    expected = [(e["id"], e["rank"]) for e in mcda.score_candidates(rows, criteria, {"a": 1})["ranked"]]
    rng = random.Random(8)
    for _ in range(5):
        shuffled = rows[:]
        rng.shuffle(shuffled)
        assert [(e["id"], e["rank"]) for e in mcda.score_candidates(shuffled, criteria, {"a": 1})["ranked"]] == expected


def weight_grid(step=0.1):
    n = round(1 / step)
    for i, j in itertools.product(range(n + 1), repeat=2):
        if i + j <= n:
            yield {D: i / n, G: j / n, N: (n - i - j) / n}


def test_weight_sweep_is_deterministic_and_weights_matter():
    tops = {}
    for weights in weight_grid():
        clean = {k: v for k, v in weights.items() if v > 0}
        tops[tuple(weights.values())] = analyse(clean)["ranked"][0]["id"]

    again = {tuple(w.values()): analyse({k: v for k, v in w.items() if v > 0})["ranked"][0]["id"] for w in weight_grid()}
    assert tops == again  # deterministic

    # Weights change the ranking, even where one dominant candidate stays on top.
    distance_only = [e["id"] for e in analyse({D: 1})["ranked"]]
    density_only = [e["id"] for e in analyse({N: 1})["ranked"]]
    assert distance_only != density_only
    minmax_tops = {analyse({k: v for k, v in w.items() if v > 0}, normalization="minmax")["ranked"][0]["id"] for w in weight_grid()}
    assert len(minmax_tops) > 1


def test_saturation_ties_share_rank_one():
    """Many candidates can saturate at 100; they must be reported as tied, not ordered by merit."""
    result = analyse({N: 1})
    top = [e for e in result["ranked"] if e["score"] == 100]
    assert len(top) > 1
    assert all(e["rank"] == 1 and e["tied"] for e in top)
    assert [e["id"] for e in top] == sorted(e["id"] for e in top)


def test_distance_and_gap_are_correlated_measures():
    """Documents (does not fix) the overlap: both reward distance from existing facilities."""
    result = analyse({D: 1, G: 1, N: 1}, normalization="minmax")
    pairs = [(e["criteria"][D]["normalized"], e["criteria"][G]["normalized"]) for e in result["ranked"]]
    xs, ys = zip(*pairs)
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    var = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    assert cov / var > 0.5
