#!/usr/bin/env python3
"""Summarise Yahoo Mail API traffic from a HAR file into a redacted endpoint catalogue.

Usage: python3 har2spec.py session.har > spec.md

Reads every request to a *.yahoo.com host whose path contains /ws/, groups them by a
normalised URL template (ids and tokens replaced by placeholders), and prints, per group:
method, template, count, latency stats, query parameter names, request JSON structure,
response JSON structure. Cookies, wssid values, email addresses and all string values are
redacted, so the output is safe to share. Only structure survives, which is all a client
implementation needs.
"""

import json
import re
import statistics
import sys
from collections import defaultdict
from urllib.parse import urlsplit, parse_qsl

MAX_DEPTH = 12
MAX_KEYS = 40
MAX_LIST_SAMPLE = 8

ID_PATTERNS = [
    (re.compile(r"@\.id==[^/?&]+"), "@.id==<ID>"),
    (re.compile(r"/[0-9a-f]{16,}(?=/|$)"), "/<HEX>"),
    (re.compile(r"/[A-Za-z0-9_-]{20,}(?=/|$)"), "/<TOKEN>"),
    (re.compile(r"/\d{3,}(?=/|$)"), "/<NUM>"),
]

REDACT_QUERY_KEYS = {"wssid", "ymreqid", "appid", "appId", "q", "token", "syncToken", "crumb"}
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def normalise_path(path):
    for pat, repl in ID_PATTERNS:
        path = pat.sub(repl, path)
    return path


def shape(value, depth=0):
    """Return a structural skeleton of a JSON value with all leaves replaced by their type."""
    if depth > MAX_DEPTH:
        return "..."
    if isinstance(value, dict):
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= MAX_KEYS:
                out["..."] = f"{len(value) - MAX_KEYS} more keys"
                break
            out[k] = shape(v, depth + 1)
        return out
    if isinstance(value, list):
        if not value:
            return []
        sample = [shape(v, depth + 1) for v in value[:MAX_LIST_SAMPLE]]
        merged = merge_shapes(sample)
        return [merged, f"len={len(value)}"]
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if value is None:
        return "null"
    if isinstance(value, str):
        if re.fullmatch(r"\d{10,13}", value):
            return "str:epoch"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T.*", value):
            return "str:iso8601"
        if EMAIL_RE.match(value):
            return "str:email"
        return f"str({len(value)})"
    return type(value).__name__


def merge_shapes(shapes):
    """Union of dict keys across list samples so optional fields are not lost."""
    if all(isinstance(s, dict) for s in shapes):
        merged = {}
        for s in shapes:
            for k, v in s.items():
                if k not in merged:
                    merged[k] = v
        return merged
    return shapes[0]


def request_body(req):
    """Return the decoded request body, looking in every place a HAR writer may put it."""
    post = req.get("postData") or {}
    text = post.get("text")
    if (post.get("mimeType") or "").startswith("multipart/form-data"):
        for p in post.get("params") or []:
            if p.get("name") == "batchJson" and p.get("value"):
                return p["value"]
        m = re.search(r"\r?\n\r?\n(.*?)\r?\n--", text or "", re.S)
        return m.group(1) if m else text
    if not text and post.get("params"):
        text = "&".join(f"{p.get('name')}={p.get('value')}" for p in post["params"])
    if not text:
        text = req.get("_postData") or req.get("body")
    if isinstance(text, str) and post.get("encoding") == "base64":
        import base64
        text = base64.b64decode(text).decode("utf-8", "replace")
    return text


