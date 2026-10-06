<?php
require_once __DIR__ . '/includes/partials.php';
$pageTitle = 'Kurumsal';
$metaDesc  = 'REMAK MAKİNA hakkında: vizyonumuz, misyonumuz, değerlerimiz ve Hadımköy İstanbul\'daki üretim tesisimiz.';
$bodyClass = 'page-about';
$aboutParts = preg_split('~(\r\n|\r|\n){2,}~', trim(setting('about_short')));
require __DIR__ . '/includes/header.php';
?>

<section class="page-hero page-hero--image" style="--img:url('<?= e(asset('img/factory/hall.jpg')) ?>')">
    <div class="container">
        <nav class="crumbs crumbs--light" aria-label="Sayfa yolu"><a href="<?= e(url('')) ?>">Anasayfa</a><span>/</span><strong>Kurumsal</strong></nav>
        <h1 data-split>Tekstil makineleri üreticisi</h1>
        <p data-hero><?= e($aboutParts[0] ?? '') ?></p>
    </div>
</section>

<section class="vm">
    <div class="container">
        <div class="split split--wide">
            <div class="split__media" data-parallax data-reveal="clip">
                <a href="<?= e(asset('img/factory/factory-5.jpg')) ?>" data-lightbox="tesis" data-caption="Tela pres makinesi test aşamasında">
                    <img src="<?= e(asset('img/factory/factory-5.jpg')) ?>" alt="Tela pres makinesi test aşamasında" loading="lazy" width="478" height="328">
                </a>
            </div>
            <div class="split__copy prose" data-reveal>
                <h2 data-split>Vizyonumuz</h2>
                <?= nl2p(setting('vision')) ?>
            </div>
        </div>
        <div class="split split--wide split--reverse">
            <div class="split__media" data-parallax data-reveal="clip">
                <a href="<?= e(asset('img/factory/factory-4.jpg')) ?>" data-lightbox="tesis" data-caption="Şase imalat alanı">
                    <img src="<?= e(asset('img/factory/factory-4.jpg')) ?>" alt="Şase imalat alanı" loading="lazy" width="259" height="328">
                </a>
            </div>
            <div class="split__copy prose" data-reveal>
                <h2 data-split>Misyonumuz</h2>
                <?= nl2p(setting('mission')) ?>
            </div>
        </div>
    </div>
</section>

<section class="values">
    <div class="container">
        <div class="section-head">
            <h2 data-split>İlkelerimiz</h2>
            <p data-reveal>Her makinede ve her iş ilişkisinde aynı beş ilkeyle hareket ediyoruz.</p>
        </div>
        <ul class="values__list">
            <li data-reveal><i class="ph ph-seal-check" aria-hidden="true"></i><h3>Kalite</h3><p>Uluslararası standartlarda tasarım, malzeme ve işçilik.</p></li>
            <li data-reveal><i class="ph ph-shield-check" aria-hidden="true"></i><h3>Güven</h3><p>Söz verdiğimiz performansı ve teslim süresini karşılayan makineler.</p></li>
            <li data-reveal><i class="ph ph-headset" aria-hidden="true"></i><h3>Müşteri memnuniyeti</h3><p>Satış öncesi danışmanlık, kurulum, eğitim ve satış sonrası teknik destek.</p></li>
            <li data-reveal><i class="ph ph-arrows-clockwise" aria-hidden="true"></i><h3>Sürekli gelişim</h3><p>Ar-Ge, tasarım ve üretim gücümüzü her geçen gün ileri taşıyoruz.</p></li>
            <li data-reveal><i class="ph ph-factory" aria-hidden="true"></i><h3>Yerli üretim</h3><p>İstanbul'da tasarlanan ve üretilen, ihracat odaklı makineler.</p></li>
        </ul>
    </div>
</section>

<?php render_gallery(); ?>

<?php render_contact_band(); ?>

<?php require __DIR__ . '/includes/footer.php'; ?>
