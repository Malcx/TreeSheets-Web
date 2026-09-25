// TreeSheets Web - the TreeSheets mini "programming language" evaluator
// (port of TreeSheets evaluator.h / Grid::Eval).
//
// Cells are marked as Data, Operation, Variable Assign/Read or Horizontal/Vertical View.
// Running the program evaluates every grid left to right (and top to bottom), feeding the value
// of the previous cell into operations; Views receive the result.

import { Cell, Grid, CT_DATA, CT_CODE, CT_VARD, CT_VARU, CT_VIEWH, CT_VIEWV } from './model.js';

const median = a => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const aggregate = {
    min: a => a.length ? Math.min(...a) : 0,
    max: a => a.length ? Math.max(...a) : 0,
    avg: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0,
    median,
};

function numbers(g) {
    const out = [];
    for (const c of g.cells) {
        const d = c.getStrictNum();
        if (d !== null) out.push(d);
    }
    return out;
}

function numCell(d) {
    const c = new Cell();
    c.setNum(d);
    return c;
}

const OPS = {};
const nn = (n, f) => { OPS[n] = { args: 'nn', runnn: f }; };
const n1 = (n, f) => { OPS[n] = { args: 'n', runn: f }; };
nn('+', (a, b) => a + b);
nn('-', (a, b) => a - b);
nn('*', (a, b) => a * b);
nn('/', (a, b) => b !== 0 ? a / b : 0);
nn('<', (a, b) => +(a < b));
nn('>', (a, b) => +(a > b));
nn('<=', (a, b) => +(a <= b));
nn('>=', (a, b) => +(a >= b));
nn('=', (a, b) => +(a === b));
nn('==', (a, b) => +(a === b));
nn('!=', (a, b) => +(a !== b));
nn('<>', (a, b) => +(a !== b));
n1('inc', a => a + 1);
n1('dec', a => a - 1);
n1('neg', a => -a);
OPS.graph = { args: 't', runc: c => {
    const n = c.getNum();
    c.setText('|'.repeat(n > 0 ? Math.min(Math.floor(n), 1000) : 0));
    return c;
} };
OPS.sum = { args: 'l', runl: g => {
    let total = 0;
    for (const c of g.cells) if (c.hasText()) { const n = c.getNum(); if (!Number.isNaN(n)) total += n; }
    return numCell(total);
} };
for (const k of Object.keys(aggregate)) OPS[k] = { args: 'l', runl: g => numCell(aggregate[k](numbers(g))) };
OPS.transpose = { args: 'g', rung: g => g.transpose() };
OPS.if = { args: 'nLL' };

export const OPERATIONS = Object.keys(OPS);

export function inferCellType(c) { return Object.prototype.hasOwnProperty.call(OPS, c.text) ? CT_CODE : CT_DATA; }

export class Evaluator {
    constructor() {
        this.vars = new Map();
        this.vert = false;
    }

    lookup(name) {
        const v = this.vars.get(name);
        return v ? v.clone(null) : null;
    }

    setSymbol(sym, val) { if (sym) this.vars.set(sym, val); }

    assign(sym, val) {
        this.setSymbol(sym.text, val.clone(null));
        if (sym.grid && val.grid) this.destructuringAssign(sym.grid, val.clone(null));
    }

    destructuringAssign(names, val) {
        const vg = val.grid;
        if (names.xs === vg.xs && names.ys === vg.ys)
            for (let x = 0; x < names.xs; x++)
                for (let y = 0; y < names.ys; y++) this.setSymbol(names.C(x, y).text, vg.C(x, y).clone(null));
    }

    // Evaluates a cell: its grid if it has one, otherwise its text.
    evalCell(c) {
        if (c.grid) return this.evalGrid(c.grid);
        switch (c.celltype) {
            case CT_VARU: {
                let v = this.lookup(c.text);
                if (!v) {
                    v = c.clone(null);
                    v.celltype = CT_DATA;
                    v.text = '**Variable Load Error**';
                }
                return v;
            }
            case CT_DATA: return c.clone(null);
            default: return null;
        }
    }

    execute1(op, left) {
        const g = left.grid;
        switch (op.args[0]) {
            case 'n':
                if (left.text !== '') {
                    left.setNum(op.runn(left.getNum()));
                    return left;
                } else if (g) {
                    for (let i = 0; i < g.cells.length; i++) {
                        g.cells[i] = this.execute1(op, g.cells[i]);
                        g.cells[i].parent = left;
                    }
                }
                break;
            case 't':
                if (left.text !== '') return op.runc(left);
                if (g) for (let i = 0; i < g.cells.length; i++) {
                    g.cells[i] = this.execute1(op, g.cells[i]);
                    g.cells[i].parent = left;
                }
                break;
            case 'l':
                if (g) {
                    if (g.xs === 1 || g.ys === 1) return op.runl(g);
                    // Split into rows (or columns), and aggregate each.
                    const vert = this.vert;
                    const n = vert ? g.xs : g.ys;
                    const ng = new Grid(vert ? n : 1, vert ? 1 : n);
                    const c = new Cell(null, left, ng);
                    for (let i = 0; i < n; i++) {
                        const part = new Grid(vert ? 1 : g.xs, vert ? g.ys : 1);
                        for (let k = 0; k < (vert ? g.ys : g.xs); k++)
                            part.cells[k] = vert ? g.C(i, k) : g.C(k, i);
                        const res = op.runl(part);
                        res.parent = c;
                        ng.setC(vert ? i : 0, vert ? 0 : i, res);
                    }
                    return c;
                }
                break;
            case 'g':
                if (g) op.rung(g);
                break;
            case 'c': return op.runc(left);
        }
        return left;
    }

