// TreeSheets Web - document model.
//
// A faithful port of the data structures and grid operations of TreeSheets
// (https://github.com/aardappel/treesheets, zlib license): cells hold text and optionally a
// grid of child cells, grids are xs * ys arrays of cells stored row major.

export const STYLE_BOLD = 1, STYLE_ITALIC = 2, STYLE_FIXED = 4, STYLE_UNDERLINE = 8, STYLE_STRIKE = 16;
export const CT_DATA = 0, CT_CODE = 1, CT_VARD = 2, CT_VIEWH = 3, CT_VARU = 4, CT_VIEWV = 5;
export const DS_GRID = 0, DS_BUBBLE = 1, DS_LINE = 2;
export const ALIGN_AUTO = 0, ALIGN_LEFT = 1, ALIGN_CENTER = 2, ALIGN_RIGHT = 3;
export const PASTE_FIT = 0, PASTE_INSERTROWS = 1, PASTE_INSERTCOLUMNS = 2;

export const CELLCOLOR_DEFAULT = 0xFFFFFF;
export const TEXTCOLOR_DEFAULT = 0x000000;
export const BORDERCOLOR_DEFAULT = 0xA0A0A0;
export const TAGTEXTCOLOR_DEFAULT = 0xFF0000;
export const SPACING_DEFAULT = 3;
export const MIN_COLWIDTH = 5;
export const MAX_GRID_CELLS = 4 * 1024 * 1024;

// Global (per user) settings, see app.js prefs.
export const settings = {
    defaultColWidth: 80,
    defTextSize: 12,
    caseSensitiveSearch: false,
};
export const minTextSize = () => settings.defTextSize - 8;
export const maxTextSize = () => settings.defTextSize + 32;

export class TSError extends Error {}
const fail = msg => { throw new TSError(msg); };

/* ---------------------------------------------------------------- Cell */

export class Cell {
    constructor(parent = null, clonefrom = null, grid = null) {
        this.parent = parent;
        this.grid = grid;
        if (grid) grid.cell = this;
        this.text = '';
        this.relsize = parent ? parent.relsize : 0;
        this.stylebits = 0;
        this.cellcolor = CELLCOLOR_DEFAULT;
        this.textcolor = TEXTCOLOR_DEFAULT;
        this.celltype = CT_DATA;
        this.drawstyle = DS_GRID;
        this.align = ALIGN_AUTO;
        this.note = '';
        this.image = null;       // image id (sha1 hex) or null
        this.imagescale = 1;     // display scale: displayed width = pixel width / scale
        this.lastedit = 0;       // ms since epoch
        this.runs = null;        // rich text: [[start, len, stylebits, color or -1], ...]
        this.vert = parent ? parent.vert : true; // "verticaltextandgrid": text above grid
        this.filtered = false;
        if (clonefrom) this.cloneStyleFrom(clonefrom);
    }

    cloneStyleFrom(o) {
        this.cellcolor = o.cellcolor;
        this.textcolor = o.textcolor;
        this.vert = o.vert;
        this.drawstyle = o.drawstyle;
        this.align = o.align;
        this.stylebits = o.stylebits;
    }

    hasText() { return this.text !== ''; }
    hasTextSize() { return this.hasText() || this.relsize !== 0; }
    hasTextState() { return this.hasTextSize() || this.image !== null; }
    hasHeader() { return this.hasText() || this.image !== null; }
    hasContent() { return this.hasHeader() || this.grid !== null; }

    depth() { return this.parent ? this.parent.depth() + 1 : 0; }
    isParentOf(c) { return c.parent === this || (c.parent !== null && this.isParentOf(c.parent)); }
    ancestor(i) { return i ? this.parent.ancestor(i - 1) : this; }

    clone(parent = null) {
        const c = new Cell(parent, this);
        c.text = this.text;
        c.relsize = this.relsize;
        c.celltype = this.celltype;
        c.note = this.note;
        c.image = this.image;
        c.imagescale = this.imagescale;
        c.lastedit = this.lastedit;
        c.runs = this.runs ? this.runs.map(r => r.slice()) : null;
        if (this.grid) c.grid = this.grid.clone(c);
        return c;
    }

    clear() {
        this.grid = null;
        this.setText('');
        this.image = null;
    }

    wasEdited() { this.lastedit = Date.now(); }

    // Changes the text, keeping rich text runs attached to the characters they styled.
    setText(t) {
        t = String(t);
        if (t === this.text) return;
        if (this.runs && this.runs.length) this.runs = adjustRuns(this.text, t, this.runs);
        this.text = t;
        this.wasEdited();
    }

    colWidth() {
        const pg = this.parent && this.parent.grid;
        const p = pg && pg.find(this);
        return p ? pg.colwidths[p.x] : settings.defaultColWidth;
    }

    addGrid(xs = 1, ys = 1) {
        if (!this.grid) {
            this.grid = new Grid(xs, ys, this);
            this.grid.initCells(this);
            if (this.parent) this.grid.cloneStyleFrom(this.parent.grid);
        }
        return this.grid;
    }

    relSize(dir, zoomdepth) {
        this.relsize = Math.max(Math.min(this.relsize + dir, settings.defTextSize - minTextSize() + zoomdepth),
            settings.defTextSize - maxTextSize() - zoomdepth);
        if (this.grid) this.grid.relSize(dir, zoomdepth);
    }

    // The smallest relsize is actually the biggest text.
    minRelsize() {
        let rs = Infinity;
        if (this.grid) rs = this.grid.minRelsize(rs);
        else if (this.hasText()) rs = Math.min(rs, this.relsize);
        return rs;
    }

    setGridTextLayout(ds, vert, noset) {
        if (!noset) this.vert = vert;
        if (ds !== -1) this.drawstyle = ds;
        if (this.grid) this.grid.setGridTextLayout(ds, vert, noset, this.grid.selectAll());
    }

    maxDepthLeaves(curdepth, acc) {
        acc.maxdepth = Math.max(curdepth, acc.maxdepth);
        if (this.grid) this.grid.maxDepthLeaves(curdepth + 1, acc);
        else acc.leaves++;
    }

    // Visits this cell and all descendants (pre-order). Return false from f to skip children.
    walk(f) {
        if (f(this) === false) return;
        if (this.grid) for (const c of this.grid.cells) c.walk(f);
    }

    findExact(s) {
        if (this.text === s) return this;
        return this.grid ? this.grid.findExact(s) : null;
    }

    getNum() {
        const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(this.text);
        return m ? parseFloat(m[0]) : NaN;
    }