def parse_json(text):
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def main(path):
    with open(path, encoding="utf-8") as f:
        har = json.load(f)

    groups = defaultdict(list)
    for entry in har["log"]["entries"]:
        req = entry["request"]
        url = urlsplit(req["url"])
        if not url.netloc.endswith("yahoo.com") or "/ws/" not in url.path:
            continue
        qs = dict(parse_qsl(url.query, keep_blank_values=True))
        template = normalise_path(url.path)
        if url.path.endswith("/batch") and qs.get("name"):
            template += f"?name={qs['name']}"
        key = (req["method"], url.netloc, template)
        groups[key].append((entry, url))

    print(f"# Yahoo Mail ws/ traffic from {path}\n")
    print(f"{sum(len(v) for v in groups.values())} requests in {len(groups)} endpoint groups\n")

    for (method, host, template), entries in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        times = [e["time"] for e, _ in entries]
        print(f"## {method} https://{host}{template}")
        print(f"- count: {len(entries)}, latency ms: median {statistics.median(times):.0f}, "
              f"min {min(times):.0f}, max {max(times):.0f}")

        qkeys = sorted({k for _, u in entries for k, _ in parse_qsl(u.query, keep_blank_values=True)})
        if qkeys:
            print(f"- query params: {', '.join(qkeys)}")
        qvals = defaultdict(set)
        for _, u in entries:
            for k, v in parse_qsl(u.query, keep_blank_values=True):
                if k not in REDACT_QUERY_KEYS:
                    qvals[k].add(v)
        for k in sorted(qvals):
            vals = sorted(qvals[k])[:8]
            if k == "name" or all(len(v) <= 24 for v in vals):
                print(f"  - {k}: {vals}")
        q_examples = sorted({v for _, u in entries for k, v in parse_qsl(u.query) if k == "q"})[:12]
        if q_examples:
            print("- q= examples (search language):")
            for q in q_examples:
                print(f"  - `{re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '<EMAIL>', q)}`")

        statuses = sorted({e["response"]["status"] for e, _ in entries})
        print(f"- response status: {statuses}")

        entry, _ = entries[0]
        req_hdrs = sorted({h["name"].lower() for e, _ in entries for h in e["request"]["headers"]})
        interesting = [h for h in req_hdrs if h not in ("cookie", "accept-encoding", "accept-language",
                       "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
                       "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "referer", "origin",
                       "content-length", "accept", "priority", "pragma", "cache-control")]
        if interesting:
            print(f"- notable request headers: {', '.join(interesting)}")

        inner = defaultdict(int)
        inner_bodies = defaultdict(list)
        inner_q = set()
        for e, _ in entries:
            b = parse_json(request_body(e["request"]))
            if isinstance(b, dict) and isinstance(b.get("requests"), list):
                for r in b["requests"]:
                    if isinstance(r, dict) and "uri" in r:
                        u = urlsplit(str(r["uri"]))
                        qk = ",".join(sorted({k for k, _ in parse_qsl(u.query, keep_blank_values=True)}))
                        inner[(r.get("method", "?"), normalise_path(u.path), qk, str(r.get("id", "")))] += 1
                        for k, v in parse_qsl(u.query):
                            if k == "q":
                                inner_q.add(re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", "<EMAIL>", re.sub(r"[A-Za-z0-9_-]{20,}", "<ID>", v)))
                        for bk in ("payload", "body", "payloadType"):
                            if bk in r:
                                inner_bodies[(str(r.get("id", "")), bk)].append(shape(r[bk]))
        if inner:
            print("- batch inner requests (method, uri template, query keys, id, count):")
            for (m, p, qk, rid), n in sorted(inner.items(), key=lambda kv: -kv[1]):
                print(f"  - {m} {p}  [{qk}]  id={rid}  x{n}")
        if inner_q:
            print("- inner q= examples:")
            for q in sorted(inner_q)[:15]:
                print(f"  - `{q}`")
        for (rid, bk), shapes_ in inner_bodies.items():
            print(f"- inner request {rid}.{bk} shape:")
            print("```json")
            print(json.dumps(merge_shapes(shapes_), indent=1))
            print("```")
        body = None
        for e, _ in entries:
            body = parse_json(request_body(e["request"]))
            if body is not None:
                break
        if body is None and method == "POST":
            pd = entry["request"].get("postData") or {}
            raw = request_body(entry["request"]) or ""
            head = re.sub(r"[^\[\]{}:,\"a-zA-Z_]", "#", raw[:120])
            print(f"- request body: not parsed. mimeType={pd.get('mimeType')!r} textLen={len(raw)} "
                  f"params={len(pd.get('params') or [])} encoding={pd.get('encoding')!r} head={head!r}")
        if body is not None:
            print("- request body shape:")
            print("```json")
            print(json.dumps(shape(body), indent=1))
            print("```")

        resp_shapes = [shape(r) for r in (parse_json(e["response"].get("content", {}).get("text")) for e, _ in entries) if r is not None]
        resp = merge_shapes(resp_shapes) if resp_shapes else None
        if resp is not None:
            print("- response body shape:")
            print("```json")
            print(json.dumps(resp, indent=1))
            print("```")
        print()

    # Long-lived connections hint at a push channel.
    slow = [(e["time"], e["request"]["url"]) for e in har["log"]["entries"] if e["time"] > 20000]
    if slow:
        print("## Requests longer than 20 s (possible long poll / push)")
        for t, u in sorted(slow, reverse=True)[:10]:
            u = urlsplit(u)
            print(f"- {t/1000:.0f} s  {u.netloc}{normalise_path(u.path)}")
    ws = [e for e in har["log"]["entries"] if e.get("_webSocketMessages")]
    if ws:
        print(f"\n## WebSocket connections: {len(ws)}")
        for e in ws:
            u = urlsplit(e["request"]["url"])
            print(f"- {u.netloc}{u.path}  messages={len(e['_webSocketMessages'])}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
