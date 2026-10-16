"""
Module      : admin_service.py
Date        : 2026-08-30
Author      : Dhruv
Modification History:
    2026-08-30 - Initial version, Phase 3.
Synopsis:
    FR-7.1: manage the admin-curated tracked-asset list.
    FR-7.2: retrain schedule config — value storage only, no executor. An
    actual cron/Celery job reading this and retraining on a timer is real
    infrastructure work that the SPMP's 8-hour Phase 3 budget doesn't cover
    for a solo dev; recorded here as an explicit scope boundary, not a
    silently dropped requirement.
    FR-7.3: data source health — attempts a live price fetch per tracked
    asset and reports success/failure per source, so an Admin can see
    "yfinance is fine, Binance is failing" without digging through logs.

Functions:
    addTrackedAsset(dbSession, assetSymbol, assetType) -> TrackedAsset
    removeTrackedAsset(dbSession, trackedAssetId) -> bool
    listTrackedAssets(dbSession) -> list[TrackedAsset]
    getRetrainConfig(dbSession) -> AdminConfig
    setRetrainInterval(dbSession, intervalDays) -> AdminConfig
    checkDataSourceHealth(dbSession, priceFetcher=None) -> list[dict]

Globals accessed/modified: None.
"""

from datetime import datetime

from models import db, TrackedAsset, AdminConfig
import price_service


def addTrackedAsset(dbSession, assetSymbol, assetType):
    existing = dbSession.query(TrackedAsset).filter_by(assetSymbol=assetSymbol).first()
    if existing:
        return existing
    asset = TrackedAsset(assetSymbol=assetSymbol, assetType=assetType)
    dbSession.add(asset)
    dbSession.commit()
    return asset


def removeTrackedAsset(dbSession, trackedAssetId):
    asset = dbSession.query(TrackedAsset).filter_by(trackedAssetId=trackedAssetId).first()
    if asset is None:
        return False
    dbSession.delete(asset)
    dbSession.commit()
    return True


def listTrackedAssets(dbSession):
    return dbSession.query(TrackedAsset).all()


def getRetrainConfig(dbSession):
    config = dbSession.query(AdminConfig).first()
    if config is None:
        config = AdminConfig(retrainIntervalDays=1)
        dbSession.add(config)
        dbSession.commit()
    return config


def setRetrainInterval(dbSession, intervalDays):
    config = getRetrainConfig(dbSession)
    config.retrainIntervalDays = intervalDays
    config.updatedAt = datetime.utcnow()
    dbSession.commit()
    return config


import sentiment_service


def checkDataSourceHealth(dbSession, priceFetcher=None):
    """Attempts a live historical-price fetch for every tracked asset.
    priceFetcher injectable for testing (no network access needed), same
    DI pattern as price_service.py/portfolio_service.py."""
    fetcher = priceFetcher or price_service.getHistoricalPrices
    results = []
    for asset in listTrackedAssets(dbSession):
        try:
            priceDf = fetcher(asset.assetSymbol, asset.assetType, 5)
            status = "ok" if len(priceDf) > 0 else "empty_response"
        except Exception as fetchError:
            status = f"error: {fetchError}"

        sentimentSource = "newsapi" if asset.assetType == "stock" else "reddit"
        sentimentStatus = sentiment_service.getDataSourceStatus(sentimentSource)

        modelHealthFlags = []
        try:
            from model_health import checkSingleClass
            from models import Signal
            for mUsed in ["random_forest", "lstm"]:
                recentSig = (
                    dbSession.query(Signal)
                    .filter_by(assetSymbol=asset.assetSymbol, modelUsed=mUsed)
                    .order_by(Signal.generatedAt.desc())
                    .limit(60)
                    .all()
                )
                if recentSig:
                    preds = [s.predictedDirection for s in recentSig]
                    h = checkSingleClass(preds, minSamples=20, threshold=0.95)
                    if h["status"] == "single_class":
                        modelHealthFlags.append(f"{mUsed}: single_class ({h['dominantClass']} {int(h['dominantShare']*100)}%)")
                    else:
                        modelHealthFlags.append(f"{mUsed}: {h['status']}")
                else:
                    modelHealthFlags.append(f"{mUsed}: no_signals")
        except Exception:
            pass

        results.append({
            "assetSymbol": asset.assetSymbol,
            "assetType": asset.assetType,
            "source": "yfinance" if asset.assetType == "stock" else "binance",
            "status": status,
            "sentimentSource": sentimentSource,
            "sentimentStatus": sentimentStatus,
            "modelHealthFlags": modelHealthFlags,
            "checkedAt": datetime.utcnow().isoformat(),
        })
    return results

