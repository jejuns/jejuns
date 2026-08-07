"""순수 함수 지표 계산. 부작용 없음, pandas/numpy만 사용."""
import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(s: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_line = ema(s, fast) - ema(s, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger(s: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(s, n)
    std = s.rolling(n).std()
    upper = mid + k * std
    lower = mid - k * std
    pct_b = (s - lower) / (upper - lower)
    return upper, mid, lower, pct_b


def _true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["Close"].shift(1)
    tr = pd.concat(
        [
            df["High"] - df["Low"],
            (df["High"] - prev_close).abs(),
            (df["Low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    tr = _true_range(df)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up_move = df["High"].diff()
    down_move = -df["Low"].diff()

    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0.0),
        index=df.index,
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0),
        index=df.index,
    )

    tr = _true_range(df)
    atr_n = tr.ewm(alpha=1 / n, adjust=False).mean()

    plus_di = 100 * plus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_n
    minus_di = 100 * minus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_n

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


def obv(df: pd.DataFrame) -> pd.Series:
    direction = np.sign(df["Close"].diff()).fillna(0)
    return (direction * df["Volume"]).cumsum()


def slope_pct(s: pd.Series, n: int) -> pd.Series:
    prev = s.shift(n)
    return (s - prev) / prev


def pct_from_52w_high(df: pd.DataFrame, window: int = 252) -> pd.Series:
    rolling_high = df["Close"].rolling(window, min_periods=1).max()
    return df["Close"] / rolling_high - 1


def mom_12_1(s: pd.Series) -> pd.Series:
    ret_12m = s / s.shift(252) - 1
    ret_1m = s / s.shift(21) - 1
    return ret_12m - ret_1m


def _align_to_stock(s: pd.Series, bench: pd.Series) -> pd.Series:
    """휴장일 불일치로 벤치마크에 s의 날짜가 비어 있으면 직전 값으로 채운다.

    reindex만 하면 그 날짜의 벤치마크가 NaN이 되어 RS Line·상대수익률 tail이
    조용히 NaN으로 깨질 수 있다.
    """
    return bench.reindex(s.index).ffill()


def rs_line(s: pd.Series, bench: pd.Series) -> pd.Series:
    aligned_bench = _align_to_stock(s, bench)
    return s / aligned_bench


def rel_return(s: pd.Series, bench: pd.Series, n: int) -> pd.Series:
    aligned_bench = _align_to_stock(s, bench)
    stock_ret = s / s.shift(n) - 1
    bench_ret = aligned_bench / aligned_bench.shift(n) - 1
    return stock_ret - bench_ret
