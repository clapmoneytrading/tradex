"""Fyers API v3 feed for TradeX: NSE Equities + Indices (OAuth login, symbols, history, live quotes)."""
import asyncio, csv, hashlib, io, json, os, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _req_json(url, data=None, headers=None, timeout=15):
    hdrs = {"User-Agent": UA, **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            raise RuntimeError(f"HTTP {e.code}: {raw or e.reason}")

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".cache")
TOKEN_FILE = os.path.join(CACHE_DIR, "fyers_token.json")
SYM_CACHE = os.path.join(CACHE_DIR, "fyers_nse_cm.csv")
ENV_FILE = os.path.join(HERE, "..", ".env")

FYERS_TF = {"M1": "1", "M5": "5", "M15": "15", "M30": "30", "H1": "60", "H2": "120", "H4": "240", "D1": "D", "W1": "D", "MN1": "D"}
TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H2": 7200, "H4": 14400, "D1": 86400, "W1": 604800, "MN1": 2592000}

# Built-in fallback NSE Indices & top Equities in case NSE_CM.csv cannot be fetched offline
FALLBACK_NSE = [
    ("NSE:NIFTY50-INDEX", "Nifty 50 Index", "nse-index"),
    ("NSE:NIFTYBANK-INDEX", "Nifty Bank Index", "nse-index"),
    ("NSE:FINNIFTY-INDEX", "Nifty Financial Services", "nse-index"),
    ("NSE:MIDCPNIFTY-INDEX", "Nifty Midcap Select", "nse-index"),
    ("NSE:INDIAVIX-INDEX", "India VIX", "nse-index"),
    ("NSE:RELIANCE-EQ", "Reliance Industries Ltd", "nse-eq"),
    ("NSE:TCS-EQ", "Tata Consultancy Services Ltd", "nse-eq"),
    ("NSE:HDFCBANK-EQ", "HDFC Bank Ltd", "nse-eq"),
    ("NSE:ICICIBANK-EQ", "ICICI Bank Ltd", "nse-eq"),
    ("NSE:INFY-EQ", "Infosys Ltd", "nse-eq"),
    ("NSE:SBIN-EQ", "State Bank of India", "nse-eq"),
    ("NSE:BHARTIARTL-EQ", "Bharti Airtel Ltd", "nse-eq"),
    ("NSE:ITC-EQ", "ITC Ltd", "nse-eq"),
    ("NSE:LT-EQ", "Larsen & Toubro Ltd", "nse-eq"),
    ("NSE:AXISBANK-EQ", "Axis Bank Ltd", "nse-eq"),
    ("NSE:KOTAKBANK-EQ", "Kotak Mahindra Bank Ltd", "nse-eq"),
    ("NSE:TATAMOTORS-EQ", "Tata Motors Ltd", "nse-eq"),
    ("NSE:TATASTEEL-EQ", "Tata Steel Ltd", "nse-eq"),
    ("NSE:BAJFINANCE-EQ", "Bajaj Finance Ltd", "nse-eq"),
    ("NSE:MARUTI-EQ", "Maruti Suzuki India Ltd", "nse-eq"),
]

_lock = threading.Lock()
_state = {
    "app_id": os.environ.get("FYERS_APP_ID", "").strip(),
    "secret_key": os.environ.get("FYERS_SECRET_KEY", "").strip(),
    "redirect_uri": os.environ.get("FYERS_REDIRECT_URI", "http://127.0.0.1:8502/").strip() or "http://127.0.0.1:8502/",
    "access_token": os.environ.get("FYERS_ACCESS_TOKEN", "").strip(),
    "last_err": "",
}
_cb_server = {"srv": None}
symbols_cache = []


def _load_saved_token():
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if not _state["access_token"] and d.get("access_token"):
            _state["access_token"] = d["access_token"].strip()
        if not _state["app_id"] and d.get("app_id"):
            _state["app_id"] = d["app_id"].strip()
        if not _state["secret_key"] and d.get("secret_key"):
            _state["secret_key"] = d["secret_key"].strip()
        if d.get("redirect_uri"):
            _state["redirect_uri"] = d["redirect_uri"].strip()
    except OSError:
        pass


_load_saved_token()


def _save_token():
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "app_id": _state["app_id"],
            "secret_key": _state["secret_key"],
            "redirect_uri": _state["redirect_uri"],
            "access_token": _state["access_token"],
            "saved_at": int(time.time()),
        }, f)


