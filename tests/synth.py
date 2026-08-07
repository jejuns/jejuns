"""합성 OHLCV 생성기 (시드 고정). 시세 API 없이 로직을 검증하기 위함."""
import numpy as np
import pandas as pd


def _ohlcv_from_close(close: pd.Series, seed: int, vol_base: int = 1_000_000) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = len(close)
    prev_close = close.shift(1).fillna(close.iloc[0])
    open_ = prev_close * (1 + rng.normal(0, 0.002, n))
    hi_base = pd.concat([open_, close], axis=1).max(axis=1)
    lo_base = pd.concat([open_, close], axis=1).min(axis=1)
    high = hi_base * (1 + np.abs(rng.normal(0, 0.004, n)))
    low = lo_base * (1 - np.abs(rng.normal(0, 0.004, n)))
    volume = rng.integers(int(vol_base * 0.5), int(vol_base * 1.5), n)
    return pd.DataFrame(
        {"Open": open_, "High": high, "Low": low, "Close": close, "Volume": volume},
        index=close.index,
    )


def _bdate_index(n: int) -> pd.DatetimeIndex:
    return pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n)


def uptrend(n: int = 800, seed: int = 1, mu: float = 0.0009, sigma: float = 0.012) -> pd.DataFrame:
    idx = _bdate_index(n)
    rng = np.random.default_rng(seed)
    rets = rng.normal(mu, sigma, n)
    close = pd.Series(100 * np.cumprod(1 + rets), index=idx, name="Close")
    return _ohlcv_from_close(close, seed)


def downtrend(n: int = 800, seed: int = 2, mu: float = -0.0009, sigma: float = 0.014) -> pd.DataFrame:
    idx = _bdate_index(n)
    rng = np.random.default_rng(seed)
    rets = rng.normal(mu, sigma, n)
    close = pd.Series(100 * np.cumprod(1 + rets), index=idx, name="Close")
    return _ohlcv_from_close(close, seed)


def sideways(n: int = 800, seed: int = 3, mean: float = 100.0, theta: float = 0.15, sigma: float = 1.2) -> pd.DataFrame:
    """평균회귀(OU 프로세스) — 횡보/저ADX 구간 시뮬레이션용."""
    idx = _bdate_index(n)
    rng = np.random.default_rng(seed)
    price = np.empty(n)
    price[0] = mean
    for t in range(1, n):
        price[t] = price[t - 1] + theta * (mean - price[t - 1]) + rng.normal(0, sigma)
    close = pd.Series(price, index=idx, name="Close")
    return _ohlcv_from_close(close, seed)


def spike(n: int = 800, seed: int = 4, spike_frac: float = 0.85) -> pd.DataFrame:
    """장기 평탄 구간 후 막판 급등 — 52주 신고가 근접 테스트용."""
    base_n = int(n * spike_frac)
    rally_n = n - base_n
    idx = _bdate_index(n)
    rng = np.random.default_rng(seed)
    base_rets = rng.normal(0.0002, 0.008, base_n)
    rally_rets = rng.normal(0.004, 0.01, rally_n)
    rets = np.concatenate([base_rets, rally_rets])
    close = pd.Series(100 * np.cumprod(1 + rets), index=idx, name="Close")
    return _ohlcv_from_close(close, seed)