    getStrictNum() {
        const t = this.text.trim();
        if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
        const d = parseFloat(t);
        return Number.isFinite(d) ? d : null;
    }

    setNum(d) {
        let s = d.toFixed(10);
        if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
        if (s === '-0') s = '0';
        this.setText(s);
    }

    /* Serialization to the compact JSON format shared with the server (see lib/cts.php). */
    toJSON() {
        const o = {};
        if (this.text !== '') o.t = this.text;
        if (this.stylebits) o.s = this.stylebits;
        if (this.relsize) o.r = this.relsize;
        if (this.cellcolor !== CELLCOLOR_DEFAULT) o.cc = this.cellcolor;
        if (this.textcolor !== TEXTCOLOR_DEFAULT) o.tc = this.textcolor;
        if (this.celltype) o.ct = this.celltype;
        if (this.drawstyle) o.ds = this.drawstyle;
        if (this.align) o.al = this.align;
        if (this.note !== '') o.n = this.note;
        if (this.image) {
            o.im = this.image;
            if (this.imagescale !== 1) o.isc = this.imagescale;
        }
        if (this.lastedit) o.le = this.lastedit;
        if (this.runs && this.runs.length) o.ru = this.runs;
        if (!this.vert) o.hv = 0;
        if (this.grid) o.g = this.grid.toJSON();
        return o;
    }

    static fromJSON(o, parent = null) {
        const c = new Cell(parent);
        o = o || {};
        c.text = typeof o.t === 'string' ? o.t : '';
        c.stylebits = (o.s | 0) & 31;
        c.relsize = o.r | 0;
        c.cellcolor = o.cc != null ? o.cc & 0xFFFFFF : CELLCOLOR_DEFAULT;
        c.textcolor = o.tc != null ? o.tc & 0xFFFFFF : TEXTCOLOR_DEFAULT;
        c.celltype = o.ct | 0;
        c.drawstyle = o.ds | 0;
        c.align = o.al | 0;
        c.note = typeof o.n === 'string' ? o.n : '';
        c.image = typeof o.im === 'string' ? o.im : null;
        c.imagescale = o.isc > 0 ? o.isc : 1;
        c.lastedit = +o.le || 0;
        c.runs = Array.isArray(o.ru) && o.ru.length ? sanitizeRuns(o.ru, c.text.length) : null;
        c.vert = o.hv !== 0;
        if (o.g && o.g.xs > 0 && o.g.ys > 0) c.grid = Grid.fromJSON(o.g, c);
        return c;
    }
}

function sanitizeRuns(runs, len) {
    const out = [];
    let pos = 0;
    for (const r of runs) {
        if (!Array.isArray(r) || r.length < 4) continue;
        let [s, l, st, col] = r.map(v => v | 0);
        s = Math.max(s, pos);
        l = Math.min(l, len - s);
        if (l > 0) {
            out.push([s, l, st & 31, col < 0 ? -1 : col & 0xFFFFFF]);
            pos = s + l;
        }
    }
    return out.length ? out : null;
}

// Per character [stylebits, color] (null = base style) <-> runs.
function runsToChars(runs, len) {
    const a = new Array(len).fill(null);
    for (const [s, l, st, col] of runs) for (let i = s; i < s + l && i < len; i++) a[i] = [st, col];
    return a;
}

function charsToRuns(a) {
    const runs = [];
    for (let i = 0; i < a.length;) {
        if (!a[i]) { i++; continue; }
        let j = i + 1;
        while (j < a.length && a[j] && a[j][0] === a[i][0] && a[j][1] === a[i][1]) j++;
        runs.push([i, j - i, a[i][0], a[i][1]]);
        i = j;
    }
    return runs.length ? runs : null;
}

export function adjustRuns(oldt, newt, runs) {
    let p = 0;
    while (p < oldt.length && p < newt.length && oldt[p] === newt[p]) p++;
    let s = 0;
    while (s < oldt.length - p && s < newt.length - p &&
        oldt[oldt.length - 1 - s] === newt[newt.length - 1 - s]) s++;
    const oc = runsToChars(runs, oldt.length);
    const ins = newt.length - p - s;
    const inherit = p > 0 ? oc[p - 1] : null;
    const nc = oc.slice(0, p).concat(new Array(ins).fill(inherit), oc.slice(oldt.length - s));
    return charsToRuns(nc);
}

// Sets (or toggles) a style bit on a range of the text, as rich text runs.
export function toggleRunStyle(cell, bit, start, end) {
    const a = runsToChars(cell.runs || [], cell.text.length);
    let all = true;
    for (let i = start; i < end; i++) if (!(((a[i] ? a[i][0] : cell.stylebits) & bit))) all = false;
    for (let i = start; i < end; i++) {
        const cur = a[i] || [cell.stylebits, -1];
        a[i] = [all ? cur[0] & ~bit : cur[0] | bit, cur[1]];
        if (a[i][0] === cell.stylebits && a[i][1] === -1) a[i] = null;
    }
    cell.runs = charsToRuns(a);
    cell.wasEdited();
}

export function setRunColor(cell, color, start, end) {
    const a = runsToChars(cell.runs || [], cell.text.length);
    for (let i = start; i < end; i++) {
        const cur = a[i] || [cell.stylebits, -1];
        a[i] = [cur[0], color === cell.textcolor ? -1 : color];
        if (a[i][0] === cell.stylebits && a[i][1] === -1) a[i] = null;
    }
    cell.runs = charsToRuns(a);
    cell.wasEdited();
}

/* ---------------------------------------------------------------- Grid */

export class Grid {
    constructor(xs, ys, cell = null) {
        this.xs = xs;
        this.ys = ys;
        this.cell = cell;
        this.cells = new Array(xs * ys).fill(null);
        this.bordercolor = BORDERCOLOR_DEFAULT;
        this.spacing = SPACING_DEFAULT; // user_grid_outer_spacing
        this.folded = false;
        this.horiz = false;
        this.initColWidths();
        this.setOrient();
    }

    C(x, y) { return this.cells[x + y * this.xs]; }
    setC(x, y, c) { this.cells[x + y * this.xs] = c; }

    initCells(clonestylefrom = null) {
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = new Cell(this.cell, clonestylefrom);
    }

    cloneStyleFrom(o) { this.bordercolor = o.bordercolor; }

    initColWidths() {
        const w = this.cell ? this.cell.colWidth() : settings.defaultColWidth;
        this.colwidths = new Array(this.xs).fill(w);
    }

    setOrient() {
        if (this.xs > this.ys) this.horiz = true;
        if (this.ys > this.xs) this.horiz = false;
    }

