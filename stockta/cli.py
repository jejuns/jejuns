"""python -m stockta analyze [tickers...] [--html out.html]"""
import argparse
import os
import sys
from datetime import date
from pathlib import Path

import yaml

from . import config, entry, exit as exit_mod, fetch, indicators, plan as plan_mod, regime, report


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _load_universe(root: Path):
    positions_data = _load_yaml(root / "positions.yaml")
    watchlist_data = _load_yaml(root / "watchlist.yaml")

    positions = {p["ticker"]: p for p in positions_data.get("positions", [])}
    watchlist = watchlist_data.get("watchlist", [])
    wl_defaults = watchlist_data.get("defaults", {})
    return positions, watchlist, wl_defaults


def _earnings_days_until(earnings_date) -> int | None:
    if earnings_date is None:
        return None
    try:
        d = earnings_date if hasattr(earnings_date, "year") else None
        if d is None:
            return None
        days = (d - date.today()).days
        return days if days >= 0 else None
    except Exception:
        return None


_ENTRY_SIGNAL_VERDICTS = {"적극 매수", "분할 매수"}
_EXIT_SIGNAL_GRADES = {"전량 청산", "부분 청산 50%", "이익보호 청산"}


def analyze_ticker(ticker: str, positions: dict, wl_defaults: dict) -> tuple[str, bool]:
    stock_df = fetch.fetch_ohlcv(ticker)
    weekly_df = fetch.resample_weekly(stock_df)
    bench_df = fetch.benchmark_for_ticker(ticker)
    is_kr = fetch.is_kr_ticker(ticker)
    kr_supply = fetch.fetch_kr_supply(ticker) if is_kr else None

    earnings_date = fetch.fetch_next_earnings_date(ticker)
    earnings_days = _earnings_days_until(earnings_date)

    gate_report = regime.evaluate_gates(stock_df, bench_df, earnings_days)
    entry_result = entry.score_entry(ticker, stock_df, weekly_df, bench_df, gate_report, is_kr, kr_supply)

    close = stock_df["Close"]
    current_price = close.iloc[-1]
    sma50 = indicators.sma(close, 50).iloc[-1]
    sma200 = indicators.sma(close, 200).iloc[-1]
    atr14 = indicators.atr(stock_df, 14).iloc[-1]

    position = positions.get(ticker)
    stop_loss_pct = (
        position["stop_loss_pct"] if position else wl_defaults.get("stop_loss_pct", config.DEFAULT_STOP_LOSS_PCT)
    )
    reference_price = position["avg_price"] if position else None

    buy_plan = plan_mod.build_plan(
        current_price=current_price,
        sma50=sma50,
        sma200=sma200,
        atr14=atr14,
        stop_loss_pct=stop_loss_pct,
        verdict=entry_result.verdict,
        earnings_warning=not gate_report.gates[3].passed,
        reference_price=reference_price,
    )

    blocks = [report.render_entry_block(entry_result, buy_plan)]
    has_signal = entry_result.verdict in _ENTRY_SIGNAL_VERDICTS

    if position is not None:
        exit_result = exit_mod.evaluate_exit(
            ticker=ticker,
            stock_df=stock_df,
            weekly_df=weekly_df,
            bench_df=bench_df,
            avg_price=position["avg_price"],
            buy_date=position["buy_date"],
            stop_loss_pct=position["stop_loss_pct"],
            trailing_pct=position.get("trailing_pct"),
        )
        blocks.append(report.render_exit_block(exit_result))
        has_signal = has_signal or exit_result.grade in _EXIT_SIGNAL_GRADES

    return "\n\n".join(blocks), has_signal


def cmd_analyze(args) -> int:
    root = Path.cwd()
    positions, watchlist, wl_defaults = _load_universe(root)

    tickers = args.tickers if args.tickers else list(positions.keys()) + [t for t in watchlist if t not in positions]
    tickers = list(dict.fromkeys(tickers))  # 중복 제거, 순서 유지

    if not tickers:
        print("분석할 종목이 없습니다. positions.yaml / watchlist.yaml을 채우거나 티커를 직접 지정하세요.")
        return 1

    market_line_printed = set()
    output_sections = []
    any_signal = False

    for ticker in tickers:
        try:
            bench_df = fetch.benchmark_for_ticker(ticker)
            if fetch.is_kr_ticker(ticker):
                symbol = config.BENCH_KQ if fetch.kr_market_suffix(ticker) == ".KQ" else config.BENCH_KR
            else:
                symbol = config.BENCH_US
            if symbol not in market_line_printed:
                g1 = regime.evaluate_market_gate(bench_df)
                output_sections.append(report.render_market_regime_line(symbol, g1))
                market_line_printed.add(symbol)
        except Exception:
            pass

        try:
            block, has_signal = analyze_ticker(ticker, positions, wl_defaults)
            output_sections.append(block)
            any_signal = any_signal or has_signal
        except Exception as e:
            output_sections.append(f"⚠️ {ticker} 분석 실패: {e}")

    full_report = "\n\n".join(output_sections)
    print(full_report)

    report.write_job_summary(full_report)
    Path("report.md").write_text(full_report, encoding="utf-8")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"has_signal={'true' if any_signal else 'false'}\n")

    if args.html:
        html = f"<html><body><pre>{full_report}</pre></body></html>"
        Path(args.html).write_text(html, encoding="utf-8")
        print(f"\nHTML 리포트 저장: {args.html}")

    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="stockta")
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyze = sub.add_parser("analyze", help="종목 매수/매도 판정 실행")
    p_analyze.add_argument("tickers", nargs="*", help="분석할 티커 (비우면 positions/watchlist 전체)")
    p_analyze.add_argument("--html", help="HTML 리포트 출력 경로")
    p_analyze.set_defaults(func=cmd_analyze)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
