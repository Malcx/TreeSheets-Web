// TreeSheets Web - server API client and download helpers.

import { el } from './ui.js';

export const CSRF = document.querySelector('meta[name="csrf-token"]').content;

/* ---------------------------------------------------------------- server API */

export async function api(action, data = {}, opts = {}) {
    const init = { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': CSRF }, keepalive: !!opts.keepalive };
    if (data instanceof FormData) init.body = data;
    else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(data);
    }
    let res;
    try {
        res = await fetch('api.php?action=' + encodeURIComponent(action), init);
    } catch (e) {
        const err = new Error('Network error: the server could not be reached.');
        err.network = true;
        throw err;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* not json */ }
    if (res.status === 401 && json && json.loggedOut) {
        location.reload();
        throw new Error('Logged out.');
    }
    if (!res.ok || !json || !json.ok) {
        const err = new Error((json && json.error) || `Request failed (${res.status}).`);
        err.status = res.status;
        err.data = json;
        throw err;
    }
    return json;
}

export function downloadURL(action, params = {}) {
    const q = new URLSearchParams({ action, t: CSRF, ...params });
    return 'api.php?' + q.toString();
}

export function triggerDownload(url, filename = '') {
    const a = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
}

export function downloadBlob(content, filename, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}


export function normalizeKey(s) {
    const parts = s.split('+');
    let key = parts.pop();
    if (key === '') key = '+';
    const mods = new Set(parts.map(p => p.toLowerCase()));
    const out = [];
    if (mods.has('ctrl') || mods.has('cmd')) out.push('Ctrl');
    if (mods.has('alt')) out.push('Alt');
    if (mods.has('shift')) out.push('Shift');
    if (key.length === 1) key = key.toUpperCase();
    out.push(key);
    return out.join('+');
}

