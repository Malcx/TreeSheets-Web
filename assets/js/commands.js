// TreeSheets Web - all commands (menu items, toolbar buttons, keyboard shortcuts).
//
// Command semantics follow TreeSheets' Document::Action; shortcuts follow the TreeSheets menus,
// with a few extra bindings where browsers reserve the original key.

import {
    Cell, Grid, Doc, Selection, settings, TSError, pathOf, CT_DATA, CT_CODE, CT_VARD, CT_VARU, CT_VIEWH,
    CT_VIEWV, DS_GRID, DS_BUBBLE, DS_LINE, ALIGN_AUTO, ALIGN_LEFT, ALIGN_CENTER, ALIGN_RIGHT,
    STYLE_BOLD, STYLE_ITALIC, STYLE_FIXED, STYLE_UNDERLINE, STYLE_STRIKE, CELLCOLOR_DEFAULT,
    TEXTCOLOR_DEFAULT, BORDERCOLOR_DEFAULT, TAGTEXTCOLOR_DEFAULT, NO_SEL, ONE_CELL, NO_THIN, NO_GRID,
    textToCell, csvToGrid, xmlToCell, toggleRunStyle, setRunColor, minTextSize,
} from './model.js';
import { Evaluator, inferCellType, OPERATIONS } from './evaluator.js';
import { F_TEXT, F_XML, F_HTMLT, F_HTMLTI, F_HTMLB, F_HTMLO, F_CSV, cellToText, wrapExport, collectImages } from './io.js';
import { hex, imageURL, imageSizes } from './render.js';
import {
    el, icon, status, dialog, confirmBox, alertBox, promptBox, colorPicker, popupMenu, isTouch, isMac,
} from './ui.js';
import { api, downloadURL, triggerDownload, downloadBlob, normalizeKey } from './api.js';

const err = m => { throw new TSError(m); };
const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- helpers */

// Makes sure the selection is visible: zooms out if it is outside the zoomed view, and zooms
// into folded grids (TreeSheets' ScrollOrZoom).
export function makeVisible(doc) {
    const s = doc.selected;
    if (!s.grid) return;
    const target = s.grid.cell;
    let dr = doc.drawRoot();
    if (target !== dr && !dr.isParentOf(target)) {
        doc.drawpath = [];
        dr = doc.root;
    }
    let deepest = null;
    for (let c = target; c && c !== dr; c = c.parent) {
        if (c.grid && c.grid.folded && !deepest) deepest = c;
    }
    if (deepest) doc.drawpath = pathOf(deepest);
}

function selCellOrExpand(doc, sel) {
    const c = sel.thinExpand(doc);
    if (!c) err(ONE_CELL);
    return c;
}

function noThin(sel) { if (sel.thin()) err(NO_THIN); }

function replaceStr(text, search, repl) {
    if (!search) return text;
    const cs = settings.caseSensitiveSearch;
    let out = '', i = 0;
    for (;;) {
        const hay = cs ? text.slice(i) : text.slice(i).toLowerCase();
        const j = hay.indexOf(search);
        if (j < 0) break;
        out += text.slice(i, i + j) + repl;
        i += j + search.length;
    }
    return out + text.slice(i);
}

function delRowCol(doc, sel, which, e, gvs, dec, dx, dy, nxs, nys) {
    if (sel[which] === e) return;
    doc.addUndo(sel.grid.cell);
    if (gvs === 1) sel.grid.delSelf(doc, sel);
    else {
        sel.grid.deleteCells(dx, dy, nxs, nys);
        sel[which] -= dec;
    }
}

function multiCellDelete(doc, sel) {
    doc.addUndo(sel.grid.cell);
    sel.grid.multiCellDeleteSub(doc, sel);
    if (sel.textedit) sel.exitEdit();
}

function styleCmd(bit) {
    return (doc, sel, ctx) => {
        noThin(sel);
        const app = ctx.app;
        const c = sel.getCell();
        const caret = ctx.caret;
        doc.addUndo(sel.grid.cell);
        if (c && caret && caret[0] !== caret[1]) {
            toggleRunStyle(c, bit, Math.min(...caret), Math.max(...caret));
            return;
        }
        const set = !sel.grid.allHaveStyle(sel, bit);
        for (const x of sel.cells()) {
            x.stylebits = set ? x.stylebits | bit : x.stylebits & ~bit;
            if (x.runs) x.runs = x.runs.map(r => [r[0], r[1], set ? r[2] | bit : r[2] & ~bit, r[3]]);
            x.wasEdited();
        }
        void app;
    };
}

function layrender(ds, vert, toggle = false, noset = false) {
    return (doc, sel) => {
        noThin(sel);
        doc.addUndo(sel.grid.cell);
        const v = toggle ? !sel.getFirst().vert : vert;
        if (ds >= 0 && sel.isAll()) sel.grid.cell.drawstyle = ds;
        sel.grid.setGridTextLayout(ds, v, noset, sel);
    };
}

function markType(ct) {
    return (doc, sel) => {
        noThin(sel);
        doc.addUndo(sel.grid.cell);
        for (const c of sel.cells()) c.celltype = ct === CT_CODE ? inferCellType(c) : ct;
    };
}

function applyFilter(doc, pred) {
    for (const c of doc.allCells()) c.filtered = pred(c);
}

function editFilter(doc, pct) {
    doc.editfilter = Math.max(1, Math.min(99, pct));
    const cells = doc.allCells().sort((a, b) => b.lastedit - a.lastedit);
    cells.forEach((c, i) => { c.filtered = i > cells.length * doc.editfilter / 100; });
    return `Showing the ${doc.editfilter}% most recently edited cells.`;
}

function uniqueName(app, base) {
    const names = new Set(app.docs.map(d => d.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

async function openExample(app, which, name) {
    const existing = app.docs.find(d => d.name === name);
    if (existing) return app.openDoc(existing.id);
    const res = await api('import_example', { name: which });
    app.docs.push(res.document);
    return app.openDoc(res.document.id);
}

function readFileText(file) {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('Could not read the file.'));
        fr.readAsText(file);
    });
}

async function importText(app, kind) {
    const accept = { xml: '.xml,.opml,text/xml', xmla: '.xml,.opml,text/xml', txt: '.txt,text/plain', csv: '.csv,.txt',
        csvs: '.csv,.txt', tab: '.tsv,.tab,.txt', json: '.json,application/json' }[kind];
    const files = await app.pickFile(accept, true);
    for (const f of files) {
        const text = await readFileText(f);
        let root;
        if (kind === 'json') {
            const o = JSON.parse(text);
            const doc = Doc.fromJSON(o.root ? o : { root: o });
            await app.createDoc(f.name.replace(/\.[^.]+$/, ''), doc.toJSON());
            continue;
        }
        if (kind === 'xml' || kind === 'xmla') root = xmlToCell(text, kind === 'xmla');
        else if (kind === 'txt') root = textToCell(text);
        else root = csvToGrid(text, kind === 'csv' ? ',' : kind === 'csvs' ? ';' : '\t');
        const doc = new Doc(root);
        await app.createDoc(f.name.replace(/\.[^.]+$/, ''), doc.toJSON());
    }
    return files.length ? 'Imported ' + files.map(f => f.name).join(', ') + '.' : '';
}