    clone(newcell) {
        const g = new Grid(this.xs, this.ys);
        g.cell = newcell;
        g.bordercolor = this.bordercolor;
        g.spacing = this.spacing;
        g.folded = this.folded;
        g.horiz = this.horiz;
        g.colwidths = this.colwidths.slice();
        for (let i = 0; i < this.cells.length; i++) g.cells[i] = this.cells[i].clone(newcell);
        return g;
    }

    cloneSel(sel) {
        const cl = new Cell(null, sel.grid.cell, new Grid(sel.xs, sel.ys));
        this.forSel(sel, (c, x, y) => cl.grid.setC(x - sel.x, y - sel.y, c.clone(cl)));
        for (let i = 0; i < sel.xs; i++) cl.grid.colwidths[i] = this.colwidths[sel.x + i];
        return cl;
    }

    find(c) {
        const i = this.cells.indexOf(c);
        return i < 0 ? null : { x: i % this.xs, y: Math.floor(i / this.xs) };
    }

    findCell(c) {
        const p = this.find(c);
        return p ? new Selection(this, p.x, p.y, 1, 1) : new Selection();
    }

    selectAll() { return new Selection(this, 0, 0, this.xs, this.ys); }

    forSel(sel, f) {
        for (let y = sel.y; y < sel.y + sel.ys; y++)
            for (let x = sel.x; x < sel.x + sel.xs; x++) f(this.C(x, y), x, y);
    }

    forSelRev(sel, f) {
        for (let y = sel.y + sel.ys - 1; y >= sel.y; y--)
            for (let x = sel.x + sel.xs - 1; x >= sel.x; x--) f(this.C(x, y), x, y);
    }

    reParent(p) {
        this.cell = p;
        for (const c of this.cells) c.parent = p;
    }

