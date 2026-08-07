"""임계값·가중치 상수 일원화. 조정은 이 파일만 수정하면 됨."""

# --- 데이터 수집 ---
LOOKBACK_YEARS = 3
BENCH_US = "^GSPC"
BENCH_KR = "^KS11"
BENCH_KQ = "^KQ11"

# --- 게이트 (regime.py) ---
GATE_ADX_MIN = 20.0
GATE_ADX_SCORE_DAMPEN = 0.7  # ADX 미달 시 최종 점수에 곱함 (30% 감쇠)
GATE_EARNINGS_DAYS = 7

# --- 카테고리 가중치 (entry.py, 합=100) ---
WEIGHT_TREND = 20
WEIGHT_RS = 25
WEIGHT_POSITION = 20
WEIGHT_MOMENTUM = 15
WEIGHT_SUPPLY = 20

# --- 판정 임계 ---
# 원점수(카테고리 배점 합산, 이론상 -77~+100)를 0으로 하한 클램프·100으로
# 상한 클램프해서 그대로 쓴다. 선형 재조정을 하지 않으므로 원점수 70 이상이
# 그대로 "적극 매수"를 뜻한다. (entry.py의 _normalize_score 참조)
SCORE_STRONG_BUY = 70
SCORE_PARTIAL_BUY = 55
SCORE_WATCH = 40

# --- 분할매수 비중 ---
TRANCHE_WEIGHTS_STRONG = (0.50, 0.30, 0.20)
TRANCHE_WEIGHTS_PARTIAL = (0.30, 0.35, 0.35)
ATR_MULT_TRANCHE2 = 1.0
ATR_MULT_TRANCHE3 = 2.0
ATR_MULT_STOPLOSS = 1.5

# --- 청산 (exit.py) ---
DEFAULT_STOP_LOSS_PCT = -10.0

# --- 한국 티커 판별 ---
KR_TICKER_RE = r"^\d{6}$"
