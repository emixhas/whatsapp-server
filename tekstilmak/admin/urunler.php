<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$adminTitle = 'Ürünler';
$topbarAction = '<a class="btn btn--amber" href="' . e(url('admin/urun-form.php')) . '"><i class="ph ph-plus"></i> Yeni Ürün</a>';
$cat = isset($_GET['kategori']) ? (int) $_GET['kategori'] : 0;
$q   = trim((string) ($_GET['q'] ?? ''));
$sql = 'SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE 1=1';
$params = [];
if ($cat) { $sql .= ' AND p.category_id = ?'; $params[] = $cat; }
if ($q !== '') { $sql .= ' AND (p.model LIKE ? OR p.name LIKE ?)'; $params[] = "%$q%"; $params[] = "%$q%"; }
$sql .= ' ORDER BY p.sort_order, p.id';
$st = db()->prepare($sql);
$st->execute($params);
$products = $st->fetchAll();
$cats = get_categories();
require __DIR__ . '/includes/header.php';
?>
<form class="toolbar" method="get">
    <input type="search" name="q" value="<?= e($q) ?>" placeholder="Model veya ad ara">
    <select name="kategori">
        <option value="0">Tüm kategoriler</option>
        <?php foreach ($cats as $c): ?><option value="<?= $c['id'] ?>"<?= $cat == $c['id'] ? ' selected' : '' ?>><?= e($c['name']) ?> (<?= (int) $c['product_count'] ?>)</option><?php endforeach; ?>
    </select>
    <button class="btn btn--ink" type="submit"><i class="ph ph-magnifying-glass"></i> Filtrele</button>
</form>

<section class="card">
    <?php if (!$products): ?>
        <div class="empty"><i class="ph ph-package"></i><p>Ürün bulunamadı.</p><a class="btn btn--amber" href="<?= e(url('admin/urun-form.php')) ?>">Yeni ürün ekle</a></div>
    <?php else: ?>
    <table class="table table--products">
        <thead><tr><th></th><th>Model</th><th>Ürün</th><th>Kategori</th><th>Sıra</th><th>Durum</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($products as $p): ?>
            <tr>
                <td class="thumb"><img src="<?= e(product_image($p)) ?>" alt="" loading="lazy"></td>
                <td class="nowrap"><strong><?= e($p['model']) ?></strong></td>
                <td><a href="<?= e(url('admin/urun-form.php?id=' . $p['id'])) ?>"><?= e($p['name']) ?></a><small><a href="<?= e(product_url($p['slug'])) ?>" target="_blank" rel="noopener">/urun/<?= e($p['slug']) ?></a></small></td>
                <td><?= e($p['category_name'] ?? 'Kategorisiz') ?></td>
                <td><?= (int) $p['sort_order'] ?></td>
                <td class="nowrap">
                    <?= $p['is_active'] ? '<span class="pill pill--ok">Yayında</span>' : '<span class="pill">Taslak</span>' ?>
                    <?= $p['is_featured'] ? '<span class="pill pill--amber">Öne çıkan</span>' : '' ?>
                </td>
                <td class="actions">
                    <a class="icon-btn" href="<?= e(url('admin/urun-form.php?id=' . $p['id'])) ?>" title="Düzenle"><i class="ph ph-pencil-simple"></i></a>
                    <form method="post" action="<?= e(url('admin/urun-sil.php')) ?>" data-confirm="<?= e($p['model'] . ' ' . $p['name']) ?> silinsin mi? Bu işlem geri alınamaz.">
                        <?= csrf_field() ?><input type="hidden" name="id" value="<?= (int) $p['id'] ?>">
                        <button class="icon-btn icon-btn--danger" type="submit" title="Sil"><i class="ph ph-trash"></i></button>
                    </form>
                </td>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
    <?php endif; ?>
</section>
<?php require __DIR__ . '/includes/footer.php'; ?>
