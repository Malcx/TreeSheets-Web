<?php
/*
 * TreeSheets Web - storage helpers shared by the entry point and the API.
 */
declare(strict_types=1);
defined('TSWEB') or exit;

require_once __DIR__ . '/cts.php';

function doc_insert(string $name, string $data): int
{
    $now = time();
    $pos = (int)db()->query('SELECT COALESCE(MAX(position), 0) + 1 FROM documents')->fetchColumn();
    db()->prepare('INSERT INTO documents(name, data, revision, position, created, updated) VALUES(?, ?, 1, ?, ?, ?)')
        ->execute([$name, $data, $pos, $now, $now]);
    return (int)db()->lastInsertId();
}

function store_image(string $data, string $mime): string
{
    $id = sha1($data);
    $w = $h = 0;
    if ($info = @getimagesizefromstring($data)) {
        [$w, $h] = $info;
    }
    db()->prepare('INSERT OR IGNORE INTO images(id, mime, data, width, height, created) VALUES(?, ?, ?, ?, ?, ?)')
        ->execute([$id, $mime, $data, $w, $h, time()]);
    return $id;
}

function load_image(string $id): ?array
{
    $st = db()->prepare('SELECT mime, data FROM images WHERE id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    return $r ? ['mime' => $r['mime'], 'data' => $r['data']] : null;
}

function import_example(string $file, string $name): int
{
    $doc = cts_import((string)file_get_contents(dirname(__DIR__) . '/examples/' . $file), 'store_image');
    return doc_insert($name, json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}
