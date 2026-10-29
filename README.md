# TradeSage AI

TradeSage AI is a personal trading intelligence platform that combines portfolio management and tracking with a dual-model machine learning signal engine (Random Forest baseline and shallow LSTM neural network, compared side-by-side) for stocks and cryptocurrencies. 

> **Disclaimer:** TradeSage AI is an educational and decision-support system only. It does not provide financial or investment advice.

---

## Key Features

- **Dual-Model ML Architecture**:
  - **Random Forest Baseline**: Scikit-Learn ensemble model trained on technical indicators for robust short-term classification.
  - **Shallow LSTM Network**: PyTorch-based sequential neural network (1-layer, 32 hidden units) analyzing temporal patterns across multi-day lookback windows.
  - **Clean Feature Engineering (`v2`)**: Models train on 4 purely technical indicators (`sma`, `rsi`, `macd`, `volumeChange`). Model versioning (`MODEL_FEATURE_VERSION = 2`) invalidates legacy models trained on static sentiment scalars.
- **Explainable AI (XAI)**:
  - Feature attribution powered by SHAP (`TreeExplainer` for Random Forest, `GradientExplainer` for PyTorch LSTM).
  - Displays top contributing features for every trade recommendation.
- **Decoupled "News Mood" Context Indicator**:
  - Live headline sentiment powered by VADER with financial lexicon enhancements.
  - Multi-source fetchers: **NewsAPI** for equities and **Reddit / PRAW** for cryptocurrencies.
  - Local SQLite caching (`tbl_SentimentCache`) to preserve rate limits.
  - Resilient design: On network timeout or missing credentials, gracefully returns neutral status (`degraded: missing_key`) without breaking signal generation.
  - Displayed for trader context only and explicitly decoupled from model feature vectors to eliminate zero-variance bias.
- **Model Health & Collapse Detection**:
  - Automated `checkSingleClass` diagnostic analyzing rolling prediction distributions.
  - Alerts users via visual warning badges and admin panel indicators when a model exhibits single-class collapse (e.g., predicting ≥95% of a single class across evaluation windows).
- **Honest Real-Market Backtesting**:
  - Walk-forward evaluation across real market histories (70% train / 30% test).
  - Enforces minimum historical depth: 1,150-bar lookback for stocks (yfinance) and paginated Binance klines (≥1,500 daily bars) for Bitcoin.
  - Reports realistic trading metrics: Sharpe ratio, win rate, and max drawdown (never misleading raw accuracy).
- **Portfolio & Watchlist Management**:
  - Live portfolio tracking, manual trade entry, and bulk CSV transaction imports.
  - Real-time P&L calculations via live market price feeds.
  - Watchlist tracking with automated signal-direction change alerts.
- **Enterprise Security & Session Hardening**:
  - Secure session-cookie authentication via Flask-Login.
  - Strict endpoint protection: rejects token spoofing (`X-User-Id`, `Bearer` tokens return 401 Unauthorized).
  - Environment variables strictly isolated in `.env` (gitignored).

---

## Repository Layout

