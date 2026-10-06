<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$adminTitle = 'Kategoriler';
$pdo = db();
$editId = (int) ($_GET['id'] ?? 0);
$edit = null;
if ($editId) {
    $st = $pdo->prepare('SELECT * FROM categories WHERE id = ?');
    $st->execute([$editId]);
    $edit = $st->fetch();
}
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_check()) {
        flash('err', 'Oturum doğrulanamadı.');
        redirect(url('admin/kategoriler.php'));
    }
    $action = $_POST['action'] ?? 'save';
    if ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        $n = (int) $pdo->query("SELECT COUNT(*) FROM products WHERE category_id = $id")->fetchColumn();
        $pdo->prepare('DELETE FROM categories WHERE id = ?')->execute([$id]);
        flash('ok', 'Kategori silindi.' . ($n ? " $n ürün kategorisiz kaldı." : ''));
        redirect(url('admin/kategoriler.php'));
    }
    $id = (int) ($_POST['id'] ?? 0);
    $name = trim((string) ($_POST['name'] ?? ''));
    $slug = slugify(trim((string) ($_POST['slug'] ?? '')) ?: $name);
    $desc = trim((string) ($_POST['description'] ?? ''));
    $sort = (int) ($_POST['sort_order'] ?? 0);
    if ($name === '') {
        flash('err', 'Kategori adı zorunludur.');
        redirect(url('admin/kategoriler.php' . ($id ? '?id=' . $id : '')));
    }
    $st = $pdo->prepare('SELECT id FROM categories WHERE slug = ? AND id <> ?');
    $st->execute([$slug, $id]);
    if ($st->fetch()) {
        flash('err', 'Bu adres (slug) başka bir kategoride kullanılıyor.');
        redirect(url('admin/kategoriler.php' . ($id ? '?id=' . $id : '')));
    }
    if ($id) {
        $pdo->prepare('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?')->execute([$name, $slug, $desc ?: null, $sort, $id]);
        flash('ok', 'Kategori güncellendi.');
    } else {
        $pdo->prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')->execute([$name, $slug, $desc ?: null, $sort]);
        flash('ok', 'Kategori eklendi.');
    }
    redirect(url('admin/kategoriler.php'));
}
$cats = get_categories();
require __DIR__ . '/includes/header.php';
?>
<div class="grid-2 grid-2--side">
    <section class="card">
        <div class="card__head"><h2>Kategoriler</h2></div>
        <table class="table">
            <thead><tr><th>Ad</th><th>Adres</th><th>Ürün</th><th>Sıra</th><th></th></tr></thead>
            <tbody>
            <?php foreach ($cats as $c): ?>
                <tr>
                    <td><a href="<?= e(url('admin/kategoriler.php?id=' . $c['id'])) ?>"><?= e($c['name']) ?></a><?php if ($c['description']): ?><small><?= e($c['description']) ?></small><?php endif; ?></td>
                    <td class="nowrap"><small>/urunler/<?= e($c['slug']) ?></small></td>
                    <td><?= (int) $c['product_count'] ?></td>
                    <td><?= (int) $c['sort_order'] ?></td>
                    <td class="actions">
                        <a class="icon-btn" href="<?= e(url('admin/kategoriler.php?id=' . $c['id'])) ?>" title="Düzenle"><i class="ph ph-pencil-simple"></i></a>
                        <form method="post" data-confirm="<?= e($c['name']) ?> silinsin mi? Bu kategorideki ürünler kategorisiz kalır."><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $c['id'] ?>"><button class="icon-btn icon-btn--danger" type="submit" title="Sil"><i class="ph ph-trash"></i></button></form>
                    </td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </section>
    <section class="card">
        <div class="card__head"><h2><?= $edit ? 'Kategoriyi düzenle' : 'Yeni kategori' ?></h2><?php if ($edit): ?><a href="<?= e(url('admin/kategoriler.php')) ?>">Yeni ekle</a><?php endif; ?></div>
        <form method="post">
            <?= csrf_field() ?>
            <input type="hidden" name="id" value="<?= (int) ($edit['id'] ?? 0) ?>">
            <div class="field"><label for="c-name">Ad *</label><input id="c-name" name="name" required value="<?= e($edit['name'] ?? '') ?>" data-slug-source></div>
            <div class="field"><label for="c-slug">Adres (slug)</label><input id="c-slug" name="slug" value="<?= e($edit['slug'] ?? '') ?>" data-slug-target<?= $edit ? ' data-touched="1"' : '' ?>></div>
            <div class="field"><label for="c-desc">Açıklama</label><textarea id="c-desc" name="description" rows="3"><?= e($edit['description'] ?? '') ?></textarea></div>
            <div class="field"><label for="c-sort">Sıralama</label><input id="c-sort" name="sort_order" type="number" value="<?= (int) ($edit['sort_order'] ?? 0) ?>"></div>
            <button class="btn btn--amber btn--block" type="submit"><i class="ph ph-floppy-disk"></i> Kaydet</button>
        </form>
    </section>
</div>
<?php require __DIR__ . '/includes/footer.php'; ?>
