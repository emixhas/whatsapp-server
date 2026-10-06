<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$pdo = db();
$id = (int) ($_GET['id'] ?? $_POST['id'] ?? 0);
$product = null;
if ($id) {
    $st = $pdo->prepare('SELECT * FROM products WHERE id = ?');
    $st->execute([$id]);
    $product = $st->fetch();
    if (!$product) {
        flash('err', 'Ürün bulunamadı.');
        redirect(url('admin/urunler.php'));
    }
}
$adminTitle = $product ? 'Ürünü Düzenle: ' . $product['model'] : 'Yeni Ürün';
$cats = get_categories(false);
$errors = [];

$specsJson = $product ? json_decode((string) $product['specs'], true) : [];
$form = [
    'model'        => $product['model'] ?? '',
    'name'         => $product['name'] ?? '',
    'slug'         => $product['slug'] ?? '',
    'category_id'  => $product['category_id'] ?? ($cats[0]['id'] ?? 0),
    'tagline'      => $product['tagline'] ?? '',
    'summary'      => $product['summary'] ?? '',
    'description'  => $product['description'] ?? '',
    'highlights'   => implode("\n", json_list($product['highlights'] ?? '')),
    'features'     => implode("\n", json_list($product['features'] ?? '')),
    'specs'        => spec_lines_to_text(is_array($specsJson) ? $specsJson : []),
    'advantages'   => implode("\n", json_list($product['advantages'] ?? '')),
    'applications' => implode("\n", json_list($product['applications'] ?? '')),
    'is_featured'  => (int) ($product['is_featured'] ?? 0),
    'is_active'    => (int) ($product['is_active'] ?? 1),
    'sort_order'   => (int) ($product['sort_order'] ?? 0),
];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_check()) {
        $errors[] = 'Oturum doğrulanamadı, lütfen tekrar deneyin.';
    }
    foreach (['model', 'name', 'slug', 'tagline', 'summary', 'description', 'highlights', 'features', 'specs', 'advantages', 'applications'] as $k) {
        $form[$k] = trim((string) ($_POST[$k] ?? ''));
    }
    $form['category_id'] = (int) ($_POST['category_id'] ?? 0);
    $form['is_featured'] = isset($_POST['is_featured']) ? 1 : 0;
    $form['is_active']   = isset($_POST['is_active']) ? 1 : 0;
    $form['sort_order']  = (int) ($_POST['sort_order'] ?? 0);

    if ($form['model'] === '') $errors[] = 'Model kodu zorunludur (örn. RM-500).';
    if ($form['name'] === '') $errors[] = 'Ürün adı zorunludur.';
    if ($form['slug'] === '') $form['slug'] = slugify($form['model'] . ' ' . $form['name']);
    $form['slug'] = slugify($form['slug']);
    $st = $pdo->prepare('SELECT id FROM products WHERE slug = ? AND id <> ?');
    $st->execute([$form['slug'], $id]);
    if ($st->fetch()) $errors[] = 'Bu adres (slug) başka bir üründe kullanılıyor.';
    $catOk = false;
    foreach ($cats as $c) { if ((int) $c['id'] === $form['category_id']) $catOk = true; }
    if (!$catOk) $form['category_id'] = null;

    $newImage = null;
    try {
        $newImage = handle_image_upload('image');
    } catch (RuntimeException $ex) {
        $errors[] = $ex->getMessage();
    }

    if (!$errors) {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
        $data = [
            'category_id'  => $form['category_id'],
            'model'        => $form['model'],
            'name'         => $form['name'],
            'slug'         => $form['slug'],
            'tagline'      => $form['tagline'] ?: null,
            'summary'      => mb_substr($form['summary'], 0, 600) ?: null,
            'description'  => $form['description'] ?: null,
            'highlights'   => json_encode(json_list($form['highlights']), $flags),
            'features'     => json_encode(json_list($form['features']), $flags),
            'specs'        => json_encode(parse_spec_lines($form['specs']), $flags),
            'advantages'   => json_encode(json_list($form['advantages']), $flags),
            'applications' => json_encode(json_list($form['applications']), $flags),
            'is_featured'  => $form['is_featured'],
            'is_active'    => $form['is_active'],
            'sort_order'   => $form['sort_order'],
        ];
        $image = $product['image'] ?? null;
        if ($newImage) {
            delete_upload($image);
            $image = $newImage;
        } elseif (!empty($_POST['remove_image'])) {
            delete_upload($image);
            $image = null;
        }
        $data['image'] = $image;

        if ($product) {
            $sets = implode(', ', array_map(fn($k) => "$k = :$k", array_keys($data)));
            $data['id'] = $id;
            $pdo->prepare("UPDATE products SET $sets WHERE id = :id")->execute($data);
            flash('ok', 'Ürün güncellendi.');
        } else {
            $cols = implode(', ', array_keys($data));
            $vals = ':' . implode(', :', array_keys($data));
            $pdo->prepare("INSERT INTO products ($cols) VALUES ($vals)")->execute($data);
            $id = (int) $pdo->lastInsertId();
            flash('ok', 'Ürün eklendi.');
        }
        redirect(url('admin/urun-form.php?id=' . $id));
    }
}
$topbarAction = '<a class="btn btn--ghost" href="' . e(url('admin/urunler.php')) . '"><i class="ph ph-arrow-left"></i> Listeye dön</a>';
require __DIR__ . '/includes/header.php';
?>
<?php if ($errors): ?><div class="alert alert--err"><i class="ph ph-warning"></i><div><?php foreach ($errors as $er): ?><div><?= e($er) ?></div><?php endforeach; ?></div></div><?php endif; ?>

