"""티커 판별만 검증. 네트워크 미사용."""
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
