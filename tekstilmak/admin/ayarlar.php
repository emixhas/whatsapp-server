<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$adminTitle = 'Site Ayarları';
$pdo = db();

$groups = [
    'Genel' => [
        'site_name' => ['Site adı', 'input'],
        'site_slogan' => ['Slogan', 'input'],
        'meta_description' => ['Arama motoru açıklaması (meta description)', 'textarea', 2],
        'hero_title' => ['Anasayfa başlığı', 'input'],
        'hero_text' => ['Anasayfa alt metni', 'textarea', 2],
        'hero_slide_ms' => ['Anasayfadaki ürün görselinin ekranda kalma süresi (milisaniye; 1000 = 1 saniye)', 'input'],
        'about_short' => ['Kısa tanıtım (anasayfa ve alt bilgi)', 'textarea', 4],
    ],
    'İletişim' => [
        'phone' => ['Telefon (görünen)', 'input'],
        'whatsapp' => ['WhatsApp numarası (yalnızca rakam, ülke koduyla: 905434598504)', 'input'],
        'email' => ['E-posta', 'input'],
        'address' => ['Adres', 'textarea', 2],
        'map_query' => ['Harita arama metni (Google Haritalar)', 'input'],
        'working_hours' => ['Çalışma saatleri', 'input'],
        'instagram' => ['Instagram adresi', 'input'],
        'youtube' => ['YouTube adresi', 'input'],
        'telegram' => ['Telegram adresi', 'input'],
        'notify_email' => ['Form bildirimlerinin gönderileceği e-posta (boş bırakılırsa gönderilmez)', 'input'],
    ],
    'Kurumsal' => [
        'vision' => ['Vizyonumuz', 'textarea', 8],
        'mission' => ['Misyonumuz', 'textarea', 8],
    ],
    'Diğer' => [
        'footer_credit' => ['Alt bilgi imzası (Tasarım ve yazılım)', 'input'],
    ],
];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_check()) {
        flash('err', 'Oturum doğrulanamadı.');
        redirect(url('admin/ayarlar.php'));
    }
    if (($_POST['form'] ?? '') === 'password') {
        $me = admin_user();
        $st = $pdo->prepare('SELECT * FROM admins WHERE id = ?');
        $st->execute([$me['id']]);
        $row = $st->fetch();
        $cur = (string) ($_POST['current'] ?? '');
        $new = (string) ($_POST['new'] ?? '');
        $rep = (string) ($_POST['repeat'] ?? '');
        if (!$row || !password_verify($cur, $row['password_hash'])) {
            flash('err', 'Mevcut şifre hatalı.');
        } elseif (mb_strlen($new) < 8) {
            flash('err', 'Yeni şifre en az 8 karakter olmalı.');
        } elseif ($new !== $rep) {
            flash('err', 'Yeni şifreler birbiriyle uyuşmuyor.');
        } else {
            $pdo->prepare('UPDATE admins SET password_hash = ? WHERE id = ?')->execute([password_hash($new, PASSWORD_DEFAULT), $row['id']]);
            flash('ok', 'Şifre güncellendi.');
        }
        redirect(url('admin/ayarlar.php#sifre'));
    }
    foreach ($groups as $fields) {
        foreach ($fields as $key => $def) {
            if (array_key_exists($key, $_POST)) {
                $val = trim((string) $_POST[$key]);
                if ($key === 'whatsapp') {
                    $val = preg_replace('~\D+~', '', $val);
                }
                set_setting($key, $val);
            }
        }
    }
    flash('ok', 'Ayarlar kaydedildi.');
    redirect(url('admin/ayarlar.php'));
}
$all = settings();
require __DIR__ . '/includes/header.php';
?>
<form method="post" class="form-layout">
    <?= csrf_field() ?>
    <div class="form-main">
        <?php foreach ($groups as $title => $fields): ?>
            <section class="card">
                <div class="card__head"><h2><?= e($title) ?></h2></div>
                <div class="fgrid">
                    <?php foreach ($fields as $key => $def): ?>
                        <div class="field field--full">
                            <label for="s-<?= e($key) ?>"><?= e($def[0]) ?></label>
                            <?php if ($def[1] === 'textarea'): ?>
                                <textarea id="s-<?= e($key) ?>" name="<?= e($key) ?>" rows="<?= (int) ($def[2] ?? 3) ?>"><?= e($all[$key] ?? '') ?></textarea>
                            <?php else: ?>
                                <input id="s-<?= e($key) ?>" name="<?= e($key) ?>" value="<?= e($all[$key] ?? '') ?>">
                            <?php endif; ?>
                        </div>
                    <?php endforeach; ?>
                </div>
            </section>
        <?php endforeach; ?>
    </div>
    <aside class="form-side">
        <section class="card">
            <div class="card__head"><h2>Kaydet</h2></div>
            <p class="muted">Değişiklikler kaydedildiği anda sitede yayınlanır.</p>
            <button class="btn btn--amber btn--block" type="submit"><i class="ph ph-floppy-disk"></i> Ayarları Kaydet</button>
        </section>
    </aside>
</form>

<section class="card" id="sifre" style="max-width:520px">
    <div class="card__head"><h2>Şifre değiştir</h2></div>
    <form method="post">
        <?= csrf_field() ?>
        <input type="hidden" name="form" value="password">
        <div class="field"><label for="pw-cur">Mevcut şifre</label><input id="pw-cur" name="current" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="pw-new">Yeni şifre (en az 8 karakter)</label><input id="pw-new" name="new" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="pw-rep">Yeni şifre (tekrar)</label><input id="pw-rep" name="repeat" type="password" required minlength="8" autocomplete="new-password"></div>
        <button class="btn btn--ink" type="submit"><i class="ph ph-lock-key"></i> Şifreyi Güncelle</button>
    </form>
</section>
<?php require __DIR__ . '/includes/footer.php'; ?>
