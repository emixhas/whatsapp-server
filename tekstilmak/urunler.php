<?php
require_once __DIR__ . '/includes/partials.php';

$catSlug  = isset($_GET['kategori']) ? preg_replace('~[^a-z0-9-]~', '', (string) $_GET['kategori']) : null;
$category = null;
if ($catSlug) {
    $category = get_category($catSlug);
    if (!$category) {
        http_response_code(404);
        $catSlug = null;
    }
}
$categories = get_categories();
$products   = get_products($catSlug);
$total      = (int) db()->query('SELECT COUNT(*) FROM products WHERE is_active = 1')->fetchColumn();

$pageTitle = $category ? $category['name'] : 'Ürünler';
$metaDesc  = $category ? ($category['description'] ?: setting('meta_description')) : 'REMAK MAKİNA ürün kataloğu: kumaş açma, kesim, dilimleme, kalite kontrol, paketleme, tela pres ve laminasyon makineleri.';
$bodyClass = 'page-products';
require __DIR__ . '/includes/header.php';
?>

<section class="page-hero page-hero--center">
    <div class="container">
        <nav class="crumbs" aria-label="Sayfa yolu"><a href="<?= e(url('')) ?>">Anasayfa</a><span>/</span><?php if ($category): ?><a href="<?= e(url('urunler')) ?>">Ürünler</a><span>/</span><strong><?= e($category['name']) ?></strong><?php else: ?><strong>Ürünler</strong><?php endif; ?></nav>
        <h1 data-split><?= e($category ? $category['name'] : 'Ürünler') ?></h1>
        <p data-hero><?= e($category ? $category['description'] : 'Tekstil üretim hattının her adımı için tasarlanmış ' . $total . ' makine modeli. Teknik özellikler, kullanım alanları ve avantajlar için modeli seçin.') ?></p>
    </div>
</section>

<section class="catalog">
    <div class="container">
        <nav class="filter filter--center" aria-label="Kategori filtresi">
            <a class="filter__item<?= $category ? '' : ' is-active' ?>" href="<?= e(url('urunler')) ?>">Tümü <span><?= $total ?></span></a>
            <?php foreach ($categories as $c): ?>
                <a class="filter__item<?= ($category && $category['id'] == $c['id']) ? ' is-active' : '' ?>" href="<?= e(category_url($c['slug'])) ?>"><?= e($c['name']) ?> <span><?= (int) $c['product_count'] ?></span></a>
            <?php endforeach; ?>
        </nav>

        <?php if ($products): ?>
            <div class="pgrid">
                <?php foreach ($products as $p): ?>
                    <?= product_card($p) ?>
                <?php endforeach; ?>
            </div>
        <?php else: ?>
            <div class="empty">
                <i class="ph ph-package" aria-hidden="true"></i>
                <h2>Bu grupta henüz ürün yok</h2>
                <p>Diğer ürün gruplarına göz atabilir veya ihtiyacınızı bize iletebilirsiniz.</p>
                <a class="btn btn--ink" href="<?= e(url('urunler')) ?>">Tüm ürünler</a>
            </div>
        <?php endif; ?>

        <div class="catalog__download" data-reveal>
            <div>
                <h2 data-split>2026 E-Katalog</h2>
                <p>Tüm makine modellerimizin teknik özellikleri, ölçüleri ve kullanım alanları tek dosyada.</p>
            </div>
            <a class="btn btn--amber btn--lg" data-magnet href="<?= e(asset('katalog/remak-makina-2026-e-katalog.pdf')) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-file-pdf" aria-hidden="true"></i> Kataloğu İndir</a>
        </div>
    </div>
</section>

<?php render_contact_band(false); ?>

<?php require __DIR__ . '/includes/footer.php'; ?>
