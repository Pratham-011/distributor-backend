// Several businesses per login, requests, business profile. Run against a test server:
//   PORT=4102 RATE_LIMIT_DISABLED=1 PLATFORM_ADMIN_EMAILS=admin@test.in node src/index.js   then   API=http://localhost:4102/api node test/multi.mjs
const B = process.env.API || 'http://localhost:4102/api', PW = 'Correct-horse-9';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + m); };
const call = async (method, path, body, tk, ua) => {
  const o = { method, headers: { ...(tk ? { Authorization: 'Bearer ' + tk } : {}), ...(ua ? { 'User-Agent': ua } : {}) } };
  if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(B + path, o); return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const signup = async (email, business, name = 'Test') => {
  const r = await call('POST', '/auth/register', { name, email, password: PW, business_name: business, state_code: '27' });
  return call('POST', '/auth/verify', { email, code: r.demo_code });
};
const login = (email, ua) => call('POST', '/auth/login', { email, password: PW }, null, ua);

const admin = (await signup('admin@test.in', 'Reportly HQ', 'Admin')).token;
const owner = await signup('owner@shree.test', 'Shree Distributors', 'Shree');
const O = owner.token;

// ---- contact details
const sup = await call('GET', '/support');
ok(sup.phones?.length === 2 && sup.phones.join().includes('98928 41898') && sup.phones.join().includes('81692 25516'), 'both support numbers are published');
ok(sup.email === 'app.reportly@gmail.com' && sup.whatsapp === '919892841898', 'support email and WhatsApp default correctly');

// ---- business profile
let r = await call('PATCH', '/org', { gstin: '29ABCDE1234F1Z5' }, O);
ok(r.status === 400 && /29/.test(r.error), 'GSTIN that does not match the GST state is refused');
r = await call('PATCH', '/org', { gstin: 'bad' }, O);
ok(r.status === 400, 'malformed GSTIN is refused');
r = await call('PATCH', '/org', { gstin: '27abcde1234f1z5', phone: '98928 41898', contact_email: 'accounts@shree.test', address: '12 Market Road, Pune' }, O);
ok(r.user?.profile?.gstin === '27ABCDE1234F1Z5' && r.user.profile.address.startsWith('12 Market'), 'owner saves the business profile');
const me0 = await call('GET', '/auth/me', null, O);
ok(me0.user.profile.phone === '98928 41898' && me0.user.profile.contact_email === 'accounts@shree.test', 'profile comes back on the next load');

// ---- requests
r = await call('POST', '/requests', { kind: 'support', message: 'Upload is slow' }, O);
ok(r.ok && r.emailed === false, 'a support request is saved (not emailed: no SMTP in the test)');
r = await call('POST', '/requests', { kind: 'support', message: 'x' }, O);
ok(r.status === 400, 'a request with no real message is refused');
r = await call('POST', '/requests', { kind: 'add_business', payload: { business_name: 'Shree Traders', state_code: '27', login: 'same' } }, O);
const reqSame = r.id; ok(r.ok, 'owner asks for another business with the same login');
r = await call('POST', '/requests', { kind: 'add_business', payload: { business_name: 'Shree Foods', state_code: '27', login: 'new', owner_name: 'Foods Owner', owner_email: 'foods@shree.test' } }, O);
const reqNew = r.id; ok(r.ok, 'owner asks for another business with a new login');
r = await call('POST', '/requests', { kind: 'add_business', payload: { business_name: 'Shree Foods', state_code: '27', login: 'new' } }, O);
ok(r.status === 400, 'a new login needs the other person\'s name and email');
r = await call('POST', '/requests', { kind: 'add_user', payload: { how_many: 2 } }, O);
ok(r.ok, 'owner asks for more people');
const mine = await call('GET', '/requests', null, O);
ok(mine.requests.length === 4, 'the business sees its own requests');

// ---- the platform admin handles them
const pr = await call('GET', '/platform/requests', null, admin);
ok(pr.requests.length === 4 && pr.counts.new === 4, 'platform admin sees all 4 new requests');
const fOwner = await call('GET', '/requests', null, admin);
ok(fOwner.requests.length === 0, 'requests of other businesses are not visible to a different business');
const orgs = await call('GET', '/platform/orgs', null, admin);
const shree = orgs.orgs.find(o => o.name === 'Shree Distributors');
const reqRow = pr.requests.find(x => x.id === reqSame);
r = await call('POST', `/platform/orgs/${shree.id}/new-company`, { name: 'Shree Traders', state_code: '27', login: 'same', from_user_id: reqRow.requested_user_id, request_id: reqSame }, admin);
ok(r.ok && !r.needs_signup, 'admin creates the second business for the same login');
r = await call('POST', `/platform/orgs/${shree.id}/new-company`, { name: 'Shree Foods', state_code: '27', login: 'new', owner_email: 'foods@shree.test', request_id: reqNew }, admin);
ok(r.ok && r.needs_signup, 'admin creates a business for a new person (invited)');
const pr2 = await call('GET', '/platform/requests?status=done', null, admin);
ok(pr2.requests.length === 2, 'creating the business marks the request done');
const pay = await call('GET', '/platform/payments', null, admin);
ok(pay.payments.filter(p => p.kind === 'extra_company').length === 2 && pay.payments.every(p => p.org_id !== undefined), 'the extra-company charge was recorded twice');

// ---- one login, two businesses, one device
const me1 = await call('GET', '/auth/me', null, O);
ok(me1.user.businesses.length === 2, 'the login now shows 2 businesses');
const other = me1.user.businesses.find(b => b.name === 'Shree Traders');
const sw = await call('POST', '/auth/switch', { user_id: other.user_id }, me1.token);
ok(sw.user?.org_name === 'Shree Traders' && sw.user.role === 'owner', 'switching opens the other business as Owner');
ok((await call('GET', '/auth/me', null, O)).status === 401, 'the old sign-in stops working after the switch');
const empty = await call('GET', '/uploads', null, sw.token);
ok(empty.status === 200 && (empty.uploads || empty.items || []).length === 0, 'the second business starts with no data of its own');
const sec = await login('owner@shree.test', 'Mozilla/5.0 (Windows) Chrome/120');
ok(sec.status === 409 && sec.code === 'already_signed_in', 'a second device is refused while the person is live in either business');
await call('POST', '/auth/logout', null, sw.token);
const again = await login('owner@shree.test', 'Mozilla/5.0 (iPhone) Safari/17');
ok(again.token && again.user.org_name === 'Shree Traders', 'after logging out, login opens the business used last');
const back = await call('POST', '/auth/switch', { user_id: me1.user.businesses.find(b => b.name === 'Shree Distributors').user_id }, again.token);
ok(back.user?.org_name === 'Shree Distributors', 'switching back works');
const stranger = await signup('stranger@x.test', 'Other Co');
const bad = await call('POST', '/auth/switch', { user_id: other.user_id }, stranger.token);
ok(bad.status === 404, 'nobody can switch into a business that is not theirs');

// ---- a new person is invited, signs up, becomes Owner of the new business
const inv = await call('POST', '/auth/register', { name: 'Foods Owner', email: 'foods@shree.test', password: PW });
const fv = await call('POST', '/auth/verify', { email: 'foods@shree.test', code: inv.demo_code });
ok(fv.user?.org_name === 'Shree Foods' && fv.user.role === 'owner', 'the invited person joins as Owner of the new business');

// ---- adding someone who already uses Reportly
const team = await call('POST', '/users/invite', { email: 'stranger@x.test', role: 'viewer' }, back.token);
ok(team.added_existing === true, 'a person who already has a login is added straight away');
const dup = await call('POST', '/users/invite', { email: 'stranger@x.test', role: 'viewer' }, back.token);
ok(dup.status === 409, 'adding the same person twice is refused');
const sMe = await call('GET', '/auth/me', null, stranger.token);
ok(sMe.user.businesses.length === 2 && sMe.user.role === 'owner', 'they see both businesses and keep their own role in the first one');
const sSw = await call('POST', '/auth/switch', { user_id: sMe.user.businesses.find(b => b.name === 'Shree Distributors').user_id }, sMe.token);
ok(sSw.user?.role === 'viewer', 'in the new business they only have the role they were given');
const viewerReq = await call('POST', '/requests', { kind: 'add_business', payload: { business_name: 'X', state_code: '27' } }, sSw.token);
ok(viewerReq.status === 403, 'only an Owner can ask for another business');

// ---- one password for every business
const fgt = await call('POST', '/auth/forgot', { email: 'stranger@x.test' });
const rs = await call('POST', '/auth/reset', { email: 'stranger@x.test', code: fgt.demo_code, password: 'Another-pass-77' });
const l2 = await call('POST', '/auth/login', { email: 'stranger@x.test', password: 'Another-pass-77' });
ok(rs.ok && l2.token, 'resetting the password changes it for every business of that login');
const l3 = await call('POST', '/auth/switch', { user_id: l2.user.businesses.find(b => b.org_id !== l2.user.org_id).user_id }, l2.token);
ok(l3.token, 'and the other business can still be opened after the reset');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