    insertCells(dx, dy, nxs, nys, nc = null) {
        const ocells = this.cells;
        this.xs += nxs;
        this.ys += nys;
        this.cells = new Array(this.xs * this.ys).fill(null);
        this.setOrient();
        const inserted = (x, y) => (nxs > 0 && x >= dx && x < dx + nxs) || (nys > 0 && y >= dy && y < dy + nys);
        let opos = 0;
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++)
                if (!inserted(x, y)) this.setC(x, y, ocells[opos++]);
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++) {
                if (!inserted(x, y)) continue;
                if (nc) {
                    this.setC(x, y, nc);
                    nc = null;
                } else {
                    const sx = nxs !== 0 ? (dx === 0 ? nxs : Math.max(0, Math.min(dx - 1, this.xs - 1))) : x;
                    const sy = nys !== 0 ? (dy === 0 ? nys : Math.max(0, Math.min(dy - 1, this.ys - 1))) : y;
                    const colcell = sx < this.xs && sy < this.ys ? this.C(sx, sy) : null;
                    const c = new Cell(this.cell, colcell);
                    if (colcell) c.relsize = colcell.relsize;
                    this.setC(x, y, c);
                }
            }
        if (dx >= 0 && nxs > 0) {
            const w = this.cell ? this.cell.colWidth() : settings.defaultColWidth;
            this.colwidths.splice(dx, 0, ...new Array(nxs).fill(w));
        }
    }

    deleteCells(dx, dy, nxs, nys) {
        const ncells = [];
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++)
                if (x !== dx && y !== dy) ncells.push(this.C(x, y));
        this.cells = ncells;
        this.xs += nxs;
        this.ys += nys;
        if (dx >= 0) this.colwidths.splice(dx, 1);
        this.setOrient();
    }

    // Returns false if the grid deleted itself, in which case it may not be used any further.
    multiCellDeleteSub(doc, sel) {
        this.forSel(sel, c => c.clear());
        let delhoriz = true, delvert = true;
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++)
                if (this.C(x, y).hasContent()) {
                    if (y >= sel.y && y < sel.y + sel.ys) delhoriz = false;
                    if (x >= sel.x && x < sel.x + sel.xs) delvert = false;
                }
        if (delhoriz && (!delvert || sel.xs >= sel.ys)) {
            if (sel.ys === this.ys) return !this.delSelf(doc, sel);
            for (let i = 0; i < sel.ys; i++) this.deleteCells(-1, sel.y, 0, -1);
            sel.ys = 0;
            sel.xs = 1;
        } else if (delvert) {
            if (sel.xs === this.xs) return !this.delSelf(doc, sel);
            for (let i = 0; i < sel.xs; i++) this.deleteCells(sel.x, -1, -1, 0);
            sel.xs = 0;
            sel.ys = 1;
        } else if (sel.getCell()) {
            sel.enterEdit();
        }
        return true;
    }

    // Returns whether the grid detached itself from its cell.
    delSelf(doc, s) {
        const drawroot = doc.drawRoot();
        if (doc.drawpath.length && drawroot.parent === this.cell) {
            doc.drawpath.pop();
        }
        if (!this.cell.parent) return false; // can't delete the root's grid
        const ns = this.cell.parent.grid.findCell(this.cell);
        s.set(ns);
        this.cell.grid = null;
        return true;
    }

    move(dx, dy, sel) {
        const swap = (c, x, y) => {
            const nx = (x + dx + this.xs) % this.xs, ny = (y + dy + this.ys) % this.ys;
            const t = this.C(nx, ny);
            this.setC(nx, ny, c);
            this.setC(x, y, t);
        };
        if (dx < 0 || dy < 0) {
            for (let y = sel.y; y < sel.y + sel.ys; y++)
                for (let x = sel.x; x < sel.x + sel.xs; x++) swap(this.C(x, y), x, y);
        } else {
            for (let y = sel.y + sel.ys - 1; y >= sel.y; y--)
                for (let x = sel.x + sel.xs - 1; x >= sel.x; x--) swap(this.C(x, y), x, y);
        }
    }

    add(c) {
        c.parent = this.cell;
        if (this.horiz) this.insertCells(this.xs, -1, 1, 0, c);
        else this.insertCells(-1, this.ys, 0, 1, c);
    }

    // Pastes this grid into the parent grid p at sel, never overwriting content (see TreeSheets
    // Grid::MergeWithParent for the rules).
    mergeWithParent(p, sel, pastemode = PASTE_FIT) {
        const selfcell = p.C(sel.x, sel.y);
        this.cell.grid = null;
        this.cell = null;
        const isempty = c => c === selfcell || (c && !c.hasText() && !c.grid && !c.image);
        const firstconflict = columns => {
            const n = columns ? this.xs : this.ys, m = columns ? this.ys : this.xs;
            for (let k = 0; k < n; k++)
                for (let l = 0; l < m; l++) {
                    const tx = sel.x + (columns ? k : l), ty = sel.y + (columns ? l : k);
                    if (tx < p.xs && ty < p.ys && !isempty(p.C(tx, ty))) return k;
                }
            return n;
        };
        let insertrows = 0, insertcolumns = 0;
        if (pastemode === PASTE_INSERTROWS) insertrows = this.ys - 1;
        else if (pastemode === PASTE_INSERTCOLUMNS) insertcolumns = this.xs - 1;
        else {
            const rows = this.ys - firstconflict(false), columns = this.xs - firstconflict(true);
            if (columns < rows || (columns === rows && this.xs > this.ys)) insertcolumns = columns;
            else insertrows = rows;
        }
        if (insertrows > 0) p.insertCells(-1, sel.y + this.ys - insertrows, 0, insertrows);
        if (insertcolumns > 0) p.insertCells(sel.x + this.xs - insertcolumns, -1, insertcolumns, 0);
        if (sel.x + this.xs > p.xs) p.insertCells(p.xs, -1, sel.x + this.xs - p.xs, 0);
        if (sel.y + this.ys > p.ys) p.insertCells(-1, p.ys, 0, sel.y + this.ys - p.ys);
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++) {
                const c = this.C(x, y);
                p.setC(x + sel.x, y + sel.y, c);
                c.parent = p.cell;
            }
        sel.grid = p;
        sel.xs += this.xs - 1;
        sel.ys += this.ys - 1;
        sel.exitEdit();
    }

    relSize(dir, zoomdepth, sel = null) {
        if (sel) this.forSel(sel, c => c.relSize(dir, zoomdepth));
        else for (const c of this.cells) c.relSize(dir, zoomdepth);
    }

    minRelsize(rs) {
        for (const c of this.cells) rs = Math.min(rs, c.minRelsize());
        return rs;
    }

    allHaveStyle(sel, sb) {
        let all = true;
        this.forSel(sel, c => { if ((c.stylebits & sb) !== sb) all = false; });
        return all;
    }

    setGridTextLayout(ds, vert, noset, sel) {
        this.forSel(sel, c => c.setGridTextLayout(ds, vert, noset));
    }

    isTable() { return this.cells.every(c => !c.grid); }

    transpose() {
        const tr = new Array(this.xs * this.ys);
        for (let y = 0; y < this.ys; y++)
            for (let x = 0; x < this.xs; x++) tr[y + x * this.ys] = this.C(x, y);
        this.cells = tr;
        [this.xs, this.ys] = [this.ys, this.xs];
        this.setOrient();
        const width = this.colwidths[this.colwidths.length - 1];
        this.colwidths.length = Math.min(this.colwidths.length, this.xs);
        while (this.colwidths.length < this.xs) this.colwidths.push(width);
    }

    sort(sel, descending) {
        const idx = [...Array(sel.ys).keys()];
        const coll = new Intl.Collator(undefined, { sensitivity: 'accent', numeric: false });
        idx.sort((i, j) => {
            for (let k = 0; k < this.xs; k++) {
                const col = (k + sel.x) % this.xs;
                const cmp = coll.compare(this.C(col, sel.y + i).text.toLowerCase(), this.C(col, sel.y + j).text.toLowerCase());
                if (cmp) return descending ? -cmp : cmp;
            }
            return 0;
        });
        const nc = [];
        for (const i of idx) for (let c = 0; c < this.xs; c++) nc.push(this.C(c, sel.y + i));
        for (let i = 0; i < nc.length; i++) this.cells[sel.y * this.xs + i] = nc[i];
    }

    findExact(s) {
        for (const c of this.cells) {
            const f = c.findExact(s);
            if (f) return f;
        }
        return null;
    }

    hierarchySwap(tag) {
        let selcell = null;
        let done = false;
        for (;;) {
            let found = null;
            for (const c of this.cells) {
                if (c.grid && !done) {
                    found = c.grid.findExact(tag);
                    if (found) break;
                }
            }
            if (!found) break;
            const f = found;
            // Add all parent tags as extra hierarchy inside the cell.
            for (let p = f.parent; p !== this.cell; p = p.parent) {
                if (p.text === tag) done = true;
                const t = new Cell(f, p);
                t.text = p.text;
                t.relsize = p.relsize;
                t.runs = p.runs ? p.runs.map(r => r.slice()) : null;
                t.image = p.image;
                t.imagescale = p.imagescale;
                t.lastedit = p.lastedit;
                t.note = p.note;
                t.grid = f.grid;
                if (t.grid) t.grid.reParent(t);
                f.grid = new Grid(1, 1, f);
                f.grid.cells[0] = t;
            }
            // Remove cell from parent, recursively if parent becomes empty.
            for (let r = f; r && r !== this.cell;) r = r.parent.grid.deleteTagParent(r, this.cell, f);
            // Merge newly constructed hierarchy at this level.
            selcell = this.mergeTagCell(f, selcell);
        }
        return selcell ? this.findCell(selcell) : this.selectAll();
    }

    deleteTagParent(tag, basecell, found) {
        const next = tag.parent;
        const pos = this.find(tag);
        if (this.xs * this.ys === 1) {
            if (this.cell !== basecell) this.cell.grid = null;
            return next;
        }
        if (this.ys > 1) this.deleteCells(-1, pos.y, 0, -1);
        else this.deleteCells(pos.x, -1, -1, 0);
        return null;
    }

    mergeTagCell(f, selcell) {
        for (const c of this.cells) {
            if (c.text === f.text) {
                if (!selcell) selcell = c;
                if (f.grid) {
                    if (c.grid) f.grid.mergeTagAll(c);
                    else {
                        c.grid = f.grid;
                        c.grid.reParent(c);
                        f.grid = null;
                    }
                }
                return selcell;
            }
        }
        if (!selcell) selcell = f;
        this.add(f);
        return selcell;
    }

    mergeTagAll(into) {
        for (const c of this.cells.slice()) into.grid.mergeTagCell(c, into);
    }

    hierarchify(doc) {
        for (let y = 0; y < this.ys; y++) {
            let rest = null;
            if (this.xs > 1) rest = this.cloneSel(new Selection(this, 1, y, this.xs - 1, 1));
            const c = this.C(0, y);
            let merged = false;
            for (let prevy = 0; prevy < y; prevy++) {
                const prev = this.C(0, prevy);
                if (prev.text === c.text) {
                    if (rest) {
                        prev.grid.mergeRow(rest.grid);
                        rest = null;
                    }
                    const s = new Selection(this, 0, y, this.xs, 1);
                    if (!this.multiCellDeleteSub(doc, s)) return;
                    y--;
                    merged = true;
                    break;
                }
            }
            if (!merged && rest) {
                c.grid = rest.grid;
                c.grid.reParent(c);
            }
        }
        const s = new Selection(this, 1, 0, this.xs - 1, this.ys);
        if (this.xs > 1 && !this.multiCellDeleteSub(doc, s)) return;
        for (const c of this.cells) if (c.grid && c.grid.xs > 1) c.grid.hierarchify(doc);
    }

    mergeRow(tm) {
        this.insertCells(-1, this.ys, 0, 1);
        for (let x = 0; x < this.xs; x++) {
            const c = tm.C(x, 0);
            this.setC(x, this.ys - 1, c);
            c.parent = this.cell;
        }
    }

    maxDepthLeaves(curdepth, acc) {
        for (const c of this.cells) c.maxDepthLeaves(curdepth, acc);
    }

    flatten(curdepth, cury, g) {
        for (const c of this.cells) {
            if (c.grid) {
                cury = c.grid.flatten(curdepth + 1, cury, g);
            } else {
                let ic = c;
                for (let i = curdepth; i >= 0; i--) {
                    const dest = g.C(i, cury);
                    dest.text = ic.text;
                    dest.stylebits = ic.stylebits;
                    dest.runs = ic.runs ? ic.runs.map(r => r.slice()) : null;
                    dest.relsize = ic.relsize;
                    dest.image = ic.image;
                    dest.imagescale = ic.imagescale;
                    dest.lastedit = ic.lastedit;
                    ic = ic.parent;
                }
                cury++;
            }
        }
        return cury;
    }

    resizeColWidths(dir, sel, hierarchical) {
        for (let x = sel.x; x < sel.x + sel.xs; x++) {
            this.colwidths[x] = Math.max(this.colwidths[x] + dir * 5, MIN_COLWIDTH);
            if (hierarchical)
                for (let y = 0; y < this.ys; y++) {
                    const g = this.C(x, y).grid;
                    if (g) g.resizeColWidths(dir, g.selectAll(), hierarchical);
                }
        }
    }

    setStyles(sel, o) {
        this.forSel(sel, c => {
            c.cellcolor = o.cellcolor;
            c.textcolor = o.textcolor;
            c.stylebits = o.stylebits;
            c.align = o.align;
            c.image = o.image;
            c.imagescale = o.imagescale;
            c.note = o.note;
            c.runs = null;
        });
    }

    toJSON() {
        const o = { xs: this.xs, ys: this.ys };
        if (this.bordercolor !== BORDERCOLOR_DEFAULT) o.bc = this.bordercolor;
        if (this.spacing !== SPACING_DEFAULT) o.sp = this.spacing;
        if (this.folded) o.f = 1;
        o.cw = this.colwidths;
        o.c = this.cells.map(c => c.toJSON());
        return o;
    }

    static fromJSON(o, cell) {
        const xs = o.xs | 0, ys = o.ys | 0;
        const g = new Grid(xs, ys);
        g.cell = cell;
        g.bordercolor = o.bc != null ? o.bc & 0xFFFFFF : BORDERCOLOR_DEFAULT;
        g.spacing = o.sp != null ? Math.max(0, Math.min(32, o.sp | 0)) : SPACING_DEFAULT;
        g.folded = !!o.f;
        for (let x = 0; x < xs; x++) {
            const w = Array.isArray(o.cw) ? o.cw[x] | 0 : 0;
            g.colwidths[x] = w >= MIN_COLWIDTH ? w : settings.defaultColWidth;
        }
        const cells = Array.isArray(o.c) ? o.c : [];
        for (let i = 0; i < xs * ys; i++) g.cells[i] = Cell.fromJSON(cells[i], cell);
        return g;
    }
}

