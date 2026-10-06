<?php
require_once __DIR__ . '/includes/partials.php';

$pageTitle = '';
$bodyClass = 'page-home';
$featured  = get_products(null, true);
if (count($featured) < 4) {
    $featured = get_products(null, false, 8);
}
$heroProduct   = $featured[0] ?? null;
$categories    = get_categories();
$productCount  = (int) db()->query('SELECT COUNT(*) FROM products WHERE is_active = 1')->fetchColumn();
$categoryCount = count($categories);
$wa            = setting('whatsapp', '905434598504');

require __DIR__ . '/includes/header.php';
?>

<section class="hero" id="hero">
    <div class="hero__bg" style="background-image:url('<?= e(asset('img/factory/factory-1.jpg')) ?>')"></div>
    <div class="hero__overlay"></div>
    <div class="container hero__grid">
        <div class="hero__copy">
            <h1 class="hero__title" data-split><?= e(setting('hero_title', 'Tekstil endüstrisi için yenilikçi makineler')) ?></h1>
            <p class="hero__text"><?= e(setting('hero_text')) ?></p>
            <div class="hero__actions">
                <a class="btn btn--amber btn--lg" data-magnet href="<?= e(url('urunler')) ?>">Ürünleri İncele <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></a>
                <a class="btn btn--ghost btn--lg" data-magnet href="<?= e(wa_link($wa, 'Merhaba, REMAK MAKİNA ürünleri için teklif almak istiyorum.')) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> Teklif Al</a>
            </div>
        </div>
        <?php if ($heroProduct): ?>
        <div class="hero__visual">
            <div class="hero__panel" data-tilt="4">
                <img src="<?= e(product_image($heroProduct)) ?>" alt="<?= e($heroProduct['model'] . ' ' . $heroProduct['name']) ?>" width="1200" height="900" fetchpriority="high">
            </div>
            <a class="hero__caption" href="<?= e(product_url($heroProduct['slug'])) ?>">
                <span class="hero__caption-model"><?= e($heroProduct['model']) ?></span>
                <span><?= e($heroProduct['name']) ?></span>
                <i class="ph-bold ph-arrow-up-right" aria-hidden="true"></i>
            </a>
        </div>
        <?php endif; ?>
    </div>
    <div class="container hero__pillars">
        <div class="pillar"><i class="ph ph-gauge" aria-hidden="true"></i><div><strong>Yüksek Verimlilik</strong><span>Üretim hattınızı hızlandıran makineler</span></div></div>
        <div class="pillar"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Üstün Kalite</strong><span>Uluslararası standartlarda üretim</span></div></div>
        <div class="pillar"><i class="ph ph-lightbulb" aria-hidden="true"></i><div><strong>Yenilikçi Teknolojiler</strong><span>PLC, dokunmatik panel, sensör kontrolü</span></div></div>
        <div class="pillar"><i class="ph ph-globe-hemisphere-west" aria-hidden="true"></i><div><strong>Global Çözümler</strong><span>İhracat odaklı, dünya standartlarında</span></div></div>
    </div>
</section>

<div class="marquee" aria-hidden="true">
    <div class="marquee__track">
        <?php for ($i = 0; $i < 2; $i++): ?>
            <span>Kumaş Açma</span><span>Kesim</span><span>Dilimleme</span><span>Kalite Kontrol</span><span>Kenar Kontrol</span><span>Paketleme</span><span>Tela Pres</span><span>Laminasyon</span>
        <?php endfor; ?>
    </div>
</div>

<section class="showcase" id="makineler" data-hpan>
    <div class="container showcase__head">
        <div>
            <span class="eyebrow">Makine Parkuru</span>
            <h2 data-split>Üretim hattınızın her adımı için bir REMAK</h2>
        </div>
        <a class="link-arrow" href="<?= e(url('urunler')) ?>">Tüm ürünler <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></a>
    </div>
    <div class="showcase__track" data-hpan-track>
        <?php foreach ($featured as $p): ?>
            <?= product_card($p, false) ?>
        <?php endforeach; ?>
        <a class="pcard pcard--all" href="<?= e(url('urunler')) ?>">
            <span class="pcard--all__count"><?= $productCount ?></span>
            <span class="pcard--all__label">makine modelinin tamamını inceleyin</span>
            <span class="pcard__more">Ürün kataloğu <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></span>
        </a>
    </div>
    <div class="showcase__progress" aria-hidden="true"><span></span></div>
