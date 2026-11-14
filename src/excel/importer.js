// Applies a column mapping to a parsed sheet: typed values, row checks, document checks,
// and the totals cross-check against the file's own TOTALS row.
// All money arithmetic uses Decimal; values leave as strings for Postgres NUMERIC.
import Decimal from 'decimal.js';
import { REPORT_TYPES, SNAPSHOT_TYPES } from './reportTypes.js';
import { isEmpty, isoDate, cellText } from './read.js';
import { brandOf } from './brands.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });
const Z = new Decimal(0);
const PAISA = new Decimal('0.01');
const ROUND_OFF_MAX = new Decimal(1);
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const issue = (level, message, rows = []) => ({ level, message, rows: rows.slice(0, 30), count: rows.length });
// an error that comes with a suggested correction for every row (the person can accept them)
const fixable = (message, fixes) => ({ ...issue('error', message, fixes.map(f => f.row)), fixes });
// GST rates in use; CGST and SGST are each half of the rate
const IGST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const HALF_RATES = IGST_RATES.map(x => x / 2);

export function toDecimal(v) {
  if (isEmpty(v)) return Z;
  if (typeof v === 'number') return new Decimal(String(v));
  const s = String(v).replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) throw new Error('not a number');
  return new Decimal(s);
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "Oct", "oct.", "October", "Sept" -> 10 / 9; anything else -> 0
const monthOf = name => {
  const k = name.toLowerCase().replace(/\.$/, '');
  return k.length >= 3 ? MONTH_NAMES.findIndex(n => n.startsWith(k)) + 1 : 0;
};

