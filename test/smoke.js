// End-to-end API test. Start the server first, then:  SAMPLES=/path/to/files node test/smoke.js
import fs from 'node:fs';
import path from 'node:path';
const BASE = process.env.API || 'http://localhost:4000/api';
const DIR = process.env.SAMPLES || new URL('../samples', import.meta.url).pathname;
let token = null;
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✕ ') + msg); if (!cond) fails++; };

async function api(method, url, body, tk = token) {
  const opts = { method, headers: {} };
  if (tk) opts.headers.Authorization = 'Bearer ' + tk;
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(BASE + url, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

const email = `owner${Date.now()}@test.in`;
console.log('Auth');
ok((await api('POST', '/auth/register', { name: 'Ravi', email, password: 'secret123', business_name: 'Akash Marketing' })).status === 400, 'new business must choose a GST state');
let r = await api('POST', '/auth/register', { name: 'Ravi', email, password: 'secret123', business_name: 'Akash Marketing', state_code: '27' });
ok(r.demo_code?.length === 6, 'register returns demo OTP');
ok((await api('POST', '/auth/verify', { email, code: '000000' })).status === 400, 'wrong OTP rejected');
r = await api('POST', '/auth/verify', { email, code: r.demo_code });
ok(r.token && r.user.role === 'owner', 'OTP verified, owner account created');
ok(r.user.state_code === '27', 'GST state saved with the business');
token = r.token;
ok((await api('POST', '/auth/login', { email, password: 'wrong-pass' })).status === 401, 'wrong password rejected');
ok((await api('POST', '/auth/login', { email, password: 'secret123' })).token, 'login works');

async function previewAll() {
  const fd = new FormData();
  for (const f of fs.readdirSync(DIR)) fd.append('files', new Blob([fs.readFileSync(path.join(DIR, f))]), f);
  return api('POST', '/uploads/preview', fd);
}

console.log('First upload (new formats)');
r = await previewAll();
ok(r.files.length === 6 && r.files.every(f => !f.error), 'all 6 files read');
ok(r.files.every(f => f.needs_mapping && !f.template), 'first time: column matching needed');
ok(r.files.every(f => !f.check.errors), 'suggested columns pass every check');
const types = r.files.map(f => f.report_type).sort().join(',');
ok(types === 'credit_note,debit_note,outstanding,purchase,receipt,sales', 'types detected: ' + types);
for (const f of r.files) {
  const c = await api('POST', '/uploads/commit', { token: f.token, report_type: f.report_type, header_row: f.header_row, mapping: f.mapping, date_format: f.date_format, save_template: true });
  ok(c.upload?.rows > 0, `saved ${f.report_type}: ${c.upload?.rows} rows, ${c.upload?.size_bytes}→${c.upload?.stored_bytes} bytes compressed`);
}

console.log('Second upload (saved formats are used, earlier data replaced)');
r = await previewAll();
ok(r.files.every(f => f.template && !f.needs_mapping), 'saved formats recognised, no matching needed');
ok(r.files.every(f => f.duplicate), 'same file flagged as already uploaded');
const s = r.files.find(f => f.report_type === 'sales');
const c2 = await api('POST', '/uploads/commit', { token: s.token, report_type: 'sales', header_row: s.header_row, mapping: s.mapping, date_format: s.date_format });
ok(c2.replaced?.length === 1, 'sales for 1 Oct replaced the earlier upload');

console.log('Bad mapping is blocked');
r = await previewAll();
const bad = r.files.find(f => f.report_type === 'sales');
const wrong = { ...bad.mapping, taxable: 'Amount' };   // wrong column on purpose
const b = await api('POST', '/uploads/commit', { token: bad.token, report_type: 'sales', header_row: bad.header_row, mapping: wrong });
ok(b.status === 422 && b.issues.some(i => /TOTALS|Taxable/.test(i.message)), 'wrong column caught: ' + b.issues?.[0]?.message.slice(0, 80));

console.log('Reports (expected values verified independently from the raw files)');
const D = '?from=2026-10-01&to=2026-10-01';
const ov = await api('GET', '/reports/overview' + D);
ok(ov.sales.taxable === '680128.00', 'sales taxable 680128.00 = ' + ov.sales.taxable);
ok(ov.sales.tax === '34011.42', 'sales GST 34011.42 = ' + ov.sales.tax);
ok(ov.sales.value === '714253.81', 'invoice value 714253.81 = ' + ov.sales.value);
ok(ov.sales.docs === 613, 'invoices 613 = ' + ov.sales.docs);
ok(ov.net_sales === '673621.28', 'net sales 673621.28 = ' + ov.net_sales);
ok(ov.outstanding.total === '18490114.38', 'outstanding 18490114.38 = ' + ov.outstanding.total);
ok(ov.outstanding.over_8 === '652942.71', 'over 8 weeks 652942.71 = ' + ov.outstanding.over_8);
const pu = await api('GET', '/reports/purchases?from=2026-10-03&to=2026-10-03');
ok(pu.totals.value === '3978127.88', 'purchase value 3978127.88 = ' + pu.totals.value);
const co = await api('GET', '/reports/collections?from=2026-09-01&to=2026-09-01');
ok(co.totals.total === '580721.98', 'collections 580721.98 = ' + co.totals.total);
ok(co.modes.find(m => m.name === 'Cash').amount === '454021.98', 'cash 454021.98');
const rt = await api('GET', '/reports/returns?from=2026-10-01&to=2026-10-09');
ok(rt.debit_note.value === '334214.64', 'debit note value 334214.64 = ' + rt.debit_note.value);
ok(rt.credit_note.value === '6831.81', 'credit note value 6831.81 = ' + rt.credit_note.value);
const g = await api('GET', '/reports/gst?from=2026-10-01&to=2026-10-09');
ok(g.position === '-139833.58', 'GST position -139833.58 = ' + g.position);
ok(g.no_gstin.invoices === 347, 'B2B without GSTIN 347 = ' + g.no_gstin.invoices);
const os = await api('GET', '/reports/outstanding');
const sumSalesmen = os.salesmen.reduce((a, x) => a + Math.round(Number(x.total) * 100), 0) / 100;
ok(sumSalesmen.toFixed(2) === '18490114.38', 'salesman totals add up');
const sr = await api('GET', '/reports/outstanding/search?q=M.R TRADERS');
ok(sr.bills.length > 0, 'party search finds M.R Traders bills: ' + sr.bills.length);
const sales = await api('GET', '/reports/sales' + D);
ok(sales.brands.reduce((a, b) => a + Math.round(Number(b.taxable) * 100), 0) === 68012800, 'brand totals add up to sales');

console.log('Roles');
const vEmail = `viewer${Date.now()}@test.in`;
ok((await api('POST', '/users/invite', { email: vEmail, role: 'viewer' })).ok, 'owner invites a viewer');
let v = await api('POST', '/auth/register', { name: 'Shyam', email: vEmail, password: 'viewer123' });
ok(v.joining === 'Akash Marketing', 'invited person joins the same business');
v = await api('POST', '/auth/verify', { email: vEmail, code: v.demo_code });
ok(v.user.role === 'viewer', 'viewer account created');
ok((await api('GET', '/reports/overview' + D, null, v.token)).sales?.taxable === '680128.00', 'viewer can see reports');
const fd = new FormData(); fd.append('files', new Blob(['x']), 'a.xlsx');
ok((await api('POST', '/uploads/preview', fd, v.token)).status === 403, 'viewer cannot upload');
ok((await api('GET', '/users', null, v.token)).status === 403, 'viewer cannot manage users');
const up = await api('GET', '/uploads');
ok(up.uploads.some(u => u.status === 'replaced'), 'history shows replaced upload');
const dl = await fetch(BASE + '/uploads/' + up.uploads[0].id + '/download', { headers: { Authorization: 'Bearer ' + token } });
ok(dl.status === 200 && (await dl.arrayBuffer()).byteLength === up.uploads[0].size_bytes, 'original file downloads unchanged after compression');

console.log('Undo');
const salesUps = up.uploads.filter(u => u.report_type === 'sales');   // newest first
ok((await api('POST', `/uploads/${salesUps[0].id}/undo`, null, v.token)).status === 403, 'viewer cannot undo');
let u1 = await api('POST', `/uploads/${salesUps[0].id}/undo`);
ok(u1.ok && u1.restored.length === 1, 'undoing the second sales upload brings back the first');
let ov2 = await api('GET', '/reports/overview' + D);
ok(ov2.sales.taxable === '680128.00' && ov2.sales.docs === 613, 'sales for 1 Oct unchanged after undo: ' + ov2.sales.taxable);
let up2 = (await api('GET', '/uploads')).uploads;
ok(up2.find(u => u.id === salesUps[0].id).status === 'undone', 'undone upload marked as undone');
ok(up2.find(u => u.id === salesUps[1].id).status === 'active' && up2.find(u => u.id === salesUps[1].id).row_count > 0, 'earlier upload is active again');
ok((await api('POST', `/uploads/${salesUps[0].id}/undo`)).status === 409, 'cannot undo twice');
u1 = await api('POST', `/uploads/${salesUps[1].id}/undo`);
ok(u1.ok && u1.restored.length === 0, 'undoing the first sales upload too');
ov2 = await api('GET', '/reports/overview' + D);
ok(Number(ov2.sales.taxable || 0) === 0, 'no sales left for 1 Oct: ' + ov2.sales.taxable);

console.log('Delete');
ok((await api('DELETE', `/uploads/${salesUps[0].id}`, null, v.token)).status === 403, 'viewer cannot delete');
ok((await api('DELETE', `/uploads/${salesUps[0].id}`)).ok, 'an undone upload can be deleted');
const cn = up2.find(u => u.report_type === 'credit_note');
const delRes = await api('DELETE', `/uploads/${cn.id}`);
ok(delRes.ok && delRes.file_removed === true, 'an active upload can be deleted, and its file is removed from storage');
const up3 = (await api('GET', '/uploads')).uploads;
ok(!up3.some(u => u.id === cn.id || u.id === salesUps[0].id), 'deleted uploads leave the list');
const rt2 = await api('GET', '/reports/returns?from=2026-10-01&to=2026-10-09');
ok(Number(rt2.credit_note?.value || 0) === 0, 'deleted upload\'s data is out of the reports');
ok((await api('GET', `/uploads/${cn.id}/download`)).status === 404, 'deleted file cannot be downloaded');
ok((await api('DELETE', `/uploads/${cn.id}`)).status === 404, 'cannot delete twice');

console.log('Business details');
ok((await api('PATCH', '/org', { state_code: '99' })).status === 400, 'unknown state rejected');
ok((await api('PATCH', '/org', { state_code: '24' })).user?.state_code === '24', 'owner changes the GST state');
ok((await api('PATCH', '/org', { state_code: '27' }, v.token)).status === 403, 'viewer cannot change business details');

console.log('Activity log');
ok((await api('GET', '/activity', null, v.token)).status === 403, 'viewer cannot see the activity log');
const act = await api('GET', '/activity');
const actions = new Set(act.entries.map(e => e.action));
for (const a of ['account.created', 'account.joined', 'login.success', 'login.failed', 'upload.saved', 'upload.undone', 'upload.deleted', 'upload.downloaded', 'team.invited', 'business.updated']) {
  ok(actions.has(a), 'logged: ' + a);
}
ok(act.entries[0].action === 'business.updated' && act.entries[0].user_name === 'Ravi', 'newest first, with who did it');
const onlyUploads = await api('GET', '/activity?kind=upload');
ok(onlyUploads.entries.length > 0 && onlyUploads.entries.every(e => e.action.startsWith('upload.')), 'filter by type works');

console.log('Sessions');
const me = await api('GET', '/auth/me');
ok(me.user?.email === email && me.token, 'opening the app renews the session');
ok((await api('GET', '/auth/me', null, me.token)).user, 'renewed session works');
const fg = await api('POST', '/auth/forgot', { email });
ok((await api('POST', '/auth/reset', { email, code: fg.demo_code, password: 'newsecret123' })).ok, 'password reset');
ok((await api('GET', '/auth/me')).status === 401, 'old sessions end after a password change');
ok((await api('POST', '/auth/login', { email, password: 'newsecret123' })).token, 'log in with the new password');

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
