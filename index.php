<?php
/*
 * TreeSheets Web - entry point: first-run setup, login, and the application shell.
 */
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';

send_security_headers(true);
session_start_secure();

$error = '';
$mode = is_setup_done() ? (is_logged_in() ? 'app' : 'login') : 'setup';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $token = (string)($_POST['csrf'] ?? '');
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $token)) {
        $error = 'Your session expired. Please try again.';
    } elseif ($mode === 'setup') {
        $pw = (string)($_POST['password'] ?? '');
        if ($err = validate_new_password($pw)) {
            $error = $err;
        } elseif ($pw !== (string)($_POST['confirm'] ?? '')) {
            $error = 'The passwords do not match.';
        } else {
            set_password($pw);
            log_in();
            require __DIR__ . '/lib/store.php';
            if (!(int)db()->query('SELECT COUNT(*) FROM documents')->fetchColumn()) {
                try {
                    import_example('tutorial.cts', 'Tutorial');
                } catch (Throwable $e) {
                    error_log('TreeSheets Web: could not import tutorial: ' . $e->getMessage());
                }
            }
            header('Location: ' . base_path() . '/');
            exit;
        }
    } elseif ($mode === 'login') {
        if (login_locked_out()) {
            $error = 'Too many failed attempts. Please wait a few minutes and try again.';
        } elseif (password_verify((string)($_POST['password'] ?? ''), (string)setting_get('password_hash'))) {
            log_in();
            header('Location: ' . base_path() . '/');
            exit;
        } else {
            record_failed_login();
            usleep(random_int(200000, 600000));
            $error = 'Incorrect password.';
        }
    }
}

$csrf = csrf_token();
header('Cache-Control: no-store');
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#2d5b8a">
<meta name="csrf-token" content="<?= h($csrf) ?>">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>TreeSheets</title>
<link rel="icon" href="assets/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/icons/icon-192.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="stylesheet" href="<?= asset_url('assets/app.css') ?>">
</head>
<?php if ($mode !== 'app'): ?>
<body class="auth-page">
<main class="auth-box">
  <div class="auth-logo"><img src="assets/icons/icon.svg" alt="" width="56" height="56"></div>
  <h1>TreeSheets</h1>
  <?php if ($mode === 'setup'): ?>
    <p class="auth-sub">Welcome! Choose a password to protect your personal TreeSheets instance.</p>
  <?php else: ?>
    <p class="auth-sub">Enter your password to open your sheets.</p>
  <?php endif; ?>
  <?php if ($error): ?><p class="auth-error" role="alert"><?= h($error) ?></p><?php endif; ?>
  <form method="post" autocomplete="on">
    <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
    <input type="text" name="username" value="treesheets" autocomplete="username" hidden>
    <label>Password
      <input type="password" name="password" required autofocus minlength="<?= $mode === 'setup' ? 8 : 1 ?>"
        autocomplete="<?= $mode === 'setup' ? 'new-password' : 'current-password' ?>">
    </label>
    <?php if ($mode === 'setup'): ?>
    <label>Confirm password
      <input type="password" name="confirm" required minlength="8" autocomplete="new-password">
    </label>
    <?php endif; ?>
    <button type="submit" class="btn primary"><?= $mode === 'setup' ? 'Create &amp; open' : 'Unlock' ?></button>
  </form>
  <p class="auth-foot">A web port of <a href="https://strlen.com/treesheets/" rel="noopener" target="_blank">TreeSheets</a>, the free-form hierarchical information organizer.</p>
</main>
</body>
<?php else: ?>
<body class="app">
<noscript><p class="auth-error">TreeSheets needs JavaScript enabled.</p></noscript>
<div id="app">
  <header id="topbar">
    <button class="icon-btn only-mobile" id="btn-menu" aria-label="Menu" data-cmd="menu"></button>
    <nav id="menubar" aria-label="Main menu"></nav>
    <div id="tabs" role="tablist" aria-label="Documents"></div>
    <div id="save-state" title="Save status"></div>
  </header>
  <div id="toolbar" role="toolbar" aria-label="Toolbar"></div>
  <div id="searchbar" hidden>
    <input type="search" id="search-input" placeholder="Search…" aria-label="Search" autocomplete="off">
    <span id="search-count"></span>
    <button class="icon-btn" data-cmd="searchprev" title="Previous match (Shift+F3)" aria-label="Previous match"></button>
    <button class="icon-btn" data-cmd="searchnext" title="Next match (F3)" aria-label="Next match"></button>
    <input type="text" id="replace-input" placeholder="Replace with…" aria-label="Replace with" autocomplete="off">
    <button class="btn small" data-cmd="replaceonce" title="Replace in selection (Ctrl+K)">Replace</button>
    <button class="btn small" data-cmd="replaceall">All</button>
    <label class="chk"><input type="checkbox" id="search-case"> Aa</label>
    <button class="icon-btn" data-cmd="searchclose" title="Close" aria-label="Close search"></button>
  </div>
  <div id="breadcrumb" aria-label="Zoom path"></div>
  <main id="viewport" tabindex="-1">
    <div id="sheet"><div id="docroot"></div><div id="selection-overlay" hidden aria-hidden="true"></div></div>
  </main>
  <footer id="statusbar"><span id="status-msg"></span><span id="status-info"></span></footer>
  <div id="mobilebar" role="toolbar" aria-label="Quick actions"></div>
</div>
<textarea id="keycatcher" aria-label="Sheet keyboard input" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
<div id="menu-popup" class="popup" hidden></div>
<div id="dialog-root"></div>
<input type="file" id="file-input" hidden>
<script type="module" src="<?= asset_url('assets/js/app.js') ?>"></script>
</body>
<?php endif; ?>
</html>