    execute2(op, left, rightcell) {
        const right = this.evalCell(rightcell);
        if (!right) return left;
        const g1 = left.grid, g2 = right.grid;
        if (op.args[0] === 'n') {
            if (left.text !== '' && right.text !== '') {
                left.setNum(op.runnn(left.getNum(), right.getNum()));
            } else if (g1 && g2 && g1.xs === g2.xs && g1.ys === g2.ys) {
                const g = new Grid(g1.xs, g1.ys);
                const c = new Cell(null, left, g);
                for (let x = 0; x < g.xs; x++)
                    for (let y = 0; y < g.ys; y++) {
                        const res = this.execute2(op, g1.C(x, y), g2.C(x, y));
                        res.parent = c;
                        g.setC(x, y, res);
                    }
                return c;
            } else if (g1 && right.text !== '') {
                for (let i = 0; i < g1.cells.length; i++) {
                    g1.cells[i] = this.execute2(op, g1.cells[i], right);
                    g1.cells[i].parent = left;
                }
            }
        }
        return left;
    }

    execute3(op, left, a, b) {
        if (left.text === '') return left;
        return this.evalCell(left.getNum() !== 0 ? a : b);
    }

    evalGridCell(g, i, acc, pos, state, vert) {
        let c = g.cells[i];
        const ct = c.celltype;
        state.alldata = state.alldata && (ct === CT_DATA || ct === CT_VARU);
        this.vert = vert;
        switch (ct) {
            case CT_VARD:
                if (vert) return acc;
                if (!acc || (!acc.grid && acc.text === '')) {
                    acc = this.evalCell(c);
                    if (!acc) return null;
                }
                this.assign(c, acc);
                return acc;
            case CT_VIEWV:
            case CT_VIEWH: {
                if (vert ? ct === CT_VIEWH : ct === CT_VIEWV) return c.clone(null);
                const nc = acc ? acc.clone(g.cell) : new Cell(g.cell);
                nc.celltype = ct;
                g.cells[i] = nc;
                return acc;
            }
            case CT_CODE: {
                const op = OPS[c.text];
                const nargs = op ? op.args.length : -1;
                if (nargs === 1) return acc ? this.execute1(op, acc) : null;
                if (nargs === 2) {
                    if (vert) {
                        if (acc && pos.y + 1 < g.ys) return this.execute2(op, acc, g.C(pos.x, ++pos.y));
                    } else if (acc && pos.x + 1 < g.xs) return this.execute2(op, acc, g.C(++pos.x, pos.y));
                    return null;
                }
                if (nargs === 3) {
                    if (vert) {
                        if (acc && pos.y + 2 < g.ys) {
                            pos.y += 2;
                            return this.execute3(op, acc, g.C(pos.x, pos.y - 1), g.C(pos.x, pos.y));
                        }
                    } else if (acc && pos.x + 2 < g.xs) {
                        pos.x += 2;
                        return this.execute3(op, acc, g.C(pos.x - 1, pos.y), g.C(pos.x, pos.y));
                    }
                    return null;
                }
                return null;
            }
            default:
                return this.evalCell(c);
        }
    }

    evalGrid(g) {
        let acc = null;
        const state = { alldata: true };
        if (g.xs > 1 || g.ys === 1) {
            for (let y = 0; y < g.ys; y++) {
                acc = null;
                const pos = { x: 0, y };
                for (; pos.x < g.xs; pos.x++) acc = this.evalGridCell(g, pos.x + pos.y * g.xs, acc, pos, state, false);
            }
        }
        if (g.ys > 1) {
            for (let x = 0; x < g.xs; x++) {
                acc = null;
                const pos = { x, y: 0 };
                for (; pos.y < g.ys; pos.y++) acc = this.evalGridCell(g, pos.x + pos.y * g.xs, acc, pos, state, true);
            }
        }
        if (state.alldata) {
            const result = g.cell ? g.cell.clone(null) : new Cell(null, null, g.clone(null));
            if (result.grid)
                for (let i = 0; i < result.grid.cells.length; i++) {
                    const ev = this.evalCell(result.grid.cells[i]);
                    if (ev) {
                        ev.parent = result;
                        result.grid.cells[i] = ev;
                    }
                }
            return result;
        }
        return acc;
    }

    run(root) {
        this.evalCell(root);
        this.vars.clear();
    }
}
