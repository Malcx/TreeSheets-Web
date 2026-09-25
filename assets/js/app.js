// TreeSheets Web - application controller: documents & saving, editing, input, clipboard.

import {
    Doc, Cell, Selection, settings, TSError, fillRows, countCol, splitLines, NO_SEL, ONE_CELL,
} from './model.js';
import { Renderer, imageSizes } from './render.js';
import { F_TEXT, F_HTMLT, gridToText, cellToText } from './io.js';
import {
    el, icon, status, toast, dialog, dialogOpen, confirmBox, alertBox, popupMenu, closeMenus, isTouch, isMac,
} from './ui.js';
import { buildCommands, menuTree, contextMenu, TOOLBAR, MOBILEBAR } from './commands.js';
import { api, CSRF, normalizeKey } from './api.js';

const $ = id => document.getElementById(id);
const LS = {
    get(k, d = null) { try { const v = localStorage.getItem('tsweb.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tsweb.' + k, JSON.stringify(v)); } catch (e) { /* full / private mode */ } },
    del(k) { try { localStorage.removeItem('tsweb.' + k); } catch (e) { /* ignore */ } },
};

function keyString(e) {
    let k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code && /^Digit\d$/.test(e.code) && (ctrl || e.altKey || e.shiftKey)) k = e.code.slice(5);
    else if (e.code && /^Key[A-Z]$/.test(e.code) && (ctrl || e.altKey) && !/^[a-zA-Z]$/.test(k)) k = e.code.slice(3);
    if (k === ' ') k = 'Space';
    if (k === 'Esc') k = 'Escape';
    if (k === 'Del') k = 'Delete';
    if (k.length === 1) k = k.toUpperCase();
    const out = [];
    if (ctrl) out.push('Ctrl');
    if (e.altKey) out.push('Alt');
    if (e.shiftKey && (k.length > 1 || ctrl || e.altKey)) out.push('Shift');
    out.push(k);
    return out.join('+');
}

const NATIVE_EDIT_KEYS = new Set([
    'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Shift+V', 'Backspace', 'Delete', 'Ctrl+Backspace', 'Ctrl+Delete',
    'Alt+Backspace', 'Home', 'End', 'Shift+Home', 'Shift+End', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+Shift+Home',
    'Ctrl+Shift+End', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown',
    'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+Shift+ArrowLeft', 'Ctrl+Shift+ArrowRight', 'Alt+ArrowLeft',
    'Alt+ArrowRight', 'Alt+Shift+ArrowLeft', 'Alt+Shift+ArrowRight',
]);

/* ---------------------------------------------------------------- caret helpers */

function getCaret(root) {
    const s = getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    if (!root.contains(r.startContainer)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    pre.setEnd(r.endContainer, r.endOffset);
    return [start, pre.toString().length];
}

function setCaret(root, start, end = start) {
    const r = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0, node, startSet = false, endSet = false, last = null;
    while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        if (!startSet && start <= pos + len) { r.setStart(node, start - pos); startSet = true; }
        if (startSet && end <= pos + len) { r.setEnd(node, end - pos); endSet = true; break; }
        pos += len;
        last = node;
    }
    if (!startSet) { r.selectNodeContents(root); r.collapse(false); }
    else if (!endSet) { if (last) r.setEnd(last, last.nodeValue.length); }
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
}

function caretFromPoint(root, x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || !root.contains(node)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(node, offset);
    return pre.toString().length;
}

function caretLines(root) {
    const s = getSelection();
    if (!s.rangeCount) return { first: true, last: true };
    const r = s.getRangeAt(0).cloneRange();
    r.collapse(s.focusNode === r.startContainer && s.focusOffset === r.startOffset);
    const rects = r.getClientRects();
    const rr = root.getBoundingClientRect();
    if (!rects.length) return { first: true, last: true };
    const cr = rects[0];
    const lh = cr.height || 16;
    return { first: cr.top - rr.top < lh * 0.7, last: rr.bottom - cr.bottom < lh * 0.7 };
}

const plaintextOnly = (() => {
    const d = document.createElement('div');
    try { d.contentEditable = 'plaintext-only'; } catch (e) { return false; }
    return d.contentEditable === 'plaintext-only';
})();

/* ---------------------------------------------------------------- the app */

class App {
    constructor() {
        this.tabs = [];          // open documents: {id, name, revision, doc, dirty, saving, ...}
        this.tab = null;
        this.docs = [];          // metadata of all documents on the server
        this.prefs = {};
        this.editing = null;     // {cell, tx, undoPushed}
        this.clip = null;        // internal cell clipboard {cell, text}
        this.multiSelect = false;
        this.presentation = false;
        this.lastColors = { cell: 0xFFFF80, text: 0xFF0000, border: 0x0000FF };
        this.recentColors = [];
        this.lastImage = null;
        this.renderer = new Renderer($('docroot'), $('sheet'), $('selection-overlay'));
        this.renderer.onlayoutchange = () => this.scheduleOverlay();
        this.commands = buildCommands(this);
        this.cmdById = new Map(this.commands.map(c => [c.id, c]));
        this.keymap = new Map();
    }

    get doc() { return this.tab ? this.tab.doc : null; }
    get sel() { return this.doc ? this.doc.selected : new Selection(); }

    /* ------------------------------------------------------------ startup */