/* ---------------------------------------------------------------- Selection */

// A selection is a rectangle of cells in a grid. xs or ys being 0 makes it a "thin" selection:
// a grid line between rows (ys == 0) or columns (xs == 0), where typing inserts a new row/column.
export class Selection {
    constructor(grid = null, x = 0, y = 0, xs = 0, ys = 0) {
        this.grid = grid;
        this.x = x;
        this.y = y;
        this.xs = xs;
        this.ys = ys;
        this.textedit = false;
        this.firstdx = 0;
        this.firstdy = 0;
    }

    set(o) {
        this.grid = o.grid;
        this.x = o.x;
        this.y = o.y;
        this.xs = o.xs;
        this.ys = o.ys;
        this.textedit = o.textedit || false;
    }

    copy() {
        const s = new Selection(this.grid, this.x, this.y, this.xs, this.ys);
        s.textedit = this.textedit;
        return s;
    }

    getCell() { return this.grid && this.xs === 1 && this.ys === 1 ? this.grid.C(this.x, this.y) : null; }
    getFirst() { return this.grid && this.xs >= 1 && this.ys >= 1 ? this.grid.C(this.x, this.y) : null; }
    thin() { return this.xs * this.ys === 0; }
    isAll() { return this.grid && this.xs === this.grid.xs && this.ys === this.grid.ys; }
    pasteMode() { return !this.thin() ? PASTE_FIT : this.xs !== 0 ? PASTE_INSERTROWS : PASTE_INSERTCOLUMNS; }
    eqLoc(s) { return this.grid === s.grid && this.x === s.x && this.y === s.y && this.xs === s.xs && this.ys === s.ys; }
    enterEdit() { this.textedit = true; this.firstdx = this.firstdy = 0; }
    exitEdit() { this.textedit = false; this.firstdx = this.firstdy = 0; }

    cells() {
        const out = [];
        if (this.grid) this.grid.forSel(this, c => out.push(c));
        return out;
    }

    contains(c) {
        if (!this.grid) return false;
        const p = this.grid.find(c);
        return !!p && p.x >= this.x && p.y >= this.y && p.x < this.x + this.xs && p.y < this.y + this.ys;
    }

    // Selection spanning from cell a to cell b, possibly across grid levels, in which case the
    // selection ends up in their common ancestor grid.
    static merge(a, b) {
        if (a.grid === b.grid) {
            const s = new Selection(a.grid, Math.min(a.x, b.x), Math.min(a.y, b.y),
                Math.abs(a.x - b.x) + 1, Math.abs(a.y - b.y) + 1);
            return s;
        }
        const at = a.getFirst(), bt = b.getCell();
        if (!at || !bt) return a.copy();
        const ad = at.depth(), bd = bt.depth();
        let i = 0;
        while (i < ad && i < bd && at.ancestor(ad - i) === bt.ancestor(bd - i)) i++;
        if (i === 0) return a.copy();
        const g = at.ancestor(ad - i + 1).grid;
        return Selection.merge(g.findCell(at.ancestor(ad - i)), g.findCell(bt.ancestor(bd - i)));
    }

