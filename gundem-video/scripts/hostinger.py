#!/usr/bin/env python3
"""Hostinger (ya da FTP destekli herhangi bir web alanı) üzerinden kalıcı köprü — tünel gerekmez.

- Video yayını: dosya FTPS ile public_html/videos/ altına yüklenir; Instagram https://ALANADI/videos/<ad>
  adresinden çeker; yayın bitince silinir (HOSTINGER_KEEP=1 ise kalır).
- Hesap bağlama: public_html/instagram/callback/index.php ve tiktok/callback/index.php geri dönüş kodunu
  bir dosyaya yazar; Mac bu adresi state anahtarıyla yoklayıp kodu alır. Adres sabittir, Meta'ya bir kez yazılır.

secrets/.env:
    HOSTINGER_FTP_HOST=ftp.emixhas.com      (hPanel → Dosyalar → FTP Hesapları; IP de olabilir)
    HOSTINGER_FTP_USER=u123456789.emixhas   (FTP kullanıcı adı)
    HOSTINGER_FTP_PASS=...
    HOSTINGER_SITE_URL=https://emixhas.com  (alan adı; alt alan adı da olabilir)
    HOSTINGER_ROOT=public_html              (FTP kökü; alt alan adı için domains/alt.emixhas.com/public_html)
    HOSTINGER_FTP_TLS=1                     (0: düz FTP)

Kullanım:  python3 scripts/hostinger.py --setup      PHP dosyalarını kurar, klasörleri açar, deneme yükler
           python3 scripts/hostinger.py --upload out/x.mp4
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from ftplib import FTP, FTP_TLS, error_perm
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, load_env  # noqa: E402

CALLBACK_PHP = r"""<?php
// Türkiye Gündemi — OAuth geri dönüş köprüsü. Kod state anahtarıyla dosyaya yazılır, Mac ?poll=<state> ile alır.
$dir = __DIR__ . '/codes';
@mkdir($dir, 0700, true);
@file_put_contents("$dir/.htaccess", "Require all denied\n");
$state = preg_replace('/[^A-Za-z0-9_-]/', '', $_GET['poll'] ?? $_GET['state'] ?? '');
if (isset($_GET['poll'])) {
  header('Content-Type: application/json');
  $f = "$dir/$state.json";
  if ($state !== '' && file_exists($f)) { readfile($f); unlink($f); } else { echo '{}'; }
  exit;
}
if ($state !== '' && (isset($_GET['code']) || isset($_GET['error']))) {
  file_put_contents("$dir/$state.json", json_encode($_GET));
  foreach (glob("$dir/*.json") as $old) { if (filemtime($old) < time() - 900) unlink($old); }
}
header('Content-Type: text/html; charset=utf-8');
echo '<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Arial;background:#0B0F1A;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#E30A17">Türkiye Gündemi</h1><h2>Hesap bağlandı.</h2><p>Bu pencereyi kapatıp panele dönebilirsiniz.</p></div></body>';
"""

# TikTok/Meta geliştirici formları Web sitesi, Kullanım Şartları ve Gizlilik Politikası adresi ister: web alanına
# public_html/uygulama/ altında üç sade sayfa (TR + EN) yüklenir. Kanal adı settings'ten, iletişim CONTACT_EMAIL'den.
LEGAL_CSS = "body{font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;line-height:1.6;color:#1b1f2a}h1{color:#E30A17}h2{margin-top:28px}small{color:#667}"


def legal_pages(channel: str, site: str, contact: str) -> dict:
    c = f"<p>İletişim / Contact: <a href=\"mailto:{contact}\">{contact}</a></p>" if contact else ""
    head = lambda t: f"<!doctype html><html lang=tr><meta charset=utf-8><meta name=viewport content='width=device-width'><title>{t} · {channel}</title><style>{LEGAL_CSS}</style><body>"  # noqa: E731
    nav = f"<p><a href='{site}/uygulama/'>Uygulama</a> · <a href='{site}/uygulama/kosullar.html'>Kullanım Şartları</a> · <a href='{site}/uygulama/gizlilik.html'>Gizlilik</a></p>"
    index = head(channel) + f"""<h1>{channel}</h1>{nav}
<p>{channel}, Türkiye gündemini kısa dikey videolarla özetleyen bağımsız bir haber kanalıdır. Bu sayfa, kanal sahibinin
kendi bilgisayarında çalışan kişisel yayın panelini tanıtır. Panel; videoları kanal sahibinin kendi YouTube, Instagram ve
TikTok hesaplarına, sahibinin izniyle yükler ve bu hesapların izlenme ve takipçi istatistiklerini sahibine gösterir.</p>
<p><i>{channel} is an independent news channel summarising Turkey's agenda in short vertical videos. This page describes the
owner's personal publishing panel, which runs on the owner's own computer and uploads the owner's videos to the owner's own
YouTube, Instagram and TikTok accounts with the owner's authorization, and shows those accounts' view and follower statistics.</i></p>
<h2>TikTok</h2><p>Login Kit ile kanal sahibi kendi TikTok hesabına giriş yapar. Content Posting API ile üretilen video hesabın
gelen kutusuna taslak olarak gönderilir; yayın kararını sahibi TikTok uygulamasında verir. user.info.basic/user.info.stats ile
hesap adı ve takipçi sayısı, video.list ile yüklenen videoların izlenme sayıları panelde gösterilir.</p>{c}</body></html>"""
    terms = head("Kullanım Şartları") + f"""<h1>Kullanım Şartları / Terms of Service</h1>{nav}<small>Son güncelleme: 2026</small>