export function toISODate(v, fmt = 'DMY') {
  if (isEmpty(v)) return null;
  if (v instanceof Date) return isoDate(v);
  // an Excel date that lost its date formatting shows up as its serial number (46296 = 1 Oct 2026)
  if (typeof v === 'number' && Number.isInteger(v) && v > 30000 && v < 70000) return isoDate(new Date(Date.UTC(1899, 11, 30) + v * 86400000));
  // text dates, sometimes with a time after them or a leading apostrophe from Excel
  const s = String(v).trim().replace(/^'/, '').replace(/[ T]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AP]M)?$/i, '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return check(+m[1], +m[2], +m[3]);
  // 02-Oct-2026, 2 Oct 2026, 02/Oct/26, 2-October-2026
  m = s.match(/^(\d{1,2})[\s/.-]+([A-Za-z]{3,9}\.?)[\s/.,-]+(\d{2}|\d{4})$/);
  if (m && monthOf(m[2])) return check(year(+m[3]), monthOf(m[2]), +m[1]);
  // Oct 02, 2026 / October 2 2026
  m = s.match(/^([A-Za-z]{3,9}\.?)[\s/.-]+(\d{1,2})(?:st|nd|rd|th)?[\s,/.-]+(\d{2}|\d{4})$/);
  if (m && monthOf(m[1])) return check(year(+m[3]), monthOf(m[1]), +m[2]);
  m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
  if (!m) throw new Error('bad date');
  let [a, b, c] = [+m[1], +m[2], +m[3]];
  let y, mo, d;
  if (fmt === 'YMD') [y, mo, d] = [a, b, c];
  else if (fmt === 'MDY') [mo, d, y] = [a, b, c];
  else [d, mo, y] = [a, b, c];
  return check(year(y), mo, d);
  function year(y) { return y < 100 ? y + 2000 : y; }
  function check(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error('bad date');
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}

const textVal = v => {
  if (isEmpty(v)) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return cellText(v);
};

/**
 * accept: ids of suggested corrections the person accepted (see `fixes` on issues), e.g. "134:discount".
 * Memory: body.rows is used up (each raw row is let go once it is converted); body.totals is kept.
 * @returns {{ rows, issues, reconciliation, period, stats, errors:boolean }}
 */
export function applyMapping(typeKey, body, mapping, { dateFormat = 'DMY', banner = {}, homeState, accept = [] } = {}) {
  const T = REPORT_TYPES[typeKey];
  const issues = [];
  const fields = T.fields.filter(f => mapping[f.key]);
  const missing = T.fields.filter(f => f.required && !mapping[f.key]);
  if (missing.length) {
    return { errors: true, rows: [], reconciliation: [], period: {}, stats: {},
      issues: [issue('error', 'Please choose a column for: ' + missing.map(f => f.label).join(', '))] };
  }
  const docKey = T.fields.find(f => f.required && f.kind === 'text').key; // doc_no / v_no / bill_no
  const bad = {};       // field label -> rows
  const out = [];
  let skipped = [];

  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i];
    body.rows[i] = null;   // the raw row is not needed again: let it go now rather than at the end
    const rec = { row_no: r._row };
    for (const f of T.fields) if (!mapping[f.key] && !['text', 'date'].includes(f.kind)) rec[f.key] = f.kind === 'int' ? 0 : Z;
    for (const f of fields) {
      const v = r[mapping[f.key]];
      try {
        if (f.kind === 'date') rec[f.key] = toISODate(v, dateFormat);
        else if (f.kind === 'text') rec[f.key] = textVal(v);
        else if (f.kind === 'int') rec[f.key] = toDecimal(v).round().toNumber();
        else rec[f.key] = toDecimal(v);                       // money / qty / rate / pct
      } catch {
        (bad[f.label] ||= []).push(r._row);
      }
    }
    if (T.keepRow && !T.keepRow(rec)) continue;     // summary / separator rows that are not data (Delivery Report Collection)
    if (!rec[docKey]) { if (Object.keys(rec).length > 2) skipped.push(r._row); continue; }
    out.push(rec);
  }
  for (const [label, rows] of Object.entries(bad)) {
    issues.push(issue('error', `"${label}" has values that are not ${T.fields.find(f => f.label === label).kind === 'date' ? 'dates' : 'numbers'}. Check that the right column is chosen.`, rows));
  }
  if (skipped.length) issues.push(issue('warning', `${skipped.length} row(s) had no ${T.fields.find(f => f.key === docKey).label.toLowerCase()} and were skipped`, skipped));
  for (const f of T.fields.filter(f => f.required && f.kind === 'date')) {
    const blank = out.filter(r => !r[f.key]).map(r => r.row_no);
    if (blank.length) issues.push(issue('error', `"${f.label}" is empty on some rows`, blank));
  }
  if (!out.length) issues.push(issue('error', 'No data rows found under the header row.'));

  // ---- money rounding to paisa (as printed) ----
  for (const r of out) for (const f of fields) if (f.kind === 'money' && r[f.key] instanceof Decimal) r[f.key] = r[f.key].toDecimalPlaces(2);

  // ---- totals cross-check (the core "no calculation mistakes" check) ----
  const reconciliation = [];
  if (body.totals) {
    for (const f of fields.filter(f => ['money', 'qty'].includes(f.kind))) {
      const tv = body.totals[mapping[f.key]];
      if (isEmpty(tv) || typeof tv === 'string' && !/\d/.test(tv)) continue;
      let fileV; try { fileV = toDecimal(tv).toDecimalPlaces(2); } catch { continue; }
      const ours = out.reduce((a, r) => a.plus(r[f.key] || Z), Z);
      const diff = ours.minus(fileV);
      // document totals (net amount) are repeated per line in these exports, so their column sum is not meaningful
      if (f.key === 'net_amount' && T.table === 'doc_lines') continue;
      const status = diff.abs().lt(PAISA) ? 'match' : diff.abs().lt(1) ? 'rounded' : 'mismatch';
      reconciliation.push({ field: f.key, label: f.label, ours: ours.toFixed(2), file: fileV.toFixed(2), diff: diff.toFixed(2), status });
      if (status === 'mismatch') issues.push(issue('error', `Total of "${f.label}" is ${ours.toFixed(2)} but the file's TOTALS row says ${fileV.toFixed(2)}. A wrong column may be chosen, or rows are missing.`));
    }
  } else {
    issues.push(issue('warning', 'This file has no TOTALS row, so totals could not be cross-checked against the file.'));
  }

  // ---- type-specific checks + derived fields ----
  // (corrections happen here, after the TOTALS cross-check, which must compare the file with itself)
  if (T.table === 'doc_lines') docChecks(typeKey, out, mapping, issues, homeState, new Set(accept));
  if (typeKey === 'receipt') receiptChecks(out, issues);
  if (typeKey === 'outstanding') outstandingChecks(out, issues);
  if (typeKey === 'stock') stockChecks(out, mapping, issues);
  if (typeKey === 'delivery') deliveryChecks(out, banner, issues);

  // ---- period ----
  // snapshots (Outstanding, Stock) are "as on" one date, taken from the title rows; registers cover their row dates
  const snapshot = SNAPSHOT_TYPES.includes(typeKey);
  let period;
  if (snapshot) {
    const d = banner.to || banner.from || null;
    period = { from: d, to: d };
    if (!d && typeKey === 'stock') {
      // stock reports don't always print a date: take today's, and say so
      const today = new Date().toISOString().slice(0, 10);
      period = { from: today, to: today };
      issues.push(issue('warning', `No "As on" date at the top of this file, so it is saved as the stock on ${today.split('-').reverse().join('/')} (today).`));
    } else if (!d) {
      issues.push(issue('error', 'Could not find the "As on" date at the top of this file.'));
    }
  } else if (typeKey === 'delivery') {
    // no date column: the load date(s) printed at the top of the file
    period = { from: banner.from || null, to: banner.to || null };
    if (!period.from) {
      const today = new Date().toISOString().slice(0, 10);
      period = { from: today, to: today };
      issues.push(issue('warning', `No load date at the top of this file, so it is saved with today's date (${today.split('-').reverse().join('/')}). The bills are still marked settled.`));
    }
  } else {
    const dateKey = T.fields.find(f => f.required && f.kind === 'date').key;
    const dates = out.map(r => r[dateKey]).filter(Boolean).sort();
    period = { from: banner.from || dates[0] || null, to: banner.to || dates[dates.length - 1] || null };
    if (dates.length && period.from && (dates[0] < period.from || dates[dates.length - 1] > period.to)) {
      period = { from: dates[0] < period.from ? dates[0] : period.from, to: dates[dates.length - 1] > period.to ? dates[dates.length - 1] : period.to };
    }
  }

  const sumOf = k => out.reduce((a, r) => a.plus(r[k] || Z), Z).toFixed(2);
  const stats = { rows: out.length, ...(T.table === 'doc_lines' ? { taxable: sumOf('taxable'), docs: new Set(out.map(r => r.doc_no)).size }
    : typeKey === 'receipt' ? { amount: sumOf('amount') }
      : typeKey === 'delivery' ? { bills: new Set(out.map(r => r.bill_key)).size, amount: sumOf('bill_amount'), cancelled: out.filter(r => r.bill_amount.isZero()).length }
      : typeKey === 'stock' ? { items: new Set(out.map(r => r.sku_code)).size, stock_qty: sumOf('closing_qty'), ...(mapping.value || mapping.rate ? { stock_value: sumOf('value') } : {}) }
        : { balance: sumOf('balance') }) };
  // decimals -> exact strings for Postgres, in place (a second copy of every row would double the memory)
  for (const r of out) for (const k in r) if (r[k] instanceof Decimal) r[k] = r[k].toFixed();
  const rows = out;
  return { rows, issues, reconciliation, period, stats, errors: issues.some(i => i.level === 'error') };
}

