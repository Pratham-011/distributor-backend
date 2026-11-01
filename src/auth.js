import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from './db.js';
import { HttpError, wrap, uuidParam } from './http.js';
import { logActivity } from './activity.js';
import { STATE_NAME } from './states.js';
import { sendMail, mailReady, addedMail } from './mail.js';
import { seatInfo } from './settings.js';

const PROD = process.env.NODE_ENV === 'production';

// ---------- secrets and settings ----------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (PROD && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || /change-this|dev-only/i.test(process.env.JWT_SECRET))) {
  throw new Error('JWT_SECRET must be set to a long random value (32+ characters) in production.');
}
// Demo codes (shown on screen) only ever work outside production: otherwise anyone could take over any account.
export const OTP_DEMO = !PROD && (process.env.OTP_DEMO ?? 'true') === 'true';
if (PROD && process.env.OTP_DEMO === 'true') console.warn('[security] OTP_DEMO=true is ignored in production: codes are emailed (or, without Brevo, only written to the server log).');
if (PROD && !mailReady) console.warn('[setup] Email (BREVO_API_KEY) is not set up: sign-up and password-reset codes are only written to the server log until it is.');

/** Tells a person by email that they were added to a business. Never fails the request; says whether it was sent. */
export async function notifyAdded(email, { orgName, role, byName, existing }) {
  if (!mailReady) { console.warn(`[mail] email is not set up; ${email} was not told they were added to ${orgName}`); return false; }
  try { const m = addedMail({ orgName, roleLabel: ROLE_LABEL[role] || role, byName, existing }); await sendMail(email, m.subject, m.text); return true; }
  catch (e) { console.error(`[mail] could not email ${email}: ${e.message}`); return false; }
}
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const TRIAL_DAYS = process.env.TRIAL_DAYS === undefined ? 15 : Math.max(0, Number(process.env.TRIAL_DAYS) || 0);   // 0 = new sign-ups wait for you to switch them on
const SESSION = '30d';
const IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS) || 8;      // a sign-in unused this long no longer blocks another device
const RATE_OFF = !PROD && process.env.RATE_LIMIT_DISABLED === '1';  // for automated tests only
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);   // so unknown emails take as long as real ones

export const ROLES = ['viewer', 'writer', 'admin', 'owner'];
export const ROLE_LABEL = { viewer: 'Viewer', writer: 'Uploader', admin: 'Admin', owner: 'Owner' };
const rank = r => ROLES.indexOf(r);
export const hasRole = (user, min) => rank(user.role) >= rank(min);

const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 254);
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// codes are keyed hashes: a copy of the table is useless without the server secret
const hashCode = (email, purpose, code) => crypto.createHmac('sha256', JWT_SECRET).update(`${email}|${purpose}|${String(code).trim()}`).digest('hex');

