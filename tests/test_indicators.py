import numpy as np
import pandas as pd
import pytest

from stockta import indicators
from tests import synth


def test_sma_hand_calc():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    result = indicators.sma(s, 3)
    assert result.iloc[:2].isna().all()
    assert result.iloc[2] == pytest.approx(2.0)
    assert result.iloc[3] == pytest.approx(3.0)
    assert result.iloc[4] == pytest.approx(4.0)


def test_ema_hand_calc():
    # span=3 -> alpha=0.5, adjust=False
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    result = indicators.ema(s, 3)
    expected = [1.0, 1.5, 2.25, 3.125, 4.0625]
    for got, want in zip(result, expected):
        assert got == pytest.approx(want)


def test_slope_pct_hand_calc():
    s = pd.Series([100, 100, 100, 100, 110], dtype=float)
    result = indicators.slope_pct(s, 4)
    assert result.iloc[4] == pytest.approx(0.10)


def test_obv_hand_calc():
    close = pd.Series([10, 11, 10, 12, 12], dtype=float)
    volume = pd.Series([100, 200, 150, 300, 120], dtype=float)
    df = pd.DataFrame({"Close": close, "Volume": volume})
    result = indicators.obv(df)
    expected = [0, 200, 50, 350, 350]
    for got, want in zip(result, expected):
        assert got == pytest.approx(want)


def _reference_wilder_rsi(closes: list[float], n: int = 14) -> float:
    """루프 기반 독립 구현 (ewm(alpha=1/n, adjust=False)와 동일한 재귀) — 벡터화 구현과 교차검증."""
    gains, losses = [], []
    for i in range(1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gains.append(max(delta, 0))
        losses.append(max(-delta, 0))
    alpha = 1 / n
    avg_gain, avg_loss = gains[0], losses[0]
    for i in range(1, len(gains)):
        avg_gain = alpha * gains[i] + (1 - alpha) * avg_gain
        avg_loss = alpha * losses[i] + (1 - alpha) * avg_loss
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def test_rsi_matches_wilder_reference():
    rng = np.random.default_rng(42)
    closes = list(100 + np.cumsum(rng.normal(0, 1, 60)))
    s = pd.Series(closes)
    got = indicators.rsi(s, 14).iloc[-1]
    want = _reference_wilder_rsi(closes, 14)
    assert got == pytest.approx(want, abs=1e-6)


def _reference_wilder_atr(df: pd.DataFrame, n: int = 14) -> float:
    """루프 기반 독립 구현 (ewm(alpha=1/n, adjust=False)와 동일한 재귀)."""
    trs = []
    prev_close = None
    for _, row in df.iterrows():
        if prev_close is None:
            tr = row["High"] - row["Low"]
        else:
            tr = max(row["High"] - row["Low"], abs(row["High"] - prev_close), abs(row["Low"] - prev_close))
        trs.append(tr)
        prev_close = row["Close"]
    alpha = 1 / n
    atr = trs[0]
    for i in range(1, len(trs)):
        atr = alpha * trs[i] + (1 - alpha) * atr
    return atr


def test_atr_matches_wilder_reference():
    df = synth.uptrend(n=60, seed=7)
    got = indicators.atr(df, 14).iloc[-1]
    want = _reference_wilder_atr(df, 14)
    assert got == pytest.approx(want, rel=1e-9)


def test_adx_low_in_sideways_high_in_trend():
    trend_df = synth.uptrend(n=300, seed=11, mu=0.0025, sigma=0.006)
    side_df = synth.sideways(n=300, seed=12)
    adx_trend = indicators.adx(trend_df, 14).iloc[-1]
    adx_side = indicators.adx(side_df, 14).iloc[-1]
    assert adx_trend > adx_side
    assert adx_side < 25


def test_macd_hist_sign_follows_regime():
    up = synth.uptrend(n=300, seed=21)
    down = synth.downtrend(n=300, seed=22)
    _, _, hist_up = indicators.macd(up["Close"])
    _, _, hist_down = indicators.macd(down["Close"])
    assert hist_up.iloc[-60:].mean() > 0
    assert hist_down.iloc[-60:].mean() < 0


def test_bollinger_structure():
    df = synth.uptrend(n=100, seed=31)
    upper, mid, lower, pct_b = indicators.bollinger(df["Close"], 20, 2)
    assert (upper.dropna() >= mid.dropna()).all()
    assert (lower.dropna() <= mid.dropna()).all()
    assert mid.dropna().iloc[-1] == pytest.approx(indicators.sma(df["Close"], 20).dropna().iloc[-1])


def test_mom_12_1_positive_in_uptrend():
    df = synth.uptrend(n=400, seed=41, mu=0.0015, sigma=0.01)
    mom = indicators.mom_12_1(df["Close"]).iloc[-1]
    assert mom > 0


def test_pct_from_52w_high_bounds():
    df = synth.uptrend(n=400, seed=51)
    pct = indicators.pct_from_52w_high(df).iloc[-1]
    assert -1.0 <= pct <= 1e-9


def test_rs_line_and_rel_return_reward_outperformance():
    strong = synth.uptrend(n=400, seed=61, mu=0.003, sigma=0.004)
    weak = synth.uptrend(n=400, seed=62, mu=0.0002, sigma=0.004)
    rs = indicators.rs_line(strong["Close"], weak["Close"])
    rs_slope = indicators.slope_pct(rs, 60).iloc[-1]
    rel = indicators.rel_return(strong["Close"], weak["Close"], 252).iloc[-1]
    assert rs_slope > 0
    assert rel > 0
