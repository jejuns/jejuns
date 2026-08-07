"""티커 자동 판별 + OHLCV 수집 (+지수, +한국 수급)."""
import re
from datetime import datetime, timedelta
from functools import lru_cache

import pandas as pd
import yfinance as yf

from . import config

_KR_RE = re.compile(config.KR_TICKER_RE)

_KR_COLS = {"시가": "Open", "고가": "High", "저가": "Low", "종가": "Close", "거래량": "Volume"}


def is_kr_ticker(ticker: str) -> bool:
    return bool(_KR_RE.match(ticker))


def _flatten_yf_columns(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.get_level_values(0)
    df.columns.name = None
    return df


def _yf_download(symbol: str, period: str = f"{config.LOOKBACK_YEARS}y") -> pd.DataFrame:
    df = yf.download(symbol, period=period, auto_adjust=False, progress=False)
    return _flatten_yf_columns(df)


def _pykrx_ohlcv(ticker6: str) -> pd.DataFrame:
    from pykrx import stock

    todate = datetime.now().strftime("%Y%m%d")
    fromdate = (datetime.now() - timedelta(days=365 * config.LOOKBACK_YEARS)).strftime("%Y%m%d")
    df = stock.get_market_ohlcv(fromdate, todate, ticker6)
    df = df.rename(columns=_KR_COLS)[["Open", "High", "Low", "Close", "Volume"]]
    df.index.name = "Date"
    return df


@lru_cache(maxsize=256)
def _resolve_kr_suffix(ticker6: str) -> str | None:
    for suffix in (".KS", ".KQ"):
        df = _yf_download(ticker6 + suffix, period="5d")
        if not df.empty:
            return suffix
    return None


def resolve_yf_symbol(ticker: str) -> str | None:
    """yfinance 조회에 쓸 실제 심볼. 한국 종목이 yfinance에서 안 잡히면 None(=pykrx 전용)."""
    if not is_kr_ticker(ticker):
        return ticker
    suffix = _resolve_kr_suffix(ticker)
    return ticker + suffix if suffix else None


def fetch_ohlcv(ticker: str) -> pd.DataFrame:
    """단일 인터페이스: 종목코드/티커 -> DataFrame[Open,High,Low,Close,Volume].

    소스 교체(yfinance <-> pykrx)가 이 함수 안에서만 일어나도록 감싼다.
    """
    symbol = resolve_yf_symbol(ticker)
    if symbol is None:
        return _pykrx_ohlcv(ticker)

    df = _yf_download(symbol)
    if df.empty and is_kr_ticker(ticker):
        return _pykrx_ohlcv(ticker)
    return df[["Open", "High", "Low", "Close", "Volume"]]


def resample_weekly(df: pd.DataFrame) -> pd.DataFrame:
    agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    return df.resample("W-FRI").agg(agg).dropna()


def kr_market_suffix(ticker: str) -> str:
    """수급 조회 등에서 코스피/코스닥 벤치마크 선택용. 실측 실패 시 KS로 가정."""
    return _resolve_kr_suffix(ticker) or ".KS"


@lru_cache(maxsize=8)
def fetch_benchmark(symbol: str) -> pd.DataFrame:
    """실행당 1회 캐시. 시장 국면 필터와 RS Line 양쪽에 쓰인다."""
    df = _yf_download(symbol)
    return df[["Open", "High", "Low", "Close", "Volume"]]


def benchmark_for_ticker(ticker: str) -> pd.DataFrame:
    if is_kr_ticker(ticker):
        suffix = kr_market_suffix(ticker)
        symbol = config.BENCH_KQ if suffix == ".KQ" else config.BENCH_KR
        return fetch_benchmark(symbol)
    return fetch_benchmark(config.BENCH_US)


def fetch_kr_supply(ticker: str, days: int = 20) -> dict | None:
    """최근 N영업일 외국인·기관 순매수 누적. 실패해도 분석은 계속되도록 None 반환."""
    try:
        from pykrx import stock

        todate = datetime.now().strftime("%Y%m%d")
        fromdate = (datetime.now() - timedelta(days=days * 2)).strftime("%Y%m%d")
        df = stock.get_market_trading_value_by_investor(fromdate, todate, ticker)
        foreign = df.loc["외국인합계", "순매수"] if "외국인합계" in df.index else df.get("외국인합계")
        inst = df.loc["기관합계", "순매수"] if "기관합계" in df.index else df.get("기관합계")
        return {"foreign_net": float(foreign), "institution_net": float(inst)}
    except Exception:
        return None


def fetch_next_earnings_date(ticker: str):
    """다음 실적 발표일. 실패 시 None(경고 생략)."""
    symbol = resolve_yf_symbol(ticker)
    if symbol is None:
        return None
    try:
        cal = yf.Ticker(symbol).calendar
        if not cal:
            return None
        dates = cal.get("Earnings Date")
        if not dates:
            return None
        return dates[0] if isinstance(dates, list) else dates
    except Exception:
        return None