function docChecks(typeKey, out, mapping, issues, homeState, accept) {
  const has = k => !!mapping[k];
  const tax = r => ['cgst', 'sgst', 'igst', 'cess'].reduce((a, k) => a.plus(as(r, k) || Z), Z);
  const rowsWhere = fn => out.filter(fn).map(r => r.row_no);
  const label = Object.fromEntries(REPORT_TYPES[typeKey].fields.map(f => [f.key, f.label]));
  const corrected = [];
  // Suggested but not yet accepted corrections, per row. Later checks look at the row as if they were
  // accepted, so one typo doesn't also show up as "wrong GST" or "wrong bill total".
  const suggested = new Map();   // row_no -> { field: value }
  const as = (r, k) => suggested.get(r.row_no)?.[k] ?? r[k];
  // A suggested correction: applied straight away if the person has accepted it, otherwise shown to them.
  const correct = (r, field, to, why, pending) => {
    const pct = field.endsWith('_pct');
    const fix = { id: `${r.row_no}:${field}`, row: r.row_no, doc_no: r.doc_no, item: r.sku_name || r.sku_code || '',
      field, label: label[field], from: pct ? r[field].toFixed() : r[field].toFixed(2), to: pct ? to.toFixed() : to.toFixed(2), why };
    if (accept.has(fix.id)) { r[field] = to; corrected.push(fix); return; }
    pending.push(fix);
    suggested.set(r.row_no, { ...suggested.get(r.row_no), [field]: to });
  };

  for (const r of out) r.brand = brandOf(r.sku_name);

  if (has('amount') && has('discount')) {
    const pending = [];
    for (const r of out.filter(r => r.amount.minus(r.discount).minus(r.taxable).abs().gt(PAISA))) fixDiscountLine(r, correct, pending);
    if (pending.length) issues.push(fixable('Amount minus Discount does not equal Taxable amount', pending));
  }
  for (const t of ['cgst', 'sgst', 'igst', 'cess']) {
    if (!has(t) || !has(t + '_pct')) continue;
    const pending = [];
    for (const r of out.filter(r => as(r, 'taxable').times(r[t + '_pct']).div(100).toDecimalPlaces(2).minus(r[t]).abs().gt(PAISA))) {
      fixTaxLine(r, t, as(r, 'taxable'), correct, pending);
    }
    if (pending.length) issues.push(fixable(`${t.toUpperCase()} amount is not Taxable × ${t.toUpperCase()} %`, pending));
  }
  if (corrected.length) {
    issues.push({ ...issue('warning', `You accepted ${corrected.length} correction${corrected.length > 1 ? 's' : ''}. The corrected values are used in the reports; the original file is kept unchanged.`,
      corrected.map(c => c.row)), corrections: corrected });
  }
  const cs = rowsWhere(r => !as(r, 'cgst').eq(as(r, 'sgst')));
  if (cs.length) issues.push(issue('error', 'CGST and SGST are different on some lines', cs));
  if (has('qty') && has('rate') && has('amount')) {
    const m = rowsWhere(r => r.qty.times(r.rate).minus(r.amount).abs().gt(r.qty.abs().times('0.00005').plus(PAISA)));
    if (m.length) issues.push(issue('warning', 'Quantity × Rate is different from Amount', m));
  }

  // document totals: printed net amount vs taxable + GST
  const docs = new Map();
  for (const r of out) {
    const d = docs.get(r.doc_no) || { lines: [], calc: Z, printed: new Set() };
    // (a file with unaccepted corrections can't be saved, so the suggested values only steer the check)
    d.lines.push(r); d.calc = d.calc.plus(as(r, 'taxable')).plus(tax(r));
    if (has('net_amount')) d.printed.add((r.net_amount || Z).toFixed(2));
    docs.set(r.doc_no, d);
  }
  let allZero = has('net_amount'), varies = [], big = [];
  for (const [, d] of docs) {
    const printed = has('net_amount') ? new Decimal([...d.printed][0]) : Z;
    if (d.printed.size > 1) varies.push(d.lines[0].row_no);
    if (!printed.isZero()) allZero = false;
    if (!printed.isZero() && printed.minus(d.calc).abs().gt(ROUND_OFF_MAX)) big.push(d.lines[0].row_no);
    const value = printed.isZero() ? d.calc.toDecimalPlaces(2) : printed;
    for (const l of d.lines) l.doc_value = value;
  }
  if (!has('net_amount')) for (const r of out) r.net_amount = Z;
  if (varies.length) issues.push(issue('error', 'Bill total is not the same on every line of a bill', varies));
  if (big.length) issues.push(issue('error', `${big.length} bill(s) where the bill total differs from Taxable + GST by more than ₹1`, big));
  if (allZero && out.length) issues.push(issue('warning', 'The bill total (Net Amount) column is empty or 0 in this file. We calculated it as Taxable + GST.'));

  if (has('gstin')) {
    // A wrong party GSTIN doesn't change any amount, and it can only be corrected in the billing
    // software, so it is a warning that names the GSTIN and suggests the likely fix.
    const badOnes = out.filter(r => r.gstin && !GSTIN_RE.test(r.gstin.toUpperCase()));
    if (badOnes.length) {
      const values = [...new Set(badOnes.map(r => r.gstin.toUpperCase()))];
      issues.push(issue('warning',
        `${values.length} party GSTIN${values.length > 1 ? 's are' : ' is'} not in the correct format: ` +
        values.slice(0, 5).map(gstinHint).join('; ') + (values.length > 5 ? ` and ${values.length - 5} more` : '') +
        '. Please correct these in your billing software. GSTR-1 needs valid GSTINs.', badOnes.map(r => r.row_no)));
    }
    // the business's own state, chosen at sign-up; the env setting is only for accounts made before that
    const home = homeState || process.env.HOME_STATE_CODE || '27';
    const other = rowsWhere(r => r.gstin && GSTIN_RE.test(r.gstin.toUpperCase()) && r.gstin.slice(0, 2) !== home && r.igst.isZero() && !r.cgst.isZero());
    if (other.length) issues.push(issue('error', 'Out-of-state party charged CGST/SGST instead of IGST', other));
  }
  if (typeKey === 'sales' && has('party_type')) {
    const reg = out.filter(r => String(r.party_type || '').toUpperCase() === 'REGISTERED' && !r.gstin);
    if (reg.length) {
      const n = new Set(reg.map(r => r.doc_no)).size;
      issues.push(issue('warning', `${n} invoice(s) are marked Registered (B2B) but have no GSTIN. GSTR-1 B2B needs a GSTIN, so the party details may need fixing.`, reg.map(r => r.row_no)));
    }
  }
}