    // Keyboard cursor movement outside of text editing, see TreeSheets Selection::Dir.
    dir(doc, ctrl, shift, dx, dy) {
        const g = this.grid;
        if (ctrl) {
            doc.addUndo(g.cell);
            g.move(dx, dy, this);
            const nx = (this.x + dx + g.xs) % g.xs, ny = (this.y + dy + g.ys) % g.ys;
            if (nx + this.xs <= g.xs && ny + this.ys <= g.ys) {
                this.x = nx;
                this.y = ny;
            }
            return;
        }
        if (shift) {
            if (this.xs === 0) this.firstdx = 0;
            if (this.ys === 0) this.firstdy = 0;
            if (this.firstdx === 0) this.firstdx = dx;
            if (this.firstdy === 0) this.firstdy = dy;
            if (this.firstdx < 0) { this.x += dx; this.xs -= dx; } else this.xs += dx;
            if (this.firstdy < 0) { this.y += dy; this.ys -= dy; } else this.ys += dy;
            if (this.x < 0) { this.x = 0; this.xs--; }
            if (this.y < 0) { this.y = 0; this.ys--; }
            if (this.x + this.xs > g.xs) this.xs--;
            if (this.y + this.ys > g.ys) this.ys--;
            if (this.xs === 0) this.firstdx = 0;
            if (this.ys === 0) this.firstdy = 0;
            if (this.xs <= 0 || this.ys <= 0) {
                this.xs = Math.max(this.xs, 1);
                this.ys = Math.max(this.ys, 1);
            }
            return;
        }
        // Plain movement. v/vs = position/size along the movement axis, ovs = the other size.
        const horiz = dx !== 0;
        const v = horiz ? 'x' : 'y', vs = horiz ? 'xs' : 'ys', ovs = horiz ? 'ys' : 'xs';
        const gmax = horiz ? g.xs : g.ys;
        const d = dx + dy;
        const notboundaryperp = d < 0 ? this[v] !== 0 : this[v] < gmax;
        const notboundarypar = d < 0 ? this[v] !== 0 : this[v] < gmax - 1;
        if (this[vs] !== 0) {
            if (this[ovs] !== 0) {
                // (Multi) cell selection: move by one cell, keeping the selection size.
                if (this.x + dx >= 0 && this.x + dx + this.xs <= g.xs &&
                    this.y + dy >= 0 && this.y + dy + this.ys <= g.ys) {
                    this.x += dx;
                    this.y += dy;
                }
                this.exitEdit();
            } else if (notboundarypar) {
                this[v] += d; // thin selection, moving in parallel direction
            }
        } else if (notboundaryperp) {
            // Thin selection, moving in perpendicular direction: back to a cell selection.
            if (d < 0) this[v]--;
            this[vs] = 1;
        } else {
            // Selection cycle, jump to the opposite side of the grid.
            if (this.y + dy > g.ys) { this.y = 0; this.ys = 1; }
            else if (this.y + dy < 0) { this.y = g.ys - 1; this.ys = 1; }
            else if (this.x + dx > g.xs) { this.x = 0; this.xs = 1; }
            else if (this.x + dx < 0) { this.x = g.xs - 1; this.xs = 1; }
        }
    }

    next(backwards) {
        const g = this.grid;
        if (backwards) {
            if (this.x > 0) this.x--;
            else if (this.y > 0) { this.y--; this.x = g.xs - 1; }
            else { this.x = g.xs - 1; this.y = g.ys - 1; }
        } else {
            if (this.x < g.xs - 1) this.x++;
            else if (this.y < g.ys - 1) { this.y++; this.x = 0; }
            else this.x = this.y = 0;
        }
        this.xs = this.ys = 1;
    }

    // Makes a thin selection into a cell selection by inserting a row or column.
    thinExpand(doc, jumptofirst = false) {
        if (this.thin()) {
            doc.addUndo(this.grid.cell);
            if (this.xs !== 0) {
                this.grid.insertCells(-1, this.y, 0, 1);
                this.ys = 1;
                if (jumptofirst) this.x = 0;
            } else {
                this.grid.insertCells(this.x, -1, 1, 0);
                this.xs = 1;
                if (jumptofirst) this.y = 0;
            }
            if (this.xs > 1 || this.ys > 1) { this.xs = this.ys = 1; }
        }
        return this.getCell();
    }

    wrap(doc) {
        if (this.thin()) fail(NO_THIN);
        const g = this.grid;
        doc.addUndo(g.cell);
        const np = g.cloneSel(this);
        g.C(this.x, this.y).setText('.'); // avoid this cell getting deleted
        if (this.xs > 1) g.multiCellDeleteSub(doc, new Selection(g, this.x + 1, this.y, this.xs - 1, this.ys));
        if (this.ys > 1) g.multiCellDeleteSub(doc, new Selection(g, this.x, this.y + 1, 1, this.ys - 1));
        const old = g.C(this.x, this.y);
        np.relsize = old.relsize;
        np.cloneStyleFrom(old);
        np.text = '';
        np.parent = g.cell;
        g.setC(this.x, this.y, np);
        this.xs = this.ys = 1;
        this.enterEdit();
    }
}

export const NO_SEL = 'This operation requires a selection.';
export const ONE_CELL = 'This operation works on a single selected cell only.';
export const NO_THIN = "This operation doesn't work on thin selections.";
export const NO_GRID = 'This operation requires a cell that contains a grid.';

/* ---------------------------------------------------------------- Document */

export function pathOf(cell) {
    const path = [];
    while (cell.parent) {
        const p = cell.parent.grid.find(cell);
        path.unshift([p.x, p.y]);
        cell = cell.parent;
    }
    return path;
}

export class Doc {
    constructor(root) {
        this.root = root || Doc.newRoot(3);
        this.tags = new Map();        // tag text -> [cellcolor, textcolor]
        this.drawpath = [];           // zoom path from root: [[x, y], ...]
        this.selected = new Selection();
        this.undolist = [];
        this.redolist = [];
        this.search = '';             // current search string (lowercased unless case sensitive)
        this.onmodified = null;
        this.editfilter = 0;
    }

    static newRoot(size = 3) {
        const root = new Cell();
        root.addGrid(size, size);
        return root;
    }