<form method="post" enctype="multipart/form-data" class="form-layout">
    <?= csrf_field() ?>
    <input type="hidden" name="id" value="<?= (int) $id ?>">
    <div class="form-main">
        <section class="card">
            <div class="card__head"><h2>Temel bilgiler</h2></div>
            <div class="fgrid">
                <div class="field"><label for="model">Model kodu *</label><input id="model" name="model" value="<?= e($form['model']) ?>" required placeholder="RM-500" data-slug-model></div>
                <div class="field"><label for="category_id">Kategori</label><select id="category_id" name="category_id"><?php foreach ($cats as $c): ?><option value="<?= $c['id'] ?>"<?= $form['category_id'] == $c['id'] ? ' selected' : '' ?>><?= e($c['name']) ?></option><?php endforeach; ?></select></div>
                <div class="field field--full"><label for="name">Ürün adı *</label><input id="name" name="name" value="<?= e($form['name']) ?>" required placeholder="Otomatik Biye Kesim Makinası" data-slug-source></div>
                <div class="field field--full"><label for="slug">Adres (slug)</label><input id="slug" name="slug" value="<?= e($form['slug']) ?>" placeholder="otomatik oluşturulur" data-slug-target<?= $form['slug'] !== '' ? ' data-touched="1"' : '' ?>><small>Site adresi: /urun/<em>slug</em></small></div>
                <div class="field field--full"><label for="tagline">Slogan</label><input id="tagline" name="tagline" value="<?= e($form['tagline']) ?>" placeholder="Hassas Kesim • Kolay Kullanım • Yüksek Verimlilik"></div>
                <div class="field field--full"><label for="summary">Kısa açıklama (kartlarda görünür, en fazla 600 karakter)</label><textarea id="summary" name="summary" rows="3" maxlength="600"><?= e($form['summary']) ?></textarea></div>
                <div class="field field--full"><label for="description">Ürün tanıtımı (paragraflar arasında boş satır bırakın)</label><textarea id="description" name="description" rows="9"><?= e($form['description']) ?></textarea></div>
            </div>
        </section>

        <section class="card">
            <div class="card__head"><h2>Listeler</h2><span class="muted">Her satır bir madde</span></div>
            <div class="fgrid">
                <div class="field"><label for="highlights">Öne çıkan özellikler (ikonlu şerit)</label><textarea id="highlights" name="highlights" rows="7"><?= e($form['highlights']) ?></textarea></div>
                <div class="field"><label for="features">Makine özellikleri</label><textarea id="features" name="features" rows="7"><?= e($form['features']) ?></textarea></div>
                <div class="field"><label for="advantages">Avantajlar</label><textarea id="advantages" name="advantages" rows="7"><?= e($form['advantages']) ?></textarea></div>
                <div class="field"><label for="applications">Kullanım alanları</label><textarea id="applications" name="applications" rows="7"><?= e($form['applications']) ?></textarea></div>
                <div class="field field--full"><label for="specs">Teknik özellikler (<code>Etiket: Değer</code> biçiminde, her satır bir özellik)</label><textarea id="specs" name="specs" rows="10" placeholder="Motor Gücü: 1,5 kW&#10;Elektrik Beslemesi: 380 V / 50 Hz"><?= e($form['specs']) ?></textarea></div>
            </div>
        </section>
    </div>

    <aside class="form-side">
        <section class="card">
            <div class="card__head"><h2>Yayın</h2></div>
            <label class="check"><input type="checkbox" name="is_active" value="1"<?= $form['is_active'] ? ' checked' : '' ?>> Yayında</label>
            <label class="check"><input type="checkbox" name="is_featured" value="1"<?= $form['is_featured'] ? ' checked' : '' ?>> Öne çıkan (anasayfa)</label>
            <div class="field"><label for="sort_order">Sıralama</label><input id="sort_order" name="sort_order" type="number" value="<?= (int) $form['sort_order'] ?>"></div>
            <button class="btn btn--amber btn--block" type="submit"><i class="ph ph-floppy-disk"></i> Kaydet</button>
            <?php if ($product): ?><a class="btn btn--ghost btn--block" href="<?= e(product_url($product['slug'])) ?>" target="_blank" rel="noopener"><i class="ph ph-arrow-up-right"></i> Sitede gör</a><?php endif; ?>
        </section>
        <section class="card">
            <div class="card__head"><h2>Görsel</h2></div>
            <img id="img-preview" class="img-preview" src="<?= $product && $product['image'] ? e(url($product['image'])) : '' ?>" alt="" style="<?= $product && $product['image'] ? '' : 'display:none' ?>">
            <div class="field"><label for="image">Yeni görsel yükle</label><input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" data-preview="#img-preview"><small>JPG, PNG, WebP. En fazla <?= round(UPLOAD_MAX_BYTES / 1048576) ?> MB. Önerilen oran 4:3.</small></div>
            <?php if ($product && $product['image']): ?><label class="check check--danger"><input type="checkbox" name="remove_image" value="1"> Mevcut görseli kaldır</label><?php endif; ?>
        </section>
    </aside>
</form>
<?php require __DIR__ . '/includes/footer.php'; ?>
