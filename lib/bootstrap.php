<?php
/*
 * TreeSheets Web - shared bootstrap: configuration, database, sessions, auth, CSRF.
 *
 * A web port of TreeSheets by Wouter van Oortmerssen (https://strlen.com/treesheets/).
 */
declare(strict_types=1);

define('TSWEB', true);
const TSWEB_VERSION = '1.0.0';
const TSWEB_SCHEMA = 1;

error_reporting(E_ALL);
ini_set('display_errors', '0');

$GLOBALS['tsweb_config'] = array_merge([
    // Directory for the SQLite database. Ideally outside the web root.
    'data_dir' => dirname(__DIR__) . '/data',
    // Name of the session cookie.
    'session_name' => 'tsweb_session',
    // Idle time (seconds) after which a session expires. Default: 30 days ("remember me").
    'session_lifetime' => 60 * 60 * 24 * 30,
    // Maximum upload size for images / imports / restores in megabytes.
    'max_upload_mb' => 64,
    // Failed login attempts allowed per IP within the lockout window.
    'login_max_attempts' => 8,
    'login_window_seconds' => 15 * 60,
    // Set to true to force Secure cookies even if HTTPS isn't detected (e.g. behind a proxy).
    'force_secure_cookie' => false,
], is_file(dirname(__DIR__) . '/config.php') ? (array)require dirname(__DIR__) . '/config.php' : []);

function cfg(string $key)
{
    return $GLOBALS['tsweb_config'][$key] ?? null;
}

/* ---------------------------------------------------------------- database */

function db_path(): string
{
    $dir = rtrim((string)cfg('data_dir'), '/\\');
    if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
        fail_hard("Cannot create data directory: $dir");
    }
    if (!is_writable($dir)) {
        fail_hard("Data directory is not writable by the web server: $dir");
    }
    // The database gets an unguessable filename, as defense in depth in case the data
    // directory is (mis)configured to be reachable over HTTP.
    $existing = glob($dir . '/treesheets-*.sqlite') ?: [];
    if ($existing) {
        return $existing[0];
    }
    return $dir . '/treesheets-' . bin2hex(random_bytes(12)) . '.sqlite';
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) {
        return $pdo;
    }
    $path = db_path();
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    db_migrate($pdo);
    return $pdo;
}

function db_migrate(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS document_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL,
        saved INTEGER NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, saved)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data BLOB NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT NOT NULL,
        ts INTEGER NOT NULL
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, ts)');
    if (setting_get('schema', null, $pdo) === null) {
        setting_set('schema', (string)TSWEB_SCHEMA, $pdo);
        setting_set('created', (string)time(), $pdo);
    }
}

function setting_get(string $key, ?string $default = null, ?PDO $pdo = null): ?string
{
    $st = ($pdo ?? db())->prepare('SELECT value FROM settings WHERE key = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? $default : (string)$v;
}

function setting_set(string $key, string $value, ?PDO $pdo = null): void
{
    $st = ($pdo ?? db())->prepare('INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    $st->execute([$key, $value]);
}

/* ---------------------------------------------------------------- sessions & auth */

function is_https(): bool
{
    if (cfg('force_secure_cookie')) {
        return true;
    }
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    return ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function session_start_secure(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $lifetime = (int)cfg('session_lifetime');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', (string)$lifetime);
    // Keep sessions next to the database so they survive shared-host /tmp cleanups and
    // are not shared with other apps.
    $sessdir = rtrim((string)cfg('data_dir'), '/\\') . '/sessions';
    if (!is_dir($sessdir)) {
        @mkdir($sessdir, 0770, true);
    }
    if (is_dir($sessdir) && is_writable($sessdir)) {
        session_save_path($sessdir);
    }
    session_name((string)cfg('session_name'));
    session_set_cookie_params([
        'lifetime' => $lifetime,
        'path' => base_path() . '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
    if (!empty($_SESSION['uid']) && (time() - (int)($_SESSION['last_seen'] ?? 0)) > $lifetime) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    // Invalidate sessions created before the last password change.
    if (!empty($_SESSION['uid']) && (int)($_SESSION['auth_epoch'] ?? -1) !== (int)setting_get('auth_epoch', '0')) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    $_SESSION['last_seen'] = time();
}

function base_path(): string
{
    $dir = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
    return rtrim($dir, '/');
}

function is_setup_done(): bool
{
    return setting_get('password_hash') !== null;
}

function is_logged_in(): bool
{
    return !empty($_SESSION['uid']);
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function check_csrf(): void
{
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['csrf'] ?? '');
    if (!is_string($sent) || empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $sent)) {
        json_error('Invalid or missing security token. Reload the page and try again.', 403);
    }
}

function client_ip(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function login_locked_out(): bool
{
    $since = time() - (int)cfg('login_window_seconds');
    db()->prepare('DELETE FROM login_attempts WHERE ts < ?')->execute([$since]);
    $st = db()->prepare('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND ts >= ?');
    $st->execute([client_ip(), $since]);
    return (int)$st->fetchColumn() >= (int)cfg('login_max_attempts');
}

function record_failed_login(): void
{
    db()->prepare('INSERT INTO login_attempts(ip, ts) VALUES(?, ?)')->execute([client_ip(), time()]);
}

function log_in(): void
{
    session_regenerate_id(true);
    $_SESSION['uid'] = 1;
    $_SESSION['auth_epoch'] = (int)setting_get('auth_epoch', '0');
    $_SESSION['last_seen'] = time();
    unset($_SESSION['csrf']);
    db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([client_ip()]);
}

function set_password(string $password): void
{
    setting_set('password_hash', password_hash($password, PASSWORD_DEFAULT));
    setting_set('auth_epoch', (string)((int)setting_get('auth_epoch', '0') + 1));
}

function validate_new_password(string $pw): ?string
{
    if (strlen($pw) < 8) {
        return 'Password must be at least 8 characters long.';
    }
    if (strlen($pw) > 4096) {
        return 'Password is too long.';
    }
    return null;
}

/* ---------------------------------------------------------------- responses */

function send_security_headers(bool $html = false): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header('X-Frame-Options: DENY');
    if ($html) {
        header("Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    }
}

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function json_error(string $msg, int $status = 400, array $extra = []): void
{
    json_out(['ok' => false, 'error' => $msg] + $extra, $status);
}

function fail_hard(string $msg): void
{
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "TreeSheets Web configuration error:\n\n" . $msg . "\n";
    exit;
}

function h(?string $s): string
{
    return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function asset_url(string $path): string
{
    $file = dirname(__DIR__) . '/' . $path;
    $v = is_file($file) ? substr(md5((string)filemtime($file) . TSWEB_VERSION), 0, 8) : TSWEB_VERSION;
    return h($path . '?v=' . $v);
}
