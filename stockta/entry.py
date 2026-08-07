"""매수 스코어링. 각 규칙은 Rule로 기록되어 보고서에 전부 노출된다."""
from dataclasses import dataclass, field

import pandas as pd

from . import config, indicators
from .regime import GateReport


@dataclass
class Rule:
    name: str
    category: str
    weight: float  # 이 규칙의 최대 배점
    passed: bool  # 체크 표시용 (기여도 > 0)
    value: str  # 사람이 읽을 지표 값
    contribution: float  # 실제 반영 점수 (음수 가능)
    comment: str = ""


@dataclass
class EntryResult:
    ticker: str
    rules: list[Rule]
    category_totals: dict
    raw_score: float
    final_score: float  # 게이트 감쇠 반영
    verdict: str
    action: str
    gate_report: GateReport


def _rule(name, category, weight, contribution, value, comment="") -> Rule:
    return Rule(name, category, weight, passed=contribution > 0, value=value, contribution=contribution, comment=comment)


def _category_a(stock_df: pd.DataFrame, weekly_df: pd.DataFrame) -> list[Rule]:
    rules = []
    close = stock_df["Close"]
    sma200 = indicators.sma(close, 200)
    slope = indicators.slope_pct(sma200, 20).iloc[-1]
    contrib = 10 if slope > 0 else -10
    rules.append(_rule("200일선 상승", "A", 10, contrib, f"{slope:+.1%}"))

    ema50 = indicators.ema(close, 50).iloc[-1]
    sma200_last = sma200.iloc[-1]
    contrib = 5 if ema50 > sma200_last else -5
    rules.append(_rule("중기 정배열", "A", 5, contrib, f"EMA50 {ema50:,.2f} vs SMA200 {sma200_last:,.2f}"))

    w_close = weekly_df["Close"]
    w_ema10 = indicators.ema(w_close, 10).iloc[-1]
    w_ema30 = indicators.ema(w_close, 30).iloc[-1]
    contrib = 5 if w_ema10 > w_ema30 else -5
    rules.append(_rule("주봉 추세", "A", 5, contrib, f"EMA10 {w_ema10:,.2f} vs EMA30 {w_ema30:,.2f}"))
    return rules


def _category_b(stock_df: pd.DataFrame, bench_df: pd.DataFrame) -> list[Rule]:
    rules = []
    close = stock_df["Close"]
    bench_close = bench_df["Close"]

    rs = indicators.rs_line(close, bench_close)
    rs_slope = indicators.slope_pct(rs, 60).iloc[-1]
    contrib = 10 if rs_slope > 0 else -10
    rules.append(_rule("RS Line 상승", "B", 10, contrib, f"{rs_slope:+.1%}"))

    rel_ret = indicators.rel_return(close, bench_close, 252).iloc[-1]
    if rel_ret > 0.20:
        contrib, cmt = 12, "지수 대비 +20%p 초과"
    elif rel_ret > 0:
        contrib, cmt = 8, ""
    else:
        contrib, cmt = 0, ""
    rules.append(_rule("12개월 상대수익률", "B", 12, contrib, f"{rel_ret:+.1%}p", cmt))

    rs_252_high = rs.rolling(252, min_periods=1).max().iloc[-1]
    rs_last = rs.iloc[-1]
    near_high = rs_last >= 0.95 * rs_252_high
    contrib = 3 if near_high else 0
    rules.append(_rule("RS Line 신고가", "B", 3, contrib, f"{rs_last / rs_252_high:.1%}"))
    return rules


def _category_c(stock_df: pd.DataFrame) -> list[Rule]:
    rules = []
    close = stock_df["Close"]

    pct_high = indicators.pct_from_52w_high(stock_df).iloc[-1]
    if pct_high >= -0.15:
        contrib, cmt = 12, "신고가 근접 — 장기 우위"
    elif pct_high >= -0.30:
        contrib, cmt = 4, ""
    else:
        contrib, cmt = -8, "추세 훼손 의심"
    rules.append(_rule("52주 고점 근접", "C", 12, contrib, f"{pct_high:+.1%}", cmt))

    sma200_last = indicators.sma(close, 200).iloc[-1]
    disp = close.iloc[-1] / sma200_last - 1
    if disp > 0.30:
        contrib, cmt = -10, "과열"
    elif 0 <= disp <= 0.20:
        contrib, cmt = 5, ""
    else:
        contrib, cmt = 0, ""
    rules.append(_rule("SMA200 이격도", "C", 5, contrib, f"{disp:+.1%}", cmt))

    _, _, _, pct_b = indicators.bollinger(close, 20, 2)
    pb = pct_b.iloc[-1]
    if pb > 1.05:
        contrib, cmt = -5, "단기 과열"
    elif 0.4 <= pb <= 0.9:
        contrib, cmt = 3, ""
    else:
        contrib, cmt = 0, ""
    rules.append(_rule("볼린저 %B", "C", 3, contrib, f"{pb:.2f}", cmt))
    return rules


