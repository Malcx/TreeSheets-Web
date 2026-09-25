// TreeSheets Web - rendering the document as nested DOM grids.
//
// Every cell becomes a .cell element holding an optional header (.hdr: image + text) and an
// optional sub-grid (.grid, a CSS grid with one track per column). CSS grid sizing gives the same
// "always the most compact layout" behaviour as TreeSheets' own layout engine.

import {
    settings, minTextSize, maxTextSize, STYLE_BOLD, STYLE_ITALIC, STYLE_FIXED, STYLE_UNDERLINE,
    STYLE_STRIKE, CT_CODE, CT_VARD, CT_VARU, CT_VIEWH, CT_VIEWV, DS_GRID, DS_BUBBLE, DS_LINE,
    ALIGN_LEFT, ALIGN_CENTER, ALIGN_RIGHT,
} from './model.js';

export const hex = c => '#' + (c & 0xFFFFFF).toString(16).padStart(6, '0');

// Program cell type colors (see TreeSheets Cell::Render).
const CT_COLORS = { [CT_VARD]: 0x8080FF, [CT_VARU]: 0xA0A0FF, [CT_VIEWH]: 0x80FF80, [CT_VIEWV]: 0x80FF80, [CT_CODE]: 0xFF8080 };

export function darken(c, f) {
    const r = ((c >> 16) & 0xFF) * f, g = ((c >> 8) & 0xFF) * f, b = (c & 0xFF) * f;
    return (r << 16) | (g << 8) | b;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
function isRTL(t) {
    for (const ch of t) {
        if (RTL.test(ch)) return true;
        if (LTR.test(ch)) return false;
    }
    return false;
}

export function textSizePt(depth, relsize) {
    return Math.max(minTextSize(), Math.min(maxTextSize(), settings.defTextSize - depth - relsize));
}

export function imageURL(id) {
    return 'api.php?action=image&id=' + encodeURIComponent(id);
}

export const imageSizes = new Map(); // id -> [w, h] natural pixel size

export class Renderer {
    constructor(root, sheet, overlay) {
        this.root = root;
        this.sheet = sheet;
        this.scale = 1;
        this.editing = null; // the cell being text edited always shows a header
        this.overlay = overlay;
        this.doc = null;
        this.els = new WeakMap(); // cell -> element
    }

    render(doc) {
        this.doc = doc;
        const dr = doc.drawRoot();
        this.drawroot = dr;
        this.root.textContent = '';
        this.root.appendChild(this.renderCell(dr, 0, settings.defaultColWidth, true));
    }

    // Re-renders a single cell (and its subtree) in place.
    rerender(cell) {
        const old = this.els.get(cell);
        if (!old || !old.isConnected || !this.doc) return this.render(this.doc);
        if (cell === this.drawroot || !this.drawroot.isParentOf(cell)) return this.render(this.doc);
        const depth = cell.depth() - this.drawroot.depth();
        const el = this.renderCell(cell, depth, cell.colWidth(), false);
        old.replaceWith(el);
    }

    elementFor(cell) {
        const el = this.els.get(cell);
        return el && el.isConnected ? el : null;
    }

    cellFromElement(el) {
        const ce = el && el.closest ? el.closest('.cell') : null;
        return ce ? ce._cell : null;
    }

    renderCell(c, depth, colwidth, isroot) {
        const doc = this.doc;
        const el = document.createElement('div');
        el.className = 'cell';
        el._cell = c;
        this.els.set(c, el);

        let cellcolor = CT_COLORS[c.celltype] ?? c.cellcolor;
        let textcolor = c.textcolor;
        const tag = doc.tags.get(c.text);
        if (tag) [cellcolor, textcolor] = tag;
        const parentcolor = this.parentColor(c, isroot);
        const pds = !isroot && c.parent ? c.parent.drawstyle : DS_GRID;

        el.classList.add('ds' + c.drawstyle);
        if (!c.vert) el.classList.add('horiz');
        if (pds === DS_GRID) {
            el.style.backgroundColor = hex(cellcolor);
        } else if (c.hasContent()) {
            // Bubble / line style: the cell (or its text) is drawn as a rounded blob, a bit darker
            // than its parent when it has the same color, so it stands out.
            const bc = cellcolor === parentcolor ? darken(cellcolor, 0.9) : cellcolor;
            el.style.setProperty('--blob', hex(bc));
            el.classList.add(pds === DS_BUBBLE ? 'bubble' : 'lineblob');
        }
        if (c.note && !isroot) {
            el.classList.add('has-note');
            el.title = c.note;
        }
        if (doc.search && doc.matchesSearch(c)) el.classList.add('match');
        if (c.filtered && !c.grid) el.classList.add('filtered');

        const size = textSizePt(depth, c.relsize);
        const gridshown = c.grid && (!c.grid.folded || isroot);
        if (c.hasHeader() || !c.grid || c === this.editing) {
            el.appendChild(this.renderHeader(c, size, textcolor, colwidth));
        }
        if (gridshown) {
            el.appendChild(this.renderGrid(c, depth));
        } else if (c.grid) {
            el.classList.add('folded');
            const f = document.createElement('div');
            f.className = 'fold-badge';
            f.textContent = '▸ ' + c.grid.xs + '×' + c.grid.ys;
            f.style.fontSize = Math.max(8, size * 0.8) + 'pt';
            el.appendChild(f);
        }
        return el;
    }

    parentColor(c, isroot) {
        if (isroot || !c.parent) return -1;
        let p = c.parent;
        while (p && p.drawstyle === DS_LINE && p !== this.drawroot) p = p.parent;
        if (!p) return -1;
        const tag = this.doc.tags.get(p.text);
        return tag ? tag[0] : (CT_COLORS[p.celltype] ?? p.cellcolor);
    }

    renderHeader(c, size, textcolor, colwidth) {
        const hdr = document.createElement('div');
        hdr.className = 'hdr';
        hdr.style.fontSize = (size * 4 / 3).toFixed(2) + 'px';
        hdr.style.color = hex(textcolor);
        hdr.style.maxWidth = colwidth + 'ch';
        if (size <= minTextSize()) hdr.classList.add('tiny');
        const sb = c.stylebits;
        if (sb & STYLE_BOLD) hdr.style.fontWeight = 'bold';
        if (sb & STYLE_ITALIC) hdr.style.fontStyle = 'italic';
        if (sb & STYLE_FIXED) hdr.classList.add('mono');
        const deco = decoration(sb);
        if (deco) hdr.style.textDecoration = deco;
        const align = c.align === ALIGN_LEFT ? 'left' : c.align === ALIGN_CENTER ? 'center'
            : c.align === ALIGN_RIGHT ? 'right' : (isRTL(c.text) ? 'right' : '');
        if (align) hdr.style.textAlign = align;
        if (isRTL(c.text)) hdr.dir = 'rtl';
        if (c.image) {
            const img = document.createElement('img');
            img.className = 'cimg';
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            const setsize = (w, h) => {
                img.style.width = (w / c.imagescale) + 'px';
                img.style.height = (h / c.imagescale) + 'px';
            };
            const known = imageSizes.get(c.image);
            if (known) setsize(...known);
            img.addEventListener('load', () => {
                imageSizes.set(c.image, [img.naturalWidth, img.naturalHeight]);
                setsize(img.naturalWidth, img.naturalHeight);
                if (this.onlayoutchange) this.onlayoutchange();
            }, { once: true });
            img.src = imageURL(c.image);
            hdr.appendChild(img);
            hdr.classList.add('has-img');
        }
        const tx = document.createElement('span');
        tx.className = 'tx';
        fillText(tx, c);
        hdr.appendChild(tx);
        return hdr;
    }

    renderGrid(c, depth) {
        const g = c.grid;
        const ge = document.createElement('div');
        ge.className = 'grid gds' + c.drawstyle;
        ge.style.gridTemplateColumns = `repeat(${g.xs}, auto)`;
        ge.style.setProperty('--bc', hex(g.bordercolor));
        ge.style.setProperty('--sp', g.spacing + 'px');
        for (let y = 0; y < g.ys; y++)
            for (let x = 0; x < g.xs; x++)
                ge.appendChild(this.renderCell(g.C(x, y), depth + 1, g.colwidths[x], false));
        return ge;
    }

    /* ------------------------------------------------------------ selection overlay */

    // Bounding box of an element relative to the sheet.
    rect(el) {
        const r = el.getBoundingClientRect(), s = this.sheet.getBoundingClientRect(), k = this.scale;
        return { l: (r.left - s.left) / k, t: (r.top - s.top) / k, r: (r.right - s.left) / k, b: (r.bottom - s.top) / k };
    }

    selectionRect(sel) {
        if (!sel.grid) return null;
        const g = sel.grid;
        const cellrect = (x, y) => {
            const el = this.elementFor(g.C(x, y));
            return el ? this.rect(el) : null;
        };
        if (sel.thin()) {
            if (sel.ys === 0) {
                // Horizontal line above row sel.y, spanning columns x..x+xs-1.
                let l = Infinity, r = -Infinity, yy = null;
                for (let x = sel.x; x < sel.x + sel.xs; x++) {
                    const cr = sel.y < g.ys ? cellrect(x, sel.y) : cellrect(x, g.ys - 1);
                    if (!cr) return null;
                    l = Math.min(l, cr.l);
                    r = Math.max(r, cr.r);
                    yy = sel.y < g.ys ? cr.t : cr.b;
                }
                return { thin: 'h', l, r, t: yy - 2, b: yy + 2 };
            }
            let t = Infinity, b = -Infinity, xx = null;
            for (let y = sel.y; y < sel.y + sel.ys; y++) {
                const cr = sel.x < g.xs ? cellrect(sel.x, y) : cellrect(g.xs - 1, y);
                if (!cr) return null;
                t = Math.min(t, cr.t);
                b = Math.max(b, cr.b);
                xx = sel.x < g.xs ? cr.l : cr.r;
            }
            return { thin: 'v', l: xx - 2, r: xx + 2, t, b };
        }
        const a = cellrect(sel.x, sel.y), z = cellrect(sel.x + sel.xs - 1, sel.y + sel.ys - 1);
        if (!a || !z) return null;
        return { l: Math.min(a.l, z.l), t: Math.min(a.t, z.t), r: Math.max(a.r, z.r), b: Math.max(a.b, z.b) };
    }

    drawSelection(sel, editing) {
        const ov = this.overlay;
        const r = sel ? this.selectionRect(sel) : null;
        if (!r) {
            ov.hidden = true;
            return null;
        }
        ov.hidden = false;
        ov.className = r.thin ? 'thin' : editing ? 'editing' : '';
        const pad = r.thin ? 0 : 1;
        ov.style.left = (r.l - pad) + 'px';
        ov.style.top = (r.t - pad) + 'px';
        ov.style.width = (r.r - r.l + pad * 2) + 'px';
        ov.style.height = (r.b - r.t + pad * 2) + 'px';
        return r;
    }
}

function decoration(sb) {
    const d = [];
    if (sb & STYLE_UNDERLINE) d.push('underline');
    if (sb & STYLE_STRIKE) d.push('line-through');
    return d.join(' ');
}

// Fills a text span with the cell text, applying rich text runs.
export function fillText(tx, c) {
    tx.textContent = '';
    const t = c.text;
    if (!c.runs || !c.runs.length) {
        tx.textContent = t;
        return;
    }
    let pos = 0;
    for (const [s, l, st, col] of c.runs) {
        if (s > pos) tx.appendChild(document.createTextNode(t.slice(pos, s)));
        const sp = document.createElement('span');
        sp.textContent = t.slice(s, s + l);
        sp.style.fontWeight = st & STYLE_BOLD ? 'bold' : 'normal';
        sp.style.fontStyle = st & STYLE_ITALIC ? 'italic' : 'normal';
        if (st & STYLE_FIXED) sp.className = 'mono';
        sp.style.textDecoration = decoration(st) || 'none';
        if (col >= 0) sp.style.color = hex(col);
        tx.appendChild(sp);
        pos = s + l;
    }
    if (pos < t.length) tx.appendChild(document.createTextNode(t.slice(pos)));
}
