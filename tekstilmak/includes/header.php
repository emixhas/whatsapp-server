<?php
require_once __DIR__ . '/partials.php';
$siteName   = setting('site_name', 'REMAK MAKİNA');
$siteSlogan = setting('site_slogan', 'Tekstil Makinaları Üreticisi');
$fullTitle  = (isset($pageTitle) && $pageTitle !== '') ? $pageTitle . ' | ' . $siteName : $siteName . ' | ' . $siteSlogan;
$metaDesc   = $metaDesc ?? setting('meta_description');
$bodyClass  = $bodyClass ?? '';
$ogImage    = $ogImage ?? asset('img/products/rm-500.jpg');
$wa         = setting('whatsapp', '905434598504');
$waText     = $waText ?? 'Merhaba, REMAK MAKİNA ürünleri hakkında bilgi almak istiyorum.';
$canonical  = site_origin() . strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
?>
<!doctype html>
<html lang="tr" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($fullTitle) ?></title>
<meta name="description" content="<?= e($metaDesc) ?>">
<link rel="canonical" href="<?= e($canonical) ?>">
<meta property="og:site_name" content="<?= e($siteName) ?>">
<meta property="og:title" content="<?= e($fullTitle) ?>">
<meta property="og:description" content="<?= e($metaDesc) ?>">
<meta property="og:image" content="<?= e((strpos($ogImage, 'http') === 0 ? '' : site_origin()) . $ogImage) ?>">
<meta property="og:type" content="website">
<meta property="og:locale" content="tr_TR">
<meta name="theme-color" content="#14171c">
<link rel="icon" type="image/png" href="<?= e(asset('img/logo-mark-amber.png')) ?>">
<link rel="apple-touch-icon" href="<?= e(asset('img/logo-mark-amber.png')) ?>">
<link rel="preload" href="<?= e(url('assets/fonts/barlow-condensed-700-latin.woff2')) ?>" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="<?= e(url('assets/fonts/manrope-400-latin.woff2')) ?>" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="<?= e(asset('fonts/fonts.css')) ?>">
<link rel="stylesheet" href="<?= e(asset('vendor/phosphor/phosphor.css')) ?>">
<link rel="stylesheet" href="<?= e(asset('css/style.css')) ?>">
<script>document.documentElement.classList.replace('no-js','js');</script>
<script type="application/ld+json">
<?= json_encode([
    '@context' => 'https://schema.org',
    '@type' => 'Organization',
    'name' => $siteName,
    'url' => site_origin() . url(''),
    'logo' => site_origin() . asset('img/logo-mark.png'),
    'telephone' => setting('phone'),
    'email' => setting('email'),
    'address' => ['@type' => 'PostalAddress', 'streetAddress' => setting('address'), 'addressLocality' => 'Hadımköy / İstanbul', 'addressCountry' => 'TR'],
    'sameAs' => array_values(array_filter([setting('instagram'), setting('youtube'), setting('telegram')])),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?>
</script>
</head>
<body class="<?= e($bodyClass) ?>">
<a class="skip-link" href="#icerik">İçeriğe geç</a>
<div class="scroll-sentinel" aria-hidden="true"></div>
<header class="site-header" id="site-header">
    <div class="container header__inner">
        <a class="brand" href="<?= e(url('')) ?>" aria-label="<?= e($siteName) ?> anasayfa">
            <img class="brand__mark" src="<?= e(asset('img/logo-mark-white.png')) ?>" alt="" width="44" height="44">
            <span class="brand__text"><span class="brand__name">REMAK</span><span class="brand__sub">MAKİNA</span></span>
        </a>
        <nav class="nav" id="nav" aria-label="Ana menü">
            <a href="<?= e(url('')) ?>" class="nav__link<?= is_active('index.php') ?>">Anasayfa</a>
            <a href="<?= e(url('kurumsal')) ?>" class="nav__link<?= is_active('kurumsal.php') ?>">Kurumsal</a>
            <a href="<?= e(url('urunler')) ?>" class="nav__link<?= is_active('urunler.php') ?: is_active('urun.php') ?>">Ürünler</a>
            <a href="<?= e(url('iletisim')) ?>" class="nav__link<?= is_active('iletisim.php') ?>">İletişim</a>
            <a href="<?= e(wa_link($wa, $waText)) ?>" class="btn btn--amber nav__cta" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> Teklif Al</a>
        </nav>
        <button class="nav-toggle" id="nav-toggle" type="button" aria-expanded="false" aria-controls="nav" aria-label="Menüyü aç/kapat"><span></span><span></span><span></span></button>
    </div>
</header>
<main id="icerik">
