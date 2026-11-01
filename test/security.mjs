// Security checks against a PRODUCTION-mode server (real rate limits, no demo codes).
//   NODE_ENV=production JWT_SECRET=<32+ random chars> node src/index.js > server.log
//   node test/security.mjs <fixtures folder> <server.log>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [dir, logFile] = process.argv.slice(2);
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, path, body, tk, extra = {}) {
  const o = { method, headers: { ...(tk ? { Authorization: 'Bearer ' + tk } : {}), ...extra } };
  if (body instanceof FormData) o.body = body; else if (body !== undefined && body !== null) { o.headers['Content-Type'] = 'application/json'; o.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(B + path, o);
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, text, ...j };
}
const PW = 'Correct-horse-9';
const codeFor = async (email, purpose) => {   // what an operator would read from the server log when email is not set up
  for (let i = 0; i < 20; i++) {
    const m = [...fs.readFileSync(logFile, 'utf8').matchAll(new RegExp(`${purpose} code for ${email.replace(/[.]/g, '\\.')}: (\\d{6})`, 'g'))].pop();
    if (m) return m[1];
    await sleep(150);
  }
  return null;
};
async function signup(email, business) {
  const r = await call('POST', '/auth/register', { name: business.split(' ')[0], email, password: PW, business_name: business, state_code: '27' });
  const v = await call('POST', '/auth/verify', { email, code: await codeFor(email, 'register') });
  return { reg: r, ...v };
}

console.log('Start-up checks');
const weak = spawnSync('node', ['src/index.js'], { env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'short-secret', DATABASE_URL: 'pglite:./data/sec-boot', PORT: '4199' }, timeout: 20000, encoding: 'utf8' });
ok(weak.status !== 0 && /JWT_SECRET/.test(weak.stderr), 'production refuses to start with a weak JWT secret');

console.log('Codes are never shown on screen');
const h = await call('GET', '/health');
ok(h.otp_demo === false, 'health says demo codes are off');
const A = await signup('owner@a.test', 'Alpha Distributors');
ok(A.reg.demo_code === undefined && !/demo_code|\b\d{6}\b/.test(A.reg.text), 'the sign-up response contains no code');
ok(A.token && A.user, 'sign-up works with the code taken from the server log');
ok((await call('POST', '/auth/forgot', { email: 'owner@a.test' })).demo_code === undefined, 'password-reset response contains no code either');
const wrong = [];
for (let i = 0; i < 6; i++) wrong.push((await call('POST', '/auth/reset', { email: 'owner@a.test', code: '000000', password: 'Whatever-pass-11' })).status);
ok(wrong.slice(0, 5).every(s => s === 400) && wrong[5] === 400, `wrong reset codes are refused (${wrong.join(',')}), a code is dead after 5 tries`);
const real = await codeFor('owner@a.test', 'reset');
ok((await call('POST', '/auth/reset', { email: 'owner@a.test', code: real, password: 'Whatever-pass-11' })).status === 400, 'even the right code no longer works after too many wrong tries');
await call('POST', '/auth/forgot', { email: 'owner@a.test' });
ok((await call('POST', '/auth/reset', { email: 'owner@a.test', code: await codeFor('owner@a.test', 'reset'), password: PW })).ok, 'a fresh code works');
const aLogin = await call('POST', '/auth/login', { email: 'owner@a.test', password: PW });
ok(aLogin.token, 'and the owner logs in with the new password');
let tkA = aLogin.token;

console.log('Passwords');
for (const [pw, what] of [['short1', 'too short'], ['passwordpassword', 'a well-known password'], ['aaaaaaaaaaaa', 'one letter repeated']]) {
  ok((await call('POST', '/auth/register', { name: 'X', email: `x${Math.random().toString(36).slice(2)}@a.test`, password: pw, business_name: 'X', state_code: '27' })).status === 400, `${what} is refused`);
}
ok(!/password_hash|\$2[aby]\$/.test((await call('GET', '/auth/me', null, tkA)).text + (await call('GET', '/users', null, tkA)).text), 'no password hash ever leaves the server');

