<?php
/*
 * Reader / writer for native TreeSheets .cts files (format versions up to 28), so documents
 * can move freely between the desktop TreeSheets application and TreeSheets Web.
 *
 * Colors in .cts files are stored as wxWidgets BGR values (0x00BBGGRR); TreeSheets Web stores
 * plain RGB (0xRRGGBB). Text run positions are code points in .cts, UTF-16 units in TreeSheets
 * Web (which is what JavaScript strings use).
 */
declare(strict_types=1);
defined('TSWEB') or exit;

const CTS_WRITE_VERSION = 28;
const CTS_MAX_CELLS = 4 * 1024 * 1024;

final class CtsReader
{
    private string $b;
    private int $p = 0;
    public int $version = 0;
    public int $cells = 0;

    public function __construct(string $bytes)
    {
        $this->b = $bytes;
    }

    private function need(int $n): void
    {
        if ($this->p + $n > strlen($this->b)) {
            throw new RuntimeException('File is truncated or corrupted.');
        }
    }

    public function u8(): int
    {
        $this->need(1);
        return ord($this->b[$this->p++]);
    }

    public function u32(): int
    {
        $this->need(4);
        $v = unpack('V', $this->b, $this->p)[1];
        $this->p += 4;
        return $v;
    }

    public function i32(): int
    {
        $v = $this->u32();
        return $v >= 0x80000000 ? $v - 0x100000000 : $v;
    }

    public function u64(): int
    {
        $this->need(8);
        $v = unpack('P', $this->b, $this->p)[1];
        $this->p += 8;
        return (int)$v;
    }

    public function bytes(int $n): string
    {
        $this->need($n);
        $s = substr($this->b, $this->p, $n);
        $this->p += $n;
        return $s;
    }

    public function str(): string
    {
        $len = $this->u32();
        if ($len === 0) {
            return '';
        }
        $s = $this->bytes($len);
        if (!mb_check_encoding($s, 'UTF-8')) {
            $s = mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1');
        }
        return $s;
    }

    /* 80 bit IEEE extended precision, big endian, as wxDataOutputStream::WriteDouble writes. */
    public function extended(): float
    {
        $raw = $this->bytes(10);
        $exp = ((ord($raw[0]) & 0x7F) << 8) | ord($raw[1]);
        $neg = (ord($raw[0]) & 0x80) !== 0;
        $hi = unpack('N', $raw, 2)[1];
        $lo = unpack('N', $raw, 6)[1];
        if ($exp === 0 && $hi === 0 && $lo === 0) {
            return 0.0;
        }
        $f = ($hi * 4294967296.0 + $lo) * pow(2.0, $exp - 16383 - 63);
        return $neg ? -$f : $f;
    }

    public function pos(): int
    {
        return $this->p;
    }

    public function rest(): string
    {
        return substr($this->b, $this->p);
    }
}

function cts_bgr_rgb(int $c): int
{
    return (($c & 0xFF) << 16) | ($c & 0xFF00) | (($c >> 16) & 0xFF);
}

/* Maps code point offsets to UTF-16 unit offsets for a string. */
function cts_cp_to_units(string $text): array
{
    $map = [0];
    $u = 0;
    foreach (mb_str_split($text, 1, 'UTF-8') as $ch) {
        $u += mb_ord($ch, 'UTF-8') > 0xFFFF ? 2 : 1;
        $map[] = $u;
    }
    return $map;
}

/**
 * Parses a .cts file. $store_image(string $data, string $mime): string returns an image id.
 * Returns the TreeSheets Web document array.
 */
