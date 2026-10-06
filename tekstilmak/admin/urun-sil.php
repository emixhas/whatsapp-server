<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !csrf_check()) {
    flash('err', 'Geçersiz istek.');
    redirect(url('admin/urunler.php'));
}
$id = (int) ($_POST['id'] ?? 0);
$st = db()->prepare('SELECT * FROM products WHERE id = ?');
$st->execute([$id]);
$p = $st->fetch();
if ($p) {
    db()->prepare('DELETE FROM products WHERE id = ?')->execute([$id]);
    delete_upload($p['image']);
    flash('ok', $p['model'] . ' ' . $p['name'] . ' silindi.');
} else {
    flash('err', 'Ürün bulunamadı.');
}
redirect(url('admin/urunler.php'));
