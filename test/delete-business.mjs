// Platform admin deletes a business with all its data.
//   RATE_LIMIT_DISABLED=1 PLATFORM_ADMIN_EMAILS=admin@test.in LOCAL_FILES_DIR=<dir> node src/index.js
//   node test/delete-business.mjs <fixtures folder> <LOCAL_FILES_DIR of the server>
// Prints the deleted business's id at the end, so the database itself can be checked for leftovers.
import fs from 'node:fs';
import path from 'node:path';
import { makeFixtures } from './fixtures.mjs';

const [dir, filesDir] = process.argv.slice(2);
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const json = { 'Content-Type': 'application/json' };
const PW = 'Correct-horse-9';
const call = async (method, p, body, H = {}) => {
  const r = await fetch(B + p, { method, headers: { ...H, ...(body ? json : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
async function signup(email, business) {
  const r = await call('POST', '/auth/register', { name: business.split(' ')[0], email, password: PW, business_name: business, state_code: '27' });
  const v = await call('POST', '/auth/verify', { email, code: r.demo_code });
  return { Authorization: 'Bearer ' + v.token };
}
async function upload(H, file) {
  const fd = new FormData(); fd.append('files', new Blob([fs.readFileSync(path.join(dir, file))]), file);
  const p = (await (await fetch(B + '/uploads/preview', { method: 'POST', headers: H, body: fd })).json()).files[0];
  return call('POST', '/uploads/commit', { token: p.token, report_type: p.report_type, header_row: p.header_row, mapping: p.mapping, date_format: p.date_format }, H);
}
const filesOf = d => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter(f => f.endsWith('.gz')) : []);

makeFixtures(dir);
const admin = await signup('admin@test.in', 'Reportly HQ');
const alpha = await signup('owner@alpha.test', 'Alpha Traders');
const beta = await signup('owner@beta.test', 'Beta Stores');

console.log('A business with something in every table');
for (const f of ['sales.xlsx', 'purchase.xlsx', 'credit_note.xlsx', 'outstanding.xlsx', 'stock.xlsx']) ok((await upload(alpha, f)).upload, `Alpha uploads ${f}`);
await upload(beta, 'sales.xlsx');
await call('POST', '/users/invite', { email: 'clerk@alpha.test', role: 'viewer' }, alpha);
await call('POST', '/users/invite', { email: 'owner@beta.test', role: 'viewer' }, alpha);             // Beta's owner also works in Alpha
await call('POST', '/requests', { kind: 'support', message: 'Please call me back' }, alpha);
const orgs = (await call('GET', '/platform/orgs', null, admin)).orgs;
const A = orgs.find(o => o.name === 'Alpha Traders'), Bo = orgs.find(o => o.name === 'Beta Stores'), me = orgs.find(o => o.name === 'Reportly HQ');
await call('POST', `/platform/orgs/${A.id}/payments`, { kind: 'setup', amount: '5000' }, admin);
await call('POST', `/platform/orgs/${A.id}/new-company`, { name: 'Alpha Foods', state_code: '27', login: 'same' }, admin);   // an extra company
const alphaFiles = (await call('GET', '/uploads', null, alpha)).uploads;
const before = filesOf(filesDir);
ok(alphaFiles.length === 5 && before.length >= 6, `stored original files: ${before.length} (5 of them Alpha's)`);
const betaSales = (await call('GET', '/reports/sales?from=2026-09-01&to=2026-10-31', null, beta)).totals;

console.log('Who may delete, and the confirmation');
ok((await call('DELETE', `/platform/orgs/${A.id}`, { confirm: 'Alpha Traders' }, beta)).status === 403, 'a business owner cannot delete a business');
ok((await call('DELETE', `/platform/orgs/${A.id}`, { confirm: 'alpha' }, admin)).status === 400, 'a wrong name is refused');
ok((await call('DELETE', `/platform/orgs/${A.id}`, null, admin)).status === 400, 'no name is refused');
ok((await call('DELETE', `/platform/orgs/${me.id}`, { confirm: 'Reportly HQ' }, admin)).status === 400, 'the admin cannot delete their own business');
ok((await call('DELETE', '/platform/orgs/00000000-0000-0000-0000-000000000000', { confirm: 'x' }, admin)).status === 404, 'an unknown business is not found');
ok((await call('GET', '/auth/me', null, alpha)).user, 'nothing happened yet: Alpha still works');

console.log('Deleting');
const del = await call('DELETE', `/platform/orgs/${A.id}`, { confirm: 'Alpha Traders' }, admin);
ok(del.ok && del.deleted.uploads === 5 && del.deleted.files === 5 && del.deleted.users === 2, `deleted: ${del.deleted?.users} people, ${del.deleted?.uploads} uploads, ${del.deleted?.files} files`);
ok(del.unlinked?.[0] === 'Alpha Foods', 'its extra company is unlinked, not deleted');
const list = (await call('GET', '/platform/orgs', null, admin)).orgs;
ok(!list.some(o => o.id === A.id) && list.some(o => o.name === 'Alpha Foods' && !o.parent_org_id), 'gone from the business list; Alpha Foods stays as a business of its own');
ok((await call('GET', '/auth/me', null, alpha)).status === 401, 'Alpha\'s owner is signed out at once');
const again = await call('POST', '/auth/login', { email: 'owner@alpha.test', password: PW });
ok(again.user?.org_name === 'Alpha Foods' && again.user.businesses.length === 1, '...and can now log in only to the extra company that was kept (Alpha Foods)');
const after = filesOf(filesDir);
ok(before.length - after.length === 5 && !after.some(f => f.includes(A.id)), 'Alpha\'s 5 original files are removed from storage');
ok((await call('GET', `/platform/orgs/${A.id}`, null, admin)).status === 404 || !(await call('GET', `/platform/orgs/${A.id}`, null, admin)).users?.length, 'its detail page has nothing left');
const pays = (await call('GET', '/platform/payments', null, admin)).payments;
ok(!pays.some(p => p.org_id === A.id), 'its payments are gone');
const reqs = (await call('GET', '/platform/requests', null, admin)).requests;
ok(!reqs.some(r => r.org_id === A.id), 'its requests are gone');
const feed = (await call('GET', '/platform/activity', null, admin)).entries;
ok(!feed.some(e => e.org_id === A.id) && feed.some(e => /Deleted the business "Alpha Traders"/.test(e.message)), 'its activity log is gone; the admin\'s own log records the deletion');

console.log('Everyone else is untouched');
const bs = (await call('GET', '/reports/sales?from=2026-09-01&to=2026-10-31', null, beta)).totals;
ok(JSON.stringify(bs) === JSON.stringify(betaSales), 'Beta\'s reports are exactly as before');
const bl = await call('POST', '/auth/login', { email: 'owner@beta.test', password: PW });
ok(bl.status === 409 || bl.token, 'Beta\'s owner (who also worked in Alpha) keeps their own login');
const bme = await call('GET', '/auth/me', null, beta);
ok(bme.user?.businesses?.length === 1 && bme.user.businesses[0].name === 'Beta Stores', '...and their business list no longer shows Alpha');
ok((await call('GET', '/uploads', null, beta)).uploads.length === 1, 'Beta\'s upload and file are still there');

console.log('Deleting a customer together with its extra companies');
const gamma = await signup('owner@gamma.test', 'Gamma Agencies');
await upload(gamma, 'sales.xlsx');
const G = (await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.name === 'Gamma Agencies');
await call('POST', `/platform/orgs/${G.id}/new-company`, { name: 'Gamma Retail', state_code: '27', login: 'same' }, admin);
const gs = await call('POST', '/auth/switch', { user_id: (await call('GET', '/auth/me', null, gamma)).user.businesses.find(b => b.name === 'Gamma Retail').user_id }, gamma);
await upload({ Authorization: 'Bearer ' + gs.token }, 'purchase.xlsx');
const filesBefore = filesOf(filesDir).length;
const delG = await call('DELETE', `/platform/orgs/${G.id}`, { confirm: 'Gamma Agencies', with_companies: true }, admin);
ok(delG.ok && delG.deleted.businesses === 2 && delG.companies_deleted[0] === 'Gamma Retail' && delG.deleted.files === 2, 'both businesses deleted, with both uploaded files');
ok(filesBefore - filesOf(filesDir).length === 2, 'both original files are removed from storage');
const names = (await call('GET', '/platform/orgs', null, admin)).orgs.map(o => o.name);
ok(!names.includes('Gamma Agencies') && !names.includes('Gamma Retail'), 'neither is in the business list');
ok((await call('POST', '/auth/login', { email: 'owner@gamma.test', password: PW })).status === 401, 'their owner cannot log in any more');

console.log(`\nDELETED_ORG ${A.id}`);
console.log(`DELETED_ORG ${G.id}`);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
