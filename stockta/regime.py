"""시장 국면 필터 + 게이트 판정. 점수 합산과 분리된 선행 조건."""
from dataclasses import dataclass

import pandas as pd

from . import config, indicators


@dataclass
class GateResult:
    name: str
    passed: bool
    detail: str


@dataclass
class GateReport:
    gates: list[GateResult]
    score_dampen: float  # 최종 점수에 곱할 계수 (G3 미달 시 0.7)
    blocked: bool  # True면 매수 판정 자체를 내지 않음 (G1/G2)
    block_reason: str | None


def evaluate_market_gate(bench_df: pd.DataFrame) -> GateResult:
    """G1만 단독 평가. 시장 국면 헤더 라인처럼 개별 종목 데이터 없이 쓸 때 사용."""
    bench_close = bench_df["Close"]
    bench_sma200 = indicators.sma(bench_close, 200).iloc[-1]
    bench_last = bench_close.iloc[-1]
    g1_pass = bool(bench_last > bench_sma200)
    return GateResult(
        "G1 시장 국면",
        g1_pass,
        f"지수 {bench_last:,.0f} vs SMA200 {bench_sma200:,.0f}",
    )


def evaluate_gates(
    stock_df: pd.DataFrame,
    bench_df: pd.DataFrame,
    next_earnings_days: int | None,
) -> GateReport:
    gates: list[GateResult] = []
    dampen = 1.0
    blocked = False
    block_reason = None

    g1 = evaluate_market_gate(bench_df)
    gates.append(g1)
    if not g1.passed:
        blocked = True
        block_reason = "시장 하락국면 — 신규 진입 보류"

    # G2. 종목 장기 국면: Close > SMA200
    stock_close = stock_df["Close"]
    stock_sma200 = indicators.sma(stock_close, 200).iloc[-1]
    stock_last = stock_close.iloc[-1]
    g2_pass = bool(stock_last > stock_sma200)
    gates.append(
        GateResult(
            "G2 종목 장기 국면",
            g2_pass,
            f"종가 {stock_last:,.2f} vs SMA200 {stock_sma200:,.2f}",
        )
    )
    if not g2_pass:
        blocked = True
        block_reason = block_reason or "진입 부적합"

    # G3. 추세 유효성: ADX(14) >= 20
    adx_val = indicators.adx(stock_df, 14).iloc[-1]
    g3_pass = bool(adx_val >= config.GATE_ADX_MIN)
    gates.append(GateResult("G3 추세 유효성", g3_pass, f"ADX {adx_val:.1f}"))
    if not g3_pass:
        dampen = config.GATE_ADX_SCORE_DAMPEN

    # G4. 실적 임박: 다음 실적일까지 7일 초과
    if next_earnings_days is None:
        gates.append(GateResult("G4 실적 임박", True, "실적일 정보 없음"))
    else:
        g4_pass = next_earnings_days > config.GATE_EARNINGS_DAYS
        gates.append(
            GateResult("G4 실적 임박", g4_pass, f"D-{next_earnings_days}")
        )

    return GateReport(gates=gates, score_dampen=dampen, blocked=blocked, block_reason=block_reason)
