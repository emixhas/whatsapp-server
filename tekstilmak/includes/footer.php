<?php
$fCats = get_categories();
$fWa = setting('whatsapp', '905434598504');
$fPhone = setting('phone');
$aboutParts = preg_split('~(\r\n|\r|\n){2,}~', trim(setting('about_short')));
?>
</main>
<footer class="site-footer">
    <div class="container footer__grid">
        <div class="footer__brand">
            <img src="<?= e(asset('img/logo-lockup-white.png')) ?>" alt="<?= e(setting('site_name', 'REMAK MAKİNA')) ?>" width="200" height="78" loading="lazy">
            <p><?= e($aboutParts[0] ?? '') ?></p>
            <div class="social">
                <?php if (setting('instagram')): ?><a href="<?= e(setting('instagram')) ?>" target="_blank" rel="noopener" aria-label="Instagram"><i class="ph ph-instagram-logo"></i></a><?php endif; ?>
                <?php if (setting('youtube')): ?><a href="<?= e(setting('youtube')) ?>" target="_blank" rel="noopener" aria-label="YouTube"><i class="ph ph-youtube-logo"></i></a><?php endif; ?>
                <?php if (setting('telegram')): ?><a href="<?= e(setting('telegram')) ?>" target="_blank" rel="noopener" aria-label="Telegram"><i class="ph ph-telegram-logo"></i></a><?php endif; ?>
                <a href="<?= e(wa_link($fWa)) ?>" target="_blank" rel="noopener" aria-label="WhatsApp"><i class="ph ph-whatsapp-logo"></i></a>
            </div>
        </div>
        <div class="footer__col">
            <h4>Menü</h4>
            <ul>
                <li><a href="<?= e(url('')) ?>">Anasayfa</a></li>
                <li><a href="<?= e(url('kurumsal')) ?>">Kurumsal</a></li>
                <li><a href="<?= e(url('urunler')) ?>">Ürünler</a></li>
                <li><a href="<?= e(url('iletisim')) ?>">İletişim</a></li>
                <li><a href="<?= e(asset('katalog/remak-makina-2026-e-katalog.pdf')) ?>" target="_blank" rel="noopener">2026 E-Katalog (PDF)</a></li>
            </ul>
        </div>
        <div class="footer__col">
            <h4>Ürün Grupları</h4>
            <ul>
                <?php foreach ($fCats as $c): ?>
                    <li><a href="<?= e(category_url($c['slug'])) ?>"><?= e($c['name']) ?></a></li>
                <?php endforeach; ?>
            </ul>
        </div>
        <div class="footer__col footer__contact">
            <h4>İletişim</h4>
            <ul>
                <li><i class="ph ph-map-pin" aria-hidden="true"></i><span><?= e(setting('address')) ?></span></li>
                <li><i class="ph ph-phone" aria-hidden="true"></i><a href="<?= e(tel_link($fPhone)) ?>"><?= e($fPhone) ?></a></li>
                <li><i class="ph ph-envelope" aria-hidden="true"></i><a href="mailto:<?= e(setting('email')) ?>"><?= e(setting('email')) ?></a></li>
                <li><i class="ph ph-clock" aria-hidden="true"></i><span><?= e(setting('working_hours')) ?></span></li>
            </ul>
        </div>
    </div>
    <div class="container footer__bottom">
        <span>© <?= date('Y') ?> <?= e(setting('site_name', 'REMAK MAKİNA')) ?>. Tüm hakları saklıdır.</span>
        <?php if (setting('footer_credit')): ?><span>Tasarım ve yazılım: <?= e(setting('footer_credit')) ?></span><?php endif; ?>
    </div>
</footer>
<a class="wa-float" href="<?= e(wa_link($fWa, $waText ?? 'Merhaba, REMAK MAKİNA ürünleri hakkında bilgi almak istiyorum.')) ?>" target="_blank" rel="noopener" aria-label="WhatsApp ile yazın">
    <i class="ph-bold ph-whatsapp-logo" aria-hidden="true"></i><span>WhatsApp</span>
</a>
<script src="<?= e(asset('js/vendor/gsap.min.js')) ?>" defer></script>
<script src="<?= e(asset('js/vendor/ScrollTrigger.min.js')) ?>" defer></script>
<script src="<?= e(asset('js/main.js')) ?>" defer></script>
</body>
</html>
