// TreeSheets Web - small UI toolkit: dialogs, popup menus, color picker, icons, status toasts.

import { bgr } from './model.js';
import { hex } from './render.js';

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}

/* ---------------------------------------------------------------- icons (inline SVG) */

const P = {
    menu: 'M3 6h18M3 12h18M3 18h18',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
    redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
    grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
    subgrid: 'M3 3h18v18H3zM9 9h10v10H9zM9 14h10M14 9v10',
    rowabove: 'M4 13h16v7H4zM12 3v7M8.5 6.5h7',
    rowbelow: 'M4 4h16v7H4zM12 14v7M8.5 17.5h7',
    colleft: 'M13 4h7v16h-7zM3 12h7M6.5 8.5v7',
    colright: 'M4 4h7v16H4zM14 12h7M17.5 8.5v7',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    zoomin: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6',
    zoomout: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6',
    edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
    search: 'M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4.8-4.8',
    bold: 'M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z',
    italic: 'M10 4h8M6 20h8M14 4l-4 16',
    underline: 'M7 4v7a5 5 0 0010 0V4M5 21h14',
    strike: 'M5 12h14M16 6.5C15 5 13.6 4.5 12 4.5c-2.5 0-4 1.3-4 3.2 0 4 8.5 2.6 8.5 7.6 0 2.1-1.8 3.7-4.5 3.7-2 0-3.6-.8-4.5-2.3',
    mono: 'M4 7V5h16v2M12 5v14M9 19h6',
    cellcolor: 'M5 19h14M7 15l5-11 5 11M8.8 11h6.4',
    fill: 'M4 12l8-8 8 8-8 8zM20 16c0 1.7 1 3 2 3',
    textcolor: 'M5 19h14M7 15l5-11 5 11M8.8 11h6.4',
    border: 'M4 4h16v16H4z',
    image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 100-.01',
    note: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5',
    fold: 'M6 9l6 6 6-6',
    save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 14h8v6H8z',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
    close: 'M6 6l12 12M18 6L6 18',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    select: 'M5 5h5M5 5v5M19 5h-5M19 5v5M5 19h5M5 19v-5M19 19h-5M19 19v-5',
    plus: 'M12 5v14M5 12h14',
    doc: 'M6 3h9l4 4v14H6zM15 3v4h4',
    wrap: 'M3 7h18v10H3zM7 10h10v4H7z',
    home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
    enter: 'M20 5v7a3 3 0 01-3 3H5M9 11l-4 4 4 4',
    copy: 'M8 8h12v12H8zM4 16V4h12',
    cut: 'M6 6a2.5 2.5 0 100 .01M6 18a2.5 2.5 0 100 .01M8 7l12 10M8 17L20 7',
    paste: 'M8 4h8v3H8zM6 5H5v16h14V5h-1',
    logout: 'M10 5H5v14h5M15 8l4 4-4 4M19 12H9',
    settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 4M12 17h.01',
};

export function icon(name, cls = '') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ico ' + cls);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', P[name] || P.more);
    svg.appendChild(path);
    return svg;
}

/* ---------------------------------------------------------------- status */

let statusTimer = 0;
export function status(msg, kind = '') {
    const s = document.getElementById('status-msg');
    if (!s) return;
    s.textContent = msg || '';
    s.className = kind;
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(() => { s.textContent = ''; s.className = ''; }, kind === 'error' ? 8000 : 4000);
    if (msg && kind === 'error' && isTouch()) toast(msg, kind);
}

export function toast(msg, kind = '') {
    const t = el('div', { class: 'toast ' + kind, role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

/* ---------------------------------------------------------------- dialogs */

const openDialogs = [];
export const dialogOpen = () => openDialogs.length > 0;

export function dialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onopen, cancelValue = null, className = '' }) {
    return new Promise(resolve => {
        const root = document.getElementById('dialog-root');
        const prevFocus = document.activeElement;
        const backdrop = el('div', { class: 'backdrop' });
        const box = el('div', { class: 'dialog ' + (wide ? 'wide ' : '') + className, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
        const close = v => {
            backdrop.remove();
            openDialogs.splice(openDialogs.indexOf(close), 1);
            if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
            resolve(v);
        };
        const header = el('div', { class: 'dialog-head' }, el('h2', { text: title }),
            el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(cancelValue) }, icon('close')));
        const content = el('div', { class: 'dialog-body' });
        if (typeof body === 'string') content.appendChild(el('p', { text: body }));
        else if (body) content.appendChild(body);
        const footer = el('div', { class: 'dialog-foot' });
        const getValue = b => typeof b.value === 'function' ? b.value(box) : b.value;
        for (const b of buttons) {
            footer.appendChild(el('button', {
                class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button',
                onclick: () => {
                    const v = getValue(b);
                    if (v === undefined) return; // validation failed, keep open
                    close(v);
                },
            }, b.label));
        }
        box.append(header, content);
        if (buttons.length) box.appendChild(footer);
        backdrop.appendChild(box);
        backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(cancelValue); });
        box.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(cancelValue);
            } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
                const p = buttons.find(b => b.primary);
                if (p) {
                    e.preventDefault();
                    const v = getValue(p);
                    if (v !== undefined) close(v);
                }
            }
            e.stopPropagation();
        });
        openDialogs.push(close);
        root.appendChild(backdrop);
        const focusable = box.querySelector('[autofocus], input, textarea, select') || footer.querySelector('.primary') || box;
        setTimeout(() => {
            focusable.focus();
            if (focusable.select && focusable.type !== 'number') focusable.select();
        }, 20);
        if (onopen) onopen(box, close);
    });
}

