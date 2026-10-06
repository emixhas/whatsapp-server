<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$adminTitle = 'Özet';
$pdo = db();
$counts = [
    'products' => (int) $pdo->query('SELECT COUNT(*) FROM products')->fetchColumn(),
    'active'   => (int) $pdo->query('SELECT COUNT(*) FROM products WHERE is_active = 1')->fetchColumn(),
    'cats'     => (int) $pdo->query('SELECT COUNT(*) FROM categories')->fetchColumn(),
    'msgs'     => (int) $pdo->query('SELECT COUNT(*) FROM messages')->fetchColumn(),
    'unread'   => (int) $pdo->query('SELECT COUNT(*) FROM messages WHERE is_read = 0')->fetchColumn(),
];
$latest = $pdo->query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 6')->fetchAll();
$recentProducts = $pdo->query('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.updated_at DESC LIMIT 5')->fetchAll();
require __DIR__ . '/includes/header.php';
?>
<div class="tiles">
    <a class="tile" href="<?= e(url('admin/urunler.php')) ?>"><i class="ph ph-package"></i><strong><?= $counts['products'] ?></strong><span>Ürün (<?= $counts['active'] ?> yayında)</span></a>
    <a class="tile" href="<?= e(url('admin/kategoriler.php')) ?>"><i class="ph ph-tag"></i><strong><?= $counts['cats'] ?></strong><span>Kategori</span></a>
    <a class="tile<?= $counts['unread'] ? ' tile--hot' : '' ?>" href="<?= e(url('admin/mesajlar.php')) ?>"><i class="ph ph-chat-text"></i><strong><?= $counts['unread'] ?></strong><span>Okunmamış mesaj (toplam <?= $counts['msgs'] ?>)</span></a>
    <a class="tile" href="<?= e(url('admin/urun-form.php')) ?>"><i class="ph ph-plus"></i><strong>Yeni</strong><span>Ürün ekle</span></a>
</div>

<div class="grid-2">
    <section class="card">
        <div class="card__head"><h2>Son mesajlar</h2><a href="<?= e(url('admin/mesajlar.php')) ?>">Tümü</a></div>
        <?php if (!$latest): ?><p class="muted">Henüz mesaj yok.</p><?php else: ?>
        <table class="table">
            <thead><tr><th>Gönderen</th><th>Konu</th><th>Tarih</th></tr></thead>
            <tbody>
            <?php foreach ($latest as $m): ?>
                <tr class="<?= $m['is_read'] ? '' : 'is-unread' ?>">
                    <td><a href="<?= e(url('admin/mesajlar.php?id=' . $m['id'])) ?>"><?= e($m['name']) ?></a><?php if ($m['company']): ?><small><?= e($m['company']) ?></small><?php endif; ?></td>
                    <td><?= e($m['subject']) ?></td>
                    <td class="nowrap"><?= e(format_date($m['created_at'])) ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
        <?php endif; ?>
    </section>
    <section class="card">
        <div class="card__head"><h2>Son düzenlenen ürünler</h2><a href="<?= e(url('admin/urunler.php')) ?>">Tümü</a></div>
        <table class="table">
            <thead><tr><th>Model</th><th>Ürün</th><th>Durum</th></tr></thead>
            <tbody>
            <?php foreach ($recentProducts as $p): ?>
                <tr>
                    <td class="nowrap"><strong><?= e($p['model']) ?></strong></td>
                    <td><a href="<?= e(url('admin/urun-form.php?id=' . $p['id'])) ?>"><?= e($p['name']) ?></a><small><?= e($p['category_name'] ?? 'Kategorisiz') ?></small></td>
                    <td><?= $p['is_active'] ? '<span class="pill pill--ok">Yayında</span>' : '<span class="pill">Taslak</span>' ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </section>
</div>

<section class="card">
    <div class="card__head"><h2>Hızlı yardım</h2></div>
    <ul class="help">
        <li><strong>Ürün eklemek:</strong> Ürünler &gt; Yeni Ürün. Model, ad ve kategori zorunludur; özellik listelerinde her satır bir madde, teknik özelliklerde <code>Etiket: Değer</code> biçimi kullanılır.</li>
        <li><strong>Görsel:</strong> JPG, PNG veya WebP; en fazla <?= round(UPLOAD_MAX_BYTES / 1048576) ?> MB. Geniş görseller otomatik olarak 1600 px'e küçültülür. En iyi sonuç için makineyi açık gri zemin üzerinde, 4:3 oranında çekin.</li>
        <li><strong>Anasayfa sırası:</strong> "Öne çıkan" işaretli ürünler anasayfadaki makine parkurunda gösterilir; ilk öne çıkan ürün hero alanında yer alır. Sıralama alanı küçükten büyüğe dizilir.</li>
        <li><strong>İletişim bilgileri ve metinler:</strong> Site Ayarları sayfasından telefon, WhatsApp, adres, sosyal medya, vizyon ve misyon metinlerini güncelleyebilirsiniz.</li>
    </ul>
</section>
<?php require __DIR__ . '/includes/footer.php'; ?>
