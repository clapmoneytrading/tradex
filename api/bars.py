"""Vercel serverless function: GET /api/bars?symbol=BTCUSD&tf=D1&limit=1000 → Binance public klines."""
import json
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler

BINANCE_TF = {
    "M1": "1m", "M5": "5m", "M15": "15m", "M30": "30m",
    "H1": "1h", "H2": "2h", "H4": "4h", "D1": "1d", "W1": "1w", "MN1": "1M",
}


def _binance_history(symbol, tf, limit=1000, to_ms=None):
    bsym = symbol.replace("/", "").replace("USD", "USDT").replace("-", "")
    if not bsym.endswith("USDT") and not bsym.endswith("BTC"):
        bsym = bsym + "T"  # BTCUSD -> BTCUSDT
    interval = BINANCE_TF.get(tf, "1d")
    url = f"https://api.binance.com/api/v3/klines?symbol={bsym}&interval={interval}&limit={min(int(limit), 1000)}"
    if to_ms:
        url += f"&endTime={int(to_ms)}"
    req = urllib.request.Request(url, headers={"User-Agent": "TradeGen/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = json.loads(r.read().decode("utf-8"))
    return [
        {"time": int(c[0]) // 1000, "open": float(c[1]), "high": float(c[2]),
         "low": float(c[3]), "close": float(c[4]), "volume": float(c[5])}
        for c in raw
    ]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
        symbol = q.get("symbol", "BTCUSD")
        tf = q.get("tf", "D1")
        limit = int(q.get("limit", "1000"))
        to_ms = q.get("to")

        try:
            bars = _binance_history(symbol, tf, limit, to_ms)
            body = json.dumps(bars).encode()
            code = 200
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            code = 502

        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, s-maxage=60")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
