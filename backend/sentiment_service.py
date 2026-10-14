"""
Module      : sentiment_service.py
Date        : 2026-08-07
Author      : Dhruv
Modification History:
    2026-08-07 - Recreated (rebuild session). Implements FR-3.2.
    (earlier session) - VADER's stock lexicon under-scores finance-specific
        language (e.g. "bearish", "bullish", "downgrade" scored ~neutral).
        Extended with a ~25-term finance lexicon on top of VADER rather than
        switching to FinBERT, to keep sentiment as a lightweight contributing
        feature (not the primary signal driver) — see project decision log.
Synopsis:
    Computes a sentiment score per asset from news headlines (stocks) or
    Reddit posts (crypto), using VADER extended with finance vocabulary,
    and persists results to SentimentCache so repeated signal-generation
    calls don't re-hit rate-limited free-tier APIs (NewsAPI, Reddit/PRAW).

    Fetchers are dependency-injected (headlineFetcher / postFetcher
    parameters) rather than hardcoded to the live NewsAPI/PRAW clients.
    This is deliberate: it keeps this module unit-testable without live
    API keys or network access, and the actual NewsAPI/PRAW client wiring
    lives in app.py's config, not here.

Functions:
    getFinanceLexicon() -> dict[str, float]
        ~25 finance terms with VADER-style valence scores, additive to VADER.
    scoreText(text, vaderAnalyzer) -> float
        Returns compound sentiment score in [-1, 1].
    getSentimentForAsset(assetSymbol, assetType, sourceDate, dbSession,
                          headlineFetcher=None, postFetcher=None)
        -> float
        Checks SentimentCache first; on miss, fetches (NewsAPI for stocks,
        Reddit for crypto), scores, caches, and returns the score.

Globals accessed/modified: None (dbSession passed explicitly, not global).
"""

import os
from datetime import date

import requests
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import yfinance as yf

from models import SentimentCache

MIN_SAMPLE_SIZE_DEFAULT = 1  # ALL_CAPS constant per standard naming convention


def getFinanceLexicon():
    # Extends VADER's general-purpose lexicon with finance-specific terms
    # VADER under-scores or misses entirely (caught during smoke testing
    # against real headlines in the earlier session).
    return {
        "bullish": 2.5, "bearish": -2.5, "rally": 2.0, "selloff": -2.5,
        "sell-off": -2.5, "downgrade": -2.0, "upgrade": 2.0, "outperform": 2.0,
        "underperform": -2.0, "beat": 1.8, "miss": -1.8, "surge": 2.2,
        "plunge": -2.5, "tumble": -2.0, "soar": 2.3, "crash": -3.0,
        "recession": -2.0, "correction": -1.5, "breakout": 1.8,
        "overbought": -1.0, "oversold": 1.0, "short squeeze": 2.0,
        "hack": -2.5, "exploit": -2.5, "rug pull": -3.0, "liquidation": -2.0,
    }


def _buildAnalyzer():
    analyzer = SentimentIntensityAnalyzer()
    analyzer.lexicon.update(getFinanceLexicon())
    return analyzer


def scoreText(text, vaderAnalyzer):
    return vaderAnalyzer.polarity_scores(text)["compound"]


def _extractTitle(item):
    if isinstance(item, dict):
        content = item.get("content")
        if isinstance(content, dict) and content.get("title"):
            return content["title"]
        return item.get("title", "")
    return str(item)


_DATA_SOURCE_STATUS = {
    "newsapi": "ok" if os.environ.get("NEWSAPI_KEY") else "degraded: missing_key",
    "reddit": "ok" if (os.environ.get("REDDIT_CLIENT_ID") and os.environ.get("REDDIT_CLIENT_SECRET")) else "degraded: missing_key",
}


def getDataSourceStatus(sourceName):
    """Returns the current operational status of a sentiment data source ('newsapi' or 'reddit')."""
    if sourceName == "newsapi" and not os.environ.get("NEWSAPI_KEY"):
        return "degraded: missing_key"
    if sourceName == "reddit" and not (os.environ.get("REDDIT_CLIENT_ID") and os.environ.get("REDDIT_CLIENT_SECRET")):
        return "degraded: missing_key"
    return _DATA_SOURCE_STATUS.get(sourceName, "ok")


def setDataSourceStatus(sourceName, status):
    """Sets the operational status of a sentiment data source."""
    _DATA_SOURCE_STATUS[sourceName] = status


