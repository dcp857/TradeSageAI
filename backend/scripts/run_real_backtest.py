"""
================================================================================
PRE-DECLARED EXPERIMENTAL PROTOCOL (Locked before execution):
- Assets            : BTC (crypto) and AAPL (stock)
- Data Frequency    : Daily close & volume
- Minimum History   : At least 3 years (>= 1,095 calendar days; lookback = 1,150)
- Train/Test Split  : Earlier 70% history for training, later 30% for walk-forward evaluation
- Trade Horizon     : 3 days (holding period per FR-3.3)
- Neutral Band      : 0.5% (0.005 forward return threshold for noise filtering)
- Execution Policy  : Non-overlapping trades, mark-to-market daily equity curve
- Integrity Rule    : No parameter or date tuning after seeing results. Weak results
                      are reported as-is without alteration. Never report raw accuracy.
================================================================================
"""

import os
import sys
from datetime import datetime
import numpy as np
import pandas as pd

# Ensure backend root is on sys.path
backendDir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backendDir not in sys.path:
    sys.path.insert(0, backendDir)

import price_service
import feature_pipeline
import signal_engine
import backtesting_service

try:
    import torch
    import lstm_model
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False

CLASS_NAMES = ["down", "neutral", "up"]

# ----------------------------------------------------------------------
# PRE-DECLARED HYPERPARAMETERS & ASSET CONFIGURATION
# ----------------------------------------------------------------------
PRE_DECLARED_ASSETS = [
    {"symbol": "BTC", "type": "crypto", "name": "Bitcoin"},
    {"symbol": "AAPL", "type": "stock", "name": "Apple Inc."},
]
DATA_FREQUENCY = "Daily"
LOOKBACK_DAYS = 1150      # >= 3 years of daily history
TRAIN_RATIO = 0.70        # Earlier 70%
TEST_RATIO = 0.30         # Later 30% walk-forward
HORIZON_DAYS = 3          # 3-day decision horizon
NEUTRAL_BAND_PCT = 0.005  # 0.5% neutral filter