function cts_import(string $bytes, callable $store_image): array
{
    $r = new CtsReader($bytes);
    if ($r->bytes(4) !== 'TSFF') {
        throw new RuntimeException('Not a TreeSheets file.');
    }
    $r->version = $r->u8();
    if ($r->version > CTS_WRITE_VERSION) {
        throw new RuntimeException('This file was written by a newer TreeSheets version (' . $r->version . ').');
    }
    if ($r->version >= 21) {
        $r->u8();
        $r->u8();
    }
    if ($r->version >= 23) {
        $r->u8();
    }
    $images = [];
    for (;;) {
        $t = chr($r->u8());
        if ($t === 'I' || $t === 'J') {
            if ($r->version < 9) {
                $r->str();
            }
            $scale = $r->version >= 19 ? $r->extended() : 1.0;
            if ($r->version >= 22) {
                $len = $r->u64();
                if ($len < 0 || $len > strlen($bytes)) {
                    throw new RuntimeException('File corrupted (image size).');
                }
                $data = $r->bytes($len);
            } else {
                $data = cts_read_legacy_image($r, $t);
            }
            $mime = $t === 'J' ? 'image/jpeg' : 'image/png';
            $id = $data !== '' ? $store_image($data, $mime) : null;
            $images[] = ['id' => $id, 'scale' => ($scale > 0 && is_finite($scale)) ? $scale : 1.0];
        } elseif ($t === 'D') {
            break;
        } else {
            throw new RuntimeException('File corrupted (unknown block).');
        }
    }
    $z = @zlib_decode($r->rest());
    if ($z === false) {
        throw new RuntimeException('Cannot decompress file.');
    }
    $zr = new CtsReader($z);
    $zr->version = $r->version;
    $root = cts_read_cell($zr, $images, null);
    $tags = [];
    if ($r->version >= 20) {
        try {
            for (;;) {
                $tag = $zr->str();
                if ($tag === '') {
                    break;
                }
                $cc = 0xFFFFFF;
                $tc = 0xFF0000;
                if ($r->version >= 24) {
                    $cc = cts_bgr_rgb($zr->u32() & 0xFFFFFF);
                    $tc = cts_bgr_rgb($zr->u32() & 0xFFFFFF);
                }
                $tags[$tag] = [$cc, $tc];
            }
        } catch (RuntimeException $e) {
            // Missing tag list: fine.
        }
    }
    return ['v' => 1, 'root' => $root, 'tags' => (object)$tags];
}

function cts_read_legacy_image(CtsReader $r, string $t): string
{
    if ($t !== 'I') {
        throw new RuntimeException('JPEG images in TreeSheets files older than version 22 are not supported.');
    }
    $start = $r->pos();
    $hdr = $r->bytes(8);
    if ($hdr !== "\x89PNG\r\n\x1A\n") {
        throw new RuntimeException('Corrupt PNG header.');
    }
    $out = $hdr;
    for (;;) {
        $lenb = $r->bytes(4);
        $len = unpack('N', $lenb)[1];
        $fourcc = $r->bytes(4);
        $out .= $lenb . $fourcc . $r->bytes($len) . $r->bytes(4);
        if ($fourcc === 'IEND') {
            break;
        }
    }
    return $out;
}

function cts_read_cell(CtsReader $r, array $images, ?array $parent): array
{
    if (++$r->cells > CTS_MAX_CELLS) {
        throw new RuntimeException('Too many cells.');
    }
    $v = $r->version;
    $c = [];
    $ct = $r->u8();
    if ($ct) {
        $c['ct'] = $ct;
    }
    if ($v >= 8) {
        $cc = cts_bgr_rgb($r->u32() & 0xFFFFFF);
        $tc = cts_bgr_rgb($r->u32() & 0xFFFFFF);
        if ($cc !== 0xFFFFFF) {
            $c['cc'] = $cc;
        }
        if ($tc !== 0) {
            $c['tc'] = $tc;
        }
    }
    if ($v >= 15) {
        $ds = $r->u8();
        if ($ds) {
            $c['ds'] = $ds;
        }
    }
    if ($v >= 25) {
        $note = $r->str();
        if ($note !== '') {
            $c['n'] = $note;
        }
    }
    if ($v >= 28) {
        $al = $r->u8();
        if ($al > 0 && $al <= 3) {
            $c['al'] = $al;
        }
    }
    $ts = $r->u8() & 0x7F;
    if ($ts === 0 || $ts === 2) {
        $text = $r->str();
        if ($v <= 11) {
            $r->u32();
        }
        $rel = $r->i32();
        $img = $r->i32();
        $sb = $v >= 7 ? $r->u32() : 0;
        $le = $v >= 14 ? $r->u64() : 0;
        if ($text !== '') {
            $c['t'] = $text;
        }
        if ($rel) {
            $c['r'] = $rel;
        }
        if ($sb) {
            $c['s'] = $sb & 31;
        }
        if ($le > 0) {
            $c['le'] = $le;
        }
        if ($img >= 0 && isset($images[$img]) && $images[$img]['id']) {
            $c['im'] = $images[$img]['id'];
            if (abs($images[$img]['scale'] - 1.0) > 1e-9) {
                $c['isc'] = $images[$img]['scale'];
            }
        }
        if ($v >= 27) {
            $n = $r->u32();
            $runs = [];
            $map = null;
            $pos = 0;
            for ($i = 0; $i < $n; $i++) {
                $start = $r->u32();
                $len = $r->u32();
                $style = $r->u32();
                $col = $r->u32();
                $map ??= cts_cp_to_units($text);
                $ncp = count($map) - 1;
                $start = max($start, $pos);
                $len = min($len, $ncp - $start);
                if ($len > 0) {
                    $pos = $start + $len;
                    $us = $map[$start];
                    $ul = $map[$pos] - $us;
                    $runs[] = [$us, $ul, $style & 31, ($col & 0x1000000) ? cts_bgr_rgb($col & 0xFFFFFF) : -1];
                }
            }
            if ($runs) {
                $c['ru'] = $runs;
            }
        }
    }
    if ($ts === 1 || $ts === 2) {
        $xs = $r->u32();
        $ys = $r->u32();
        if ($xs < 1 || $ys < 1 || $xs * $ys > CTS_MAX_CELLS) {
            throw new RuntimeException('File corrupted (grid size).');
        }
        $g = ['xs' => $xs, 'ys' => $ys];
        if ($v >= 10) {
            $bc = cts_bgr_rgb($r->u32() & 0xFFFFFF);
            if ($bc !== 0xA0A0A0) {
                $g['bc'] = $bc;
            }
            $sp = max(0, min(32, $r->i32()));
            if ($sp !== 3) {
                $g['sp'] = $sp;
            }
            if ($v >= 11) {
                if ($r->u8() === 0) {
                    $c['hv'] = 0;
                }
                if ($v >= 13) {
                    if ($v >= 16) {
                        if ($r->u8()) {
                            $g['f'] = 1;
                        }
                    }
                    $cw = [];
                    for ($x = 0; $x < $xs; $x++) {
                        $cw[] = max(5, min(10000, $r->i32()));
                    }
                    $g['cw'] = $cw;
                }
            }
        }
        $cells = [];
        for ($i = 0; $i < $xs * $ys; $i++) {
            $cells[] = cts_read_cell($r, $images, $c);
        }
        $g['c'] = $cells;
        $c['g'] = $g;
    } elseif ($ts !== 0 && $ts !== 3) {
        throw new RuntimeException('File corrupted (cell contents).');
    }
    return $c;
}

