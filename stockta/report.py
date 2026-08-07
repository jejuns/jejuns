"""콘솔 표 + GitHub Job Summary 마크다운 렌더."""
import os

from . import config
from .entry import EntryResult
from .exit import ExitResult
from .plan import BuyPlan
from .regime import GateReport

_CATEGORY_LABELS = {
    "A": ("추세", config.WEIGHT_TREND),
    "B": ("상대강도", config.WEIGHT_RS),
    "C": ("위치", config.WEIGHT_POSITION),
    "D": ("모멘텀", config.WEIGHT_MOMENTUM),
    "E": ("수급", config.WEIGHT_SUPPLY),
}


def _mark(contribution: float) -> str:
    if contribution > 0:
        return "✅"
    if contribution < 0:
        return "❌"
    return "⬜"


def render_market_regime_line(symbol: str, g1, warning: str | None = None) -> str:
    status = "✅ 강세국면 (G1 통과)" if g1.passed else "🔻 약세국면 (G1 미통과)"
    line = f"━━ 시장 국면 ({symbol}): {g1.detail} → {status}"
    if warning:
        line += f"\n⚠️ 벤치마크: {warning}"
    return line


def _render_gates_line(gate_report: GateReport) -> str:
    parts = []
    for i, g in enumerate(gate_report.gates):
        name = g.name.split(" ", 1)[0]  # "G1", "G2", ...
        if g.name.startswith("G4"):
            mark = "✅" if g.passed else "⚠️"
        else:
            mark = "✅" if g.passed else "❌"
        parts.append(f"{mark} {g.name} {g.detail}")
    return "게이트  " + "  ".join(parts)


def _render_category_line(category: str, rules) -> str:
    label, weight = _CATEGORY_LABELS[category]
    cat_rules = [r for r in rules if r.category == category]
    pieces = [f"[{label} {weight}%]"]
    for r in cat_rules:
        pieces.append(f"{_mark(r.contribution)} {r.name} {r.value} ({r.contribution:+.0f})")
    return " ".join(pieces)


def render_entry_block(entry_result: EntryResult, plan: BuyPlan | None) -> str:
    lines = []
    verdict_icon = {
        "적극 매수": "🟢",
        "분할 매수": "🟡",
        "관망": "⚪",
        "진입 부적합": "🔴",
    }.get(entry_result.verdict, "🔴")

    lines.append(
        f"━━ {entry_result.ticker} — 매수 스코어 {entry_result.final_score:.0f}/100 "
        f"→ {verdict_icon} {entry_result.verdict} ━━"
    )
    lines.append(_render_gates_line(entry_result.gate_report))

    for cat in ("A", "B", "C", "D", "E"):
        lines.append(_render_category_line(cat, entry_result.rules))

    g4 = entry_result.gate_report.gates[3]
    if not g4.passed:
        lines.append(f"\n⚠️ 실적 임박({g4.detail}) — 1차 비중을 축소하거나 발표 후 진입 권장")

    if plan is not None:
        tranche_strs = []
        for t in plan.tranches:
            if t.price is None:
                tranche_strs.append(f"{t.label} 생략({t.note})")
            else:
                tranche_strs.append(f"{t.label} {t.price:,.2f} ({t.weight_pct:.0f}%)")
        lines.append("분할매수: " + " / ".join(tranche_strs))
        lines.append(f"손절선: {plan.stop_loss:,.2f}")

        if plan.alt_plan_tranches is not None:
            alt_strs = []
            for t in plan.alt_plan_tranches:
                if t.price is None:
                    alt_strs.append(f"{t.label} 생략")
                else:
                    alt_strs.append(f"{t.label} {t.price:,.2f} ({t.weight_pct:.0f}%)")
            lines.append("대안 플랜(실적 후): " + " / ".join(alt_strs))

    return "\n".join(lines)


def render_exit_block(exit_result: ExitResult) -> str:
    lines = [f"━━ {exit_result.ticker} — 청산 판정: {exit_result.grade} ━━", exit_result.evidence]
    if exit_result.trailing_evidence:
        icon = "🚨" if exit_result.trailing_triggered else "ℹ️"
        lines.append(f"{icon} 트레일링 스탑: {exit_result.trailing_evidence}")
    for w in exit_result.warnings:
        lines.append(w)
    return "\n".join(lines)


def write_job_summary(text: str) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as f:
        f.write("```\n")
        f.write(text)
        f.write("\n```\n")