// Amount − Discount ≠ Taxable. GST is charged on the taxable amount, so the GST printed on the line
// shows which number is wrong: if it fits Amount − Discount, Taxable is wrong; otherwise Discount (or Amount) is.
function fixDiscountLine(r, correct, pending) {
  const rate = r.cgst_pct.plus(r.sgst_pct).plus(r.igst_pct).div(100);
  const gst = r.cgst.plus(r.sgst).plus(r.igst);
  const net = r.amount.minus(r.discount);
  const fits = base => rate.gt(0) && base.times(rate).minus(gst).abs().lte('0.02');
  if (fits(net) && !fits(r.taxable)) {
    correct(r, 'taxable', net, `the GST on this line (${gst.toFixed(2)}) was worked out on ${net.toFixed(2)}, which is Amount − Discount`, pending);
  } else if (r.amount.gte(r.taxable)) {
    correct(r, 'discount', r.amount.minus(r.taxable), `Amount ${r.amount.toFixed(2)} − Taxable ${r.taxable.toFixed(2)}; the GST agrees with the Taxable amount`, pending);
  } else {
    correct(r, 'amount', r.taxable.plus(r.discount), `Taxable ${r.taxable.toFixed(2)} + Discount ${r.discount.toFixed(2)}; the GST agrees with the Taxable amount`, pending);
  }
}

