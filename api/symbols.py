"""Vercel serverless function: GET /api/symbols → public Binance + Bybit + Deriv symbol list."""
import json
import urllib.request
from http.server import BaseHTTPRequestHandler

UA = "TradeGen/1.0"

def _fetch(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _binance_symbols():
    try:
        data = _fetch("https://api.binance.com/api/v3/ticker/24hr")
        usdt = sorted(
            [d for d in data if d["symbol"].endswith("USDT") and float(d.get("quoteVolume", 0)) > 0],
            key=lambda d: -float(d.get("quoteVolume", 0)),
        )[:100]
        out = []
        for d in usdt:
            raw = d["symbol"]
            ticker = raw.replace("USDT", "USD")
            name = raw.replace("USDT", "") + " / USD"
            out.append({"ticker": ticker, "name": name, "source": "binance", "group": "crypto", "digits": 2})
        return out
    except Exception:
        return [{"ticker": "BTCUSD", "name": "Bitcoin / USD", "source": "binance", "group": "crypto", "digits": 2}]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        symbols = _binance_symbols()
        body = json.dumps({
            "symbols": symbols,
            "mt5": "off",
            "arm": "off",
            "deriv": 0,
            "bybit": 0,
            "binance": len(symbols),
            "fyers": 0,
            "ws_port": 0,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, s-maxage=300")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