</section>

<section class="cats">
    <div class="container">
        <div class="section-head">
            <h2 data-split>Ürün grupları</h2>
            <p data-reveal>Kumaşın açılmasından kalite kontrolüne, kesimden paketlemeye ve laminasyona kadar üretim hattının her noktası için makine üretiyoruz.</p>
        </div>
        <div class="bento">
            <?php foreach ($categories as $i => $c): ?>
                <a class="bento__cell bento__cell--<?= $i + 1 ?>" href="<?= e(category_url($c['slug'])) ?>" style="--img:url('<?= e(category_image($c)) ?>')" data-reveal data-tilt="3">
                    <div class="bento__content">
                        <span class="bento__count"><?= (int) $c['product_count'] ?> makine</span>
                        <h3><?= e($c['name']) ?></h3>
                        <p><?= e($c['description']) ?></p>
                        <span class="link-arrow link-arrow--light">İncele <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></span>
                    </div>
                </a>
            <?php endforeach; ?>
        </div>
    </div>
</section>

<section class="about-teaser">
    <div class="container split">
        <div class="split__media" data-parallax data-reveal="clip">
            <img src="<?= e(asset('img/factory/factory-2.jpg')) ?>" alt="REMAK MAKİNA üretim tesisi" loading="lazy" width="478" height="402">
        </div>
        <div class="split__copy" data-reveal>
            <span class="eyebrow">Kurumsal</span>
            <h2 data-split>Tasarlandı ve Türkiye'de üretildi</h2>
            <?= nl2p(setting('about_short')) ?>
            <ul class="stats">
                <li><strong data-count="<?= $productCount ?>"><?= $productCount ?></strong><span>makine modeli</span></li>
                <li><strong data-count="<?= $categoryCount ?>"><?= $categoryCount ?></strong><span>ürün grubu</span></li>
                <li><strong>%100</strong><span>yerli üretim</span></li>
            </ul>
            <a class="btn btn--ink" data-magnet href="<?= e(url('kurumsal')) ?>">Bizi Tanıyın <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></a>
        </div>
    </div>
</section>

<section class="why">
    <div class="container why__grid">
        <div class="why__sticky">
            <h2 data-split>Neden REMAK MAKİNA?</h2>
            <p data-reveal>Makinelerimizi tasarlıyor, üretiyor ve kurulumdan sonra da yanınızda oluyoruz. Her makinede dayanıklılığı, teknolojiyi ve kullanım kolaylığını bir araya getiriyoruz.</p>
        </div>
        <ul class="why__list" data-stack>
            <li><i class="ph ph-seal-check" aria-hidden="true"></i><div><h3>Yüksek kalite</h3><p>Üretimin her aşamasında uluslararası kalite standartlarını esas alıyoruz.</p></div></li>
            <li><i class="ph ph-shield-check" aria-hidden="true"></i><div><h3>Güvenilir üretim</h3><p>Sağlam çelik konstrüksiyon, güvenlik sensörleri ve uzun ömürlü mekanik sistemler.</p></div></li>
            <li><i class="ph ph-users" aria-hidden="true"></i><div><h3>Uzman kadro</h3><p>Mühendislik tecrübemizle tasarımdan montaja kadar her adım kendi ekibimizde.</p></div></li>
            <li><i class="ph ph-cpu" aria-hidden="true"></i><div><h3>Teknolojik çözümler</h3><p>PLC kontrol, dokunmatik operatör panelleri ve hassas sensör teknolojileri.</p></div></li>
            <li><i class="ph ph-headset" aria-hidden="true"></i><div><h3>Satış sonrası destek</h3><p>Kurulum, operatör eğitimi ve teknik servis ile uzun soluklu iş ortaklığı.</p></div></li>
        </ul>
    </div>
</section>

<?php render_gallery(); ?>

<?php render_contact_band(); ?>

<?php require __DIR__ . '/includes/footer.php'; ?>
