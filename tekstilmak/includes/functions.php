<?php
require_once __DIR__ . '/db.php';

/* ---------------------------------------------------------------------
 * Temel yardımcılar
 * ------------------------------------------------------------------ */

function e(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * Site kök yolu ("" veya "/altklasor"). Hem Apache/LiteSpeed hem de
 * PHP'nin dahili sunucusunda çalışır.
 */
function base_path(): string
{
    static $base = null;
    if ($base !== null) {
        return $base;
    }
    $docroot = isset($_SERVER['DOCUMENT_ROOT']) ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
    $approot = realpath(APP_ROOT);
    $base = '';
    if ($docroot && $approot && strpos($approot, $docroot) === 0) {
        $base = str_replace('\\', '/', substr($approot, strlen($docroot)));
    }
    $base = rtrim($base, '/');
    return $base;
}

function url(string $path = ''): string
{
    $path = ltrim($path, '/');
    return base_path() . '/' . $path;
}

function asset(string $path): string
{
    $file = APP_ROOT . '/assets/' . $path;
    $v = is_file($file) ? '?v=' . filemtime($file) : '';
    return url('assets/' . $path) . $v;
}

function product_url(string $slug): string
{
    return url('urun/' . $slug);
}

function category_url(string $slug): string
{
    return url('urunler/' . $slug);
}

function current_url(): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host . ($_SERVER['REQUEST_URI'] ?? '/');
}

function site_origin(): string
{
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return $scheme . '://' . $host;
}

function redirect(string $url): void
{
    header('Location: ' . $url);
    exit;
}

function is_active(string $page): string
{
    $script = basename($_SERVER['SCRIPT_NAME'] ?? '');
    return $script === $page ? ' is-active' : '';
}

/**
 * Türkçe karakterleri de dönüştüren slug üretici.
 */
function slugify(string $text): string
{
    $map = ['ş' => 's', 'Ş' => 's', 'ı' => 'i', 'İ' => 'i', 'ğ' => 'g', 'Ğ' => 'g', 'ü' => 'u', 'Ü' => 'u', 'ö' => 'o', 'Ö' => 'o', 'ç' => 'c', 'Ç' => 'c', 'â' => 'a', 'î' => 'i', 'û' => 'u'];
    $text = strtr($text, $map);
    $text = mb_strtolower($text, 'UTF-8');
    $text = preg_replace('~[^a-z0-9]+~', '-', $text);
    $text = trim($text, '-');
    return $text === '' ? 'urun' : $text;
}

/**
 * JSON listeyi diziye çevirir; düz metin ise satırlara böler.
 */
function json_list(?string $raw): array
{
    if ($raw === null || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) {
        return array_values(array_filter(array_map(function ($v) {
            return is_string($v) ? trim($v) : $v;
        }, $decoded), function ($v) {
            return $v !== '' && $v !== null;
        }));
    }
    return array_values(array_filter(array_map('trim', preg_split('~\r\n|\r|\n~', $raw))));
}

/**
 * "Etiket: Değer" satırlarını [{label,value}] dizisine çevirir.
 */
function parse_spec_lines(string $raw): array
{
    $rows = [];
    foreach (preg_split('~\r\n|\r|\n~', $raw) as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $pos = mb_strpos($line, ':');
        if ($pos === false) {
            $rows[] = ['label' => $line, 'value' => ''];
            continue;
        }
        $rows[] = ['label' => trim(mb_substr($line, 0, $pos)), 'value' => trim(mb_substr($line, $pos + 1))];
    }
    return $rows;
}

function spec_lines_to_text(array $specs): string
{
    $out = [];
    foreach ($specs as $row) {
        if (is_array($row)) {
            $out[] = ($row['label'] ?? '') . ': ' . ($row['value'] ?? '');
        }
    }
    return implode("\n", $out);
}

/**
 * Boş satırla ayrılmış metni <p> paragraflarına çevirir.
 */
function nl2p(?string $text, string $class = ''): string
{
    $text = trim((string) $text);
    if ($text === '') {
        return '';
    }
    $parts = preg_split('~(\r\n|\r|\n){2,}~', $text);
    $cls = $class !== '' ? ' class="' . e($class) . '"' : '';
    $html = '';
    foreach ($parts as $p) {
        $p = trim($p);
        if ($p === '') {
            continue;
        }
        $html .= '<p' . $cls . '>' . nl2br(e($p)) . '</p>';
    }
    return $html;
}

function wa_link(string $number, string $text = ''): string
{
    $number = preg_replace('~\D+~', '', $number);
    $url = 'https://wa.me/' . $number;
    if ($text !== '') {
        $url .= '?text=' . rawurlencode($text);
    }
    return $url;
}

function tel_link(string $phone): string
{
    return 'tel:' . preg_replace('~[^\d+]+~', '', $phone);
}

function format_date(?string $dt): string
{
    if (!$dt) {
        return '';
    }
    $ts = strtotime($dt);
    return $ts ? date('d.m.Y H:i', $ts) : $dt;
}

/* ---------------------------------------------------------------------
 * Ayarlar
 * ------------------------------------------------------------------ */

function settings(): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $cache = [];
    try {
        foreach (db()->query('SELECT skey, svalue FROM settings') as $row) {
            $cache[$row['skey']] = $row['svalue'];
        }
    } catch (PDOException $e) {
        $cache = [];
    }
    return $cache;
}

function setting(string $key, string $default = ''): string
{
    $all = settings();
    return isset($all[$key]) && $all[$key] !== '' ? $all[$key] : $default;
}

function set_setting(string $key, string $value): void
{
    $st = db()->prepare('INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)');
    $st->execute([$key, $value]);
}

