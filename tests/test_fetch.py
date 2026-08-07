"""티커 판별 + 벤치마크 폴백 로직 검증. 네트워크 미사용(fetch_benchmark는 monkeypatch)."""
import pandas as pd

from stockta import fetch
from stockta.fetch import is_kr_ticker


def test_kr_ticker_detected():
    assert is_kr_ticker("005930") is True
    assert is_kr_ticker("000660") is True


def test_us_ticker_not_detected_as_kr():
    assert is_kr_ticker("AAPL") is False
    assert is_kr_ticker("NVDA") is False


def test_kr_ticker_must_be_exactly_6_digits():
    assert is_kr_ticker("12345") is False
    assert is_kr_ticker("1234567") is False
    assert is_kr_ticker("00593A") is False


def test_market_suffix_uses_krx_official_list_not_yfinance_probing(monkeypatch):
    """추가로 발견된 버그 — yfinance는 .KS/.KQ 접미사를 검증하지 않는다.
    실측 확인: 코스피 종목(000660)에 .KQ를, 코스닥 종목(247540)에 .KS를 붙여도
    yfinance가 동일한 실데이터를 그대로 반환한다. 접미사 프로빙으로는 시장을
    구분할 수 없으므로 KRX 공식 코스닥 목록으로만 판별해야 한다."""
    monkeypatch.setattr(fetch, "_kosdaq_ticker_set", lambda: frozenset({"247540"}))

    assert fetch.kr_market_suffix("247540") == (".KQ", False)
    assert fetch.kr_market_suffix("005930") == (".KS", False)


def test_market_suffix_uncertain_when_krx_list_unavailable(monkeypatch):
    monkeypatch.setattr(fetch, "_kosdaq_ticker_set", lambda: None)

    suffix, uncertain = fetch.kr_market_suffix("247540")

    assert suffix == ".KS"
    assert uncertain is True


def test_kosdaq_ticker_uses_kq11_when_available(monkeypatch):
    monkeypatch.setattr(fetch, "kr_market_suffix", lambda ticker: (".KQ", False))
    monkeypatch.setattr(
        fetch, "fetch_benchmark", lambda symbol: pd.DataFrame({"Close": [1, 2, 3]})
    )

    symbol, warning = fetch.resolve_benchmark_symbol("247540")

    assert symbol == "^KQ11"
    assert warning is None


def test_kosdaq_ticker_falls_back_to_ks11_when_kq11_empty(monkeypatch):
    """CHECK 4 회귀 테스트 — ^KQ11 조회가 실패하면 조용히 코스피 지수를 쓰는 대신
    경고 메시지를 반환해야 한다(리포트에서 노출)."""
    monkeypatch.setattr(fetch, "kr_market_suffix", lambda ticker: (".KQ", False))
    monkeypatch.setattr(fetch, "fetch_benchmark", lambda symbol: pd.DataFrame())

    symbol, warning = fetch.resolve_benchmark_symbol("247540")

    assert symbol == "^KS11"
    assert warning is not None


def test_market_classification_uncertain_still_warns_even_though_it_falls_back_to_kospi(monkeypatch):
    monkeypatch.setattr(fetch, "kr_market_suffix", lambda ticker: (".KS", True))

    symbol, warning = fetch.resolve_benchmark_symbol("247540")

    assert symbol == "^KS11"
    assert warning is not None


def test_kospi_ticker_never_needs_fallback(monkeypatch):
    monkeypatch.setattr(fetch, "kr_market_suffix", lambda ticker: (".KS", False))

    symbol, warning = fetch.resolve_benchmark_symbol("005930")

    assert symbol == "^KS11"
    assert warning is None


def test_us_ticker_ignores_kr_benchmark_logic():
    symbol, warning = fetch.resolve_benchmark_symbol("AAPL")
    assert symbol == "^GSPC"
    assert warning is None