async function exportText(app, format) {
    const doc = app.doc;
    const root = doc.drawRoot();
    if (format === F_CSV) {
        const acc = { maxdepth: 0, leaves: 0 };
        root.maxDepthLeaves(0, acc);
        if (acc.maxdepth > 1) err('Cannot export grid that is not flat (zoom the view to the desired grid, and/or use Flatten).');
    }
    const images = format === F_HTMLTI ? await collectImages([root]) : null;
    const content = cellToText(root, 0, format, doc, true, root, images);
    const out = wrapExport(format, content, app.tab.name, doc.root.cellcolor);
    const ext = { [F_XML]: 'xml', [F_TEXT]: 'txt', [F_CSV]: 'csv' }[format] || 'html';
    const mime = { xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html' }[ext];
    downloadBlob(out, safeName(app.tab.name) + '.' + ext, mime + ';charset=utf-8');
    return 'File exported.';
}

const safeName = n => n.replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_').slice(0, 100) || 'document';

// Renders the current view as an SVG (HTML in a foreignObject) - used for SVG and PNG export.
async function viewSVG(app) {
    const src = $('docroot').firstElementChild;
    if (!src) err('Nothing to export.');
    const w = Math.ceil(src.scrollWidth) + 2, h = Math.ceil(src.scrollHeight) + 2;
    const css = await (await fetch('assets/app.css')).text();
    const clone = src.cloneNode(true);
    const imgs = await collectImages([app.doc.drawRoot()]);
    for (const img of clone.querySelectorAll('img.cimg')) {
        const id = new URLSearchParams(img.getAttribute('src').split('?')[1]).get('id');
        if (imgs.has(id)) img.setAttribute('src', imgs.get(id));
    }
    const rs = document.documentElement.style;
    const vars = ['--sheet-font', '--sheet-mono', '--round'].map(v => `${v}:${rs.getPropertyValue(v)};`).join('')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="export-root" style="${vars}">` +
        `<style><![CDATA[${css.replace(/\]\]>/g, '')}]]></style>${xhtml}</div></foreignObject></svg>`;
    return { svg, w, h };
}

async function exportImage(app, png) {
    const { svg, w, h } = await viewSVG(app);
    const name = safeName(app.tab.name);
    if (!png) {
        downloadBlob(svg, name + '.svg', 'image/svg+xml');
        return 'Exported the current view as SVG.';
    }
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const k = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(16000, w * k);
    canvas.height = Math.min(16000, h * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(k, k);
    ctx.drawImage(img, 0, 0);
    try {
        const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
        downloadBlob(blob, name + '.png', 'image/png');
        return 'Exported the current view as PNG.';
    } catch (e) {
        downloadBlob(svg, name + '.svg', 'image/svg+xml');
        return 'This browser cannot create PNGs from HTML; exported SVG instead.';
    }
}

// Loads an image into a canvas, scaled, and re-encodes it.
async function reencodeImage(id, scale, mime) {
    const blob = await (await fetch(imageURL(id), { credentials: 'same-origin' })).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (mime === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise(res => canvas.toBlob(res, mime || blob.type || 'image/png', 0.9));
    return { blob: out, width: bmp.width };
}

async function replaceSelectedImages(app, fn) {
    const doc = app.doc;
    const cells = doc.selCells(true).filter(c => c.image);
    if (!cells.length) err('There are no images in the selection.');
    doc.addUndo(doc.selected.grid.cell);
    const done = new Map();
    status('Processing images…');
    for (const c of cells) {
        const key = c.image + '@' + c.imagescale;
        if (!done.has(key)) done.set(key, await fn(c));
        const r = done.get(key);
        if (r) {
            c.image = r.id;
            c.imagescale = r.scale;
            c.wasEdited();
        }
    }
}

async function uploadBlob(app, blob, name) {
    return app.uploadImage(new File([blob], name, { type: blob.type }));
}

function fontDialog(app, mono) {
    const opts = mono ? [
        ['System monospace', 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'],
        ['Courier', '"Courier New", Courier, monospace'], ['Consolas', 'Consolas, monospace'],
        ['Menlo', 'Menlo, Monaco, monospace'], ['Lucida Console', '"Lucida Console", monospace'],
    ] : [
        ['System', 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'],
        ['Arial / Helvetica', 'Arial, Helvetica, sans-serif'], ['Verdana', 'Verdana, Geneva, sans-serif'],
        ['Tahoma', 'Tahoma, Geneva, sans-serif'], ['Trebuchet', '"Trebuchet MS", sans-serif'],
        ['Georgia', 'Georgia, serif'], ['Times', '"Times New Roman", Times, serif'],
        ['Palatino', '"Palatino Linotype", Palatino, serif'], ['Segoe UI', '"Segoe UI", sans-serif'],
    ];
    const cur = mono ? app.prefs.monoFont : app.prefs.font;
    const sel = el('select', {}, opts.map(([l, v]) => el('option', { value: v, text: l, selected: v === cur })));
    const custom = el('input', { type: 'text', placeholder: 'or type a CSS font-family…', value: cur && !opts.some(o => o[1] === cur) ? cur : '' });
    const size = el('input', { type: 'number', min: 10, max: 20, value: settings.defTextSize });
    const sample = el('div', { class: 'font-sample', text: 'The quick brown fox jumps over the lazy dog 0123456789' });
    const upd = () => { sample.style.fontFamily = custom.value || sel.value; };
    sel.addEventListener('change', () => { custom.value = ''; upd(); });
    custom.addEventListener('input', upd);
    upd();
    return dialog({
        title: mono ? 'Typewriter font' : 'Font',
        body: el('div', { class: 'form' }, el('label', { class: 'field' }, 'Font', sel), el('label', { class: 'field' }, 'Custom', custom),
            mono ? null : el('label', { class: 'field' }, 'Base size (pt)', size), sample),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: () => ({ font: custom.value || sel.value, size: +size.value }) }],
    }).then(r => {
        if (!r) return;
        if (mono) app.savePrefs({ monoFont: r.font });
        else app.savePrefs({ font: r.font, defTextSize: Math.max(10, Math.min(20, r.size || 12)) });
    });
}

/* ---------------------------------------------------------------- dialogs */

async function docManager(app) {
    await app.refreshDocList().catch(() => {});
    const list = el('div', { class: 'doclist' });
    const filter = el('input', { type: 'search', placeholder: 'Filter sheets…', 'aria-label': 'Filter sheets' });
    let close = null;
    const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
    const draw = () => {
        list.textContent = '';
        const q = filter.value.toLowerCase();
        const docs = app.docs.filter(d => d.name.toLowerCase().includes(q));
        if (!docs.length) list.appendChild(el('p', { class: 'muted', text: 'No sheets.' }));
        for (const d of docs) {
            const isOpen = app.tabs.some(t => t.id === d.id);
            const row = el('div', { class: 'docrow' },
                el('button', { class: 'docname', type: 'button', onclick: async () => { close(null); await app.openDoc(d.id); } },
                    el('strong', { text: d.name }), isOpen ? el('span', { class: 'badge', text: 'open' }) : null,
                    el('small', { text: `Edited ${new Date(d.updated * 1000).toLocaleString()} · ${fmtSize(d.size)}` })),
                el('div', { class: 'docactions' },
                    el('button', { class: 'icon-btn', title: 'Rename', 'aria-label': 'Rename ' + d.name, onclick: async () => {
                        const n = await promptBox('Rename sheet', 'Name', d.name);
                        if (!n || n === d.name) return;
                        await api('rename', { id: d.id, name: n });
                        d.name = n;
                        const t = app.tabs.find(t => t.id === d.id);
                        if (t) { t.name = n; app.renderTabs(); }
                        draw();
                    } }, icon('edit')),
                    el('button', { class: 'icon-btn', title: 'Duplicate', 'aria-label': 'Duplicate ' + d.name, onclick: async () => {
                        const t = app.tabs.find(t => t.id === d.id);
                        if (t) await app.flush(t);
                        const r = await api('duplicate', { id: d.id });
                        app.docs.push(r.document);
                        draw();
                    } }, icon('copy')),
                    el('button', { class: 'icon-btn', title: 'Download as TreeSheets .cts file', 'aria-label': 'Download ' + d.name, onclick: async () => {
                        const t = app.tabs.find(t => t.id === d.id);
                        if (t) await app.flush(t);
                        triggerDownload(downloadURL('export_cts', { id: d.id }));
                    } }, icon('download')),
                    el('button', { class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete ' + d.name, onclick: async () => {
                        if (!await confirmBox('Delete sheet', `Delete “${d.name}” permanently? This cannot be undone (except by restoring a backup).`, 'Delete', true)) return;
                        await api('delete', { id: d.id });
                        app.docs = app.docs.filter(x => x.id !== d.id);
                        const t = app.tabs.find(t => t.id === d.id);
                        if (t) { t.dirty = false; await app.closeTab(t); }
                        draw();
                    } }, icon('trash'))));
            list.appendChild(row);
        }
    };
    filter.addEventListener('input', draw);
    draw();
    const body = el('div', {},
        el('div', { class: 'docbar' }, filter,
            el('button', { class: 'btn', type: 'button', onclick: () => { close(null); app.run('new'); } }, icon('plus'), ' New'),
            el('button', { class: 'btn', type: 'button', onclick: () => { close(null); app.run('import_cts'); } }, icon('upload'), ' Import .cts')),
        list,
        el('div', { class: 'docbar foot' },
            el('button', { class: 'btn primary', type: 'button', onclick: () => app.run('backup') }, icon('download'), ' Download backup'),
            app.zipAvailable ? el('button', { class: 'btn', type: 'button', onclick: () => app.run('backup_zip') }, 'All as .cts (zip)') : null,
            el('button', { class: 'btn', type: 'button', onclick: () => { close(null); app.run('restore'); } }, 'Restore…')));
    await dialog({ title: 'Your sheets', body, wide: true, buttons: [], onopen: (b, c) => { close = c; } });
}

async function shortcutsDialog(app, editable) {
    const q = el('input', { type: 'search', placeholder: 'Search commands…', 'aria-label': 'Search commands' });
    const table = el('div', { class: 'keys-table' });
    const custom = Object.assign({}, app.prefs.keys || {});
    const draw = () => {
        table.textContent = '';
        const f = q.value.toLowerCase();
        for (const c of app.commands) {
            if (c.hidden || !c.label) continue;
            if (f && !c.label.toLowerCase().includes(f) && !(c.group || '').toLowerCase().includes(f)) continue;
            const keys = custom[c.id] !== undefined ? (custom[c.id] ? [custom[c.id]] : []) : (c.keys || []);
            const shown = keys.length ? keys.join(', ') : (c.shortcut || '');
            const keyEl = el(editable ? 'button' : 'span', { class: 'kbd' + (editable ? ' editable' : ''), type: editable ? 'button' : null, text: shown || (editable ? 'set…' : '') });
            if (editable) {
                keyEl.addEventListener('click', () => {
                    keyEl.textContent = 'press keys… (Esc: none)';
                    const h = e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
                        window.removeEventListener('keydown', h, true);
                        if (e.key === 'Escape') custom[c.id] = '';
                        else {
                            const parts = [];
                            if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
                            if (e.altKey) parts.push('Alt');
                            if (e.shiftKey) parts.push('Shift');
                            let k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
                            if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
                            parts.push(k === ' ' ? 'Space' : k);
                            custom[c.id] = normalizeKey(parts.join('+'));
                        }
                        draw();
                    };
                    window.addEventListener('keydown', h, true);
                });
            }
            table.appendChild(el('div', { class: 'keyrow' }, el('span', { class: 'kgroup', text: c.group || '' }), el('span', { text: c.label }), keyEl));
        }
    };
    q.addEventListener('input', draw);
    draw();
    const buttons = editable ? [
        { label: 'Reset all', value: 'reset' }, { label: 'Cancel', value: null }, { label: 'Save', primary: true, value: 'save' },
    ] : [{ label: 'Customize…', value: 'edit' }, { label: 'Close', primary: true, value: null }];
    const r = await dialog({ title: editable ? 'Customize keyboard shortcuts' : 'Keyboard shortcuts', body: el('div', {}, q, table), wide: true, buttons });
    if (r === 'edit') return shortcutsDialog(app, true);
    if (r === 'save') app.savePrefs({ keys: custom });
    if (r === 'reset') app.savePrefs({ keys: {} });
}

async function versionsDialog(app) {
    const tab = app.tab;
    await app.flush(tab);
    const res = await api('versions', { id: tab.id });
    const list = el('div', { class: 'doclist' });
    let close;
    if (!res.versions.length) list.appendChild(el('p', { class: 'muted', text: 'No older versions yet. A snapshot is kept at most every 10 minutes while you edit.' }));
    for (const v of res.versions) {
        list.appendChild(el('div', { class: 'docrow' },
            el('div', { class: 'docname' }, el('strong', { text: new Date(v.saved * 1000).toLocaleString() }), el('small', { text: `revision ${v.revision} · ${Math.round(v.size / 1024)} KB` })),
            el('div', { class: 'docactions' },
                el('button', { class: 'btn small', type: 'button', onclick: async () => {
                    const r = await api('version', { id: tab.id, version: v.id });
                    close(null);
                    const choice = await dialog({ title: 'Restore version', body: `Restore the version from ${new Date(v.saved * 1000).toLocaleString()}?`,
                        buttons: [{ label: 'Cancel', value: null }, { label: 'Open as new sheet', value: 'copy' }, { label: 'Replace current', value: 'replace', primary: true }] });
                    if (choice === 'copy') await app.createDoc(tab.name + ' (' + new Date(v.saved * 1000).toLocaleDateString() + ')', r.data);
                    if (choice === 'replace') {
                        const nd = Doc.fromJSON(r.data);
                        const doc = app.doc;
                        doc.addUndo(doc.root);
                        doc.root = nd.root;
                        doc.tags = nd.tags;
                        doc.drawpath = [];
                        app.initSelection(doc);
                        app.refresh();
                        status('Version restored. Use Undo to go back.');
                    }
                } }, 'Restore…'))));
    }
    await dialog({ title: 'Version history – ' + tab.name, body: list, wide: true, buttons: [{ label: 'Close', value: null, primary: true }], onopen: (b, c) => { close = c; } });
}

function dateRangeDialog() {
    const now = new Date();
    const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const from = el('input', { type: 'datetime-local', value: iso(new Date(now.getTime() - 7 * 86400000)) });
    const to = el('input', { type: 'datetime-local', value: iso(now) });
    return dialog({
        title: 'Show edits in date range',
        body: el('div', { class: 'form' }, el('label', { class: 'field' }, 'From', from), el('label', { class: 'field' }, 'To', to)),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Filter', primary: true, value: () => [new Date(from.value).getTime(), new Date(to.value).getTime()] }],
    });
}

async function passwordDialog() {
    const cur = el('input', { type: 'password', autocomplete: 'current-password', autofocus: true });
    const pw = el('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const pw2 = el('input', { type: 'password', autocomplete: 'new-password' });
    const r = await dialog({
        title: 'Change password',
        body: el('div', { class: 'form' }, el('label', { class: 'field' }, 'Current password', cur),
            el('label', { class: 'field' }, 'New password (8+ characters)', pw), el('label', { class: 'field' }, 'Repeat new password', pw2),
            el('small', { class: 'hint', text: 'Other browsers and devices will be logged out.' })),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Change', primary: true, value: () => {
            if (pw.value.length < 8) { pw.setCustomValidity('At least 8 characters'); pw.reportValidity(); return undefined; }
            if (pw.value !== pw2.value) { pw2.setCustomValidity('Passwords do not match'); pw2.reportValidity(); return undefined; }
            return { current: cur.value, password: pw.value };
        } }],
    });
    if (!r) return '';
    const res = await api('change_password', r);
    if (res.csrf) document.querySelector('meta[name="csrf-token"]').content = res.csrf;
    alertBox('Password changed', 'Your password was changed. Reloading…').then(() => location.reload());
    return 'Password changed.';
}

async function newDocDialog(app) {
    const name = el('input', { type: 'text', value: uniqueName(app, 'Untitled'), autofocus: true });
    const size = el('input', { type: 'number', min: 1, max: 25, value: 3 });
    const r = await dialog({
        title: 'New sheet',
        body: el('div', { class: 'form' }, el('label', { class: 'field' }, 'Name', name),
            el('label', { class: 'field' }, 'Start with a grid of size (N × N)', size)),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, value: () => ({ name: name.value.trim() || 'Untitled', size: Math.max(1, Math.min(25, +size.value || 3)) }) }],
    });
    if (!r) return '';
    await app.createDoc(r.name, null, r.size);
    return '';
}

/* ---------------------------------------------------------------- the command list */

export function buildCommands(app) {
    const C = [];
    let group = '';
    const def = (id, label, keys, run, opts = {}) => {
        C.push(Object.assign({ id, label, keys: keys ? (Array.isArray(keys) ? keys : [keys]) : [], group,
            run: (doc, sel, ctx) => run(doc, sel, Object.assign({ app }, ctx)) }, opts));
    };
    const sel1 = { needs: 'sel' };

    /* File */
    group = 'File';
    def('new', 'New sheet…', ['Alt+N', 'Ctrl+N'], () => newDocDialog(app), { noDoc: true, icon: 'plus' });
    def('open', 'Open / manage sheets…', ['Ctrl+O'], () => docManager(app), { noDoc: true, icon: 'doc', render: false });
    def('close', 'Close tab', ['Alt+W'], () => app.closeTab(app.tab), { render: false });
    def('save', 'Save now', ['Ctrl+S'], async () => {
        await app.flushAll();
        return app.tab && !app.tab.dirty ? 'Saved.' : '';
    }, { icon: 'save', render: false });
    def('rename', 'Rename sheet…', [], async () => {
        const n = await promptBox('Rename sheet', 'Name', app.tab.name);
        if (!n || n === app.tab.name) return;
        await api('rename', { id: app.tab.id, name: n });
        app.tab.name = n;
        const d = app.docs.find(d => d.id === app.tab.id);
        if (d) d.name = n;
        document.title = n + ' – TreeSheets';
        app.renderTabs();
    }, { render: false });
    def('duplicate', 'Duplicate sheet', [], async () => {
        await app.flush(app.tab);
        const r = await api('duplicate', { id: app.tab.id });
        app.docs.push(r.document);
        await app.openDoc(r.document.id);
    }, { render: false });
    def('deletedoc', 'Delete sheet…', [], async () => {
        const t = app.tab;
        if (!await confirmBox('Delete sheet', `Delete “${t.name}” permanently?`, 'Delete', true)) return;
        await api('delete', { id: t.id });
        app.docs = app.docs.filter(d => d.id !== t.id);
        t.dirty = false;
        await app.closeTab(t);
    }, { render: false });
    def('history', 'Version history…', [], () => versionsDialog(app), { render: false });
    def('import_cts', 'TreeSheets file (.cts)…', [], async () => {
        const files = await app.pickFile('.cts', true);
        for (const f of files) await app.importCTS(f);
    }, { noDoc: true, render: false });
    def('import_xml', 'XML…', [], () => importText(app, 'xml'), { noDoc: true, render: false });
    def('import_xmla', 'XML (attributes too, for OPML etc.)…', [], () => importText(app, 'xmla'), { noDoc: true, render: false });
    def('import_txt', 'Indented text…', [], () => importText(app, 'txt'), { noDoc: true, render: false });
    def('import_csv', 'Comma delimited text (CSV)…', [], () => importText(app, 'csv'), { noDoc: true, render: false });
    def('import_csvs', 'Semi-colon delimited text (CSV)…', [], () => importText(app, 'csvs'), { noDoc: true, render: false });
    def('import_tab', 'Tab delimited text…', [], () => importText(app, 'tab'), { noDoc: true, render: false });
    def('import_json', 'TreeSheets Web JSON…', [], () => importText(app, 'json'), { noDoc: true, render: false });
    def('export_cts', 'TreeSheets file (.cts)…', [], async () => {
        await app.flush(app.tab);
        triggerDownload(downloadURL('export_cts', { id: app.tab.id }));
    }, { render: false });
    def('export_xml', 'XML…', [], () => exportText(app, F_XML), { render: false });
    def('export_htmlt', 'HTML (Tables+Styling)…', [], () => exportText(app, F_HTMLT), { render: false });
    def('export_htmlti', 'HTML (Tables+Styling+Images)…', [], () => exportText(app, F_HTMLTI), { render: false });
    def('export_htmlb', 'HTML (Bullet points)…', [], () => exportText(app, F_HTMLB), { render: false });
    def('export_htmlo', 'HTML (Outline)…', [], () => exportText(app, F_HTMLO), { render: false });
    def('export_txt', 'Indented text…', [], () => exportText(app, F_TEXT), { render: false });
    def('export_csv', 'Comma delimited text (CSV)…', [], () => exportText(app, F_CSV), { render: false });
    def('export_json', 'TreeSheets Web JSON…', [], () => {
        downloadBlob(JSON.stringify(app.doc.toJSON()), safeName(app.tab.name) + '.json', 'application/json');
    }, { render: false });
    def('export_png', 'Image (PNG) of current view…', [], () => exportImage(app, true), { render: false });
    def('export_svg', 'Vector graphics (SVG) of current view…', [], () => exportImage(app, false), { render: false });
    def('backup', 'Download backup (all sheets)', [], async () => {
        await app.flushAll();
        triggerDownload(downloadURL('backup'));
        return 'Backup download started.';
    }, { noDoc: true, render: false, icon: 'download' });
    def('backup_zip', 'Download all sheets as .cts files (zip)', [], async () => {
        await app.flushAll();
        triggerDownload(downloadURL('export_all'));
    }, { noDoc: true, render: false });
    def('restore', 'Restore from backup…', [], async () => {
        const files = await app.pickFile('.sqlite,.db,application/vnd.sqlite3,application/x-sqlite3');
        if (!files.length) return;
        if (!await confirmBox('Restore backup', `Replace ALL sheets with the contents of “${files[0].name}”? Your current sheets will be lost (download a backup first if unsure). Your password stays the same.`, 'Restore', true)) return;
        const fd = new FormData();
        fd.append('file', files[0]);
        await api('restore', fd);
        for (const t of app.tabs) t.dirty = false;
        try { for (const k of Object.keys(localStorage)) if (k.startsWith('tsweb.')) localStorage.removeItem(k); } catch (e) { /* ignore */ }
        await alertBox('Backup restored', 'The backup was restored. The page will now reload.');
        location.reload();
    }, { noDoc: true, render: false });
    def('print', 'Print…', ['Ctrl+P'], () => { window.print(); }, { render: false });
    def('logout', 'Log out', [], async () => {
        await app.flushAll();
        await api('logout');
        location.reload();
    }, { noDoc: true, render: false, icon: 'logout' });

    /* Edit */
    group = 'Edit';
    def('cut', 'Cut', [], () => app.copyToClipboard(true), { needs: 'sel', shortcut: isMac ? '⌘X' : 'Ctrl+X', icon: 'cut' });
    def('copy', 'Copy', [], () => app.copyToClipboard(false), { needs: 'sel', shortcut: isMac ? '⌘C' : 'Ctrl+C', icon: 'copy', render: false });
    def('copywi', 'Copy with images', ['Ctrl+Alt+C'], () => app.copyToClipboard(false, 'images'), { needs: 'sel', render: false });
    def('copyct', 'Copy as continuous text', [], () => app.copyToClipboard(false, 'continuous'), { needs: 'sel', render: false });
    def('paste', 'Paste', [], () => app.pasteFromSystem(), { needs: 'sel', shortcut: isMac ? '⌘V' : 'Ctrl+V', icon: 'paste' });
    def('pastestyle', 'Paste style only', ['Ctrl+Shift+V'], (doc, sel) => {
        if (!app.clip) err('No style to paste.');
        doc.addUndo(sel.grid.cell);
        sel.grid.setStyles(sel, app.clip.cell);
    }, sel1);
    def('collapse', 'Collapse cells', ['Ctrl+L'], (doc, sel) => {
        noThin(sel);
        if (sel.xs * sel.ys === 1) err('More than one cell must be selected.');
        const fc = sel.getFirst();
        let ct = '';
        for (const ci of doc.selCells(true)) if (ci !== fc && ci.text) ct += ' ' + ci.text;
        if (!fc.hasContent() && !ct) err('There is no content to collapse.');
        doc.addUndo(fc.parent);
        fc.setText(fc.text + ct);
        for (const ci of sel.cells()) if (ci !== fc) ci.clear();
        const g = sel.grid, x = sel.x, y = sel.y;
        const ds = new Selection(g, sel.x + (sel.xs > 1 ? 1 : 0), sel.y + (sel.ys > 1 ? 1 : 0), sel.xs - (sel.xs > 1 ? 1 : 0), sel.ys - (sel.ys > 1 ? 1 : 0));
        g.multiCellDeleteSub(doc, ds);
        doc.selected = new Selection(g, x, y, 1, 1);
    }, sel1);
    def('note', 'Edit note…', ['Ctrl+E'], async (doc, sel) => {
        const c = selCellOrExpand(doc, sel);
        const v = await promptBox('Note', 'Note for this cell', c.note, { multiline: true, ok: 'Save' });
        if (v === null || v === c.note) return;
        doc.addUndo(c);
        c.note = v;
    }, { needs: 'sel', icon: 'note' });
    def('undo', 'Undo', ['Ctrl+Z'], doc => { if (!doc.undo()) return 'Nothing more to undo.'; }, { icon: 'undo' });
    def('redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], doc => { if (!doc.undo(true)) return 'Nothing more to redo.'; }, { icon: 'redo' });
    def('deleteafter', 'Delete after', ['Delete'], (doc, sel) => {
        if (sel.thin()) {
            if (sel.xs !== 0) delRowCol(doc, sel, 'y', sel.grid.ys, sel.grid.ys, 0, -1, sel.y, 0, -1);
            else delRowCol(doc, sel, 'x', sel.grid.xs, sel.grid.xs, 0, sel.x, -1, -1, 0);
        } else multiCellDelete(doc, sel);
        doc.zoomOutIfNoGrid();
    }, { needs: 'sel', title: 'Deletes the column of cells after the selected grid line, or the row below' });
    def('deletebefore', 'Delete before', ['Backspace'], (doc, sel) => {
        if (sel.thin()) {
            if (sel.xs !== 0) delRowCol(doc, sel, 'y', 0, sel.grid.ys, 1, -1, sel.y - 1, 0, -1);
            else delRowCol(doc, sel, 'x', 0, sel.grid.xs, 1, sel.x - 1, -1, -1, 0);
        } else multiCellDelete(doc, sel);
        doc.zoomOutIfNoGrid();
    }, { needs: 'sel', title: 'Deletes the column of cells before the selected grid line, or the row above' });
    def('deletecells', 'Delete cells', [], (doc, sel) => {
        noThin(sel);
        multiCellDelete(doc, sel);
        doc.zoomOutIfNoGrid();
    }, { needs: 'sel', icon: 'trash', hidden: true });
    const enterGrid = n => async (doc, sel) => {
        const c = selCellOrExpand(doc, sel);
        if (c.grid) {
            doc.selected = new Selection(c.grid, 0, 0, 1, 1);
            makeVisible(doc);
            return;
        }
        let size = 1;
        if (n) {
            size = await promptBox('New subgrid', 'What subgrid size would you like to start with?', 3, { type: 'number', min: 1, max: 25 });
            if (size === null) return 'No subgrid created.';
        }
        doc.addUndo(c);
        c.addGrid(size, size);
        doc.selected = new Selection(c.grid, 0, 0, 1, 1);
    };
    def('entergrid', 'Insert new grid / select first child', ['Insert', 'Shift+Enter', 'Ctrl+G'], enterGrid(false), { needs: 'sel', icon: 'subgrid' });
    def('entergridn', 'Insert new N×N grid…', ['Ctrl+Shift+Enter'], enterGrid(true), sel1);
    def('wrap', 'Wrap in new parent', ['F9'], (doc, sel) => {
        sel.wrap(doc);
        sel.exitEdit();
        if (!isTouch()) setTimeout(() => app.startEdit({ end: true }), 0);
    }, { needs: 'sel', icon: 'wrap' });
    const fold = mode => (doc, sel) => {
        noThin(sel);
        let any = false;
        for (const c of doc.selCells(mode !== 'toggle')) {
            if (!c.grid) continue;
            if (!any) doc.addUndo(sel.grid.cell);
            any = true;
            c.grid.folded = mode === 'toggle' ? !c.grid.folded : mode === 'fold';
        }
        if (!any) return 'No grids to fold in the selection.';
    };
    def('fold', 'Toggle fold', ['Ctrl+F10', 'F10', 'Ctrl+Shift+Space'], fold('toggle'), { needs: 'sel', icon: 'fold' });
    def('foldall', 'Fold all', ['Ctrl+Shift+F10'], fold('fold'), sel1);
    def('unfoldall', 'Unfold all', ['Ctrl+Alt+F10'], fold('unfold'), sel1);
    // Extra (web): insert rows/columns next to the selection - handy on touch screens.
    const insert = (dx, dy) => (doc, sel) => {
        const g = sel.grid;
        doc.addUndo(g.cell);
        if (sel.thin()) {
            sel.thinExpand(doc);
            doc.redolist = [];
            return;
        }
        if (dy) {
            const y = dy < 0 ? sel.y : sel.y + sel.ys;
            g.insertCells(-1, y, 0, 1);
            doc.selected = new Selection(g, sel.x, y, 1, 1);
        } else {
            const x = dx < 0 ? sel.x : sel.x + sel.xs;
            g.insertCells(x, -1, 1, 0);
            doc.selected = new Selection(g, x, sel.y, 1, 1);
        }
    };
    def('insrowabove', 'Insert row above', [], insert(0, -1), { needs: 'sel', icon: 'rowabove' });
    def('insrowbelow', 'Insert row below', [], insert(0, 1), { needs: 'sel', icon: 'rowbelow' });
    def('inscolleft', 'Insert column left', [], insert(-1, 0), { needs: 'sel', icon: 'colleft' });
    def('inscolright', 'Insert column right', [], insert(1, 0), { needs: 'sel', icon: 'colright' });

    /* Selection */
    group = 'Selection';
    def('next', 'Move to next cell', ['Tab'], (doc, sel) => {
        if (sel.thin()) sel.thinExpand(doc);
        sel.next(false);
        setTimeout(() => app.startEdit({ all: true }), 0);
    }, sel1);
    def('prev', 'Move to previous cell', ['Shift+Tab'], (doc, sel) => {
        if (sel.thin()) sel.thinExpand(doc);
        sel.next(true);
        setTimeout(() => app.startEdit({ all: true }), 0);
    }, sel1);
    def('selectall', 'Select all in current grid', ['Ctrl+A'], (doc, sel) => {
        sel.x = sel.y = 0;
        sel.xs = sel.grid.xs;
        sel.ys = sel.grid.ys;
    }, sel1);
    const cursor = (dx, dy, ctrl, shift) => (doc, sel) => sel.dir(doc, ctrl, shift, dx, dy);
    def('left', 'Cursor left', ['ArrowLeft'], cursor(-1, 0, false, false), sel1);
    def('right', 'Cursor right', ['ArrowRight'], cursor(1, 0, false, false), sel1);
    def('up', 'Cursor up', ['ArrowUp'], cursor(0, -1, false, false), sel1);
    def('down', 'Cursor down', ['ArrowDown'], cursor(0, 1, false, false), sel1);
    def('mleft', 'Move cells left', ['Ctrl+ArrowLeft'], cursor(-1, 0, true, false), sel1);
    def('mright', 'Move cells right', ['Ctrl+ArrowRight'], cursor(1, 0, true, false), sel1);
    def('mup', 'Move cells up', ['Ctrl+ArrowUp'], cursor(0, -1, true, false), sel1);
    def('mdown', 'Move cells down', ['Ctrl+ArrowDown'], cursor(0, 1, true, false), sel1);
    def('sleft', 'Extend selection left', ['Shift+ArrowLeft'], cursor(-1, 0, false, true), sel1);
    def('sright', 'Extend selection right', ['Shift+ArrowRight'], cursor(1, 0, false, true), sel1);
    def('sup', 'Extend selection up', ['Shift+ArrowUp'], cursor(0, -1, false, true), sel1);
    def('sdown', 'Extend selection down', ['Shift+ArrowDown'], cursor(0, 1, false, true), sel1);
    def('srows', 'Extend selection full rows', ['Ctrl+Shift+B'], (doc, sel) => { sel.x = 0; sel.xs = sel.grid.xs; }, sel1);
    def('scols', 'Extend selection full columns', ['Ctrl+Shift+A'], (doc, sel) => { sel.y = 0; sel.ys = sel.grid.ys; }, sel1);
    const extendTo = (horiz, ismin) => (doc, sel) => {
        const pos = horiz ? 'x' : 'y', ext = horiz ? 'xs' : 'ys';
        if (ismin) {
            if (sel[pos] + sel[ext] > 0) { sel[ext] = sel[pos] + sel[ext]; sel[pos] = 0; }
        } else sel[ext] = (horiz ? sel.grid.xs : sel.grid.ys) - sel[pos];
    };
    def('scleft', 'Extend selection rows left', ['Ctrl+Shift+ArrowLeft'], extendTo(true, true), sel1);
    def('scright', 'Extend selection rows right', ['Ctrl+Shift+ArrowRight'], extendTo(true, false), sel1);
    def('scup', 'Extend selection columns up', ['Ctrl+Shift+ArrowUp'], extendTo(false, true), sel1);
    def('scdown', 'Extend selection columns down', ['Ctrl+Shift+ArrowDown'], extendTo(false, false), sel1);
    def('parent', 'Select parent', ['Escape'], (doc, sel) => {
        const p = sel.grid.cell;
        if (p.parent && p !== doc.drawRoot()) doc.selected = p.parent.grid.findCell(p);
        else if (p.parent && p === doc.drawRoot()) {
            doc.zoom(-1);
            doc.selected = p.parent.grid.findCell(p);
        } else { sel.x = sel.y = 0; sel.xs = sel.grid.xs; sel.ys = sel.grid.ys; }
    }, { needs: 'sel', icon: 'up' });
    def('home', 'Select first cell', ['Home', 'Ctrl+Home'], (doc, sel) => { sel.x = sel.y = 0; sel.xs = sel.ys = 1; }, sel1);
    def('end', 'Select last cell', ['End', 'Ctrl+End'], (doc, sel) => { sel.x = sel.grid.xs - 1; sel.y = sel.grid.ys - 1; sel.xs = sel.ys = 1; }, sel1);
    const link = (forward, image) => (doc, sel) => {
        const c = sel.getCell();
        if (!c) err(ONE_CELL);
        if (!image && !c.text) err('No text in this cell.');
        if (image && !c.image) err('No image in this cell.');
        const l = doc.findLink(c, forward, image);
        if (!l || !l.parent) err('No matching cell found!');
        doc.selected = l.parent.grid.findCell(l);
        makeVisible(doc);
    };
    def('link', 'Go to matching cell (text)', ['F6'], link(true, false), sel1);
    def('linkrev', 'Go to matching cell (text, reverse)', ['Shift+F6'], link(false, false), sel1);
    def('linkimg', 'Go to matching cell (image)', ['F7'], link(true, true), sel1);
    def('linkimgrev', 'Go to matching cell (image, reverse)', ['Shift+F7'], link(false, true), sel1);

    /* Text editing */
    group = 'Text editing';
    def('entercell', 'Enter/exit text edit mode', ['Enter'], () => { app.startEdit({ all: true }); }, { needs: 'sel', icon: 'edit', render: false });
    def('entercellend', '…and jump to the end of the text', ['F2'], () => { app.startEdit({ end: true }); }, { needs: 'sel', render: false });
    def('entercellstart', '…and progress to the first cell in the new row', ['Ctrl+Enter'], (doc, sel) => {
        sel.thinExpand(doc, true);
        setTimeout(() => app.startEdit({ all: true }), 0);
    }, sel1);
    def('progresscell', '…and progress to the next cell on the right', ['Alt+Enter'], () => { app.startEdit({ all: true }); }, { needs: 'sel', render: false });
    def('edit', 'Edit cell text', [], () => { app.startEdit({ end: true }); }, { needs: 'sel', icon: 'edit', render: false, hidden: true });

    /* Text sizing */
    group = 'Sizing';
    const relsize = dir => (doc, sel) => {
        if (!doc.lastUndoSameCellStructure(sel.grid.cell)) doc.addUndo(sel.grid.cell);
        doc.modified();
        sel.grid.relSize(-dir, doc.drawpath.length, sel);
        return dir > 0 ? 'Text size increased.' : 'Text size decreased.';
    };
    def('incsize', 'Increase text size (Shift+mousewheel)', ['Shift+PageUp'], relsize(1), sel1);
    def('decsize', 'Decrease text size (Shift+mousewheel)', ['Shift+PageDown'], relsize(-1), sel1);
    const resetLoop = fn => (doc, sel) => {
        doc.addUndo(sel.grid.cell);
        for (const c of doc.selCells(true)) fn(c, doc, sel);
    };
    def('resetsize', 'Reset text sizes', ['Ctrl+Shift+S'], resetLoop(c => { c.relsize = 0; }), sel1);
    def('minisize', 'Shrink text of all sub-grids', ['Ctrl+Shift+M'], (doc, sel) => {
        doc.addUndo(sel.grid.cell);
        for (const o of sel.cells())
            if (o.grid) o.walk(c => { if (c !== o) c.relsize = settings.defTextSize - minTextSize() - c.depth(); });
    }, sel1);
    const colwidth = (dir, hier) => (doc, sel) => {
        if (sel.xs <= 0) return 'Nothing to resize.';
        if (!doc.lastUndoSameCellStructure(sel.grid.cell)) doc.addUndo(sel.grid.cell);
        doc.modified();
        sel.grid.resizeColWidths(dir, sel, hier);
        return dir > 0 ? 'Column width increased.' : 'Column width decreased.';
    };
    def('incwidth', 'Increase column width (Alt+mousewheel)', ['Alt+PageUp'], colwidth(1, true), sel1);
    def('decwidth', 'Decrease column width (Alt+mousewheel)', ['Alt+PageDown'], colwidth(-1, true), sel1);
    def('incwidthnh', 'Increase column width (no sub grids)', ['Ctrl+Alt+PageUp'], colwidth(1, false), sel1);
    def('decwidthnh', 'Decrease column width (no sub grids)', ['Ctrl+Alt+PageDown'], colwidth(-1, false), sel1);
    def('resetwidth', 'Reset column widths', ['Ctrl+R'], (doc, sel) => {
        doc.addUndo(sel.grid.cell);
        for (let x = sel.x; x < sel.x + sel.xs; x++) sel.grid.colwidths[x] = settings.defaultColWidth;
    }, sel1);
    for (let i = 0; i <= 5; i++) {
        def('bord' + i, 'Border ' + i, [i === 0 ? 'Ctrl+Shift+9' : 'Ctrl+Shift+' + i], (doc, sel) => {
            doc.addUndo(sel.grid.cell);
            sel.grid.spacing = i + 1;
        }, sel1);
    }

    /* Styles */
    group = 'Style';
    def('bold', 'Toggle cell bold', ['Ctrl+B'], styleCmd(STYLE_BOLD), { needs: 'sel', edit: 'keep', icon: 'bold' });
    def('italic', 'Toggle cell italic', ['Ctrl+I'], styleCmd(STYLE_ITALIC), { needs: 'sel', edit: 'keep', icon: 'italic' });
    def('tt', 'Toggle cell typewriter', ['Ctrl+Alt+T'], styleCmd(STYLE_FIXED), { needs: 'sel', edit: 'keep', icon: 'mono' });
    def('underline', 'Toggle cell underlined', ['Ctrl+U'], styleCmd(STYLE_UNDERLINE), { needs: 'sel', edit: 'keep', icon: 'underline' });
    def('strike', 'Toggle cell strikethrough', ['Ctrl+T', 'Ctrl+Shift+X'], styleCmd(STYLE_STRIKE), { needs: 'sel', edit: 'keep', icon: 'strike' });
    const align = a => (doc, sel) => {
        doc.addUndo(sel.grid.cell);
        for (const c of sel.cells()) c.align = a;
    };
    def('alignauto', 'Align automatically', ['Ctrl+Shift+D'], align(ALIGN_AUTO), sel1);
    def('alignleft', 'Align left', ['Ctrl+Shift+L'], align(ALIGN_LEFT), sel1);
    def('aligncenter', 'Align center', ['Ctrl+Shift+E'], align(ALIGN_CENTER), sel1);
    def('alignright', 'Align right', ['Ctrl+Shift+R'], align(ALIGN_RIGHT), sel1);
    def('resetstyle', 'Reset text styles', ['Ctrl+Shift+K'], resetLoop(c => { c.stylebits = 0; c.runs = null; c.align = ALIGN_AUTO; }), sel1);
    def('resetcolor', 'Reset colors', ['Ctrl+Shift+C', 'Ctrl+Alt+Shift+C'], resetLoop((c, doc) => {
        if (doc.isTag(c)) doc.tags.set(c.text, [CELLCOLOR_DEFAULT, TAGTEXTCOLOR_DEFAULT]);
        else {
            c.textcolor = TEXTCOLOR_DEFAULT;
            if (c.runs) c.runs = c.runs.map(r => [r[0], r[1], r[2], -1]);
        }
        c.cellcolor = CELLCOLOR_DEFAULT;
        if (c.grid) c.grid.bordercolor = BORDERCOLOR_DEFAULT;
    }), sel1);
    const applyColor = (which, color, doc, sel, caret) => {
        doc.addUndo(sel.grid.cell);
        const c1 = sel.getCell();
        if (which === 'text' && c1 && caret && caret[0] !== caret[1]) {
            setRunColor(c1, color, Math.min(...caret), Math.max(...caret));
            return;
        }
        for (const c of sel.cells()) {
            if (which === 'cell') { if (doc.isTag(c)) doc.tags.get(c.text)[0] = color; else c.cellcolor = color; }
            else if (which === 'text') {
                if (doc.isTag(c)) doc.tags.get(c.text)[1] = color;
                else { c.textcolor = color; if (c.runs) c.runs = c.runs.map(r => [r[0], r[1], r[2], -1]); }
            } else if (which === 'border') sel.grid.bordercolor = color;
            c.wasEdited();
        }
    };
    const colorCmd = (which, title) => async (doc, sel, ctx) => {
        const cur = which === 'border' ? sel.grid.bordercolor : which === 'cell' ? (sel.getFirst() || {}).cellcolor : (sel.getFirst() || {}).textcolor;
        const color = await colorPicker(title, cur ?? 0xFFFFFF, app.recentColors);
        if (color === null) return;
        app.lastColors[which] = color;
        app.rememberColor(color);
        applyColor(which, color, doc, sel, ctx.caret);
    };
    def('cellcolor', 'Cell color…', ['Shift+Alt+F9'], colorCmd('cell', 'Cell color'), { needs: 'sel', icon: 'fill', edit: 'keep' });
    def('textcolor', 'Text color…', ['Shift+Alt+F10'], colorCmd('text', 'Text color'), { needs: 'sel', icon: 'textcolor', edit: 'keep' });
    def('bordcolor', 'Border color…', ['Shift+Alt+F11'], colorCmd('border', 'Border color'), { needs: 'sel', icon: 'border' });
    const lastColor = which => (doc, sel, ctx) => {
        if (which === 'text' && ctx.caret && ctx.caret[0] !== ctx.caret[1]) return applyColor('text', app.lastColors.text, doc, sel, ctx.caret);
        doc.addUndo(sel.grid.cell);
        for (const c of doc.selCells(true)) {
            if (which === 'cell') c.cellcolor = app.lastColors.cell;
            else if (which === 'text') { c.textcolor = app.lastColors.text; if (c.runs) c.runs = c.runs.map(r => [r[0], r[1], r[2], -1]); }
            else if (c.parent && c.parent.grid) c.parent.grid.bordercolor = app.lastColors.border;
        }
    };
    def('lastcellcolor', 'Apply last cell color', ['Alt+Shift+C'], lastColor('cell'), { needs: 'sel', edit: 'keep' });
    def('lasttextcolor', 'Apply last text color', ['Alt+Shift+T'], lastColor('text'), { needs: 'sel', edit: 'keep' });
    def('lastbordcolor', 'Apply last border color', ['Alt+Shift+B'], lastColor('border'), sel1);

    /* Tags */
    group = 'Tags';
    def('tagadd', 'Add cell text as tag', [], (doc, sel) => {
        for (const c of sel.cells()) if (c.text) doc.tags.set(c.text, [c.cellcolor, c.textcolor]);
        doc.modified();
    }, sel1);
    def('tagremove', 'Remove cell text from tags', [], (doc, sel) => {
        for (const c of sel.cells()) doc.tags.delete(c.text);
        doc.modified();
    }, sel1);
    def('tagset', 'Set cell text to tag', [], (doc, sel, ctx) => {
        const tag = ctx.args[0];
        if (tag === undefined) return;
        const c = sel.thin() ? sel.thinExpand(doc) : null;
        doc.addUndo(sel.grid.cell);
        for (const x of c ? [c] : sel.cells()) x.setText(tag);
    }, { needs: 'sel', hidden: true });

    /* Organization */
    group = 'Organization';
    def('transpose', 'Transpose', ['Ctrl+Shift+T', 'Ctrl+Alt+Shift+T'], (doc, sel) => {
        noThin(sel);
        const ac = sel.grid.cell;
        doc.addUndo(ac);
        if (sel.isAll()) {
            ac.grid.transpose();
            doc.selected = ac.parent ? ac.parent.grid.findCell(ac) : ac.grid.selectAll();
        } else for (const c of sel.cells()) if (c.grid) c.grid.transpose();
    }, { needs: 'sel', title: 'Changes the orientation of a grid' });
    const sort = desc => (doc, sel) => {
        if (sel.xs !== 1 && sel.ys <= 1) err("Can't sort: make a 1xN selection to indicate what column to sort on, and what rows to affect");
        doc.addUndo(sel.grid.cell);
        sel.grid.sort(sel, desc);
    };
    def('sort', 'Sort ascending', [], sort(false), { needs: 'sel', title: 'Make a 1xN selection to indicate which column to sort on, and which rows to affect' });
    def('sortd', 'Sort descending', [], sort(true), sel1);
    def('hswap', 'Hierarchy swap', ['F8'], (doc, sel) => {
        const cell = sel.getCell();
        if (!cell) err(ONE_CELL);
        const pp = cell.parent.parent;
        if (!pp) err('Cannot move this cell up in the hierarchy.');
        if (pp.grid.xs !== 1 && pp.grid.ys !== 1) err('Can only move this cell into a Nx1 or 1xN grid.');
        if (cell.parent.grid.xs !== 1 && cell.parent.grid.ys !== 1) err('Can only move this cell from a Nx1 or 1xN grid.');
        doc.addUndo(pp);
        doc.selected = pp.grid.hierarchySwap(cell.text);
        makeVisible(doc);
    }, { needs: 'sel', title: 'Swap all cells with this text at this level (or above) with the parent' });
    const acCell = (doc, sel) => {
        const c = sel.getCell();
        if (c) return c;
        if (sel.isAll()) return sel.grid.cell;
        err(ONE_CELL);
    };
    def('hify', 'Hierarchify', [], (doc, sel) => {
        const ac = acCell(doc, sel);
        if (!ac.grid) err(NO_GRID);
        if (!ac.grid.isTable()) err('Selected grid is not a table: cells must not already have sub-grids.');
        doc.addUndo(ac);
        ac.grid.hierarchify(doc);
        doc.selected = ac.parent && ac !== doc.drawRoot() ? ac.parent.grid.findCell(ac) : new Selection(ac.grid, 0, 0, 1, 1);
    }, { needs: 'sel', title: 'Convert an NxN grid with repeating elements per column into an 1xN grid with hierarchy' });
    def('flatten', 'Flatten', [], (doc, sel) => {
        const ac = acCell(doc, sel);
        if (!ac.grid) err(NO_GRID);
        doc.addUndo(ac);
        const acc = { maxdepth: 0, leaves: 0 };
        ac.maxDepthLeaves(0, acc);
        const g = new Grid(Math.max(1, acc.maxdepth), Math.max(1, acc.leaves), ac);
        g.initCells();
        ac.grid.flatten(0, 0, g);
        ac.grid = g;
        g.reParent(ac);
        doc.selected = ac.parent && ac !== doc.drawRoot() ? ac.parent.grid.findCell(ac) : new Selection(ac.grid, 0, 0, 1, 1);
    }, { needs: 'sel', title: 'Takes a hierarchy (nested 1xN or Nx1 grids) and converts it into a flat NxN grid' });

    /* Images */
    group = 'Images';
    def('image', 'Add image…', [], async (doc, sel) => {
        const files = await app.pickFile('image/png,image/jpeg,image/gif,image/webp');
        if (!files.length) return;
        await app.pasteFiles(files);
    }, { needs: 'sel', icon: 'image', render: false });
    def('imagesave', 'Save image(s) as…', [], (doc) => {
        const ids = [...new Set(doc.selCells(true).filter(c => c.image).map(c => c.image))];
        if (!ids.length) err('There are no images in the selection.');
        ids.forEach((id, i) => setTimeout(() => triggerDownload(imageURL(id), 'image-' + (i + 1)), i * 300));
        return 'Image(s) are being downloaded.';
    }, { needs: 'sel', render: false });
    def('imagescalep', 'Scale (re-sample pixels, by %)…', [], async () => {
        const v = await promptBox('Image resize', 'Percentage to scale the image(s) by:', 50, { type: 'number', min: 5, max: 400 });
        if (v === null) return;
        await replaceSelectedImages(app, async c => {
            const r = await reencodeImage(c.image, v / 100);
            const up = await uploadBlob(app, r.blob, 'resized');
            return { id: up.id, scale: c.imagescale };
        });
        return 'Image(s) resized.';
    }, sel1);
    def('imagescalew', 'Scale (re-sample pixels, by width)…', [], async () => {
        const v = await promptBox('Image resize', 'New image width (pixels):', 500, { type: 'number', min: 10, max: 4000 });
        if (v === null) return;
        await replaceSelectedImages(app, async c => {
            const size = imageSizes.get(c.image);
            const w = size ? size[0] : (await createImageBitmap(await (await fetch(imageURL(c.image))).blob())).width;
            const r = await reencodeImage(c.image, v / w);
            const up = await uploadBlob(app, r.blob, 'resized');
            return { id: up.id, scale: 1 };
        });
        return 'Image(s) resized.';
    }, sel1);
    def('imagescalef', 'Scale (display only)…', [], async (doc) => {
        const v = await promptBox('Image resize', 'Percentage to show the image(s) at (applies to all uses of the image):', 50, { type: 'number', min: 5, max: 400 });
        if (v === null) return;
        const targets = new Set(doc.selCells(true).filter(c => c.image).map(c => c.image + '@' + c.imagescale));
        if (!targets.size) err('There are no images in the selection.');
        doc.addUndo(doc.root);
        for (const c of doc.allCells()) if (c.image && targets.has(c.image + '@' + c.imagescale)) c.imagescale = c.imagescale / (v / 100);
    }, sel1);
    def('imagescalen', 'Reset scale (display only)', [], async (doc) => {
        const targets = new Set(doc.selCells(true).filter(c => c.image).map(c => c.image + '@' + c.imagescale));
        if (!targets.size) err('There are no images in the selection.');
        doc.addUndo(doc.root);
        for (const c of doc.allCells()) if (c.image && targets.has(c.image + '@' + c.imagescale)) c.imagescale = 1;
    }, sel1);
    const embed = mime => async () => {
        await replaceSelectedImages(app, async c => {
            const r = await reencodeImage(c.image, 1, mime);
            const up = await uploadBlob(app, r.blob, mime === 'image/jpeg' ? 'image.jpg' : 'image.png');
            return { id: up.id, scale: c.imagescale };
        });
        return mime === 'image/jpeg' ? 'Images in selected cells have been converted to JPEG format.' : 'Images in selected cells have been converted to PNG format.';
    };
    def('imagejpeg', 'Embed as JPEG', [], embed('image/jpeg'), { needs: 'sel', title: 'Embed the image(s) in the selected cells in JPEG format (reduces data size)' });
    def('imagepng', 'Embed as PNG', [], embed('image/png'), sel1);
    def('lastimage', 'Insert last image', ['Alt+Shift+I'], (doc, sel) => {
        if (!app.lastImage) err('No image has been inserted yet.');
        doc.addUndo(sel.grid.cell);
        for (const c of doc.selCells(true)) { c.image = app.lastImage.id; c.imagescale = app.lastImage.scale; }
    }, sel1);
    def('imageremove', 'Remove image(s)', [], (doc, sel) => {
        doc.addUndo(sel.grid.cell);
        for (const c of sel.cells()) c.image = null;
    }, sel1);

    /* Navigation */
    group = 'Navigation';
    def('browse', 'Open link in browser', ['F5', 'F4'], (doc) => {
        let n = 0, msg = '';
        for (const c of doc.selected.cells()) {
            let t = c.text.trim();
            if (!t) continue;
            if (n >= 10) { msg = 'Maximum number of launches reached.'; break; }
            if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = 'https://' + t;
            if (!/^(https?|mailto|ftp|tel):/i.test(t)) { msg = 'Only web links can be opened.'; continue; }
            window.open(t, '_blank', 'noopener');
            n++;
        }
        return msg;
    }, { needs: 'sel', render: false, title: 'Opens up the text from the selected cell in the browser (should be a valid URL)' });

    /* Layout */
    group = 'Layout';
    def('vgs', 'Vertical layout with grid style rendering', ['Alt+1', 'Ctrl+Alt+1'], layrender(DS_GRID, true), sel1);
    def('vbs', 'Vertical layout with bubble style rendering', ['Alt+2', 'Ctrl+Alt+2'], layrender(DS_BUBBLE, true), sel1);
    def('vls', 'Vertical layout with line style rendering', ['Alt+3', 'Ctrl+Alt+3'], layrender(DS_LINE, true), sel1);
    def('hgs', 'Horizontal layout with grid style rendering', ['Alt+4', 'Ctrl+Alt+4'], layrender(DS_GRID, false), sel1);
    def('hbs', 'Horizontal layout with bubble style rendering', ['Alt+5', 'Ctrl+Alt+5'], layrender(DS_BUBBLE, false), sel1);
    def('hls', 'Horizontal layout with line style rendering', ['Alt+6', 'Ctrl+Alt+6'], layrender(DS_LINE, false), sel1);
    def('gs', 'Grid style rendering', ['Alt+7', 'Ctrl+Alt+7'], layrender(DS_GRID, true, false, true), sel1);
    def('bs', 'Bubble style rendering', ['Alt+8', 'Ctrl+Alt+8'], layrender(DS_BUBBLE, true, false, true), sel1);
    def('ls', 'Line style rendering', ['Alt+9', 'Ctrl+Alt+9'], layrender(DS_LINE, true, false, true), sel1);
    def('textgrid', 'Toggle vertical layout', ['Alt+0', 'Ctrl+Alt+0'], layrender(-1, true, true), { needs: 'sel', title: 'Make a hierarchy layout more vertical (default) or more horizontal' });

    /* Search & filter */
    group = 'Search';
    const openSearch = replace => () => {
        const bar = $('searchbar');
        bar.hidden = false;
        bar.classList.toggle('with-replace', !!replace || bar.classList.contains('with-replace'));
        const inp = $(replace ? 'replace-input' : 'search-input');
        const c = app.sel.getCell();
        if (!replace && !$('search-input').value && c && c.text) $('search-input').value = c.text;
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        if ($('search-input').value) app.run('searchupdate');
    };
    def('search', 'Search', ['Ctrl+F'], openSearch(false), { icon: 'search', render: false, focus: false });
    def('replace', 'Replace', ['Ctrl+H'], openSearch(true), { render: false, focus: false });
    def('searchupdate', 'Update search', [], (doc) => {
        const v = $('search-input').value;
        doc.search = settings.caseSensitiveSearch ? v : v.toLowerCase();
        const n = doc.search ? doc.allCells().filter(c => c.parent && doc.matchesSearch(c)).length : 0;
        $('search-count').textContent = doc.search ? (n ? n + ' found' : 'no matches') : '';
        if (n) {
            const cur = doc.selected.getCell();
            if (!cur || !doc.matchesSearch(cur)) {
                const m = doc.findNext(c => doc.matchesSearch(c), null);
                if (m) { doc.selected = m.parent.grid.findCell(m); makeVisible(doc); }
            }
        }
    }, { hidden: true, focus: false });
    const searchNext = reverse => (doc) => {
        if (!doc.search) {
            const c = doc.selected.getCell();
            if (!c || !c.text) err('No text to search for.');
            $('searchbar').hidden = false;
            $('search-input').value = c.text;
            doc.search = settings.caseSensitiveSearch ? c.text : c.text.toLowerCase();
        }
        const m = doc.findNext(c => doc.matchesSearch(c), doc.selected.getCell(), reverse);
        if (!m) err('No matches.');
        doc.selected = m.parent.grid.findCell(m);
        makeVisible(doc);
    };
    def('searchnext', 'Next match', ['F3'], searchNext(false), { focus: false });
    def('searchprev', 'Previous match', ['Shift+F3'], searchNext(true), { focus: false });
    def('searchclose', 'Close search', [], (doc) => {
        $('searchbar').hidden = true;
        $('searchbar').classList.remove('with-replace');
        $('search-input').value = '';
        $('search-count').textContent = '';
        doc.search = '';
    }, { hidden: true });
    const replaceOnce = jump => (doc, sel) => {
        if (!doc.search) err('No search.');
        const r = $('replace-input').value;
        doc.addUndo(sel.grid.cell);
        for (const c of sel.cells()) c.setText(replaceStr(c.text, doc.search, r));
        if (jump) {
            const m = doc.findNext(c => doc.matchesSearch(c), sel.getCell());
            if (m) { doc.selected = m.parent.grid.findCell(m); makeVisible(doc); }
        }
        return 'Text has been replaced.';
    };
    def('replaceonce', 'Replace in current selection', ['Ctrl+K'], replaceOnce(false), { needs: 'sel', focus: false });
    def('replaceoncej', 'Replace in current selection & jump next', ['Ctrl+J'], replaceOnce(true), { needs: 'sel', focus: false });
    def('replaceall', 'Replace all', [], (doc) => {
        if (!doc.search) err('No search.');
        const r = $('replace-input').value;
        doc.addUndo(doc.root);
        doc.root.walk(c => { if (c !== doc.root) c.setText(replaceStr(c.text, doc.search, r)); });
        return 'Text has been replaced.';
    }, { focus: false });
    def('casesensitive', 'Case-sensitive search', [], () => {
        app.savePrefs({ caseSensitive: !settings.caseSensitiveSearch });
        app.run('searchupdate');
    }, { check: () => settings.caseSensitiveSearch, render: false });

    group = 'Filter';
    def('filteroff', 'Turn filter off', ['Ctrl+Shift+F'], doc => { applyFilter(doc, () => false); });
    def('filters', 'Show only cells in current search', [], doc => {
        if (!doc.search) err('Search for something first.');
        applyFilter(doc, c => !doc.matchesSearch(c));
    });
    def('filterrange', 'Show last edits in specific date range…', [], async doc => {
        const r = await dateRangeDialog();
        if (!r) return;
        applyFilter(doc, c => !(c.lastedit >= r[0] && c.lastedit <= r[1]));
    });
    for (const p of [5, 10, 20, 50]) def('filter' + p, `Show ${p}% of last edits`, [], doc => editFilter(doc, p));
    def('filterm', 'Show 1% more than the last filter', [], doc => editFilter(doc, (doc.editfilter || 10) + 1));
    def('filterl', 'Show 1% less than the last filter', [], doc => editFilter(doc, (doc.editfilter || 10) - 1));
    const filterBy = f => (doc, sel) => {
        const c = sel.getCell();
        if (!c) err(ONE_CELL);
        applyFilter(doc, ci => f(ci, c));
    };
    def('filterbycellbg', 'Show cells with the same cell color', [], filterBy((ci, c) => ci.cellcolor !== c.cellcolor), sel1);
    def('filterbystyle', 'Show cells with the same style', [], filterBy((ci, c) => ci.stylebits !== c.stylebits), sel1);
    def('filterbytext', 'Show cells with the same text', [], filterBy((ci, c) => ci.text !== c.text), sel1);
    def('filternote', 'Show cells with notes', [], doc => applyFilter(doc, c => !c.note));
    def('filtermatchnext', 'Go to next filter match', ['Ctrl+F3'], doc => {
        const n = doc.findNext(c => !c.filtered, doc.selected.getCell());
        if (!n) err('No matches for filter.');
        doc.selected = n.parent.grid.findCell(n);
        makeVisible(doc);
    });

    /* View */
    group = 'View';
    def('zoomin', 'Zoom in (Ctrl+mousewheel)', ['Ctrl+PageUp', 'Ctrl+]', 'Alt+Z'], doc => { if (!doc.zoom(1)) return 'Select a cell with a grid to zoom into.'; }, { icon: 'zoomin' });
    def('zoomout', 'Zoom out (Ctrl+mousewheel)', ['Ctrl+PageDown', 'Ctrl+[', 'Alt+Shift+Z'], doc => { if (!doc.zoom(-1)) return 'Already showing the whole sheet.'; }, { icon: 'zoomout' });
    def('zoomroot', 'Zoom out to top', [], doc => { doc.drawpath = []; }, { icon: 'home' });
    def('zoomsel', 'Zoom into selected cell', [], (doc, sel) => {
        const c = sel.getCell();
        if (!c || !c.grid) err('Select a cell that has a grid.');
        doc.zoomTo(c);
    }, sel1);
    const fontsize = d => () => app.savePrefs({ defTextSize: d === 0 ? 12 : Math.max(10, Math.min(20, settings.defTextSize + d)) });
    def('incfont', 'Increase font size', ['Ctrl+.'], fontsize(1));
    def('decfont', 'Decrease font size', ['Ctrl+,'], fontsize(-1));
    def('resetfont', 'Reset font size', ['Ctrl+-'], fontsize(0));
    const cycle = d => () => {
        if (app.tabs.length < 2) return;
        const i = app.tabs.indexOf(app.tab);
        app.switchTab(app.tabs[(i + d + app.tabs.length) % app.tabs.length]);
    };
    def('nexttab', 'Next tab', ['Alt+Shift+ArrowRight', 'Ctrl+Alt+ArrowRight'], cycle(1), { render: false });
    def('prevtab', 'Previous tab', ['Alt+Shift+ArrowLeft', 'Ctrl+Alt+ArrowLeft'], cycle(-1), { render: false });
    def('fullscreen', 'Toggle fullscreen view', ['F11', 'Shift+F11'], () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    }, { render: false, noDoc: true });
    def('presentation', 'Toggle scaled presentation view', ['Shift+F12'], () => {
        app.presentation = !app.presentation;
        document.body.classList.toggle('presentation', app.presentation);
        app.fitPresentation();
        return app.presentation ? 'Now viewing the sheet scaled to fit the screen, press Shift+F12 to return to normal.' : '1:1 scale restored.';
    });
    def('darksheet', 'Dark sheet colors', [], () => app.savePrefs({ darkSheet: !app.prefs.darkSheet }), { check: () => !!app.prefs.darkSheet, noDoc: true, render: false });
    for (const [t, l] of [['auto', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']]) {
        def('theme_' + t, l, [], () => app.savePrefs({ theme: t }), { check: () => (app.prefs.theme || 'auto') === t, noDoc: true, render: false, hidden: true });
    }
    def('multiselect', 'Multi-select (tap to extend selection)', [], () => {
        app.multiSelect = !app.multiSelect;
        return app.multiSelect ? 'Multi-select on: tap cells to extend the selection.' : 'Multi-select off.';
    }, { icon: 'select', check: () => app.multiSelect });

    /* Options */
    group = 'Options';
    def('font', 'Font…', [], () => fontDialog(app, false), { noDoc: true });
    def('monofont', 'Typewriter font…', [], () => fontDialog(app, true), { noDoc: true });
    def('keys', 'Key bindings…', [], () => shortcutsDialog(app, true), { noDoc: true, render: false });
    def('defcolwidth', 'Default column width…', [], async () => {
        const v = await promptBox('Default column width', 'Default column width (in characters) for new columns:', settings.defaultColWidth, { type: 'number', min: 5, max: 1000 });
        if (v !== null) app.savePrefs({ defaultColWidth: v });
    }, { noDoc: true });
    def('bgcolor', 'Background color…', [], async doc => {
        const oldbg = doc.root.cellcolor;
        const color = await colorPicker('Background color', oldbg, app.recentColors);
        if (color === null) return;
        doc.addUndo(doc.root);
        doc.root.walk(c => { if (c.cellcolor === oldbg && (!c.parent || c.parent.cellcolor === color)) c.cellcolor = color; });
    });
    def('cursorcolor', 'Cursor color…', [], async () => {
        const cur = parseInt((app.prefs.cursorColor || '#1f6fd6').slice(1), 16);
        const color = await colorPicker('Cursor (selection) color', cur, app.recentColors);
        if (color !== null) app.savePrefs({ cursorColor: hex(color) });
    }, { noDoc: true });
    for (let i = 0; i <= 6; i++) def('round' + i, 'Roundness ' + i, [], () => app.savePrefs({ roundness: i }), { check: () => (app.prefs.roundness ?? 3) === i, noDoc: true, hidden: true });
    def('password', 'Change password…', [], () => passwordDialog(), { noDoc: true, render: false });

    /* Program */
    group = 'Program';
    def('markdata', 'Data', ['Ctrl+Alt+D'], markType(CT_DATA), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_DATA });
    def('markcode', 'Operation', ['Ctrl+Alt+O'], markType(CT_CODE), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_CODE });
    def('markvard', 'Variable assign', ['Ctrl+Alt+A'], markType(CT_VARD), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_VARD });
    def('markvaru', 'Variable read', ['Ctrl+Alt+R'], markType(CT_VARU), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_VARU });
    def('markviewh', 'Horizontal view', ['Ctrl+Alt+.'], markType(CT_VIEWH), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_VIEWH });
    def('markviewv', 'Vertical view', ['Ctrl+Alt+,'], markType(CT_VIEWV), { needs: 'sel', check: () => (app.sel.getFirst() || {}).celltype === CT_VIEWV });
    def('runprog', 'Run', ['Ctrl+Alt+F5'], doc => {
        doc.addUndo(doc.root);
        new Evaluator().run(doc.root);
        return 'Evaluation finished.';
    });
    def('clrview', 'Clear views', [], doc => {
        doc.addUndo(doc.root);
        doc.root.walk(c => { if (c.celltype === CT_VIEWH || c.celltype === CT_VIEWV) c.clear(); });
    });

    /* Help */
    group = 'Help';
    def('tutorial', 'Interactive tutorial', ['F1'], () => openExample(app, 'tutorial', 'Tutorial'), { noDoc: true, render: false });
    def('opref', 'Operation reference', ['Ctrl+Alt+F1'], () => openExample(app, 'opref', 'Operation reference'), { noDoc: true, render: false, title: 'Operations: ' + OPERATIONS.join(' ') });
    def('shortcuts', 'Keyboard shortcuts', ['Ctrl+/'], () => shortcutsDialog(app, false), { noDoc: true, render: false, icon: 'help' });
    def('website', 'TreeSheets website', [], () => { window.open('https://strlen.com/treesheets/', '_blank', 'noopener'); }, { noDoc: true, render: false });
    def('about', 'About…', [], () => alertBox('About TreeSheets Web',
        'TreeSheets Web — a personal web edition of TreeSheets, the free-form hierarchical information organizer by Wouter van Oortmerssen (strlen.com/treesheets). ' +
        'Documents are stored on your own server in SQLite and can be exchanged with the desktop app as .cts files.'), { noDoc: true, render: false });

    return C;
}

/* ---------------------------------------------------------------- menus */

export function menuTree(app) {
    const it = id => {
        const c = app.cmdById.get(id);
        if (!c) return null;
        return {
            label: c.label, title: c.title, disabled: false,
            get checked() { return c.check ? c.check() : false; },
            shortcut: (c.activeKeys && c.activeKeys[0]) || c.shortcut || '',
            run: () => app.run(id),
        };
    };
    const sep = { separator: true };
    const sub = (label, ids) => ({ label, submenu: () => ids.map(i => i === '|' ? sep : it(i)) });
    const tagsSub = () => ({
        label: 'Tags', submenu: () => {
            const tags = app.doc ? [...app.doc.tags.keys()].sort() : [];
            return [it('tagadd'), it('tagremove'), sep,
                ...(tags.length ? tags.map(t => ({ label: t, color: app.doc.tags.get(t)[0], run: () => app.run('tagset', t) })) : [{ label: '(no tags yet)', disabled: true }])];
        },
    });
    return [
        { label: 'File', items: () => [it('new'), it('open'), it('close'), sep, it('save'), it('rename'), it('duplicate'), it('history'), it('deletedoc'), sep,
            sub('Import', ['import_cts', 'import_xml', 'import_xmla', 'import_txt', 'import_csv', 'import_csvs', 'import_tab', 'import_json']),
            sub('Export', ['export_cts', '|', 'export_xml', 'export_htmlt', 'export_htmlti', 'export_htmlb', 'export_htmlo', 'export_txt', 'export_csv', 'export_json', '|', 'export_png', 'export_svg']),
            sep, it('backup'), it('backup_zip'), it('restore'), sep, it('print'), sep, it('logout')] },
        { label: 'Edit', items: () => [it('cut'), it('copy'), it('copywi'), it('copyct'), it('paste'), it('pastestyle'), sep,
            it('undo'), it('redo'), sep, it('deleteafter'), it('deletebefore'), sep,
            it('entergrid'), it('entergridn'), it('wrap'), sub('Insert row / column', ['insrowabove', 'insrowbelow', 'inscolleft', 'inscolright']), sep,
            it('fold'), it('foldall'), it('unfoldall'), sep,
            sub('Selection', ['next', 'prev', '|', 'selectall', '|', 'mleft', 'mright', 'mup', 'mdown', '|', 'sleft', 'sright', 'sup', 'sdown', '|',
                'srows', 'scleft', 'scright', '|', 'scols', 'scup', 'scdown', '|', 'parent', 'entergrid', '|', 'link', 'linkrev', 'linkimg', 'linkimgrev']),
            sub('Text editing', ['entercell', 'entercellend', 'entercellstart', 'progresscell']),
            sub('Text sizing', ['incsize', 'decsize', 'resetsize', 'minisize', '|', 'incwidth', 'decwidth', 'incwidthnh', 'decwidthnh', 'resetwidth']),
            sub('Grid borders', ['bord0', 'bord1', 'bord2', 'bord3', 'bord4', 'bord5']),
            sub('Text styles', ['bold', 'italic', 'tt', 'underline', 'strike', '|', 'alignauto', 'alignleft', 'aligncenter', 'alignright', '|', 'resetstyle', 'resetcolor', '|', 'lastcellcolor', 'lasttextcolor', 'lastbordcolor']),
            sub('Colors', ['cellcolor', 'textcolor', 'bordcolor', '|', 'lastcellcolor', 'lasttextcolor', 'lastbordcolor', 'resetcolor']),
            tagsSub(),
            sub('Grid reorganization', ['transpose', 'sort', 'sortd', 'hswap', 'hify', 'flatten']),
            sub('Images', ['image', 'imagesave', '|', 'imagescalep', 'imagescalew', 'imagescalef', 'imagescalen', '|', 'imagejpeg', 'imagepng', '|', 'lastimage', 'imageremove']),
            sub('Navigation', ['browse']),
            sub('Layout & render style', ['vgs', 'vbs', 'vls', '|', 'hgs', 'hbs', 'hls', '|', 'gs', 'bs', 'ls', '|', 'textgrid']),
            sep, it('collapse'), it('note')] },
        { label: 'Search', items: () => [it('search'), it('searchnext'), it('searchprev'), sep, it('replace'), it('replaceonce'), it('replaceoncej'), it('replaceall'), it('casesensitive'), sep,
            sub('Filter', ['filteroff', 'filters', '|', 'filterrange', 'filter5', 'filter10', 'filter20', 'filter50', 'filterm', 'filterl', '|', 'filterbycellbg', 'filterbystyle', 'filterbytext', 'filternote', '|', 'filtermatchnext'])] },
        { label: 'View', items: () => [it('zoomin'), it('zoomout'), it('zoomroot'), sep, it('incfont'), it('decfont'), it('resetfont'), sep,
            it('nexttab'), it('prevtab'), sep, it('fullscreen'), it('presentation'), sep, it('darksheet'), sub('Theme', ['theme_auto', 'theme_light', 'theme_dark']), isTouch() ? it('multiselect') : null] },
        { label: 'Options', items: () => [it('font'), it('monofont'), it('keys'), it('defcolwidth'), sep, it('bgcolor'), it('cursorcolor'),
            sub('Roundness', ['round0', 'round1', 'round2', 'round3', 'round4', 'round5', 'round6']), sep, it('password')] },
        { label: 'Program', items: () => [it('markdata'), it('markcode'), it('markvard'), it('markvaru'), it('markviewh'), it('markviewv'), sep, it('runprog'), it('clrview')] },
        { label: 'Help', items: () => [it('tutorial'), it('opref'), it('shortcuts'), sep, it('website'), it('about')] },
    ];
}

export function contextMenu(app, tagsOnly) {
    const it = id => {
        const c = app.cmdById.get(id);
        return { label: c.label, shortcut: (c.activeKeys && c.activeKeys[0]) || c.shortcut || '', run: () => app.run(id), get checked() { return c.check ? c.check() : false; } };
    };
    const tags = app.doc ? [...app.doc.tags.keys()].sort() : [];
    const tagItems = tags.map(t => ({ label: t, color: app.doc.tags.get(t)[0], run: () => app.run('tagset', t) }));
    if (tagsOnly && tagItems.length) return tagItems;
    const sep = { separator: true };
    const c = app.sel.getCell();
    return [
        it('edit'), it('cut'), it('copy'), it('paste'), sep,
        it('entergrid'), { label: 'Insert', submenu: [it('insrowabove'), it('insrowbelow'), it('inscolleft'), it('inscolright')] }, it('wrap'), it('deletecells'), sep,
        { label: 'Style', submenu: [it('bold'), it('italic'), it('underline'), it('strike'), it('tt'), sep, it('incsize'), it('decsize'), it('resetsize'), sep, it('alignleft'), it('aligncenter'), it('alignright'), it('alignauto')] },
        { label: 'Color', submenu: [it('cellcolor'), it('textcolor'), it('bordcolor'), it('resetcolor')] },
        { label: 'Layout', submenu: [it('gs'), it('bs'), it('ls'), it('textgrid'), sep, it('incwidth'), it('decwidth'), it('resetwidth')] },
        { label: 'Tags', submenu: [it('tagadd'), it('tagremove'), ...(tagItems.length ? [sep, ...tagItems] : [])] },
        it('note'), it('image'), c && c.grid ? it('fold') : null, c && c.grid ? it('zoomsel') : null,
        c && /^(https?:\/\/|www\.)/i.test(c.text.trim()) ? it('browse') : null,
    ];
}

export const TOOLBAR = [
    'new', 'open', 'backup', '|', 'undo', 'redo', '|', 'cut', 'copy', 'paste', '|', 'entergrid', 'wrap', 'fold', '|',
    'zoomin', 'zoomout', '|', 'bold', 'italic', 'underline', 'strike', 'tt', '|', 'cellcolor', 'textcolor', 'bordcolor', '|',
    'image', 'note', '|', 'search', 'shortcuts',
];

export const MOBILEBAR = ['edit', 'entergrid', 'insrowbelow', 'inscolright', 'deletecells', 'undo', 'zoomin', 'zoomout', 'multiselect'];
