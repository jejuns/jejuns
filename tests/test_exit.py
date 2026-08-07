import pandas as pd

from stockta import exit as exit_mod, fetch
from tests import synth


def _setup(stock_df):
    weekly = fetch.resample_weekly(stock_df)
    bench = synth.uptrend(n=len(stock_df), seed=999, mu=0.0005, sigma=0.006)
    return weekly, bench


def test_small_loss_within_threshold_holds():
    stock = synth.uptrend(n=300, seed=1001, mu=0.0002, sigma=0.006)
    weekly, bench = _setup(stock)
    avg_price = stock["Close"].iloc[-1] / 0.95  # 현재가가 평단 대비 -5%

    result = exit_mod.evaluate_exit(
        "T1", stock, weekly, bench, avg_price=avg_price, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-10,
    )

    assert result.gate_on is False
    assert result.grade == "HOLD"


def test_deep_loss_with_broken_trend_triggers_full_exit():
    stock = synth.downtrend(n=300, seed=1002, mu=-0.002, sigma=0.008)
    weekly, bench = _setup(stock)
    avg_price = stock["Close"].iloc[-1] / 0.88  # 현재가가 평단 대비 -12%

    result = exit_mod.evaluate_exit(
        "T2", stock, weekly, bench, avg_price=avg_price, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-10,
    )

    assert result.gate_on is True
    assert result.pnl_pct == -12.0 or result.pnl_pct < -10
    assert result.grade == "전량 청산"


def test_loss_with_sma200_still_rising_triggers_partial_exit():
    # 완만한 상승추세 중 최근 급락으로 손실 임계는 넘었지만 200일선 기울기는 아직 양수
    n, crash_n = 300, 15
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n)
    import numpy as np

    rng = np.random.default_rng(1003)
    rets = rng.normal(0.002, 0.005, n - crash_n).tolist() + rng.normal(-0.02, 0.005, crash_n).tolist()
    close = pd.Series(100 * pd.Series(rets).add(1).cumprod().values, index=idx)
    from tests.synth import _ohlcv_from_close

    stock = _ohlcv_from_close(close, seed=1003)
    weekly, bench = _setup(stock)
    avg_price = stock["Close"].iloc[-1] / 0.85  # 현재가가 평단 대비 -15%

    result = exit_mod.evaluate_exit(
        "T3", stock, weekly, bench, avg_price=avg_price, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-10,
    )

    assert result.gate_on is True
    assert result.grade == "부분 청산 50%"


def test_currency_mismatch_avg_price_triggers_sanity_warning():
    """CHECK 5 회귀 테스트 — 미국 종목 평단을 원화로 잘못 입력한 경우
    (예: AAPL 실제 가격은 ~$300대인데 250000을 입력) 조용히 넘어가지 않고
    경고를 내야 한다."""
    stock = synth.uptrend(n=300, seed=1005, mu=0.0005, sigma=0.006)  # 종가는 대략 100대
    weekly, bench = _setup(stock)

    result = exit_mod.evaluate_exit(
        "T5", stock, weekly, bench, avg_price=250000, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-10,
    )

    assert any("통화" in w for w in result.warnings)


def test_normal_avg_price_has_no_sanity_warning():
    stock = synth.uptrend(n=300, seed=1006, mu=0.0005, sigma=0.006)
    weekly, bench = _setup(stock)
    avg_price = stock["Close"].iloc[-1]  # 현재가와 동일 — 정상 범위

    result = exit_mod.evaluate_exit(
        "T6", stock, weekly, bench, avg_price=avg_price, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-10,
    )

    assert not any("통화" in w for w in result.warnings)


def test_trailing_stop_triggers_independent_of_gate():
    stock = synth.uptrend(n=300, seed=1004, mu=0.0, sigma=0.003)
    weekly, bench = _setup(stock)
    avg_price = stock["Close"].iloc[-1] * 0.99  # 손실 임계 미달 (게이트 OFF)

    result = exit_mod.evaluate_exit(
        "T4", stock, weekly, bench, avg_price=avg_price, buy_date=str(stock.index[0].date()),
        stop_loss_pct=-50, trailing_pct=-0.001,
    )

    assert result.trailing_triggered is True
    assert result.grade == "이익보호 청산"
