#!/usr/bin/env python3
"""ym: command-line client for Yahoo Mail over the ws/v3 batch API the web UI uses.

Setup: put the Cookie header value of a logged-in mail.yahoo.com session in cookie.txt next to
this script, then run `ym bootstrap`. That stores wssid and mailbox id in session.json.

Commands:
  ym bootstrap                 extract wssid and mailbox id from the mail.yahoo.com page
  ym folders                   list folders with unread/total counts
  ym ls [folderId] [n] [off]   list messages (default: Inbox, 25, 0)
  ym search "<query>"          raw q= query, same language as ls
  ym cat <msgId>               print headers and body text of one message
  ym read|unread|star|unstar <msgId>...
  ym move <folderId> <msgId>...
  ym rm <msgId>...             delete (moves to Trash on Yahoo's side)
  ym sync                      one mailbox.sync poll, prints folders whose modseq changed
  ym raw <METHOD> <uri> [json] send an arbitrary inner request

Every command prints wall-clock latency to stderr. Nothing is cached; every call hits Yahoo.
"""

import html
import json
import os
import re
import sys
import time
import uuid
import urllib.request
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(HERE, "cookie.txt")
SESSION_FILE = os.path.join(HERE, "session.json")
BATCH_URL = "https://mail.yahoo.com/c/ws/v3/batch"
APP_ID = "YMailNorrin"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")
LIST_FILTER = "-folderType:(SYNC)-folderType:(INVISIBLE)"


def die(msg):
    sys.exit(f"ym: {msg}")


def load_cookie():
    try:
        with open(COOKIE_FILE, encoding="utf-8") as f:
            return f.read().strip().removeprefix("cookie:").removeprefix("Cookie:").strip()
    except FileNotFoundError:
        die(f"{COOKIE_FILE} missing; paste the Cookie header value of a mail.yahoo.com request into it")


def load_session():
    try:
        with open(SESSION_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        die("run `ym bootstrap` first")


def http(method, url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    req.add_header("Cookie", load_cookie())
    req.add_header("Accept", "application/json, text/html;q=0.9, */*;q=0.1")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        body = e.read()
        status = e.code
    ms = (time.perf_counter() - t0) * 1000
    print(f"[{method} {urllib.parse.urlsplit(url).path.split('/')[-1]} {status} {ms:.0f} ms]", file=sys.stderr)
    return status, body


def bootstrap():
    """Pull wssid and mailbox id out of the mail.yahoo.com page's embedded state."""
    status, body = http("GET", "https://mail.yahoo.com/")
    text = body.decode("utf-8", "replace")
    if status != 200 or "login.yahoo.com" in text[:4000]:
        die(f"not logged in (status {status}); refresh cookie.txt from a live session")
    wssid = re.search(r'"wssid"\s*:\s*"([^"]+)"', text) or re.search(r'wssid=([A-Za-z0-9_.-]+)', text)
    mailbox = (re.search(r'"mailboxId"\s*:\s*"([^"]+)"', text)
               or re.search(r'/ws/v3/mailboxes/@\.id==([^/"?&]+)', text)
               or re.search(r'"mailboxes"\s*:\s*\[\s*\{[^}]*?"id"\s*:\s*"([^"]+)"', text))
    if not wssid or not mailbox:
        found = sorted(set(re.findall(r'"(wssid|mailboxId|mailboxes|accounts)"', text)))
        die(f"could not find wssid/mailboxId in page ({len(text)} bytes); keys present: {found}. "
            f"Fallback: create session.json by hand with {{\"wssid\": ..., \"mailboxId\": ...}} "
            f"taken from any batch request URL and URI in DevTools.")
    sess = {"wssid": html.unescape(wssid.group(1)), "mailboxId": html.unescape(mailbox.group(1))}
    with open(SESSION_FILE, "w", encoding="utf-8") as f:
        json.dump(sess, f, indent=1)
    print(f"session.json written: mailbox {sess['mailboxId']}, wssid {sess['wssid'][:6]}...")


def batch(name, requests_):
    """Send inner requests in one batch envelope; returns the list of inner responses."""
    sess = load_session()
    for r in requests_:
        r["uri"] = r["uri"].replace("<mb>", sess["mailboxId"])
        r.setdefault("payloadType", "embedded")
    envelope = json.dumps({"requests": requests_, "responseType": "json"})
    boundary = "----ymBoundary" + uuid.uuid4().hex[:16]
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"batchJson\"\r\n\r\n"
            f"{envelope}\r\n--{boundary}--\r\n").encode("utf-8")
    qs = urllib.parse.urlencode({"name": name, "appId": APP_ID, "wssid": sess["wssid"],
                                 "ymreqid": str(uuid.uuid4()), "nonblocking": "true"})
    status, raw = http("POST", f"{BATCH_URL}?{qs}",
                       {"Content-Type": f"multipart/form-data; boundary={boundary}"}, body)
    if status in (401, 403):
        die(f"batch returned {status}: wssid or cookies expired, re-run `ym bootstrap` with a fresh cookie.txt")
    try:
        doc = json.loads(raw)
    except ValueError:
        die(f"non-JSON response ({status}): {raw[:300]!r}")
    if doc.get("error"):
        die(f"api error: {doc['error']}")
    result = doc.get("result", {})
    failed = result.get("status", {}).get("failedRequests") or []
    if failed:
        print(f"ym: failed inner requests: {json.dumps(failed)}", file=sys.stderr)
    return result.get("responses", [])


def inner_result(responses, i=0):
    r = responses[i]
    if "response" in r:
        return r["response"].get("result", r["response"])
    return {"httpCode": r.get("httpCode"), "responseString": r.get("responseString")}


def addr(lst):
    return ", ".join(f"{a.get('name') or ''} <{a.get('email')}>".strip() for a in lst or [])


def when(epoch):
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(epoch)))
    except (TypeError, ValueError):
        return str(epoch)


