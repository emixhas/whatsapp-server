<?php
/**
 * Tekrar kullanılan parçalar: ürün kartı, galeri, iletişim bandı.
 */
require_once __DIR__ . '/functions.php';

function product_card(array $p, bool $reveal = true): string
{
    $img = product_image($p);
    $rev = $reveal ? ' data-reveal' : '';
    return '<a class="pcard" href="' . e(product_url($p['slug'])) . '"' . $rev . ' data-tilt="5">'
        . '<div class="pcard__media"><img src="' . e($img) . '" alt="' . e($p['model'] . ' ' . $p['name']) . '" loading="lazy" width="1200" height="900"></div>'
        . '<div class="pcard__body">'
        . '<span class="pcard__model">' . e($p['model']) . '</span>'
        . '<h3 class="pcard__name">' . e($p['name']) . '</h3>'
        . ($p['summary'] ? '<p class="pcard__text">' . e($p['summary']) . '</p>' : '')
        . '<span class="pcard__more">İncele <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></span>'
        . '</div></a>';
}

function render_gallery(string $title = 'Üretim tesisimiz', string $text = 'Hadımköy, İstanbul\'daki tesisimizde tasarımdan kaynağa, montajdan son kontrole kadar her aşama kendi ekibimiz tarafından yürütülür.'): void
{
    $photos = [
        ['factory-1.jpg', 'RM-500 TIGER montaj hattında', 519, 402],
        ['factory-2.jpg', 'Rulo açma makinesi son kontrolde', 478, 402],
        ['factory-3.jpg', 'Çelik konstrüksiyon kaynak işlemi', 252, 328],
        ['factory-4.jpg', 'Şase imalat alanı', 259, 328],
        ['factory-5.jpg', 'Tela pres makinesi test aşamasında', 478, 328],
    ];
    ?>
    <section class="gallery">
        <div class="container">
            <div class="section-head">
                <h2 data-split><?= e($title) ?></h2>
                <p data-reveal><?= e($text) ?></p>
            </div>
            <div class="gallery__grid">
                <?php foreach ($photos as $i => $ph): ?>
                    <figure class="gallery__item gallery__item--<?= $i + 1 ?>" data-reveal="clip" data-speed="<?= [1.0, 0.92, 1.08, 0.96, 1.05][$i] ?>">
                        <a href="<?= e(asset('img/factory/' . $ph[0])) ?>" data-lightbox="tesis" data-caption="<?= e($ph[1]) ?>">
                            <img src="<?= e(asset('img/factory/' . $ph[0])) ?>" alt="<?= e($ph[1]) ?>" loading="lazy" width="<?= $ph[2] ?>" height="<?= $ph[3] ?>">
                        </a>
                    </figure>
                <?php endforeach; ?>
            </div>
        </div>
    </section>
    <?php
}

function render_contact_band(bool $withEyebrow = true): void
{
    $wa = setting('whatsapp', '905434598504');
    $phone = setting('phone');
    ?>
    <section class="contact-band">
        <div class="container contact-band__grid">
            <div class="contact-band__cta" data-reveal>
                <?php if ($withEyebrow): ?><span class="eyebrow">İletişim</span><?php endif; ?>
                <h2 data-split>Projeniz için teklif alın</h2>
                <p>Makine seçimi, teknik detaylar ve fiyat bilgisi için WhatsApp üzerinden bize yazın; aynı gün dönüş yapalım.</p>
                <div class="contact-band__actions">
                    <a class="btn btn--ink btn--lg" data-magnet href="<?= e(wa_link($wa, 'Merhaba, REMAK MAKİNA ürünleri için teklif almak istiyorum.')) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> Teklif Al</a>
                    <a class="btn btn--outline-ink btn--lg" href="<?= e(tel_link($phone)) ?>"><i class="ph-bold ph-phone" aria-hidden="true"></i> <?= e($phone) ?></a>
                </div>
            </div>
            <ul class="contact-list" data-reveal>
                <li><i class="ph ph-map-pin" aria-hidden="true"></i><div><strong>Adres</strong><span><?= e(setting('address')) ?></span></div></li>
                <li><i class="ph ph-phone" aria-hidden="true"></i><div><strong>Telefon / WhatsApp</strong><a href="<?= e(tel_link($phone)) ?>"><?= e($phone) ?></a></div></li>
                <li><i class="ph ph-envelope" aria-hidden="true"></i><div><strong>E-posta</strong><a href="mailto:<?= e(setting('email')) ?>"><?= e(setting('email')) ?></a></div></li>
                <li><i class="ph ph-clock" aria-hidden="true"></i><div><strong>Çalışma saatleri</strong><span><?= e(setting('working_hours')) ?></span></div></li>
            </ul>
        </div>
    </section>
    <?php
}
