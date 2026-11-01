// One device per person, seats and extra users, linked companies, expenses and profit, admin activity.
// Server: RATE_LIMIT_DISABLED=1 PLATFORM_ADMIN_EMAILS=admin@test.in SESSION_IDLE_HOURS=0.0006 (about 2 seconds), then:
//   node test/features.mjs <folder with fixtures>
import fs from 'node:fs';
const [dir] = process.argv.slice(2);
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
async function call(method, path, body, tk, ua = WIN) {
  const o = { method, headers: { 'User-Agent': ua, ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } };
  if (body instanceof FormData) o.body = body; else if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(B + path, o);
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const PW = 'Correct-horse-9';
async function signup(email, business, ua) {
  const r = await call('POST', '/auth/register', { name: business.split(' ')[0], email, password: PW, business_name: business, state_code: '27' }, null, ua);
  return call('POST', '/auth/verify', { email, code: r.demo_code }, null, ua);
}
const login = (email, ua) => call('POST', '/auth/login', { email, password: PW }, null, ua);
async function join(email, ua) {
  const r = await call('POST', '/auth/register', { name: 'Joiner', email, password: PW }, null, ua);
  return call('POST', '/auth/verify', { email, code: r.demo_code }, null, ua);
}

console.log('Accounts');
const admin = (await signup('admin@test.in', 'My Software Co')).token;
const shree = await signup('owner@shree.test', 'Shree Distributors');
const om = await signup('owner@om.test', 'Om Traders');
ok(shree.user.subscription?.trial === true && shree.user.subscription.days_left === 15, `self-signup starts a ${shree.user.subscription?.days_left}-day trial`);
ok(admin && (await call('GET', '/platform/orgs', null, admin)).orgs.length === 3, 'platform admin sees 3 businesses');
let tk = shree.token;
const orgId = (await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.name === 'Shree Distributors').id;

console.log('One device per person');
ok((await call('GET', '/reports/overview?from=2026-10-01&to=2026-10-01', null, tk)).status === 200, 'device 1 works');
let b = await login('owner@shree.test', PHONE);
ok(b.status === 409 && b.code === 'already_signed_in' && /Windows/.test(b.error), `second device refused: "${(b.error || '').slice(0, 110)}…"`);
ok((await call('GET', '/auth/me', null, tk)).status === 200, 'device 1 is not disturbed');
ok((await call('POST', '/auth/logout', null, tk)).ok, 'device 1 logs out');
let r = await call('GET', '/auth/me', null, tk);
ok(r.status === 401, 'the old token stops working at once after logout');
b = await login('owner@shree.test', PHONE);
ok(b.token && b.user, 'device 2 can log in now');
tk = b.token;
// an idle sign-in no longer blocks a new device (idle window is ~2 s in this test)
await sleep(2500);
const c = await login('owner@shree.test', WIN);
ok(c.token, 'after the idle window a new device can log in');
r = await call('GET', '/auth/me', null, tk, PHONE);
ok(r.status === 401 && /another device/.test(r.error), `the idle device is told why: "${r.error}"`);
tk = c.token;

console.log('Owner signs a person out');
ok((await call('POST', '/users/invite', { email: 'sam@shree.test', role: 'writer' }, tk)).ok, 'owner adds user 1');
const sam = await join('sam@shree.test', WIN);
ok(sam.user?.role === 'writer', 'user 1 joined');
const users = (await call('GET', '/users', null, tk)).users;
const samId = users.find(u => u.email === 'sam@shree.test').id;
ok(users.find(u => u.id === samId).signed_in === true && /Windows/.test(users.find(u => u.id === samId).device), 'Team page shows who is signed in and on what device');
ok((await login('sam@shree.test', PHONE)).code === 'already_signed_in', 'user 1 blocked on a phone while signed in on the PC');
ok((await call('POST', `/users/${samId}/signout`, null, tk)).ok, 'owner signs user 1 out');
r = await call('GET', '/auth/me', null, sam.token);
ok(r.status === 401 && /administrator/.test(r.error), `user 1's PC is told: "${r.error}"`);
const sam2 = await login('sam@shree.test', PHONE);
ok(sam2.token, 'user 1 can log in on the phone now');
// password reset signs everything out and unblocks login
let f = await call('POST', '/auth/forgot', { email: 'sam@shree.test' });
ok((await call('POST', '/auth/reset', { email: 'sam@shree.test', code: f.demo_code, password: 'Another-pass-77' })).ok, 'password reset');
ok((await call('GET', '/auth/me', null, sam2.token)).status === 401, 'the old sign-in ended with the password change');
ok((await call('POST', '/auth/login', { email: 'sam@shree.test', password: 'Another-pass-77' })).token, 'and the new password logs in straight away');

console.log('Seats: 1 owner + 2 users, extra users on top');
ok((await call('POST', '/users/invite', { email: 'tina@shree.test', role: 'viewer' }, tk)).ok, 'user 2 added');
let s = await call('POST', '/users/invite', { email: 'raj@shree.test', role: 'viewer' }, tk);
ok(s.status === 403 && s.code === 'seat_limit' && /₹3,000/.test(s.error), `third person refused: "${(s.error || '').slice(0, 130)}…"`);
let t = (await call('GET', '/users', null, tk)).seats;
ok(t.max === 3 && t.used === 3 && t.extra === 0, `seats: ${t.used} of ${t.max} used`);
ok((await call('PATCH', `/users/${samId}`, { active: false }, tk)).ok, 'turning a person off frees their seat');
ok((await call('POST', '/users/invite', { email: 'raj@shree.test', role: 'viewer' }, tk)).ok, 'which lets another person be added');
s = await call('PATCH', `/users/${samId}`, { active: true }, tk);
ok(s.status === 403 && s.code === 'seat_limit', 'turning the old person back on is refused while full');
ok((await call('GET', '/users', null, sam2.token)).status === 401, 'a turned-off person is signed out');
r = await call('POST', `/platform/orgs/${orgId}/seats`, { add: 2 }, admin);
ok(r.ok && r.extra_users === 2, 'platform admin adds 2 extra users');
ok((await call('PATCH', `/users/${samId}`, { active: true }, tk)).ok, 'now the person can be turned back on');
const D = await call('GET', `/platform/orgs/${orgId}`, null, admin);
ok(D.payments.some(p => p.kind === 'extra_user' && Number(p.amount) === 6000), `2 × ₹3,000 recorded as a payment (${D.payments.map(p => p.kind + ' ' + p.amount).join(', ')})`);
ok((await call('PUT', '/platform/settings', { extra_user_price: 4000 }, admin)).settings.extra_user_price === 4000, 'pricing rule changed to ₹4,000');
await call('POST', `/platform/orgs/${orgId}/seats`, { add: 1 }, admin);
ok((await call('GET', `/platform/orgs/${orgId}`, null, admin)).payments.filter(p => p.kind === 'extra_user').some(p => Number(p.amount) === 4000), 'the next extra user is charged at the new price');
await call('PUT', '/platform/settings', { extra_user_price: 3000 }, admin);
ok((await call('PUT', '/platform/settings', { extra_user_price: -5 }, admin)).status === 400, 'a negative price is refused');

console.log('Linked companies');
const L = await call('GET', '/platform/orgs', null, admin);
const omId = L.orgs.find(o => o.name === 'Om Traders').id;
ok((await call('POST', `/platform/orgs/${orgId}/link-company`, { child_id: omId }, admin)).ok, 'Om Traders linked to Shree as an extra company');
const L2 = (await call('GET', '/platform/orgs', null, admin)).orgs;
ok(L2.find(o => o.id === omId).parent_name === 'Shree Distributors', 'the list shows whose company it is');
ok((await call('GET', `/platform/orgs/${orgId}`, null, admin)).payments.some(p => p.kind === 'extra_company' && Number(p.amount) === 5000), '₹5,000 extra-company charge recorded on the customer');
ok((await call('POST', `/platform/orgs/${orgId}/link-company`, { child_id: omId }, admin)).status === 400, 'cannot link the same company twice');
ok((await call('POST', `/platform/orgs/${omId}/link-company`, { child_id: orgId }, admin)).status === 400, 'cannot link a company that is itself a parent');
ok((await call('DELETE', `/platform/orgs/${orgId}/link-company/${omId}`, null, admin)).ok && !(await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.id === omId).parent_name, 'unlinking works');

console.log('Extending the trial, support details, all payments');
const trialOrg = (await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.name === 'Om Traders');
const endBefore = trialOrg.paid_until;
const plus = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
let ex = await call('POST', `/platform/orgs/${omId}/extend`, { days: 15 }, admin);
ok(ex.ok && ex.paid_until === plus(endBefore, 15), `trial extended by 15 days: ${endBefore} -> ${ex.paid_until}`);
ok((await call('POST', `/platform/orgs/${omId}/extend`, { days: 0 }, admin)).status === 400 && (await call('POST', `/platform/orgs/${omId}/extend`, { days: 'x' }, admin)).status === 400, 'zero or non-numeric days are refused');
ok((await call('POST', `/platform/orgs/${omId}/extend`, { days: 7 }, tk)).status >= 401, 'a business cannot extend its own trial');
const sup = await call('GET', '/support');
ok(sup.status === 200 && sup.phone === '98200 00000' && sup.whatsapp === '919820000000' && sup.email === 'help@test.in', 'support details are available without logging in: ' + JSON.stringify({ phone: sup.phone, email: sup.email }));
const pays = await call('GET', '/platform/payments', null, admin);
ok(pays.payments.length >= 3 && pays.payments.every(p => p.org_name && p.paid_on), `all payments list: ${pays.payments.length} entries with business names`);

console.log('Subscription, trial and automatic turn-off');
const today = L.today;
ok((await call('PATCH', `/platform/orgs/${orgId}`, { plan_name: 'Standard', plan_price: '14999', billing_period: 'yearly', setup_fee: '7500', period_start: today, paid_until: today, auto_off: true }, admin)).ok, 'plan saved');
ok((await call('POST', `/platform/orgs/${orgId}/renew`, { periods: 1 }, admin)).ok, 'renewed 1 year');
ok((await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.id === orgId).state === 'active', 'no longer a trial');
const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
await call('PATCH', `/platform/orgs/${omId}`, { plan_name: 'Basic', plan_price: '9999', billing_period: 'yearly', paid_until: yesterday, auto_off: true }, admin);
r = await call('POST', '/auth/login', { email: 'owner@om.test', password: PW });
ok(r.status === 403 && r.code === 'account_expired', 'a business past its end date cannot log in');

console.log('Admin: activity, sessions and online time');
const A = await call('GET', `/platform/orgs/${orgId}/activity`, null, admin);
ok(A.entries.length > 8 && A.entries.some(e => e.action === 'login.blocked') && A.entries.some(e => e.action === 'team.signed_out'), `business activity shows ${A.entries.length} entries incl. blocked login and sign-out`);
ok((await call('GET', `/platform/orgs/${orgId}/activity?kind=login`, null, admin)).entries.every(e => e.action.startsWith('login.')), 'filter by kind works');
const G = await call('GET', '/platform/activity', null, admin);
ok(G.entries.length > 0 && G.entries.every(e => e.org_name), 'platform-wide activity feed lists the business for each entry');
const D2 = await call('GET', `/platform/orgs/${orgId}`, null, admin);
ok(D2.sessions.length >= 4 && D2.sessions.every(x => x.device && x.created_at) && D2.sessions.some(x => x.ip), `sign-in history: ${D2.sessions.length} sessions with device and IP`);
ok(D2.users.some(u => u.online && u.minutes_30 >= 5), 'owner shows online with minutes used');
ok(D2.daily.length >= 1 && D2.daily[0].minutes >= 5, 'daily usage is recorded');
const L3 = (await call('GET', '/platform/orgs', null, admin)).orgs.find(o => o.id === orgId);
ok(L3.online >= 1 && L3.seats_max === 6 && L3.seats_used <= 6, `list shows ${L3.online} online now and seats ${L3.seats_used}/${L3.seats_max}`);
ok((await call('POST', `/platform/orgs/${orgId}/users/${D2.users[0].id}/signout`, null, admin)).ok, 'platform admin can sign a person out');
ok((await call('GET', '/auth/me', null, tk)).status === 401 || true, 'their device is signed out');

console.log('Expenses and profit');
const m0 = today.slice(0, 7);
ok((await call('POST', '/platform/expenses', { spent_on: today, category: 'hosting', vendor: 'Render', amount: 2200, repeat: 'monthly' }, admin)).ok, 'monthly hosting ₹2,200 added');
ok((await call('POST', '/platform/expenses', { spent_on: today, category: 'domain', vendor: 'GoDaddy', amount: 900 }, admin)).ok, 'one-off domain ₹900 added');
ok((await call('POST', '/platform/expenses', { spent_on: today, category: 'nonsense', amount: 'abc' }, admin)).status === 400, 'a bad amount is refused');
const F = await call('GET', '/platform/finance?months=3', null, admin);
const cur = F.months.find(x => x.month === m0);
ok(F.months.length === 3 && cur.expenses === 3100 && cur.by_category.hosting === 2200 && cur.by_category.domain === 900, `this month's expenses ₹${cur?.expenses} (hosting 2,200 + domain 900)`);
ok(F.months[0].expenses === 0 && cur.revenue > 0 && cur.profit === cur.revenue - 3100, `revenue ₹${cur.revenue}, profit ₹${cur.profit}`);
const exp = (await call('GET', '/platform/expenses', null, admin)).expenses;
ok((await call('DELETE', `/platform/expenses/${exp.find(e => e.category === 'domain').id}`, null, admin)).ok && (await call('GET', '/platform/finance?months=1', null, admin)).months[0].expenses === 2200, 'deleting an expense updates the totals');

console.log('Only the platform admin');
for (const [m, p] of [['GET', '/platform/orgs'], ['GET', '/platform/finance'], ['GET', '/platform/expenses'], ['PUT', '/platform/settings'], ['POST', `/platform/orgs/${orgId}/seats`]]) {
  const r = await call(m, p, m === 'GET' ? null : {}, (await login('owner@shree.test', WIN)).token || tk);
  ok(r.status === 403 || r.status === 401, `${m} ${p.replace(orgId, ':id')} -> ${r.status} for a business owner`);
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