console.log('Tokens');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const uid = JSON.parse(Buffer.from(tkA.split('.')[1], 'base64url')).sub;
const sid = JSON.parse(Buffer.from(tkA.split('.')[1], 'base64url')).sid;
const exp = Math.floor(Date.now() / 1000) + 3600;
const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: uid, sid, exp })}.`;
const bad = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uid, sid, exp })}.${crypto.createHmac('sha256', 'guess').update('x').digest('base64url')}`;
const tampered = tkA.split('.').slice(0, 2).join('.') + '.' + 'A'.repeat(43);
for (const [t, what] of [[none, 'an unsigned ("alg none") token'], [bad, 'a token signed with the wrong secret'], [tampered, 'a token with a damaged signature'], ['garbage', 'garbage']]) {
  ok((await call('GET', '/auth/me', null, t)).status === 401, `${what} is refused`);
}
ok((await call('GET', '/auth/me', null, tkA)).status === 200, 'the real token still works');

console.log('One business can never see another');
const Bz = await signup('owner@b.test', 'Beta Traders');
const tkB = Bz.token;
const fd = new FormData(); fd.append('files', new Blob([fs.readFileSync(`${dir}/purchase.xlsx`)]), 'purchase.xlsx');
const p = (await call('POST', '/uploads/preview', fd, tkA)).files[0];
const c = await call('POST', '/uploads/commit', { token: p.token, report_type: p.report_type, header_row: p.header_row, mapping: p.mapping, date_format: p.date_format }, tkA);
ok(c.upload?.id, "Alpha's upload saved");
const up = c.upload.id;
for (const [m, path, what] of [['GET', `/uploads/${up}`, 'details'], ['GET', `/uploads/${up}/download`, 'the original file'], ['POST', `/uploads/${up}/undo`, 'undo'], ['DELETE', `/uploads/${up}`, 'delete']]) {
  const r = await call(m, path, m === 'POST' ? {} : null, tkB);
  ok(r.status === 404, `Beta cannot reach Alpha's upload: ${what} -> ${r.status}`);
}
const lst = await call('GET', '/uploads', null, tkB);
ok(lst.uploads.length === 0, "Beta's upload list does not show Alpha's file");
const rep = await call('GET', '/reports/purchases?from=2026-09-01&to=2026-10-31', null, tkB);
ok(Number(rep.totals?.lines || 0) === 0, "Beta's reports contain none of Alpha's data");
ok((await call('GET', '/reports/stock', null, tkB)).items?.length === 0, "Beta's stock page contains none of Alpha's items");
const aUsers = (await call('GET', '/users', null, tkA)).users;
ok((await call('PATCH', `/users/${aUsers[0].id}`, { role: 'viewer' }, tkB)).status === 404, "Beta cannot change Alpha's users");
ok((await call('POST', `/users/${aUsers[0].id}/signout`, {}, tkB)).status === 404, "Beta cannot sign Alpha's users out");
const fd2 = new FormData(); fd2.append('files', new Blob([fs.readFileSync(`${dir}/sales.xlsx`)]), 'sales.xlsx');
const p2 = (await call('POST', '/uploads/preview', fd2, tkA)).files[0];
ok((await call('POST', '/uploads/commit', { token: p2.token, report_type: p2.report_type, header_row: p2.header_row, mapping: p2.mapping, date_format: p2.date_format }, tkB)).status === 410, "Beta cannot save Alpha's pending file");
ok((await call('GET', '/activity', null, tkB)).entries.every(e => !/Alpha/.test(e.message)), "Beta's activity log has nothing of Alpha's");
ok((await call('GET', '/platform/orgs', null, tkA)).status === 403, 'a business owner cannot open the platform admin');

