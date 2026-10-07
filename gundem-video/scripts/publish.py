#!/usr/bin/env python3
"""Videoyu YouTube Shorts ve/veya Instagram Reels olarak yayınlar; sonucu data/metrics.json'a yazar.

  python3 scripts/publish.py --connect youtube                 # ilk bağlantı (tarayıcıda Google girişi)
  python3 scripts/publish.py --file out/2026-10-07-1.mp4 --platform youtube
  python3 scripts/publish.py --file out/2026-10-07-1.mp4 --platform instagram
  python3 scripts/publish.py --status                          # bağlantı durumu (JSON)
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from common import OUT, SECRETS, build_caption, load_env, metrics, now_iso, save_metrics

YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]


# ---------------- YouTube
def yt_service(interactive=False):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        sys.exit("Eksik paket: pip install google-api-python-client google-auth-oauthlib")
    client = SECRETS / "youtube_client.json"
    token = SECRETS / "youtube_token.json"
    creds = Credentials.from_authorized_user_file(str(token), YT_SCOPES) if token.exists() else None
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token.write_text(creds.to_json())
    if not creds or not creds.valid:
        if not interactive:
            raise RuntimeError("YouTube bağlı değil. Önce: python3 scripts/publish.py --connect youtube")
        if not client.exists():
            raise RuntimeError(f"{client} yok. Google Cloud'dan OAuth istemci dosyasını buraya koyun.")
        from google_auth_oauthlib.flow import InstalledAppFlow
        creds = InstalledAppFlow.from_client_secrets_file(str(client), YT_SCOPES).run_local_server(port=0)
        token.write_text(creds.to_json())
    return build("youtube", "v3", credentials=creds, cache_discovery=False)


def yt_upload(path: Path):
    from googleapiclient.http import MediaFileUpload
    yt = yt_service()
    title, desc = build_caption(path.name, max_len=4900)
    body = {"snippet": {"title": title, "description": desc, "categoryId": "25", "defaultLanguage": "tr"},
            "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}}
    req = yt.videos().insert(part="snippet,status", body=body, media_body=MediaFileUpload(str(path), chunksize=-1, resumable=True))
    resp = None
    while resp is None:
        _, resp = req.next_chunk()
    vid = resp["id"]
    return {"id": vid, "url": f"https://youtube.com/shorts/{vid}", "publishedAt": now_iso(), "title": title}


# ---------------- Instagram (Graph API)
def ig_call(method, path, params, env):
    params = dict(params, access_token=env["IG_ACCESS_TOKEN"])
    url = f"https://graph.facebook.com/v21.0/{path}"
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data if method == "POST" else None, method=method)
    if method == "GET":
        req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def ig_upload(path: Path):
    env = load_env()
    for k in ("IG_USER_ID", "IG_ACCESS_TOKEN", "PUBLIC_BASE_URL"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    _, caption = build_caption(path.name, max_len=2200)
    video_url = env["PUBLIC_BASE_URL"].rstrip("/") + "/videos/" + urllib.parse.quote(path.name)
    c = ig_call("POST", f"{env['IG_USER_ID']}/media", {"media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true"}, env)
    cid = c["id"]
    for _ in range(60):  # Instagram videoyu çekip işler; 5 dk'ya kadar bekle
        st = ig_call("GET", cid, {"fields": "status_code,status"}, env)
        if st.get("status_code") == "FINISHED":
            break
        if st.get("status_code") == "ERROR":
            raise RuntimeError(f"Instagram işleme hatası: {st}")
        time.sleep(5)
    else:
        raise RuntimeError("Instagram işleme zaman aşımı")
    pub = ig_call("POST", f"{env['IG_USER_ID']}/media_publish", {"creation_id": cid}, env)
    mid = pub["id"]
    info = ig_call("GET", mid, {"fields": "permalink"}, env)
    return {"id": mid, "url": info.get("permalink"), "publishedAt": now_iso()}


# ---------------- TikTok (Content Posting API + Login Kit)
TT_AUTH = "https://www.tiktok.com/v2/auth/authorize/"
TT_API = "https://open.tiktokapis.com/v2"
TT_SCOPES = "user.info.basic,video.list,video.upload,video.publish"
TT_TOKEN_FILE = SECRETS / "tiktok_token.json"


def tt_http(method, url, data=None, headers=None, raw=False):
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    if not raw and data is not None:
        req.add_header("Content-Type", "application/json; charset=UTF-8")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"TikTok HTTP {e.code}: {txt[:400]}")
    return json.loads(txt) if txt.strip().startswith("{") else {}


def tt_token_request(env, form):
    data = urllib.parse.urlencode({"client_key": env["TIKTOK_CLIENT_KEY"], "client_secret": env["TIKTOK_CLIENT_SECRET"], **form}).encode()
    req = urllib.request.Request(f"{TT_API}/oauth/token/", data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=60) as r:
        tok = json.loads(r.read())
    if "access_token" not in tok:
        raise RuntimeError(f"TikTok token alınamadı: {tok}")
    tok["obtained_at"] = time.time()
    TT_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


def tt_access_token():
    env = load_env()
    for k in ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    if not TT_TOKEN_FILE.exists():
        raise RuntimeError("TikTok bağlı değil. Önce: python3 scripts/publish.py --connect tiktok")
    tok = json.loads(TT_TOKEN_FILE.read_text())
    if time.time() - tok.get("obtained_at", 0) > tok.get("expires_in", 86400) - 300:
        tok = tt_token_request(env, {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
    return tok["access_token"]


def tt_connect():
    """Tarayıcıda TikTok girişi; yerel geri dönüş sunucusu kodu yakalar."""
    import http.server
    import secrets as _secrets
    import threading
    import webbrowser
    env = load_env()
    for k in ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    redirect = env.get("TIKTOK_REDIRECT_URI", "http://localhost:3137/tiktok/callback")
    state = _secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write("<h2>TikTok bağlandı. Bu pencereyi kapatabilirsiniz.</h2>".encode())
        def log_message(self, *a):  # sessiz
            pass

    port = int(urllib.parse.urlparse(redirect).port or 3137)
    srv = http.server.HTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = TT_AUTH + "?" + urllib.parse.urlencode({"client_key": env["TIKTOK_CLIENT_KEY"], "scope": TT_SCOPES, "response_type": "code",
                                                  "redirect_uri": redirect, "state": state})
    print(f"Tarayıcıda açılıyor: {url}", file=sys.stderr)
    webbrowser.open(url)
    for _ in range(600):  # 5 dk bekle
        if "code" in got or "error" in got:
            break
        time.sleep(0.5)
    srv.shutdown()
    if got.get("error"):
        raise RuntimeError(f"TikTok reddetti: {got.get('error_description') or got['error']}")
    if got.get("state") != state or "code" not in got:
        raise RuntimeError("TikTok geri dönüşü alınamadı (redirect URI uygulamada kayıtlı mı?)")
    tt_token_request(env, {"grant_type": "authorization_code", "code": got["code"], "redirect_uri": redirect})


def tt_upload(path: Path):
    """mode=inbox: TikTok gelen kutusuna taslak (onaysız uygulamada da çalışır, telefondan yayınlanır).
    mode=direct: doğrudan yayın (uygulama TikTok denetiminden geçmişse herkese açık, geçmemişse yalnızca-ben)."""
    env = load_env()
    mode = (env.get("TIKTOK_MODE") or "inbox").lower()
    token = tt_access_token()
    H = {"Authorization": f"Bearer {token}"}
    size = path.stat().st_size
    chunk = size if size <= 64 * 1024 * 1024 else 10 * 1024 * 1024
    total = -(-size // chunk)
    source = {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": total}
    title, _ = build_caption(path.name, max_len=150)
    if mode == "direct":
        info = tt_http("POST", f"{TT_API}/post/publish/creator_info/query/", {}, H).get("data", {})
        opts = info.get("privacy_level_options") or ["SELF_ONLY"]
        privacy = "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in opts else opts[0]
        init = tt_http("POST", f"{TT_API}/post/publish/video/init/",
                       {"post_info": {"title": title[:150], "privacy_level": privacy, "disable_duet": False, "disable_comment": False, "disable_stitch": False},
                        "source_info": source}, H)
    else:
        privacy = None
        init = tt_http("POST", f"{TT_API}/post/publish/inbox/video/init/", {"source_info": source}, H)
    if init.get("error", {}).get("code") not in (None, "ok"):
        raise RuntimeError(f"TikTok init hatası: {init['error']}")
    data = init["data"]
    publish_id, upload_url = data["publish_id"], data["upload_url"]
    with open(path, "rb") as f:
        for i in range(total):
            start = i * chunk
            blob = f.read(chunk)
            end = start + len(blob) - 1
            tt_http("PUT", upload_url, blob, {"Content-Type": "video/mp4", "Content-Length": str(len(blob)),
                                             "Content-Range": f"bytes {start}-{end}/{size}"}, raw=True)
    status = None
    for _ in range(60):
        st = tt_http("POST", f"{TT_API}/post/publish/status/fetch/", {"publish_id": publish_id}, H).get("data", {})
        status = st.get("status")
        if status in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX", "FAILED"):
            break
        time.sleep(5)
    if status == "FAILED":
        raise RuntimeError(f"TikTok işleme hatası: {st.get('fail_reason')}")
    post_ids = st.get("publicaly_available_post_id") or []
    return {"id": post_ids[0] if post_ids else publish_id, "publish_id": publish_id, "mode": mode, "privacy": privacy,
            "status": status, "url": f"https://www.tiktok.com/@me/video/{post_ids[0]}" if post_ids else None,
            "publishedAt": now_iso(), "title": title,
            "note": "Gelen kutusuna gönderildi; TikTok uygulamasında bildirime dokunup yayınlayın." if mode != "direct" else None}


# ---------------- durum
def status():
    env = load_env()
    yt_ok = (SECRETS / "youtube_token.json").exists()
    return {
        "youtube": {"connected": yt_ok, "clientFile": (SECRETS / "youtube_client.json").exists()},
        "instagram": {"connected": bool(env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN")), "publicUrl": bool(env.get("PUBLIC_BASE_URL"))},
        "tiktok": {"connected": TT_TOKEN_FILE.exists(), "appKeys": bool(env.get("TIKTOK_CLIENT_KEY") and env.get("TIKTOK_CLIENT_SECRET")),
                   "mode": (env.get("TIKTOK_MODE") or "inbox").lower()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--platform", choices=["youtube", "instagram", "tiktok"])
    ap.add_argument("--connect", choices=["youtube", "tiktok"])
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.status:
        print(json.dumps(status(), ensure_ascii=False)); return
    if a.connect == "youtube":
        try:
            yt_service(interactive=True)
        except Exception as e:  # paneli okunur bir mesajla bilgilendir
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(json.dumps({"ok": True, "message": "YouTube bağlandı"}, ensure_ascii=False)); return
    if a.connect == "tiktok":
        try:
            tt_connect()
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(json.dumps({"ok": True, "message": "TikTok bağlandı"}, ensure_ascii=False)); return
    if not (a.file and a.platform):
        ap.error("--file ve --platform gerekli")
    path = Path(a.file) if Path(a.file).is_absolute() else OUT / Path(a.file).name
    if not path.exists():
        sys.exit(f"Dosya yok: {path}")
    m = metrics()
    entry = m["videos"].setdefault(path.name, {})
    if entry.get(a.platform, {}).get("id"):
        print(json.dumps({"ok": True, "skipped": True, "message": f"{a.platform} için zaten yayınlanmış", **entry[a.platform]}, ensure_ascii=False)); return
    try:
        res = {"youtube": yt_upload, "instagram": ig_upload, "tiktok": tt_upload}[a.platform](path)
    except Exception as e:  # hatayı JSON olarak döndür, panel okur
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
    entry[a.platform] = res
    save_metrics(m)
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))


if __name__ == "__main__":
    main()
