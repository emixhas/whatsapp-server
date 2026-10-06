<?php
require_once __DIR__ . '/includes/auth.php';
require_admin();
$adminTitle = 'Mesajlar';
$pdo = db();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!csrf_check()) {
        flash('err', 'Oturum doğrulanamadı.');
        redirect(url('admin/mesajlar.php'));
    }
    $id = (int) ($_POST['id'] ?? 0);
    $action = $_POST['action'] ?? '';
    if ($action === 'delete') {
        $pdo->prepare('DELETE FROM messages WHERE id = ?')->execute([$id]);
        flash('ok', 'Mesaj silindi.');
    } elseif ($action === 'unread') {
        $pdo->prepare('UPDATE messages SET is_read = 0 WHERE id = ?')->execute([$id]);
        flash('ok', 'Okunmadı olarak işaretlendi.');
    }
    redirect(url('admin/mesajlar.php'));
}
$viewId = (int) ($_GET['id'] ?? 0);
$view = null;
if ($viewId) {
    $st = $pdo->prepare('SELECT * FROM messages WHERE id = ?');
    $st->execute([$viewId]);
    $view = $st->fetch();
    if ($view && !$view['is_read']) {
        $pdo->prepare('UPDATE messages SET is_read = 1 WHERE id = ?')->execute([$viewId]);
        $view['is_read'] = 1;
    }
}
$messages = $pdo->query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 300')->fetchAll();
require __DIR__ . '/includes/header.php';
?>
<?php if ($view): ?>
<section class="card msg">
    <div class="card__head"><h2><?= e($view['subject'] ?: 'Mesaj') ?></h2><a href="<?= e(url('admin/mesajlar.php')) ?>"><i class="ph ph-arrow-left"></i> Listeye dön</a></div>
    <dl class="msg__meta">
        <div><dt>Gönderen</dt><dd><?= e($view['name']) ?><?= $view['company'] ? ' (' . e($view['company']) . ')' : '' ?></dd></div>
        <div><dt>Telefon</dt><dd><?= $view['phone'] ? '<a href="' . e(tel_link($view['phone'])) . '">' . e($view['phone']) . '</a> · <a href="' . e(wa_link($view['phone'])) . '" target="_blank" rel="noopener">WhatsApp</a>' : '-' ?></dd></div>
        <div><dt>E-posta</dt><dd><?= $view['email'] ? '<a href="mailto:' . e($view['email']) . '">' . e($view['email']) . '</a>' : '-' ?></dd></div>
        <div><dt>Tarih</dt><dd><?= e(format_date($view['created_at'])) ?></dd></div>
    </dl>
    <div class="msg__body"><?= nl2br(e($view['message'])) ?></div>
    <div class="msg__actions">
        <form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="unread"><input type="hidden" name="id" value="<?= (int) $view['id'] ?>"><button class="btn btn--ghost" type="submit">Okunmadı yap</button></form>
        <form method="post" data-confirm="Mesaj silinsin mi?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $view['id'] ?>"><button class="btn btn--danger" type="submit"><i class="ph ph-trash"></i> Sil</button></form>
    </div>
</section>
<?php endif; ?>

<section class="card">
    <div class="card__head"><h2>Gelen kutusu</h2><span class="muted"><?= count($messages) ?> mesaj</span></div>
    <?php if (!$messages): ?><div class="empty"><i class="ph ph-chat-text"></i><p>Henüz mesaj yok. İletişim formundan gelen mesajlar burada listelenir.</p></div><?php else: ?>
    <table class="table">
        <thead><tr><th>Gönderen</th><th>Konu</th><th>Mesaj</th><th>Tarih</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($messages as $m): ?>
            <tr class="<?= $m['is_read'] ? '' : 'is-unread' ?>">
                <td><a href="<?= e(url('admin/mesajlar.php?id=' . $m['id'])) ?>"><?= e($m['name']) ?></a><small><?= e($m['phone'] ?: $m['email']) ?></small></td>
                <td><?= e($m['subject']) ?></td>
                <td class="clip"><?= e(mb_substr($m['message'], 0, 90)) ?><?= mb_strlen($m['message']) > 90 ? '…' : '' ?></td>
                <td class="nowrap"><?= e(format_date($m['created_at'])) ?></td>
                <td class="actions"><form method="post" data-confirm="Mesaj silinsin mi?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $m['id'] ?>"><button class="icon-btn icon-btn--danger" type="submit" title="Sil"><i class="ph ph-trash"></i></button></form></td>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
    <?php endif; ?>
</section>
<?php require __DIR__ . '/includes/footer.php'; ?>
