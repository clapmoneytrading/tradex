"""Persistent local disk cache for OHLCV bars with incremental delta fetching.

Stores bars per (source, symbol, tf) under hub/.cache/bars/<source>/<symbol>__<tf>.json.
On each request:
- Latest bars (to_ms is None): loads local bars, fetches only missing/recent bars since the
  last cached timestamp, merges & saves back to disk, and returns the requested tail.
- Historical bars (to_ms is set): serves from disk if the requested range is already cached;
  otherwise fetches the missing older slice from upstream, merges & saves to disk.
"""
import json
import os
import re
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BARS_DIR = os.path.join(HERE, ".cache", "bars")

_file_locks = {}
_locks_guard = threading.Lock()


def _lock_for(key):
    with _locks_guard:
        lk = _file_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _file_locks[key] = lk
        return lk


def _safe_name(s):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(s or ""))


def _cache_path(source, symbol, tf):
    return os.path.join(BARS_DIR, _safe_name(source), f"{_safe_name(symbol)}__{_safe_name(tf)}.json")


def _load_disk(path):
    """Return (fetched_at, bars_list) from disk, or (0.0, [])."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        fetched_at = float(data.get("fetched_at") or 0.0)
        raw = data.get("bars") or []
        bars = [
            {
                "time": int(b[0]),
                "open": float(b[1]),
                "high": float(b[2]),
                "low": float(b[3]),
                "close": float(b[4]),
                "volume": float(b[5]),
            }
            for b in raw
            if len(b) >= 6
        ]
        return fetched_at, bars
    except (OSError, ValueError, TypeError):
        return 0.0, []


def _save_disk(path, bars, fetched_at=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    payload = {
        "fetched_at": float(fetched_at if fetched_at is not None else time.time()),
        "bars": [
            [int(b["time"]), float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"]), float(b.get("volume", 0.0))]
            for b in bars
        ],
    }
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, path)


def _merge_bars(existing, incoming):
    """Merge two lists of OHLCV dicts by timestamp, preferring incoming on overlap."""
    if not existing:
        by_t = {int(b["time"]): b for b in incoming}
    elif not incoming:
        return existing
    else:
        by_t = {int(b["time"]): b for b in existing}
        for b in incoming:
            by_t[int(b["time"])] = b
    return [by_t[t] for t in sorted(by_t)]


def get_bars(source, symbol, tf, limit, to_ms, tf_sec, fetch_fn, ttl):
    """Load bars from local disk cache and fetch only missing/new bars from upstream."""
    src = source or "binance"
    lim = max(1, int(limit))
    sec = max(1, int(tf_sec))
    path = _cache_path(src, symbol, tf)
    lk = _lock_for((src, symbol, tf))

    with lk:
        fetched_at, cached = _load_disk(path)
        now = time.time()

        # Case 1: Historical page request (user zoomed/scrolled left)
        if to_ms is not None and str(to_ms).strip() != "":
            to_sec = int(float(to_ms) // 1000)
            older = [b for b in cached if b["time"] <= to_sec]
            # Serve directly from disk if we already have enough older bars before to_sec
            if len(older) >= lim or (cached and cached[0]["time"] <= to_sec - lim * sec):
                return older[-lim:]
            try:
                incoming = fetch_fn(symbol, tf, lim, to_ms)
            except Exception:
                if older:
                    return older[-lim:]
                raise
            if incoming:
                merged = _merge_bars(cached, incoming)
                _save_disk(path, merged, fetched_at or now)
                older = [b for b in merged if b["time"] <= to_sec]
            return older[-lim:]

        # Case 2: Latest bars request (initial load or refresh)
        if cached and (now - fetched_at) < ttl and len(cached) >= min(lim, 200):
            return cached[-lim:]

        if not cached:
            incoming = fetch_fn(symbol, tf, lim, None)
            if incoming:
                merged = _merge_bars([], incoming)
                _save_disk(path, merged, now)
                return merged[-lim:]
            return []

        last_t = cached[-1]["time"]
        # Fetch only the delta since last_t (plus a small overlap for the live/partial candle)
        if tf == "MN1":
            from_sec = last_t - 32 * 86400
        elif tf == "W1":
            from_sec = last_t - 8 * 86400
        else:
            from_sec = last_t - sec * 2

        delta_bars = max(5, int((now - from_sec) // sec) + 5)
        fetch_lim = min(lim, max(delta_bars, 10))
        # If local cache has fewer bars than requested and we only have a tiny slice, fetch full limit once
        if len(cached) < min(lim, 500) and (now - cached[0]["time"]) < lim * sec * 0.5:
            fetch_lim = lim
            from_sec = None

        try:
            if src == "fyers" and from_sec is not None:
                incoming = fetch_fn(symbol, tf, fetch_lim, None, from_sec=from_sec)
            else:
                incoming = fetch_fn(symbol, tf, fetch_lim, None)
        except Exception:
            # On transient upstream failure / rate limit, serve local cached bars instead of failing the chart
            if cached:
                return cached[-lim:]
            raise

        merged = _merge_bars(cached, incoming)
        _save_disk(path, merged, now)
        return merged[-lim:]
