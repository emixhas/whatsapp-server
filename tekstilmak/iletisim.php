<?php
require_once __DIR__ . '/includes/partials.php';
start_session();

$errors = [];
$old    = ['name' => '', 'company' => '', 'phone' => '', 'email' => '', 'subject' => 'Teklif talebi', 'message' => ''];
$subjects = ['Teklif talebi', 'Teknik destek', 'Yedek parça', 'Bayilik / iş birliği', 'Diğer'];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    foreach ($old as $k => $v) {
        $old[$k] = trim((string) ($_POST[$k] ?? ''));
    }
    if (!csrf_check()) {
        $errors['form'] = 'Oturum süresi dolmuş olabilir. Lütfen sayfayı yenileyip tekrar deneyin.';
    }
    if (!empty($_POST['website'])) { // bal küpü (bot koruması)
        $errors['form'] = 'Gönderim doğrulanamadı.';
    }
    if (mb_strlen($old['name']) < 2 || mb_strlen($old['name']) > 120) {
        $errors['name'] = 'Lütfen adınızı ve soyadınızı yazın.';
    }
    if ($old['phone'] === '' && $old['email'] === '') {
        $errors['phone'] = 'Size ulaşabilmemiz için telefon veya e-posta girin.';
    }
    if ($old['email'] !== '' && !filter_var($old['email'], FILTER_VALIDATE_EMAIL)) {
        $errors['email'] = 'E-posta adresi geçersiz görünüyor.';
    }
    if ($old['phone'] !== '' && !preg_match('~^[0-9+()\s-]{7,25}$~', $old['phone'])) {
        $errors['phone'] = 'Telefon numarası geçersiz görünüyor.';
    }
    if (!in_array($old['subject'], $subjects, true)) {
        $old['subject'] = 'Diğer';
    }
    if (mb_strlen($old['message']) < 10 || mb_strlen($old['message']) > 3000) {
        $errors['message'] = 'Mesajınız en az 10 karakter olmalı.';
    }

    if (!$errors) {
        $st = db()->prepare('INSERT INTO messages (name, company, phone, email, subject, message, ip) VALUES (?, ?, ?, ?, ?, ?, ?)');
        $st->execute([$old['name'], $old['company'] ?: null, $old['phone'] ?: null, $old['email'] ?: null, $old['subject'], $old['message'], $_SERVER['REMOTE_ADDR'] ?? null]);

        $notify = setting('notify_email');
        if ($notify && filter_var($notify, FILTER_VALIDATE_EMAIL)) {
            $body = "Ad Soyad: {$old['name']}\nFirma: {$old['company']}\nTelefon: {$old['phone']}\nE-posta: {$old['email']}\nKonu: {$old['subject']}\n\n{$old['message']}";
            $headers = 'From: ' . setting('site_name', 'REMAK MAKİNA') . ' <no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . ">\r\nContent-Type: text/plain; charset=utf-8";
            @mail($notify, '=?UTF-8?B?' . base64_encode('Web sitesi iletişim formu: ' . $old['subject']) . '?=', $body, $headers);
        }
        flash('contact_ok', 'Mesajınız bize ulaştı. En kısa sürede sizinle iletişime geçeceğiz.');
        redirect(url('iletisim') . '#form');
    }
}

$success   = flash('contact_ok');
$pageTitle = 'İletişim';
$metaDesc  = 'REMAK MAKİNA iletişim: ' . setting('address') . ' Telefon ' . setting('phone');
$bodyClass = 'page-contact';
$wa        = setting('whatsapp', '905434598504');
$mapQuery  = setting('map_query', setting('address'));
require __DIR__ . '/includes/header.php';
?>

<section class="page-hero">
    <div class="container">
        <nav class="crumbs" aria-label="Sayfa yolu"><a href="<?= e(url('')) ?>">Anasayfa</a><span>/</span><strong>İletişim</strong></nav>
        <h1 data-split>Bize ulaşın</h1>
        <p data-hero>Makine seçimi, teknik sorular, servis veya teklif talepleriniz için ekibimiz hazır.</p>
    </div>
</section>

