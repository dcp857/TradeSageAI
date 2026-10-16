import numpy as np
import pandas as pd
from datetime import date, timedelta
from flask import Flask
import conftest
from models import db, User, Holding
import auth_service, portfolio_service, sentiment_service, price_service
from feature_pipeline import buildFeatureFrame, labelDirection
from signal_engine import trainRandomForestBaseline
from lstm_model import buildSequenceWindows, trainLstm, WINDOW_SIZE_DEFAULT
from signal_service import generateSignal
from models import MODEL_BASELINE, MODEL_LSTM

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
db.init_app(app)

with app.app_context():
    db.create_all()

    # --- auth ---
    user = auth_service.registerUser(db.session, "trader@example.com", "hunter2pass")
    assert auth_service.verifyLogin(db.session, "trader@example.com", "hunter2pass") is not None
    assert auth_service.verifyLogin(db.session, "trader@example.com", "wrong") is None
    print("auth OK, userId =", user.userId)

    # --- portfolio: manual add + CSV import (with a deliberately bad row) ---
    portfolio_service.addHolding(db.session, user.userId, "aapl", "stock", 10, 150.0, date(2025, 1, 5))
    csvContent = b"assetSymbol,assetType,quantity,buyPrice,buyDate\nBTC,crypto,0.1,40000,2025-02-01\nBAD,stock,notanumber,100,2025-01-01\n"
    import io
    importResult = portfolio_service.importHoldingsFromCsv(db.session, user.userId, io.BytesIO(csvContent))
    print("CSV import:", importResult)
    assert importResult["imported"] == 1
    assert len(importResult["errors"]) == 1

    def fakeStockPrice(symbol): return 160.0
    def fakeCryptoPrice(symbol): return 42000.0
    pnl = portfolio_service.getPortfolioPnl(db.session, user.userId, fakeStockPrice, fakeCryptoPrice)
    print("Portfolio P&L:", pnl["totalPnl"])
    assert isinstance(pnl["totalPnl"], float)

    # --- sentiment (mocked fetchers, no live network) ---
    def fakeHeadlines(symbol, d): return ["Stock rallies on bullish outlook", "Analysts upgrade rating"]
    score = sentiment_service.getSentimentForAsset("AAPL", "stock", date(2025, 1, 5), db.session, headlineFetcher=fakeHeadlines)
    print("Sentiment score (finance lexicon applied):", score)
    assert score > 0  # "rallies", "bullish", "upgrade" should push this positive
    # cache hit path
    score2 = sentiment_service.getSentimentForAsset("AAPL", "stock", date(2025, 1, 5), db.session, headlineFetcher=fakeHeadlines)
    assert score == score2

    # --- price service cache immutability check ---
    def fakeStockHistory(sym, lookback):
        d = pd.bdate_range("2025-01-01", periods=10)
        return pd.DataFrame({"close": [100.0]*10, "volume": [1000]*10}, index=d)

    origStockFetcher = price_service._defaultStockHistoryFetcher
    try:
        price_service._defaultStockHistoryFetcher = fakeStockHistory
        df1 = price_service.getHistoricalPrices("IMMUTABLE_TEST", "stock")
        df1["close"] = 999.9  # mutate returned dataframe
        df1["mutated_column"] = True

        df2 = price_service.getHistoricalPrices("IMMUTABLE_TEST", "stock")
        assert df2["close"].iloc[0] == 100.0, "Cache was mutated by downstream modification!"
        assert "mutated_column" not in df2.columns, "Mutated column leaked into cached DataFrame!"
        print("price_service cache immutability verified OK")
    finally:
        price_service._defaultStockHistoryFetcher = origStockFetcher

    # --- feature pipeline + labels on synthetic price history ---
    np.random.seed(1)
    dates = pd.bdate_range("2025-01-01", periods=250)
    closes = 100 * np.cumprod(1 + np.random.normal(0.0003, 0.012, len(dates)))
    volumes = np.random.randint(1_000_000, 5_000_000, len(dates))
    priceDf = pd.DataFrame({"close": closes, "volume": volumes}, index=dates)

    featureFrame = buildFeatureFrame(priceDf)
    labels = labelDirection(priceDf["close"])
    print("Feature frame shape:", featureFrame.shape)
    assert set(featureFrame.columns) == {"rsi", "macd", "sma", "volumeChange"}

    # --- train both models (technical features only per Task 1) ---
    assert set(featureFrame.columns) == {"rsi", "macd", "sma", "volumeChange"}
    assert len(featureFrame.columns) == 4
    rfModel = trainRandomForestBaseline(featureFrame, labels)
    print("RF trained, classes:", rfModel.classes_)

    sequences, seqLabels = buildSequenceWindows(featureFrame, labels, WINDOW_SIZE_DEFAULT)
    print("LSTM sequences:", sequences.shape, "labels:", seqLabels.shape)
    assert sequences.shape[2] == 4, f"Expected 4 features, got {sequences.shape[2]}"
    lstmModel = trainLstm(sequences, seqLabels, classNames=["down", "neutral", "up"], epochs=3)
    print("LSTM trained OK")

    # --- full orchestrated signal generation (RF + LSTM + SHAP, persisted) ---
    rfBackground = featureFrame.tail(80).values[:60]
    lstmBackground = sequences[-30:]
    rows = generateSignal(
        db.session, user.userId, "AAPL", "stock", priceDf,
        rfModel=rfModel, rfBackground=rfBackground,
        lstmModel=lstmModel, lstmBackground=lstmBackground,
        featureNames=list(featureFrame.columns),
    )
    print(f"Signals persisted: {len(rows)}")
    assert len(rows) == 2
    modelsUsed = {r.modelUsed for r in rows}
    assert modelsUsed == {MODEL_BASELINE, MODEL_LSTM}
    for r in rows:
        import json
        explanation = json.loads(r.topContributingFeatures)
        print(f"  {r.modelUsed}: direction={r.predictedDirection} conf={r.confidenceScore:.3f} top={explanation[:2]}")
        featuresInExpl = [f.get("feature") for f in explanation]
        assert "sentiment" not in featuresInExpl, f"'sentiment' found in feature attribution: {featuresInExpl}"
        assert len(explanation) > 0

    print("PASS: smoke_test_full verified (4 features, no sentiment in model features)")

print("\nFULL PIPELINE SMOKE TEST PASSED")

