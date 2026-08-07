"""분할매수 플랜 / 손절선 산출."""
from dataclasses import dataclass

from . import config


@dataclass
class Tranche:
    label: str
    price: float | None
    weight_pct: float
    note: str = ""


@dataclass
class BuyPlan:
    tranches: list[Tranche]
    stop_loss: float
    alt_plan_tranches: list[Tranche] | None = None


def build_plan(
    current_price: float,
    sma50: float,
    sma200: float,
    atr14: float,
    stop_loss_pct: float,
    verdict: str,
    earnings_warning: bool,
    reference_price: float | None = None,
) -> BuyPlan | None:
    if verdict == "적극 매수":
        weights = config.TRANCHE_WEIGHTS_STRONG
    elif verdict == "분할 매수":
        weights = config.TRANCHE_WEIGHTS_PARTIAL
    else:
        return None

    reference_price = reference_price if reference_price is not None else current_price

    t1_price = current_price
    t2_price = max(sma50, current_price - config.ATR_MULT_TRANCHE2 * atr14)
    t3_price = max(sma200, current_price - config.ATR_MULT_TRANCHE3 * atr14)

    tranches = [Tranche("1차", t1_price, weights[0] * 100)]

    if t2_price < t1_price:
        tranches.append(Tranche("2차", t2_price, weights[1] * 100))
        prev_valid = t2_price
    else:
        tranches.append(Tranche("2차", None, weights[1] * 100, "현재가가 이미 지지선 근처 — 생략"))
        prev_valid = t1_price

    if t3_price < prev_valid:
        tranches.append(Tranche("3차", t3_price, weights[2] * 100))
    else:
        tranches.append(Tranche("3차", None, weights[2] * 100, "현재가가 이미 지지선 근처 — 생략"))

    stop_loss_atr = t3_price - config.ATR_MULT_STOPLOSS * atr14
    stop_loss_user = reference_price * (1 + stop_loss_pct / 100)
    stop_loss = min(stop_loss_atr, stop_loss_user)

    alt_tranches = None
    if earnings_warning:
        alt_tranches = [
            Tranche("1차", t1_price, weights[0] * 100 / 2, "실적 임박 — 비중 축소"),
            tranches[1],
            tranches[2],
        ]

    return BuyPlan(tranches=tranches, stop_loss=stop_loss, alt_plan_tranches=alt_tranches)
