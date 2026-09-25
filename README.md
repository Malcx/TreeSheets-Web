# TreeSheets Web

A self-hosted, password-protected web version of [TreeSheets](https://strlen.com/treesheets/) —
the free-form hierarchical information organizer (a mix of spreadsheet, mind map, outliner and
notes) by Wouter van Oortmerssen. Built with **PHP + SQLite** and plain JavaScript (no build
step), and it works on desktop and mobile.

## Features

**The TreeSheets feature set, ported from the original C++ source:**

- Grids in grids: cells hold text, an image, a note and/or a sub-grid, nested as deep as you like.
  The layout sizes itself to the content automatically.
- Grid-line selection: click a line between cells, or move onto one with the cursor keys, and
  start typing to insert a row or column. Backspace/Delete on a line removes the row or column
  before/after it.
- Selecting across hierarchy levels, moving cells (Ctrl+arrows), extending selections, Tab
  navigation, "go to matching cell" (F6/F7).
- Relative text sizes (Shift+wheel), column widths (Alt+wheel), zoom into any sub-grid
  (Ctrl+wheel, or the breadcrumb to go back up), folding, wrap in new parent, collapse cells.
- Styles: bold, italic, typewriter, underline, strikethrough, rich text on part of a cell (select
  text while editing), alignment, cell/text/border colors with the TreeSheets palette, borders,
  grid/bubble/line rendering, vertical/horizontal layout, roundness.
- Tags, notes, images (paste, drag & drop, upload; resample, display scale, JPEG/PNG conversion).
- Reorganize: transpose, sort, hierarchy swap (F8), hierarchify, flatten.
- Search, replace, and filters (search results, recent edits by %, date range, same color, same
  style, same text, cells with notes).
- Unlimited undo/redo.
- The TreeSheets mini programming language (Data / Operation / Variable / View cells, Run).
- Import: TreeSheets `.cts` files, XML, OPML, indented text, CSV (comma/semicolon/tab), JSON.
- Export: `.cts` (open it in desktop TreeSheets), XML, HTML (tables / tables with images /
  bullet points / outline), indented text, CSV, JSON, PNG and SVG images, printing.
- Copy & paste to and from other applications as indented text / HTML tables.
- Multiple sheets in tabs; configurable fonts, default column width, cursor color, and key bindings.
- The interactive TreeSheets tutorial (F1) and operation reference are included.

**Added for the web:**

- **Password-protected login.** You choose the password on first visit. It's stored as a
  bcrypt/argon hash; failed logins are rate limited; there's CSRF protection and strict cookies.
- **One-click backup.** The download button in the toolbar (also under *File*, and in
  *Open / manage sheets*) downloads the whole SQLite database: every sheet, image and version.
  *Restore from backup…* loads one back. You can also download every sheet as `.cts` files in
  a zip.
- **Autosave** to the server, **version history** (snapshots kept every 10 minutes, 50 per sheet),
  conflict detection when a sheet is edited on two devices, and offline drafts kept in the browser.
- **Mobile friendly.** Tap to select, tap again to edit, long-press for the cell menu, a
  bottom action bar (edit, sub-grid, add row/column, delete, undo, zoom, multi-select), and
  menus that slide up from the bottom. It can be installed as a home-screen app (PWA manifest).
- Light/dark interface, plus an optional dark sheet.

## Requirements

- PHP 8.1+ with `pdo_sqlite` (SQLite ≥ 3.27). `zip` (for the zip export) and `gd` (only for
  converting exotic image formats when exporting `.cts`) are optional.
- Any web server that runs PHP (Apache, nginx + PHP-FPM, Caddy, shared hosting…).
- HTTPS is strongly recommended. The browser clipboard API also needs it.

## Installation

1. Copy the files to a directory on your web server, e.g. `/var/www/treesheets`.
2. Make sure the web server user can write to `data/`:
   `chown www-data data && chmod 770 data`
   (or set `data_dir` in `config.php` to a directory **outside** the web root, which is best).
3. Open the site in your browser and choose a password. The tutorial is loaded as your first sheet.

Optional: copy `config.sample.php` to `config.php` to change settings.

### Protecting the data directory

The included `.htaccess` files block access to `data/`, `lib/` and `examples/` on Apache.
Using **nginx**, add:

```nginx
location ~ ^/(data|lib|examples)(/|$) { deny all; return 404; }
location ~ \.(sqlite|sqlite-wal|sqlite-shm|cts)$ { deny all; return 404; }
```

As an extra safeguard, the database file gets a random name.

### Local testing

```sh
php -S 127.0.0.1:8080
```

(The PHP built-in server ignores `.htaccess`, so only use it locally.)

## Using it

Everything in the original TreeSheets menus is under the same menus here. See
*Help → Keyboard shortcuts* for the key list (you can rebind keys too). Browsers reserve a few
keys, so these also have alternatives:

| Action | TreeSheets | Also here |
| --- | --- | --- |
| New sheet | Ctrl+N | Alt+N |
| Close tab | Ctrl+W | Alt+W |
| Zoom in / out | Ctrl+PgUp / PgDn | Ctrl+] / Ctrl+[, Alt+Z / Alt+Shift+Z, Ctrl+wheel |
| Strikethrough | Ctrl+T | Ctrl+Shift+X |
| Layout styles | Ctrl/Alt+1…0 | Alt+1…0 and Ctrl+Alt+1…0 |
| Next/prev tab | Ctrl+Tab | Alt+Shift+→ / ← |
| Presentation view | F12 | Shift+F12 |
| Open link | F5 | F5 / F4 |

Your sheets are compatible with desktop TreeSheets. Use *File → Export → TreeSheets file* and
*File → Import → TreeSheets file* (or drop `.cts` files on the page).

## Project layout

```
index.php            setup / login pages and the app shell
api.php              JSON API (documents, images, import/export, backup/restore, auth)
lib/bootstrap.php    config, SQLite schema, sessions, auth, CSRF
lib/cts.php          reader/writer for the native TreeSheets .cts format
lib/store.php        storage helpers
assets/js/model.js   document model and grid operations (port of TreeSheets' cell/grid/selection)
assets/js/render.js  rendering to nested CSS grids
assets/js/app.js     editing, input (keyboard/mouse/touch), clipboard, autosave
assets/js/commands.js  every command, menu and shortcut
assets/js/evaluator.js the TreeSheets operation language
assets/js/io.js      text/HTML/XML/CSV export
```

## License & credits

TreeSheets © Wouter van Oortmerssen, released under the zlib license (see
`examples/TREESHEETS_LICENSE.txt`). This is a modified version, rewritten for the web. The
tutorial and operation reference sheets come from the TreeSheets distribution.