export function alertBox(title, msg) {
    return dialog({ title, body: msg, buttons: [{ label: 'OK', value: true, primary: true }] });
}

export function confirmBox(title, msg, ok = 'OK', danger = false) {
    return dialog({ title, body: msg, buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true, danger }], cancelValue: false });
}

export function promptBox(title, label, value = '', opts = {}) {
    const input = el(opts.multiline ? 'textarea' : 'input', {
        type: opts.type || 'text', value: opts.multiline ? null : String(value), autofocus: true,
        min: opts.min, max: opts.max, rows: opts.multiline ? 8 : null, placeholder: opts.placeholder,
    });
    if (opts.multiline) input.value = value;
    const body = el('label', { class: 'field' }, label, input);
    if (opts.hint) body.appendChild(el('small', { class: 'hint', text: opts.hint }));
    return dialog({
        title, body, wide: !!opts.multiline, buttons: [{ label: 'Cancel', value: null }, {
            label: opts.ok || 'OK', primary: true, value: () => {
                if (opts.type === 'number') {
                    const n = Number(input.value);
                    if (!Number.isFinite(n) || (opts.min != null && n < opts.min) || (opts.max != null && n > opts.max)) {
                        input.setCustomValidity(`Enter a number between ${opts.min} and ${opts.max}`);
                        input.reportValidity();
                        return undefined;
                    }
                    return n;
                }
                return input.value;
            },
        }],
    });
}

/* ---------------------------------------------------------------- color picker */

// The TreeSheets palette (stored as wx BGR values in the original).
export const PALETTE = [
    0xFFFFFF, 0x000000, 0x202020, 0x404040, 0x606060, 0x808080, 0xA0A0A0, 0xC0C0C0, 0xD0D0D0,
    0xE0E0E0, 0xE8E8E8, 0x000080, 0x0000FF, 0x8080FF, 0xC0C0FF, 0xC0C0E0, 0x008000, 0x00FF00,
    0x80FF80, 0xC0FFC0, 0xC0E0C0, 0x800000, 0xFF0000, 0xFF8080, 0xFFC0C0, 0xE0C0C0, 0x800080,
    0xFF00FF, 0xFF80FF, 0xFFC0FF, 0xE0C0E0, 0x008080, 0x00FFFF, 0x80FFFF, 0xC0FFFF, 0xC0E0E0,
    0x808000, 0xFFFF00, 0xFFFF80, 0xFFFFC0, 0xE0E0C0,
].map(bgr);

export function colorPicker(title, current, recent = []) {
    let chosen = current;
    const custom = el('input', { type: 'color', value: hex(current), 'aria-label': 'Custom color' });
    const preview = el('span', { class: 'swatch big', style: { background: hex(current) } });
    const hexin = el('input', { type: 'text', value: hex(current), maxlength: 7, class: 'hexin', 'aria-label': 'Hex color' });
    const pick = (c, done) => {
        chosen = c;
        preview.style.background = hex(c);
        custom.value = hex(c);
        hexin.value = hex(c);
        if (done) closeFn(c);
    };
    let closeFn = null;
    const sw = c => el('button', { type: 'button', class: 'swatch' + (c === current ? ' current' : ''), title: hex(c),
        'aria-label': hex(c), style: { background: hex(c) }, onclick: () => pick(c, true) });
    const body = el('div', { class: 'colorpicker' },
        el('div', { class: 'swatches' }, PALETTE.map(sw)),
        recent.length ? el('div', { class: 'recent' }, el('small', { text: 'Recent' }), el('div', { class: 'swatches' }, recent.map(sw))) : null,
        el('div', { class: 'custom-row' }, preview, custom, hexin));
    custom.addEventListener('input', () => pick(parseInt(custom.value.slice(1), 16), false));
    hexin.addEventListener('input', () => {
        if (/^#?[0-9a-fA-F]{6}$/.test(hexin.value)) pick(parseInt(hexin.value.replace('#', ''), 16), false);
    });
    return dialog({
        title, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: () => chosen }],
        onopen: (box, close) => { closeFn = close; },
    });
}

/* ---------------------------------------------------------------- popup menus */

