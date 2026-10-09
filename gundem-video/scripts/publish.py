#!/usr/bin/env python3
"""Videoyu YouTube Shorts ve/veya Instagram Reels olarak yayınlar; sonucu data/metrics.json'a yazar.

  python3 scripts/publish.py --connect youtube                 # ilk bağlantı (tarayıcıda Google girişi)
  python3 scripts/publish.py --connect instagram               # Instagram girişi (tünel açıkken; HTTPS geri dönüş)
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

from common import OUT, SECRETS, build_caption, episode_meta, load_env, metrics, now_iso, save_metrics
import hostinger

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
    thumb = path.with_name(path.stem + "-kapak.jpg")
    if thumb.exists():
        try:
            yt.thumbnails().set(videoId=vid, media_body=MediaFileUpload(str(thumb))).execute()
        except Exception as e:  # kanal doğrulanmamışsa özel kapak reddedilir; yayın yine de tamam
            print(f"  ! kapak yüklenemedi: {e}", file=sys.stderr)
    meta = episode_meta(path.name) or {}
    return {"id": vid, "url": f"https://youtube.com/shorts/{vid}", "publishedAt": now_iso(), "title": title, "titleVariant": meta.get("titleVariant")}


# ---------------- Instagram (Instagram API with Instagram Login; eski Facebook Graph token'ı da desteklenir)
IG_TOKEN_FILE = SECRETS / "instagram_token.json"
IG_SCOPES = "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights"
IG_API = "https://graph.instagram.com/v21.0"
FB_API = "https://graph.facebook.com/v21.0"
IG_CALLBACK_PORT = 3138
# Facebook Login yolu izinleri. Her biri Meta uygulamasında Kullanım senaryosu → "Permissions and features" listesinde
# "Add" ile eklenmiş olmalı; eklenmemiş izin "Invalid Scopes" hatası verir. İş portföyüne bağlı sayfalar için
# .env'de IG_EXTRA_SCOPES=business_management eklenebilir.
FB_SCOPES = "instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement"


def fb_finish(env, redirect, code):
    """Facebook Login yolu: kod → kısa kullanıcı token'ı → uzun ömürlü → Sayfa token'ı (süresi dolmaz) +
    sayfaya bağlı Instagram profesyonel hesabının kimliği."""
    q = urllib.parse.urlencode({"client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "redirect_uri": redirect, "code": code})
    short = ig_http(f"{FB_API}/oauth/access_token?{q}")
    q = urllib.parse.urlencode({"grant_type": "fb_exchange_token", "client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "fb_exchange_token": short["access_token"]})
    long_tok = ig_http(f"{FB_API}/oauth/access_token?{q}")
    user_token = long_tok.get("access_token", short["access_token"])
    pages = ig_http(f"{FB_API}/me/accounts?" + urllib.parse.urlencode({"fields": "id,name,access_token,instagram_business_account{id,username}", "limit": "50", "access_token": user_token})).get("data", [])
    page = next((p for p in pages if p.get("instagram_business_account")), None)
    if not page:
        names = ", ".join(p.get("name", "?") for p in pages)
        if not pages:
            raise RuntimeError("Facebook uygulamaya hiçbir Sayfa için izin vermedi. Tekrar bağlanırken giriş ekranında 'Türkiye Gündemi' sayfasını "
                               "işaretleyin (Hesapları düzenle → sayfayı seç). Sayfa bir İş portföyündeyse: Meta uygulamasında business_management iznini "
                               "ekleyip .env'e IG_EXTRA_SCOPES=business_management yazın ve yeniden bağlanın.")
        raise RuntimeError(f"Sayfalar bulundu ({names}) ama hiçbirine Instagram hesabı bağlı değil. Facebook → Sayfa → Ayarlar → Bağlı hesaplar → Instagram → Hesabı bağla; sonra tekrar deneyin.")
    ig = page["instagram_business_account"]
    tok = {"access_token": page["access_token"], "expires_in": 0, "obtained_at": time.time(), "via": "facebook",
           "user_id": str(ig["id"]), "username": ig.get("username"), "page_id": page["id"], "page_name": page.get("name")}
    IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


def ig_http(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(txt).get("error", {}).get("message") or txt
        except Exception:
            msg = txt
        raise RuntimeError(f"Instagram HTTP {e.code}: {msg[:300]}")


def ig_creds():
    """(kullanıcı id, token, API kökü). Önce panelden bağlanan hesap (instagram_token.json, Instagram Login),
    yoksa secrets/.env içindeki IG_USER_ID + IG_ACCESS_TOKEN (Facebook Graph). Token süresi 15 günün
    altına indiyse sessizce yenilenir (60 güne uzar)."""
    if IG_TOKEN_FILE.exists():
        tok = json.loads(IG_TOKEN_FILE.read_text())
        if tok.get("via") == "facebook":  # Sayfa token'ı: süresi dolmaz, graph.facebook.com
            return tok.get("user_id") or "me", tok["access_token"], FB_API
        env = load_env()
        age = time.time() - tok.get("obtained_at", 0)
        left = tok.get("obtained_at", 0) + tok.get("expires_in", 0) - time.time()
        if age > 86400 and left < 15 * 86400:
            try:
                q = urllib.parse.urlencode({"grant_type": "ig_refresh_token", "access_token": tok["access_token"]})
                new = ig_http(f"https://graph.instagram.com/refresh_access_token?{q}")
                tok.update({"access_token": new["access_token"], "expires_in": new.get("expires_in", 5184000), "obtained_at": time.time()})
                IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
            except Exception as e:
                print(f"  ! instagram token yenilenemedi: {e}", file=sys.stderr)
        return tok.get("user_id") or "me", tok["access_token"], IG_API
    env = load_env()
    if env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        return env["IG_USER_ID"], env["IG_ACCESS_TOKEN"], FB_API
    raise RuntimeError("Instagram bağlı değil. Panelde 'Instagram'ı bağla' deyin (IG_APP_ID ve IG_APP_SECRET gerekir, bkz. secrets/README.md)")


def ig_call(method, path, params, creds):
    uid, token, base = creds
    params = dict(params, access_token=token)
    url = f"{base}/{path}"
    if method == "GET":
        return ig_http(url + "?" + urllib.parse.urlencode(params))
    return ig_http(url, urllib.parse.urlencode(params).encode())


def url_reachable(url, timeout=12):
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


class _PublicVideo:
    """Yayın anında dış adres yoksa (panel kapalı, tünel kapalı) out/ klasörünü geçici bir sunucu +
    Cloudflare hızlı tüneliyle açar; yayın bitince kapatır. Böylece launchd üretimi de Instagram'a gider."""

    def __init__(self):
        self.proc = None
        self.srv = None
        self.base = None
        self.remote = None
        self.extra = []

    def ensure(self, name: str) -> str:
        env = load_env()
        if hostinger.configured():  # kalıcı köprü: dosyayı web alanına yükle, Instagram oradan çeksin
            print(f"🌐 Hostinger: yükleniyor {name}", file=sys.stderr, flush=True)
            url = hostinger.upload(OUT / name, f"videos/{name}")
            self.remote = f"videos/{name}"
            for _ in range(10):
                if url_reachable(url):
                    break
                time.sleep(2)
            else:
                raise RuntimeError(f"Yüklenen video dış adresten okunamadı: {url} (HOSTINGER_SITE_URL / HOSTINGER_ROOT ayarlarını kontrol edin)")
            print(f"🌐 Hostinger: yüklendi {url}", file=sys.stderr, flush=True)
            return hostinger.site_url()
        base = (env.get("PUBLIC_BASE_URL") or "").rstrip("/")
        if base and url_reachable(f"{base}/videos/{urllib.parse.quote(name)}"):
            return base
        import http.server
        import shutil
        import subprocess
        import threading
        if not shutil.which("cloudflared"):
            raise RuntimeError("Dış adres yok ve cloudflared kurulu değil (brew install cloudflared); panelde tüneli açın")
        out_dir = OUT

        class H(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=str(out_dir), **kw)

            def translate_path(self, path):  # /videos/<ad> → out/<ad>; başka yol yok
                p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
                if not p.startswith("/videos/") or "/" in p[len("/videos/"):] or not p.endswith(".mp4"):
                    return str(out_dir / "__yok__")
                return str(out_dir / p[len("/videos/"):])

            def log_message(self, *a):
                pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.proc = subprocess.Popen(["cloudflared", "tunnel", "--url", f"http://localhost:{port}"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        import re
        deadline = time.time() + 60
        url = None
        while time.time() < deadline and not url:
            line = self.proc.stdout.readline()
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line or "")
            if m:
                url = m.group(0)
        if not url:
            self.close()
            raise RuntimeError("Geçici tünel açılamadı (cloudflared adres vermedi)")
        threading.Thread(target=lambda: [None for _ in iter(self.proc.stdout.readline, "")], daemon=True).start()
        for _ in range(20):  # DNS yayılması birkaç saniye sürer
            if url_reachable(f"{url}/videos/{urllib.parse.quote(name)}"):
                break
            time.sleep(3)
        self.base = url
        print(f"  geçici dış adres: {url}", file=sys.stderr)
        return url

    def close(self):
        if (load_env().get("HOSTINGER_KEEP") or "0") != "1":
            for rel in self.extra:
                hostinger.delete(rel)
            self.extra = []
        if self.remote and (load_env().get("HOSTINGER_KEEP") or "0") != "1":
            hostinger.delete(self.remote)  # yayın bitti, web alanında yer kaplamasın
            print(f"🌐 Hostinger: silindi {self.remote}", file=sys.stderr, flush=True)
            self.remote = None
        if self.proc:
            self.proc.terminate()
            self.proc = None
        if self.srv:
            self.srv.shutdown()
            self.srv = None


def ig_upload(path: Path):
    creds = ig_creds()
    uid = creds[0]
    _, caption = build_caption(path.name, max_len=2200)
    pub_srv = _PublicVideo()
    try:
        base = pub_srv.ensure(path.name)
        video_url = base + "/videos/" + urllib.parse.quote(path.name)
        params = {"media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true"}
        cover = path.with_name(path.stem + "-kapak.jpg")
        if cover.exists() and hostinger.configured():
            try:
                params["cover_url"] = hostinger.upload(cover, f"videos/{cover.name}")
                pub_srv.extra.append(f"videos/{cover.name}")
                print(f"🌐 Hostinger: kapak yüklendi {cover.name}", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"  ! kapak yüklenemedi: {e}", file=sys.stderr)
        c = ig_call("POST", f"{uid}/media", params, creds)
        cid = c["id"]
        for _ in range(72):  # Instagram videoyu çekip işler; 6 dk'ya kadar bekle
            st = ig_call("GET", cid, {"fields": "status_code,status"}, creds)
            if st.get("status_code") == "FINISHED":
                break
            if st.get("status_code") == "ERROR":
                raise RuntimeError(f"Instagram işleme hatası: {st}")
            time.sleep(5)
        else:
            raise RuntimeError("Instagram işleme zaman aşımı")
        pub = ig_call("POST", f"{uid}/media_publish", {"creation_id": cid}, creds)
    finally:
        pub_srv.close()
    mid = pub["id"]
    info = ig_call("GET", mid, {"fields": "permalink"}, creds)
    return {"id": mid, "url": info.get("permalink"), "publishedAt": now_iso()}


def ig_connect():
    """Tarayıcıda Instagram girişi (Instagram API with Instagram Login). Geri dönüş HTTPS olmak zorunda;
    panel tüneli /instagram/callback'i yerel :3138'e aktarır. Kısa ömürlü kod → 60 günlük token."""
    import http.server
    import secrets as _secrets
    import threading
    import webbrowser
    env = load_env()
    for k in ("IG_APP_ID", "IG_APP_SECRET"):
        if not env.get(k):
            raise RuntimeError(f"secrets/.env içinde {k} eksik (bkz. secrets/README.md)")
    use_host = hostinger.configured() and not env.get("IG_REDIRECT_URI")
    if use_host:
        redirect = hostinger.site_url() + "/instagram/callback/"  # sabit adres, Meta'ya bir kez yazılır
    else:
        redirect = env.get("IG_REDIRECT_URI") or ((env.get("PUBLIC_BASE_URL") or "").rstrip("/") + "/instagram/callback")
    if not redirect.startswith("https://"):
        raise RuntimeError("Instagram geri dönüş adresi HTTPS olmalı: Hostinger köprüsünü kurun (scripts/hostinger.py --setup) ya da tüneli başlatın")
    state = _secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write("<h2>Instagram bağlandı. Bu pencereyi kapatıp panele dönebilirsiniz.</h2>".encode())

        def log_message(self, *a):
            pass

    srv = None
    if not use_host:
        http.server.HTTPServer.allow_reuse_address = True
        try:
            srv = http.server.HTTPServer(("127.0.0.1", IG_CALLBACK_PORT), H)
        except OSError as e:
            raise RuntimeError(f"Geri dönüş portu {IG_CALLBACK_PORT} açılamadı ({e}); önceki bağlanma denemesi hâlâ sürüyor olabilir, 1 dk bekleyip tekrar deneyin")
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    via = (env.get("IG_LOGIN") or "instagram").lower()  # instagram: Instagram Login (sayfa gerekmez) | facebook: Facebook Login (Facebook Sayfası + bağlı Instagram)
    if via == "facebook":
        # auth_type=rerequest: daha önce atlanan sayfa/izin seçimini yeniden sorar
        params = {"client_id": env["IG_APP_ID"], "redirect_uri": redirect, "response_type": "code", "state": state, "auth_type": "rerequest"}
        if env.get("IG_CONFIG_ID"):  # Facebook Login for Business "Configuration" kimliği: izinler yapılandırmadan gelir
            params["config_id"] = env["IG_CONFIG_ID"]
        else:
            params["scope"] = ",".join(x for x in (FB_SCOPES + "," + (env.get("IG_EXTRA_SCOPES") or "")).split(",") if x)
        url = "https://www.facebook.com/v21.0/dialog/oauth?" + urllib.parse.urlencode(params)
    else:
        url = "https://www.instagram.com/oauth/authorize?" + urllib.parse.urlencode({
            "client_id": env["IG_APP_ID"], "redirect_uri": redirect, "response_type": "code", "scope": IG_SCOPES, "state": state, "force_reauth": "true"})
    print(f"AUTH_URL {url}", file=sys.stderr, flush=True)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    if use_host:
        got.update(hostinger.poll_code(redirect, state, 300))
    else:
        for _ in range(600):  # 5 dk
            if "code" in got or "error" in got:
                break
            time.sleep(0.5)
        srv.shutdown()
    if got.get("error"):
        raise RuntimeError(f"Instagram reddetti: {got.get('error_description') or got.get('error_reason') or got['error']}")
    if got.get("state") != state or "code" not in got:
        raise RuntimeError("Instagram geri dönüşü alınamadı (redirect URI uygulamada aynen kayıtlı mı?)")
    code = got["code"].split("#")[0]
    if via == "facebook":
        return fb_finish(env, redirect, code)
    form = urllib.parse.urlencode({"client_id": env["IG_APP_ID"], "client_secret": env["IG_APP_SECRET"], "grant_type": "authorization_code",
                                   "redirect_uri": redirect, "code": code}).encode()
    short = ig_http("https://api.instagram.com/oauth/access_token", form)
    if "access_token" not in short:
        raise RuntimeError(f"Instagram token alınamadı: {short}")
    q = urllib.parse.urlencode({"grant_type": "ig_exchange_token", "client_secret": env["IG_APP_SECRET"], "access_token": short["access_token"]})
    long_tok = ig_http(f"https://graph.instagram.com/access_token?{q}")
    token = long_tok.get("access_token", short["access_token"])
    me = ig_http(f"{IG_API}/me?" + urllib.parse.urlencode({"fields": "user_id,username,account_type", "access_token": token}))
    tok = {"access_token": token, "expires_in": long_tok.get("expires_in", 5184000), "obtained_at": time.time(),
           "user_id": str(me.get("user_id") or short.get("user_id") or "me"), "username": me.get("username"), "account_type": me.get("account_type"),
           "permissions": short.get("permissions")}
    IG_TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok


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
def ig_status(env):
    import shutil
    st = {"connected": False, "appKeys": bool(env.get("IG_APP_ID") and env.get("IG_APP_SECRET")), "publicUrl": bool(env.get("PUBLIC_BASE_URL")), "login": (env.get("IG_LOGIN") or "instagram").lower(),
          "hostinger": hostinger.configured(), "hostingerUrl": hostinger.site_url() if hostinger.configured() else None,
          "cloudflared": bool(shutil.which("cloudflared")), "username": None, "daysLeft": None, "via": None}
    if IG_TOKEN_FILE.exists():
        try:
            tok = json.loads(IG_TOKEN_FILE.read_text())
            st.update({"connected": True, "via": tok.get("via") or "instagram_login", "username": tok.get("username"), "pageName": tok.get("page_name"),
                       "daysLeft": None if tok.get("via") == "facebook" else max(0, int((tok.get("obtained_at", 0) + tok.get("expires_in", 0) - time.time()) / 86400))})
        except Exception:
            pass
    elif env.get("IG_USER_ID") and env.get("IG_ACCESS_TOKEN"):
        st.update({"connected": True, "via": "env"})
    return st


def status():
    env = load_env()
    yt_ok = (SECRETS / "youtube_token.json").exists()
    return {
        "youtube": {"connected": yt_ok, "clientFile": (SECRETS / "youtube_client.json").exists()},
        "instagram": ig_status(env),
        "tiktok": {"connected": TT_TOKEN_FILE.exists(), "appKeys": bool(env.get("TIKTOK_CLIENT_KEY") and env.get("TIKTOK_CLIENT_SECRET")),
                   "mode": (env.get("TIKTOK_MODE") or "inbox").lower()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--platform", choices=["youtube", "instagram", "tiktok"])
    ap.add_argument("--connect", choices=["youtube", "tiktok", "instagram"])
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
    if a.connect == "instagram":
        try:
            tok = ig_connect()
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)); sys.exit(1)
        print(json.dumps({"ok": True, "message": f"Instagram bağlandı: @{tok.get('username') or '?'}", "username": tok.get("username")}, ensure_ascii=False)); return
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
