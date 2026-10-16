"""
Module      : signal_service.py
Date        : 2026-08-07
Author      : Dhruv
Modification History:
    2026-08-07 - Recreated (rebuild session). Implements FR-3.3-3.5 as the
                 orchestration layer over signal_engine.py (baseline),
                 lstm_model.py, feature_pipeline.py, sentiment_service.py,
                 and explainability_service.py.
Synopsis:
    Ties the full Signal Engine together: builds the feature set for an
    asset (technical + sentiment), runs the RandomForest baseline and LSTM
    on the same features, and persists one Signal row per model (FR-3.3's
    "shown side by side" requirement -> two rows, not one row with two
    columns, so the dashboard's feedback loop in FR-6.2 can compare either
    model's history against actual outcomes independently).

    Each Signal row's topContributingFeatures is populated via
    explainability_service.getTopContributingFeatures (SHAP), replacing the
    earlier permutation-importance placeholder.

Functions:
    generateSignal(dbSession, userId, assetSymbol, assetType, priceDf,
                    sentimentScore, rfModel, rfBackground, lstmModel,
                    lstmBackground, featureNames, horizonDays)
        -> list[Signal]  (two persisted rows: baseline + LSTM)

        priceDf must already cover enough history to build both the
        instantaneous feature row (for RF) and the last windowSize rows
        (for LSTM) — building that history is the caller's/app.py's job,
        not this module's, to keep this module free of I/O concerns beyond
        the DB session it's given.

Globals accessed/modified: None.
"""

import json

from feature_pipeline import buildFeatureFrame
from lstm_model import WINDOW_SIZE_DEFAULT
from lstm_model import predictDirection as predictLstmDirection
from signal_engine import predictDirection as predictRfDirection
from explainability_service import getTopContributingFeatures
from models import Signal, MODEL_BASELINE, MODEL_LSTM

CLASS_NAMES = ["down", "neutral", "up"]  # fixed order shared by both models' explainer calls


def generateSignal(dbSession, userId, assetSymbol, assetType, priceDf,
                    sentimentScore=None, rfModel=None, rfBackground=None,
                    lstmModel=None, lstmBackground=None, featureNames=None,
                    horizonDays=3):
    featureFrame = buildFeatureFrame(priceDf)
    allFeatureNames = list(featureFrame.columns)


    latestFeatureRow = featureFrame.iloc[-1].values
    latestSequence = featureFrame.tail(WINDOW_SIZE_DEFAULT).values

    signalRows = []

    # --- Baseline (RandomForest) ---
    rfPrediction = predictRfDirection(rfModel, latestFeatureRow)
    rfExplanation = getTopContributingFeatures(
        MODEL_BASELINE, rfModel, rfBackground, latestFeatureRow,
        allFeatureNames, rfPrediction["classIndex"],
    )
    signalRows.append(_buildSignalRow(
        userId, assetSymbol, assetType, horizonDays, MODEL_BASELINE,
        rfPrediction, rfExplanation, latestFeatureRow, allFeatureNames,
    ))

    # --- LSTM ---
    if latestSequence.shape[0] == WINDOW_SIZE_DEFAULT:
        lstmPrediction = predictLstmDirection(lstmModel, latestSequence, CLASS_NAMES)
        lstmExplanation = getTopContributingFeatures(
            MODEL_LSTM, lstmModel, lstmBackground, latestSequence,
            allFeatureNames, lstmPrediction["classIndex"],
        )
        signalRows.append(_buildSignalRow(
            userId, assetSymbol, assetType, horizonDays, MODEL_LSTM,
            lstmPrediction, lstmExplanation, latestFeatureRow, allFeatureNames,
        ))
    # else: not enough history yet for a full 20-day window — baseline-only
    # signal is still valid and persisted; this is a normal early-history
    # state, not an error.

    for row in signalRows:
        dbSession.add(row)
    dbSession.commit()
    return signalRows


def _buildSignalRow(userId, assetSymbol, assetType, horizonDays, modelUsed,
                     prediction, explanation, featureRow, featureNames):
    return Signal(
        userId=userId,
        assetSymbol=assetSymbol,
        assetType=assetType,
        horizonDays=horizonDays,
        modelUsed=modelUsed,
        predictedDirection=prediction["direction"],
        confidenceScore=prediction["confidence"],
        topContributingFeatures=json.dumps(explanation),
        featureSnapshot=json.dumps(dict(zip(featureNames, [float(v) for v in featureRow]))),
    )
