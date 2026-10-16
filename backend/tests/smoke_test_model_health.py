"""
Module      : smoke_test_model_health.py
Synopsis    : Validates model collapse detection helper (Task 2f):
              1. Fake always-'up' label list returns 'single_class'
              2. Balanced list returns 'ok'
              3. Fewer than minSamples (<20, e.g. 10 samples) returns 'insufficient_data'
              4. Boundary threshold behavior at exactly 0.95 returns 'single_class'
              5. Just below 0.95 threshold returns 'ok'
"""

import os
import sys

# Ensure backend root is on sys.path
backendDir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backendDir not in sys.path:
    sys.path.insert(0, backendDir)

from model_health import checkSingleClass


def test_model_health():
    # 1. Always-'up' list (>= 20 samples) -> single_class
    alwaysUp = ["up"] * 40
    res1 = checkSingleClass(alwaysUp, minSamples=20, threshold=0.95)
    assert res1["status"] == "single_class", f"Expected single_class, got {res1}"
    assert res1["dominantClass"] == "up"
    assert res1["dominantShare"] == 1.0
    assert res1["sampleSize"] == 40
    print("PASS: Always-'up' list -> single_class (100%)")

    # 2. Balanced list -> ok
    balanced = ["up", "down", "neutral"] * 10  # 30 samples, 33.3% each
    res2 = checkSingleClass(balanced, minSamples=20, threshold=0.95)
    assert res2["status"] == "ok", f"Expected ok, got {res2}"
    assert res2["dominantShare"] < 0.95
    print(f"PASS: Balanced list -> ok (dominant share {res2['dominantShare']*100:.1f}%)")

    # 3. 10 samples (< minSamples=20) -> insufficient_data
    shortList = ["up"] * 10
    res3 = checkSingleClass(shortList, minSamples=20, threshold=0.95)
    assert res3["status"] == "insufficient_data", f"Expected insufficient_data, got {res3}"
    assert res3["sampleSize"] == 10
    print("PASS: 10 samples (< 20) -> insufficient_data")

    # 4. Boundary at exactly 0.95 (19 up, 1 down out of 20 = 0.95) -> single_class
    boundary95 = ["up"] * 19 + ["down"] * 1
    res4 = checkSingleClass(boundary95, minSamples=20, threshold=0.95)
    assert res4["status"] == "single_class", f"Expected single_class at 0.95, got {res4}"
    assert res4["dominantShare"] == 0.95
    print("PASS: Exactly 0.95 boundary (19/20) -> single_class")

    # 5. Just below boundary (18 up, 2 down out of 20 = 0.90) -> ok
    below95 = ["up"] * 18 + ["down"] * 2
    res5 = checkSingleClass(below95, minSamples=20, threshold=0.95)
    assert res5["status"] == "ok", f"Expected ok at 0.90, got {res5}"
    assert res5["dominantShare"] == 0.90
    print("PASS: Just below boundary (18/20 = 0.90) -> ok")

    print("\nALL MODEL HEALTH SMOKE TESTS PASSED CLEANLY")


if __name__ == "__main__":
    test_model_health()