    static fromJSON(o) {
        const d = new Doc(o && o.root ? Cell.fromJSON(o.root) : null);
        if (!d.root.grid) d.root.addGrid(1, 1);
        if (o && o.tags && typeof o.tags === 'object')
            for (const [k, v] of Object.entries(o.tags))
                if (Array.isArray(v)) d.tags.set(k, [v[0] & 0xFFFFFF, v[1] & 0xFFFFFF]);
        if (o && Array.isArray(o.zoom)) {
            d.drawpath = o.zoom;
            if (!d.walk(d.drawpath)) d.drawpath = [];
        }
        return d;
    }

    toJSON() {
        const tags = {};
        for (const [k, v] of this.tags) tags[k] = v;
        const o = { v: 1, root: this.root.toJSON(), tags };
        if (this.drawpath.length) o.zoom = this.drawpath;
        return o;
    }

    walk(path) {
        let c = this.root;
        for (const [x, y] of path) {
            if (!c.grid || x >= c.grid.xs || y >= c.grid.ys) return null;
            c = c.grid.C(x, y);
        }
        return c;
    }

    drawRoot() {
        let c = this.root;
        let i = 0;
        for (const [x, y] of this.drawpath) {
            if (!c.grid || x >= c.grid.xs || y >= c.grid.ys) break;
            c = c.grid.C(x, y);
            i++;
        }
        if (i < this.drawpath.length) this.drawpath.length = i;
        return c;
    }

    isTag(c) { return this.tags.has(c.text); }

    modified() { if (this.onmodified) this.onmodified(); }

    /* Undo: like TreeSheets, each undo step is a copy of the smallest cell containing the change. */
    saveSel(sel = this.selected) {
        if (!sel.grid || !sel.grid.cell) return null;
        return { path: pathOf(sel.grid.cell), x: sel.x, y: sel.y, xs: sel.xs, ys: sel.ys };
    }

    restoreSel(s) {
        this.selected = new Selection();
        if (!s) return;
        const c = this.walk(s.path);
        if (!c || !c.grid) return;
        const g = c.grid;
        const x = Math.min(s.x, g.xs), y = Math.min(s.y, g.ys);
        this.selected = new Selection(g, x, y, Math.min(s.xs, g.xs - x), Math.min(s.ys, g.ys - y));
        if (this.selected.xs < 0 || this.selected.ys < 0 || (this.selected.xs === 0 && this.selected.ys === 0))
            this.selected = new Selection(g, 0, 0, 1, 1);
    }

    addUndo(cell, textedit = false) {
        this.redolist = [];
        this.undolist.push({
            path: pathOf(cell), clone: cell.clone(null), sel: this.saveSel(),
            drawpath: this.drawpath.map(p => p.slice()), textedit, cellref: cell,
        });
        if (this.undolist.length > 500) this.undolist.shift();
        this.modified();
    }

    lastUndoSameCellTextEdit(c) {
        const u = this.undolist[this.undolist.length - 1];
        return u && u.textedit && u.cellref === c;
    }

    lastUndoSameCellStructure(c) {
        const u = this.undolist[this.undolist.length - 1];
        return u && !u.textedit && u.cellref === c;
    }

    undo(redo = false) {
        const from = redo ? this.redolist : this.undolist, to = redo ? this.undolist : this.redolist;
        const u = from.pop();
        if (!u) return false;
        const cur = this.walk(u.path);
        if (!cur) return false;
        to.push({ path: u.path, clone: cur.clone(null), sel: this.saveSel(),
            drawpath: this.drawpath.map(p => p.slice()), textedit: u.textedit, cellref: null });
        const nc = u.clone;
        if (cur.parent) {
            const p = cur.parent.grid.find(cur);
            nc.parent = cur.parent;
            cur.parent.grid.setC(p.x, p.y, nc);
        } else {
            nc.parent = null;
            this.root = nc;
        }
        this.drawpath = u.drawpath;
        this.drawRoot();
        this.restoreSel(u.sel);
        this.modified();
        return true;
    }

    /* Zoom (drawing a sub-cell as the root). */
    zoom(dir, fromcell = null) {
        if (dir > 0) {
            // Zoom into the cell that contains the selection, one level below the current root.
            const sel = this.selected;
            let c = fromcell || sel.getFirst() || (sel.grid && sel.grid.cell);
            if (!c) return false;
            const dr = this.drawRoot();
            if (c === dr || !dr.isParentOf(c)) return false;
            // Find the ancestor of c that is a direct child of the draw root.
            let steps = 0;
            while (c.parent !== dr) { c = c.parent; steps++; }
            if (!c.grid && steps === 0) {
                return false; // selected a leaf directly under the root: nothing to zoom into
            }
            const p = dr.grid.find(c);
            this.drawpath.push([p.x, p.y]);
            if (this.selected.getCell() === c && c.grid) this.selected = c.grid.selectAll();
            return true;
        }
        if (!this.drawpath.length) return false;
        const old = this.drawRoot();
        this.drawpath.pop();
        if (!this.selected.grid) this.selected = old.parent.grid.findCell(old);
        return true;
    }

    zoomTo(cell) {
        const path = pathOf(cell);
        this.drawpath = path;
        if (cell.grid && (!this.selected.grid || !cell.isParentOf(this.selected.grid.cell) && this.selected.grid !== cell.grid))
            this.selected = cell.grid.selectAll();
    }

    zoomOutIfNoGrid() {
        while (this.drawpath.length && !this.drawRoot().grid) this.drawpath.pop();
    }

    // All cells in the document (or under root), pre-order.
    allCells(root = this.root) {
        const out = [];
        root.walk(c => { out.push(c); });
        return out;
    }

    // Cells in the selection, optionally recursively including all their descendants.
    selCells(recurse) {
        const out = [];
        for (const c of this.selected.cells()) {
            if (recurse) c.walk(d => { out.push(d); });
            else out.push(c);
        }
        return out;
    }

    matchesSearch(c) {
        if (!this.search) return false;
        const t = settings.caseSensitiveSearch ? c.text : c.text.toLowerCase();
        return t.includes(this.search);
    }

    // Finds the next cell (in document order, starting after `from`) matching pred.
    findNext(pred, from, reverse = false, restrictroot = null) {
        const cells = this.allCells(restrictroot || this.root).filter(c => c.parent);
        if (!cells.length) return null;
        let start = from ? cells.indexOf(from) : -1;
        const n = cells.length;
        for (let k = 1; k <= n; k++) {
            const i = reverse ? ((start < 0 ? n : start) - k + n * 2) % n : (start + k) % n;
            if (pred(cells[i])) return cells[i];
        }
        return null;
    }

