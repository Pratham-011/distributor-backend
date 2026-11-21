// Platform admin signs a whole business out of its devices.
//   RATE_LIMIT_DISABLED=1 PLATFORM_ADMIN_EMAILS=admin@test.in node src/index.js      then      node test/signout-all.mjs
const B = process.env.API || 'http://localhost:4100/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✕ ') + m); if (!c) fails++; };
const PW = 'Correct-horse-9', json = { 'Content-Type': 'application/json' };
const call = async (method, p, body, H = {}) => {
  const r = await fetch(B + p, { method, headers: { ...H, ...(body ? json : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const auth = t => ({ Authorization: 'Bearer ' + t });
async function signup(email, business) {
  const r = await call('POST', '/auth/register', { name: email.split('@')[0], email, password: PW, business_name: business, state_code: '27' });
  return (await call('POST', '/auth/verify', { email, code: r.demo_code })).token;
}

const admin = auth(await signup('admin@test.in', 'Reportly HQ'));
const owner = await signup('owner@shop.test', 'Shop One');
const other = await signup('owner@other.test', 'Other Co');
await call('POST', '/users/invite', { email: 'clerk@shop.test', role: 'viewer' }, auth(owner));
const cr = await call('POST', '/auth/register', { name: 'Clerk', email: 'clerk@shop.test', password: PW });
const clerk = (await call('POST', '/auth/verify', { email: 'clerk@shop.test', code: cr.demo_code })).token;
// Other Co's owner also works in Shop One, but is signed in to Other Co right now
await call('POST', '/users/invite', { email: 'owner@other.test', role: 'viewer' }, auth(owner));
const orgs = (await call('GET', '/platform/orgs', null, admin)).orgs;
const shop = orgs.find(o => o.name === 'Shop One'), hq = orgs.find(o => o.name === 'Reportly HQ');

console.log('Who may do it');
ok((await call('POST', `/platform/orgs/${shop.id}/signout-all`, null, auth(owner))).status === 403, 'a business owner cannot');
ok((await call('POST', `/platform/orgs/${hq.id}/signout-all`, null, admin)).status === 400, 'the admin cannot sign out their own business this way');
ok((await call('GET', '/auth/me', null, auth(owner))).user && (await call('GET', '/auth/me', null, auth(clerk))).user, 'nothing happened yet');

console.log('Signing everyone out');
const r = await call('POST', `/platform/orgs/${shop.id}/signout-all`, null, admin);
ok(r.ok && r.people === 2 && r.sessions === 2, `signed out ${r.people} people (${r.sessions} sign-ins)`);
const me = await call('GET', '/auth/me', null, auth(owner));
ok(me.status === 401 && /administrator signed you out/i.test(me.error), 'the owner is signed out and told why');
ok((await call('GET', '/auth/me', null, auth(clerk))).status === 401, 'the other person is signed out too');
ok((await call('GET', '/auth/me', null, auth(other))).user?.org_name === 'Other Co', 'someone who also works there but is signed in to another business is not touched');
ok((await call('POST', '/auth/login', { email: 'owner@shop.test', password: PW })).token, 'they can log in again straight away');
const feed = (await call('GET', '/platform/activity', null, admin)).entries;
ok(feed.some(e => e.org_id === shop.id && /Signed everyone out/.test(e.message)), 'the business\'s activity log records it');
ok((await call('POST', `/platform/orgs/${shop.id}/signout-all`, null, admin)).people === 1, 'running it again signs out only who is signed in now');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
