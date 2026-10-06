# REMAK MAKİNA - Kurumsal Web Sitesi

Tekstil makineleri üreticisi REMAK MAKİNA için PHP + MySQL tabanlı kurumsal web sitesi ve yönetim paneli.
2026 e-katalogdaki 13 makine, 4 ürün grubu, vizyon/misyon metinleri ve iletişim bilgileri kurulumla birlikte yüklenir.

## Özellikler

- **Anasayfa:** tam ekran hero, kaydırmayla yatay ilerleyen makine parkuru (GSAP ScrollTrigger), ürün grupları, kurumsal tanıtım, "Neden REMAK" yapışkan bölümü, üretim tesisi galerisi, teklif bandı.
- **Ürünler:** kategori filtresi, ürün kartları, e-katalog indirme.
- **Ürün detayı:** öne çıkan özellikler, makine özellikleri, teknik özellik kartları, avantajlar, kullanım alanları, WhatsApp ile teklif, aynı gruptaki diğer makineler.
- **Kurumsal:** vizyon, misyon, ilkeler, galeri. **İletişim:** form (veritabanına kaydeder, isteğe bağlı e-posta bildirimi), harita, sosyal medya.
- **Yönetim paneli** (`/admin`): ürün ekle/düzenle/sil (görsel yükleme, otomatik küçültme), kategoriler, gelen mesajlar, site ayarları (iletişim, metinler, sosyal medya), şifre değiştirme.
- SEO: temiz adresler (`/urun/rm-500-...`), meta açıklamaları, Open Graph, `sitemap.xml`, `robots.txt`, Organization JSON-LD.
- **Hareket paketi:** Lenis yumuşak kaydırma, GSAP ScrollTrigger (sabitlenen yatay makine parkuru, kelime kelime başlık animasyonları, üst üste yığılan kartlar, paralaks, kaydırma hızına tepki veren yazı bandı), fareyle 3D eğilen kartlar, manyetik butonlar, ön yükleyici, kaydırma ilerleme çubuğu (CSS scroll-driven animation), sayfalar arası geçiş (View Transitions API). `prefers-reduced-motion` açıksa tüm hareketler kapanır; dokunmatik cihazlarda eğim/mıknatıs efektleri çalışmaz.
- Fontlar ve ikonlar (Barlow Condensed, Manrope, Phosphor), GSAP ve Lenis yerel olarak sunulur; harici CDN bağımlılığı yoktur.

## Kurulum (Hostinger / cPanel benzeri paylaşımlı hosting)

1. `tekstilmak` klasörünün **içeriğini** `public_html` klasörüne yükleyin (`index.php` doğrudan `public_html` içinde olmalı).
2. `config.php` içindeki veritabanı bilgilerini kontrol edin (varsayılan değerler Hostinger'daki `u767443840_makinaci1` veritabanına göre ayarlıdır).
3. Tarayıcıdan `https://alanadiniz.com/install.php` adresini açın. Tablolar oluşturulur, katalog ürünleri ve ayarlar yüklenir, yönetici hesabı açılır.
4. `https://alanadiniz.com/admin/` adresinden giriş yapın (kullanıcı adı `admin`). Giriş yaptıktan sonra **Site Ayarları > Şifre değiştir** bölümünden şifrenizi değiştirin.
5. Güvenlik için `install.php` dosyasını sunucudan silin.
6. SSL kurulduktan sonra `.htaccess` içindeki HTTPS yönlendirme satırlarının başındaki `#` işaretlerini kaldırın.

Alternatif olarak `database.sql` dosyasını phpMyAdmin'den içe aktarabilirsiniz (install.php ile aynı veriyi içerir).

### Gereksinimler

- PHP 8.0+ (`pdo_mysql`, `mbstring`, `gd`, `fileinfo` eklentileri)
- MySQL 5.7+ / MariaDB 10.3+
- Apache veya LiteSpeed (`mod_rewrite` açık, `.htaccess` destekli)
- `uploads/` klasörü yazılabilir olmalı (755)

## Yerel geliştirme

```bash
php -S 127.0.0.1:8080 -t . router.php
```

`router.php` yalnızca PHP'nin dahili sunucusu için `.htaccess` yönlendirmelerini taklit eder.

## Klasör yapısı

```
index.php, urunler.php, urun.php, kurumsal.php, iletisim.php, sitemap.php
config.php            veritabanı ve uygulama ayarları
install.php           tek seferlik kurulum (install.lock oluşturur)
includes/             db.php, functions.php, partials.php, header/footer, seed-data.php (katalog verisi)
admin/                yönetim paneli
assets/               css, js (gsap + main.js), fonts, vendor/phosphor, img, katalog (PDF)
uploads/              panelden yüklenen görseller
```

## Yönetim panelinde içerik düzenleme

- Liste alanlarında (öne çıkanlar, özellikler, avantajlar, kullanım alanları) **her satır bir maddedir**.
- Teknik özellikler `Etiket: Değer` biçimindedir (örn. `Motor Gücü: 1,5 kW`).
- "Öne çıkan" işaretli ürünler anasayfadaki makine parkurunda gösterilir; ilk öne çıkan ürün hero alanında yer alır.
- Görseller JPG/PNG/WebP, en fazla 6 MB; geniş görseller otomatik olarak 1600 px'e küçültülür. Önerilen oran 4:3, açık gri zemin.