let activeMenu = null;

export function closeMenus() {
    if (activeMenu) {
        activeMenu.remove();
        activeMenu = null;
        document.querySelectorAll('#menubar .open').forEach(b => b.classList.remove('open'));
    }
}

// items: [{label, shortcut, run, checked, disabled, submenu: items | () => items, separator}]
export function popupMenu(items, x, y, opts = {}) {
    closeMenus();
    const root = el('div', { class: 'menu-layer' });
    root.addEventListener('mousedown', e => { if (e.target === root) closeMenus(); });
    root.addEventListener('contextmenu', e => { e.preventDefault(); closeMenus(); });
    document.body.appendChild(root);
    activeMenu = root;
    const mobileSheet = isTouch() && window.innerWidth < 700;
    const build = (list, px, py, parentMenu, depth) => {
        const m = el('div', { class: 'menu' + (mobileSheet ? ' sheet' : ''), role: 'menu' });
        if (mobileSheet && depth > 0) {
            m.appendChild(el('button', { class: 'menu-item back', role: 'menuitem', onclick: () => { m.remove(); parentMenu.hidden = false; } },
                el('span', { class: 'mi-check' }, icon('left')), el('span', { class: 'mi-label', text: 'Back' })));
        }
        if (mobileSheet && opts.title && depth === 0) m.appendChild(el('div', { class: 'menu-title', text: opts.title }));
        const resolved = typeof list === 'function' ? list() : list;
        for (const it of resolved) {
            if (!it) continue;
            if (it.separator) { m.appendChild(el('div', { class: 'menu-sep' })); continue; }
            const b = el('button', { class: 'menu-item' + (it.disabled ? ' disabled' : ''), role: 'menuitem', type: 'button' },
                el('span', { class: 'mi-check', text: it.checked ? '✓' : '' }),
                el('span', { class: 'mi-label', text: it.label }),
                el('span', { class: 'mi-key', text: it.submenu ? '▸' : (it.shortcut || '') }));
            if (it.title) b.title = it.title;
            if (it.color !== undefined) b.querySelector('.mi-check').appendChild(el('span', { class: 'swatch tiny', style: { background: hex(it.color) } }));
            if (it.submenu) {
                const open = () => {
                    m.querySelectorAll(':scope > .menu-item.sub-open').forEach(o => o.classList.remove('sub-open'));
                    if (m._sub) m._sub.remove();
                    b.classList.add('sub-open');
                    if (mobileSheet) {
                        m.hidden = true;
                        m._sub = build(it.submenu, 0, 0, m, depth + 1);
                    } else {
                        const r = b.getBoundingClientRect();
                        m._sub = build(it.submenu, r.right - 2, r.top - 4, m, depth + 1);
                    }
                };
                b.addEventListener('click', open);
                if (!mobileSheet) b.addEventListener('mouseenter', () => { clearTimeout(m._t); m._t = setTimeout(open, 120); });
            } else {
                b.addEventListener('mouseenter', () => {
                    clearTimeout(m._t);
                    if (!mobileSheet && m._sub) m._t = setTimeout(() => { if (m._sub) { m._sub.remove(); m._sub = null; } }, 250);
                });
                b.addEventListener('click', () => {
                    if (it.disabled) return;
                    closeMenus();
                    it.run && it.run();
                });
            }
            m.appendChild(b);
        }
        root.appendChild(m);
        if (!mobileSheet) {
            const r = m.getBoundingClientRect();
            let lx = px, ly = py;
            if (lx + r.width > innerWidth - 4) lx = depth > 0 && parentMenu ? parentMenu.getBoundingClientRect().left - r.width + 2 : innerWidth - r.width - 4;
            if (ly + r.height > innerHeight - 4) ly = Math.max(4, innerHeight - r.height - 4);
            m.style.left = Math.max(4, lx) + 'px';
            m.style.top = Math.max(4, ly) + 'px';
        }
        m.addEventListener('keydown', e => {
            const btns = [...m.querySelectorAll(':scope > .menu-item')];
            const i = btns.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
            else if (e.key === 'ArrowRight' && i >= 0 && resolved.filter(Boolean)) { btns[i].click(); setTimeout(() => m._sub && m._sub.querySelector('.menu-item') && m._sub.querySelector('.menu-item').focus(), 0); }
            else if (e.key === 'ArrowLeft' && depth > 0) { e.preventDefault(); m.remove(); parentMenu._sub = null; parentMenu.querySelector('.sub-open') && parentMenu.querySelector('.sub-open').focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeMenus(); if (opts.onclose) opts.onclose(); }
            e.stopPropagation();
        });
        const first = m.querySelector('.menu-item');
        if (opts.focus !== false && first && !isTouch()) setTimeout(() => first.focus({ preventScroll: true }), 0);
        return m;
    };
    build(items, x, y, null, 0);
    return root;
}
