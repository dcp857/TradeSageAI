"""
Module      : smoke_test_sentiment.py
Date        : 2026-10-14
Author      : TradeSage AI
Synopsis    :
    Validates sentiment service behavior per Task 1:
    1. Score is bounded within [-1.0, 1.0]
    2. Positive headlines score > 0, negative headlines score < 0
    3. Second call is served from SentimentCache with zero fetcher calls
    4. Fetchers that raise (e.g. timeout / connection error) return 0.0 and do not crash
    5. Data source degraded status is flagged
    6. No secret keys appear in git-tracked files and .env is untracked
    7. Demonstrates how sentiment feature appears in full signal engine output (Requirement e)
"""

import json
import os
import subprocess
import sys
from datetime import date
import numpy as np
import pandas as pd
from flask import Flask

import conftest
from models import db, User, SentimentCache, MODEL_BASELINE, MODEL_LSTM
import sentiment_service
import auth_service
from feature_pipeline import buildFeatureFrame, labelDirection
from signal_engine import trainRandomForestBaseline
from lstm_model import buildSequenceWindows, trainLstm, WINDOW_SIZE_DEFAULT
from signal_service import generateSignal

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
db.init_app(app)

with app.app_context():
    db.create_all()
    user = auth_service.registerUser(db.session, "sentiment_tester@example.com", "SecurePass123!")

    # -------------------------------------------------------------
    # 1. Boundedness: Score is strictly within [-1.0, 1.0]
    # -------------------------------------------------------------
    neutralTexts = ["Market trading volume normal", "Quarterly filings released"]
    scoreBounded = sentiment_service.getSentimentForAsset(
        "BOUND_TEST", "stock", date(2026, 1, 1), db.session,
        headlineFetcher=lambda s, d: neutralTexts,
    )
    assert -1.0 <= scoreBounded <= 1.0, f"Score out of range: {scoreBounded}"
    print(f"PASS: Boundedness [-1, 1] verified -> score = {scoreBounded:.3f}")

    # -------------------------------------------------------------
    # 2. Valence: Positive headlines score > 0, negative headlines score < 0
    # -------------------------------------------------------------
    positiveHeadlines = [
        "Company beats revenue expectations with massive profit surge",
        "Strong rally as analysts upgrade stock with bullish breakout",
    ]
    positiveScore = sentiment_service.getSentimentForAsset(
        "POS_TEST", "stock", date(2026, 1, 2), db.session,
        headlineFetcher=lambda s, d: positiveHeadlines,
    )
    assert positiveScore > 0, f"Expected positive score > 0, got {positiveScore}"
    print(f"PASS: Positive headlines score > 0 -> {positiveScore:.3f}")

    negativeHeadlines = [
        "Company crashes on devastating revenue miss and severe downgrade",
        "Selloff and recession fears cause panic plunge",
    ]
    negativeScore = sentiment_service.getSentimentForAsset(
        "NEG_TEST", "stock", date(2026, 1, 3), db.session,
        headlineFetcher=lambda s, d: negativeHeadlines,
    )
    assert negativeScore < 0, f"Expected negative score < 0, got {negativeScore}"
    print(f"PASS: Negative headlines score < 0 -> {negativeScore:.3f}")

    # -------------------------------------------------------------
    # 3. Caching: Second call is served from cache with zero fetcher calls
    # -------------------------------------------------------------
    fetchCounter = [0]
    def countedFetcher(sym, dt):
        fetchCounter[0] += 1
        return ["Stock rallies on bullish upgrade announcement"]

    cacheTestDate = date(2026, 1, 4)
    firstFetchScore = sentiment_service.getSentimentForAsset(
        "CACHE_ASSET", "stock", cacheTestDate, db.session,
        headlineFetcher=countedFetcher,
    )
    assert fetchCounter[0] == 1, f"Expected 1 call on first fetch, got {fetchCounter[0]}"

    secondFetchScore = sentiment_service.getSentimentForAsset(
        "CACHE_ASSET", "stock", cacheTestDate, db.session,
        headlineFetcher=countedFetcher,
    )
    assert fetchCounter[0] == 1, f"Expected zero additional fetcher calls on cache hit, got {fetchCounter[0]}"
    assert firstFetchScore == secondFetchScore, "Cached score mismatch"
    print(f"PASS: Cache hit served with 0 network/fetcher calls -> score = {secondFetchScore:.3f}")

    # -------------------------------------------------------------
    # 4. Graceful failure: Fetcher that raises returns 0.0 and does not crash
    # -------------------------------------------------------------
    def failingFetcher(sym, dt):
        raise TimeoutError("Simulated 8-second network timeout to live feed")

    failScore = sentiment_service.getSentimentForAsset(
        "FAIL_ASSET", "stock", date(2026, 1, 5), db.session,
        headlineFetcher=failingFetcher,
    )
    assert failScore == 0.0, f"Expected 0.0 neutral on error, got {failScore}"
    assert "degraded" in sentiment_service.getDataSourceStatus("newsapi"), "Status not flagged degraded"
    print("PASS: Fetcher exception handled gracefully -> returned 0.0 without crash, status flagged degraded")

    # -------------------------------------------------------------
    # 5. Security: No secret key strings appear in git-tracked files
    # -------------------------------------------------------------
    repoRoot = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    # Verify .env is ignored and not tracked
    trackedFiles = subprocess.check_output(["git", "ls-files"], cwd=repoRoot, text=True).splitlines()
    assert ".env" not in trackedFiles, "CRITICAL SECURITY RISK: .env is tracked in git!"
    assert "backend/.env" not in trackedFiles, "CRITICAL SECURITY RISK: backend/.env is tracked in git!"

    # Grep check for forbidden hardcoded secrets pattern in tracked files
    secretPatterns = ["NEWSAPI_KEY=[a-zA-Z0-9]{10,}", "REDDIT_CLIENT_SECRET=[a-zA-Z0-9]{10,}"]
    for pat in secretPatterns:
        result = subprocess.run(
            ["git", "grep", "-E", pat],
            cwd=repoRoot,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert result.returncode != 0, f"Security violation: Secret pattern {pat} found in tracked files!"
    print("PASS: Security check passed — no API secrets exist in any tracked git files")

    # -------------------------------------------------------------
    # 6. Requirement e: Live Signal integration with sentiment feature
    # -------------------------------------------------------------
    np.random.seed(42)
    dates = pd.bdate_range("2025-01-01", periods=250)
    closes = 100 * np.cumprod(1 + np.random.normal(0.0003, 0.012, len(dates)))
    volumes = np.random.randint(1_000_000, 5_000_000, len(dates))
    priceDf = pd.DataFrame({"close": closes, "volume": volumes}, index=dates)

    featureFrame = buildFeatureFrame(priceDf)
    labels = labelDirection(priceDf["close"])
    featureFrameWithSentiment = featureFrame.copy()
    featureFrameWithSentiment["sentiment"] = positiveScore

    rfModel = trainRandomForestBaseline(featureFrameWithSentiment, labels)
    sequences, seqLabels = buildSequenceWindows(featureFrameWithSentiment, labels, WINDOW_SIZE_DEFAULT)
    lstmModel = trainLstm(sequences, seqLabels, classNames=["down", "neutral", "up"], epochs=2)

    rfBackground = featureFrameWithSentiment.tail(80).values[:60]
    lstmBackground = sequences[-30:]

    signalRows = generateSignal(
        db.session, user.userId, "AAPL", "stock", priceDf,
        sentimentScore=positiveScore,
        rfModel=rfModel, rfBackground=rfBackground,
        lstmModel=lstmModel, lstmBackground=lstmBackground,
        featureNames=list(featureFrame.columns),
    )

    print("\n--- REQUIREMENT (e): Signal Output with Non-Neutral Sentiment Feature ---")
    print(f"Injected Positive Sentiment Score: {positiveScore:.4f}")
    assert len(signalRows) == 2, "Expected 2 signal rows (RF baseline + LSTM)"
    for row in signalRows:
        explanation = json.loads(row.topContributingFeatures)
        print(f"Model: {row.modelUsed:<15} | Predicted: {row.predictedDirection:<7} | Confidence: {row.confidenceScore:.3f}")
        print(f"  Top SHAP Contributing Features: {explanation}")
        sentimentInFeatures = any(f.get("feature") == "sentiment" for f in explanation)
        print(f"  -> 'sentiment' feature represented in SHAP breakdown: {sentimentInFeatures}")

print("\nALL SENTIMENT SMOKE TESTS PASSED")