<p>Bu panel yalnızca {channel} kanal sahibinin kişisel kullanımı içindir; üçüncü kişilere hizmet olarak sunulmaz. Panel,
yalnızca sahibinin bağladığı hesaplarda ve sahibinin verdiği izinler kapsamında işlem yapar. Yayınlanan içerikten kanal
sahibi sorumludur; içerikler ilgili platformların topluluk kurallarına uygun olmalıdır. Bağlantı istendiği an panelden
kesilebilir ve verilen izinler platformun ayarlarından geri alınabilir.</p>
<p><i>This panel is for the personal use of the {channel} channel owner only and is not offered as a service to third parties.
It acts only on accounts the owner connects and within the permissions the owner grants. The owner is responsible for published
content, which must follow each platform's community guidelines. Connections can be removed at any time from the panel, and
permissions can be revoked from the platform's settings.</i></p>{c}</body></html>"""
    privacy = head("Gizlilik Politikası") + f"""<h1>Gizlilik Politikası / Privacy Policy</h1>{nav}<small>Son güncelleme: 2026</small>
<h2>Toplanan veriler</h2><p>Bağlanan hesapların erişim anahtarları, hesap adı, takipçi sayısı ve panel üzerinden yüklenen
videoların izlenme/beğeni sayıları. Başka kullanıcıların kişisel verisi toplanmaz.</p>
<h2>Kullanım ve saklama</h2><p>Veriler yalnızca videoları sahibinin kendi hesaplarına yüklemek ve istatistikleri sahibine
göstermek için kullanılır; kanal sahibinin kendi bilgisayarında saklanır, satılmaz, üçüncü kişilerle paylaşılmaz, reklam
için kullanılmaz. Bağlantı kesildiğinde erişim anahtarı silinir.</p>
<p><i>Collected: access tokens of connected accounts, account name, follower count and view/like counts of videos uploaded by
the panel. No personal data of other users is collected. Data is used only to upload the owner's videos to the owner's own
accounts and to show statistics to the owner; it is stored on the owner's own computer and is never sold, shared with third
parties or used for advertising. Disconnecting deletes the access token.</i></p>{c}</body></html>"""
    return {"uygulama/index.html": index, "uygulama/kosullar.html": terms, "uygulama/gizlilik.html": privacy}


def upload_legal(f=None):
    """Yasal sayfaları yükler; adresleri döndürür."""
    from common import settings
    own = f is None
    f = f or connect()
    base = site_url()
    mkdirs(f, "uygulama")
    for rel, html in legal_pages(settings().get("channelName", "Türkiye Gündemi"), base, load_env().get("CONTACT_EMAIL", "")).items():
        put_bytes(f, rel, html.encode("utf-8"))
    if own:
        f.quit()
    return {"site": f"{base}/uygulama/", "terms": f"{base}/uygulama/kosullar.html", "privacy": f"{base}/uygulama/gizlilik.html"}


VIDEOS_HTACCESS = "Options -Indexes\n<FilesMatch \"\\.(mp4|jpg)$\">\n  Header set Access-Control-Allow-Origin \"*\"\n</FilesMatch>\n"


def configured():
    e = load_env()
    return all(e.get(k) for k in ("HOSTINGER_FTP_HOST", "HOSTINGER_FTP_USER", "HOSTINGER_FTP_PASS", "HOSTINGER_SITE_URL"))


def site_url():
    return (load_env().get("HOSTINGER_SITE_URL") or "").rstrip("/")


def connect():
    e = load_env()
    host, user, pw = e["HOSTINGER_FTP_HOST"], e["HOSTINGER_FTP_USER"], e["HOSTINGER_FTP_PASS"]
    port = int(e.get("HOSTINGER_FTP_PORT") or 21)
    if (e.get("HOSTINGER_FTP_TLS") or "1") != "0":
        try:
            f = FTP_TLS(); f.connect(host, port, timeout=30); f.login(user, pw); f.prot_p()
        except Exception as err:
            print(f"  ! FTPS olmadı ({str(err)[:80]}), düz FTP deneniyor", file=sys.stderr)
            f = FTP(); f.connect(host, port, timeout=30); f.login(user, pw)
    else:
        f = FTP(); f.connect(host, port, timeout=30); f.login(user, pw)
    f.set_pasv(True)
    host = urllib.parse.urlparse(e.get("HOSTINGER_SITE_URL", "")).hostname or ""
    bare = host[4:] if host.startswith("www.") else host
    candidates = [e.get("HOSTINGER_ROOT")] if e.get("HOSTINGER_ROOT") else []
    candidates += ["public_html", f"domains/{bare}/public_html", f"domains/{host}/public_html", f"{bare}/public_html"]
    for root in candidates:
        try:
            f.cwd("/"); f.cwd(root)
            f.web_root = root
            return f
        except error_perm:
            continue
    f.cwd("/")
    try:
        f.web_root = "/ (kök; listede: " + ", ".join(f.nlst()[:12]) + ")"
    except Exception:
        f.web_root = "/"
    return f


