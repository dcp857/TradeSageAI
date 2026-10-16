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
    # 6. Task 1e: Decoupled News Mood & 4-Feature Models
    # -------------------------------------------------------------
    np.random.seed(42)
    dates = pd.bdate_range("2025-01-01", periods=250)
    closes = 100 * np.cumprod(1 + np.random.normal(0.0003, 0.012, len(dates)))
    volumes = np.random.randint(1_000_000, 5_000_000, len(dates))
    priceDf = pd.DataFrame({"close": closes, "volume": volumes}, index=dates)

    featureFrame = buildFeatureFrame(priceDf)
    labels = labelDirection(priceDf["close"])

    # Assertion: feature frame uses 4 technical features, 'sentiment' does NOT appear
    assert featureFrame.shape[1] == 4, f"Expected 4 features, got {featureFrame.shape[1]}"
    assert set(featureFrame.columns) == {"rsi", "macd", "sma", "volumeChange"}
    assert "sentiment" not in featureFrame.columns

    rfModel = trainRandomForestBaseline(featureFrame, labels)
    sequences, seqLabels = buildSequenceWindows(featureFrame, labels, WINDOW_SIZE_DEFAULT)
    assert sequences.shape[2] == 4, f"Expected sequence shape with 4 features, got {sequences.shape[2]}"

    lstmModel = trainLstm(sequences, seqLabels, classNames=["down", "neutral", "up"], epochs=2)

    rfBackground = featureFrame.tail(80).values[:60]
    lstmBackground = sequences[-30:]

    signalRows = generateSignal(
        db.session, user.userId, "AAPL", "stock", priceDf,
        rfModel=rfModel, rfBackground=rfBackground,
        lstmModel=lstmModel, lstmBackground=lstmBackground,
        featureNames=list(featureFrame.columns),
    )

    print("\n--- TASK 1e VERIFICATION: Technical-Only Models + newsMood Decoupling ---")
    assert len(signalRows) == 2, "Expected 2 signal rows (RF baseline + LSTM)"
    for row in signalRows:
        explanation = json.loads(row.topContributingFeatures)
        print(f"Model: {row.modelUsed:<15} | Predicted: {row.predictedDirection:<7} | Confidence: {row.confidenceScore:.3f}")
        print(f"  Top SHAP Contributing Features: {explanation}")
        sentimentInFeatures = any(f.get("feature") == "sentiment" for f in explanation)
        assert not sentimentInFeatures, f"'sentiment' unexpectedly found in SHAP explanation for {row.modelUsed}"
        print(f"  -> 'sentiment' absent from SHAP breakdown: True")

    # Verify /api/signal returns newsMood with valid label and degraded status when keys unset
    from app import create_app
    testApp = create_app({"SQLALCHEMY_DATABASE_URI": "sqlite:///:memory:", "TESTING": True})
    with testApp.app_context():
        db.create_all()
        tUser = auth_service.registerUser(db.session, "api_tester@example.com", "SecurePass123!")
        client = testApp.test_client()
        loginResp = client.post("/api/login", json={"email": "api_tester@example.com", "password": "SecurePass123!"})
        assert loginResp.status_code == 200

        # Inject fake price to avoid external network during unit smoke test
        import price_service
        origGetPrices = price_service.getHistoricalPrices
        price_service.getHistoricalPrices = lambda *a, **k: priceDf.copy()
        try:
            sigResp = client.get("/api/signal?assetSymbol=AAPL&assetType=stock")
            assert sigResp.status_code == 200, sigResp.get_data(as_text=True)
            sigJson = sigResp.get_json()

            assert "newsMood" in sigJson, "newsMood field missing from /api/signal"
            mood = sigJson["newsMood"]
            assert -1.0 <= mood["score"] <= 1.0, f"Mood score out of bounds: {mood['score']}"
            assert mood["label"] in {"positive", "neutral", "negative"}, f"Invalid mood label: {mood['label']}"
            assert mood["status"].startswith("degraded"), f"Expected degraded status without API key, got: {mood['status']}"
            print(f"PASS: /api/signal returns newsMood: {mood}")

            # Verify no model signal contains 'sentiment' in features
            for sig in sigJson["signals"]:
                featNames = [f.get("feature") for f in sig.get("topContributingFeatures", [])]
                assert "sentiment" not in featNames, f"'sentiment' found in API signal features: {featNames}"
            print("PASS: Verified 'sentiment' is absent from all API signal explanations")
        finally:
            price_service.getHistoricalPrices = origGetPrices

print("\nALL SENTIMENT SMOKE TESTS PASSED")