const COMMON = /^(password|passw0rd|12345678|123456789|1234567890|qwertyuiop|iloveyou|admin12345|welcome123)/i;
function checkPassword(p, email) {
  const s = String(p || '');
  if (s.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
  if (s.length > 200) throw new HttpError(400, 'Password is too long.');
  if (COMMON.test(s) || /^(.)\1+$/.test(s) || (email && s.toLowerCase() === email)) throw new HttpError(400, 'That password is too easy to guess. Please choose another.');
}

// ---------- rate limits (per IP) ----------
const limiter = (windowMin, limit, what) => rateLimit({
  windowMs: windowMin * 60000, limit, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => RATE_OFF,
  handler: (_req, res) => res.status(429).json({ error: `Too many ${what}. Please wait a few minutes and try again.` }),
});
const loginLimit = limiter(15, 20, 'login attempts');
const signupLimit = limiter(60, 10, 'sign-up attempts');
const codeLimit = limiter(60, 30, 'attempts');

// ---------- platform: who runs the software, and whether a business may use it today ----------
export const PLATFORM_ADMINS = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
export const isPlatformAdmin = u => !!u && PLATFORM_ADMINS.includes(String(u.email).toLowerCase());
const SUPPORT = process.env.SUPPORT_CONTACT || '';
export const todayIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
export const supportText = () => (SUPPORT ? ` Please contact ${SUPPORT}` : ' Please contact your software provider');

/** null when the business may use the app today; otherwise the reason (shown to its users). */
export function accessBlock(u) {
  if (isPlatformAdmin(u)) return null;
  if (u.org_status === 'paused') {
    return { code: 'account_paused', error: `The portal for ${u.org_name} is paused${u.org_status_reason ? ` (${u.org_status_reason})` : ''}.${supportText()}.` };
  }
  if (u.org_auto_off && u.org_paid_until && u.org_paid_until < todayIndia()) {
    return { code: 'account_expired', error: `The subscription for ${u.org_name} ended on ${dayText(u.org_paid_until)}.${supportText()} to renew.` };
  }
  return null;
}

// u must carry the org_* fields from USER_WITH_ORG
function publicUser(u) {
  const sub = u.org_paid_until ? { paid_until: u.org_paid_until, days_left: daysBetween(todayIndia(), u.org_paid_until), auto_off: u.org_auto_off, trial: !!u.org_trial } : null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, org_id: u.org_id, org_name: u.org_name, state_code: u.org_state || null,
    profile: { address: u.org_address || '', gstin: u.org_gstin || '', phone: u.org_phone || '', contact_email: u.org_contact_email || '' },
    platform_admin: isPlatformAdmin(u), subscription: sub };
}
const USER_WITH_ORG = `select u.*, o.name org_name, o.state_code org_state, o.status org_status, o.status_reason org_status_reason,
  o.paid_until::text org_paid_until, o.auto_off org_auto_off, o.trial org_trial,
  o.address org_address, o.gstin org_gstin, o.phone org_phone, o.contact_email org_contact_email from users u join organizations o on o.id=u.org_id`;

/** Every business this email belongs to (one row each), for the business switcher. */
async function businessesOf(email) {
  return (await db.query(
    `select u.id user_id, u.org_id, o.name, u.role, o.parent_org_id from users u join organizations o on o.id=u.org_id where u.email=$1 and u.active order by o.name`, [email])).rows;
}
const sessionUser = async u => ({ ...publicUser(u), businesses: await businessesOf(u.email) });

