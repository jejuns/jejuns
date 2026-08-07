from stockta import config, regime
from tests import synth


def test_downtrend_market_blocks_entry_even_with_strong_stock():
    bench_down = synth.downtrend(n=300, seed=101, mu=-0.0015, sigma=0.006)
    strong_stock = synth.uptrend(n=300, seed=102, mu=0.003, sigma=0.006)

    report = regime.evaluate_gates(strong_stock, bench_down, next_earnings_days=None)

    assert report.blocked is True
    assert report.block_reason == "시장 하락국면 — 신규 진입 보류"
    assert report.gates[0].passed is False


def test_uptrend_market_and_stock_pass_g1_g2():
    bench_up = synth.uptrend(n=300, seed=201, mu=0.0015, sigma=0.006)
    stock_up = synth.uptrend(n=300, seed=202, mu=0.0015, sigma=0.006)

    report = regime.evaluate_gates(stock_up, bench_up, next_earnings_days=None)

    assert report.gates[0].passed is True  # G1
    assert report.gates[1].passed is True  # G2
    assert report.blocked is False


def test_low_adx_dampens_score_30pct():
    bench_up = synth.uptrend(n=300, seed=301, mu=0.0015, sigma=0.006)
    sideways_stock = synth.sideways(n=300, seed=302)

    report = regime.evaluate_gates(sideways_stock, bench_up, next_earnings_days=None)

    assert report.gates[2].passed is False  # G3 ADX < 20
    assert report.score_dampen == config.GATE_ADX_SCORE_DAMPEN


def test_earnings_within_window_flagged_not_blocking():
    bench_up = synth.uptrend(n=300, seed=401, mu=0.0015, sigma=0.006)
    stock_up = synth.uptrend(n=300, seed=402, mu=0.0015, sigma=0.006)

    report = regime.evaluate_gates(stock_up, bench_up, next_earnings_days=3)

    assert report.gates[3].passed is False
    assert report.blocked is False  # G4는 진입을 막지 않음