/* ---------------------------------------------------------------- writer */

final class CtsWriter
{
    public string $b = '';

    public function u8(int $v): void
    {
        $this->b .= chr($v & 0xFF);
    }

    public function u32(int $v): void
    {
        $this->b .= pack('V', $v & 0xFFFFFFFF);
    }

    public function u64(int $v): void
    {
        $this->b .= pack('P', $v);
    }

    public function str(string $s): void
    {
        $this->u32(strlen($s));
        $this->b .= $s;
    }

    public function extended(float $f): void
    {
        if ($f == 0.0) {
            $this->b .= str_repeat("\0", 10);
            return;
        }
        $sign = $f < 0 ? 0x8000 : 0;
        $f = abs($f);
        $e = (int)floor(log($f, 2));
        $m = $f / pow(2.0, $e); // 1 <= m < 2
        if ($m >= 2.0) {
            $m /= 2;
            $e++;
        }
        $mant = $m * pow(2.0, 31);
        $hi = (int)floor($mant);
        $lo = (int)floor(($mant - $hi) * 4294967296.0);
        $this->b .= pack('n', $sign | ($e + 16383)) . pack('N', $hi) . pack('N', $lo);
    }
}

function cts_rgb_bgr(int $c): int
{
    return cts_bgr_rgb($c);
}

/* Maps UTF-16 unit offsets to code point offsets. */
function cts_units_to_cp(string $text): array
{
    $map = [0 => 0];
    $u = 0;
    $cp = 0;
    foreach (mb_str_split($text, 1, 'UTF-8') as $ch) {
        $u += mb_ord($ch, 'UTF-8') > 0xFFFF ? 2 : 1;
        $cp++;
        $map[$u] = $cp;
    }
    return $map;
}

/**
 * Writes a TreeSheets Web document as a .cts file.
 * $load_image(string $id): ?array returns ['data' => bytes, 'mime' => string] or null.
 */
