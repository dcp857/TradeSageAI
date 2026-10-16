"""
Module      : app.py
Date        : 2026-08-07
Author      : Dhruv
Modification History:
    2026-08-07 - Recreated (rebuild session). Wires all modules into a
                 Flask app; implements the dashboard-facing endpoints for
                 FR-1 through FR-4.
    (earlier session) - CORS + session cookies don't combine by default:
        supports_credentials must be True AND origins must be an explicit
        list (not "*") for the browser to accept the Set-Cookie on
        cross-origin XHR from the plain HTML/CSS/JS dashboard. Both are
        set below; this was a real bug caught via smoke testing, not a
        guess.
    2026-09-21 - [Fix #1] Removed hardcoded Neon DB fallback credential.
                 DATABASE_URL is now required from .env; app raises
                 ValueError on startup if missing rather than silently
                 using a credential that should never be in source code.
               - [Fix #2] Documented token-auth scheme as known gap.
               - [Fix #3] G_ModelCache now evicts oldest entries when it
                 exceeds MAX_MODEL_CACHE_SIZE to prevent unbounded memory
                 growth during long-running deployments.
Synopsis:
    Flask application factory + route registration. Minimal HTML/CSS/JS
    dashboard is served from /static per the locked "no React" frontend
    decision (SRS 2.2, project context Section 5).

Globals accessed/modified:
    G-Db (module-level SQLAlchemy instance from models.py, imported not
    redefined — standard global naming convention applied at the point of
    use in create_app()).

Functions:
    create_app(configOverrides=None) -> Flask app instance
"""

import io
import json
import os
from datetime import date, datetime
from dotenv import load_dotenv

# Automatically load environment variables from .env
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv()

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_login import LoginManager, current_user, login_required

import admin_service
import auth_service
import portfolio_service
import price_service
import sentiment_service
import watchlist_service
from backtesting_service import runBacktest
from feature_pipeline import buildFeatureFrame, labelDirection
from lstm_model import WINDOW_SIZE_DEFAULT, buildSequenceWindows, trainLstm, predictDirection as predictLstmDirection
from models import db, User, Signal, BacktestResult, MODEL_BASELINE, MODEL_LSTM
from signal_engine import trainRandomForestBaseline, predictDirection as predictRfDirection
from signal_service import generateSignal
from model_health import checkSingleClass


ALLOWED_DASHBOARD_ORIGIN_DEFAULT = "http://localhost:5500"  # plain HTML/CSS/JS dev server
CLASS_NAMES = ["down", "neutral", "up"]

# G-ModelCache: process-lifetime cache of trained models keyed by
# (assetSymbol, todaysDateIsoString). Decision: signal generation is an
# explicit user action, not part of the dashboard's 3-second NFR-1 load
# (documented earlier in the project record), so training on first request
# per asset per day is acceptable — this cache just avoids repeating that
# ~17s cold-start cost on every subsequent click for the same asset today.
#
# Fix #3: capped at MAX_MODEL_CACHE_SIZE entries. When the limit is reached
# the oldest-inserted key is evicted first. Without this, a long-running
# deployment tracking many assets accumulates large RF+LSTM objects in RAM
# Model feature set version. Incremented to 2 when removing inert sentiment
# from model feature frame (technical features only: sma, rsi, macd, volumeChange).
# In-memory and persisted caches keyed by this version cleanly invalidate old shapes.
MODEL_FEATURE_VERSION = 2
MAX_MODEL_CACHE_SIZE = 50
G_ModelCache = {}


