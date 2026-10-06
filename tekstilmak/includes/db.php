<?php
require_once __DIR__ . '/../config.php';

/**
 * PDO bağlantısı (tekil).
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=%s', DB_HOST, DB_NAME, DB_CHARSET);
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    } catch (PDOException $e) {
        http_response_code(500);
        if (APP_DEBUG) {
            die('Veritabanı bağlantı hatası: ' . htmlspecialchars($e->getMessage()));
        }
        die('<!doctype html><meta charset="utf-8"><title>Bağlantı hatası</title><body style="font-family:system-ui;padding:40px;color:#222"><h1>Veritabanına bağlanılamadı</h1><p>Lütfen <code>config.php</code> içindeki veritabanı bilgilerini kontrol edin. Kurulum yapılmadıysa <a href="install.php">install.php</a> dosyasını çalıştırın.</p></body>');
    }
    return $pdo;
}

/**
 * Tablolar kurulu mu?
 */
function db_installed(): bool
{
    try {
        db()->query('SELECT 1 FROM settings LIMIT 1');
        return true;
    } catch (PDOException $e) {
        return false;
    }
}