// Tax amount ≠ Taxable × %. If the amount is exactly a real GST rate of Taxable, the % is the wrong one;
// otherwise the amount is.
// `taxable` is the line's taxable amount, after any correction suggested for it.
function fixTaxLine(r, t, taxable, correct, pending) {
  const T = t.toUpperCase();
  const rates = t === 'igst' ? IGST_RATES : t === 'cess' ? [] : HALF_RATES;
  const real = taxable.gt(0) ? rates.find(x => taxable.times(x).div(100).toDecimalPlaces(2).minus(r[t]).abs().lte(PAISA)) : undefined;
  if (typeof real === 'number') {
    correct(r, t + '_pct', new Decimal(real), `${T} amount ${r[t].toFixed(2)} is exactly ${real}% of Taxable ${taxable.toFixed(2)}`, pending);
  } else {
    correct(r, t, taxable.times(r[t + '_pct']).div(100).toDecimalPlaces(2), `Taxable ${taxable.toFixed(2)} × ${r[t + '_pct'].toFixed()}%`, pending);
  }
}

// GSTIN = 2-digit state + PAN (5 letters, 4 digits, 1 letter) + entity number + Z + check character.
// The usual typing mistake is O for 0 or I for 1 (and the other way round) in the wrong place.
const GSTIN_DIGIT_AT = [0, 1, 7, 8, 9, 10];
const GSTIN_LETTER_AT = [2, 3, 4, 5, 6, 11];
export function gstinHint(g) {
  const shown = `"${g}"`;
  if (g.length !== 15) return `${shown} has ${g.length} characters, a GSTIN has 15`;
  const fixed = [...g], notes = [];
  for (const i of GSTIN_DIGIT_AT) {
    const to = { O: '0', I: '1' }[fixed[i]];
    if (to) { notes.push(`letter ${fixed[i]} typed instead of ${to === '0' ? 'zero (0)' : 'one (1)'}`); fixed[i] = to; }
  }
  for (const i of GSTIN_LETTER_AT) {
    const to = { 0: 'O', 1: 'I' }[fixed[i]];
    if (to) { notes.push(`${fixed[i] === '0' ? 'zero (0)' : 'one (1)'} typed instead of letter ${to}`); fixed[i] = to; }
  }
  const guess = fixed.join('');
  return notes.length && GSTIN_RE.test(guess) ? `${shown} should probably be ${guess} (${[...new Set(notes)].join(', ')})` : shown;
}