// ---------- sessions: one live sign-in per person ----------
export function deviceOf(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iPhone/iPad' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
const SESSION_WHY = {
  other_device: 'You were signed out because this account was opened on another device.',
  admin: 'An administrator signed you out. Please log in again.',
  password: 'Your password was changed. Please log in again.',
  access_off: 'Your access was turned off.',
  expired: 'Your sign-in expired. Please log in again.',
};

export async function revokeUserSessions(userId, why) {
  await db.query(`update sessions set revoked_at=now(), revoked_why=$2 where user_id=$1 and revoked_at is null`, [userId, why]);
}

/** Starts a sign-in. A second device is refused while the first is live (used within the last IDLE_HOURS). */
async function startSession(req, u, { switching = false } = {}) {
  const admin = isPlatformAdmin(u);
  return db.tx(async t => {
    // one person = one email, even when it belongs to several businesses: they share one live sign-in
    await t.query('select id from users where email=$1 order by id for update', [u.email]);   // two logins at the same moment can't both win
    if (!admin) {
      const live = switching ? null : (await t.query(
        `select s.user_agent, s.last_seen_at from sessions s join users x on x.id=s.user_id where x.email=$1 and s.revoked_at is null and s.last_seen_at > now() - ($2 || ' hours')::interval
         order by s.last_seen_at desc limit 1`, [u.email, String(IDLE_HOURS)])).rows[0];
      if (live) {
        throw new HttpError(409, `${u.name || 'This user'} is already signed in on another device (${deviceOf(live.user_agent)}). ` +
          'Log out there first, then log in here. If you cannot, ask your Owner or Admin to sign that device out (Team & access), or reset your password.',
        { code: 'already_signed_in' });
      }
      await t.query(`update sessions set revoked_at=now(), revoked_why=$2 where user_id in (select id from users where email=$1) and revoked_at is null`, [u.email, switching ? 'logout' : 'other_device']);
    }
    return (await t.query(`insert into sessions (user_id, org_id, ip, user_agent) values ($1,$2,$3,$4) returning id`,
      [u.id, u.org_id, req.ip || null, String(req.get('user-agent') || '').slice(0, 300)])).rows[0].id;
  });
}
const sign = (user, sid) => jwt.sign({ sub: user.id, sid }, JWT_SECRET, { expiresIn: SESSION });

// Usage: each 5-minute window in which someone does anything counts once (about 5 minutes of use).
const lastWindow = new Map(), lastTouch = new Map();
function trackUse(u, sid) {
  const now = Date.now(), w = Math.floor(now / 300000);
  if (now - (lastTouch.get(sid) || 0) > 60000) {
    lastTouch.set(sid, now);
    db.query('update sessions set last_seen_at=now() where id=$1', [sid]).catch(() => {});
  }
  if (lastWindow.get(u.id) === w) return;
  lastWindow.set(u.id, w);
  db.query(`insert into usage_blocks (user_id, org_id, day, blocks) values ($1,$2,$3,1)
    on conflict (user_id, day) do update set blocks = usage_blocks.blocks + 1`, [u.id, u.org_id, todayIndia()]).catch(() => {});
  db.query('update users set last_seen_at=now() where id=$1', [u.id]).catch(() => {});
}
const checkState = code => {
  if (!STATE_NAME[code]) throw new HttpError(400, 'Please choose the state where your business is registered for GST.');
};

// ---------- one-time codes ----------
/** Sends the code by email. Demo mode (never in production) returns it to the browser. Without Brevo it is only written to the server log. */
async function issueOtp(email, purpose, payload) {
  const recent = await db.query(
    `select count(*)::int n from otps where email=$1 and created_at > now() - interval '10 minutes'`, [email]);
  if (recent.rows[0].n >= 5) throw new HttpError(429, 'Too many codes requested. Please wait 10 minutes.');
  const code = String(crypto.randomInt(100000, 1000000));
  await db.query(`update otps set used_at=now() where email=$1 and purpose=$2 and used_at is null`, [email, purpose]);
  await db.query(
    `insert into otps (email, purpose, code_hash, payload, expires_at)
     values ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [email, purpose, hashCode(email, purpose, code), JSON.stringify(payload), String(OTP_MINUTES)]);
  if (OTP_DEMO) {
    console.log(`[OTP] ${purpose} code for ${email}: ${code}`);
    return { demo_code: code };
  }
  const what = purpose === 'register' ? 'finish creating your account' : 'reset your password';
  if (!mailReady) {
    console.warn(`[OTP] email is not set up; ${purpose} code for ${email}: ${code}`);
    return {};
  }
  try {
    await sendMail(email, `Your code: ${code}`, `Your code to ${what} is ${code}.\n\nIt works for ${OTP_MINUTES} minutes. If you did not ask for this, you can ignore this email.`);
  } catch (e) {
    console.error(`[OTP] could not email ${email}: ${e.message}`);
    throw new HttpError(503, 'We could not send the code by email right now. Please try again in a few minutes.');
  }
  return {};
}

async function consumeOtp(email, purpose, code) {
  const r = await db.query(
    `select * from otps where email=$1 and purpose=$2 and used_at is null and expires_at > now()
     order by created_at desc limit 1`, [email, purpose]);
  const otp = r.rows[0];
  if (!otp) throw new HttpError(400, 'This code has expired. Please ask for a new code.');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(400, 'Too many wrong tries. Please ask for a new code.');
  const a = Buffer.from(otp.code_hash), b = Buffer.from(hashCode(email, purpose, code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await db.query(`update otps set attempts = attempts + 1 where id=$1`, [otp.id]);
    throw new HttpError(400, 'Wrong code. Please check and try again.');
  }
  await db.query(`update otps set used_at=now() where id=$1`, [otp.id]);
  return otp.payload;
}

export const authRouter = Router();

// Step 1 of sign-up: details + password -> code sent
authRouter.post('/register', signupLimit, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const name = String(req.body.name || '').trim().slice(0, 100);
  const business = String(req.body.business_name || '').trim().slice(0, 150);
  const state_code = String(req.body.state_code || '').trim();
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!name) throw new HttpError(400, 'Please enter your name.');
  checkPassword(req.body.password, email);
  const exists = await db.query('select 1 from users where email=$1', [email]);
  if (exists.rows.length) throw new HttpError(409, 'This email already has an account. Please log in.');
  const invite = (await db.query('select i.*, o.name org_name from invites i join organizations o on o.id=i.org_id where email=$1 order by i.created_at desc limit 1', [email])).rows[0];
  if (!invite) {
    if (!business) throw new HttpError(400, 'Please enter your business name.');
    checkState(state_code);
  }
  const password_hash = await bcrypt.hash(String(req.body.password), BCRYPT_COST);
  const extra = await issueOtp(email, 'register', { name, business, state_code, password_hash });
  res.json({ ok: true, email, joining: invite ? invite.org_name : null, ...extra });
}));

// Step 2 of sign-up: code -> account created and logged in
authRouter.post('/verify', codeLimit, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const payload = await consumeOtp(email, 'register', req.body.code);
  let newBusiness = false;
  const user = await db.tx(async t => {
    const dup = await t.query('select 1 from users where email=$1', [email]);
    if (dup.rows.length) throw new HttpError(409, 'This email already has an account. Please log in.');
    const invite = (await t.query('select * from invites where email=$1 order by created_at desc limit 1', [email])).rows[0];
    let orgId, role;
    if (invite) {
      orgId = invite.org_id; role = invite.role;
      await t.query('delete from invites where id=$1', [invite.id]);
    } else {
      // a self-signed-up business gets a trial (TRIAL_DAYS), or waits for you to switch it on when TRIAL_DAYS=0
      const trialEnd = TRIAL_DAYS > 0 ? addDays(todayIndia(), TRIAL_DAYS) : null;
      orgId = (await t.query(
        `insert into organizations (name, state_code, trial, plan_name, period_start, paid_until, auto_off, status, status_reason)
         values ($1,$2,true,'Trial',$3,$4,true,$5,$6) returning id`,
        [payload.business, payload.state_code || null, todayIndia(), trialEnd, TRIAL_DAYS > 0 ? 'active' : 'paused', TRIAL_DAYS > 0 ? null : 'Waiting to be switched on'])).rows[0].id;
      role = 'owner'; newBusiness = true;
    }
    return (await t.query(
      `insert into users (org_id, email, name, password_hash, role, last_login_at) values ($1,$2,$3,$4,$5, now()) returning *`,
      [orgId, email, payload.name, payload.password_hash, role])).rows[0];
  });
  const u = (await db.query(USER_WITH_ORG + ' where u.id=$1', [user.id])).rows[0];
  if (newBusiness) {
    await logActivity(req, 'account.created', `Created the business account "${u.org_name}" (${STATE_NAME[u.org_state] || 'no state'})` + (TRIAL_DAYS > 0 ? `, ${TRIAL_DAYS}-day trial` : ''), {}, u);
  } else {
    await logActivity(req, 'account.joined', `Joined as ${ROLE_LABEL[u.role]}`, { email }, u);
  }
  const block = accessBlock(u);
  if (block) throw new HttpError(403, `Your account was created. ${block.error}`, { code: block.code });
  const sid = await startSession(req, u);
  res.json({ token: sign(u, sid), user: await sessionUser(u) });
}));

authRouter.post('/login', loginLimit, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  // the same email may belong to several businesses: open the one used last that can be used today
  const rows = (await db.query(USER_WITH_ORG + ' where u.email=$1 order by u.last_login_at desc nulls last', [email])).rows;
  const u = rows.find(r => r.active && !accessBlock(r)) || rows[0];
  if (u) {
    // 10 wrong tries in 15 minutes: no more tries for a while, even with the right password
    const bad = (await db.query(`select count(*)::int n from activity_log where user_id=$1 and action='login.failed' and created_at > now() - interval '15 minutes'`, [u.id])).rows[0].n;
    if (bad >= 10) throw new HttpError(429, 'Too many wrong attempts on this account. Please wait 15 minutes, or reset the password.');
  }
  const ok = await bcrypt.compare(String(req.body.password || '').slice(0, 200), u ? u.password_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    if (u) await logActivity(req, 'login.failed', 'Wrong password entered while logging in', {}, u);
    throw new HttpError(401, 'Email or password is not correct.');
  }
  if (!u.active) {
    await logActivity(req, 'login.failed', 'Tried to log in, but the account is turned off', {}, u);
    throw new HttpError(403, 'Your account has been turned off. Please contact the owner.');
  }
  const block = accessBlock(u);
  if (block) {
    await logActivity(req, 'login.failed', block.code === 'account_paused' ? 'Tried to log in while the portal is paused' : 'Tried to log in after the subscription ended', {}, u);
    throw new HttpError(403, block.error, { code: block.code });
  }
  let sid;
  try { sid = await startSession(req, u); }
  catch (e) {
    if (e.status === 409) await logActivity(req, 'login.blocked', 'Tried to log in on a second device while already signed in elsewhere', { device: deviceOf(req.get('user-agent')) }, u);
    throw e;
  }
  await db.query('update users set last_login_at=now() where id=$1', [u.id]);
  await logActivity(req, 'login.success', `Logged in (${deviceOf(req.get('user-agent'))})`, {}, u);
  res.json({ token: sign(u, sid), user: await sessionUser(u) });
}));

authRouter.post('/forgot', codeLimit, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const u = (await db.query('select id from users where email=$1 and active', [email])).rows[0];
  // Same answer whether or not the account exists, so emails can't be probed.
  const extra = u ? await issueOtp(email, 'reset', {}) : {};
  res.json({ ok: true, ...extra });
}));

authRouter.post('/reset', codeLimit, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  checkPassword(req.body.password, email);
  await consumeOtp(email, 'reset', req.body.code);
  const hash = await bcrypt.hash(String(req.body.password), BCRYPT_COST);
  // one password for every business this email belongs to
  for (const u of (await db.query('update users set password_hash=$1 where email=$2 returning id, org_id, name', [hash, email])).rows) {
    await revokeUserSessions(u.id, 'password');     // every device is signed out, so the next login is not blocked
    await logActivity(req, 'login.password_reset', 'Changed their password using an email code', {}, u);
  }
  res.json({ ok: true });
}));

// ---------- middleware ----------
async function authenticate(req, { allowBlocked = false } = {}) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); } catch { throw new HttpError(401, 'Your login has expired. Please log in again.'); }
  if (!claims.sid) throw new HttpError(401, 'Please log in again.', { code: 'session_ended' });
  const s = (await db.query('select user_id, revoked_at, revoked_why from sessions where id=$1', [claims.sid])).rows[0];
  if (!s || s.user_id !== claims.sub) throw new HttpError(401, 'Please log in again.', { code: 'session_ended' });
  if (s.revoked_at) throw new HttpError(401, SESSION_WHY[s.revoked_why] || 'You have been logged out. Please log in again.', { code: s.revoked_why === 'logout' ? 'session_ended' : 'session_revoked' });
  // role is re-read from the DB on every request, so a role change applies immediately
  const u = (await db.query(USER_WITH_ORG + ' where u.id=$1', [claims.sub])).rows[0];
  if (!u || !u.active) throw new HttpError(401, 'Please log in.', { code: 'session_ended' });
  const block = accessBlock(u);
  if (block && !allowBlocked) throw new HttpError(403, block.error, { code: block.code });
  u.platform_admin = isPlatformAdmin(u);
  u.sid = claims.sid;
  req.user = u;
  if (!block) trackUse(u, claims.sid);
}
export const requireAuth = wrap(async (req, _res, next) => { await authenticate(req); next(); });
// a valid sign-in, even if this business is paused or expired (so the person can still switch to another business)
const requireSession = wrap(async (req, _res, next) => { await authenticate(req, { allowBlocked: true }); next(); });

export const requireRole = min => (req, _res, next) => {
  if (rank(req.user.role) < rank(min)) return next(new HttpError(403, `Only ${ROLE_LABEL[min]} or above can do this.`));
  next();
};

// also hands back a fresh token for the same sign-in, which keeps it going for another 30 days
authRouter.get('/me', requireAuth, wrap(async (req, res) => res.json({ user: await sessionUser(req.user), token: sign(req.user, req.user.sid) })));

// the businesses this person belongs to, with whether each can be opened today
authRouter.get('/businesses', requireSession, wrap(async (req, res) => {
  const list = await businessesOf(req.user.email);
  const rows = (await db.query(USER_WITH_ORG + ' where u.email=$1', [req.user.email])).rows;
  const off = Object.fromEntries(rows.map(r => [r.id, accessBlock(r)?.error || null]));
  res.json({ current: req.user.org_id, businesses: list.map(b => ({ ...b, blocked: off[b.user_id] || null })) });
}));

// Opens another business of the same person: the current sign-in ends and a new one starts there (still one device at a time).
authRouter.post('/switch', requireSession, wrap(async (req, res) => {
  const target = (await db.query(USER_WITH_ORG + ' where u.id=$1 and u.email=$2', [String(req.body.user_id || ''), req.user.email])).rows[0];
  if (!target || !target.active) throw new HttpError(404, 'You do not have access to that business.');
  if (target.id === req.user.id) return res.json({ token: sign(req.user, req.user.sid), user: await sessionUser(req.user) });
  const block = accessBlock(target);
  if (block) throw new HttpError(403, block.error);      // no code: it must not turn the current screen into the blocked page
  const sid = await startSession(req, target, { switching: true });
  await logActivity(req, 'login.switched', `Switched to ${target.org_name}`, { to: target.org_id });
  await logActivity(req, 'login.success', `Opened this business from ${req.user.org_name} (${deviceOf(req.get('user-agent'))})`, {}, target);
  await db.query('update users set last_login_at=now() where id=$1', [target.id]);
  res.json({ token: sign(target, sid), user: await sessionUser(target) });
}));

// ends this sign-in for good (the token stops working at once)
authRouter.post('/logout', requireAuth, wrap(async (req, res) => {
  await db.query(`update sessions set revoked_at=now(), revoked_why='logout' where id=$1 and revoked_at is null`, [req.user.sid]);
  await logActivity(req, 'login.logout', 'Logged out');
  res.json({ ok: true });
}));

// ---------- business details ----------
export const orgRouter = Router();
orgRouter.use(requireAuth);

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// the business profile: name and GST state, plus address, GSTIN, phone and contact email (all optional except name and state)
orgRouter.patch('/', requireRole('owner'), wrap(async (req, res) => {
  const b = req.body, u = req.user;
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const name = b.name === undefined ? u.org_name : text(b.name, 150);
  const state = b.state_code === undefined ? u.org_state : String(b.state_code);
  const address = b.address === undefined ? u.org_address || '' : text(b.address, 300);
  const gstin = b.gstin === undefined ? u.org_gstin || '' : text(b.gstin, 15).toUpperCase();
  const phone = b.phone === undefined ? u.org_phone || '' : text(b.phone, 20);
  const contact = b.contact_email === undefined ? u.org_contact_email || '' : text(b.contact_email, 254).toLowerCase();
  if (!name) throw new HttpError(400, 'Please enter your business name.');
  checkState(state);
  if (gstin && !GSTIN.test(gstin)) throw new HttpError(400, 'The GSTIN should be 15 letters and digits, like 27ABCDE1234F1Z5.');
  if (gstin && gstin.slice(0, 2) !== state) throw new HttpError(400, `This GSTIN starts with ${gstin.slice(0, 2)} (${STATE_NAME[gstin.slice(0, 2)] || 'unknown state'}), but the GST state is ${STATE_NAME[state]}. Please check both.`);
  if (phone && !/^[0-9+\-() ]{6,20}$/.test(phone)) throw new HttpError(400, 'Please enter a valid phone number.');
  if (contact && !isEmail(contact)) throw new HttpError(400, 'Please enter a valid contact email.');
  await db.query('update organizations set name=$1, state_code=$2, address=$3, gstin=$4, phone=$5, contact_email=$6 where id=$7',
    [name, state, address || null, gstin || null, phone || null, contact || null, u.org_id]);
  const changes = [];
  if (name !== u.org_name) changes.push(`name from "${u.org_name}" to "${name}"`);
  if (state !== u.org_state) changes.push(`state from ${STATE_NAME[u.org_state] || 'not set'} to ${STATE_NAME[state]}`);
  if (address !== (u.org_address || '') || gstin !== (u.org_gstin || '') || phone !== (u.org_phone || '') || contact !== (u.org_contact_email || '')) changes.push('profile details');
  if (changes.length) await logActivity(req, 'business.updated', 'Changed business ' + changes.join(' and '), { name, state_code: state });
  const next = { ...u, org_name: name, org_state: state, org_address: address, org_gstin: gstin, org_phone: phone, org_contact_email: contact };
  res.json({ user: await sessionUser(next) });
}));

// ---------- team management ----------
export const usersRouter = Router();
usersRouter.use(requireAuth);
usersRouter.param('id', uuidParam);

usersRouter.get('/', requireRole('admin'), wrap(async (req, res) => {
  const users = (await db.query(
    `select u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login_at, u.last_seen_at,
       (select s.user_agent from sessions s where s.user_id=u.id and s.revoked_at is null and s.last_seen_at > now() - ($2 || ' hours')::interval
          order by s.last_seen_at desc limit 1) device
     from users u where u.org_id=$1 order by u.created_at`, [req.user.org_id, String(IDLE_HOURS)])).rows;
  for (const u of users) { u.signed_in = u.device != null; u.device = u.device != null ? deviceOf(u.device) : null; }
  const invites = (await db.query(`select id, email, role, created_at from invites where org_id=$1 order by created_at`, [req.user.org_id])).rows;
  res.json({ users, invites, seats: await seatInfo(req.user.org_id) });
}));

function canAssign(actor, role) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role.');
  if ((role === 'owner' || role === 'admin') && actor.role !== 'owner') throw new HttpError(403, 'Only the Owner can give Admin or Owner access.');
}
async function checkSeat(orgId) {
  const s = await seatInfo(orgId);
  if (s.used >= s.max) {
    throw new HttpError(403, `Your plan has ${s.max} people (1 Owner + ${s.max - 1} users) and all of them are in use. ` +
      `Each extra person is ₹${s.extra_price.toLocaleString('en-IN')} a year.${supportText()} to add more.`, { code: 'seat_limit' });
  }
}

usersRouter.post('/invite', requireRole('admin'), wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const role = req.body.role || 'viewer';
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  canAssign(req.user, role);
  if ((await db.query('select 1 from users where org_id=$1 and email=$2', [req.user.org_id, email])).rows.length) throw new HttpError(409, 'This person is already in your business.');
  // someone who already uses Reportly (in another business) keeps their login and password: they are added straight away
  // and will see this business in their business switcher
  const known = (await db.query('select name, password_hash from users where email=$1 order by last_login_at desc nulls last limit 1', [email])).rows[0];
  if (known) {
    await checkSeat(req.user.org_id);
    await db.tx(async t => {
      await t.query('insert into users (org_id, email, name, password_hash, role) values ($1,$2,$3,$4,$5)', [req.user.org_id, email, known.name, known.password_hash, role]);
      await t.query('delete from invites where org_id=$1 and email=$2', [req.user.org_id, email]);
    });
    await logActivity(req, 'team.added', `Added ${known.name} (${email}) as ${ROLE_LABEL[role]}: they already use Reportly, so they can open this business from their business switcher`, { email, role });
    const emailed = await notifyAdded(email, { orgName: req.user.org_name, role, byName: req.user.name, existing: true });
    return res.json({ ok: true, added_existing: true, emailed, name: known.name, seats: await seatInfo(req.user.org_id) });
  }
  const already = (await db.query('select 1 from invites where org_id=$1 and email=$2', [req.user.org_id, email])).rows.length;
  if (!already) await checkSeat(req.user.org_id);      // changing the access of someone already added takes no extra seat
  await db.query(
    `insert into invites (org_id, email, role, invited_by) values ($1,$2,$3,$4)
     on conflict (org_id, email) do update set role=excluded.role`, [req.user.org_id, email, role, req.user.id]);
  await logActivity(req, 'team.invited', `Added ${email} as ${ROLE_LABEL[role]}`, { email, role });
  const emailed = await notifyAdded(email, { orgName: req.user.org_name, role, byName: req.user.name, existing: false });
  res.json({ ok: true, emailed, seats: await seatInfo(req.user.org_id) });
}));

usersRouter.delete('/invite/:id', requireRole('admin'), wrap(async (req, res) => {
  const gone = (await db.query('delete from invites where id=$1 and org_id=$2 returning email', [req.params.id, req.user.org_id])).rows[0];
  if (gone) await logActivity(req, 'team.invite_removed', `Removed the invite for ${gone.email}`, { email: gone.email });
  res.json({ ok: true });
}));

async function targetUser(req) {
  const target = (await db.query('select * from users where id=$1 and org_id=$2', [req.params.id, req.user.org_id])).rows[0];
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only the Owner can change another Owner.');
  return target;
}

usersRouter.patch('/:id', requireRole('admin'), wrap(async (req, res) => {
  const target = await targetUser(req);
  if (target.id === req.user.id) throw new HttpError(400, 'You cannot change your own access.');
  if (req.body.role) canAssign(req.user, req.body.role);
  if (target.role === 'owner' && (req.body.role && req.body.role !== 'owner' || req.body.active === false)) {
    const owners = (await db.query(`select count(*)::int n from users where org_id=$1 and role='owner' and active`, [req.user.org_id])).rows[0].n;
    if (owners <= 1) throw new HttpError(400, 'There must always be at least one Owner.');
  }
  if (req.body.active === true && !target.active) await checkSeat(req.user.org_id);
  await db.query('update users set role=coalesce($1, role), active=coalesce($2, active) where id=$3',
    [req.body.role ?? null, typeof req.body.active === 'boolean' ? req.body.active : null, target.id]);
  if (req.body.active === false) await revokeUserSessions(target.id, 'access_off');
  const who = `${target.name} (${target.email})`;
  if (req.body.role && req.body.role !== target.role) {
    await logActivity(req, 'team.access_changed', `Changed access of ${who} from ${ROLE_LABEL[target.role]} to ${ROLE_LABEL[req.body.role]}`,
      { user_id: target.id, from: target.role, to: req.body.role });
  }
  if (typeof req.body.active === 'boolean' && req.body.active !== target.active) {
    await logActivity(req, req.body.active ? 'team.turned_on' : 'team.turned_off',
      req.body.active ? `Turned on ${who}: they can log in again` : `Turned off ${who}: they can no longer log in`, { user_id: target.id });
  }
  res.json({ ok: true });
}));

// signs a person out of their device, so they can log in on another one
usersRouter.post('/:id/signout', requireRole('admin'), wrap(async (req, res) => {
  const target = await targetUser(req);
  await revokeUserSessions(target.id, target.id === req.user.id ? 'logout' : 'admin');
  await logActivity(req, 'team.signed_out', `Signed ${target.name} (${target.email}) out of their device`, { user_id: target.id });
  res.json({ ok: true });
}));
