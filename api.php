<?php
/*
 * TreeSheets Web - JSON API.
 */
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/store.php';

send_security_headers();
session_start_secure();

$action = (string)($_GET['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

set_exception_handler(function (Throwable $e) {
    error_log('TreeSheets Web: ' . $e);
    json_error('Server error: ' . $e->getMessage(), 500);
});

/* Actions that don't need a login. */
switch ($action) {
    case 'status':
        json_out(['ok' => true, 'setup' => is_setup_done(), 'loggedIn' => is_logged_in(), 'version' => TSWEB_VERSION]);
}

if (!is_logged_in()) {
    json_error('Not logged in.', 401, ['loggedOut' => true]);
}

// Downloads are plain GET navigations (so the browser shows its download UI); everything else
// that changes state must be a POST with the CSRF token.
$get_actions = ['image', 'backup', 'export_cts', 'export_all'];
if (!in_array($action, $get_actions, true)) {
    require_post();
    check_csrf();
} else {
    // Protect downloads against cross-site requests too: the token travels in the URL.
    if (!isset($_GET['t']) || !is_string($_GET['t']) || !hash_equals(csrf_token(), $_GET['t'])) {
        if ($action !== 'image') {
            json_error('Invalid download link. Reload the page and try again.', 403);
        }
    }
}
// Release the session lock early; nothing below writes to the session (except logout).
if ($action !== 'logout' && $action !== 'change_password') {
    session_write_close();
}

switch ($action) {
    case 'logout':
        $_SESSION = [];
        session_regenerate_id(true);
        session_destroy();
        json_out(['ok' => true]);

    case 'change_password':
        $in = json_in();
        if (!password_verify((string)($in['current'] ?? ''), (string)setting_get('password_hash'))) {
            json_error('The current password is incorrect.', 403);
        }
        $pw = (string)($in['password'] ?? '');
        if ($err = validate_new_password($pw)) {
            json_error($err);
        }
        set_password($pw);
        log_in(); // keeps this session valid; all other sessions are logged out

        json_out(['ok' => true, 'csrf' => csrf_token()]);

    case 'list':
        $rows = db()->query('SELECT id, name, revision, created, updated, length(data) AS size
            FROM documents ORDER BY position, id')->fetchAll();
        json_out(['ok' => true, 'documents' => array_map('doc_meta', $rows), 'prefs' => prefs_get(),
            'zip' => class_exists('ZipArchive')]);

    case 'get':
        $doc = doc_row((int)(json_in()['id'] ?? 0));
        json_out(['ok' => true, 'document' => doc_meta($doc) + ['data' => json_decode($doc['data'], true)]]);

    case 'create':
        $in = json_in();
        $name = clean_name((string)($in['name'] ?? 'Untitled'));
        $data = isset($in['data']) ? validate_doc_json($in['data']) : new_doc_json((int)($in['size'] ?? 3));
        $id = doc_insert($name, $data);
        json_out(['ok' => true, 'document' => doc_meta(doc_row($id))]);

    case 'save':
        $in = json_in();
        $id = (int)($in['id'] ?? 0);
        $data = validate_doc_json($in['data'] ?? null);
        $base = (int)($in['revision'] ?? 0);
        $force = !empty($in['force']);
        $pdo = db();
        $pdo->beginTransaction();
        $row = doc_row($id);
        if (!$force && $base !== (int)$row['revision']) {
            $pdo->rollBack();
            json_error('This document was changed elsewhere (another tab or device).', 409,
                ['conflict' => true, 'revision' => (int)$row['revision']]);
        }
        $now = time();
        maybe_snapshot($row, $now);
        $rev = (int)$row['revision'] + 1;
        $pdo->prepare('UPDATE documents SET data = ?, revision = ?, updated = ? WHERE id = ?')
            ->execute([$data, $rev, $now, $id]);
        $pdo->commit();
        json_out(['ok' => true, 'revision' => $rev, 'updated' => $now]);

    case 'rename':
        $in = json_in();
        $row = doc_row((int)($in['id'] ?? 0));
        db()->prepare('UPDATE documents SET name = ? WHERE id = ?')
            ->execute([clean_name((string)($in['name'] ?? '')), $row['id']]);
        json_out(['ok' => true]);

    case 'delete':
        $row = doc_row((int)(json_in()['id'] ?? 0));
        db()->prepare('DELETE FROM documents WHERE id = ?')->execute([$row['id']]);
        purge_unused_images();
        json_out(['ok' => true]);

    case 'duplicate':
        $row = doc_row((int)(json_in()['id'] ?? 0));
        $id = doc_insert(clean_name($row['name'] . ' (copy)'), $row['data']);
        json_out(['ok' => true, 'document' => doc_meta(doc_row($id))]);

    case 'reorder':
        $ids = json_in()['ids'] ?? [];
        $st = db()->prepare('UPDATE documents SET position = ? WHERE id = ?');
        foreach (array_values((array)$ids) as $i => $id) {
            $st->execute([$i, (int)$id]);
        }
        json_out(['ok' => true]);

    case 'versions':
        $row = doc_row((int)(json_in()['id'] ?? 0));
        $st = db()->prepare('SELECT id, revision, saved, length(data) AS size FROM document_versions
            WHERE document_id = ? ORDER BY saved DESC');
        $st->execute([$row['id']]);
        json_out(['ok' => true, 'versions' => $st->fetchAll()]);

    case 'version':
        $in = json_in();
        $st = db()->prepare('SELECT data FROM document_versions WHERE id = ? AND document_id = ?');
        $st->execute([(int)($in['version'] ?? 0), (int)($in['id'] ?? 0)]);
        $data = $st->fetchColumn();
        if ($data === false) {
            json_error('Version not found.', 404);
        }
        json_out(['ok' => true, 'data' => json_decode((string)$data, true)]);

    case 'prefs':
        $prefs = json_in()['prefs'] ?? [];
        if (!is_array($prefs)) {
            json_error('Invalid preferences.');
        }
        $json = json_encode($prefs);
        if (strlen($json) > 65536) {
            json_error('Preferences too large.');
        }
        setting_set('prefs', $json);
        json_out(['ok' => true]);

    case 'upload_image':
        $data = uploaded_file('file');
        $info = @getimagesizefromstring($data);
        $allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (!$info || !in_array($info['mime'], $allowed, true)) {
            json_error('Unsupported image type. Use PNG, JPEG, GIF or WebP.');
        }
        $id = store_image($data, $info['mime']);
        json_out(['ok' => true, 'id' => $id, 'width' => $info[0], 'height' => $info[1]]);

    case 'image':
        $id = (string)($_GET['id'] ?? '');
        if (!preg_match('/^[a-f0-9]{40}$/', $id)) {
            http_response_code(404);
            exit;
        }
        $st = db()->prepare('SELECT mime, data FROM images WHERE id = ?');
        $st->execute([$id]);
        $img = $st->fetch();
        if (!$img) {
            http_response_code(404);
            exit;
        }
        header('Content-Type: ' . $img['mime']);
        header('Cache-Control: private, max-age=31536000, immutable');
        header('Content-Length: ' . strlen($img['data']));
        echo $img['data'];
        exit;

    case 'image_info':
        $ids = array_filter((array)(json_in()['ids'] ?? []), fn($i) => is_string($i) && preg_match('/^[a-f0-9]{40}$/', $i));
        $out = [];
        if ($ids) {
            $in = implode(',', array_fill(0, count($ids), '?'));
            $st = db()->prepare("SELECT id, mime, width, height, length(data) AS size FROM images WHERE id IN ($in)");
            $st->execute(array_values($ids));
            foreach ($st->fetchAll() as $r) {
                $out[$r['id']] = $r;
            }
        }
        json_out(['ok' => true, 'images' => $out]);

    case 'import_cts':
        $data = uploaded_file('file');
        $name = clean_name(preg_replace('/\.cts$/i', '', (string)($_FILES['file']['name'] ?? 'Imported')));
        $doc = cts_import($data, 'store_image');
        $id = doc_insert($name, json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        json_out(['ok' => true, 'document' => doc_meta(doc_row($id))]);

    case 'import_example':
        $which = (string)(json_in()['name'] ?? '');
        $map = ['tutorial' => ['tutorial.cts', 'Tutorial'], 'opref' => ['operation-reference.cts', 'Operation reference']];
        if (!isset($map[$which])) {
            json_error('Unknown example.');
        }
        $id = import_example(...$map[$which]);
        json_out(['ok' => true, 'document' => doc_meta(doc_row($id))]);

    case 'export_cts':
        $row = doc_row((int)($_GET['id'] ?? 0));
        $bytes = cts_export(json_decode($row['data'], true), 'load_image');
        send_download($bytes, safe_filename($row['name']) . '.cts', 'application/octet-stream');

    case 'export_all':
        if (!class_exists('ZipArchive')) {
            json_error('The PHP zip extension is not installed on this server.', 500);
        }
        $tmp = tempnam(sys_get_temp_dir(), 'tsz');
        $zip = new ZipArchive();
        $zip->open($tmp, ZipArchive::OVERWRITE);
        $used = [];
        foreach (db()->query('SELECT id, name, data FROM documents ORDER BY position, id') as $row) {
            $base = safe_filename($row['name']);
            $fn = $base;
            for ($i = 2; isset($used[strtolower($fn)]); $i++) {
                $fn = "$base ($i)";
            }
            $used[strtolower($fn)] = true;
            $zip->addFromString("$fn.cts", cts_export(json_decode($row['data'], true), 'load_image'));
        }
        $zip->close();
        $bytes = (string)file_get_contents($tmp);
        @unlink($tmp);
        send_download($bytes, 'treesheets-' . date('Ymd-His') . '.zip', 'application/zip');

    case 'backup':
        $tmp = rtrim((string)cfg('data_dir'), '/\\') . '/backup-' . bin2hex(random_bytes(8)) . '.sqlite';
        db()->exec('PRAGMA wal_checkpoint(FULL)');
        $st = db()->prepare('VACUUM INTO ?');
        $st->execute([$tmp]);
        $bytes = (string)file_get_contents($tmp);
        @unlink($tmp);
        send_download($bytes, 'treesheets-backup-' . date('Ymd-His') . '.sqlite', 'application/vnd.sqlite3');

    case 'restore':
        $data = uploaded_file('file');
        if (strncmp($data, "SQLite format 3\0", 16) !== 0) {
            json_error('That is not a TreeSheets Web backup file (.sqlite).');
        }
        $tmp = rtrim((string)cfg('data_dir'), '/\\') . '/restore-' . bin2hex(random_bytes(8)) . '.sqlite';
        file_put_contents($tmp, $data);
        try {
            $src = new PDO('sqlite:' . $tmp, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $tables = $src->query("SELECT name FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN);
            if (!in_array('documents', $tables, true) || !in_array('images', $tables, true)) {
                json_error('That backup does not contain TreeSheets Web documents.');
            }
            $src = null;
            $pdo = db();
            $pdo->exec('ATTACH DATABASE ' . $pdo->quote($tmp) . ' AS src');
            $pdo->beginTransaction();
            $pdo->exec('DELETE FROM document_versions');
            $pdo->exec('DELETE FROM documents');
            $pdo->exec('DELETE FROM images');
            $pdo->exec('INSERT INTO documents(id, name, data, revision, position, created, updated)
                SELECT id, name, data, revision + 1, position, created, updated FROM src.documents');
            $pdo->exec('INSERT INTO images(id, mime, data, width, height, created)
                SELECT id, mime, data, width, height, created FROM src.images');
            if (in_array('document_versions', $tables, true)) {
                $pdo->exec('INSERT INTO document_versions(document_id, revision, data, saved)
                    SELECT document_id, revision, data, saved FROM src.document_versions
                    WHERE document_id IN (SELECT id FROM documents)');
            }
            $pdo->commit();
            $pdo->exec('DETACH DATABASE src');
        } finally {
            @unlink($tmp);
        }
        json_out(['ok' => true]);
}

json_error('Unknown action.', 404);

/* ---------------------------------------------------------------- helpers */

function require_post(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        json_error('POST required.', 405);
    }
}

function json_in(): array
{
    static $in = null;
    if ($in !== null) {
        return $in;
    }
    if (!empty($_POST)) {
        return $in = $_POST;
    }
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return $in = [];
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        json_error('Invalid JSON request body.');
    }
    return $in = $d;
}

function max_bytes(): int
{
    return (int)cfg('max_upload_mb') * 1024 * 1024;
}

function uploaded_file(string $field): string
{
    $f = $_FILES[$field] ?? null;
    if (!$f || !is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        $code = is_array($f) ? (int)($f['error'] ?? 4) : 4;
        $msg = [UPLOAD_ERR_INI_SIZE => 'File exceeds the server upload limit (upload_max_filesize).',
            UPLOAD_ERR_FORM_SIZE => 'File is too large.', UPLOAD_ERR_NO_FILE => 'No file was uploaded.'][$code] ?? 'Upload failed.';
        json_error($msg);
    }
    if ((int)$f['size'] > max_bytes()) {
        json_error('File is too large.');
    }
    return (string)file_get_contents($f['tmp_name']);
}

function doc_meta(array $row): array
{
    return [
        'id' => (int)$row['id'],
        'name' => $row['name'],
        'revision' => (int)$row['revision'],
        'created' => (int)$row['created'],
        'updated' => (int)$row['updated'],
        'size' => isset($row['size']) ? (int)$row['size'] : strlen($row['data'] ?? ''),
    ];
}

function doc_row(int $id): array
{
    $st = db()->prepare('SELECT * FROM documents WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) {
        json_error('Document not found.', 404);
    }
    return $row;
}


function clean_name(string $name): string
{
    $name = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $name) ?? '');
    if ($name === '') {
        $name = 'Untitled';
    }
    return mb_substr($name, 0, 200);
}

function safe_filename(string $name): string
{
    $n = trim(preg_replace('/[\\\\\/:*?"<>|\x00-\x1F]+/u', '_', $name) ?? '');
    return $n === '' ? 'document' : mb_substr($n, 0, 100);
}

function validate_doc_json($data): string
{
    if (is_string($data)) {
        $decoded = json_decode($data, true);
    } else {
        $decoded = $data;
    }
    if (!is_array($decoded) || !isset($decoded['root']) || !is_array($decoded['root'])) {
        json_error('Invalid document data.');
    }
    $json = is_string($data) ? $data : json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (strlen($json) > max_bytes()) {
        json_error('Document is too large.');
    }
    return $json;
}

function new_doc_json(int $size): string
{
    $size = max(1, min(25, $size));
    $cells = array_fill(0, $size * $size, new stdClass());
    $doc = ['v' => 1, 'root' => ['g' => ['xs' => $size, 'ys' => $size, 'cw' => array_fill(0, $size, 80), 'c' => $cells]], 'tags' => new stdClass()];
    return json_encode($doc);
}

function maybe_snapshot(array $row, int $now): void
{
    // Keep a history of older versions: at most one snapshot per 10 minutes, 50 per document.
    $st = db()->prepare('SELECT MAX(saved) FROM document_versions WHERE document_id = ?');
    $st->execute([$row['id']]);
    $last = (int)$st->fetchColumn();
    if ($now - $last < 600) {
        return;
    }
    db()->prepare('INSERT INTO document_versions(document_id, revision, data, saved) VALUES(?, ?, ?, ?)')
        ->execute([$row['id'], $row['revision'], $row['data'], (int)$row['updated']]);
    db()->prepare('DELETE FROM document_versions WHERE document_id = ? AND id NOT IN
        (SELECT id FROM document_versions WHERE document_id = ? ORDER BY saved DESC LIMIT 50)')
        ->execute([$row['id'], $row['id']]);
}

function prefs_get(): array
{
    $p = json_decode((string)setting_get('prefs', '{}'), true);
    return is_array($p) ? $p : [];
}



function purge_unused_images(): void
{
    // Images are shared between documents (and old versions); drop the ones nothing uses.
    $used = [];
    $scan = function (string $json) use (&$used) {
        if (preg_match_all('/"im":"([a-f0-9]{40})"/', $json, $m)) {
            foreach ($m[1] as $id) {
                $used[$id] = true;
            }
        }
    };
    foreach (db()->query('SELECT data FROM documents') as $r) {
        $scan($r['data']);
    }
    foreach (db()->query('SELECT data FROM document_versions') as $r) {
        $scan($r['data']);
    }
    $del = db()->prepare('DELETE FROM images WHERE id = ?');
    foreach (db()->query('SELECT id, created FROM images')->fetchAll() as $r) {
        // Leave recently uploaded images alone: they may belong to unsaved edits.
        if (!isset($used[$r['id']]) && (int)$r['created'] < time() - 86400) {
            $del->execute([$r['id']]);
        }
    }
}


function send_download(string $bytes, string $filename, string $mime): void
{
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . strlen($bytes));
    header('Cache-Control: no-store');
    $ascii = preg_replace('/[^A-Za-z0-9._ ()-]/', '_', $filename);
    header('Content-Disposition: attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($filename));
    echo $bytes;
    exit;
}
