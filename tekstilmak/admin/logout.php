<?php
require_once __DIR__ . '/includes/auth.php';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && csrf_check()) {
    admin_logout();
}
redirect(url('admin/login.php'));
