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
    root = e.get("HOSTINGER_ROOT") or "public_html"
    try:
        f.cwd(root)
    except error_perm:
        f.cwd("/")  # bazı hesaplarda FTP kökü zaten public_html'dir
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
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


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
    print(f"FTP bağlandı: {f.pwd()}")
    for plat in ("instagram", "tiktok"):
        mkdirs(f, f"{plat}/callback/codes")
        put_bytes(f, f"{plat}/callback/index.php", CALLBACK_PHP.encode())
        put_bytes(f, f"{plat}/callback/codes/.htaccess", b"Require all denied\n")
    mkdirs(f, "videos")
    put_bytes(f, "videos/.htaccess", VIDEOS_HTACCESS.encode())
    put_bytes(f, "videos/test.txt", b"ok")
    f.quit()
    base = site_url()
    ok_v = reachable(base + "/videos/test.txt")
    ok_cb = reachable(base + "/instagram/callback/")
    delete("videos/test.txt")
    v_msg = "erişilebilir ✔" if ok_v else "ERİŞİLEMEDİ (alan adı bu hostinge bağlı mı? HOSTINGER_ROOT doğru mu?)"
    print(f"Video adresi: {base}/videos/  → {v_msg}")
    print(f"Instagram geri dönüş: {base}/instagram/callback/  → {'çalışıyor ✔' if ok_cb else 'ERİŞİLEMEDİ'}")
    print(f"TikTok geri dönüş:    {base}/tiktok/callback/")
    print("Meta → Facebook Login for Business → Ayarlar → Valid OAuth Redirect URIs alanına bir kez yazın:")
    print(f"  {base}/instagram/callback/")
    print(json.dumps({"ok": ok_v and ok_cb, "videos": ok_v, "callback": ok_cb}))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup", action="store_true")
    ap.add_argument("--upload")
    a = ap.parse_args()
    if a.setup:
        setup()
    elif a.upload:
        p = Path(a.upload)
        print(upload(p, f"videos/{p.name}"))