function receiptChecks(out, issues) {
  for (const r of out) {
    const acc = String(r.account || '').toUpperCase();
    const chq = String(r.cheque_no || '').toUpperCase();
    r.mode = acc.includes('CASH') ? 'Cash'
      : ['RTGS', 'NEFT', 'UPI', 'IMPS'].includes(chq) || String(r.bank || '').toUpperCase().includes('ONLINE') ? 'Online' : 'Cheque';
    let c = String(r.collected_by || '').replace(/^[.\s]+|[.\s]+$/g, '');
    r.collected_by = !c ? 'Not given' : c.toUpperCase() === 'COLLECTION' ? 'Office counter' : c;
  }
  const neg = out.filter(r => r.amount.lte(0)).map(r => r.row_no);
  if (neg.length) issues.push(issue('error', 'Receipt with zero or minus amount', neg));
  const noChq = out.filter(r => r.mode !== 'Cash' && !r.cheque_no).map(r => r.row_no);
  if (noChq.length) issues.push(issue('warning', 'Bank receipt without cheque / UTR number', noChq));
  const seen = new Map(), dup = [];
  for (const r of out) { if (seen.has(r.v_no)) dup.push(r.row_no, seen.get(r.v_no)); else seen.set(r.v_no, r.row_no); }
  if (dup.length) issues.push(issue('error', 'The same receipt number appears more than once', [...new Set(dup)]));
}

function stockChecks(out, mapping, issues) {
  for (const r of out) {
    r.brand = brandOf(r.sku_name);
    // no value column: work it out from the rate when there is one
    if (!mapping.value && mapping.rate) r.value = r.closing_qty.times(r.rate).toDecimalPlaces(2);
    else if (!mapping.value) r.value = null;
  }
  const neg = out.filter(r => r.closing_qty.lt(0)).map(r => r.row_no);
  if (neg.length) issues.push(issue('warning', 'Some items show minus stock (sold more than received). Check them in the billing software.', neg));
  if (mapping.opening_qty && mapping.in_qty && mapping.out_qty) {
    const m = out.filter(r => r.opening_qty.plus(r.in_qty).minus(r.out_qty).minus(r.closing_qty).abs().gt('0.001')).map(r => r.row_no);
    if (m.length) issues.push(issue('warning', 'Opening + In − Out is not equal to Closing quantity on some rows', m));
  }
  if (!mapping.value && !mapping.rate) {
    issues.push(issue('warning', 'This file has no value or rate column, so stock value will be worked out from your latest purchase rates.'));
  }
}

// The key a bill is matched on everywhere: series + number, letters and digits only ("A\15727" -> "A15727").
export const billKey = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function deliveryChecks(out, banner, issues) {
  const seen = new Map(), dup = [];
  const loads = (banner.loads || []).join(', ') || null;
  for (const r of out) {
    const no = String(r.bill_no).trim();
    const ref = billKey(r.bill_ref);
    // the printed "A\15727" is what the billing software calls the bill; otherwise series + number
    r.bill_key = ref && ref.endsWith(no) ? ref : billKey(`${r.series || ''}${no}`);
    r.series = billKey(r.series) || null;
    r.load_no = loads;
    if (seen.has(r.bill_key)) dup.push(r.row_no, seen.get(r.bill_key)); else seen.set(r.bill_key, r.row_no);
  }
  if (dup.length) issues.push(issue('warning', 'The same bill appears more than once in this file', [...new Set(dup)]));
  const off = out.filter(r => r.cash.plus(r.cheque).plus(r.credit).plus(r.pending).minus(r.bill_amount).abs().gt(ROUND_OFF_MAX)).map(r => r.row_no);
  if (off.length) issues.push(issue('warning', 'Cash + Cheque + Credit + Pending is not equal to the Bill amount on some bills', off));
}

function outstandingChecks(out, issues) {
  for (const r of out) {
    r.received ||= Z;
    r.party_name = String(r.party_name || '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/[.\s]+$/, '').trim();
    r.salesman = String(r.salesman || '').replace(/^[.\s]+|[.\s]+$/g, '') || 'Not given';
  }
  const m = out.filter(r => r.bill_amount.minus(r.received).minus(r.balance).abs().gt(PAISA)).map(r => r.row_no);
  if (m.length) issues.push(issue('warning', 'Bill amount minus Received is not equal to Balance on some rows', m));
}
