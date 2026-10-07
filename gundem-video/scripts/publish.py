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


# ---------------- durum
def status():
    env = load_env()
    yt_ok = (SECRETS / "youtube_token.json").exists()
    return {
        "youtube": {"connected": yt_ok, "clientFile": (SECRETS / "youtube_client.json").exists()},
        "instagram": {"connected": bool(env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN")), "publicUrl": bool(env.get("PUBLIC_BASE_URL"))},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--platform", choices=["youtube", "instagram"])
    ap.add_argument("--connect", choices=["youtube"])
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.status:
        print(json.dumps(status(), ensure_ascii=False)); return
    if a.connect == "youtube":
        yt_service(interactive=True); print(json.dumps({"ok": True, "message": "YouTube bağlandı"})); return
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
        res = yt_upload(path) if a.platform == "youtube" else ig_upload(path)
    except Exception as e:  # hatayı JSON olarak döndür, panel okur
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
    entry[a.platform] = res
    save_metrics(m)
    print(json.dumps({"ok": True, **res}, ensure_ascii=False))


if __name__ == "__main__":
    main()
