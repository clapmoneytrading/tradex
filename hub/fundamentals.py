"""NSE stock fundamental fetcher & persistent file store (MarketSmith India API).

Stores all looked-up stocks in hub/.cache/fundamentals.json (upsert by symbol).
Supports single-stock lookup/update, listing all saved stocks, bulk refresh, and CSV report export.
"""
import csv
import io
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, ".cache", "fundamentals.json")

BASE_URL = "https://marketsmithindia.com"
API_BASE = f"{BASE_URL}/gateway/simple-api/ms-india"
DEFAULT_MS_AUTH = "0000+MarketSmithINDUID-0000000000000+MarketSmithINDUID-0000000000000"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json,text/plain,*/*",
}

_lock = threading.Lock()


def normalize_symbol(raw):
    """Turn 'NSE:ICICIBANK-EQ' or 'ICICIBANK' into 'ICICIBANK'."""
    s = str(raw or "").strip().upper()
    if ":" in s:
        s = s.split(":", 1)[1]
    s = re.sub(r"-(EQ|BE|BZ|SM|ST|INDEX)$", "", s)
    return s.strip()


def _fetch_json(url, timeout=15):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _to_float(val):
    if val is None or val == "":
        return None
    s = re.sub(r"[^0-9.\-]", "", str(val))
    if not s or s in ("-", "."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _fmt_val(val):
    if val is None or val == "":
        return None
    return str(val)


def _fmt_pct(val):
    n = _to_float(val)
    return f"{n:.2f}%" if n is not None else None


def _fmt_signed_pct(val):
    n = _to_float(val)
    if n is None:
        return None
    return f"{'+' if n > 0 else ''}{n:.2f}%"


def _calc_chg_pct(cur, prev):
    c, p = _to_float(cur), _to_float(prev)
    if c is None or p is None or p == 0:
        return None
    return _fmt_signed_pct(((c - p) / p) * 100.0)


def _fmt_compact(val):
    n = _to_float(val)
    if n is None:
        return None
    if abs(n) >= 1000:
        return f"{n / 1000.0:.2f} K"
    return str(round(n))


def _fmt_crore(val):
    n = _to_float(val)
    if n is None:
        return None
    return f"{n / 10000000.0:.2f} Cr"


def _fmt_month_year(val):
    if val is None or val == "":
        return None
    raw = str(val).strip()
    if not raw:
        return None
    try:
        if re.fullmatch(r"\d{10,13}", raw):
            ep = int(raw)
            if len(raw) > 10:
                ep = ep // 1000
            dt = datetime.fromtimestamp(ep, tz=timezone.utc)
            return dt.strftime("%b %Y")
        if re.fullmatch(r"\d{8}", raw):
            dt = datetime.strptime(raw, "%Y%m%d")
            return dt.strftime("%b %Y")
    except Exception:
        pass
    return raw


def _master_rank(score):
    n = _to_float(score)
    if n is None:
        return None
    if n >= 80:
        return "A"
    if n >= 60:
        return "B"
    if n >= 40:
        return "C"
    return "D"


def _find_instrument(query):
    url = f"{API_BASE}/instr/srch.json?text={urllib.parse.quote(query)}&lang=en&listID=-1&ver=2"
    payload = _fetch_json(url)
    results = (payload.get("response") or {}).get("results") or []
    if not results:
        return None
    q = query.lower()
    for item in results:
        syms = [str(item.get(k) or "").lower() for k in ("symbol", "nseSymbol", "bseSymbol")]
        name = str(item.get("name") or "").lower()
        if q in syms or name == q:
            return item
    return results[0]


def _fetch_symbol_details(instrument_id, symbol):
    date_to = datetime.now(timezone.utc).strftime("%Y%m%d")
    url = (
        f"{API_BASE}/instr/0/{urllib.parse.quote(str(instrument_id))}/symboldetails.json"
        f"?s=20180101&e={date_to}&text={urllib.parse.quote(str(symbol))}&lang=en&isConsolidated=1"
        f"&ms-auth={urllib.parse.quote(DEFAULT_MS_AUTH)}"
    )
    payload = _fetch_json(url)
    resp = payload.get("response")
    if not resp:
        raise RuntimeError("MarketSmith API returned an unexpected response.")
    return resp


def fetch_stock(raw_symbol):
    """Fetch live fundamental details for an NSE stock from MarketSmith India."""
    query = normalize_symbol(raw_symbol)
    if not query:
        raise RuntimeError("Stock symbol is required.")
    cand = _find_instrument(query)
    if not cand:
        raise RuntimeError(f"Stock '{query}' not found in MarketSmith India.")
    details = _fetch_symbol_details(cand["instrumentId"], cand.get("symbol") or query)
    header = details.get("detailsGeneralInformationHeader") or {}
    q_raw = (details.get("quarterlySalesAndEarningsInternational") or {}).get("quarterlySalesAndEarningsOrigin") or []
    q_rows = [r for r in q_raw if isinstance(r, dict) and (r.get("eps") is not None or r.get("sales") is not None or r.get("salesMil") is not None)]

    last_q = q_rows[0] if q_rows else {}
    prev_q = q_rows[1] if len(q_rows) > 1 else {}
    q_last4 = [
        {
            "date": _fmt_month_year(r.get("calendarDate") or r.get("fiscalDate")),
            "eps": _fmt_val(r.get("eps")),
            "eps_change_percent": _fmt_signed_pct(r.get("epsPct")),
            "sales_cr": _fmt_val(r.get("sales")),
            "sales_change_percent": _fmt_signed_pct(r.get("salesPct")),
        }
        for r in q_rows[:4]
    ]
    eps_pcts = [n for n in (_to_float(r.get("epsPct")) for r in q_rows[:4]) if n is not None]
    last4_avg = f"{sum(eps_pcts) / len(eps_pcts):.2f}%" if eps_pcts else None

    cur_px = _to_float(header.get("currentPrice"))
    prev_px = _to_float(header.get("prevPrice"))
    chg_pct = f"{((cur_px - prev_px) / prev_px) * 100.0:.2f}%" if (cur_px is not None and prev_px not in (None, 0)) else None

    sym = normalize_symbol(cand.get("nseSymbol") or cand.get("symbol") or query)
    sector = str(header.get("industryName") or "").strip() or None
    if sector and sector.upper().startswith("NSE-"):
        sector = sector[4:].strip()
    return {
        "symbol": sym,
        "ticker": f"NSE:{sym}-EQ",
        "stock_name": str(header.get("companyName") or cand.get("name") or sym).strip(),
        "sector": sector,
        "industry_group_rank": _fmt_val(header.get("industryGroupRank")),
        "buyer_demand": _fmt_val(header.get("accDisRating")),
        "current_price": _fmt_val(header.get("currentPrice")),
        "change": chg_pct,
        "master_rank": _master_rank(header.get("masterScore")),
        "master_score": _fmt_val(header.get("masterScore")),
        "eps_rating": _fmt_val(header.get("epsRank")),
        "rs_rating": _fmt_val(header.get("rsNumericGrade")),
        "pe_ratio": _fmt_val(header.get("pe")),
        "return_on_equity": _fmt_pct(header.get("roe")),
        "last_4_quarterly_earnings_percent": last4_avg,
        "eps_percent": _fmt_pct(last_q.get("epsPct")),
        "sales_cr": _fmt_val(last_q.get("sales") if last_q.get("sales") is not None else header.get("sales")),
        "sales_change_percent": _fmt_pct(last_q.get("salesPct")),
        "no_of_funds": _fmt_compact(last_q.get("noOfFunds")),
        "no_of_funds_percent": _calc_chg_pct(last_q.get("noOfFunds"), prev_q.get("noOfFunds")),
        "shares_held_by_funds": _fmt_crore(last_q.get("totSharesHeldByFunds")),
        "shares_held_by_funds_percent": _calc_chg_pct(last_q.get("totSharesHeldByFunds"), prev_q.get("totSharesHeldByFunds")),
        "quarterly_earnings_last_4": q_last4,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _load_store():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("stocks"), dict):
            return data["stocks"]
    except (OSError, ValueError, TypeError):
        pass
    return {}


def _save_store(stocks):
    os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
    tmp = f"{STORE_PATH}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "stocks": stocks}, f, indent=2)
    os.replace(tmp, STORE_PATH)


def lookup_and_save(raw_symbol):
    """Fetch fresh details for raw_symbol and save/update it in hub/.cache/fundamentals.json."""
    sym = normalize_symbol(raw_symbol)
    try:
        rec = fetch_stock(sym)
        stale = False
    except Exception as e:
        with _lock:
            stocks = _load_store()
            existing = stocks.get(sym)
        if existing:
            return existing, len(stocks), False, True, str(e)
        raise

    with _lock:
        stocks = _load_store()
        existed = rec["symbol"] in stocks
        stocks[rec["symbol"]] = rec
        _save_store(stocks)
        total = len(stocks)
    return rec, total, existed, stale, None


def list_all():
    with _lock:
        stocks = _load_store()
    rows = list(stocks.values())
    rows.sort(key=lambda r: r.get("updated_at") or "", reverse=True)
    return rows


def delete_symbol(raw_symbol):
    sym = normalize_symbol(raw_symbol)
    with _lock:
        stocks = _load_store()
        removed = stocks.pop(sym, None) is not None
        if removed:
            _save_store(stocks)
        total = len(stocks)
    return removed, total


def refresh_all():
    rows = list_all()
    ok, errs = 0, []
    for r in rows:
        sym = r.get("symbol") or r.get("stock_name")
        if not sym:
            continue
        try:
            lookup_and_save(sym)
            ok += 1
        except Exception as e:
            errs.append({"symbol": sym, "error": str(e)})
    return {"total": len(rows), "updated": ok, "errors": errs}


def export_csv():
    rows = list_all()
    cols = [
        "symbol", "stock_name", "sector", "industry_group_rank", "current_price", "change",
        "master_rank", "master_score", "eps_rating", "rs_rating", "buyer_demand",
        "pe_ratio", "return_on_equity", "last_4_quarterly_earnings_percent",
        "eps_percent", "sales_cr", "sales_change_percent",
        "no_of_funds", "no_of_funds_percent", "shares_held_by_funds", "shares_held_by_funds_percent",
        "updated_at",
    ]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for r in rows:
        w.writerow([r.get(c, "") or "" for c in cols])
    return buf.getvalue().encode("utf-8")