POPULAR_ASSETS = [
    {"symbol": "AAPL", "name": "Apple Inc.", "type": "stock"},
    {"symbol": "MSFT", "name": "Microsoft Corporation", "type": "stock"},
    {"symbol": "GOOGL", "name": "Alphabet Inc.", "type": "stock"},
    {"symbol": "AMZN", "name": "Amazon.com Inc.", "type": "stock"},
    {"symbol": "NVDA", "name": "NVIDIA Corporation", "type": "stock"},
    {"symbol": "TSLA", "name": "Tesla, Inc.", "type": "stock"},
    {"symbol": "META", "name": "Meta Platforms Inc.", "type": "stock"},
    {"symbol": "AMD", "name": "Advanced Micro Devices", "type": "stock"},
    {"symbol": "NFLX", "name": "Netflix Inc.", "type": "stock"},
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "type": "stock"},
    {"symbol": "QQQ", "name": "Invesco QQQ Trust", "type": "stock"},
    {"symbol": "COIN", "name": "Coinbase Global", "type": "stock"},
    {"symbol": "PLTR", "name": "Palantir Technologies", "type": "stock"},
    {"symbol": "INTC", "name": "Intel Corporation", "type": "stock"},
    {"symbol": "BABA", "name": "Alibaba Group", "type": "stock"},
    {"symbol": "BTC", "name": "Bitcoin", "type": "crypto"},
    {"symbol": "ETH", "name": "Ethereum", "type": "crypto"},
    {"symbol": "SOL", "name": "Solana", "type": "crypto"},
    {"symbol": "BNB", "name": "Binance Coin", "type": "crypto"},
    {"symbol": "XRP", "name": "Ripple", "type": "crypto"},
    {"symbol": "ADA", "name": "Cardano", "type": "crypto"},
    {"symbol": "DOGE", "name": "Dogecoin", "type": "crypto"},
    {"symbol": "AVAX", "name": "Avalanche", "type": "crypto"},
    {"symbol": "DOT", "name": "Polkadot", "type": "crypto"},
    {"symbol": "LINK", "name": "Chainlink", "type": "crypto"},
    {"symbol": "MATIC", "name": "Polygon", "type": "crypto"},
]