def mkdirs(f, rel):
    cur = f.pwd()
    for part in rel.strip("/").split("/"):
        try:
            f.cwd(part)
        except error_perm:
            f.mkd(part); f.cwd(part)
    f.cwd(cur)


def put_bytes(f, rel, data: bytes):
    mkdirs(f, os.path.dirname(rel)) if "/" in rel else None
    f.storbinary(f"STOR {rel}", io.BytesIO(data))


def upload(local: Path, remote_rel: str) -> str:
    """Dosyayı yükler, herkese açık URL'yi döndürür."""
    f = connect()
    try:
        mkdirs(f, os.path.dirname(remote_rel))
        with open(local, "rb") as fh:
            f.storbinary(f"STOR {remote_rel}", fh, blocksize=1 << 20)
    finally:
        f.quit()
    return site_url() + "/" + "/".join(urllib.parse.quote(p) for p in remote_rel.split("/"))


def delete(remote_rel: str):
    try:
        f = connect(); f.delete(remote_rel); f.quit()
    except Exception:
        pass


def reachable(url, timeout=15):
    """HEAD, olmazsa GET (bazı sunucular HEAD'i reddeder)."""
    for method in ("HEAD", "GET"):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=timeout) as r:
                return r.status == 200
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 405) and method == "HEAD":
                continue
            return False
        except Exception:
            return False
    return False


def http_status(url, timeout=15):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return str(e)[:60]


def poll_code(callback_url: str, state: str, timeout_sec=300) -> dict:
    """Geri dönüş sayfasını state ile yoklar; kod gelince döndürür."""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(callback_url + "?poll=" + urllib.parse.quote(state), timeout=15) as r:
                data = json.loads(r.read() or b"{}")
            if data.get("code") or data.get("error"):
                return data
        except Exception:
            pass
        time.sleep(2)
    return {}


def setup():
    if not configured():
        sys.exit("secrets/.env içinde HOSTINGER_FTP_HOST, HOSTINGER_FTP_USER, HOSTINGER_FTP_PASS, HOSTINGER_SITE_URL gerekli")
    f = connect()
    print(f"FTP bağlandı, web kökü: {f.web_root}")
    if f.web_root.startswith("/ ("):
        print("  ! public_html bulunamadı. hPanel → Dosya Yöneticisi'nde sitenin klasör yolunu bulup .env'e HOSTINGER_ROOT=... yazın.")
    for plat in ("instagram", "tiktok"):
        mkdirs(f, f"{plat}/callback/codes")
        put_bytes(f, f"{plat}/callback/index.php", CALLBACK_PHP.encode())
        put_bytes(f, f"{plat}/callback/codes/.htaccess", b"Require all denied\n")
    mkdirs(f, "videos")
    put_bytes(f, "videos/.htaccess", VIDEOS_HTACCESS.encode())
    put_bytes(f, "videos/test.txt", b"ok")
    legal = upload_legal(f)
    f.quit()
    base = site_url()
    ok_v = reachable(base + "/videos/test.txt")
    ok_cb = reachable(base + "/instagram/callback/")
    delete("videos/test.txt")
    v_msg = "erişilebilir ✔" if ok_v else f"ERİŞİLEMEDİ (HTTP {http_status(base + '/videos/.htaccess')} / {http_status(base + '/instagram/callback/')}; HOSTINGER_ROOT doğru mu?)"
    print(f"Video adresi: {base}/videos/  → {v_msg}")
    print(f"Instagram geri dönüş: {base}/instagram/callback/  → {'çalışıyor ✔' if ok_cb else 'ERİŞİLEMEDİ'}")
    print(f"TikTok geri dönüş:    {base}/tiktok/callback/")
    print(f"Uygulama sayfaları:   site {legal['site']} · şartlar {legal['terms']} · gizlilik {legal['privacy']}")
    print("Meta → Facebook Login for Business → Ayarlar → Valid OAuth Redirect URIs alanına bir kez yazın:")
    print(f"  {base}/instagram/callback/")
    print(json.dumps({"ok": ok_v and ok_cb, "videos": ok_v, "callback": ok_cb}))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup", action="store_true")
    ap.add_argument("--upload")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--legal", action="store_true", help="yalnız Web sitesi / Kullanım Şartları / Gizlilik sayfalarını yükle")
    a = ap.parse_args()
    if a.legal:
        print(json.dumps({"ok": True, **upload_legal()}, ensure_ascii=False)); sys.exit(0)
    if a.check:
        base = site_url()
        print(json.dumps({"configured": configured(), "site": base, "callback": bool(base) and reachable(base + "/instagram/callback/")}))
    elif a.setup:
        setup()
    elif a.upload:
        p = Path(a.upload)
        print(upload(p, f"videos/{p.name}"))