def cmd_folders():
    res = inner_result(batch("folders.list", [
        {"id": "GetFolders", "uri": "/ws/v3/mailboxes/@.id==<mb>/folders", "method": "GET"}]))
    folders = res.get("folders", [])
    for f in folders:
        types = ",".join(f.get("types", []))
        if "SYNC" in types or "INVISIBLE" in types:
            continue
        print(f"{f['id']:>6}  {f.get('unread', 0):>5}/{f.get('total', 0):<6} modseq={f.get('highestModSeq')}  "
              f"{f['name']}  [{types}]")
    hidden = sum(1 for f in folders if {"SYNC", "INVISIBLE"} & set(f.get("types", [])))
    print(f"({len(folders)} folders, {hidden} hidden)", file=sys.stderr)


def list_query(q):
    res = inner_result(batch("messageGroups.getList", [
        {"id": "GetMessageGroupList",
         "uri": "/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=" + urllib.parse.quote(q),
         "method": "GET"}]))
    for m in res.get("messages", []):
        h = m.get("headers", {})
        fl = m.get("flags", {})
        mark = ("N" if not fl.get("read") else " ") + ("*" if fl.get("flagged") else " ") \
               + ("A" if m.get("attachmentCount") else " ")
        frm = (h.get("from") or [{}])[0]
        print(f"{m['id']}  {mark}  {when(h.get('date')):16}  {(frm.get('name') or frm.get('email') or '')[:22]:22}  "
              f"{(h.get('subject') or '')[:60]}")
    qinfo = res.get("query", {})
    print(f"(nextModSeq={qinfo.get('nextModSeq')} token={qinfo.get('token')})", file=sys.stderr)


def cmd_ls(folder="1", n="25", off="0"):
    list_query(f"folderId:{folder} {LIST_FILTER} count:{n} offset:{off} -sort:date")


def cmd_search(q):
    list_query(q)


