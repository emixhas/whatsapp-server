<?php
require_once __DIR__ . '/../../includes/functions.php';
start_session();

function admin_user(): ?array
{
    return $_SESSION['admin'] ?? null;
}

function require_admin(): void
{
    if (empty($_SESSION['admin'])) {
        redirect(url('admin/login.php'));
    }
}

function admin_login(string $username, string $password): bool
{
    $st = db()->prepare('SELECT * FROM admins WHERE username = ? LIMIT 1');
    $st->execute([$username]);
    $row = $st->fetch();
    if (!$row || !password_verify($password, $row['password_hash'])) {
        return false;
    }
    session_regenerate_id(true);
    $_SESSION['admin'] = ['id' => (int) $row['id'], 'username' => $row['username']];
    unset($_SESSION['login_fail'], $_SESSION['login_lock']);
    db()->prepare('UPDATE admins SET last_login_at = NOW() WHERE id = ?')->execute([$row['id']]);
    if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
        db()->prepare('UPDATE admins SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $row['id']]);
    }
    return true;
}

function admin_logout(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
}

/**
 * Görsel yükleme: jpg/png/webp, en fazla UPLOAD_MAX_BYTES. Büyük görseller 1600px'e küçültülür.
 * Başarıda site köküne göre yol döner ("uploads/xxx.jpg"), hata durumunda RuntimeException fırlatır.
 */
function handle_image_upload(string $field): ?string
{
    if (empty($_FILES[$field]) || ($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    $f = $_FILES[$field];
    if ($f['error'] !== UPLOAD_ERR_OK) {
        throw new RuntimeException('Dosya yüklenemedi (hata kodu ' . (int) $f['error'] . '). Dosya boyutu sunucu limitini aşıyor olabilir.');
    }
    if ($f['size'] > UPLOAD_MAX_BYTES) {
        throw new RuntimeException('Görsel en fazla ' . round(UPLOAD_MAX_BYTES / 1048576) . ' MB olabilir.');
    }
    if (!is_uploaded_file($f['tmp_name'])) {
        throw new RuntimeException('Geçersiz yükleme.');
    }
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = $finfo->file($f['tmp_name']);
    $map = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    if (!isset($map[$mime]) || !@getimagesize($f['tmp_name'])) {
        throw new RuntimeException('Yalnızca JPG, PNG veya WebP görsel yükleyebilirsiniz.');
    }
    $dir = APP_ROOT . '/' . UPLOAD_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    if (!is_writable($dir)) {
        throw new RuntimeException('uploads klasörü yazılabilir değil. Klasör izinlerini (755) kontrol edin.');
    }
    $name = date('Ymd') . '-' . bin2hex(random_bytes(6)) . '.' . $map[$mime];
    $dest = $dir . '/' . $name;

    $resized = false;
    if (function_exists('imagecreatefromstring')) {
        $src = @imagecreatefromstring(file_get_contents($f['tmp_name']));
        if ($src) {
            $w = imagesx($src);
            $h = imagesy($src);
            $max = 1600;
            if ($w > $max) {
                $nh = (int) round($h * $max / $w);
                $dst = imagecreatetruecolor($max, $nh);
                if ($mime !== 'image/jpeg') {
                    imagealphablending($dst, false);
                    imagesavealpha($dst, true);
                }
                imagecopyresampled($dst, $src, 0, 0, 0, 0, $max, $nh, $w, $h);
                $ok = $mime === 'image/png' ? imagepng($dst, $dest, 7) : ($mime === 'image/webp' ? imagewebp($dst, $dest, 86) : imagejpeg($dst, $dest, 86));
                imagedestroy($dst);
                $resized = (bool) $ok;
            }
            imagedestroy($src);
        }
    }
    if (!$resized && !move_uploaded_file($f['tmp_name'], $dest)) {
        throw new RuntimeException('Dosya kaydedilemedi.');
    }
    @chmod($dest, 0644);
    return UPLOAD_DIR . '/' . $name;
}

function delete_upload(?string $path): void
{
    if ($path && strpos($path, UPLOAD_DIR . '/') === 0) {
        $file = APP_ROOT . '/' . $path;
        if (is_file($file)) {
            @unlink($file);
        }
    }
}
