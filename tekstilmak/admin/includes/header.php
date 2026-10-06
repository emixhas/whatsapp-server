<?php
require_once __DIR__ . '/auth.php';
require_admin();
$adminTitle = $adminTitle ?? 'Yönetim';
$unread = (int) db()->query('SELECT COUNT(*) FROM messages WHERE is_read = 0')->fetchColumn();
$me = admin_user();
$cur = basename($_SERVER['SCRIPT_NAME'] ?? '');
function admin_nav(string $file, string $icon, string $label, int $badge = 0): string
{
    global $cur;
    $active = ($cur === $file || ($file === 'urunler.php' && in_array($cur, ['urun-form.php'], true))) ? ' is-active' : '';
    $b = $badge > 0 ? '<span class="badge">' . $badge . '</span>' : '';
    return '<a class="side__link' . $active . '" href="' . e(url('admin/' . $file)) . '"><i class="ph ph-' . $icon . '"></i><span>' . e($label) . '</span>' . $b . '</a>';
}
?>
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= e($adminTitle) ?> - REMAK Yönetim</title>
<link rel="icon" type="image/png" href="<?= e(asset('img/logo-mark-amber.png')) ?>">
<link rel="stylesheet" href="<?= e(asset('fonts/fonts.css')) ?>">
<link rel="stylesheet" href="<?= e(asset('vendor/phosphor/phosphor.css')) ?>">
<link rel="stylesheet" href="<?= e(url('admin/assets/admin.css')) ?>?v=<?= filemtime(__DIR__ . '/../assets/admin.css') ?>">
</head>
<body class="admin">
<aside class="side">
    <a class="side__brand" href="<?= e(url('admin/')) ?>">
        <img src="<?= e(asset('img/logo-mark-white.png')) ?>" alt="" width="36" height="36">
        <span><strong>REMAK</strong><small>Yönetim Paneli</small></span>
    </a>
    <nav class="side__nav">
        <?= admin_nav('index.php', 'squares-four', 'Özet') ?>
        <?= admin_nav('urunler.php', 'package', 'Ürünler') ?>
        <?= admin_nav('kategoriler.php', 'tag', 'Kategoriler') ?>
        <?= admin_nav('mesajlar.php', 'chat-text', 'Mesajlar', $unread) ?>
        <?= admin_nav('ayarlar.php', 'gear-six', 'Site Ayarları') ?>
    </nav>
    <div class="side__foot">
        <a class="side__link" href="<?= e(url('')) ?>" target="_blank" rel="noopener"><i class="ph ph-arrow-up-right"></i><span>Siteyi görüntüle</span></a>
        <form method="post" action="<?= e(url('admin/logout.php')) ?>"><?= csrf_field() ?><button class="side__link side__link--btn" type="submit"><i class="ph ph-sign-out"></i><span>Çıkış (<?= e($me['username']) ?>)</span></button></form>
    </div>
</aside>
<div class="content">
    <header class="topbar">
        <button class="topbar__menu" type="button" id="side-toggle" aria-label="Menü"><i class="ph ph-list"></i></button>
        <h1><?= e($adminTitle) ?></h1>
        <?php if (isset($topbarAction)): ?><div class="topbar__action"><?= $topbarAction ?></div><?php endif; ?>
    </header>
    <main class="content__main">
    <?php if ($m = flash('ok')): ?><div class="alert alert--ok"><i class="ph ph-check-circle"></i> <?= e($m) ?></div><?php endif; ?>
    <?php if ($m = flash('err')): ?><div class="alert alert--err"><i class="ph ph-warning"></i> <?= e($m) ?></div><?php endif; ?>
