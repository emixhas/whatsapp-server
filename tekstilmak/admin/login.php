<?php
require_once __DIR__ . '/includes/auth.php';
if (admin_user()) {
    redirect(url('admin/'));
}
$error = '';
$lockUntil = (int) ($_SESSION['login_lock'] ?? 0);
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if ($lockUntil > time()) {
        $error = 'Çok fazla hatalı deneme. Lütfen ' . ($lockUntil - time()) . ' saniye sonra tekrar deneyin.';
    } elseif (!csrf_check()) {
        $error = 'Oturum doğrulanamadı, lütfen tekrar deneyin.';
    } else {
        $u = trim((string) ($_POST['username'] ?? ''));
        $p = (string) ($_POST['password'] ?? '');
        if ($u !== '' && $p !== '' && admin_login($u, $p)) {
            redirect(url('admin/'));
        }
        $fails = (int) ($_SESSION['login_fail'] ?? 0) + 1;
        $_SESSION['login_fail'] = $fails;
        if ($fails >= 5) {
            $_SESSION['login_lock'] = time() + 60;
            $_SESSION['login_fail'] = 0;
        }
        usleep(400000);
        $error = 'Kullanıcı adı veya şifre hatalı.';
    }
}
?>
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Giriş - REMAK Yönetim</title>
<link rel="icon" type="image/png" href="<?= e(asset('img/logo-mark-amber.png')) ?>">
<link rel="stylesheet" href="<?= e(asset('fonts/fonts.css')) ?>">
<link rel="stylesheet" href="<?= e(asset('vendor/phosphor/phosphor.css')) ?>">
<link rel="stylesheet" href="<?= e(url('admin/assets/admin.css')) ?>?v=<?= filemtime(__DIR__ . '/assets/admin.css') ?>">
</head>
<body class="login">
<div class="login__box">
    <div class="login__brand">
        <img src="<?= e(asset('img/logo-mark-white.png')) ?>" alt="" width="56" height="56">
        <strong>REMAK MAKİNA</strong>
        <span>Yönetim Paneli</span>
    </div>
    <?php if ($error): ?><div class="alert alert--err"><i class="ph ph-warning"></i> <?= e($error) ?></div><?php endif; ?>
    <form method="post" autocomplete="on">
        <?= csrf_field() ?>
        <div class="field">
            <label for="u">Kullanıcı adı</label>
            <input id="u" name="username" type="text" required autofocus autocomplete="username" value="<?= e($_POST['username'] ?? '') ?>">
        </div>
        <div class="field">
            <label for="p">Şifre</label>
            <input id="p" name="password" type="password" required autocomplete="current-password">
        </div>
        <button class="btn btn--amber btn--block" type="submit">Giriş Yap</button>
    </form>
    <a class="login__back" href="<?= e(url('')) ?>"><i class="ph ph-arrow-left"></i> Siteye dön</a>
</div>
</body>
</html>
