<?php
require_once __DIR__ . '/includes/functions.php';
header('Content-Type: application/xml; charset=utf-8');
$origin = site_origin();
$urls = [
    [url(''), '1.0'], [url('urunler'), '0.9'], [url('kurumsal'), '0.7'], [url('iletisim'), '0.7'],
];
foreach (get_categories(false) as $c) {
    $urls[] = [category_url($c['slug']), '0.8'];
}
foreach (get_products() as $p) {
    $urls[] = [product_url($p['slug']), '0.8', $p['updated_at']];
}
echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
foreach ($urls as $u) {
    echo '  <url><loc>' . e($origin . $u[0]) . '</loc>';
    if (!empty($u[2])) {
        echo '<lastmod>' . date('Y-m-d', strtotime($u[2])) . '</lastmod>';
    }
    echo '<priority>' . $u[1] . '</priority></url>' . "\n";
}
echo '</urlset>';