```
TradeSageAI/
├── backend/
│   ├── app.py                      # Flask application factory, routes & API endpoints
│   ├── models.py                   # SQLAlchemy ORM models (User, Holding, Signal, Cache, etc.)
│   ├── auth_service.py             # User authentication & session management
│   ├── portfolio_service.py        # Portfolio tracking, CSV import, and P&L calculations
│   ├── watchlist_service.py        # Watchlist CRUD, alerts, and feedback loop
│   ├── price_service.py            # Market data feeds (yfinance & paginated Binance klines)
│   ├── feature_pipeline.py         # Technical indicator generation (SMA, RSI, MACD, Volume)
│   ├── sentiment_service.py        # VADER + finance lexicon sentiment analysis & caching
│   ├── signal_engine.py            # Random Forest baseline model
│   ├── lstm_model.py               # PyTorch LSTM sequential model
│   ├── signal_service.py           # Signal orchestration & feature pipeline coordinator
│   ├── model_health.py             # Model collapse & single-class distribution detector
│   ├── explainability_service.py   # SHAP feature importance & explanations
│   ├── backtesting_service.py      # Backtesting engine (Sharpe, win rate, drawdown)
│   ├── admin_service.py            # System administration & data source health diagnostics
│   ├── requirements.txt            # Python dependencies
│   ├── scripts/
│   │   ├── verify_all.py           # Automated test runner for all 7 smoke test suites
│   │   └── run_real_backtest.py    # Honest real-market backtesting execution script
│   └── tests/                      # Comprehensive smoke test suites
├── frontend/
│   ├── index.html                  # Landing page
│   ├── dashboard.html              # Main trading terminal dashboard
│   ├── auth.html                   # Login & registration portal
│   ├── css/style.css               # Terminal dark & light theme styling
│   └── js/app.js                   # Client-side API orchestration & reactive UI
├── docs/                           # Project deliverables (SRS, SPMP, Synopsis, Report)
├── .env.example                    # Template for environment configuration
└── .gitignore
```

---

## Quick Start

### 1. Prerequisites
- Python 3.10+ (tested up to Python 3.14)
- Virtual environment recommended (`venv` or `conda`)

### 2. Installation & Configuration

```bash
# Clone the repository
git clone https://github.com/dcp857/TradeSageAI.git
cd TradeSageAI

# Install backend dependencies
cd backend
pip install -r requirements.txt

# Create your local environment file
cp ../.env.example ../.env
```

Edit `.env` and configure key variables:
```env
SECRET_KEY=your_secure_secret_key_here
FLASK_DEBUG=1
SEED_DEMO_USER=1

# Optional: Live News & Reddit sentiment keys (gracefully degrades to neutral if omitted)
NEWSAPI_KEY=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=TradeSageAI/1.0
```

### 3. Running the Server

From the `backend/` directory:
```bash
python app.py
```

The Flask server will start at `http://127.0.0.1:5000/`.
- **Trading Dashboard**: `http://127.0.0.1:5000/dashboard`
- **1-Click Demo Login**: Pre-seeded when `SEED_DEMO_USER=1` (`trader@tradesage.ai` / `Password123!`).

---

## Verification & Testing

TradeSage AI includes a centralized test runner and 7 end-to-end smoke test suites verifying the entire pipeline on both synthetic and live data:

```bash
# Run all 7 test suites
python backend/scripts/verify_all.py
```

### Included Test Suites:
1. `smoke_test.py`: SHAP explainability and backtesting metrics in isolation.
2. `smoke_test_auth.py`: Session hardening, 401 rejection on `X-User-Id` / `Bearer` tokens, and demo flow.
3. `smoke_test_full.py`: End-to-end signal generation, caching immutability, and 4-feature shape verification.
4. `smoke_test_phase3.py`: Watchlist, feedback loops, comparison views, and admin diagnostics.
5. `smoke_test_routes.py`: Flask HTTP route execution and JSON payload contracts.
6. `smoke_test_sentiment.py`: NewsAPI and Reddit/PRAW fetchers, VADER scoring, cache hits, and degraded status handling.
7. `smoke_test_model_health.py`: `checkSingleClass` collapse detection and threshold boundaries.

### Real-Market Backtesting Runner:
Run the honest walk-forward evaluation script across real historical market data (AAPL & BTC):
```bash
python backend/scripts/run_real_backtest.py
```

---

## Documentation

Full project deliverables and engineering specifications are located in `docs/`:
- **Software Project Management Plan (SPMP)**: `docs/TradeSage_AI_SPMP.docx`
- **Software Requirements Specification (SRS)**: `docs/TradeSage_AI_SRS.docx`
- **Project Synopsis**: `docs/TradeSage_AI_Synopsis.docx`
- **Complete Project Report**: `docs/TradeSage_AI_Project_Report.docx`
- **Technical Context & Decision Log**: `docs/TradeSage_AI_Project_Context.md`

---

## License

This project is developed for educational and academic research purposes.