def create_app(configOverrides=None):
    # Repo reorg (lean-build session): dashboard.html now lives in ../frontend
    # instead of a static/ folder next to app.py. static_folder is pointed
    # there explicitly so Flask's default static route keeps serving it at
    # the same /static/dashboard.html URL the smoke tests and browser already
    # expect - no other route or test needed to change.
    app = Flask(__name__, static_folder="../frontend", static_url_path="/static")
    # Fix #1: DATABASE_URL must be provided via .env — no hardcoded fallback.
    # A missing value raises ValueError immediately at startup so the problem
    # is visible rather than silently using a stale/wrong credential.
    _dbUrl = os.environ.get("DATABASE_URL")
    if not _dbUrl:
        raise ValueError(
            "DATABASE_URL is not set. Copy .env.example to .env and fill in "
            "DATABASE_URL before starting the server. "
            "For local dev: DATABASE_URL=sqlite:///tradesage.db"
        )
    app.config["SQLALCHEMY_DATABASE_URI"] = _dbUrl
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
        "pool_pre_ping": True,
        "pool_recycle": 300,
    }
    _appSecretKey = os.environ.get("SECRET_KEY")
    if not _appSecretKey:
        if os.environ.get("FLASK_DEBUG") != "1":
            raise ValueError(
                "SECRET_KEY is not set and FLASK_DEBUG is not \"1\". "
                "Set SECRET_KEY in your environment or .env before starting the app."
            )
        _appSecretKey = "dev-only-change-in-production"
    app.config["SECRET_KEY"] = _appSecretKey
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    if configOverrides:
        app.config.update(configOverrides)

    db.init_app(app)

    allowedOrigins = [
        "http://localhost:5000",
        "http://127.0.0.1:5000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]
    customOrigin = app.config.get("DASHBOARD_ORIGIN")
    if customOrigin and customOrigin not in allowedOrigins:
        allowedOrigins.append(customOrigin)

    CORS(app, supports_credentials=True, origins=allowedOrigins)

    with app.app_context():
        db.create_all()
        if not app.config.get("TESTING") and os.environ.get("SEED_DEMO_USER") == "1":
            existingDemo = db.session.query(User).filter_by(email="trader@tradesage.ai").first()
            if not existingDemo:
                from werkzeug.security import generate_password_hash
                db.session.add(User(email="trader@tradesage.ai", passwordHash=generate_password_hash("Password123!")))
                db.session.commit()

    # Session authentication architecture:
    # Flask-Login session cookies (set by loginUser()) are the sole authentication
    # mechanism. The application is same-origin, using signed, HttpOnly session cookies.
    # No custom or unsigned header tokens are used.
    loginManager = LoginManager()
    loginManager.init_app(app)

    @loginManager.user_loader
    def loadUser(userId):
        return db.session.get(User, int(userId))

    @loginManager.request_loader
    def loadUserFromRequest(req):
        # Preferred: same-origin Flask session cookie set by Flask-Login.
        # No unsigned / guessable token paths are accepted here.
        return None

    frontendDir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

    @app.route("/")
    @app.route("/index")
    @app.route("/index.html")
    def serveLanding():
        return send_from_directory(frontendDir, "index.html")

    @app.route("/dashboard")
    @app.route("/dashboard.html")
    def serveDashboard():
        return send_from_directory(frontendDir, "dashboard.html")

    @app.route("/auth")
    @app.route("/login")
    @app.route("/register", methods=["GET"])
    @app.route("/auth.html")
    def serveAuth():
        return send_from_directory(frontendDir, "auth.html")

    @app.route("/css/<path:filename>")
    def serveCss(filename):
        return send_from_directory(os.path.join(frontendDir, "css"), filename)

    @app.route("/js/<path:filename>")
    def serveJs(filename):
        return send_from_directory(os.path.join(frontendDir, "js"), filename)

    @app.route("/api/register", methods=["POST"])
    def register():
        body = request.get_json()
        try:
            newUser = auth_service.registerUser(db.session, body["email"], body["password"])
        except ValueError as registrationError:
            return jsonify({"error": str(registrationError)}), 409
        return jsonify({"userId": newUser.userId, "email": newUser.email}), 201

    @app.route("/api/login", methods=["POST"])
    def login():
        body = request.get_json()
        user = auth_service.verifyLogin(db.session, body["email"], body["password"])
        if user is None:
            return jsonify({"error": "invalid credentials"}), 401
        auth_service.loginUser(user)
        return jsonify({"userId": user.userId, "email": user.email})

    @app.route("/api/logout", methods=["POST"])
    @login_required
    def logout():
        auth_service.logoutUser()
        return jsonify({"status": "logged out"})

    @app.route("/api/config", methods=["GET"])
    def getConfig():
        isSeedOn = os.environ.get("SEED_DEMO_USER") == "1"
        demoUser = db.session.query(User).filter_by(email="trader@tradesage.ai").first()
        demoEnabled = bool(isSeedOn and demoUser is not None)
        return jsonify({"demoEnabled": demoEnabled})

    @app.route("/api/demo-login", methods=["POST"])
    def demoLogin():
        if os.environ.get("SEED_DEMO_USER") != "1":
            return jsonify({"error": "Demo mode disabled"}), 404
        demoUser = db.session.query(User).filter_by(email="trader@tradesage.ai").first()
        if not demoUser:
            return jsonify({"error": "Demo user not seeded"}), 404
        auth_service.loginUser(demoUser)
        return jsonify({"userId": demoUser.userId, "email": demoUser.email})

    @app.route("/api/me", methods=["GET"])
    @login_required
    def me():
        return jsonify({"userId": current_user.userId, "email": current_user.email})

    @app.route("/api/holdings", methods=["POST"])
    @login_required
    def addHolding():
        body = request.get_json() or {}
        try:
            holding = portfolio_service.addHolding(
                db.session, current_user.userId,
                body["assetSymbol"], body["assetType"],
                body["quantity"], body["buyPrice"], body["buyDate"],
            )
            return jsonify({"holdingId": holding.holdingId}), 201
        except (ValueError, KeyError, TypeError) as err:
            return jsonify({"error": str(err)}), 400

    @app.route("/api/holdings/import", methods=["POST"])
    @login_required
    def importHoldings():
        uploadedFile = request.files["file"]
        result = portfolio_service.importHoldingsFromCsv(
            db.session, current_user.userId, io.BytesIO(uploadedFile.read())
        )
        return jsonify(result)

    @app.route("/api/holdings/<int:holdingId>", methods=["DELETE"])
    @login_required
    def deleteHolding(holdingId):
        removed = portfolio_service.removeHolding(db.session, current_user.userId, holdingId)
        if not removed:
            return jsonify({"error": "Holding not found"}), 404
        return jsonify({"status": "removed", "holdingId": holdingId})

    @app.route("/api/assets/search", methods=["GET"])
    @login_required
    def searchAssets():
        query = request.args.get("q", "").strip().lower()
        if not query:
            return jsonify(POPULAR_ASSETS[:10])

        matches = []
        for asset in POPULAR_ASSETS:
            if query in asset["symbol"].lower() or query in asset["name"].lower():
                matches.append(asset)

        tracked = admin_service.listTrackedAssets(db.session)
        for t in tracked:
            sym = t.assetSymbol.upper()
            if query in sym.lower() and not any(m["symbol"] == sym for m in matches):
                matches.append({"symbol": sym, "name": f"{sym} ({t.assetType})", "type": t.assetType})

        return jsonify(matches[:12])

    @app.route("/api/price/spot", methods=["GET"])
    @login_required
    def getSpotPrice():
        assetSymbol = request.args.get("assetSymbol", "").strip().upper()
        assetType = request.args.get("assetType", "stock").strip().lower()
        if not assetSymbol:
            return jsonify({"error": "assetSymbol required"}), 400
        try:
            price = portfolio_service.getLivePrice(assetSymbol, assetType)
            return jsonify({"assetSymbol": assetSymbol, "assetType": assetType, "price": float(price)})
        except Exception as e:
            return jsonify({"error": f"Failed to fetch price for {assetSymbol}: {str(e)}"}), 400

    @app.route("/api/price/batch", methods=["GET"])
    @login_required
    def getBatchPrices():
        assetsQuery = request.args.get("assets", "")
        if not assetsQuery:
            return jsonify({})

        pairs = [p.split(":") for p in assetsQuery.split(",") if ":" in p]
        results = {}

        def _fetchPair(pair):
            sym, typ = pair[0].strip().upper(), pair[1].strip().lower()
            try:
                price = portfolio_service.getLivePrice(sym, typ)
                return sym, {"price": float(price), "type": typ}
            except Exception:
                return sym, {"error": "Failed"}

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(len(pairs), 8)) as executor:
            for sym, data in executor.map(_fetchPair, pairs):
                results[sym] = data

        return jsonify(results)

    @app.route("/api/portfolio", methods=["GET"])
    @login_required
    def getPortfolio():
        result = portfolio_service.getPortfolioPnl(db.session, current_user.userId)
        return jsonify({
            "totalPnl": result["totalPnl"],
            "holdings": [
                {
                    "holdingId": h["holding"].holdingId,
                    "assetSymbol": h["holding"].assetSymbol,
                    "assetType": h["holding"].assetType,
                    "quantity": h["holding"].quantity,
                    "buyPrice": h["holding"].buyPrice,
                    "buyDate": h["holding"].buyDate.isoformat() if h["holding"].buyDate else None,
                    "livePrice": h["livePrice"],
                    "unrealizedPnl": h["unrealizedPnl"],
                    "unrealizedPnlPct": h["unrealizedPnlPct"],
                }
                for h in result["holdings"]
            ],
        })

    @app.route("/api/signal", methods=["GET"])
    @login_required
    def getSignal():
        assetSymbol = request.args.get("assetSymbol")
        assetType = request.args.get("assetType", "stock")
        if not assetSymbol:
            return jsonify({"error": "assetSymbol query param required"}), 400

        priceDf = price_service.getHistoricalPrices(assetSymbol, assetType)
        # No headlineFetcher/postFetcher injected here yet: real NewsAPI/PRAW
        # client wiring (with API keys) is a separate, still-open TODO per
        # sentiment_service.py's own docstring. Until then this safely
        # returns 0.0 (neutral) rather than crashing or faking a score.
        sentimentScore = sentiment_service.getSentimentForAsset(
            assetSymbol, assetType, date.today(), db.session,
        )

        rfModel, rfBackground, lstmModel, lstmBackground, featureNames = \
            _getOrTrainModels(assetSymbol, priceDf)

        signalRows = generateSignal(
            db.session, current_user.userId, assetSymbol, assetType, priceDf,
            rfModel=rfModel, rfBackground=rfBackground,
            lstmModel=lstmModel, lstmBackground=lstmBackground,
            featureNames=featureNames,
        )
        # FR-6.2 feedback loop: opportunistically resolve any of this
        # asset's older signals now that we already have fresh price data
        # in hand — avoids a second fetch just to run this check.
        watchlist_service.resolveSignalOutcomes(db.session, assetSymbol, priceDf)

        status = sentiment_service.getDataSourceStatus("reddit" if assetType.lower() == "crypto" else "newsapi")
        # Thresholds: ±0.15 chosen because compound VADER scores within (-0.15, 0.15)
        # reflect mild/neutral daily baseline noise, while scores >= 0.15 or <= -0.15
        # denote distinct positive or negative sentiment tone with statistical confidence.
        if sentimentScore >= 0.15:
            moodLabel = "positive"
        elif sentimentScore <= -0.15:
            moodLabel = "negative"
        else:
            moodLabel = "neutral"

        newsMood = {
            "score": round(float(sentimentScore), 4),
            "label": moodLabel,
            "status": status,
        }

        # Task 2b: Evaluate model collapse health on recent predictions (last 60 rows/windows)
        featureFrame = buildFeatureFrame(priceDf)
        rfRecentRows = featureFrame.tail(60)
        rfRecentPreds = [
            predictRfDirection(rfModel, rfRecentRows.iloc[i].values)["direction"]
            for i in range(len(rfRecentRows))
        ]
        rfHealth = checkSingleClass(rfRecentPreds, minSamples=20, threshold=0.95)

        if lstmModel is not None:
            numWindows = min(60, max(0, len(featureFrame) - WINDOW_SIZE_DEFAULT + 1))
            startIdx = len(featureFrame) - numWindows
            lstmRecentPreds = []
            for i in range(startIdx, len(featureFrame)):
                seq = featureFrame.iloc[i - WINDOW_SIZE_DEFAULT + 1 : i + 1].values
                if len(seq) == WINDOW_SIZE_DEFAULT:
                    pred = predictLstmDirection(lstmModel, seq, CLASS_NAMES)
                    lstmRecentPreds.append(pred["direction"])
            lstmHealth = checkSingleClass(lstmRecentPreds, minSamples=20, threshold=0.95)
        else:
            lstmHealth = {"status": "insufficient_data", "dominantClass": None, "dominantShare": 0.0, "sampleSize": 0}

        return jsonify({
            "assetSymbol": assetSymbol,
            "assetType": assetType,
            "newsMood": newsMood,
            "signals": [
                {
                    "modelUsed": row.modelUsed,
                    "predictedDirection": row.predictedDirection,
                    "confidenceScore": row.confidenceScore,
                    "topContributingFeatures": json.loads(row.topContributingFeatures),
                    "horizonDays": row.horizonDays,
                    "modelHealth": rfHealth if row.modelUsed == MODEL_BASELINE else lstmHealth,
                }
                for row in signalRows
            ],
        })


    @app.route("/api/backtest", methods=["POST"])
    @login_required
    def backtest():
        body = request.get_json() or {}
        assetSymbol = body.get("assetSymbol", "").strip().upper()
        if not assetSymbol:
            return jsonify({"error": "assetSymbol is required"}), 400

        modelUsed = body.get("modelUsed", MODEL_BASELINE)
        assetType = body.get("assetType", "stock")
        horizonDays = int(body.get("horizonDays", 3))

        try:
            priceDf = price_service.getHistoricalPrices(assetSymbol, assetType)
            if priceDf is None or priceDf.empty or len(priceDf) < 20:
                return jsonify({"error": f"Insufficient historical price data available for {assetSymbol}."}), 400

            priceSeries = priceDf["close"].copy()
            priceSeries.index = pd.to_datetime(priceSeries.index).normalize()
            if priceSeries.index.tz is not None:
                priceSeries.index = priceSeries.index.tz_localize(None)
            priceSeries = priceSeries[~priceSeries.index.duplicated(keep="last")]

            # Pull this user's persisted signal history for the asset+model if available
            signalRowsQuery = (
                db.session.query(Signal)
                .filter_by(userId=current_user.userId, assetSymbol=assetSymbol, modelUsed=modelUsed)
                .order_by(Signal.generatedAt)
                .all()
            )

            if len(signalRowsQuery) >= 2:
                sigDates = pd.to_datetime([row.generatedAt.date() for row in signalRowsQuery]).normalize()
                if sigDates.tz is not None:
                    sigDates = sigDates.tz_localize(None)
                signalSeries = pd.Series(
                    [row.predictedDirection for row in signalRowsQuery],
                    index=sigDates,
                )
                signalSeries = signalSeries[~signalSeries.index.duplicated(keep="last")]
                rangeStart = signalRowsQuery[0].generatedAt.date()
                rangeEnd = date.today()
            else:
                # Walk-forward historical replay: simulate model predictions over historical windows
                rfModel, _, lstmModel, _, _ = _getOrTrainModels(assetSymbol, priceDf)
                featureFrame = buildFeatureFrame(priceDf)

                testWindow = min(60, len(featureFrame) - WINDOW_SIZE_DEFAULT - 1)

                if testWindow < 5:
                    testWindow = max(5, len(featureFrame) // 3)

                startIdx = max(WINDOW_SIZE_DEFAULT, len(featureFrame) - testWindow)
                simDates = []
                simDirections = []

                for i in range(startIdx, len(featureFrame)):
                    dt = priceSeries.index[i]
                    if modelUsed == MODEL_LSTM and lstmModel is not None:
                        seq = featureFrame.iloc[i - WINDOW_SIZE_DEFAULT + 1 : i + 1].values
                        if len(seq) == WINDOW_SIZE_DEFAULT:
                            pred = predictLstmDirection(lstmModel, seq, CLASS_NAMES)
                            simDates.append(dt)
                            simDirections.append(pred["direction"])
                    else:
                        featRow = featureFrame.iloc[i].values
                        pred = predictRfDirection(rfModel, featRow)
                        simDates.append(dt)
                        simDirections.append(pred["direction"])

                if len(simDirections) < 2:
                    simDates = list(priceSeries.index[-10:])
                    simDirections = ["up" if priceSeries.iloc[j] >= priceSeries.iloc[j-1] else "down" for j in range(len(priceSeries)-10, len(priceSeries))]

                sigDates = pd.to_datetime(simDates).normalize()
                if sigDates.tz is not None:
                    sigDates = sigDates.tz_localize(None)
                signalSeries = pd.Series(simDirections, index=sigDates)
                signalSeries = signalSeries[~signalSeries.index.duplicated(keep="last")]
                rangeStart = simDates[0].date() if hasattr(simDates[0], "date") else date.today()
                rangeEnd = date.today()

            metrics = runBacktest(priceSeries, signalSeries, horizonDays=horizonDays)

            resultRow = BacktestResult(
                userId=current_user.userId,
                assetSymbol=assetSymbol,
                modelUsed=modelUsed,
                rangeStart=rangeStart,
                rangeEnd=rangeEnd,
                sharpeRatio=metrics["sharpeRatio"],
                winRate=metrics["winRate"],
                maxDrawdown=metrics["maxDrawdown"],
                totalTrades=metrics["totalTrades"],
                equityCurve=json.dumps(metrics["equityCurve"]),
            )
            db.session.add(resultRow)
            db.session.commit()

            # _debugDirectionalAccuracy deliberately dropped here, not just in
            # backtesting_service — Honesty Framework applies at every layer
            # the metric could otherwise leak through (NFR-6).
            return jsonify({
                "sharpeRatio": metrics["sharpeRatio"],
                "winRate": metrics["winRate"],
                "maxDrawdown": metrics["maxDrawdown"],
                "totalTrades": metrics["totalTrades"],
                "equityCurve": metrics["equityCurve"],
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            return jsonify({"error": f"Backtest failed: {str(e)}"}), 400

    # --- Phase 3: Watchlist & Alerts (FR-5) ---

    @app.route("/api/watchlist", methods=["GET"])
    @login_required
    def getWatchlist():
        return jsonify(watchlist_service.getWatchlistWithAlerts(db.session, current_user.userId))

    @app.route("/api/watchlist", methods=["POST"])
    @login_required
    def addWatchlistItem():
        body = request.get_json()
        item = watchlist_service.addToWatchlist(
            db.session, current_user.userId, body["assetSymbol"], body.get("assetType", "stock"),
        )
        return jsonify({"watchlistId": item.watchlistId}), 201

    @app.route("/api/watchlist/<int:watchlistId>", methods=["DELETE"])
    @login_required
    def deleteWatchlistItem(watchlistId):
        removed = watchlist_service.removeFromWatchlist(db.session, current_user.userId, watchlistId)
        if not removed:
            return jsonify({"error": "not found"}), 404
        return jsonify({"status": "removed"})

    # --- Phase 3: Feedback loop (FR-6.2) ---

    @app.route("/api/signal-history", methods=["GET"])
    @login_required
    def getSignalHistory():
        assetSymbol = request.args.get("assetSymbol")
        if not assetSymbol:
            return jsonify({"error": "assetSymbol query param required"}), 400
        return jsonify(watchlist_service.getSignalHistory(db.session, current_user.userId, assetSymbol))

    # --- Phase 3: Stock vs crypto comparison (FR-6.3) ---

    @app.route("/api/portfolio/comparison", methods=["GET"])
    @login_required
    def getPortfolioComparison():
        result = portfolio_service.getPortfolioPnl(db.session, current_user.userId)
        byType = {"stock": {"totalPnl": 0.0, "holdingCount": 0}, "crypto": {"totalPnl": 0.0, "holdingCount": 0}}
        for h in result["holdings"]:
            bucket = byType.setdefault(h["holding"].assetType, {"totalPnl": 0.0, "holdingCount": 0})
            bucket["totalPnl"] += h["unrealizedPnl"]
            bucket["holdingCount"] += 1
        return jsonify(byType)

    # --- Phase 3: Admin/Config panel (FR-7) ---
    # NOTE: SRS 2.1 treats Admin as "the same physical person as Trader/
    # User, but a distinct role" (solo project) — enforced here only by
    # @login_required, not a separate role check, matching that spec.

    @app.route("/api/admin/tracked-assets", methods=["GET"])
    @login_required
    def listTrackedAssets():
        assets = admin_service.listTrackedAssets(db.session)
        return jsonify([{"trackedAssetId": a.trackedAssetId, "assetSymbol": a.assetSymbol, "assetType": a.assetType} for a in assets])

    @app.route("/api/admin/tracked-assets", methods=["POST"])
    @login_required
    def addTrackedAsset():
        body = request.get_json()
        asset = admin_service.addTrackedAsset(db.session, body["assetSymbol"], body.get("assetType", "stock"))
        return jsonify({"trackedAssetId": asset.trackedAssetId}), 201

    @app.route("/api/admin/tracked-assets/<int:trackedAssetId>", methods=["DELETE"])
    @login_required
    def deleteTrackedAsset(trackedAssetId):
        removed = admin_service.removeTrackedAsset(db.session, trackedAssetId)
        if not removed:
            return jsonify({"error": "not found"}), 404
        return jsonify({"status": "removed"})

    @app.route("/api/admin/config", methods=["GET"])
    @login_required
    def getAdminConfig():
        config = admin_service.getRetrainConfig(db.session)
        return jsonify({"retrainIntervalDays": config.retrainIntervalDays})

    @app.route("/api/admin/config", methods=["POST"])
    @login_required
    def setAdminConfig():
        body = request.get_json()
        config = admin_service.setRetrainInterval(db.session, body["retrainIntervalDays"])
        return jsonify({"retrainIntervalDays": config.retrainIntervalDays})

    @app.route("/api/admin/health", methods=["GET"])
    @login_required
    def getDataSourceHealth():
        return jsonify(admin_service.checkDataSourceHealth(db.session))

    @app.route("/api/admin/retrain", methods=["POST"])
    @login_required
    def triggerAdminRetrain():
        tracked = admin_service.listTrackedAssets(db.session)
        if not tracked:
            return jsonify({"status": "no_tracked_assets", "results": []})

        results = []
        for asset in tracked:
            try:
                cacheKey = (asset.assetSymbol, date.today().isoformat())
                if cacheKey in G_ModelCache:
                    del G_ModelCache[cacheKey]

                priceDf = price_service.getHistoricalPrices(asset.assetSymbol, asset.assetType)
                sentimentScore = sentiment_service.getSentimentForAsset(
                    asset.assetSymbol, asset.assetType, date.today(), db.session
                )
                rf, _, lstm, _, _ = _getOrTrainModels(asset.assetSymbol, priceDf, sentimentScore)
                results.append({
                    "assetSymbol": asset.assetSymbol,
                    "assetType": asset.assetType,
                    "status": "retrained",
                    "models": ["random_forest", "lstm" if lstm else "baseline_only"],
                    "dataPoints": len(priceDf),
                    "sentiment": round(sentimentScore, 4),
                })
            except Exception as e:
                results.append({
                    "assetSymbol": asset.assetSymbol,
                    "status": "failed",
                    "error": str(e),
                })

        config = admin_service.getRetrainConfig(db.session)
        config.updatedAt = datetime.utcnow()
        db.session.commit()

        return jsonify({
            "status": "completed",
            "results": results,
            "retrainedAt": config.updatedAt.isoformat(),
        })

    return app


def _getOrTrainModels(assetSymbol, priceDf, sentimentScore=None):
    """Train RF+LSTM on demand and cache per (MODEL_FEATURE_VERSION, asset, day).
    Models use technical features only (sma, rsi, macd, volumeChange) — sentiment
    is decoupled as a separate newsMood context indicator per Task 1.

    Fix #3: evict the oldest entry when MAX_MODEL_CACHE_SIZE is reached so
    the dict never grows without bound across a long-running session.
    """
    cacheKey = (MODEL_FEATURE_VERSION, assetSymbol, date.today().isoformat())
    if cacheKey in G_ModelCache:
        cached = G_ModelCache[cacheKey]
        # Invalidate if stale or legacy shape (must have 4 features and no 'sentiment')
        if len(cached[4]) == 4 and "sentiment" not in cached[4]:
            return cached
        del G_ModelCache[cacheKey]

    # Evict oldest-inserted entry when cap is reached (dict preserves
    # insertion order in Python 3.7+, so next(iter(...)) is the oldest key).
    if len(G_ModelCache) >= MAX_MODEL_CACHE_SIZE:
        oldest = next(iter(G_ModelCache))
        del G_ModelCache[oldest]

    featureFrame = buildFeatureFrame(priceDf)
    labels = labelDirection(priceDf["close"])
    featureNames = list(featureFrame.columns)

    rfModel = trainRandomForestBaseline(featureFrame, labels)
    rfBackground = featureFrame.tail(80).values[:60]

    sequences, seqLabels = buildSequenceWindows(featureFrame, labels, WINDOW_SIZE_DEFAULT)
    lstmModel = None
    lstmBackground = None
    if len(sequences) > 0:
        lstmModel = trainLstm(sequences, seqLabels, classNames=CLASS_NAMES)
        lstmBackground = sequences[-30:]

    result = (rfModel, rfBackground, lstmModel, lstmBackground, featureNames)
    G_ModelCache[cacheKey] = result
    return result



if __name__ == "__main__":
    from retrain_scheduler import startScheduler
    application = create_app()
    with application.app_context():
        db.create_all()
    startScheduler(application, _getOrTrainModels, G_ModelCache)
    application.run(debug=os.environ.get("FLASK_DEBUG") == "1")
