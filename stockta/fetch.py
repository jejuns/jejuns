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
    df = _flatten_yf_columns(df)
    if not df.empty:
        # 당일 장중 세션 등 미확정 마지막 행이 NaN으로 들어오면 .iloc[-1] 기반 계산이
        # 조용히 깨지므로(SMA/게이트 전부 NaN) 제거한다.
        df = df.dropna(subset=["Close"])
    return df


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
    """OHLCV/실적일 조회용으로 '작동하는' 접미사를 찾는다 (시장 판별용 아님).

    yfinance는 .KS/.KQ를 검증하지 않고 어느 쪽을 붙이든 같은 실데이터를 준다
    (실측 확인됨). 그래서 이 함수는 가격 데이터를 얻는 데는 문제없이 쓸 수
    있지만, 코스피/코스닥 구분에는 못 쓴다 — 그건 kr_market_suffix()가
    KRX 공식 목록으로 따로 판별한다.
    """
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


@lru_cache(maxsize=1)
def _kosdaq_ticker_set() -> frozenset | None:
    """KRX 공식 코스닥 종목 목록. 조회 실패 시 None(=시장 구분 불가).

    yfinance의 .KS/.KQ 접미사는 시장을 검증하지 않는다 — 실측 확인 결과
    코스피 종목(005930, 000660)에 .KQ를 붙여도, 코스닥 종목(247540)에 .KS를
    붙여도 똑같은 실데이터가 그대로 반환된다. 따라서 접미사 프로빙으로는
    코스피/코스닥을 구분할 수 없고, KRX 공식 목록으로만 판별 가능하다.
    """
    try:
        from pykrx import stock

        date = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
        tickers = stock.get_market_ticker_list(date, market="KOSDAQ")
        return frozenset(tickers) if tickers else None
    except Exception:
        return None


def kr_market_suffix(ticker: str) -> tuple[str, bool]:
    """반환: (접미사, 시장 구분 불확실 여부).

    KRX 공식 코스닥 목록 조회가 실패하면 코스피로 가정하되, 실제로는
    코스닥일 수 있으므로 불확실함을 호출부에 알린다(조용히 틀린 벤치마크를
    쓰는 것보다 낫다).
    """
    kosdaq = _kosdaq_ticker_set()
    if kosdaq is None:
        return ".KS", True
    return (".KQ", False) if ticker in kosdaq else (".KS", False)


@lru_cache(maxsize=8)
def fetch_benchmark(symbol: str) -> pd.DataFrame:
    """실행당 1회 캐시. 시장 국면 필터와 RS Line 양쪽에 쓰인다."""
    df = _yf_download(symbol)
    return df[["Open", "High", "Low", "Close", "Volume"]]


def resolve_benchmark_symbol(ticker: str) -> tuple[str, str | None]:
    """반환: (실제 사용할 벤치마크 심볼, 경고 메시지 또는 None).

    조용히 틀린 지수를 쓰는 상황이 두 가지 있고 각각 다르게 경고한다:
    1. KRX 코스닥 목록 조회 실패로 코스피/코스닥 구분 자체가 불확실
    2. 코스닥으로 확인됐지만 ^KQ11 조회가 실패해 ^KS11로 대체
    """
    if not is_kr_ticker(ticker):
        return config.BENCH_US, None

    suffix, uncertain = kr_market_suffix(ticker)
    if uncertain:
        return config.BENCH_KR, "코스피/코스닥 구분 조회 실패 — 코스피 지수로 가정(틀렸을 수 있음)"
    if suffix != ".KQ":
        return config.BENCH_KR, None

    if not fetch_benchmark(config.BENCH_KQ).empty:
        return config.BENCH_KQ, None
    return config.BENCH_KR, "^KQ11 조회 실패로 ^KS11(코스피)로 대체"


def benchmark_for_ticker(ticker: str) -> pd.DataFrame:
    symbol, _ = resolve_benchmark_symbol(ticker)
    return fetch_benchmark(symbol)


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
