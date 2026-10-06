<?php
/**
 * Yalnızca geliştirme için: php -S 127.0.0.1:8080 router.php
 * .htaccess içindeki yönlendirmeleri taklit eder.
 */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri = rtrim($uri, '/');
$file = __DIR__ . $uri;
if ($uri !== '' && (is_file($file) || (is_dir($file) && is_file($file . '/index.php')))) {
    return false;
}
if (preg_match('~^/urun/([a-z0-9-]+)$~', $uri, $m)) {
    $_GET['slug'] = $m[1];
    $_SERVER['SCRIPT_NAME'] = '/urun.php';
    require __DIR__ . '/urun.php';
    return true;
}
if (preg_match('~^/urunler/([a-z0-9-]+)$~', $uri, $m)) {
    $_GET['kategori'] = $m[1];
    $_SERVER['SCRIPT_NAME'] = '/urunler.php';
    require __DIR__ . '/urunler.php';
    return true;
}
if (preg_match('~^/(urunler|kurumsal|iletisim)$~', $uri, $m)) {
    $_SERVER['SCRIPT_NAME'] = '/' . $m[1] . '.php';
    require __DIR__ . '/' . $m[1] . '.php';
    return true;
}
if ($uri === '/sitemap.xml') {
    require __DIR__ . '/sitemap.php';
    return true;
}
if ($uri === '') {
    require __DIR__ . '/index.php';
    return true;
}
http_response_code(404);
echo '404';
return true;
