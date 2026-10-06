<?php
/**
 * REMAK MAKİNA - Site yapılandırması
 *
 * Veritabanı bilgileri Hostinger paneli (hPanel > Veritabanları) ile aynıdır.
 * Bu dosya web üzerinden okunamaz (.htaccess ile korunur).
 */

define('DB_HOST', 'localhost');
define('DB_NAME', 'u767443840_makinaci1');
define('DB_USER', 'u767443840_makinaci1');
define('DB_PASS', 'Emixhas.25');
define('DB_CHARSET', 'utf8mb4');

/** Hata ayıklama: canlı sitede false kalmalı. */
define('APP_DEBUG', false);

/** Uygulama kök dizini */
define('APP_ROOT', __DIR__);

/** Yüklenen görsellerin klasörü (site köküne göre) */
define('UPLOAD_DIR', 'uploads');
define('UPLOAD_MAX_BYTES', 6 * 1024 * 1024);

date_default_timezone_set('Europe/Istanbul');
mb_internal_encoding('UTF-8');