    // "Go to matching cell" (F6/F7): next cell with the same text or image, preferring same style.
    findLink(cell, forward, image) {
        const cells = this.allCells().filter(c => c.parent);
        const same = c => c !== cell && (image ? c.image === cell.image : c.text === cell.text);
        const samestyle = c => c.stylebits === cell.stylebits && c.cellcolor === cell.cellcolor && c.textcolor === cell.textcolor;
        const idx = cells.indexOf(cell);
        const order = [];
        for (let k = 1; k < cells.length; k++) order.push(cells[(idx + (forward ? k : -k) + cells.length * 2) % cells.length]);
        return order.find(c => same(c) && !samestyle(c)) || order.find(same) || null;
    }
}

/* ---------------------------------------------------------------- import helpers */

export function countCol(s) {
    let col = 0;
    while (s[col] === ' ' || s[col] === '\t') col++;
    return col;
}

// Builds a hierarchy from lines of indented text (TreeSheets System::FillRows).
export function fillRows(g, lines, column, startrow, starty) {
    let y = starty;
    for (let i = startrow; i < lines.length; i++) {
        const s = lines[i];
        const col = countCol(s);
        if (col < column && startrow !== 0) return i;
        if (col > column && y > 0) {
            const c = g.C(0, y - 1);
            const sg = c.grid;
            i = fillRows(sg || c.addGrid(), lines, col, i, sg ? sg.ys : 0) - 1;
        } else {
            if (g.ys <= y) g.insertCells(-1, y, 0, 1);
            const c = g.C(0, y);
            c.text = s.trimStart();
            c.wasEdited();
            y++;
        }
    }
    return lines.length;
}

export function splitLines(text) {
    return text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim() !== '');
}

export function textToCell(text) {
    const lines = splitLines(text);
    const c = new Cell();
    const g = c.addGrid(1, 1);
    if (lines.length) fillRows(g, lines, countCol(lines[0]), 0, 0);
    return c;
}

// CSV import (TreeSheets Grid::CSVImport).
export function csvToGrid(text, sep) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const rows = [];
    for (let y = 0; y < lines.length; y++) {
        let s = lines[y];
        const row = [];
        while (s.length) {
            let word = '';
            if (s[0] === '"') {
                for (let i = 1; ; i++) {
                    if (i >= s.length) {
                        if (y < lines.length - 1) {
                            word += '\n';
                            s = lines[++y];
                            i = -1;
                        } else {
                            s = '';
                            break;
                        }
                    } else if (s[i] === '"') {
                        if (s[i + 1] === '"') word += s[++i];
                        else {
                            s = s.length === i + 1 ? '' : s.slice(i + 2);
                            break;
                        }
                    } else word += s[i];
                }
            } else {
                const pos = s.indexOf(sep);
                if (pos < 0) { word = s; s = ''; }
                else { word = s.slice(0, pos); s = s.slice(pos + 1); }
            }
            row.push(word);
        }
        rows.push(row);
    }
    const xs = Math.max(1, ...rows.map(r => r.length)), ys = Math.max(1, rows.length);
    const c = new Cell();
    const g = c.addGrid(xs, ys);
    rows.forEach((r, y) => r.forEach((w, x) => { g.C(x, y).text = w; }));
    return c;
}

// XML / OPML import (TreeSheets System::FillXML).
export function xmlToCell(text, attributestoo) {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    if (dom.getElementsByTagName('parsererror').length) throw new TSError('Could not parse the XML file.');
    const root = new Cell();
    root.addGrid(1, 1);
    fillXML(root.grid.C(0, 0), dom.documentElement, attributestoo);
    let c = root.grid.C(0, 0);
    if (!c.hasText() && c.grid) {
        c = c.grid.C(0, 0);
    }
    const out = new Cell();
    out.addGrid(1, 1);
    const top = c.clone(out);
    out.grid.setC(0, 0, top);
    return c.grid && !c.hasText() ? c : out;
}

function xmlNodes(node, attributestoo) {
    const nodes = [];
    if (attributestoo && node.attributes)
        for (const a of node.attributes) nodes.push({ attr: true, name: a.name, value: a.value });
    for (const ch of node.childNodes) {
        if (ch.nodeType === 1 || (ch.nodeType === 3 && ch.nodeValue.trim() && nodes.some(n => !n.attr && n.nodeType === 1))) {
            if (ch.nodeType === 1) nodes.push(ch);
        }
    }
    return nodes;
}

function directText(node) {
    let t = '';
    for (const ch of node.childNodes)
        if (ch.nodeType === 3 || ch.nodeType === 4) t += ch.nodeValue;
    return t.split(/\s+/).filter(Boolean).join(' ');
}

function fillXML(c, node, attributestoo) {
    if (node.attr) {
        c.text = node.name + ': ' + node.value;
        return;
    }
    const name = node.nodeName;
    let text = directText(node);
    if (name === 'outline' && node.getAttribute('text') != null) text = node.getAttribute('text') + (text ? ' ' + text : '');
    c.text = text;
    if (name === 'cell') {
        c.relsize = -(parseInt(node.getAttribute('relsize') || '0', 10) || 0);
        c.stylebits = (parseInt(node.getAttribute('stylebits') || '0', 10) || 0) & 31;
        const col = (a, d) => {
            const v = node.getAttribute(a);
            if (!v) return d;
            const n = parseInt(v, v.startsWith('0x') ? 16 : 10);
            return Number.isNaN(n) ? d : bgr(n & 0xFFFFFF);
        };
        c.cellcolor = col('colorbg', CELLCOLOR_DEFAULT);
        c.textcolor = col('colorfg', TEXTCOLOR_DEFAULT);
        c.celltype = parseInt(node.getAttribute('type') || '0', 10) || 0;
        const al = parseInt(node.getAttribute('align') || '0', 10) || 0;
        c.align = al >= 0 && al <= 3 ? al : 0;
    }
    const nodes = xmlNodes(node, attributestoo && name !== 'cell' && name !== 'row' && name !== 'grid');
    if (!nodes.length) return;
    if (nodes.length === 1 && !c.text && nodes[0].nodeName !== 'row') {
        fillXML(c, nodes[0], attributestoo);
        return;
    }
    const allrow = nodes.every(n => n.nodeName === 'row');
    if (allrow) {
        const rows = nodes.map(r => xmlNodes(r, attributestoo));
        const xs = Math.max(1, ...rows.map(r => r.length));
        const g = c.addGrid(xs, rows.length);
        rows.forEach((r, y) => r.forEach((n, x) => fillXML(g.C(x, y), n, attributestoo)));
    } else {
        const g = c.addGrid(1, nodes.length);
        nodes.forEach((n, y) => fillXML(g.C(0, y), n, attributestoo));
    }
}

// wx colors are 0xBBGGRR; the XML format uses those.
export const bgr = c => ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
