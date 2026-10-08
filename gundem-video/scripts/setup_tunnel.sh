#!/usr/bin/env bash
# Kalıcı tünel adresi kurar (Cloudflare adlı tünel). Tek seferlik.
#   bash scripts/setup_tunnel.sh video.ALANADINIZ.com
# Gereken: cloudflared (brew install cloudflared) ve Cloudflare'de yönetilen bir alan adı (ücretsiz plan yeter).
# Alan adınızın DNS'i Cloudflare'de değilse: dash.cloudflare.com → "Add a domain" → verdiği iki ad sunucusunu
# alan adını aldığınız yerde (GoDaddy, Natro, İsimtescil…) ad sunucusu olarak yazın; yayılması birkaç saat sürebilir.
set -e
cd "$(dirname "$0")/.."
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
HOST="$1"; NAME="${2:-gundem}"
[ -n "$HOST" ] || { echo "Kullanım: bash scripts/setup_tunnel.sh video.ALANADINIZ.com"; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared yok: brew install cloudflared"; exit 1; }
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "== 1/3 Cloudflare girişi (tarayıcı açılır; alan adınızı seçip Authorize deyin)"
  cloudflared tunnel login
fi
echo "== 2/3 Tünel: $NAME"
cloudflared tunnel list 2>/dev/null | grep -q " $NAME " || cloudflared tunnel create "$NAME"
echo "== 3/3 DNS kaydı: $HOST → tünel"
cloudflared tunnel route dns --overwrite-dns "$NAME" "$HOST"
mkdir -p secrets
sed -i '' '/^TUNNEL_NAME=/d; /^TUNNEL_HOSTNAME=/d; /^PUBLIC_BASE_URL=/d' secrets/.env 2>/dev/null || true
printf 'TUNNEL_NAME=%s\nTUNNEL_HOSTNAME=%s\nPUBLIC_BASE_URL=https://%s\n' "$NAME" "$HOST" "$HOST" >> secrets/.env
echo
echo "Tamam. Kalıcı adres: https://$HOST"
echo "Instagram geri dönüş adresi (Meta → Valid OAuth Redirect URIs, bir kez): https://$HOST/instagram/callback"
echo "TikTok için: https://$HOST/tiktok/callback"
echo "Panelde tüneli yeniden başlatın (Ayarlar → Cloudflare Tüneli → Durdur, Başlat) ya da paneli yeniden başlatın."
