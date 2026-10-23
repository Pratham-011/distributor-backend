// Reads .xls / .xlsx / .csv into a grid and finds the banner, header row, period and TOTALS row.
import crypto from 'node:crypto';
import XLSX from 'xlsx';
import { REPORT_TYPES, norm } from './reportTypes.js';

const isEmpty = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const cellText = v => (v instanceof Date ? fmtDate(v) : isEmpty(v) ? '' : String(v).trim());
const pad = n => String(n).padStart(2, '0');
export const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
export const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function readGrid(buffer, fileName = '') {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true, raw: /\.csv$/i.test(fileName) ? false : undefined });
  } catch {
    throw new Error('This file could not be opened. Please upload the Excel (.xls / .xlsx) or CSV file exactly as exported.');
  }
  // These exports carry empty Sheet1/Sheet2; use the sheet that has the most filled rows.
  // Rows are counted straight from the parsed sheet and only the chosen sheet is turned into a grid,
  // so a workbook with several sheets isn't held in memory twice.
  let best = null;
  for (const name of wb.SheetNames) {
    const filled = filledRows(wb.Sheets[name]);
    if (!best || filled > best.filled) best = { name, filled };
  }
  if (!best || best.filled === 0) throw new Error('This file is empty.');
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[best.name], { header: 1, raw: true, defval: null, blankrows: true });
  return { sheet: best.name, grid };
}

// Rows with at least one value inside the sheet's range (the same rows sheet_to_json would return as filled).
// In dense mode each row is an array of cells at ws[rowIndex].
function filledRows(ws) {
  if (!ws?.['!ref']) return 0;
  const r = XLSX.utils.decode_range(ws['!ref']);
  let n = 0;
  for (let R = r.s.r; R <= r.e.r; R++) {
    const row = ws[R];
    if (!row) continue;
    for (let C = r.s.c; C <= r.e.c; C++) if (row[C] && !isEmpty(row[C].v)) { n++; break; }
  }
  return n;
}

export function guessHeaderRow(grid) {
  for (let i = 0; i < Math.min(40, grid.length); i++) {
    const cells = grid[i].filter(c => !isEmpty(c));
    if (cells.length >= 5 && cells.filter(c => typeof c === 'string').length >= 4) return i;
  }
  return 0;
}

export function bannerOf(grid, headerRow) {
  const out = [];
  for (let i = 0; i < headerRow; i++) for (const c of grid[i]) if (!isEmpty(c)) out.push(cellText(c));
  return out;
}

export function detectType(banner, headers) {
  const text = banner.join(' | ').toLowerCase();
  for (const t of Object.values(REPORT_TYPES)) if (t.titles.some(x => text.includes(x))) return t.key;
  // fall back to header shape
  const h = new Set(headers.map(norm));
  if (h.has('crntype')) return 'credit_note';
  if (h.has('creditaccount') && h.has('debitaccount')) return 'receipt';
  if (h.has('balance') && h.has('billamount')) return 'outstanding';
  if (h.has('suppliername') && h.has('refinvno')) return 'debit_note';
  if (h.has('suppliername') && h.has('vno')) return 'purchase';
  if (h.has('invno') && h.has('partyname')) return 'sales';
  if ((h.has('closingqty') || h.has('clqty') || h.has('closingstock')) && !h.has('partyname')) return 'stock';
  return null;
}

export function periodOf(banner) {
  const text = banner.join(' ');
  let m = text.match(/From\s*:?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*To\s*:?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i);
  if (m) return { from: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, to: `${m[6]}-${pad(m[5])}-${pad(m[4])}` };
  m = text.match(/As\s*On\s*(?:Date)?\s*:?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i);
  if (m) { const d = `${m[3]}-${pad(m[2])}-${pad(m[1])}`; return { from: d, to: d }; }
  return { from: null, to: null };
}

export function headersOf(grid, headerRow) {
  const raw = grid[headerRow] || [];
  const seen = {};
  return raw.map((c, j) => {
    let h = cellText(c) || `Column ${j + 1}`;
    if (seen[h]) h = `${h} (${++seen[h]})`; else seen[h] = 1;
    return h;
  });
}

export const isTotalsRow = row => row.some(c => typeof c === 'string' && /^\s*(grand\s*)?totals?\s*:?\s*$/i.test(c));

/** Rows below the header as objects keyed by header, plus the TOTALS row if present. */
export function bodyOf(grid, headerRow, headers) {
  const rows = [];
  let totals = null;
  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (!r.some(c => !isEmpty(c))) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, j) => { obj[h] = r[j] ?? null; });
    if (isTotalsRow(r)) { totals = obj; continue; }
    rows.push(obj);
  }
  return { rows, totals };
}

export const signatureOf = (type, headers) =>
  crypto.createHash('sha1').update(type + '|' + headers.map(norm).join('|')).digest('hex');

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export { cellText, isEmpty };
