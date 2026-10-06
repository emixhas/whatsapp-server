<?php
/**
 * REMAK MAKİNA - Kurulum
 *
 * 1. config.php içindeki veritabanı bilgilerini kontrol edin.
 * 2. Tarayıcıdan install.php adresini açın.
 * 3. Kurulum bittiğinde bu dosya kendini "install.lock" ile kilitler; güvenlik için sunucudan silebilirsiniz.
 */
require_once __DIR__ . '/includes/functions.php';

$lock = APP_ROOT . '/install.lock';
$messages = [];
$errors = [];
$done = false;

$adminUser = 'admin';
$adminPass = 'Emixhas.25';

if (is_file($lock) && !isset($_GET['yeniden'])) {
    $locked = true;
} else {
    $locked = false;
    try {
        $pdo = db();
        $pdo->exec("SET NAMES utf8mb4");

        $pdo->exec("CREATE TABLE IF NOT EXISTS admins (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            last_login_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $pdo->exec("CREATE TABLE IF NOT EXISTS categories (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            slug VARCHAR(140) NOT NULL UNIQUE,
            description TEXT NULL,
            sort_order INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $pdo->exec("CREATE TABLE IF NOT EXISTS products (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            category_id INT UNSIGNED NULL,
            model VARCHAR(60) NOT NULL,
            name VARCHAR(160) NOT NULL,
            slug VARCHAR(180) NOT NULL UNIQUE,
            tagline VARCHAR(255) NULL,
            summary VARCHAR(600) NULL,
            description MEDIUMTEXT NULL,
            image VARCHAR(255) NULL,
            highlights TEXT NULL,
            features TEXT NULL,
            specs TEXT NULL,
            advantages TEXT NULL,
            applications TEXT NULL,
            is_featured TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_category (category_id),
            INDEX idx_active_sort (is_active, sort_order),
            CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $pdo->exec("CREATE TABLE IF NOT EXISTS settings (
            skey VARCHAR(80) NOT NULL PRIMARY KEY,
            svalue TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            company VARCHAR(160) NULL,
            phone VARCHAR(40) NULL,
            email VARCHAR(160) NULL,
            subject VARCHAR(200) NULL,
            message TEXT NOT NULL,
            product_slug VARCHAR(180) NULL,
            ip VARCHAR(45) NULL,
            is_read TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

        $messages[] = 'Tablolar oluşturuldu (admins, categories, products, settings, messages).';

        $seed = require __DIR__ . '/includes/seed-data.php';

        // Ayarlar: yalnızca eksik anahtarlar eklenir (mevcut değerler korunur)
        $st = $pdo->prepare('INSERT IGNORE INTO settings (skey, svalue) VALUES (?, ?)');
        foreach ($seed['settings'] as $k => $v) {
            $st->execute([$k, $v]);
        }
        $messages[] = 'Site ayarları yüklendi.';

        // Yönetici
        $count = (int) $pdo->query('SELECT COUNT(*) FROM admins')->fetchColumn();
        if ($count === 0) {
            $st = $pdo->prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)');
            $st->execute([$adminUser, password_hash($adminPass, PASSWORD_DEFAULT)]);
            $messages[] = 'Yönetici hesabı oluşturuldu: <strong>' . e($adminUser) . '</strong>';
        } else {
            $messages[] = 'Yönetici hesabı zaten mevcut, değiştirilmedi.';
        }

        // Kategoriler
        $catIds = [];
        $sel = $pdo->prepare('SELECT id FROM categories WHERE slug = ?');
        $ins = $pdo->prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)');
        foreach ($seed['categories'] as $c) {
            $sel->execute([$c['slug']]);
            $id = $sel->fetchColumn();
            if (!$id) {
                $ins->execute([$c['name'], $c['slug'], $c['description'], $c['sort_order']]);
                $id = $pdo->lastInsertId();
            }
            $catIds[$c['slug']] = (int) $id;
        }
        $messages[] = count($catIds) . ' kategori hazır.';

        // Ürünler
        $sel = $pdo->prepare('SELECT id FROM products WHERE slug = ?');
        $ins = $pdo->prepare('INSERT INTO products (category_id, model, name, slug, tagline, summary, description, image, highlights, features, specs, advantages, applications, is_featured, is_active, sort_order)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)');
        $added = 0;
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
        foreach ($seed['products'] as $p) {
            $sel->execute([$p['slug']]);
            if ($sel->fetchColumn()) {
                continue;
            }
            $specs = array_map(function ($row) {
                return ['label' => $row[0], 'value' => $row[1]];
            }, $p['specs']);
            $ins->execute([
                $catIds[$p['category']] ?? null,
                $p['model'], $p['name'], $p['slug'], $p['tagline'], $p['summary'], $p['description'], $p['image'],
                json_encode($p['highlights'], $flags),
                json_encode($p['features'], $flags),
                json_encode($specs, $flags),
                json_encode($p['advantages'], $flags),
                json_encode($p['applications'], $flags),
                (int) $p['is_featured'], (int) $p['sort_order'],
            ]);
            $added++;
        }
        $messages[] = $added . ' ürün eklendi (' . count($seed['products']) . ' katalog ürünü).';

        @file_put_contents($lock, date('c'));
        $done = true;
    } catch (Throwable $e) {
        $errors[] = $e->getMessage();
    }
}
?>
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kurulum - REMAK MAKİNA</title>
<meta name="robots" content="noindex">
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f4f6;color:#191c22}
.box{max-width:640px;margin:48px auto;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:32px}
h1{font-size:22px;margin:0 0 16px}
ul{padding-left:20px;line-height:1.7}
.ok{color:#1f7a3a}.err{color:#b42318}
.btn{display:inline-block;margin-top:16px;margin-right:8px;background:#14171c;color:#fff;padding:12px 18px;border-radius:4px;text-decoration:none;font-weight:600}
.btn.alt{background:#f5a800;color:#14171c}
code{background:#f3f4f6;padding:2px 6px;border-radius:3px}
</style>
</head>
<body>
<div class="box">
<?php if ($locked): ?>
    <h1>Kurulum zaten yapılmış</h1>
    <p>Bu kurulum daha önce tamamlanmış ve <code>install.lock</code> dosyası oluşturulmuş. Eksik tabloları veya katalog ürünlerini yeniden yüklemek isterseniz <a href="install.php?yeniden=1">buraya tıklayın</a> (mevcut veriler silinmez).</p>
    <a class="btn" href="<?= e(url('')) ?>">Siteye git</a>
    <a class="btn alt" href="<?= e(url('admin/')) ?>">Yönetim paneli</a>
<?php elseif ($errors): ?>
    <h1 class="err">Kurulum sırasında hata oluştu</h1>
    <ul><?php foreach ($errors as $m): ?><li class="err"><?= e($m) ?></li><?php endforeach; ?></ul>
    <p>Lütfen <code>config.php</code> içindeki veritabanı adı, kullanıcı adı ve şifresini kontrol edip sayfayı yenileyin.</p>
<?php else: ?>
    <h1 class="ok">Kurulum tamamlandı</h1>
    <ul><?php foreach ($messages as $m): ?><li><?= $m ?></li><?php endforeach; ?></ul>
    <p>Yönetim paneli girişi: kullanıcı adı <code><?= e($adminUser) ?></code>. Güvenlik için <code>install.php</code> dosyasını sunucudan silmeniz önerilir.</p>
    <a class="btn" href="<?= e(url('')) ?>">Siteye git</a>
    <a class="btn alt" href="<?= e(url('admin/')) ?>">Yönetim paneli</a>
<?php endif; ?>
</div>
</body>
</html>