def status():
    with _lock:
        has_creds = bool(_state["app_id"] and _state["secret_key"])
        connected = bool(_state["app_id"] and _state["access_token"])
        return {
            "configured": has_creds,
            "connected": connected,
            "app_id": _state["app_id"],
            "redirect_uri": _state["redirect_uri"],
            "symbols": len(symbols_cache),
            "last_err": _state["last_err"],
        }


def configure(app_id=None, secret_key=None, redirect_uri=None, access_token=None):
    with _lock:
        if app_id is not None:
            _state["app_id"] = app_id.strip()
        if secret_key is not None and secret_key.strip():
            _state["secret_key"] = secret_key.strip()
        if redirect_uri is not None and redirect_uri.strip():
            _state["redirect_uri"] = redirect_uri.strip()
        if access_token is not None:
            _state["access_token"] = access_token.strip()
        _state["last_err"] = ""
        _save_token()
    return status()


def _auth_header():
    app_id = _state["app_id"]
    tok = _state["access_token"]
    if not app_id or not tok:
        raise RuntimeError("Fyers is not connected. Open Feeds -> Connect Fyers to log in.")
    return f"{app_id}:{tok}"


def exchange_auth_code(auth_code):
    app_id = _state["app_id"]
    secret = _state["secret_key"]
    if not app_id or not secret:
        raise RuntimeError("FYERS_APP_ID and FYERS_SECRET_KEY are required.")
    code = auth_code.strip()
    if "auth_code=" in code:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(code).query)
        code = (q.get("auth_code") or [""])[0]
    if not code:
        raise RuntimeError("Missing auth_code")
    app_hash = hashlib.sha256(f"{app_id}:{secret}".encode("utf-8")).hexdigest()
    payload = json.dumps({
        "grant_type": "authorization_code",
        "appIdHash": app_hash,
        "code": code,
    }).encode("utf-8")
    res = _req_json(
        "https://api-t1.fyers.in/api/v3/validate-authcode",
        data=payload,
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    if res.get("s") != "ok" or not res.get("access_token"):
        msg = res.get("message") or str(res)
        with _lock:
            _state["last_err"] = msg
        raise RuntimeError(f"Fyers auth failed: {msg}")
    with _lock:
        _state["access_token"] = res["access_token"]
        _state["last_err"] = ""
        _save_token()
    return status()


def _ensure_callback_listener():
    if _cb_server["srv"] is not None:
        return
    u = urllib.parse.urlparse(_state["redirect_uri"])
    host = u.hostname or "127.0.0.1"
    port = u.port or 8502

    class _CbHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code = (q.get("auth_code") or [""])[0]
            if code:
                try:
                    exchange_auth_code(code)
                    html = "<html><body style='font-family:sans-serif;background:#0f161d;color:#d6dee5;padding:30px'><h2>Fyers Connected!</h2><p>NSE Equities &amp; Indices are ready in TradeX. You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>"
                    status_code = 200
                except Exception as e:
                    html = f"<html><body style='font-family:sans-serif;background:#0f161d;color:#f87171;padding:30px'><h2>Fyers Login Error</h2><pre>{e}</pre></body></html>"
                    status_code = 400
            else:
                html = "<html><body style='font-family:sans-serif;background:#0f161d;color:#d6dee5;padding:30px'><p>No auth_code in callback URL.</p></body></html>"
                status_code = 400
            self.send_response(status_code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(html.encode("utf-8"))

        def log_message(self, *a):
            pass

    try:
        srv = HTTPServer((host, port), _CbHandler)
        _cb_server["srv"] = srv
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    except OSError:
        # Port might already be bound from an earlier login click
        pass


def login_url():
    if not _state["app_id"] or not _state["secret_key"]:
        raise RuntimeError("Enter Fyers App ID and Secret Key first.")
    _ensure_callback_listener()
    params = urllib.parse.urlencode({
        "client_id": _state["app_id"],
        "redirect_uri": _state["redirect_uri"],
        "response_type": "code",
        "state": "tradex",
    })
    return f"https://api-t1.fyers.in/api/v3/generate-authcode?{params}"


def load_symbols():
    """Load NSE Equities (-EQ) + Indices (-INDEX) from Fyers public symbol master CSV."""
    global symbols_cache
    raw_csv = None
    try:
        if os.path.exists(SYM_CACHE) and time.time() - os.path.getmtime(SYM_CACHE) < 86400:
            with open(SYM_CACHE, encoding="utf-8", errors="ignore") as f:
                raw_csv = f.read()
        else:
            req = urllib.request.Request(
                "https://public.fyers.in/sym_details/NSE_CM.csv",
                headers={"User-Agent": "TradeX/1.0"},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                raw_csv = r.read().decode("utf-8", errors="ignore")
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(SYM_CACHE, "w", encoding="utf-8") as f:
                f.write(raw_csv)
    except Exception:
        pass

    out = []
    seen = set()
    if raw_csv:
        reader = csv.reader(io.StringIO(raw_csv))
        for row in reader:
            if len(row) < 10:
                continue
            ticker = row[9].strip()
            if not ticker.startswith("NSE:"):
                continue
            if ticker.endswith("-INDEX"):
                grp = "nse-index"
            elif ticker.endswith("-EQ"):
                grp = "nse-eq"
            else:
                continue
            if ticker in seen:
                continue
            seen.add(ticker)
            name = (row[1] or ticker).strip()
            out.append({"ticker": ticker, "name": name, "source": "fyers", "group": grp, "digits": 2})

    if not out:
        out = [{"ticker": t, "name": n, "source": "fyers", "group": g, "digits": 2} for t, n, g in FALLBACK_NSE]
    else:
        # Put indices first, then popular/alphabetical equities
        out.sort(key=lambda x: (x["group"] != "nse-index", x["ticker"]))

    symbols_cache = out
    return out


def symbols_loop():
    while True:
        load_symbols()
        time.sleep(21600)


_hist_cache = {}
_hist_inflight = {}
_hist_lock = threading.Lock()
_rate_until = 0.0

_quote_lock = threading.Lock()
_quote_subs = {}   # symbol -> refcount
_quote_cache = {}  # symbol -> quote dict
_quote_started = False


def _is_rate_limit(msg):
    m = (msg or "").lower()
    return "limit" in m or "too many" in m or "429" in m


def _agg_bars(bars, tf):
    from datetime import datetime, timezone
    out = []
    cur_key = None
    for b in bars:
        dt = datetime.fromtimestamp(int(b["time"]), tz=timezone.utc)
        if tf == "W1":
            monday = dt.toordinal() - dt.weekday()
            b_ts = int(datetime.fromordinal(monday).replace(tzinfo=timezone.utc).timestamp())
            key = monday
        else:
            b_ts = int(datetime(dt.year, dt.month, 1, tzinfo=timezone.utc).timestamp())
            key = (dt.year, dt.month)
        if key != cur_key:
            cur_key = key
            out.append({"time": b_ts, "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"], "volume": b.get("volume", 0.0)})
        else:
            c = out[-1]
            c["high"] = max(c["high"], b["high"])
            c["low"] = min(c["low"], b["low"])
            c["close"] = b["close"]
            c["volume"] += b.get("volume", 0.0)
    return out


def history(symbol, tf, limit=1000, to_ms=None):
    global _rate_until
    res = FYERS_TF.get(tf)
    if not res:
        raise RuntimeError(f"Unsupported timeframe for Fyers: {tf}")
    sec = TF_SEC[tf]
    lim = int(limit)
    ttl = 600 if to_ms else (180 if tf in ("W1", "MN1") else max(20, min(120, sec // 3)))
    key = (symbol, tf, lim, str(int(to_ms) // 1000) if to_ms else "")
    now = time.time()

    with _hist_lock:
        hit = _hist_cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        if now < _rate_until and hit:
            return hit[1]
        ev = _hist_inflight.get(key)
        if ev is None:
            ev = threading.Event()
            _hist_inflight[key] = ev
            owner = True
        else:
            owner = False

    if not owner:
        ev.wait(timeout=20)
        with _hist_lock:
            hit = _hist_cache.get(key)
            if hit:
                return hit[1]

    try:
        if time.time() < _rate_until:
            raise RuntimeError("Fyers rate limit cooldown (50 req/min); retrying shortly.")
        range_to = int(int(to_ms) // 1000) if to_ms else int(time.time())
        chunks = 3 if tf in ("W1", "MN1") else 1
        all_candles = []
        for idx in range(chunks):
            c_to = range_to - idx * 365 * 86400
            if c_to <= 0:
                break
            max_span = 365 * 86400 if res == "D" else 95 * 86400
            wanted_span = max(lim * sec * 3, 7 * 86400)
            c_from = max(0, c_to - min(max_span, wanted_span))
            params = urllib.parse.urlencode({
                "symbol": symbol,
                "resolution": res,
                "date_format": "0",
                "range_from": str(c_from),
                "range_to": str(c_to),
                "cont_flag": "1",
            })
            data = _req_json(
                f"https://api-t1.fyers.in/data/history?{params}",
                headers={"Authorization": _auth_header()},
                timeout=15,
            )
            if data.get("s") != "ok":
                msg = data.get("message") or str(data)
                if _is_rate_limit(msg):
                    _rate_until = time.time() + 15
                    if all_candles:
                        break
                    with _hist_lock:
                        if hit:
                            return hit[1]
                if data.get("code") in (-15, -16, -17) or "token" in msg.lower():
                    with _lock:
                        _state["last_err"] = msg
                if idx == 0:
                    raise RuntimeError(f"Fyers history error: {msg}")
                break
            c_rows = data.get("candles") or []
            if not c_rows:
                break
            all_candles = c_rows + all_candles
        bars = [
            {"time": int(c[0]), "open": float(c[1]), "high": float(c[2]), "low": float(c[3]), "close": float(c[4]), "volume": float(c[5])}
            for c in all_candles
        ]
        if tf in ("W1", "MN1"):
            bars = _agg_bars(bars, tf)
        bars = bars[-lim:]
        with _hist_lock:
            if len(_hist_cache) > 128:
                cutoff = time.time() - 600
                for k in [k for k, v in _hist_cache.items() if v[0] < cutoff]:
                    del _hist_cache[k]
            _hist_cache[key] = (time.time(), bars)
        return bars
    finally:
        if owner:
            with _hist_lock:
                _hist_inflight.pop(key, None)
            ev.set()


def _quote_loop():
    global _rate_until
    while True:
        time.sleep(3.0)
        if time.time() < _rate_until:
            continue
        with _quote_lock:
            syms = [s for s, n in _quote_subs.items() if n > 0]
        if not syms or not _state["app_id"] or not _state["access_token"]:
            continue
        try:
            for i in range(0, len(syms), 50):
                batch = syms[i:i + 50]
                params = urllib.parse.urlencode({"symbols": ",".join(batch)})
                data = _req_json(
                    f"https://api-t1.fyers.in/data/quotes?{params}",
                    headers={"Authorization": _auth_header()},
                    timeout=10,
                )
                if data.get("s") != "ok":
                    if _is_rate_limit(data.get("message")):
                        _rate_until = time.time() + 20
                    break
                with _quote_lock:
                    for item in data.get("d") or []:
                        n = item.get("n")
                        v = item.get("v")
                        if n and isinstance(v, dict):
                            _quote_cache[n] = v
        except Exception as e:
            if _is_rate_limit(str(e)):
                _rate_until = time.time() + 20


def _ensure_quote_loop():
    global _quote_started
    with _quote_lock:
        if _quote_started:
            return
        _quote_started = True
    threading.Thread(target=_quote_loop, daemon=True).start()


async def stream(ws, symbol, tf, record_tick, true_now_ms):
    sec = TF_SEC[tf]
    try:
        bars = await asyncio.to_thread(history, symbol, tf, 1000)
    except Exception as e:
        await ws.send(json.dumps({"type": "error", "msg": str(e)}))
        return
    await ws.send(json.dumps({"type": "history", "bars": bars}))
    _ensure_quote_loop()
    with _quote_lock:
        _quote_subs[symbol] = _quote_subs.get(symbol, 0) + 1
    cur = dict(bars[-1]) if bars else None
    last_vol = None
    last_seen = None
    try:
        while True:
            await asyncio.sleep(1.0)
            with _quote_lock:
                q = _quote_cache.get(symbol)
            if not q or q.get("lp") is None:
                continue
            sig = (q.get("lp"), q.get("volume"), q.get("tt"))
            if sig == last_seen:
                continue
            last_seen = sig
            ltp = float(q["lp"])
            tot_vol = float(q.get("volume") or 0)
            ts_sec = int(q.get("tt") or time.time())
            bucket = (ts_sec // sec) * sec
            src_ms = ts_sec * 1000
            record_tick("fyers", symbol, src_ms)
            dvol = max(0.0, tot_vol - last_vol) if last_vol is not None else 0.0
            last_vol = tot_vol
            if cur is None or bucket > cur["time"]:
                cur = {"time": bucket, "open": ltp, "high": ltp, "low": ltp, "close": ltp, "volume": dvol}
            else:
                cur["high"] = max(cur["high"], ltp)
                cur["low"] = min(cur["low"], ltp)
                cur["close"] = ltp
                cur["volume"] += dvol
            await ws.send(json.dumps({
                "type": "bar",
                "bar": cur,
                "sent": true_now_ms(),
                "trade_ms": src_ms,
                "lag_ms": max(0, true_now_ms() - src_ms),
            }))
    finally:
        with _quote_lock:
            if _quote_subs.get(symbol, 0) <= 1:
                _quote_subs.pop(symbol, None)
            else:
                _quote_subs[symbol] -= 1
