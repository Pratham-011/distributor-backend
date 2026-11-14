// Settled / unsettled bills (Delivery Report Collection), with invented files in the layout the billing software exports.
//   RATE_LIMIT_DISABLED=1 PORT=4100 node src/index.js      then      node test/settlement.mjs <folder for the generated files>
import fs from 'node:fs';
import XLSX from 'xlsx';
import { makeFixtures } from './fixtures.mjs';

const dir = process.argv[2] || './data/test-settlement';
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const json = { 'Content-Type': 'application/json' };
const R = '?from=2026-11-02&to=2026-11-02';

async function account(name) {
  const email = `${name}${Date.now()}@test.in`;
  const reg = await (await fetch(B + '/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ name, email, password: 'Correct-horse-9', business_name: name + ' Co', state_code: '27' }) })).json();
  const tk = (await (await fetch(B + '/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ email, code: reg.demo_code }) })).json()).token;
  return { Authorization: 'Bearer ' + tk };
}
const xlsx = rows => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet3');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet2');     // these exports carry empty extra sheets
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
async function upload(H, name, buf) {
  const fd = new FormData(); fd.append('files', new Blob([buf]), name);
  const p = (await (await fetch(B + '/uploads/preview', { method: 'POST', headers: H, body: fd })).json()).files[0];
  const c = await (await fetch(B + '/uploads/commit', { method: 'POST', headers: { ...H, ...json },
    body: JSON.stringify({ token: p.token, report_type: p.report_type, header_row: p.header_row, mapping: p.mapping, date_format: p.date_format }) })).json();
  return { p, c };
}
const get = async (H, path) => (await fetch(B + path, { headers: H })).json();

// ---- the invented files
// Sales: plain numbers 9001-9004, series A 101-104, series Z 201-206. Every bill: taxable 1000 + CGST 90 + SGST 90.
const bills = [...[9001, 9002, 9003, 9004].map(n => String(n)), ...[101, 102, 103, 104].map(n => 'A' + n), ...[201, 202, 203, 204, 205, 206].map(n => 'Z' + n)];
const salesHead = ['Inv Date', 'Inv No', 'Party Code', 'Party Name', 'SKU Code', 'SKU Name', 'HSN Code', 'Qty', 'Rate', 'MRP', 'Amount', 'Disc', 'Taxable Amount', 'IGST %', 'IGST Amt', 'CGST %', 'CGST Amt', 'SGST %', 'SGST Amt', 'CESS %', 'CESS Amt', 'Net Amount'];
const salesRows = [['TEST DISTRIBUTORS'], ['PUNE'], [], ['GST Sales Register'], ['From: 02/11/2026  To: 02/11/2026'], [], salesHead,
  ...bills.map((b, i) => ['02/11/2026', b, 'P' + i, 'SHOP ' + b, '4300', 'CDM TEST 10G', '18069010', 10, 100, 120, 1000, 0, 1000, 0, 0, 9, 90, 9, 90, 0, 0, 1180])];
const total = n => n * 1180;

// Delivery Report Collection, as the software prints it: title lines, header, bills, #LINE, a summary block, TOTALS
function delivery(load, date, list) {
  const rows = [['TEST DISTRIBUTORS'], ['PUNE'], [], ['Delivery Report Collection'], [`Load No: ${load}   Date : ${date}`], [],
    ['Bill No', 'Series', 'Bill No', 'Party Name', 'Bill Amt', 'Cash', 'Cheque', 'Credit', 'Pending', 'Scheme', 'CD']];
  let sum = 0, cash = 0, credit = 0;
  for (const [no, series, amt] of list) {
    const c = amt && Number(no) % 2 ? amt : 0;
    rows.push([String(no), series, `${series}\\${no}`, 'SHOP ' + series + no, amt, c || '', '', amt - c, '', 0, 0]);
    sum += amt; cash += c; credit += amt - c;
  }
  rows.push(['#LINE'], [], ['', '', '', 'TYPE             BILLS'], ['', '', '', `TOTAL BILLS        ${list.length}`], ['#LINE'], [],
    ['', '', '', 'TOTALS:', sum, cash, 0, credit, 0, 0, 0]);
  return xlsx(rows);
}
// load 1: 9001, 9002, a cancelled 9004 (amount 0), A101-A103 and one Z bill (Z201). load 2 (same day): 9003 and A104.
const load1 = delivery(7001, '02/11/2026', [[9001, '', 1180], [9002, '', 1180], [9004, '', 0], [101, 'A', 1180], [102, 'A', 1180], [103, 'A', 1180], [201, 'Z', 1180]]);
const load2 = delivery(7002, '02/11/2026', [[9003, '', 1180], [104, 'A', 1180]]);

const cnHead = ['Inv Date', 'Inv No', 'REF No.', 'Party Code', 'Party Name', 'GSTR No', 'SKU Code', 'SKU Name', 'HSN Code', 'Qty', 'Rate', 'MRP', 'Amount', 'Disc', 'Taxable Amount',
  'IGST %', 'IGST Amt', 'CGST %', 'CGST Amt', 'SGST %', 'SGST Amt', 'CESS %', 'CESS Amt', 'Net Amount', 'Ref.InvNo', 'Ref.InvDate', 'CRN Type'];
// credit notes raised against: A101 (settled), Z202 (unsettled), 9003 (settled by load 2)
const cn = (no, ref) => ['02/11/2026', String(no), '', 'P1', 'SHOP', '', '4300', 'CDM TEST 10G', '18069010', 1, 100, 120, 100, 0, 100, 0, 0, 9, 9, 9, 9, 0, 0, 118, ref, '02/11/2026', 'DAMAGE'];
const cnFile = xlsx([['TEST DISTRIBUTORS'], ['PUNE'], [], ['GST Credit Note Register'], [], ['From: 02/11/2026  To: 02/11/2026'], [], cnHead, cn(501, 'A101'), cn(502, 'Z202'), cn(503, '9003')]);

// outstanding writes the series with a slash: "A/101", "Z/201", "/9001" (no series)
const out = (no, bal) => ['02/10/2026', no, 'SHOP', bal, 0, bal, 4, 'P1', 'RAVI'];
const outFile = xlsx([['TEST DISTRIBUTORS'], ['PUNE'], [], ['OutStanding Debtors Statement 2 Report'], ['OutStanding As On Date:14/11/2026'], [],
  ['Date', 'Bill No.', 'Party Name', 'Bill Amount', 'Receipt', 'Balance', 'Wk', 'Party Code', 'Salesman Name'],
  out('/9001', 1000), out('A/101', 2000), out('Z/201', 4000), out('Z/202', 8000), out('/9004', 16000)]);

const H = await account('Alpha');
console.log('Reading the Delivery Report Collection');
const first = await upload(H, 'Delivery Report Collection-7001.xlsx', load1);
ok(first.p.report_type === 'delivery', 'the file is recognised by its title, from the first of three sheets');
ok(first.p.header_row === 6, 'the header row is found below the title lines');
ok(first.p.mapping.bill_no === 'Bill No' && first.p.mapping.bill_ref === 'Bill No (2)' && first.p.mapping.series === 'Series', 'both "Bill No" columns and the series are matched');
ok(first.p.check.stats.bills === 7 && first.p.check.stats.cancelled === 1, 'seven bills, one of them cancelled (amount 0)');
ok(first.p.check.issues.length === 0, '#LINE, the summary block and TOTALS are not treated as bills: no warnings');
ok(first.p.check.reconciliation.every(r => r.status === 'match'), 'the totals match the file\'s TOTALS row');
ok(first.c.upload?.rows === 7, 'saved: 7 rows');
ok(first.p.period.from === '2026-11-02' && first.p.period.loads[0] === '7001', 'load date and number are read from the top');

console.log('Everything is "unsettled" until the registers are there, and the split always adds up');
await upload(H, 'GST Sales Register 02-11-26.xlsx', xlsx(salesRows));
const s1 = await get(H, '/reports/sales' + R);
ok(s1.totals.docs === 14 && Number(s1.totals.taxable) === 14000, 'sales register: 14 bills, ₹14,000');
const split = async path => { const o = {}; for (const s of ['all', 'settled', 'unsettled']) o[s] = await get(H, `${path}${R}&settle=${s}`); return o; };
let sales = await split('/reports/sales');
ok(sales.settled.totals.docs === 7 && sales.unsettled.totals.docs === 7, 'one load uploaded: its 7 bills are settled (the cancelled one included), the other 7 are unsettled');
ok(Number(sales.settled.totals.taxable) + Number(sales.unsettled.totals.taxable) === Number(sales.all.totals.taxable), 'settled + unsettled taxable = all');
const second = await upload(H, 'Delivery Report Collection-7002.xlsx', load2);
ok(second.c.upload?.rows === 2 && !second.c.replaced.length, 'a second load for the same day is added, it does not replace the first');
sales = await split('/reports/sales');
ok(sales.settled.totals.docs === 9 && sales.unsettled.totals.docs === 5, 'two loads: 9 settled, 5 unsettled');
const series = o => Object.fromEntries(o.series.map(x => [x.name, x.invoices]));
ok(series(sales.settled)['Numbers only'] === 4 && series(sales.settled).A === 4 && series(sales.settled).Z === 1, 'settled: all four plain bills, all four A bills, one Z bill');
ok(series(sales.unsettled).Z === 5 && !series(sales.unsettled).A && !series(sales.unsettled)['Numbers only'], 'unsettled: five Z bills');
ok(sales.all.totals.docs === 14, '"All bills" is unchanged by the filter');
const gst = await split('/reports/gst');
ok(Math.abs(Number(gst.settled.sales.tax) + Number(gst.unsettled.sales.tax) - Number(gst.all.sales.tax)) < 0.005, 'GST on sales: settled + unsettled = all');

console.log('Credit notes follow the bill they were raised against');
await upload(H, 'GST Credit Note Register 02-11-26.xlsx', cnFile);
const ret = await split('/reports/returns');
ok(ret.all.cn_list.length === 3 && ret.settled.cn_list.length === 2 && ret.unsettled.cn_list.length === 1, 'three notes: two follow settled bills (A101, 9003), one follows an unsettled bill (Z202)');
ok(Number(ret.settled.credit_note.taxable) + Number(ret.unsettled.credit_note.taxable) === Number(ret.all.credit_note.taxable), 'credit note value adds up');

console.log('Money to collect: "A/101", "/9001" and "Z/201" are the same bills as "A101", "9001", "Z201"');
await upload(H, 'OutStanding Debtors Statement 2 Report.xlsx', outFile);
const o = {}; for (const s of ['all', 'settled', 'unsettled']) o[s] = await get(H, `/reports/outstanding?settle=${s}`);
ok(o.all.summary.bills === 5 && o.settled.summary.bills === 4 && o.unsettled.summary.bills === 1, 'five unpaid bills: four settled (9001, A101, Z201, 9004), one unsettled (Z202)');
ok(Number(o.settled.summary.total) === 23000 && Number(o.unsettled.summary.total) === 8000, 'the amounts follow: ₹23,000 settled, ₹8,000 unsettled');
const q = await get(H, `/reports/outstanding/search?q=SHOP&settle=unsettled`);
ok(q.bills.length === 1 && q.bills[0].bill_no === 'Z/202', 'the party search follows the filter too');

console.log('The summary and the file list');
const sum = await get(H, '/reports/settlement' + R);
ok(sum.has_files && sum.settled_bills === 9 && sum.files === 2 && sum.sales.settled.bills === 9 && sum.sales.unsettled.bills === 5, 'summary: 9 settled bills in 2 files; 9 settled and 5 unsettled sales bills on the day');
const dates = await get(H, '/reports/dates');
ok(dates.latest.delivery === '2026-11-02', 'the day shows a Delivery Report Collection was uploaded');

console.log('Each settlement bill is checked against the Sales Register by its number');
let chk = await get(H, '/reports/settlement/check' + R);
const st9004 = chk.rows.find(r => r.bill_key === '9004');
ok(chk.summary.bills === 9 && chk.summary.match === 8 && chk.summary.differs === 1 && chk.summary.missing === 0, '9 bills: 8 with the same amount, 1 different (9004: cancelled in settlement, ₹1,180 in the register)');
ok(st9004?.status === 'differs' && Number(st9004.reg_value) === 1180 && chk.rows[0].bill_key === '9004', 'the bill with a problem is listed first, with both amounts');
await upload(H, 'Delivery Report Collection-7003.xlsx', delivery(7003, '02/11/2026', [[9999, '', 500]]));
chk = await get(H, '/reports/settlement/check' + R);
ok(chk.summary.missing === 1 && chk.rows[0].bill_key === '9999' && chk.rows[0].status === 'missing', 'a bill that is not in any uploaded Sales Register is reported as missing');
await fetch(B + `/uploads/${(await get(H, '/uploads')).uploads.find(u => u.file_name.includes('7003')).id}/undo`, { method: 'POST', headers: H });

console.log('Stock: settled only, or every bill');
const mv = {}; for (const s of ['all', 'settled', 'unsettled']) mv[s] = (await get(H, `/reports/stock/movement${R}&settle=${s}`)).items.reduce((a, i) => ({ sold: a.sold + Number(i.sold), rin: a.rin + Number(i.returned_in) }), { sold: 0, rin: 0 });
ok(mv.all.sold === 140 && mv.settled.sold === 90 && mv.unsettled.sold === 50, 'goods out: 140 units on all bills, 90 on settled, 50 on unsettled');
ok(mv.settled.rin === 2 && mv.unsettled.rin === 1, 'goods back: the credit notes of settled bills (2) and of the unsettled bill (1)');
const stA = await get(H, '/reports/stock?as_on=2026-11-02'), stS = await get(H, '/reports/stock?as_on=2026-11-02&settle=settled');
const qty = d => d.items.reduce((a, i) => a + Number(i.qty), 0);
ok(stS.settle === 'settled' && qty(stS) - qty(stA) === 50 - 1, 'stock in hand, settled only: 50 more units in hand (unsettled sales not taken out, their 1 returned unit not put back)');
ok((await get(H, '/reports/stock?as_on=2026-11-02&settle=unsettled')).settle === 'all', '"unsettled" has no meaning for goods in hand: every bill is counted');

console.log('Uploading, replacing and undoing');
const again = await upload(H, 'Delivery Report Collection-7001.xlsx', load1);
ok(again.c.replaced.length === 1, 'the very same file again replaces its earlier copy');
sales = await split('/reports/sales');
ok(sales.settled.totals.docs === 9, 'and nothing is counted twice');
const list = (await get(H, '/uploads')).uploads;
const l2 = list.find(u => u.file_name.includes('7002') && u.status === 'active');
const undo = await (await fetch(B + `/uploads/${l2.id}/undo`, { method: 'POST', headers: H })).json();
ok(undo.ok && !undo.restored.length, 'undoing a load removes only its own bills');
sales = await split('/reports/sales');
ok(sales.settled.totals.docs === 7 && sales.unsettled.totals.docs === 7, '9003 and A104 are unsettled again; load 1 is untouched');

console.log('Other businesses, purchases and receipts');
const H2 = await account('Beta');
await upload(H2, 'GST Sales Register 02-11-26.xlsx', xlsx(salesRows));
const beta = await get(H2, `/reports/sales${R}&settle=settled`);
ok(beta.totals.docs === 0, 'a business with its own bills never sees another business\'s settled bills');
const fx = `${dir}/fx`; makeFixtures(fx);
await upload(H, 'purchase.xlsx', fs.readFileSync(`${fx}/purchase.xlsx`));
const P = '?from=2026-09-01&to=2026-10-31';
const [pa, ps] = [await get(H, '/reports/purchases' + P), await get(H, '/reports/purchases' + P + '&settle=settled')];
ok(pa.totals.docs > 0 && JSON.stringify(pa) === JSON.stringify(ps), 'purchases are never split: the filter changes nothing there');
await upload(H, 'receipts.xlsx', fs.readFileSync(`${fx}/receipts.xlsx`));
const [ra, rs] = [await get(H, '/reports/collections' + P), await get(H, '/reports/collections' + P + '&settle=unsettled')];
ok(Number(ra.totals.total) > 0 && JSON.stringify(ra) === JSON.stringify(rs), 'receipts are not split either');
ok((await get(H, `/reports/sales${R}&settle=banana`)).totals.docs === 14, 'an unknown filter value just shows every bill');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