function cts_export(array $doc, callable $load_image): string
{
    // Collect images (unique by id + scale, as in TreeSheets).
    $imglist = [];
    $imgindex = [];
    $collect = function (array $c) use (&$collect, &$imglist, &$imgindex, $load_image) {
        if (!empty($c['im'])) {
            $scale = (float)($c['isc'] ?? 1.0);
            $key = $c['im'] . '@' . $scale;
            if (!isset($imgindex[$key])) {
                $img = $load_image((string)$c['im']);
                if ($img) {
                    $imgindex[$key] = count($imglist);
                    $imglist[] = ['scale' => $scale] + $img;
                } else {
                    $imgindex[$key] = -1;
                }
            }
        }
        foreach ($c['g']['c'] ?? [] as $ch) {
            $collect($ch);
        }
    };
    $root = $doc['root'] ?? [];
    $collect($root);

    $w = new CtsWriter();
    $w->b = 'TSFF';
    $w->u8(CTS_WRITE_VERSION);
    $w->u8(1);
    $w->u8(1);
    $w->u8(0);
    foreach ($imglist as $img) {
        $data = $img['data'];
        $type = 'I';
        if ($img['mime'] === 'image/jpeg') {
            $type = 'J';
        } elseif ($img['mime'] !== 'image/png') {
            // TreeSheets only knows PNG and JPEG: convert others when GD is available.
            $conv = function_exists('imagecreatefromstring') ? @imagecreatefromstring($data) : false;
            if ($conv) {
                ob_start();
                imagepng($conv);
                $data = (string)ob_get_clean();
            }
        }
        $w->b .= $type;
        $w->extended($img['scale']);
        $w->u64(strlen($data));
        $w->b .= $data;
    }
    $w->b .= 'D';
    $z = new CtsWriter();
    cts_write_cell($z, $root, $imgindex);
    foreach ((array)($doc['tags'] ?? []) as $tag => $cols) {
        if ($tag === '' || $tag === null) {
            continue;
        }
        $z->str((string)$tag);
        $z->u32(cts_rgb_bgr((int)($cols[0] ?? 0xFFFFFF)));
        $z->u32(cts_rgb_bgr((int)($cols[1] ?? 0xFF0000)));
    }
    $z->str('');
    $w->b .= zlib_encode($z->b, ZLIB_ENCODING_DEFLATE, 9);
    return $w->b;
}

function cts_write_cell(CtsWriter $w, array $c, array $imgindex): void
{
    $w->u8((int)($c['ct'] ?? 0));
    $w->u32(cts_rgb_bgr((int)($c['cc'] ?? 0xFFFFFF)));
    $w->u32(cts_rgb_bgr((int)($c['tc'] ?? 0)));
    $w->u8((int)($c['ds'] ?? 0));
    $w->str((string)($c['n'] ?? ''));
    $w->u8((int)($c['al'] ?? 0));
    $text = (string)($c['t'] ?? '');
    $img = -1;
    if (!empty($c['im'])) {
        $img = $imgindex[$c['im'] . '@' . (float)($c['isc'] ?? 1.0)] ?? -1;
    }
    $rel = (int)($c['r'] ?? 0);
    $hastext = $text !== '' || $rel !== 0 || $img >= 0;
    $g = $c['g'] ?? null;
    $w->u8($hastext ? ($g ? 2 : 0) : ($g ? 1 : 3));
    if ($hastext) {
        $w->str($text);
        $w->u32($rel);
        $w->u32($img);
        $w->u32((int)($c['s'] ?? 0));
        $w->u64((int)($c['le'] ?? 0));
        $runs = $c['ru'] ?? [];
        $map = $runs ? cts_units_to_cp($text) : [];
        $out = [];
        foreach ($runs as $run) {
            $s = $map[$run[0]] ?? null;
            $e = $map[$run[0] + $run[1]] ?? null;
            if ($s === null || $e === null || $e <= $s) {
                continue;
            }
            $col = (int)$run[3] >= 0 ? (cts_rgb_bgr((int)$run[3]) | 0x1000000) : 0;
            $out[] = [$s, $e - $s, (int)$run[2], $col];
        }
        $w->u32(count($out));
        foreach ($out as $o) {
            $w->u32($o[0]);
            $w->u32($o[1]);
            $w->u32($o[2]);
            $w->u32($o[3]);
        }
    }
    if ($g) {
        $xs = (int)$g['xs'];
        $ys = (int)$g['ys'];
        $w->u32($xs);
        $w->u32($ys);
        $w->u32(cts_rgb_bgr((int)($g['bc'] ?? 0xA0A0A0)));
        $w->u32((int)($g['sp'] ?? 3));
        $w->u8(isset($c['hv']) && !$c['hv'] ? 0 : 1);
        $w->u8(!empty($g['f']) ? 1 : 0);
        for ($x = 0; $x < $xs; $x++) {
            $w->u32((int)($g['cw'][$x] ?? 80));
        }
        for ($i = 0; $i < $xs * $ys; $i++) {
            cts_write_cell($w, $g['c'][$i] ?? [], $imgindex);
        }
    }
}
