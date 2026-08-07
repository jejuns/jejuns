"""청산 판정. 평상시엔 신호를 내지 않고 손실이 임계 초과일 때만 활성화된다."""
from dataclasses import dataclass
from datetime import date

import pandas as pd

from . import indicators


@dataclass
class ExitResult:
    ticker: str
    pnl_pct: float
    gate_on: bool
    grade: str
    evidence: str
    trailing_triggered: bool
    trailing_evidence: str | None
    warnings: list[str]


def _trend_warnings(stock_df: pd.DataFrame, weekly_df: pd.DataFrame, bench_df: pd.DataFrame) -> list[str]:
    warnings = []
    close = stock_df["Close"]
    sma200 = indicators.sma(close, 200)

    w_close = weekly_df["Close"]
    w_ema10 = indicators.ema(w_close, 10).iloc[-1]
    w_ema30 = indicators.ema(w_close, 30).iloc[-1]
    if w_ema10 < w_ema30:
        warnings.append("⚠️ 주봉 데드크로스 (EMA10 < EMA30)")

    if close.iloc[-1] < sma200.iloc[-1]:
        warnings.append("⚠️ 200일선 하향 이탈")

    rs = indicators.rs_line(close, bench_df["Close"])
    rs_slope = indicators.slope_pct(rs, 60).iloc[-1]
    if rs_slope < 0:
        warnings.append(f"⚠️ RS Line 60일 기울기 음전환 ({rs_slope:+.1%}) — 시장 대비 뒤처지기 시작")

    return warnings


def evaluate_exit(
    ticker: str,
    stock_df: pd.DataFrame,
    weekly_df: pd.DataFrame,
    bench_df: pd.DataFrame,
    avg_price: float,
    buy_date: str,
    stop_loss_pct: float,
    trailing_pct: float | None = None,
) -> ExitResult:
    close = stock_df["Close"]
    current_price = close.iloc[-1]
    pnl_pct = (current_price / avg_price - 1) * 100

    gate_on = bool(pnl_pct <= stop_loss_pct)

    if not gate_on:
        grade, evidence = "HOLD", (
            f"평단 {avg_price:,.0f} / 현재 {current_price:,.0f} / "
            f"수익률 {pnl_pct:+.1f}% (임계 {stop_loss_pct:+.1f}% 이내) → 게이트 OFF"
        )
    else:
        sma200 = indicators.sma(close, 200)
        sma200_last = sma200.iloc[-1]
        sma200_slope = indicators.slope_pct(sma200, 20).iloc[-1]
        below_sma200 = bool(current_price < sma200_last)

        if below_sma200 and sma200_slope < 0:
            grade = "전량 청산"
        elif below_sma200:
            grade = "부분 청산 50%"
        else:
            grade = "관찰"

        evidence = (
            f"평단 {avg_price:,.0f} / 현재 {current_price:,.0f} / "
            f"수익률 {pnl_pct:+.1f}% (임계 {stop_loss_pct:+.1f}% 하회) → 게이트 ON / "
            f"SMA200 {sma200_last:,.0f} (기울기 {sma200_slope:+.1%})"
        )

    trailing_triggered = False
    trailing_evidence = None
    if trailing_pct is not None:
        buy_dt = pd.Timestamp(buy_date)
        since_buy = close[close.index >= buy_dt]
        if len(since_buy) > 0:
            peak = since_buy.max()
            drawdown_pct = (current_price / peak - 1) * 100
            if drawdown_pct < trailing_pct:
                trailing_triggered = True
            trailing_evidence = (
                f"매수일 이후 최고가 {peak:,.0f} 대비 {drawdown_pct:+.1f}% "
                f"(임계 {trailing_pct:+.1f}%)"
            )

    warnings = _trend_warnings(stock_df, weekly_df, bench_df)

    return ExitResult(
        ticker=ticker,
        pnl_pct=pnl_pct,
        gate_on=gate_on,
        grade="이익보호 청산" if trailing_triggered else grade,
        evidence=evidence,
        trailing_triggered=trailing_triggered,
        trailing_evidence=trailing_evidence,
        warnings=warnings,
    )
