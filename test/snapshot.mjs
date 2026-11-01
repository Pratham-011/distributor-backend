// Uploads the fixed test files to a fresh account and saves everything the app shows about them, to compare
// before / after a change: every result must stay identical.
// node test/snapshot.mjs <folder with fixtures> <out.json>     (server running; API=http://localhost:4100/api)
import fs from 'node:fs';
const [dir, out] = process.argv.slice(2);
const B = process.env.API || 'http://localhost:4100/api';
const files = ['purchase.xlsx', 'sales.xlsx', 'sales_oct2.xls', 'sales_oct3.csv', 'credit_note.xlsx', 'debit_note.xlsx', 'receipts.xlsx', 'outstanding.xlsx', 'stock.xlsx'];
const json = { 'Content-Type': 'application/json' };
const email = `snap${Date.now()}@test.in`;
const reg = await (await fetch(B + '/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Snap', email, password: 'Correct-horse-9', business_name: 'Snap Co', state_code: '27' }) })).json();
const tk = (await (await fetch(B + '/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ email, code: reg.demo_code }) })).json()).token;
const H = { Authorization: 'Bearer ' + tk };
const result = { previews: {}, rechecks: {}, saves: {}, reports: {} };
// leave out what differs on every run (ids, tokens, times)
const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (['token', 'id', 'upload_id', 'created_at', 'template', 'existing', 'duplicate', 'size', 'size_bytes', 'stored_bytes'].includes(k) ? undefined : v)));
for (const f of files) {
  const fd = new FormData(); fd.append('files', new Blob([fs.readFileSync(`${dir}/${f}`)]), f);
  const p = (await (await fetch(B + '/uploads/preview', { method: 'POST', headers: H, body: fd })).json()).files[0];
  result.previews[f] = clean(p);
  const body = JSON.stringify({ header_row: p.header_row, report_type: p.report_type, mapping: p.mapping, date_format: p.date_format });
  result.rechecks[f] = clean(await (await fetch(B + '/uploads/preview/' + p.token, { method: 'POST', headers: { ...H, ...json }, body })).json());
  result.saves[f] = clean(await (await fetch(B + '/uploads/commit', { method: 'POST', headers: { ...H, ...json },
    body: JSON.stringify({ token: p.token, report_type: p.report_type, header_row: p.header_row, mapping: p.mapping, date_format: p.date_format }) })).json());
}
const R = '?from=2026-09-01&to=2026-10-31';
for (const [name, path] of [['overview', '/reports/overview' + R], ['sales', '/reports/sales' + R], ['gst', '/reports/gst' + R], ['returns', '/reports/returns' + R],
  ['purchases', '/reports/purchases' + R], ['collections', '/reports/collections' + R], ['receipts', '/reports/collections/receipts' + R], ['outstanding', '/reports/outstanding'],
  ['stock', '/reports/stock?as_on=2026-10-03'], ['stock_30sep', '/reports/stock?as_on=2026-09-30'], ['movement', '/reports/stock/movement' + R]]) {
  result.reports[name] = clean(await (await fetch(B + path, { headers: H })).json());
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(Object.entries(result.saves).map(([f, s]) => `${f}: ${s.upload?.rows ?? 'NOT SAVED ' + s.error + ' ' + JSON.stringify(result.previews[f].check?.issues?.filter(i => i.level === 'error').map(i => i.message))}`).join('\n'));
