"""
Module      : price_service.py
Date        : 2026-08-29
Author      : Dhruv
Modification History:
    2026-08-29 - Initial version. Added while wiring /api/signal and
                 /api/backtest in app.py: portfolio_service.py only fetches
                 a single live spot price (FR-2.3), but the Signal Engine
                 (FR-3.1) and Backtesting Module (FR-4.1) both need a
                 historical OHLCV series to build features/labels and to
                 replay signals against. That gap was found by reading the
                 code fresh from the repo, not assumed.
Synopsis:
    Fetches historical daily close+volume history for an asset, stock via
    yfinance and crypto via Binance's public klines endpoint, returning a
    pandas DataFrame shaped exactly as feature_pipeline.buildFeatureFrame
    expects (columns ['close', 'volume'], DatetimeIndex).

    Same dependency-injection pattern as portfolio_service.py's price
    fetchers: real network clients live in _default*Fetcher functions,
    callers can inject a fake fetcher for testing without live API access.

Functions:
    getHistoricalPrices(assetSymbol, assetType, lookbackDays,
                         stockHistoryFetcher=None, cryptoHistoryFetcher=None)
        -> pandas.DataFrame (columns: close, volume; DatetimeIndex)

Globals accessed/modified: None.
"""

import pandas as pd

import time

LOOKBACK_DAYS_DEFAULT = 250  # enough history for SMA-20/RSI-14/MACD-26 warmup plus LSTM windows
_HISTORICAL_PRICE_CACHE = {}
_HIST_TTL_SECONDS = 60.0


def getHistoricalPrices(assetSymbol, assetType, lookbackDays=LOOKBACK_DAYS_DEFAULT,
                         stockHistoryFetcher=None, cryptoHistoryFetcher=None):
    sym = assetSymbol.upper()
    typ = assetType.lower()
    isDefault = (stockHistoryFetcher is None and cryptoHistoryFetcher is None)

    if isDefault:
        cacheKey = (sym, typ, lookbackDays)
        now = time.time()
        if cacheKey in _HISTORICAL_PRICE_CACHE:
            ts, cachedDf = _HISTORICAL_PRICE_CACHE[cacheKey]
            if now - ts < _HIST_TTL_SECONDS:
                return cachedDf.copy()

    if typ == "crypto":
        fetcher = cryptoHistoryFetcher or _defaultCryptoHistoryFetcher
    else:
        fetcher = stockHistoryFetcher or _defaultStockHistoryFetcher

    priceDf = fetcher(sym, lookbackDays)
    # Guard against fetchers returning extra columns (e.g. yfinance's Open/High/Low/
    # Adj Close/Dividends/Splits) — downstream code only expects close + volume.
    priceDf = priceDf[["close", "volume"]].sort_index()
    if priceDf.index.tz is not None:
        priceDf.index = priceDf.index.tz_localize(None)
    priceDf = priceDf[~priceDf.index.duplicated(keep="last")]

    if isDefault:
        _HISTORICAL_PRICE_CACHE[(sym, typ, lookbackDays)] = (time.time(), priceDf)

    return priceDf.copy()


# --- default fetchers (real network clients; not used in unit tests) ---

def _defaultStockHistoryFetcher(assetSymbol, lookbackDays):
    import yfinance as yf
    ticker = yf.Ticker(assetSymbol)
    history = ticker.history(period=f"{lookbackDays}d")
    if history.empty:
        history = ticker.history(period="1y")
    return pd.DataFrame({
        "close": history["Close"],
        "volume": history["Volume"],
    })


def _defaultCryptoHistoryFetcher(assetSymbol, lookbackDays):
    import requests
    sym = assetSymbol.upper()
    if not sym.endswith("USDT"):
        sym = f"{sym}USDT"

    targetBars = max(lookbackDays or 0, 1500)
    allKlines = []
    endTime = None

    while len(allKlines) < targetBars:
        limit = min(1000, targetBars - len(allKlines) + 50)
        params = {
            "symbol": sym,
            "interval": "1d",
            "limit": limit,
        }
        if endTime is not None:
            params["endTime"] = endTime

        response = requests.get(
            "https://api.binance.com/api/v3/klines",
            params=params,
            timeout=8,
        )
        response.raise_for_status()
        batch = response.json()
        if not batch:
            break
        allKlines.extend(batch)
        earliestOpen = min(row[0] for row in batch)
        endTime = earliestOpen - 1

    # Deduplicate overlapping bars and sort ascending by open time
    seenTimes = set()
    uniqueKlines = []
    for row in allKlines:
        if row[0] not in seenTimes:
            seenTimes.add(row[0])
            uniqueKlines.append(row)
    uniqueKlines.sort(key=lambda row: row[0])

    # Binance kline row layout: [openTime, open, high, low, close, volume, ...]
    closes = [float(row[4]) for row in uniqueKlines]
    volumes = [float(row[5]) for row in uniqueKlines]
    timestamps = pd.to_datetime([row[0] for row in uniqueKlines], unit="ms")
    return pd.DataFrame({"close": closes, "volume": volumes}, index=timestamps)

