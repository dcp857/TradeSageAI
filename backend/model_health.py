"""
Module      : model_health.py
Synopsis    : Pure helper to detect model collapse (e.g. single-class prediction collapse)
              without modifying training settings or model architecture (Task 2).
"""

from collections import Counter


def checkSingleClass(predictedLabels, minSamples=20, threshold=0.95):
    """
    Checks if a model's recent predictions have collapsed into a single dominant class.

    Parameters:
        predictedLabels: Iterable of class label strings (e.g. ['up', 'down', 'neutral'])
        minSamples: Minimum number of samples required to evaluate health (default 20)
        threshold: Fraction required to flag single_class (default 0.95)

    Returns:
        dict: {
            "status": "ok" | "single_class" | "insufficient_data",
            "dominantClass": str or None,
            "dominantShare": float,
            "sampleSize": int,
        }
    """
    labelsList = list(predictedLabels)
    sampleSize = len(labelsList)

    if sampleSize < minSamples:
        dominantClass = None
        dominantShare = 0.0
        if sampleSize > 0:
            counts = Counter(labelsList)
            dominantClass, topCount = counts.most_common(1)[0]
            dominantShare = round(float(topCount) / sampleSize, 4)
        return {
            "status": "insufficient_data",
            "dominantClass": dominantClass,
            "dominantShare": dominantShare,
            "sampleSize": sampleSize,
        }

    counts = Counter(labelsList)
    dominantClass, topCount = counts.most_common(1)[0]
    dominantShare = round(float(topCount) / sampleSize, 4)

    if dominantShare >= threshold:
        status = "single_class"
    else:
        status = "ok"

    return {
        "status": status,
        "dominantClass": dominantClass,
        "dominantShare": dominantShare,
        "sampleSize": sampleSize,
    }