<section class="contact">
    <div class="container contact__grid">
        <div class="contact__info" data-reveal>
            <ul class="contact-list contact-list--lg">
                <li><i class="ph ph-map-pin" aria-hidden="true"></i><div><strong>Adres</strong><span><?= e(setting('address')) ?></span><a href="https://www.google.com/maps/search/?api=1&query=<?= rawurlencode($mapQuery) ?>" target="_blank" rel="noopener">Yol tarifi al <i class="ph-bold ph-arrow-up-right" aria-hidden="true"></i></a></div></li>
                <li><i class="ph ph-phone" aria-hidden="true"></i><div><strong>Telefon / WhatsApp</strong><a href="<?= e(tel_link(setting('phone'))) ?>"><?= e(setting('phone')) ?></a></div></li>
                <li><i class="ph ph-envelope" aria-hidden="true"></i><div><strong>E-posta</strong><a href="mailto:<?= e(setting('email')) ?>"><?= e(setting('email')) ?></a></div></li>
                <li><i class="ph ph-clock" aria-hidden="true"></i><div><strong>Çalışma saatleri</strong><span><?= e(setting('working_hours')) ?></span></div></li>
            </ul>
            <div class="contact__social">
                <a class="btn btn--amber btn--lg" href="<?= e(wa_link($wa, 'Merhaba, REMAK MAKİNA ürünleri hakkında bilgi almak istiyorum.')) ?>" target="_blank" rel="noopener"><i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i> WhatsApp ile Yazın</a>
                <div class="social social--lg">
                    <?php if (setting('instagram')): ?><a href="<?= e(setting('instagram')) ?>" target="_blank" rel="noopener" aria-label="Instagram"><i class="ph ph-instagram-logo"></i></a><?php endif; ?>
                    <?php if (setting('youtube')): ?><a href="<?= e(setting('youtube')) ?>" target="_blank" rel="noopener" aria-label="YouTube"><i class="ph ph-youtube-logo"></i></a><?php endif; ?>
                    <?php if (setting('telegram')): ?><a href="<?= e(setting('telegram')) ?>" target="_blank" rel="noopener" aria-label="Telegram"><i class="ph ph-telegram-logo"></i></a><?php endif; ?>
                </div>
            </div>
        </div>

        <div class="contact__form" id="form" data-reveal>
            <h2 data-split>Mesaj gönderin</h2>
            <?php if ($success): ?>
                <div class="alert alert--success" role="status"><i class="ph-bold ph-check-circle" aria-hidden="true"></i> <?= e($success) ?></div>
            <?php endif; ?>
            <?php if (!empty($errors['form'])): ?>
                <div class="alert alert--error" role="alert"><i class="ph-bold ph-warning" aria-hidden="true"></i> <?= e($errors['form']) ?></div>
            <?php endif; ?>
            <form method="post" action="<?= e(url('iletisim')) ?>#form" novalidate>
                <?= csrf_field() ?>
                <div class="hp" aria-hidden="true"><label>Web siteniz<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
                <div class="form-grid">
                    <div class="field<?= isset($errors['name']) ? ' has-error' : '' ?>">
                        <label for="f-name">Ad Soyad *</label>
                        <input id="f-name" name="name" type="text" value="<?= e($old['name']) ?>" required autocomplete="name">
                        <?php if (isset($errors['name'])): ?><span class="field__error"><?= e($errors['name']) ?></span><?php endif; ?>
                    </div>
                    <div class="field">
                        <label for="f-company">Firma</label>
                        <input id="f-company" name="company" type="text" value="<?= e($old['company']) ?>" autocomplete="organization">
                    </div>
                    <div class="field<?= isset($errors['phone']) ? ' has-error' : '' ?>">
                        <label for="f-phone">Telefon *</label>
                        <input id="f-phone" name="phone" type="tel" value="<?= e($old['phone']) ?>" autocomplete="tel" placeholder="0 5xx xxx xx xx">
                        <?php if (isset($errors['phone'])): ?><span class="field__error"><?= e($errors['phone']) ?></span><?php endif; ?>
                    </div>
                    <div class="field<?= isset($errors['email']) ? ' has-error' : '' ?>">
                        <label for="f-email">E-posta</label>
                        <input id="f-email" name="email" type="email" value="<?= e($old['email']) ?>" autocomplete="email">
                        <?php if (isset($errors['email'])): ?><span class="field__error"><?= e($errors['email']) ?></span><?php endif; ?>
                    </div>
                    <div class="field field--full">
                        <label for="f-subject">Konu</label>
                        <select id="f-subject" name="subject">
                            <?php foreach ($subjects as $s): ?><option value="<?= e($s) ?>"<?= $old['subject'] === $s ? ' selected' : '' ?>><?= e($s) ?></option><?php endforeach; ?>
                        </select>
                    </div>
                    <div class="field field--full<?= isset($errors['message']) ? ' has-error' : '' ?>">
                        <label for="f-message">Mesajınız *</label>
                        <textarea id="f-message" name="message" rows="6" required><?= e($old['message']) ?></textarea>
                        <?php if (isset($errors['message'])): ?><span class="field__error"><?= e($errors['message']) ?></span><?php endif; ?>
                    </div>
                </div>
                <button class="btn btn--ink btn--lg" type="submit">Gönder <i class="ph-bold ph-paper-plane-tilt" aria-hidden="true"></i></button>
            </form>
        </div>
    </div>
</section>

<section class="map">
    <iframe src="https://www.google.com/maps?q=<?= rawurlencode($mapQuery) ?>&hl=tr&z=15&output=embed" width="100%" height="460" style="border:0" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="REMAK MAKİNA konumu"></iframe>
</section>

<?php require __DIR__ . '/includes/footer.php'; ?>
