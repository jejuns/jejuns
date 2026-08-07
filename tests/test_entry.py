import pytest

from stockta import entry, fetch, regime
from tests import synth


def test_normalize_score_clamps_without_linear_rescale():
    """CHECK 2 회귀 테스트 — 전 규칙 충족(+100)은 그대로 100, 전 규칙 미충족(-77)은
    0으로 클램프되어야 한다. (raw+77)/177*100 같은 선형 재조정을 쓰면 원점수 70이
    "적극 매수" 임계와 어긋나게 되므로 이를 방지한다."""
    assert entry._normalize_score(100, 1.0) == pytest.approx(100)
    assert entry._normalize_score(-77, 1.0) == pytest.approx(0)
    assert entry._normalize_score(70, 1.0) == pytest.approx(70)
    assert entry._normalize_score(-10, 1.0) == pytest.approx(0)
    assert entry._normalize_score(150, 1.0) == pytest.approx(100)  # 상한 안전장치
    assert entry._normalize_score(100, 0.7) == pytest.approx(70)  # G3 감쇠 반영


def test_relative_strength_penalizes_underperformance():
    bench = synth.uptrend(n=400, seed=501, mu=0.003, sigma=0.005)
    stock = synth.uptrend(n=400, seed=502, mu=0.0002, sigma=0.005)
    weekly = fetch.resample_weekly(stock)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry("WEAK", stock, weekly, bench, gate_report, is_kr=False, kr_supply=None)

    assert result.category_totals["B"] < 0


def test_52w_high_proximity_scores_positive_sign_fix_regression():
    """초안은 52주 고점 근접을 감점했으나, 6~12개월 보유 구간에서는 신고가 근접이 우위(George & Hwang 2004).
    부호가 원래대로 되돌아가지 않는지 확인하는 회귀 테스트."""
    stock = synth.spike(n=400, seed=601)
    weekly = fetch.resample_weekly(stock)
    bench = synth.uptrend(n=400, seed=602, mu=0.0008, sigma=0.006)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry("SPIKE", stock, weekly, bench, gate_report, is_kr=False, kr_supply=None)

    rule = next(r for r in result.rules if r.name == "52주 고점 근접")
    assert rule.contribution > 0


def test_deep_pullback_from_high_penalized():
    stock = synth.downtrend(n=400, seed=701, mu=-0.002, sigma=0.008)
    weekly = fetch.resample_weekly(stock)
    bench = synth.uptrend(n=400, seed=702, mu=0.0005, sigma=0.006)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry("DOWN", stock, weekly, bench, gate_report, is_kr=False, kr_supply=None)

    rule = next(r for r in result.rules if r.name == "52주 고점 근접")
    assert rule.contribution < 0


def test_kr_ticker_with_missing_supply_data_still_has_category_max_20():
    """CHECK 1 회귀 테스트 — 재분배 조건은 국가가 아니라 데이터 가용성이어야 한다.
    pykrx가 실패해 kr_supply가 None이면(현재 이 환경의 실제 상황), 한국 종목도
    미국과 동일하게 OBV/거래량으로 재분배해 카테고리 만점이 20이어야 한다.
    (예전 코드는 is_kr만 보고 재분배를 안 해서 만점이 12로 깎였다.)"""
    stock = synth.uptrend(n=400, seed=851)
    weekly = fetch.resample_weekly(stock)
    bench = synth.uptrend(n=400, seed=852)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry(
        "005930", stock, weekly, bench, gate_report, is_kr=True, kr_supply=None
    )

    e_rules = [r for r in result.rules if r.category == "E"]
    max_possible = sum(r.weight for r in e_rules if r.weight > 0)
    assert max_possible == pytest.approx(20)


def test_kr_ticker_adds_supply_rules():
    stock = synth.uptrend(n=400, seed=801)
    weekly = fetch.resample_weekly(stock)
    bench = synth.uptrend(n=400, seed=802)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry(
        "005930", stock, weekly, bench, gate_report, is_kr=True, kr_supply={"foreign_net": 1000, "institution_net": -500}
    )

    names = [r.name for r in result.rules]
    assert "[한국] 외국인 순매수" in names
    assert "[한국] 기관 순매수" in names


def test_us_ticker_redistributes_supply_weight_to_keep_category_max_20():
    stock = synth.uptrend(n=400, seed=901)
    weekly = fetch.resample_weekly(stock)
    bench = synth.uptrend(n=400, seed=902)
    gate_report = regime.evaluate_gates(stock, bench, None)

    result = entry.score_entry("AAPL", stock, weekly, bench, gate_report, is_kr=False, kr_supply=None)

    e_rules = [r for r in result.rules if r.category == "E" and "한국" not in r.name]
    max_possible = sum(r.weight for r in e_rules if r.weight > 0)
    assert max_possible == pytest.approx(20)
