"""
Module      : retrain_scheduler.py
Date        : 2026-09-20
Author      : Dhruv
Modification History:
    2026-09-21 - [Fix #4] Added logging throughout so per-asset retrain
                 failures and scheduler loop errors are visible in the
                 server log instead of being silently swallowed.
Synopsis:
    Lightweight background daemon thread for automated ML model retraining (FR-7.2).
    Checks AdminConfig.retrainIntervalDays periodically and triggers retraining
    for all tracked assets in tbl_TrackedAsset.
"""

import logging
import threading
import time
from datetime import date, datetime, timedelta

logger = logging.getLogger(__name__)


def runRetrainTask(app, getOrTrainFunc, modelCache):
    """Executes a single retrain sweep across all tracked assets."""
    with app.app_context():
        from models import db, TrackedAsset, AdminConfig
        import admin_service
        import price_service
        import sentiment_service

        config = admin_service.getRetrainConfig(db.session)
        now = datetime.utcnow()
        intervalDays = config.retrainIntervalDays or 1

        # Only retrain if due based on config.updatedAt
        if config.updatedAt and (now - config.updatedAt) < timedelta(days=intervalDays):
            return {"status": "skipped", "reason": "not_due"}

        tracked = admin_service.listTrackedAssets(db.session)
        if not tracked:
            return {"status": "skipped", "reason": "no_tracked_assets"}

        from app import MODEL_FEATURE_VERSION
        retrainedSymbols = []
        for asset in tracked:
            try:
                cacheKey = (MODEL_FEATURE_VERSION, asset.assetSymbol, date.today().isoformat())
                if cacheKey in modelCache:
                    del modelCache[cacheKey]

                priceDf = price_service.getHistoricalPrices(asset.assetSymbol, asset.assetType)
                getOrTrainFunc(asset.assetSymbol, priceDf)
                retrainedSymbols.append(asset.assetSymbol)

                logger.info("Scheduler retrained %s successfully.", asset.assetSymbol)
            except Exception as exc:
                # Fix #4: log the full traceback so failures are diagnosable
                # from the server log rather than disappearing silently.
                logger.exception(
                    "Scheduler failed to retrain %s: %s", asset.assetSymbol, exc
                )

        config.updatedAt = datetime.utcnow()
        db.session.commit()
        return {"status": "success", "retrained": retrainedSymbols}


def startScheduler(app, getOrTrainFunc, modelCache, checkIntervalSec=3600):
    """Starts the background retrain worker daemon thread."""
    def _loop():
        # Initial wait so app finishes binding
        time.sleep(5)
        while True:
            try:
                runRetrainTask(app, getOrTrainFunc, modelCache)
            except Exception as exc:
                # Fix #4: catch unexpected errors in the outer loop too so
                # the scheduler thread stays alive but the error is logged.
                logger.exception("Retrain scheduler loop error: %s", exc)
            time.sleep(checkIntervalSec)

    worker = threading.Thread(target=_loop, daemon=True, name="TradeSage-RetrainWorker")
    worker.start()
    return worker