def _category_d(stock_df: pd.DataFrame, weekly_df: pd.DataFrame, trend_a_positive: bool) -> list[Rule]:
    rules = []
    close = stock_df["Close"]

    w_rsi = indicators.rsi(weekly_df["Close"], 14).iloc[-1]
    if w_rsi >= 80:
        contrib, cmt = -8, "과열"
    elif 45 <= w_rsi <= 70:
        contrib, cmt = 7, ""
    elif w_rsi <= 35 and trend_a_positive:
        contrib, cmt = 3, "눌림목 반등 기대"
    else:
        contrib, cmt = 0, ""
    rules.append(_rule("주봉 RSI", "D", 7, contrib, f"{w_rsi:.1f}", cmt))

    _, _, hist = indicators.macd(close)
    recent = hist.iloc[-6:]
    crossed = any(
        recent.iloc[i - 1] < 0 and recent.iloc[i] >= 0 for i in range(1, len(recent))
    )
    contrib = 5 if crossed else 0
    rules.append(_rule("MACD 히스토그램 전환", "D", 5, contrib, "음→양" if crossed else "-"))

    mom = indicators.mom_12_1(close).iloc[-1]
    contrib = 3 if mom > 0 else -3
    rules.append(_rule("12-1 절대 모멘텀", "D", 3, contrib, f"{mom:+.1%}"))
    return rules


def _category_e(stock_df: pd.DataFrame, is_kr: bool, kr_supply: dict | None) -> list[Rule]:
    rules = []
    obv = indicators.obv(stock_df)
    obv_slope = indicators.slope_pct(obv, 20).iloc[-1]

    vol = stock_df["Volume"]
    vol5 = vol.rolling(5).mean().iloc[-1]
    vol20 = vol.rolling(20).mean().iloc[-1]
    vol_confirmed = vol5 > vol20

    if is_kr:
        obv_max, vol_max = 8, 4
    else:
        scale = (8 + 4 + 8) / (8 + 4)  # 한국 전용 8점을 OBV·거래량에 비례 재분배
        obv_max, vol_max = 8 * scale, 4 * scale

    contrib = obv_max if obv_slope > 0 else -5
    rules.append(_rule("OBV 상승", "E", obv_max, contrib, f"{obv_slope:+.1%}"))

    contrib = vol_max if vol_confirmed else 0
    rules.append(_rule("거래량 확인", "E", vol_max, contrib, f"5일 {vol5:,.0f} vs 20일 {vol20:,.0f}"))

    if is_kr:
        if kr_supply is None:
            rules.append(_rule("[한국] 외국인 순매수", "E", 4, 0, "N/A", "수급 데이터 조회 실패"))
            rules.append(_rule("[한국] 기관 순매수", "E", 4, 0, "N/A", "수급 데이터 조회 실패"))
        else:
            f_net = kr_supply["foreign_net"]
            i_net = kr_supply["institution_net"]
            rules.append(_rule("[한국] 외국인 순매수", "E", 4, 4 if f_net > 0 else 0, f"{f_net:,.0f}"))
            rules.append(_rule("[한국] 기관 순매수", "E", 4, 4 if i_net > 0 else 0, f"{i_net:,.0f}"))

    price_up = stock_df["Close"].iloc[-1] > stock_df["Close"].iloc[-20]
    obv_down = obv.iloc[-1] < obv.iloc[-20]
    diverging = price_up and obv_down
    contrib = -8 if diverging else 0
    rules.append(_rule("약세 다이버전스", "E", 0, contrib, "있음" if diverging else "없음"))
    return rules


def _verdict(score: float) -> tuple[str, str]:
    if score >= config.SCORE_STRONG_BUY:
        return "적극 매수", "1차 50% 진입"
    if score >= config.SCORE_PARTIAL_BUY:
        return "분할 매수", "1차 30% 진입"
    if score >= config.SCORE_WATCH:
        return "관망", "진입 보류"
    return "진입 부적합", "미진입"


def score_entry(
    ticker: str,
    stock_df: pd.DataFrame,
    weekly_df: pd.DataFrame,
    bench_df: pd.DataFrame,
    gate_report: GateReport,
    is_kr: bool,
    kr_supply: dict | None,
) -> EntryResult:
    rules_a = _category_a(stock_df, weekly_df)
    rules_b = _category_b(stock_df, bench_df)
    rules_c = _category_c(stock_df)
    trend_a_positive = sum(r.contribution for r in rules_a) > 0
    rules_d = _category_d(stock_df, weekly_df, trend_a_positive)
    rules_e = _category_e(stock_df, is_kr, kr_supply)

    all_rules = rules_a + rules_b + rules_c + rules_d + rules_e
    category_totals = {}
    for cat in ("A", "B", "C", "D", "E"):
        category_totals[cat] = sum(r.contribution for r in all_rules if r.category == cat)

    raw_score = sum(category_totals.values())
    final_score = min(raw_score * gate_report.score_dampen, 100.0)

    if gate_report.blocked:
        verdict, action = gate_report.block_reason, "미진입"
    else:
        verdict, action = _verdict(final_score)

    return EntryResult(
        ticker=ticker,
        rules=all_rules,
        category_totals=category_totals,
        raw_score=raw_score,
        final_score=final_score,
        verdict=verdict,
        action=action,
        gate_report=gate_report,
    )
