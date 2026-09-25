// TreeSheets Web - text based export formats (ports of TreeSheets Cell/Grid::ToText).

import { STYLE_BOLD, STYLE_ITALIC, STYLE_FIXED, STYLE_UNDERLINE, STYLE_STRIKE, CT_DATA, ALIGN_AUTO,
    ALIGN_LEFT, CELLCOLOR_DEFAULT, TEXTCOLOR_DEFAULT, BORDERCOLOR_DEFAULT, SPACING_DEFAULT, bgr } from './model.js';
import { imageURL } from './render.js';

export const F_TEXT = 'text', F_XML = 'xml', F_HTMLT = 'htmlt', F_HTMLTI = 'htmlti', F_HTMLB = 'htmlb',
    F_HTMLO = 'htmlo', F_CSV = 'csv';

const isTable = f => f === F_HTMLT || f === F_HTMLTI;

export function htmlify(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const hex6 = c => (c & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
const pad = n => ' '.repeat(n);

function richMarkup(c, format) {
    const t = c.text;
    let out = '', pos = 0;
    const esc = s => (format === F_TEXT || format === F_CSV) ? s : htmlify(s);
    for (const [s, l, st, col] of c.runs) {
        out += esc(t.slice(pos, s));
        const part = esc(t.slice(s, s + l));
        if (format === F_XML) {
            out += `<run stylebits="${st}"` + (col >= 0 ? ` colorfg="0x${hex6(bgr(col))}"` : '') + `>${part}</run>`;
        } else {
            let style = '';
            style += st & STYLE_BOLD ? 'font-weight:bold;' : 'font-weight:normal;';
            style += st & STYLE_ITALIC ? 'font-style:italic;' : 'font-style:normal;';
            if (st & STYLE_FIXED) style += 'font-family:monospace;';
            const d = [];
            if (st & STYLE_UNDERLINE) d.push('underline');
            if (st & STYLE_STRIKE) d.push('line-through');
            if (d.length) style += 'text-decoration:' + d.join(' ') + ';';
            if (col >= 0) style += `color:#${hex6(col)};`;
            out += `<span style="${style}">${part}</span>`;
        }
        pos = s + l;
    }
    return out + esc(t.slice(pos));
}

function textToText(c, format, images) {
    let str;
    const rich = c.runs && c.runs.length && format !== F_TEXT && format !== F_CSV;
    if (rich) str = richMarkup(c, format);
    else {
        str = c.text;
        if (format !== F_TEXT && format !== F_CSV) str = htmlify(str);
    }
    if (format === F_TEXT && c.image) str += ' ';
    if (format === F_HTMLTI && c.image) {
        const src = images && images.get(c.image) || imageURL(c.image);
        str = `<img src="${src}" />` + str;
    }
    return str;
}

function colorAttr(name, c) { return ` ${name}="0x${hex6(bgr(c))}"`; }

// Converts a cell (and its sub-grid) to one of the text formats.
export function cellToText(c, indent, format, doc, inheritstyle, root, images) {
    let str = textToText(c, format, images);
    if (isTable(format) && c !== root && str !== '') {
        let spanstyle = 'white-space: pre-wrap;';
        if (!(c.runs && c.runs.length) && (c.stylebits & (STYLE_UNDERLINE | STYLE_STRIKE))) {
            spanstyle += 'text-decoration:' + (c.stylebits & STYLE_UNDERLINE ? ' underline' : '') +
                (c.stylebits & STYLE_STRIKE ? ' line-through' : '') + ';';
        }
        str = `<span style="${spanstyle}">${str}</span>`;
    }
    if (format === F_CSV) {
        if (c.grid) return gridToText(c.grid, c.grid.selectAll(), indent, format, doc, inheritstyle, root, images);
        return '"' + str.replace(/"/g, '""') + '"';
    }
    str += '\n';
    if (c.grid) str += gridToText(c.grid, c.grid.selectAll(), indent + 2, format, doc, inheritstyle, root, images);
    if (format === F_XML) {
        let attrs = '';
        if (c.align !== ALIGN_AUTO) attrs = ` align="${c.align}"` + attrs;
        if (c.celltype !== CT_DATA) attrs = ` type="${c.celltype}"` + attrs;
        if (c.textcolor !== TEXTCOLOR_DEFAULT) attrs = colorAttr('colorfg', c.textcolor) + attrs;
        if (c.cellcolor !== CELLCOLOR_DEFAULT) attrs = colorAttr('colorbg', c.cellcolor) + attrs;
        if (c.stylebits) attrs = ` stylebits="${c.stylebits}"` + attrs;
        if (c.relsize) attrs = ` relsize="${-c.relsize}"` + attrs;
        str = '<cell' + attrs + '>' + str + pad(indent) + '</cell>\n';
    } else if (isTable(format) && c !== root) {
        const p = c.parent;
        let style = '';
        if (!inheritstyle || !p || (c.stylebits & STYLE_BOLD) !== (p.stylebits & STYLE_BOLD))
            style += c.stylebits & STYLE_BOLD ? 'font-weight: bold;' : 'font-weight: normal;';
        if (!inheritstyle || !p || (c.stylebits & STYLE_ITALIC) !== (p.stylebits & STYLE_ITALIC))
            style += c.stylebits & STYLE_ITALIC ? 'font-style: italic;' : 'font-style: normal;';
        if (!inheritstyle || !p || (c.stylebits & STYLE_FIXED) !== (p.stylebits & STYLE_FIXED))
            style += c.stylebits & STYLE_FIXED ? 'font-family: monospace;' : 'font-family: sans-serif;';
        const alignOf = x => x.align === ALIGN_AUTO ? ALIGN_LEFT : x.align;
        const palign = p && p !== root ? alignOf(p) : ALIGN_LEFT;
        if (alignOf(c) !== palign) style += 'text-align: ' + ['', 'left', 'center', 'right'][alignOf(c)] + ';';
        const tagcol = x => doc.tags.get(x.text);
        const ccol = tagcol(c) ? tagcol(c)[0] : c.cellcolor;
        const pcol = p ? (tagcol(p) ? tagcol(p)[0] : p.cellcolor) : CELLCOLOR_DEFAULT;
        if (!inheritstyle || ccol !== pcol) style += `background-color: #${hex6(ccol)};`;
        const tcol = tagcol(c) ? tagcol(c)[1] : c.textcolor;
        const ptcol = p ? (tagcol(p) ? tagcol(p)[1] : p.textcolor) : TEXTCOLOR_DEFAULT;
        if (!inheritstyle || tcol !== ptcol) style += `color: #${hex6(tcol)};`;
        str = (style ? `<td style="${style}">` : '<td>') + str + pad(indent) + '</td>\n';
    } else if (format === F_HTMLB && (c.text !== '' || c.grid) && c !== root) {
        str = '<li>' + str + pad(indent) + '</li>\n';
    } else if (format === F_HTMLO && c.text !== '') {
        const h = 'h' + Math.min(6, Math.max(1, Math.floor(indent / 2))) + '>';
        str = '<' + h + str + pad(indent) + '</' + h + '\n';
    }
    return pad(indent) + str;
}

export function gridToText(g, sel, indent, format, doc, inheritstyle, root, images) {
    let r = '';
    const fontsize = 14 - Math.floor(indent / 2);
    const borderw = g.cell === doc.root ? 2 : g.spacing - 1;
    let xml = '<grid';
    if (g.folded) xml += ' folded="1"';
    if (g.bordercolor !== BORDERCOLOR_DEFAULT) xml += ` bordercolor="0x${hex6(bgr(g.bordercolor))}"`;
    if (g.spacing !== SPACING_DEFAULT) xml += ` outerspacing="${g.spacing}"`;
    xml += '>\n';
    const fmt = (x, h, b) => {
        if (format === F_XML) r += pad(indent) + x;
        else if (isTable(format)) r += pad(indent) + h;
        else if (format === F_HTMLB && b) r += pad(indent) + b;
    };
    fmt(xml, `<table style="border-width: ${borderw}pt; font-size: ${fontsize}pt;">\n`, `<ul style="font-size: ${fontsize}pt;">\n`);
    for (let y = sel.y; y < sel.y + sel.ys; y++)
        for (let x = sel.x; x < sel.x + sel.xs; x++) {
            if (x === sel.x) fmt('<row>\n', '<tr>\n', '');
            r += cellToText(g.C(x, y), indent, format, doc, inheritstyle, root, images);
            if (format === F_CSV) r += x === sel.x + sel.xs - 1 ? '\n' : ',';
            if (x === sel.x + sel.xs - 1) fmt('</row>\n', '</tr>\n', '');
        }
    fmt('</grid>\n', '</table>\n', '</ul>\n');
    return r;
}

export function wrapExport(format, content, title, bg) {
    if (format === F_XML) {
        return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE cell [\n<!ELEMENT cell (grid)>\n' +
            '<!ELEMENT grid (row*)>\n<!ELEMENT row (cell*)>\n]>\n' + content;
    }
    if (format === F_TEXT || format === F_CSV) return content;
    return '<!DOCTYPE html>\n<html>\n<head>\n<style>\nbody { font-family: sans-serif; }\n' +
        'table, th, td { border: 1px solid #A0A0A0; border-collapse: collapse; padding: 3px; vertical-align: top; }\n' +
        '@media (prefers-color-scheme: dark) {\n  html { filter: invert(1); }\n  img { filter: invert(1); }\n}\n' +
        'li { }\n</style>\n<title>export of TreeSheets file ' + htmlify(title) + '</title>\n<meta charset="UTF-8" />\n' +
        `</head>\n<body style="background-color: #${hex6(bg)};">` + content + '</body>\n</html>\n';
}

// Fetches images as data URLs, for self-contained HTML exports / clipboard.
export async function collectImages(cells) {
    const ids = new Set();
    for (const root of cells) root.walk(c => { if (c.image) ids.add(c.image); });
    const map = new Map();
    await Promise.all([...ids].map(async id => {
        try {
            const blob = await (await fetch(imageURL(id), { credentials: 'same-origin' })).blob();
            map.set(id, await new Promise(res => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result);
                fr.readAsDataURL(blob);
            }));
        } catch (e) { /* leave the URL */ }
    }));
    return map;
}
