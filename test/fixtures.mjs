// Invented test files (no real customers). Same content every run, so results can be compared before / after a change.
// node test/fixtures.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

XLSX.set_fs(fs);   // the ES-module build of SheetJS writes files only after it is given fs

export function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let seed = 7;
  const rnd = n => (seed = (seed * 9301 + 49297) % 233280) / 233280 * n;
  const r2 = x => Math.round(x * 100) / 100;
  const items = Array.from({ length: 24 }, (_, i) => ({ code: String(4300200 + i), name: `CDM DAIRY MILK ${10 + i}G RS.${[5, 10, 20, 45][i % 4]}`, rate: 4 + i, mrp: [5, 10, 20, 45][i % 4] }));
  const shops = Array.from({ length: 18 }, (_, i) => ({ code: String(1320100 + i), name: `TEST SHOP ${i + 1}`, gstin: i % 3 ? `27ABCDE${String(1000 + i)}F1Z5` : '' }));
  const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const write = (rows, name, opts) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), 'Sheet1');
    XLSX.writeFile(wb, path.join(dir, name), opts);
  };
  const KIND = {
    purchase: ['GST Purchase Register', 'V.Date', 'V.No', 'Supplier Code', 'Supplier Name', ['Bill No', 'Bill Date'], (n, d) => ['MDLZ' + n, d]],
    sales: ['GST Sales Register', 'Inv Date', 'Inv No', 'Party Code', 'Party Name', ['Party Type', 'GSTR No', 'GSTR1'], (n, d, p) => [p.gstin ? 'REGISTERED' : 'UNREGISTERED', p.gstin, p.gstin ? 'B2B' : 'B2CS']],
    credit_note: ['GST Credit Note Register', 'CN Date', 'CN No', 'Party Code', 'Party Name', ['CRN Type', 'Ref Inv No'], () => ['DAMAGE', 'A100']],
    debit_note: ['GST Debit Note Register', 'DN Date', 'DN No', 'Supplier Code', 'Supplier Name', ['Ref Inv No'], () => ['MDLZ9']],
  };
  function register(type, from, to, day, docs, pick, file, opts) {
    const [title, dh, nh, ch, nmh, xh, xv] = KIND[type];
    const H = [dh, nh, ch, nmh, 'SKU Code', 'SKU Name', 'HSN Code', 'Qty', 'Rate', 'MRP', 'Amount', 'Disc', 'Taxable Amount',
      'IGST %', 'IGST Amt', 'CGST %', 'CGST Amt', 'SGST %', 'SGST Amt', 'CESS %', 'CESS Amt', 'Net Amount', ...xh];
    const rows = [['TEST DISTRIBUTORS'], [title], [`From: ${from} To: ${to}`], [], H];
    const tot = { q: 0, a: 0, d: 0, t: 0, g: 0 };
    for (let b = 0; b < docs; b++) {
      const party = type === 'purchase' || type === 'debit_note' ? { code: 'MDLZ', name: 'MONDELEZ INDIA FOODS', gstin: '' } : shops[b % shops.length];
      const lines = pick(b).map(([it, q]) => {
        const amount = r2(q * it.rate), disc = r2(amount * 0.02), taxable = r2(amount - disc), gst = r2(taxable * 0.09);
        return { it, q, amount, disc, taxable, gst };
      });
      const net = r2(lines.reduce((a, l) => a + l.taxable + 2 * l.gst, 0));
      for (const l of lines) {
        rows.push([day(b), type[0].toUpperCase() + (100 + b), party.code, party.name, l.it.code, l.it.name, '18069010', l.q, l.it.rate, l.it.mrp, l.amount, l.disc, l.taxable,
          0, 0, 9, l.gst, 9, l.gst, 0, 0, net, ...xv(b, day(b), party)]);
        tot.q += l.q; tot.a += l.amount; tot.d += l.disc; tot.t += l.taxable; tot.g += l.gst;
      }
    }
    const t = Array(H.length).fill(null);
    t[0] = 'TOTAL'; t[7] = tot.q; t[10] = r2(tot.a); t[11] = r2(tot.d); t[12] = r2(tot.t); t[16] = r2(tot.g); t[18] = r2(tot.g);
    rows.push(t);
    write(rows, file, opts);
  }
  const line = b => [[items[b % 20], 6 + 6 * Math.floor(rnd(4))], [items[(b * 7) % 24], 12]];
  // real Excel dates, .xlsx
  register('purchase', '30/09/2026', '30/09/2026', () => utc(2026, 9, 30), 4, b => items.slice(b * 5, b * 5 + 5).map(it => [it, 500 + 20 * (+it.code % 7)]), 'purchase.xlsx');
  register('sales', '01/10/2026', '01/10/2026', () => utc(2026, 10, 1), 60, line, 'sales.xlsx');
  // text dates like 02-Oct-2026, old .xls format
  register('sales', '02/10/2026', '02/10/2026', () => '02-Oct-2026', 40, line, 'sales_oct2.xls', { bookType: 'biff8' });
  // dd/mm/yyyy text, csv
  register('sales', '03/10/2026', '03/10/2026', () => '03/10/2026', 30, line, 'sales_oct3.csv', { bookType: 'csv' });
  register('credit_note', '01/10/2026', '01/10/2026', () => utc(2026, 10, 1), 3, b => [[items[b], 6]], 'credit_note.xlsx');
  register('debit_note', '01/10/2026', '01/10/2026', () => utc(2026, 10, 1), 2, b => [[items[b + 2], 10]], 'debit_note.xlsx');

  const rec = [['TEST DISTRIBUTORS'], ['Receipt Book'], ['From: 01/09/2026 To: 01/09/2026'], [],
    ['V.Date', 'V.No', 'A/C Code', 'Credit Account', 'City', 'Amount', 'Debit Account', 'Cheque No', 'Cheque Date', 'Bank', 'Salesman']];
  for (let i = 0; i < 40; i++) {
    const s = shops[i % shops.length], kind = i % 5 === 0 ? 'chq' : i % 3 === 0 ? 'online' : 'cash';
    rec.push([utc(2026, 9, 1), 'R' + (1001 + i), s.code, s.name, ['KALYAN', 'THANE', 'DOMBIVLI'][i % 3], Math.round(rnd(25000) + 500) + (i % 4) * 0.25,
      kind === 'cash' ? 'CASH IN HAND' : 'HDFC CURRENT A/C', kind === 'chq' ? String(400100 + i) : kind === 'online' ? ['NEFT', 'UPI', 'RTGS'][i % 3] : '',
      kind === 'chq' ? utc(2026, 9, 5) : '', kind === 'cash' ? '' : ['HDFC BANK', 'SBI'][i % 2], ['RAMESH', 'SURESH', 'COLLECTION'][i % 3]]);
  }
  // a workbook like many exports: empty first sheet, data on the second, a small notes sheet
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rec, { cellDates: true }), 'Receipts');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Printed by', 'DMS']]), 'Info');
  XLSX.writeFile(wb, path.join(dir, 'receipts.xlsx'));

  const os = [['TEST DISTRIBUTORS'], ['Outstanding Debtors Statement'], ['As On 01/10/2026'], [],
    ['Date', 'Trn', 'Bill No', 'Party Name', 'Party Code', 'Bill Amount', 'Receipt', 'Balance', 'Wk', 'Salesman Name']];
  for (let i = 0; i < 60; i++) {
    const amt = Math.round(rnd(20000) + 500), got = i % 3 ? 0 : Math.round(amt / 2), wk = i % 16;
    os.push([new Date(Date.UTC(2026, 9, 1) - wk * 7 * 86400000), 'SAL', 'B' + (7000 + i), shops[i % 9].name, shops[i % 9].code, amt, got, amt - got, wk, ['Murali', 'Ajit Jha', 'Ashok Nakka'][i % 3]]);
  }
  write(os, 'outstanding.xlsx');

  const st = [['TEST DISTRIBUTORS'], ['Stock Statement'], ['As On 30/09/2026'], [], ['Item Code', 'Item Name', 'Batch No', 'Expiry Date', 'Closing Qty', 'Rate', 'Closing Value']];
  for (const [i, it] of items.entries()) st.push([it.code, it.name, 'B' + i, utc(2027, 1 + (i % 12), 28), 500 + i * 10, it.rate, r2((500 + i * 10) * it.rate)]);
  write(st, 'stock.xlsx');
  return ['purchase.xlsx', 'sales.xlsx', 'sales_oct2.xls', 'sales_oct3.csv', 'credit_note.xlsx', 'debit_note.xlsx', 'receipts.xlsx', 'outstanding.xlsx', 'stock.xlsx'];
}

if (process.argv[1]?.endsWith('fixtures.mjs')) console.log(makeFixtures(process.argv[2] || './test-files').join(', '));