    async start() {
        this.buildChrome();
        this.bindInput();
        let list;
        try {
            list = await api('list');
        } catch (e) {
            status(e.message, 'error');
            return;
        }
        this.docs = list.documents;
        this.zipAvailable = list.zip;
        this.applyPrefs(list.prefs || {});
        const session = LS.get('session', { open: [], current: null });
        let open = session.open.filter(id => this.docs.some(d => d.id === id));
        if (!open.length && this.docs.length) open = [this.docs[0].id];
        for (const id of open) await this.openDoc(id, false);
        const cur = this.tabs.find(t => t.id === session.current) || this.tabs[0];
        if (cur) this.switchTab(cur);
        else this.showEmpty();
        this.renderTabs();
        window.addEventListener('beforeunload', e => this.onBeforeUnload(e));
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushAll(true); });
        window.addEventListener('online', () => this.flushAll());
        setInterval(() => this.flushAll(), 30000);
    }

    applyPrefs(p) {
        this.prefs = p;
        settings.defTextSize = Math.max(10, Math.min(20, p.defTextSize || 12));
        settings.defaultColWidth = Math.max(5, Math.min(1000, p.defaultColWidth || 80));
        settings.caseSensitiveSearch = !!p.caseSensitive;
        if (p.lastColors) Object.assign(this.lastColors, p.lastColors);
        if (Array.isArray(p.recentColors)) this.recentColors = p.recentColors.slice(0, 12);
        const root = document.documentElement.style;
        root.setProperty('--sheet-font', p.font || 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif');
        root.setProperty('--sheet-mono', p.monoFont || 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace');
        root.setProperty('--cursor', p.cursorColor || '#1f6fd6');
        root.setProperty('--round', (p.roundness ?? 3) * 2 + 'px');
        document.body.classList.toggle('dark-sheet', !!p.darkSheet);
        document.body.dataset.theme = p.theme || 'auto';
        $('search-case').checked = settings.caseSensitiveSearch;
        this.keymap = new Map();
        const custom = p.keys || {};
        for (const c of this.commands) {
            const keys = custom[c.id] !== undefined ? (custom[c.id] ? [custom[c.id]] : []) : (c.keys || []);
            c.activeKeys = keys.map(normalizeKey);
            for (const k of c.activeKeys) if (!this.keymap.has(k)) this.keymap.set(k, c);
        }
    }

    savePrefs(patch) {
        Object.assign(this.prefs, patch);
        this.applyPrefs(this.prefs);
        clearTimeout(this.prefTimer);
        this.prefTimer = setTimeout(() => api('prefs', { prefs: this.prefs }).catch(e => status(e.message, 'error')), 600);
    }

    rememberColor(c) {
        this.recentColors = [c, ...this.recentColors.filter(x => x !== c)].slice(0, 12);
        this.savePrefs({ recentColors: this.recentColors, lastColors: this.lastColors });
    }

    /* ------------------------------------------------------------ chrome: menus & toolbars */

    buildChrome() {
        const mb = $('menubar');
        for (const m of menuTree(this)) {
            const b = el('button', { class: 'menu-top', type: 'button', text: m.label });
            const open = () => {
                const r = b.getBoundingClientRect();
                popupMenu(m.items, r.left, r.bottom, { onclose: () => b.focus() });
                b.classList.add('open');
            };
            b.addEventListener('mousedown', e => {
                e.preventDefault();
                if (b.classList.contains('open')) closeMenus(); else open();
            });
            b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(); } });
            b.addEventListener('mouseenter', () => { if (document.querySelector('#menubar .open') && !b.classList.contains('open')) open(); });
            mb.appendChild(b);
        }
        const mkbtn = (spec, cls) => {
            if (spec === '|') return el('span', { class: 'tb-sep' });
            const c = this.cmdById.get(spec.id || spec);
            const b = el('button', { class: cls, type: 'button', 'data-cmd': c.id, title: c.label + (c.keys && c.keys[0] ? ` (${c.keys[0]})` : ''), 'aria-label': c.label },
                icon(spec.icon || c.icon || 'more'));
            if (spec.text) b.appendChild(el('span', { class: 'tb-text', text: spec.text }));
            return b;
        };
        const tb = $('toolbar');
        for (const spec of TOOLBAR) tb.appendChild(mkbtn(spec, 'icon-btn'));
        const bar = $('mobilebar');
        for (const spec of MOBILEBAR) bar.appendChild(mkbtn(spec, 'mb-btn'));
        $('btn-menu').appendChild(icon('menu'));
        document.querySelectorAll('#searchbar .icon-btn').forEach(b => {
            b.appendChild(icon({ searchprev: 'up', searchnext: 'down', searchclose: 'close' }[b.dataset.cmd]));
        });
        document.addEventListener('click', e => {
            const b = e.target.closest('[data-cmd]');
            if (!b || b.closest('.dialog')) return;
            e.preventDefault();
            if (b.dataset.cmd === 'menu') return this.openMobileMenu();
            this.run(b.dataset.cmd);
        });
        // Keep focus in the editor when pressing toolbar buttons.
        document.addEventListener('mousedown', e => {
            if (e.target.closest('#toolbar [data-cmd], #mobilebar [data-cmd]')) e.preventDefault();
        });
    }

    openMobileMenu() {
        popupMenu(menuTree(this).map(m => ({ label: m.label, submenu: m.items })), 8, 48, { title: 'Menu' });
    }

    renderTabs() {
        const t = $('tabs');
        t.textContent = '';
        for (const tab of this.tabs) {
            const b = el('button', { class: 'tab' + (tab === this.tab ? ' active' : '') + (tab.dirty ? ' dirty' : ''), role: 'tab', type: 'button',
                'aria-selected': tab === this.tab ? 'true' : 'false', title: tab.name },
            el('span', { class: 'tab-name', text: tab.name }),
            el('span', { class: 'tab-close', role: 'button', 'aria-label': 'Close ' + tab.name, title: 'Close tab', text: '×' }));
            b.addEventListener('click', e => {
                if (e.target.classList.contains('tab-close')) { e.stopPropagation(); this.closeTab(tab); return; }
                if (tab === this.tab) this.run('rename'); else this.switchTab(tab);
            });
            b.addEventListener('auxclick', e => { if (e.button === 1) this.closeTab(tab); });
            t.appendChild(b);
        }
        t.appendChild(el('button', { class: 'tab tab-new', type: 'button', title: 'New sheet', 'aria-label': 'New sheet', 'data-cmd': 'new' }, icon('plus')));
        t.appendChild(el('button', { class: 'tab tab-open', type: 'button', title: 'All sheets…', 'aria-label': 'All sheets', 'data-cmd': 'open' }, icon('doc')));
        const active = t.querySelector('.active');
        if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        this.updateSaveState();
    }

    saveSession() {
        LS.set('session', { open: this.tabs.map(t => t.id), current: this.tab ? this.tab.id : null });
    }

    showEmpty() {
        this.tab = null;
        $('docroot').textContent = '';
        $('docroot').appendChild(el('div', { class: 'empty' },
            el('p', { text: 'No sheet is open.' }),
            el('button', { class: 'btn primary', 'data-cmd': 'new', type: 'button', text: 'New sheet' }), ' ',
            el('button', { class: 'btn', 'data-cmd': 'open', type: 'button', text: 'Open…' })));
        this.renderer.drawSelection(null);
        $('breadcrumb').textContent = '';
        this.renderTabs();
    }

    /* ------------------------------------------------------------ documents */

    async openDoc(id, switchto = true) {
        let tab = this.tabs.find(t => t.id === id);
        if (!tab) {
            let res;
            try {
                res = await api('get', { id });
            } catch (e) {
                status(e.message, 'error');
                return null;
            }
            const d = res.document;
            tab = { id: d.id, name: d.name, revision: d.revision, doc: null, dirty: false, saving: false, error: null };
            tab.doc = Doc.fromJSON(d.data);
            this.attachDoc(tab);
            this.tabs.push(tab);
            // A local draft newer than what the server has (e.g. saved while offline)?
            const draft = LS.get('draft.' + id);
            if (draft && draft.revision === d.revision && draft.time > d.updated * 1000) {
                const ok = await confirmBox('Unsaved changes found',
                    `This browser has changes to “${d.name}” from ${new Date(draft.time).toLocaleString()} that never reached the server. Restore them?`,
                    'Restore');
                if (ok) {
                    tab.doc = Doc.fromJSON(draft.data);
                    this.attachDoc(tab);
                    this.markDirty(tab);
                } else LS.del('draft.' + id);
            } else if (draft) LS.del('draft.' + id);
            this.initSelection(tab.doc);
        }
        if (switchto) this.switchTab(tab);
        return tab;
    }

    attachDoc(tab) {
        tab.doc.onmodified = () => this.markDirty(tab);
    }

    initSelection(doc) {
        const dr = doc.drawRoot();
        if (dr.grid) doc.selected = new Selection(dr.grid, 0, 0, 1, 1);
    }

    switchTab(tab) {
        if (this.editing) this.commitEdit();
        this.tab = tab;
        this.saveSession();
        this.renderTabs();
        this.refresh();
        this.focusSheet();
        document.title = tab.name + ' – TreeSheets';
    }

    async closeTab(tab) {
        if (tab === this.tab && this.editing) this.commitEdit();
        await this.flush(tab);
        if (tab.dirty) {
            const ok = await confirmBox('Unsaved changes', `“${tab.name}” could not be saved to the server yet. Close anyway? (A copy stays in this browser.)`, 'Close', true);
            if (!ok) return;
        }
        const i = this.tabs.indexOf(tab);
        this.tabs.splice(i, 1);
        if (tab === this.tab) {
            const next = this.tabs[Math.min(i, this.tabs.length - 1)];
            if (next) this.switchTab(next); else this.showEmpty();
        }
        this.saveSession();
        this.renderTabs();
    }

    async createDoc(name, data = null, size = 3) {
        const res = await api('create', data ? { name, data } : { name, size });
        this.docs.push(res.document);
        return this.openDoc(res.document.id);
    }

    async refreshDocList() {
        const res = await api('list');
        this.docs = res.documents;
        return this.docs;
    }

    /* ------------------------------------------------------------ saving */

    markDirty(tab) {
        tab.dirty = true;
        tab.changeCount = (tab.changeCount || 0) + 1;
        clearTimeout(tab.saveTimer);
        tab.saveTimer = setTimeout(() => this.flush(tab), 1200);
        if (!tab.firstDirty) tab.firstDirty = Date.now();
        if (Date.now() - tab.firstDirty > 10000) this.flush(tab);
        clearTimeout(tab.draftTimer);
        tab.draftTimer = setTimeout(() => this.writeDraft(tab), 400);
        this.updateSaveState();
        const t = document.querySelector('#tabs .tab.active');
        if (t && tab === this.tab) t.classList.add('dirty');
    }

    writeDraft(tab) {
        if (!tab.dirty) return;
        LS.set('draft.' + tab.id, { revision: tab.revision, time: Date.now(), data: tab.doc.toJSON() });
    }

    async flush(tab, keepalive = false) {
        clearTimeout(tab.saveTimer);
        if (!tab.dirty) return true;
        if (tab.saving) {
            tab.saveAgain = true;
            return tab.savePromise;
        }
        tab.saving = true;
        tab.firstDirty = 0;
        const count = tab.changeCount;
        const data = JSON.stringify(tab.doc.toJSON());
        this.updateSaveState();
        tab.savePromise = (async () => {
            try {
                const res = await api('save', { id: tab.id, data, revision: tab.revision }, { keepalive: keepalive && data.length < 60000 });
                tab.revision = res.revision;
                tab.error = null;
                if (tab.changeCount === count) {
                    tab.dirty = false;
                    LS.del('draft.' + tab.id);
                }
                return true;
            } catch (e) {
                tab.error = e.message;
                this.writeDraft(tab);
                if (e.status === 409) {
                    await this.resolveConflict(tab);
                } else {
                    status('Saving failed: ' + e.message, 'error');
                    clearTimeout(tab.saveTimer);
                    tab.saveTimer = setTimeout(() => this.flush(tab), 15000);
                }
                return false;
            } finally {
                tab.saving = false;
                this.updateSaveState();
                if (tab === this.tab) this.renderTabs();
                if (tab.saveAgain) {
                    tab.saveAgain = false;
                    if (tab.dirty) this.flush(tab);
                }
            }
        })();
        return tab.savePromise;
    }

    async resolveConflict(tab) {
        if (tab.resolving) return;
        tab.resolving = true;
        const choice = await dialog({
            title: 'Edited somewhere else',
            body: `“${tab.name}” was changed in another browser tab or on another device since you opened it. What should happen with your changes?`,
            buttons: [
                { label: 'Discard mine & reload', value: 'reload', danger: true },
                { label: 'Save mine as a copy', value: 'copy' },
                { label: 'Overwrite with mine', value: 'overwrite', primary: true },
            ],
            cancelValue: 'later',
        });
        tab.resolving = false;
        if (choice === 'overwrite') {
            await api('save', { id: tab.id, data: JSON.stringify(tab.doc.toJSON()), revision: tab.revision, force: true }).then(r => {
                tab.revision = r.revision;
                tab.dirty = false;
                LS.del('draft.' + tab.id);
            }).catch(e => status(e.message, 'error'));
        } else if (choice === 'copy') {
            const data = tab.doc.toJSON();
            await this.reloadTab(tab);
            await this.createDoc(tab.name + ' (my changes)', data);
        } else if (choice === 'reload') {
            await this.reloadTab(tab);
        }
        this.updateSaveState();
    }

    async reloadTab(tab) {
        const res = await api('get', { id: tab.id });
        tab.doc = Doc.fromJSON(res.document.data);
        tab.revision = res.document.revision;
        tab.dirty = false;
        LS.del('draft.' + tab.id);
        this.attachDoc(tab);
        this.initSelection(tab.doc);
        if (tab === this.tab) this.refresh();
    }

    async flushAll(keepalive = false) {
        if (this.editing) this.syncEditText();
        await Promise.all(this.tabs.map(t => this.flush(t, keepalive)));
    }

    onBeforeUnload(e) {
        if (this.editing) this.syncEditText();
        const dirty = this.tabs.filter(t => t.dirty);
        if (!dirty.length) return;
        for (const t of dirty) { this.writeDraft(t); this.flush(t, true); }
        e.preventDefault();
        e.returnValue = '';
    }

    updateSaveState() {
        const s = $('save-state');
        const t = this.tab;
        if (!t) { s.textContent = ''; return; }
        let txt, cls;
        if (t.error && t.dirty) { txt = navigator.onLine ? 'Not saved' : 'Offline'; cls = 'error'; }
        else if (t.saving) { txt = 'Saving…'; cls = 'saving'; }
        else if (t.dirty) { txt = 'Edited'; cls = 'dirty'; }
        else { txt = 'Saved'; cls = 'saved'; }
        s.textContent = txt;
        s.className = cls;
        s.title = t.error ? t.error : 'All changes are saved automatically';
    }

    /* ------------------------------------------------------------ rendering */

    refresh() {
        if (!this.doc) return;
        const doc = this.doc;
        doc.drawRoot();
        this.renderer.editing = this.editing ? this.editing.cell : null;
        this.renderer.render(doc);
        this.renderBreadcrumb();
        this.drawOverlay();
        this.updateStatusInfo();
        this.updateToolbarState();
        if (this.presentation) this.fitPresentation();
    }

    scheduleOverlay() {
        if (this.overlayPending) return;
        this.overlayPending = true;
        requestAnimationFrame(() => {
            this.overlayPending = false;
            this.drawOverlay(false);
        });
    }

    drawOverlay(scroll = true) {
        if (!this.doc) return;
        const r = this.renderer.drawSelection(this.sel, !!this.editing);
        if (r && scroll) this.scrollIntoView(r);
    }

    scrollIntoView(r) {
        const vp = $('viewport');
        const sheet = $('sheet');
        const k = this.renderer.scale;
        const ox = sheet.offsetLeft, oy = sheet.offsetTop;
        const pad = 24;
        const l = ox + r.l * k, t = oy + r.t * k, rr = ox + r.r * k, b = oy + r.b * k;
        if (b > vp.scrollTop + vp.clientHeight - pad) vp.scrollTop = Math.min(t - pad, b - vp.clientHeight + pad);
        if (t < vp.scrollTop + pad) vp.scrollTop = t - pad;
        if (rr > vp.scrollLeft + vp.clientWidth - pad) vp.scrollLeft = Math.min(l - pad, rr - vp.clientWidth + pad);
        if (l < vp.scrollLeft + pad) vp.scrollLeft = l - pad;
    }

    renderBreadcrumb() {
        const bc = $('breadcrumb');
        bc.textContent = '';
        const doc = this.doc;
        if (!doc.drawpath.length) { bc.hidden = true; return; }
        bc.hidden = false;
        const chain = [];
        for (let c = doc.drawRoot(); c; c = c.parent) chain.unshift(c);
        chain.forEach((c, i) => {
            const label = i === 0 ? '⌂' : (c.text || (c.image ? '[image]' : '…')).slice(0, 40);
            const b = el('button', { type: 'button', class: 'crumb', text: label, title: i === 0 ? 'Zoom out to the top' : c.text });
            b.addEventListener('click', () => {
                if (this.editing) this.commitEdit();
                doc.drawpath = doc.drawpath.slice(0, i);
                if (!doc.selected.grid || !doc.drawRoot().isParentOf(doc.selected.grid.cell) && doc.selected.grid.cell !== doc.drawRoot())
                    this.initSelection(doc);
                this.refresh();
            });
            if (i) bc.appendChild(el('span', { class: 'crumb-sep', text: '›' }));
            bc.appendChild(b);
        });
    }

    updateStatusInfo() {
        const info = $('status-info');
        const s = this.sel;
        if (!s.grid) { info.textContent = ''; return; }
        const c = s.getCell();
        const parts = [];
        if (s.thin()) parts.push(s.xs ? 'Row line — type to insert a row' : 'Column line — type to insert a column');
        else if (!c) parts.push(`${s.xs} × ${s.ys} cells`);
        else {
            if (c.lastedit) parts.push('Edited ' + new Date(c.lastedit).toLocaleString());
            if (c.grid) parts.push(`Grid ${c.grid.xs}×${c.grid.ys}${c.grid.folded ? ' (folded)' : ''}`);
            parts.push('Width ' + s.grid.colwidths[s.x]);
            if (c.relsize) parts.push('Size ' + (-c.relsize > 0 ? '+' : '') + (-c.relsize));
        }
        info.textContent = parts.join(' · ');
        if (c && c.note && isTouch() && !this.editing) status('Note: ' + c.note.slice(0, 200));
    }

    updateToolbarState() {
        const c = this.sel.getFirst();
        const set = (id, on) => document.querySelectorAll(`[data-cmd="${id}"]`).forEach(b => b.classList.toggle('on', !!on));
        const sb = c ? c.stylebits : 0;
        set('bold', sb & 1);
        set('italic', sb & 2);
        set('underline', sb & 8);
        set('strike', sb & 16);
        set('tt', sb & 4);
        set('multiselect', this.multiSelect);
        document.querySelectorAll('[data-cmd="undo"]').forEach(b => { b.disabled = !this.doc || !this.doc.undolist.length; });
        document.querySelectorAll('[data-cmd="redo"]').forEach(b => { b.disabled = !this.doc || !this.doc.redolist.length; });
    }

    focusSheet() {
        if (isTouch()) {
            if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) document.activeElement.blur();
            return;
        }
        const kc = $('keycatcher');
        if (document.activeElement !== kc) kc.focus({ preventScroll: true });
    }

    fitPresentation() {
        const vp = $('viewport'), sheet = $('sheet');
        sheet.style.transform = '';
        this.renderer.scale = 1;
        if (!this.presentation) return;
        const w = $('docroot').scrollWidth, h = $('docroot').scrollHeight;
        const k = Math.max(0.2, Math.min(5, Math.min((vp.clientWidth - 32) / w, (vp.clientHeight - 32) / h)));
        sheet.style.transform = `scale(${k})`;
        this.renderer.scale = k;
        this.drawOverlay(false);
    }

    /* ------------------------------------------------------------ commands */

    // Runs a command by id. Commands throw TSError for user-facing problems.
    async run(id, ...args) {
        const c = this.cmdById.get(id);
        if (!c) return;
        closeMenus();
        if (c.needsDoc !== false && !this.doc && !c.noDoc) return status('Open or create a sheet first.');
        const editKeep = this.editing && c.edit === 'keep';
        let caret = null;
        if (this.editing) {
            if (editKeep) {
                caret = getCaret(this.editing.tx) || [0, 0];
                this.syncEditText();
            } else if (c.edit !== 'ignore') this.commitEdit();
        }
        try {
            if (c.needs === 'sel' && !this.sel.grid) throw new TSError(NO_SEL);
            if (c.needs === 'cell' && !this.sel.getCell() && !this.sel.thin()) throw new TSError(ONE_CELL);
            const res = await c.run(this.doc, this.sel, { caret, args });
            if (typeof res === 'string' && res) status(res);
        } catch (e) {
            if (e instanceof TSError) status(e.message, 'warn');
            else {
                console.error(e);
                status(e.message || String(e), 'error');
            }
        }
        if (c.render !== false && this.doc) {
            if (editKeep && this.sel.getCell() === this.editing.cell) {
                const cell = this.editing.cell;
                this.editing = null;
                this.refresh();
                this.startEdit({ caret });
                void cell;
            } else {
                if (editKeep) this.editing = null;
                this.refresh();
            }
        }
        if (!this.editing && c.focus !== false && !dialogOpen()) this.focusSheet();
    }

    /* ------------------------------------------------------------ text editing */

    // opts: {replace: string} | {all: true} | {end: true} | {start: true} | {point: [x, y]} | {caret: [s, e]}
    startEdit(opts = {}) {
        const doc = this.doc;
        if (!doc) return;
        const sel = doc.selected;
        let c = sel.getCell();
        if (!c && sel.thin()) {
            c = sel.thinExpand(doc);
            this.refresh();
        }
        if (!c) return;
        if (this.editing) this.commitEdit();
        sel.enterEdit();
        this.editing = { cell: c, tx: null, undoPushed: false, original: c.text };
        if (opts.replace !== undefined) {
            doc.addUndo(c, true);
            this.editing.undoPushed = true;
            c.setText(opts.replace);
        }
        this.renderer.editing = c;
        this.renderer.rerender(c);
        const cel = this.renderer.elementFor(c);
        const tx = cel && cel.querySelector(':scope > .hdr > .tx');
        if (!tx) { this.editing = null; sel.exitEdit(); return; }
        this.editing.tx = tx;
        tx.contentEditable = plaintextOnly ? 'plaintext-only' : 'true';
        tx.spellcheck = true;
        tx.setAttribute('role', 'textbox');
        tx.setAttribute('aria-label', 'Cell text');
        tx.classList.add('editing');
        tx.addEventListener('input', this.onEditInput);
        tx.addEventListener('paste', this.onEditPaste);
        tx.addEventListener('blur', this.onEditBlur);
        tx.focus({ preventScroll: true });
        const len = c.text.length;
        if (opts.point) {
            const pos = caretFromPoint(tx, opts.point[0], opts.point[1]);
            setCaret(tx, pos === null ? len : pos);
        } else if (opts.caret) setCaret(tx, Math.min(opts.caret[0], len), Math.min(opts.caret[1], len));
        else if (opts.all) setCaret(tx, 0, len);
        else if (opts.start) setCaret(tx, 0);
        else setCaret(tx, len);
        this.drawOverlay();
        this.updateStatusInfo();
    }

    onEditInput = () => {
        this.syncEditText();
        this.scheduleOverlay();
    };

    onEditBlur = () => {
        // Clicking elsewhere in the page (not a toolbar button) ends editing.
        setTimeout(() => {
            if (!this.editing || dialogOpen()) return;
            const a = document.activeElement;
            if (a === this.editing.tx) return;
            if (a && (a.closest('.menu-layer') || a.closest('#toolbar') || a.closest('#mobilebar'))) return;
            if (a && a.id === 'keycatcher') return;
            if (a && a.matches('input, textarea, select')) this.commitEdit(false);
        }, 0);
    };

    onEditPaste = e => {
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        const files = e.clipboardData ? [...e.clipboardData.files] : [];
        if (files.length && !text) {
            e.preventDefault();
            this.commitEdit();
            this.pasteFiles(files);
            return;
        }
        if (!text) return;
        const lines = splitLines(text);
        if (lines.length > 1) {
            e.preventDefault();
            this.commitEdit();
            this.pasteText(text, true);
            return;
        }
        if (!plaintextOnly || /[\r\n]/.test(text)) {
            e.preventDefault();
            document.execCommand('insertText', false, text.replace(/[\r\n]+/g, ' '));
        }
    };

    syncEditText() {
        const ed = this.editing;
        if (!ed || !ed.tx) return;
        let t = ed.tx.textContent;
        if (t.includes('\n') && !ed.original.includes('\n')) t = t.replace(/\n+$/, '');
        if (t === ed.cell.text) return;
        if (!ed.undoPushed) {
            this.doc.addUndo(ed.cell, true);
            ed.undoPushed = true;
        }
        ed.cell.setText(t);
        this.doc.modified();
    }

    commitEdit(refocus = true) {
        const ed = this.editing;
        if (!ed) return;
        this.syncEditText();
        this.endEditDom();
        this.doc.selected.exitEdit();
        this.renderer.rerender(ed.cell);
        this.drawOverlay(false);
        this.updateStatusInfo();
        this.updateToolbarState();
        if (refocus) this.focusSheet();
    }

    cancelEdit() {
        const ed = this.editing;
        if (!ed) return;
        this.endEditDom();
        this.doc.selected.exitEdit();
        if (ed.undoPushed && this.doc.lastUndoSameCellTextEdit(ed.cell)) {
            this.doc.undo();
            this.doc.redolist.pop();
        }
        this.refresh();
        this.focusSheet();
    }

    endEditDom() {
        const ed = this.editing;
        this.editing = null;
        this.renderer.editing = null;
        if (ed.tx) {
            ed.tx.removeEventListener('input', this.onEditInput);
            ed.tx.removeEventListener('paste', this.onEditPaste);
            ed.tx.removeEventListener('blur', this.onEditBlur);
            ed.tx.contentEditable = 'false';
        }
    }

    // Keys while editing text; returns true if handled.
    handleEditKey(e, ks) {
        const ed = this.editing;
        const doc = this.doc;
        const tx = ed.tx;
        const moveSel = (dx, dy) => {
            this.commitEdit();
            const s = doc.selected;
            const g = s.grid;
            if (s.x + dx >= 0 && s.x + dx < g.xs && s.y + dy >= 0 && s.y + dy < g.ys) {
                s.x += dx;
                s.y += dy;
            }
            this.drawOverlay();
            this.updateStatusInfo();
        };
        switch (ks) {
            case 'Enter': moveSel(0, 1); return true;
            case 'Ctrl+Enter': moveSel(0, 1); doc.selected.x = 0; this.drawOverlay(); return true;
            case 'Alt+Enter': moveSel(1, 0); return true;
            case 'Escape': this.cancelEdit(); return true;
            case 'Tab':
            case 'Shift+Tab':
                this.commitEdit();
                doc.selected.next(ks === 'Shift+Tab');
                this.startEdit({ all: true });
                return true;
            case 'ArrowUp':
            case 'ArrowDown': {
                const l = caretLines(tx);
                if (ks === 'ArrowUp' ? l.first : l.last) { moveSel(0, ks === 'ArrowUp' ? -1 : 1); return true; }
                return false;
            }
            case 'ArrowLeft':
            case 'ArrowRight': {
                const c = getCaret(tx);
                if (!c || c[0] !== c[1]) return false;
                if (ks === 'ArrowLeft' && c[0] === 0) { moveSel(-1, 0); return true; }
                if (ks === 'ArrowRight' && c[0] === tx.textContent.length) { moveSel(1, 0); return true; }
                return false;
            }
        }
        if (NATIVE_EDIT_KEYS.has(ks)) return false;
        const cmd = this.keymap.get(ks);
        if (cmd) {
            this.run(cmd.id);
            return true;
        }
        return false;
    }

    /* ------------------------------------------------------------ input */

    bindInput() {
        document.addEventListener('keydown', e => this.onKeyDown(e), true);
        const vp = $('viewport');
        vp.addEventListener('pointerdown', e => this.onPointerDown(e));
        vp.addEventListener('pointermove', e => this.onPointerMove(e));
        window.addEventListener('pointerup', e => this.onPointerUp(e));
        window.addEventListener('pointercancel', () => { this.drag = null; clearTimeout(this.longPress); });
        vp.addEventListener('click', e => this.onClick(e));
        vp.addEventListener('dblclick', e => this.onDblClick(e));
        vp.addEventListener('contextmenu', e => this.onContextMenu(e));
        vp.addEventListener('wheel', e => this.onWheel(e), { passive: false });
        vp.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
        vp.addEventListener('drop', e => this.onDrop(e));
        const kc = $('keycatcher');
        kc.addEventListener('copy', e => this.onCopy(e, false));
        kc.addEventListener('cut', e => this.onCopy(e, true));
        kc.addEventListener('paste', e => this.onPaste(e));
        kc.addEventListener('input', () => { kc.value = ''; });
        window.addEventListener('resize', () => {
            if (this.presentation) this.fitPresentation();
            this.scheduleOverlay();
        });
        const si = $('search-input');
        si.addEventListener('input', () => this.run('searchupdate'));
        $('search-case').addEventListener('change', () => {
            this.savePrefs({ caseSensitive: $('search-case').checked });
            this.run('searchupdate');
        });
    }

    onKeyDown(e) {
        if (dialogOpen()) return;
        if (document.querySelector('.menu-layer')) {
            if (e.key === 'Escape') { closeMenus(); e.preventDefault(); }
            return;
        }
        if (e.isComposing || e.keyCode === 229) return;
        const ks = keyString(e);
        const t = e.target;
        if (this.editing && t === this.editing.tx) {
            if (this.handleEditKey(e, ks)) { e.preventDefault(); e.stopPropagation(); }
            return;
        }
        const infield = t && t.matches && t.matches('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]') && t.id !== 'keycatcher';
        if (infield) {
            if (t.id === 'search-input' || t.id === 'replace-input') {
                if (ks === 'Enter' || ks === 'F3') { e.preventDefault(); this.run(t.id === 'replace-input' ? 'replaceonce' : 'searchnext'); }
                else if (ks === 'Shift+Enter' || ks === 'Shift+F3') { e.preventDefault(); this.run('searchprev'); }
                else if (ks === 'Escape') { e.preventDefault(); this.run('searchclose'); }
            }
            return;
        }
        if (t && t.id === 'keycatcher' && (ks === 'Ctrl+C' || ks === 'Ctrl+X')) {
            // Give the browser something selected, so it fires the copy/cut event we handle.
            t.value = '.';
            t.select();
            return;
        }
        if (!this.doc && !['Ctrl+N', 'Ctrl+O', 'Alt+N', 'F1'].includes(ks)) return;
        const cmd = this.keymap.get(ks);
        if (cmd) {
            e.preventDefault();
            this.run(cmd.id);
            return;
        }
        // Typing on a selected cell starts editing it, replacing its text (like a spreadsheet).
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !(e.altKey && !isMac) && this.doc && this.sel.grid) {
            e.preventDefault();
            this.startEdit({ replace: e.key });
        }
    }

    cellAt(x, y) {
        const t = document.elementFromPoint(x, y);
        if (!t || !$('docroot').contains(t)) return null;
        return this.renderer.cellFromElement(t);
    }

    // Thin selection when clicking close to the edge of a cell (or in the gap between cells).
    edgeHit(target, cx, cy, touch) {
        const doc = this.doc;
        const dr = doc.drawRoot();
        const T = touch ? 0 : 4;
        let gridEl = target.classList.contains('grid') ? target : null;
        let cellEl = target.closest('.cell');
        if (gridEl) {
            // In the gap/border of a grid: use the nearest child cell.
            let best = null, bd = Infinity;
            for (const ch of gridEl.children) {
                const r = ch.getBoundingClientRect();
                const dx = Math.max(r.left - cx, 0, cx - r.right), dy = Math.max(r.top - cy, 0, cy - r.bottom);
                const d = dx * dx + dy * dy;
                if (d < bd) { bd = d; best = ch; }
            }
            if (!best) return null;
            cellEl = best;
        } else if (!cellEl || T === 0) return null;
        const c = cellEl._cell;
        if (!c || c === dr || !c.parent) return null;
        const r = cellEl.getBoundingClientRect();
        const g = c.parent.grid, p = g.find(c);
        const dt = cy - r.top, db = r.bottom - cy, dl = cx - r.left, drr = r.right - cx;
        const m = Math.min(dt, db, dl, drr);
        if (!gridEl && m > T) return null;
        if (m === dt) return new Selection(g, p.x, p.y, 1, 0);
        if (m === db) return new Selection(g, p.x, p.y + 1, 1, 0);
        if (m === dl) return new Selection(g, p.x, p.y, 0, 1);
        return new Selection(g, p.x + 1, p.y, 0, 1);
    }

    selectCellAt(e, touch) {
        const doc = this.doc;
        const target = e.target;
        const thin = this.edgeHit(target, e.clientX, e.clientY, touch);
        if (thin) {
            doc.selected = thin;
            this.anchor = null;
            this.afterSelect();
            return null;
        }
        const c = this.renderer.cellFromElement(target);
        const dr = doc.drawRoot();
        if (!c || c === dr || !c.parent) return null;
        const cs = c.parent.grid.findCell(c);
        if ((e.shiftKey || (touch && this.multiSelect)) && doc.selected.grid && (this.anchor || doc.selected.getFirst())) {
            const anchor = this.anchor && this.anchor.grid ? this.anchor : doc.selected.grid.findCell(doc.selected.getFirst());
            doc.selected = Selection.merge(anchor, cs);
            this.anchor = anchor;
            this.afterSelect();
            return null;
        }
        const was = doc.selected.getCell() === c;
        doc.selected = cs;
        this.anchor = cs;
        this.afterSelect();
        return { cs, was };
    }

    afterSelect() {
        this.drawOverlay();
        this.updateStatusInfo();
        this.updateToolbarState();
    }

    onPointerDown(e) {
        if (!this.doc || e.button !== 0) return;
        const t = e.target;
        if (this.editing && this.editing.tx.contains(t)) return;
        if (!$('docroot').contains(t)) return;
        if (e.pointerType !== 'mouse') {
            // Touch/pen: select on tap (click), so scrolling doesn't change the selection.
            this.touchStart = { x: e.clientX, y: e.clientY, t: Date.now() };
            clearTimeout(this.longPress);
            this.longPress = setTimeout(() => {
                if (!this.touchStart) return;
                this.touchStart = null;
                this.suppressClick = true;
                this.selectCellAt(e, true);
                this.showContextMenu(e.clientX, e.clientY);
            }, 550);
            return;
        }
        if (this.editing) this.commitEdit();
        const r = this.selectCellAt(e, false);
        if (r) {
            this.drag = { anchor: r.cs, moved: false, enterEdit: r.was, x: e.clientX, y: e.clientY };
            e.preventDefault();
            this.focusSheet();
        } else this.focusSheet();
    }

    onPointerMove(e) {
        if (this.touchStart && Math.hypot(e.clientX - this.touchStart.x, e.clientY - this.touchStart.y) > 10) {
            this.touchStart = null;
            clearTimeout(this.longPress);
        }
        const d = this.drag;
        if (!d || e.pointerType !== 'mouse' || !(e.buttons & 1)) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
        const c = this.cellAt(e.clientX, e.clientY);
        const dr = this.doc.drawRoot();
        if (!c || c === dr || !c.parent || !dr.isParentOf(c)) return;
        const s = Selection.merge(d.anchor, c.parent.grid.findCell(c));
        d.moved = true;
        if (!s.eqLoc(this.doc.selected)) {
            this.doc.selected = s;
            this.afterSelect();
        }
    }

    onPointerUp(e) {
        clearTimeout(this.longPress);
        const d = this.drag;
        this.drag = null;
        if (d && !d.moved && d.enterEdit && e.pointerType === 'mouse') this.startEdit({ point: [e.clientX, e.clientY] });
    }

    onClick(e) {
        if (!this.doc) return;
        if (this.suppressClick) { this.suppressClick = false; return; }
        if (!this.touchStart) return; // mouse clicks are handled on pointerdown
        this.touchStart = null;
        clearTimeout(this.longPress);
        if (this.editing && this.editing.tx.contains(e.target)) return;
        if (this.editing) this.commitEdit(false);
        const r = this.selectCellAt(e, true);
        if (r && r.was && !this.multiSelect) this.startEdit({ point: [e.clientX, e.clientY] });
    }

    onDblClick(e) {
        if (!this.doc || isTouch()) return;
        if (this.editing && this.editing.tx.contains(e.target)) return;
        const c = this.renderer.cellFromElement(e.target);
        if (!c || c === this.doc.drawRoot()) return;
        if (this.sel.getCell() === c) this.startEdit({ point: [e.clientX, e.clientY] });
    }

    onContextMenu(e) {
        if (!this.doc) return;
        if (this.editing && this.editing.tx.contains(e.target)) return;
        e.preventDefault();
        if (e.pointerType === 'touch' || this.suppressClick) return;
        const c = this.renderer.cellFromElement(e.target);
        if (c && c !== this.doc.drawRoot() && !this.sel.contains(c)) this.selectCellAt(e, false);
        this.showContextMenu(e.clientX, e.clientY, e.ctrlKey);
    }

    showContextMenu(x, y, tagsOnly = false) {
        if (this.editing) this.commitEdit();
        popupMenu(contextMenu(this, tagsOnly), x, y, { title: 'Cell' });
    }

    onWheel(e) {
        if (!this.doc) return;
        const zoom = e.ctrlKey || e.metaKey;
        if (!zoom && !e.shiftKey && !e.altKey) return;
        if (e.shiftKey && !this.sel.grid) return;
        e.preventDefault();
        this.wheelAcc = (this.wheelAcc || 0) + (e.deltaY || e.deltaX);
        const step = e.deltaMode === 1 ? 1 : 60;
        if (Math.abs(this.wheelAcc) < step) return;
        const dir = this.wheelAcc < 0 ? 1 : -1;
        this.wheelAcc = 0;
        if (zoom) {
            // Zoom into the cell under the mouse, like TreeSheets' hover zoom.
            if (dir > 0) {
                const c = this.cellAt(e.clientX, e.clientY);
                if (c && c.parent && c !== this.doc.drawRoot() && !this.sel.contains(c) && !(this.sel.grid && c.isParentOf(this.sel.grid.cell))) {
                    this.doc.selected = c.parent.grid.findCell(c);
                }
            }
            this.run(dir > 0 ? 'zoomin' : 'zoomout');
        } else if (e.altKey) this.run(dir > 0 ? 'incwidth' : 'decwidth');
        else this.run(dir > 0 ? 'incsize' : 'decsize');
    }

    async onDrop(e) {
        const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
        if (!files.length || !this.doc) return;
        e.preventDefault();
        const cts = files.filter(f => /\.cts$/i.test(f.name));
        if (cts.length) {
            for (const f of cts) await this.importCTS(f);
            return;
        }
        const c = this.cellAt(e.clientX, e.clientY);
        if (c && c.parent) this.doc.selected = c.parent.grid.findCell(c);
        await this.pasteFiles(files);
    }

    /* ------------------------------------------------------------ clipboard */

    clipboardPayload(cut) {
        const doc = this.doc, s = doc.selected;
        if (!s.grid || s.thin()) return null;
        const c = s.getCell();
        const text = gridToText(s.grid, s, 0, F_TEXT, doc, false, doc.drawRoot());
        const html = '<table>' + gridToText(s.grid, s, 0, F_HTMLT, doc, true, doc.drawRoot()) + '</table>';
        const cellclip = c ? c.clone(null) : s.grid.cloneSel(s);
        this.clip = { cell: cellclip, text };
        void cut;
        return { text, html, json: JSON.stringify(cellclip.toJSON()) };
    }

    onCopy(e, cut) {
        if (!this.doc) return;
        const p = this.clipboardPayload(cut);
        if (!p) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', p.text);
        e.clipboardData.setData('text/html', p.html);
        try { e.clipboardData.setData('application/x-treesheets', p.json); } catch (err) { /* ignore */ }
        if (cut) this.run('deletecells');
        else status('Copied.');
    }

    async copyToClipboard(cut, format = null) {
        const p = this.clipboardPayload(cut);
        if (!p) throw new TSError("This operation doesn't work on thin selections.");
        let text = p.text;
        if (format === 'continuous') {
            text = this.doc.selCells(true).filter(c => c.text).map(c => c.text).join(' ') + ' ';
            this.clip = null;
        }
        try {
            if (navigator.clipboard && window.ClipboardItem && format !== 'continuous') {
                let html = p.html;
                if (format === 'images') {
                    const { collectImages } = await import('./io.js');
                    const imgs = await collectImages(this.sel.cells());
                    const s = this.sel;
                    html = '<table>' + (await import('./io.js')).gridToText(s.grid, s, 0, 'htmlti', this.doc, true, this.doc.drawRoot(), imgs) + '</table>';
                }
                await navigator.clipboard.write([new ClipboardItem({
                    'text/plain': new Blob([text], { type: 'text/plain' }),
                    'text/html': new Blob([html], { type: 'text/html' }),
                })]);
            } else await navigator.clipboard.writeText(text);
        } catch (err) {
            // Clipboard API unavailable (e.g. plain http): keep the internal clipboard only.
            status('Copied inside TreeSheets (the system clipboard is not available here).');
        }
        if (cut) this.run('deletecells');
        return cut ? '' : 'Copied.';
    }

    async pasteFromSystem() {
        let text = '';
        try {
            if (navigator.clipboard && navigator.clipboard.read) {
                const items = await navigator.clipboard.read();
                for (const it of items) {
                    const img = it.types.find(t => t.startsWith('image/'));
                    if (img) {
                        const blob = await it.getType(img);
                        return this.pasteFiles([new File([blob], 'pasted.' + img.split('/')[1], { type: img })]);
                    }
                    if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
                }
            } else if (navigator.clipboard) text = await navigator.clipboard.readText();
        } catch (err) {
            if (this.clip) return this.pasteCellClip();
            throw new TSError('Clipboard access was denied. Use Ctrl+V (⌘V) to paste.');
        }
        if (text) return this.pasteText(text);
        if (this.clip) return this.pasteCellClip();
    }

    onPaste(e) {
        if (!this.doc) return;
        e.preventDefault();
        const dt = e.clipboardData;
        const json = dt.getData('application/x-treesheets');
        const text = dt.getData('text/plain');
        const files = [...dt.files];
        if (json && (!text || !this.clip || this.clip.text !== text)) {
            try {
                this.clip = { cell: Cell.fromJSON(JSON.parse(json)), text };
            } catch (err) { /* ignore */ }
        }
        if (text) this.pasteText(text);
        else if (files.length) this.pasteFiles(files);
        else if (this.clip) this.pasteCellClip();
    }

    pasteText(text, fromEdit = false) {
        const doc = this.doc;
        if (!doc.selected.grid) return status(NO_SEL, 'warn');
        if (this.clip && this.clip.text === text) return this.pasteCellClip();
        const pastemode = doc.selected.pasteMode();
        const c = doc.selected.thinExpand(doc);
        if (!c) return status(ONE_CELL, 'warn');
        const lines = splitLines(text);
        if (lines.length === 1) {
            doc.addUndo(c);
            c.setText(fromEdit ? c.text + lines[0] : lines[0].trim());
        } else if (lines.length > 1) {
            doc.addUndo(c.parent);
            c.grid = null;
            fillRows(c.addGrid(), lines, countCol(lines[0]), 0, 0);
            if (!c.hasText()) c.grid.mergeWithParent(c.parent.grid, doc.selected, pastemode);
        }
        this.refresh();
    }

    pasteCellClip() {
        const doc = this.doc;
        const s = doc.selected;
        if (!s.grid) return status(NO_SEL, 'warn');
        const pastemode = s.pasteMode();
        const c = s.thinExpand(doc);
        if (!c) return status(ONE_CELL, 'warn');
        const o = this.clip.cell;
        doc.addUndo(c.parent);
        c.note = o.note;
        if (o.hasText()) {
            c.cellcolor = o.cellcolor;
            c.textcolor = o.textcolor;
            c.stylebits = o.stylebits;
            c.text = o.text;
            c.runs = o.runs ? o.runs.map(r => r.slice()) : null;
            c.relsize = o.relsize;
            c.wasEdited();
        }
        if (o.image) { c.image = o.image; c.imagescale = o.imagescale; }
        if (o.grid) {
            c.grid = o.grid.clone(c);
            if (!c.hasText()) c.grid.mergeWithParent(c.parent.grid, s, pastemode);
        }
        this.refresh();
    }

    async uploadImage(file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('csrf', CSRF);
        const res = await api('upload_image', fd);
        imageSizes.set(res.id, [res.width, res.height]);
        return res;
    }

    async pasteFiles(files) {
        const doc = this.doc;
        const imgs = files.filter(f => /^image\//.test(f.type));
        if (!imgs.length) return status('Only images can be pasted into cells.', 'warn');
        if (!doc.selected.grid) return status(NO_SEL, 'warn');
        status('Uploading image…');
        try {
            const res = await this.uploadImage(imgs[0]);
            const c = doc.selected.thinExpand(doc) || doc.selected.getFirst();
            if (!c) return;
            doc.addUndo(c);
            c.image = res.id;
            c.imagescale = res.width > 800 ? res.width / 800 : 1;
            c.wasEdited();
            this.lastImage = { id: res.id, scale: c.imagescale };
            this.refresh();
            status('Image added.');
        } catch (e) {
            status(e.message, 'error');
        }
    }

    async importCTS(file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('csrf', CSRF);
        status('Importing ' + file.name + '…');
        const res = await api('import_cts', fd);
        this.docs.push(res.document);
        await this.openDoc(res.document.id);
        status('Imported ' + file.name + '.');
    }

    pickFile(accept, multiple = false) {
        return new Promise(resolve => {
            const input = $('file-input');
            input.value = '';
            input.accept = accept;
            input.multiple = multiple;
            input.onchange = () => resolve([...input.files]);
            input.click();
        });
    }
}

export const app = new App();
window.tsapp = app; // handy for debugging from the console
app.start();

