# TradeSage AI — Backend Architecture & Verification

Personal trading intelligence platform combining portfolio tracking with an ML-driven signal engine (Random Forest baseline + LSTM, compared side by side) for stocks and cryptocurrency. Decision-support only — not financial advice.

---

## Directory Structure & Modules

- `app.py` — Flask application factory, route handlers (auth, portfolio, signal, backtest, admin, dashboard)
- `models.py` — SQLAlchemy ORM (`User`, `Holding`, `Signal`, `BacktestResult`, `WatchlistItem`, `SentimentCache`)
- `auth_service.py` — Registration, authentication, session lifecycle
- `portfolio_service.py` — Portfolio holding CRUD, CSV bulk import, live pricing, real-time P&L
- `watchlist_service.py` — Watchlist management, signal-change notifications, feedback-loop outcome resolution
- `price_service.py` — Historical OHLCV market feeds (yfinance for equities, paginated Binance klines for crypto)
- `feature_pipeline.py` — Technical indicator calculation (`sma`, `rsi`, `macd`, `volumeChange`) and 3-class target labeling
- `sentiment_service.py` — Live headline sentiment (NewsAPI for stocks, Reddit/PRAW for crypto) with VADER scoring and SQLite caching
- `signal_engine.py` — Baseline Random Forest classifier
- `lstm_model.py` — PyTorch sequential LSTM network (1-layer, 32 hidden units)
- `signal_service.py` — Orchestrates data acquisition, feature transformation, model execution, SHAP generation, and DB persistence
- `model_health.py` — `checkSingleClass` algorithm detecting single-class prediction collapse
- `explainability_service.py` — SHAP explainability (`TreeExplainer` for RF, `GradientExplainer` for LSTM)
- `backtesting_service.py` — Backtesting engine calculating Sharpe ratio, win rate, and maximum drawdown
- `admin_service.py` — Administrative controls, retrain schedules, and data source health monitoring
- `scripts/verify_all.py` — Consolidated runner executing all 7 smoke test suites
- `scripts/run_real_backtest.py` — Walk-forward real-market backtesting runner for BTC and AAPL

---

## Setup & Execution

From the `backend/` directory:

```bash
pip install -r requirements.txt
python app.py
```

The Flask server will start on `http://127.0.0.1:5000`.

- **Cold Start & Retraining**: `/api/signal` trains models on first request for an asset (~15-20s cold start). Subsequent calls leverage cached models.
- **Model Feature Versioning**: `MODEL_FEATURE_VERSION = 2` ensures any legacy models trained with obsolete 5-feature shapes are automatically invalidated.
- **Sentiment Resilience**: Sentiment is returned via a separate `newsMood` payload. When API keys are not supplied in `.env`, the service returns neutral sentiment with status `degraded: missing_key` rather than raising errors.

---

## Verification Test Suites

All 7 test suites can be executed via the master runner:

```bash
python scripts/verify_all.py
```

Or individually with `PYTHONPATH=.`:

```bash
PYTHONPATH=. python tests/smoke_test.py              # SHAP explainability & backtesting in isolation
PYTHONPATH=. python tests/smoke_test_auth.py         # Session hardening, 401 on X-User-Id / Bearer tokens
PYTHONPATH=. python tests/smoke_test_full.py         # End-to-end signal pipeline & 4-feature shape verification
PYTHONPATH=. python tests/smoke_test_phase3.py       # Watchlist, feedback loop, comparison view, admin diagnostics
PYTHONPATH=. python tests/smoke_test_routes.py       # Flask HTTP routes & request contracts
PYTHONPATH=. python tests/smoke_test_sentiment.py    # NewsAPI & Reddit/PRAW fetchers, caching, degradation handling
PYTHONPATH=. python tests/smoke_test_model_health.py # checkSingleClass collapse detection & threshold tests
```

---

## Real-Market Backtesting

To run an honest walk-forward backtest (70% train / 30% test) on live historical data:

```bash
python scripts/run_real_backtest.py
```

This script evaluates AAPL (1,150-bar lookback via yfinance) and BTC (≥1,500 daily bars via Binance klines pagination), logging class distributions, trade counts, Sharpe ratio, win rate, and maximum drawdown.