/* ---------------------------------------------------------------------
 * Ürün ve kategori sorguları
 * ------------------------------------------------------------------ */

function get_categories(bool $withCounts = true): array
{
    if ($withCounts) {
        $sql = 'SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
                FROM categories c ORDER BY c.sort_order, c.name';
    } else {
        $sql = 'SELECT * FROM categories ORDER BY sort_order, name';
    }
    return db()->query($sql)->fetchAll();
}

function get_category(string $slug): ?array
{
    $st = db()->prepare('SELECT * FROM categories WHERE slug = ? LIMIT 1');
    $st->execute([$slug]);
    $row = $st->fetch();
    return $row ?: null;
}

function get_products(?string $categorySlug = null, bool $onlyFeatured = false, ?int $limit = null): array
{
    $sql = 'SELECT p.*, c.name AS category_name, c.slug AS category_slug
            FROM products p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_active = 1';
    $params = [];
    if ($categorySlug !== null) {
        $sql .= ' AND c.slug = ?';
        $params[] = $categorySlug;
    }
    if ($onlyFeatured) {
        $sql .= ' AND p.is_featured = 1';
    }
    $sql .= ' ORDER BY p.sort_order, p.id';
    if ($limit !== null) {
        $sql .= ' LIMIT ' . (int) $limit;
    }
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st->fetchAll();
}

function get_product(string $slug): ?array
{
    $st = db()->prepare('SELECT p.*, c.name AS category_name, c.slug AS category_slug
                         FROM products p LEFT JOIN categories c ON c.id = p.category_id
                         WHERE p.slug = ? AND p.is_active = 1 LIMIT 1');
    $st->execute([$slug]);
    $row = $st->fetch();
    return $row ?: null;
}

function product_image(?array $product): string
{
    if ($product && !empty($product['image'])) {
        return url($product['image']);
    }
    return asset('img/products/rm-500.jpg');
}

function category_image(array $category): string
{
    $st = db()->prepare('SELECT image FROM products WHERE category_id = ? AND is_active = 1 AND image <> "" ORDER BY is_featured DESC, sort_order LIMIT 1');
    $st->execute([$category['id']]);
    $img = $st->fetchColumn();
    return $img ? url($img) : asset('img/factory/factory-1.jpg');
}

/**
 * Öne çıkan özellik metnine göre Phosphor ikon adı seçer.
 */
function highlight_icon(string $text): string
{
    $t = mb_strtolower($text, 'UTF-8');
    $rules = [
        'hız' => 'gauge', 'hızlı' => 'gauge', 'verim' => 'chart-line-up', 'güven' => 'shield-check', 'emniyet' => 'shield-check',
        'kesim' => 'scissors', 'dilim' => 'scissors', 'kenar' => 'ruler', 'ölçü' => 'ruler', 'metraj' => 'ruler', 'metre' => 'ruler',
        'sıcaklık' => 'thermometer', 'ısı' => 'thermometer', 'rezistans' => 'thermometer', 'yağ' => 'drop', 'su bazlı' => 'drop',
        'enerji' => 'lightning', 'çevre' => 'leaf', 'tasarruf' => 'leaf', 'dokunmatik' => 'hand-tap', 'panel' => 'hand-tap',
        'dijital' => 'cpu', 'kontrol' => 'sliders-horizontal', 'plc' => 'cpu', 'sensör' => 'crosshair', 'hassas' => 'crosshair',
        'led' => 'lightbulb', 'aydınlat' => 'lightbulb', 'kumaş' => 'stack', 'tela' => 'stack', 'rulo' => 'package',
        'paket' => 'package', 'koru' => 'shield-check', 'bakım' => 'wrench', 'servis' => 'wrench', 'ömür' => 'clock',
        'dayanıklı' => 'medal', 'sağlam' => 'medal', 'çelik' => 'medal', 'kalite' => 'seal-check', 'kullanım' => 'hand-tap',
        'kompakt' => 'squares-four', 'tasarım' => 'squares-four', 'basınç' => 'gauge', 'gerginlik' => 'arrows-horizontal',
        'homojen' => 'circles-three-plus', 'minimum fire' => 'recycle', 'fire' => 'recycle', 'sürekli' => 'arrows-clockwise',
        'otomatik' => 'gear-six', 'ayarlanabilir' => 'sliders-horizontal', 'merdane' => 'circles-three-plus', 'sistem' => 'gear',
    ];
    foreach ($rules as $needle => $icon) {
        if (mb_strpos($t, $needle) !== false) {
            return $icon;
        }
    }
    return 'check-circle';
}

/* ---------------------------------------------------------------------
 * Oturum, CSRF, flash
 * ------------------------------------------------------------------ */

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    session_name('remak_session');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => (base_path() === '' ? '/' : base_path() . '/'),
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function csrf_token(): string
{
    start_session();
    if (empty($_SESSION['_csrf'])) {
        $_SESSION['_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['_csrf'];
}

function csrf_field(): string
{
    return '<input type="hidden" name="_token" value="' . e(csrf_token()) . '">';
}

function csrf_check(): bool
{
    start_session();
    $sent = $_POST['_token'] ?? '';
    return is_string($sent) && !empty($_SESSION['_csrf']) && hash_equals($_SESSION['_csrf'], $sent);
}

function flash(string $key, ?string $message = null)
{
    start_session();
    if ($message !== null) {
        $_SESSION['_flash'][$key] = $message;
        return null;
    }
    $msg = $_SESSION['_flash'][$key] ?? null;
    unset($_SESSION['_flash'][$key]);
    return $msg;
}
