<?php
require_once __DIR__ . '/includes/partials.php';

$slug = isset($_GET['slug']) ? preg_replace('~[^a-z0-9-]~', '', (string) $_GET['slug']) : '';
$p    = $slug !== '' ? get_product($slug) : null;

if (!$p) {
    http_response_code(404);
    $pageTitle = 'Ürün bulunamadı';
    $bodyClass = 'page-404';
    require __DIR__ . '/includes/header.php';
    ?>
    <section class="page-hero">
        <div class="container">
            <h1>Ürün bulunamadı</h1>
            <p>Aradığınız makine kaldırılmış veya adresi değişmiş olabilir.</p>
            <a class="btn btn--ink" href="<?= e(url('urunler')) ?>">Tüm ürünlere dön</a>
        </div>
    </section>
    <?php
    require __DIR__ . '/includes/footer.php';
    exit;
}

$highlights   = json_list($p['highlights']);
$features     = json_list($p['features']);
$advantages   = json_list($p['advantages']);
$applications = json_list($p['applications']);
$specs        = json_decode((string) $p['specs'], true);
$specs        = is_array($specs) ? $specs : [];
$wa           = setting('whatsapp', '905434598504');
$waText       = 'Merhaba, ' . $p['model'] . ' ' . $p['name'] . ' hakkında teklif almak istiyorum.';

$related = [];
if ($p['category_slug']) {
    foreach (get_products($p['category_slug']) as $r) {
        if ($r['id'] != $p['id']) {
            $related[] = $r;
        }
    }
    $related = array_slice($related, 0, 3);
}

$pageTitle = $p['model'] . ' ' . $p['name'];
$metaDesc  = $p['summary'] ?: mb_substr(strip_tags((string) $p['description']), 0, 160);
$ogImage   = product_image($p);
$bodyClass = 'page-product';
require __DIR__ . '/includes/header.php';
?>

<section class="product-hero">
    <div class="container product-hero__grid">
        <div class="product-hero__copy">
            <nav class="crumbs" aria-label="Sayfa yolu">
                <a href="<?= e(url('urunler')) ?>">Ürünler</a><span>/</span>
                <?php if ($p['category_name']): ?><a href="<?= e(category_url($p['category_slug'])) ?>"><?= e($p['category_name']) ?></a><span>/</span><?php endif; ?>
                <strong><?= e($p['model']) ?></strong>
            </nav>
            <h1><span class="product-hero__model" data-split><?= e($p['model']) ?></span><span class="product-hero__name" data-split><?= e($p['name']) ?></span></h1>
            <?php if ($p['tagline']): ?><p class="product-hero__tagline" data-hero><?= e($p['tagline']) ?></p><?php endif; ?>
            <?php if ($p['summary']): ?><p class="lead" data-hero><?= e($p['summary']) ?></p><?php endif; ?>
            <div class="product-hero__actions" data-hero>
                <a class="btn btn--amber btn--lg" data-magnet href="<?= e(wa_link($wa, $waText)) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> Teklif Al</a>
                <a class="btn btn--outline-ink btn--lg" data-magnet href="#teknik"><i class="ph-bold ph-list-checks" aria-hidden="true"></i> Teknik Özellikler</a>
            </div>
        </div>
        <div class="product-hero__media" data-tilt="4">
            <img src="<?= e(product_image($p)) ?>" alt="<?= e($p['model'] . ' ' . $p['name']) ?>" width="1200" height="900" fetchpriority="high">
        </div>
    </div>
</section>

<?php if ($highlights): ?>
<section class="highlights">
    <div class="container">
        <ul class="hl-row">
            <?php foreach ($highlights as $h): ?>
                <li data-reveal><i class="ph ph-<?= e(highlight_icon($h)) ?>" aria-hidden="true"></i><span><?= e($h) ?></span></li>
            <?php endforeach; ?>
        </ul>
    </div>
</section>
<?php endif; ?>

<section class="product-body">
    <div class="container product-body__grid">
        <div class="product-body__main">
            <?php if ($p['description']): ?>
                <div class="prose" data-reveal>
                    <h2 data-split>Ürün tanıtımı</h2>
                    <?= nl2p($p['description']) ?>
                </div>
            <?php endif; ?>

            <?php if ($features): ?>
                <div data-reveal>
                    <h2 data-split>Makine özellikleri</h2>
                    <ul class="checklist">
                        <?php foreach ($features as $f): ?>
                            <li><i class="ph-bold ph-check" aria-hidden="true"></i><span><?= e($f) ?></span></li>
                        <?php endforeach; ?>
                    </ul>
                </div>
            <?php endif; ?>

            <?php if ($specs): ?>
                <div id="teknik" data-reveal>
                    <h2 data-split>Teknik özellikler</h2>
                    <dl class="specs">
                        <?php foreach ($specs as $s): ?>
                            <div class="spec" data-reveal><dt><?= e($s['label'] ?? '') ?></dt><dd><?= e($s['value'] ?? '') ?></dd></div>
                        <?php endforeach; ?>
                    </dl>
                    <p class="note">Teknik bilgiler ve ölçüler model ve opsiyonlara göre değişiklik gösterebilir. REMAK MAKİNA önceden haber vermeksizin teknik özelliklerde değişiklik yapma hakkını saklı tutar.</p>
                </div>
            <?php endif; ?>
        </div>

        <aside class="product-body__side">
            <?php if ($advantages): ?>
                <div class="side-card" data-reveal>
                    <h3><i class="ph ph-medal" aria-hidden="true"></i> Avantajlar</h3>
                    <ul class="chips"><?php foreach ($advantages as $a): ?><li><?= e($a) ?></li><?php endforeach; ?></ul>
                </div>
            <?php endif; ?>
            <?php if ($applications): ?>
                <div class="side-card" data-reveal>
                    <h3><i class="ph ph-squares-four" aria-hidden="true"></i> Kullanım alanları</h3>
                    <ul class="chips chips--muted"><?php foreach ($applications as $a): ?><li><?= e($a) ?></li><?php endforeach; ?></ul>
                </div>
            <?php endif; ?>
            <div class="side-card side-card--amber" data-reveal>
                <h3>Bu makine için teklif alın</h3>
                <p>Kapasite, opsiyonlar ve teslim süresi için bize yazın; size özel teklif hazırlayalım.</p>
                <a class="btn btn--ink" href="<?= e(wa_link($wa, $waText)) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> Teklif Al</a>
                <a class="side-card__link" href="<?= e(tel_link(setting('phone'))) ?>"><i class="ph ph-phone" aria-hidden="true"></i> <?= e(setting('phone')) ?></a>
                <a class="side-card__link" href="<?= e(asset('katalog/remak-makina-2026-e-katalog.pdf')) ?>" target="_blank" rel="noopener"><i class="ph ph-file-pdf" aria-hidden="true"></i> 2026 E-Katalog (PDF)</a>
            </div>
        </aside>
    </div>
</section>

<?php if ($related): ?>
<section class="related">
    <div class="container">
        <div class="section-head section-head--row">
            <h2 data-split>Aynı gruptaki diğer makineler</h2>
            <a class="link-arrow" href="<?= e(category_url($p['category_slug'])) ?>"><?= e($p['category_name']) ?> <i class="ph-bold ph-arrow-right" aria-hidden="true"></i></a>
        </div>
        <div class="pgrid pgrid--3">
            <?php foreach ($related as $r): ?><?= product_card($r) ?><?php endforeach; ?>
        </div>
    </div>
</section>
<?php endif; ?>

<?php require __DIR__ . '/includes/footer.php'; ?>