def evaluateAsset(assetConfig, logLines):
    sym = assetConfig["symbol"]
    typ = assetConfig["type"]
    name = assetConfig["name"]

    logLines.append("=" * 78)
    logLines.append(f"ASSET: {sym} ({name}) | Market Type: {typ.upper()}")
    logLines.append("=" * 78)

    # 1. Fetch real historical prices via existing price_service
    try:
        priceDf = price_service.getHistoricalPrices(sym, typ, lookbackDays=LOOKBACK_DAYS)
    except Exception as e:
        logLines.append(f"ERROR: Failed to fetch historical prices for {sym}: {e}\n")
        return

    if len(priceDf) < 250:
        logLines.append(f"ERROR: Insufficient price history returned ({len(priceDf)} rows). Need at least 250 bars.\n")
        return

    fullStart = priceDf.index[0].strftime("%Y-%m-%d")
    fullEnd = priceDf.index[-1].strftime("%Y-%m-%d")
    totalBars = len(priceDf)
    calendarDays = (priceDf.index[-1] - priceDf.index[0]).days

    logLines.append(f"Full Dataset Range : {fullStart} to {fullEnd} ({totalBars} bars, ~{calendarDays} calendar days)")

    # 2. Extract technical features & labels
    featureFrame = feature_pipeline.buildFeatureFrame(priceDf)
    featureFrame["sentiment"] = 0.0  # neutral sentiment baseline over historical horizon
    labels = feature_pipeline.labelDirection(priceDf["close"], horizonDays=HORIZON_DAYS, neutralBandPct=NEUTRAL_BAND_PCT)

    # Align indexes
    commonIdx = featureFrame.index.intersection(labels.index)
    featureFrame = featureFrame.loc[commonIdx]
    labels = labels.loc[commonIdx]
    priceSeries = priceDf["close"].loc[commonIdx]

    totalCleanBars = len(featureFrame)
    splitIdx = int(totalCleanBars * TRAIN_RATIO)

    trainFeatures = featureFrame.iloc[:splitIdx]
    trainLabels = labels.iloc[:splitIdx]
    testFeatures = featureFrame.iloc[splitIdx:]
    testLabels = labels.iloc[splitIdx:]

    trainRange = f"{trainFeatures.index[0].strftime('%Y-%m-%d')} to {trainFeatures.index[-1].strftime('%Y-%m-%d')}"
    evalRange = f"{testFeatures.index[0].strftime('%Y-%m-%d')} to {testFeatures.index[-1].strftime('%Y-%m-%d')}"

    logLines.append(f"Training Set (70%) : {trainRange} ({len(trainFeatures)} bars)")
    logLines.append(f"Evaluation (30%)   : {evalRange} ({len(testFeatures)} bars)")
    logLines.append("-" * 78)

    # 3. Model 1: Random Forest Baseline
    logLines.append("MODEL: Scikit-Learn Random Forest Baseline")
    rfModel = signal_engine.trainRandomForestBaseline(trainFeatures, trainLabels)

    rfPredictions = []
    for i in range(len(testFeatures)):
        featRow = testFeatures.iloc[i].values
        pred = signal_engine.predictDirection(rfModel, featRow)
        rfPredictions.append(pred["direction"])

    rfSignalSeries = pd.Series(rfPredictions, index=testFeatures.index)
    rfMetrics = backtesting_service.runBacktest(priceSeries, rfSignalSeries, horizonDays=HORIZON_DAYS)

    logLines.append(f"  Evaluation Window : {evalRange}")
    logLines.append(f"  Total Trades      : {rfMetrics['totalTrades']}")
    if rfMetrics["totalTrades"] < 10:
        logLines.append("  Result Status     : INSUFFICIENT TRADES, do not interpret")
    else:
        logLines.append(f"  Sharpe Ratio      : {rfMetrics['sharpeRatio']:.2f}")
        logLines.append(f"  Win Rate          : {rfMetrics['winRate'] * 100:.1f}%")
        logLines.append(f"  Max Drawdown      : {rfMetrics['maxDrawdown'] * 100:.1f}%")
    logLines.append("")

    # 4. Model 2: PyTorch Shallow LSTM (if torch available)
    if TORCH_AVAILABLE:
        logLines.append("MODEL: PyTorch Shallow LSTM (1-layer, 32 hidden units)")
        try:
            windowSize = lstm_model.WINDOW_SIZE_DEFAULT
            # Build training sequences
            trainSeqs, trainSeqLabels = lstm_model.buildSequenceWindows(
                trainFeatures, trainLabels, windowSize=windowSize
            )
            lstm = lstm_model.trainLstm(
                trainSeqs, trainSeqLabels, classNames=CLASS_NAMES, epochs=8, hiddenSize=32
            )

            # Walk-forward evaluate on testFeatures using lookback windows
            lstmPredictions = []
            for i in range(len(testFeatures)):
                currentIdxInFull = splitIdx + i
                if currentIdxInFull < windowSize - 1:
                    lstmPredictions.append("neutral")
                    continue
                seq = featureFrame.iloc[currentIdxInFull - windowSize + 1 : currentIdxInFull + 1].values
                pred = lstm_model.predictDirection(lstm, seq, CLASS_NAMES)
                lstmPredictions.append(pred["direction"])

            lstmSignalSeries = pd.Series(lstmPredictions, index=testFeatures.index)
            lstmMetrics = backtesting_service.runBacktest(priceSeries, lstmSignalSeries, horizonDays=HORIZON_DAYS)

            logLines.append(f"  Evaluation Window : {evalRange}")
            logLines.append(f"  Total Trades      : {lstmMetrics['totalTrades']}")
            if lstmMetrics["totalTrades"] < 10:
                logLines.append("  Result Status     : INSUFFICIENT TRADES, do not interpret")
            else:
                logLines.append(f"  Sharpe Ratio      : {lstmMetrics['sharpeRatio']:.2f}")
                logLines.append(f"  Win Rate          : {lstmMetrics['winRate'] * 100:.1f}%")
                logLines.append(f"  Max Drawdown      : {lstmMetrics['maxDrawdown'] * 100:.1f}%")
        except Exception as lstmErr:
            logLines.append(f"  LSTM Execution Error: {lstmErr}")
    else:
        logLines.append("MODEL: PyTorch Shallow LSTM -> SKIPPED (PyTorch not installed in environment)")

    logLines.append("")


def main():
    logLines = []
    logLines.append("=" * 78)
    logLines.append("TRADESAGE AI - REAL-MARKET WALK-FORWARD BACKTEST EVIDENCE")
    logLines.append(f"Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logLines.append("=" * 78)
    logLines.append("Pre-declared parameters: 70/30 split, horizon=3d, neutral_band=0.5%, lookback=1150d")
    logLines.append("")

    for asset in PRE_DECLARED_ASSETS:
        evaluateAsset(asset, logLines)

    # Fixed mandatory disclaimer footer
    logLines.append("=" * 78)
    logLines.append("Historical simulation. No transaction costs or slippage modeled. "
                    "Short positions assume no borrowing cost. Not a guarantee of future performance.")
    logLines.append("=" * 78)

    fullOutput = "\n".join(logLines)
    print(fullOutput)

    # Save to last_real_backtest.txt
    outputPath = os.path.join(backendDir, "scripts", "last_real_backtest.txt")
    with open(outputPath, "w", encoding="utf-8") as f:
        f.write(fullOutput)
    print(f"\n[Artifact saved to {outputPath}]")


if __name__ == "__main__":
    main()
