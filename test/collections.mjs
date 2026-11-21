// Money received from the Daily Sales Collection Report + cash/cheques at delivery, and what is left to collect.
// Invented files in the layout the billing software exports.
//   RATE_LIMIT_DISABLED=1 PORT=4100 node src/index.js      then      node test/collections.mjs <fixtures folder>
import fs from 'node:fs';
import XLSX from 'xlsx';
import { makeFixtures } from './fixtures.mjs';

const dir = process.argv[2] || './data/test-collections';
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const json = { 'Content-Type': 'application/json' };
const xlsx = rows => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet3');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Sheet2');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const email = `coll${Date.now()}@test.in`;
const reg = await (await fetch(B + '/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Coll', email, password: 'Correct-horse-9', business_name: 'Coll Co', state_code: '27' }) })).json();
const H = { Authorization: 'Bearer ' + (await (await fetch(B + '/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ email, code: reg.demo_code }) })).json()).token };
async function upload(name, buf) {
  const fd = new FormData(); fd.append('files', new Blob([buf]), name);
  const p = (await (await fetch(B + '/uploads/preview', { method: 'POST', headers: H, body: fd })).json()).files[0];
  if (p.error) return { p };
  const c = await (await fetch(B + '/uploads/commit', { method: 'POST', headers: { ...H, ...json },
    body: JSON.stringify({ token: p.token, report_type: p.report_type, header_row: p.header_row, mapping: p.mapping, date_format: p.date_format }) })).json();
  return { p, c };
}
const get = async path => (await fetch(B + path, { headers: H })).json();

// Delivery on 10 Nov: 5001 paid in cash, 5002 on credit, A601 part cheque, 5003 and 5004 on credit
const dHead = ['Bill No', 'Series', 'Bill No', 'Party Name', 'Bill Amt', 'Cash', 'Cheque', 'Credit', 'Pending', 'Scheme', 'CD'];
const dRows = [['5001', '', '\\5001', 'SHOP ONE', 1000, 1000, '', 0, '', 0, 0], ['5002', '', '\\5002', 'SHOP ONE', 2000, '', '', 2000, '', 0, 0],
  ['601', 'A', 'A\\601', 'SHOP TWO', 3000, '', 1000, 2000, '', 0, 0], ['5003', '', '\\5003', 'SHOP THREE', 500, '', '', 500, '', 0, 0],
  ['5004', '', '\\5004', 'SHOP FOUR', 700, '', '', 700, '', 0, 0],
  ['5005', '', '\\5005', 'SHOP FIVE', 900, '', 900, 0, '', 0, 0]];      // 5005: cheque at delivery, not yet in a collection report
const delivery = xlsx([['TEST DISTRIBUTORS'], ['PUNE'], [], ['Delivery Report Collection'], ['Load No: 8001   Date : 10/11/2026'], [], dHead, ...dRows,
  ['#LINE'], [], ['', '', '', 'TOTALS:', 8100, 1000, 1900, 5200, 0, 0, 0]]);

// Daily Sales Collection Report for 13 Nov, as printed: title lines, header, "Salesman Name" headings, TOTALS
const cHead = ['Rec. No', 'Party', 'Bill No.', 'BillDate', 'Bill. Amt', 'Prev. Rec Amt', 'Recieved Amt', 'DiscAmt', 'Bal. Amt', 'ChqNo', 'ChqDate', 'Ret Amt', 'Bank Name'];
const line = (rec, party, bill, amt, prev, recv, bal, chq, bank) => [rec, party, bill, '10/11/2026', amt, prev, recv, 0, bal, chq, chq ? '13/11/2026' : '', 0, bank];
function dscr(type, groups) {
  const rows = [['TEST DISTRIBUTORS'], ['PUNE'], [], ['Daily Sales Collection Report'], ['Salesman : ALL'], ['For Date : 13/11/2026'], [`Collection Type : ${type}`], [], cHead];
  const t = [0, 0, 0, 0, 0];
  for (const [salesman, lines] of groups) {
    rows.push([`Salesman Name : ${salesman}`]);
    for (const l of lines) { rows.push(l); t[0] += l[4]; t[1] += l[5]; t[2] += l[6]; t[4] += l[8]; }
  }
  rows.push(['TOTALS :', '', '', '', t[0], t[1], t[2], 0, t[4], '', '', 0, '']);
  return xlsx(rows);
}
const cheques = dscr('CHEQUE', [
  ['RAVI [11]', [line('7001', 'SHOP ONE [P1]', '5002', 2000, 0, 1500, 500, '123456', 'STATE BANK OF INDIA'),
    line('7002', '', 'A 601', 3000, 1000, 2000, 0, 'RTGS', 'ONLINE PAYMENT'),             // empty party = same shop as above
    // the cheque taken at delivery for A601 is entered here too (as in the real files): it must be counted once
    line('7005', '', 'A 601', 3000, 0, 1000, 2000, '111222', 'STATE BANK OF INDIA')]],
  ['.COLLECTION [D1]', [line('7003', 'SHOP NINE [P9]', '9999', 800, 0, 800, 0, '654321', 'HDFC BANK LTD')]],     // 9999 was never delivered
]);
const cash = dscr('CASH', [['RAVI [11]', [line('7004', 'SHOP THREE [P3]', '5003', 500, 0, 200, 300, '', '')]]]);
// an "ALL" file for the same day repeats two lines that are already uploaded
const all = dscr('ALL', [['RAVI [11]', [line('7001', 'SHOP ONE [P1]', '5002', 2000, 0, 1500, 500, '123456', 'STATE BANK OF INDIA'), line('7004', 'SHOP THREE [P3]', '5003', 500, 0, 200, 300, '', '')]]]);
const outstanding = xlsx([['TEST DISTRIBUTORS'], ['PUNE'], [], ['OutStanding Debtors Statement 2 Report'], ['OutStanding As On Date:14/11/2026'], [],
  ['Date', 'Bill No.', 'Party Name', 'Bill Amount', 'Receipt', 'Balance', 'Wk', 'Party Code', 'Salesman Name'],
  ['10/11/2026', '/5004', 'SHOP FOUR', 700, 0, 700, 1, 'P4', 'MOHAN'], ['10/11/2026', '/5002', 'SHOP ONE', 2000, 1500, 500, 1, 'P1', 'RAVI']]);

console.log('Reading the Daily Sales Collection Report');
await upload('Delivery Report Collection-8001.xlsx', delivery);
const c1 = await upload('Daily Sales Collection Report 13.xlsx', cheques);
ok(c1.p.report_type === 'collection' && c1.p.period.from === '2026-11-13', 'recognised by its title; the date is "For Date" at the top');
ok(c1.p.check.issues.length === 0 && c1.p.check.reconciliation.every(r => r.status === 'match'), 'the "Salesman Name" headings and TOTALS are not counted as payments; totals match the file');
ok(c1.p.check.stats.rows === 4 && c1.p.check.stats.cheque === '3300.00' && c1.p.check.stats.online === '2000.00' && c1.p.check.stats.cash === '0.00', 'four payments: three cheques (₹3,300) and one RTGS (₹2,000)');
ok(c1.c.upload?.rows === 4, 'saved');
const c2 = await upload('Daily Sales Collection Report 13 cash.xlsx', cash);
ok(c2.p.check.stats.cash === '200.00' && !c2.c.replaced?.length, 'an empty cheque number is cash; the cash file for the same day is added, not replaced');

const R = '?from=2026-11-10&to=2026-11-13';
const coll = async s => get(`/reports/collections${R}&settle=${s}`);
console.log('Received, by salesman');
let a = await coll('all');
const person = n => a.people.find(p => p.name === n) || {};
ok(Number(a.totals.total) === 6500, 'total ₹6,500 = ₹5,500 from the collection report + ₹1,000 cash at delivery');
ok(Number(person('At delivery').cash) === 1000 && Number(person('At delivery').cheque) === 0, '"At delivery" is cash only (₹1,000): the ₹1,000 cheque taken at delivery is not counted from the delivery report');
ok(Number(person('RAVI').cash) === 200 && Number(person('RAVI').cheque) === 2500 && Number(person('RAVI').online) === 2000, 'RAVI: ₹200 cash, ₹2,500 cheque (incl. the delivery cheque, counted once), ₹2,000 RTGS');
ok(Number(person('Office collection').cheque) === 800, '".COLLECTION" is shown as "Office collection"');
const rv = await get(`/reports/collections/receipts${R}&by=person&key=RAVI`);
ok(rv.receipts.some(x => x.bill_no === 'A 601' && x.party_name === 'SHOP ONE' && x.mode === 'Online'), 'the row with an empty party takes the party of the row above');
const s = await coll('settled'), u = await coll('unsettled');
ok(Number(s.totals.total) === 5700 && Number(u.totals.total) === 800, 'settled bills ₹5,700, unsettled ₹800 (bill 9999 was never delivered)');
ok(!u.people.some(p => p.name === 'At delivery') && u.left === null, 'unsettled has no delivery money and nothing "left to collect"');

console.log('Left to collect on settled bills');
ok(a.left.bills === 3 && Number(a.left.total) === 1500, '3 bills, ₹1,500: 5002 (₹500), 5003 (₹300), 5004 (₹700); 5001 and A601 are fully paid');
let L = await get(`/reports/collections/left${R}`);
const bill = k => L.bills.find(b => b.bill_key === k) || {};
ok(Number(bill('5002').left_amt) === 500 && bill('5002').salesman === 'RAVI', '5002: ₹2,000 − ₹1,500 collected = ₹500, salesman RAVI');
ok(Number(bill('5003').left_amt) === 300, '5003: ₹500 − ₹200 cash = ₹300');
ok(!L.bills.some(b => b.bill_key === '5005'), '5005: the cheque taken at delivery counts as paid, though it is not yet in a collection report');
ok(!L.bills.some(b => b.bill_key === 'A601' || b.bill_key === '5001'),'A601 (₹1,000 cheque entered in the collection report + ₹2,000 RTGS) and 5001 (cash at delivery) are paid');
await upload('OutStanding Debtors Statement.xlsx', outstanding);
L = await get(`/reports/collections/left${R}`);
ok(bill('5004').salesman === 'MOHAN' && Number(bill('5004').statement_balance) === 700, 'a bill nobody has collected on yet takes its salesman from the latest Outstanding statement (MOHAN), with its balance there');
a = await coll('all');
ok(a.left.by_salesman.find(x => x.name === 'RAVI')?.bills === 2 && a.left.by_salesman.find(x => x.name === 'MOHAN')?.left === '700.00', 'by salesman: RAVI 2 bills, MOHAN ₹700');
const before = await get(`/reports/collections/left?from=2026-11-10&to=2026-11-10`);
ok(before.bills.length === 4, 'on the delivery day itself 5001 (cash) and 5005 (cheque) are paid: 4 bills left');

console.log('The same payment in two files counts once');
await upload('Daily Sales Collection Report 13 all.xlsx', all);
a = await coll('all');
ok(Number(a.totals.total) === 6500, 'an "ALL" file that repeats two lines changes nothing');
const again = await upload('Daily Sales Collection Report 13.xlsx', cheques);
ok(again.c.replaced?.length === 1 && Number((await coll('all')).totals.total) === 6500, 'the very same file again replaces its earlier copy');

console.log('Home and the old Receipt Book');
const home = await get(`/reports/overview${R}`);
ok(Number(home.receipts.total) === 6500 && Number(home.receipts.cash) === 1200, 'Home "Money received": ₹6,500, of which ₹1,200 cash');
makeFixtures(dir);
const old = await upload('receipts.xlsx', fs.readFileSync(`${dir}/receipts.xlsx`));
ok(/no longer used/.test(old.p.error || ''), 'a Receipt Book is refused with a clear message');
ok(!(await get('/uploads/meta')).types.some(t => t.key === 'receipt'), 'and it is no longer in the list of file types');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