def _defaultHeadlineFetcher(assetSymbol, sourceDate):
    """Fetches real headlines via NewsAPI for stock assets.
    Reads NEWSAPI_KEY from environment.
    On missing key, timeout, HTTP error, or rate limit, returns [] and flags
    the data source as degraded (SRS NFR-2). Never raises."""
    newsApiKey = os.environ.get("NEWSAPI_KEY")
    if not newsApiKey:
        setDataSourceStatus("newsapi", "degraded: missing_key")
        return []

    try:
        resp = requests.get(
            "https://newsapi.org/v2/everything",
            params={
                "q": assetSymbol,
                "pageSize": 10,
                "sortBy": "relevance",
                "apiKey": newsApiKey,
            },
            timeout=8,
        )
        if resp.status_code == 200:
            data = resp.json()
            articles = data.get("articles", [])
            headlines = [a["title"] for a in articles if a.get("title")]
            setDataSourceStatus("newsapi", "ok")
            return headlines
        elif resp.status_code == 429:
            setDataSourceStatus("newsapi", "degraded: rate_limit")
            return []
        else:
            setDataSourceStatus("newsapi", f"degraded: http_{resp.status_code}")
            return []
    except requests.exceptions.Timeout:
        setDataSourceStatus("newsapi", "degraded: timeout")
        return []
    except Exception as exc:
        setDataSourceStatus("newsapi", f"degraded: {type(exc).__name__}")
        return []


def _defaultPostFetcher(assetSymbol, sourceDate):
    """Fetches crypto posts via Reddit/PRAW for crypto assets.
    Reads REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT from environment.
    On missing key, timeout, HTTP error, or rate limit, returns [] and flags
    the data source as degraded (SRS NFR-2). Never raises."""
    clientId = os.environ.get("REDDIT_CLIENT_ID")
    clientSecret = os.environ.get("REDDIT_CLIENT_SECRET")
    userAgent = os.environ.get("REDDIT_USER_AGENT", "tradesage-ai/1.0")

    if not (clientId and clientSecret):
        setDataSourceStatus("reddit", "degraded: missing_key")
        return []

    try:
        import praw
        reddit = praw.Reddit(
            client_id=clientId,
            client_secret=clientSecret,
            user_agent=userAgent,
            requestor_kwargs={"timeout": 8},
        )
        subreddit = reddit.subreddit("CryptoCurrency")
        posts = [s.title for s in subreddit.search(assetSymbol, limit=10, time_filter="week")]
        setDataSourceStatus("reddit", "ok")
        return posts
    except Exception as exc:
        errMsg = str(exc).lower()
        if "429" in errMsg or "ratelimit" in errMsg:
            setDataSourceStatus("reddit", "degraded: rate_limit")
        elif "timeout" in errMsg:
            setDataSourceStatus("reddit", "degraded: timeout")
        else:
            setDataSourceStatus("reddit", f"degraded: {type(exc).__name__}")
        return []


def getSentimentForAsset(assetSymbol, assetType, sourceDate, dbSession,
                          headlineFetcher=None, postFetcher=None):
    cachedRow = (
        dbSession.query(SentimentCache)
        .filter_by(assetSymbol=assetSymbol, sourceDate=sourceDate)
        .first()
    )
    if cachedRow is not None:
        return cachedRow.sentimentScore

    headlineFetcher = headlineFetcher or _defaultHeadlineFetcher
    postFetcher = postFetcher or _defaultPostFetcher

    src = "reddit" if assetType == "crypto" else "newsapi"
    try:
        if assetType == "crypto":
            texts = postFetcher(assetSymbol, sourceDate)
        else:
            texts = headlineFetcher(assetSymbol, sourceDate)
    except Exception as exc:
        setDataSourceStatus(src, f"degraded: {type(exc).__name__}")
        texts = []

    if not texts:
        sentimentScore = 0.0
        sampleSize = 0
    else:
        analyzer = _buildAnalyzer()
        scores = [scoreText(t, analyzer) for t in texts]
        rawScore = sum(scores) / len(scores) if scores else 0.0
        sentimentScore = max(-1.0, min(1.0, float(rawScore)))
        sampleSize = len(scores)

    newCacheRow = SentimentCache(
        assetSymbol=assetSymbol,
        sourceDate=sourceDate,
        sentimentScore=sentimentScore,
        sampleSize=sampleSize,
    )
    dbSession.add(newCacheRow)
    dbSession.commit()
    return sentimentScore