def cmd_cat(msg_id):
    res = inner_result(batch("messages.getBodyFull", [
        {"id": "GetSimpleBody_0",
         "uri": f"/ws/v3/mailboxes/@.id==<mb>/messages/@.id=={msg_id}/content/simplebody/full",
         "method": "GET"}]))
    m = res.get("message", {})
    h = m.get("headers", {})
    print(f"From:    {addr(h.get('from'))}\nTo:      {addr(h.get('to'))}\nCc:      {addr(h.get('cc'))}\n"
          f"Date:    {when(h.get('date'))}\nSubject: {h.get('subject')}\nFolder:  {m.get('folder', {}).get('name')}  "
          f"Conv: {m.get('conversationId')}  Flags: {m.get('flags')}")
    for a in res.get("simpleBody", {}).get("attachments", []):
        print(f"Attach:  {a.get('filename')} ({a.get('size')} B, {a.get('type')}/{a.get('subtype')})")
    body_html = res.get("simpleBody", {}).get("html", "")
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body_html, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>|</p>|</div>|</tr>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    print("\n" + text)


def update(name, ids, payload):
    reqs = [{"id": f"UnifiedUpdateMessage_{i}",
             "uri": f"/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=id:({mid})",
             "method": "POST", "payload": payload} for i, mid in enumerate(ids)]
    for i, r in enumerate(batch(name, reqs)):
        print(f"{ids[i]}  httpCode={r.get('httpCode')}")


def cmd_read(*ids):
    update("messages.readFlagUpdate", ids, {"message": {"flags": {"read": True}}})


def cmd_unread(*ids):
    update("messages.readFlagUpdate", ids, {"message": {"flags": {"read": False}}})


def cmd_star(*ids):
    update("messages.starFlagUpdate", ids, {"message": {"flags": {"flagged": True}}})


def cmd_unstar(*ids):
    update("messages.starFlagUpdate", ids, {"message": {"flags": {"flagged": False}}})


def cmd_move(folder, *ids):
    update("messages.move", ids, {"message": {"folder": {"id": folder}}})


def cmd_rm(*ids):
    reqs = [{"id": f"UnifiedDeleteMessage_{i}",
             "uri": f"/ws/v3/mailboxes/@.id==<mb>/messages/@.select==q?q=id:({mid})",
             "method": "DELETE"} for i, mid in enumerate(ids)]
    for i, r in enumerate(batch("messages.delete", reqs)):
        print(f"{ids[i]}  httpCode={r.get('httpCode')}")


def cmd_sync():
    """Poll folders and report which ones changed since the previous poll (state in sync.json)."""
    state_file = os.path.join(HERE, "sync.json")
    try:
        with open(state_file, encoding="utf-8") as f:
            prev = json.load(f)
    except FileNotFoundError:
        prev = {}
    res = inner_result(batch("mailbox.sync", [
        {"id": "GetFolders", "uri": "/ws/v3/mailboxes/@.id==<mb>/folders", "method": "GET"}]))
    cur = {f["id"]: [f.get("highestModSeq"), f.get("unread"), f.get("total")] for f in res.get("folders", [])}
    names = {f["id"]: f["name"] for f in res.get("folders", [])}
    for fid, v in cur.items():
        if prev.get(fid) != v:
            print(f"{fid:>6}  {names[fid]:30}  modseq {prev.get(fid, ['-'])[0]} -> {v[0]}  unread {v[1]}  total {v[2]}")
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(cur, f)


def cmd_raw(method, uri, payload=None):
    r = {"id": "Raw", "uri": uri, "method": method.upper()}
    if payload:
        r["payload"] = json.loads(payload)
    print(json.dumps(batch("raw", [r]), indent=1)[:20000])


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        sys.exit(__doc__)
    cmd = argv[1]
    if cmd == "bootstrap":
        return bootstrap()
    fn = globals().get("cmd_" + cmd)
    if not fn:
        die(f"unknown command {cmd!r}")
    try:
        fn(*argv[2:])
    except TypeError as e:
        die(f"bad arguments for {cmd}: {e}")


if __name__ == "__main__":
    main(sys.argv)