console.log('Odd input');
ok((await call('GET', "/reports/sales?from=2026-10-01'%20or%20'1'='1&to=2026-10-31", null, tkA)).status === 400, 'a quote in a date is refused, not run');
const inj = await call('GET', "/activity?kind=' or '1'='1", null, tkA);
ok(inj.status === 200 && inj.entries?.length === 0, "an injection attempt in a filter just matches nothing");
for (const path of [`/uploads/' or 1=1 --`, '/uploads/not-a-uuid/download', '/templates/xyz']) {
  const r = await call('GET', path, null, tkA);
  ok(r.status === 404 || r.status === 400, `${path} -> ${r.status} (not a server error)`);
}
ok((await call('POST', '/uploads/preview/../../etc/passwd', {}, tkA)).status !== 500, 'a path-style token is not followed');
ok((await call('POST', '/auth/login', '{"email": {"$gt": ""}, "password": "x"}', null, { 'Content-Type': 'application/json' })).status === 401, 'an object where an email belongs is just a wrong login');
ok((await call('POST', '/auth/login', JSON.stringify({ email: 'a@a.test', password: 'x'.repeat(2 * 1024 * 1024) }))).status === 413, 'a 2 MB request body is refused');
const junk = new FormData(); junk.append('files', new Blob([crypto.randomBytes(5000)]), 'broken.xlsx');
let r = await call('POST', '/uploads/preview', junk, tkA);
const f0 = r.files?.[0];
ok(r.status === 200 && f0 && (f0.error || !f0.report_type) && !/\.js:\d+/.test(r.text),
  `a corrupt file is answered plainly (${f0?.error ? 'error: ' + f0.error.slice(0, 60) : 'shown as an unknown file type, nothing saved'})`);
const exe = new FormData(); exe.append('files', new Blob(['MZ']), 'virus.exe');
ok((await call('POST', '/uploads/preview', exe, tkA)).files[0].error, 'a non-Excel file name is refused');
ok((await call('GET', '/health')).status === 200, 'the server is still healthy after all of that');

console.log('Headers');
const hd = (await call('GET', '/health')).headers;
ok(!hd.get('x-powered-by'), 'the server does not announce its software');
ok(/default-src 'none'/.test(hd.get('content-security-policy') || '') && /frame-ancestors 'none'/.test(hd.get('content-security-policy') || ''), 'API responses carry a strict content policy');
ok(hd.get('x-content-type-options') === 'nosniff' && /no-store/.test(hd.get('cache-control') || ''), 'no content sniffing, no caching of data');
ok(/max-age=/.test(hd.get('strict-transport-security') || ''), 'HTTPS is enforced (HSTS)');
ok(!/stack|node_modules|\.js:\d+/.test((await call('GET', '/reports/nothing', null, tkA)).text), 'errors do not leak code paths');

console.log('Logout really logs out');
ok((await call('POST', '/auth/logout', {}, tkA)).ok, 'logout');
ok((await call('GET', '/auth/me', null, tkA)).status === 401, 'the same token no longer works');

console.log('Guessing passwords');
const statuses = [];
for (let i = 0; i < 12; i++) statuses.push((await call('POST', '/auth/login', { email: 'owner@b.test', password: 'wrong-guess-' + i })).status);
ok(statuses.slice(0, 10).every(s => s === 401) && statuses[10] === 429, `10 wrong tries, then locked: ${statuses.join(',')}`);
ok((await call('POST', '/auth/login', { email: 'owner@b.test', password: PW })).status === 429, 'even the right password is refused during the lock');
let hit = 0;
for (let i = 0; i < 30 && !hit; i++) { const r = await call('POST', '/auth/login', { email: `nobody${i}@x.test`, password: 'x' }); if (r.status === 429 && /Too many login attempts/.test(r.error)) hit = i + 1; }
ok(hit > 0, `a flood of logins from one address is stopped (after about ${hit + 12} tries)`);
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
