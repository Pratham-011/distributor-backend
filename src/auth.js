import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { db } from './db.js';
import { HttpError, wrap } from './http.js';
import { logActivity } from './activity.js';
import { STATE_NAME } from './states.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}
export const OTP_DEMO = (process.env.OTP_DEMO ?? 'true') === 'true';
const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

export const ROLES = ['viewer', 'writer', 'admin', 'owner'];
export const ROLE_LABEL = { viewer: 'Viewer', writer: 'Uploader', admin: 'Admin', owner: 'Owner' };
const rank = r => ROLES.indexOf(r);
export const hasRole = (user, min) => rank(user.role) >= rank(min);

const normEmail = e => String(e || '').trim().toLowerCase();
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const hashCode = c => crypto.createHash('sha256').update(String(c)).digest('hex');

function checkPassword(p) {
  if (!p || String(p).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
}

// Sessions last 30 days and are renewed each time the app is opened (GET /auth/me), so a device
// that is used at least once a month stays logged in. Changing the password ends all old sessions.
const SESSION = '30d';
const passwordStamp = u => crypto.createHash('sha256').update(u.password_hash).digest('hex').slice(0, 16);
function sign(user) {
  return jwt.sign({ sub: user.id, org: user.org_id, pv: passwordStamp(user) }, JWT_SECRET, { expiresIn: SESSION });
}

// ---- platform: who runs the software, and whether a business may use it today ----
// PLATFORM_ADMIN_EMAILS: comma-separated emails of the people who run this software (the Platform admin page).
export const PLATFORM_ADMINS = (process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
export const isPlatformAdmin = u => !!u && PLATFORM_ADMINS.includes(String(u.email).toLowerCase());
// shown to a business whose portal is paused or whose subscription ended, e.g. "98200 00000 / support@yourbrand.in"
const SUPPORT = process.env.SUPPORT_CONTACT || '';
// subscriptions run to the end of the "paid until" day in India
export const todayIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** null when the business may use the app today; otherwise the reason (shown to its users). */
export function accessBlock(u) {
  if (isPlatformAdmin(u)) return null;
  const contact = SUPPORT ? ` Please contact ${SUPPORT}` : ' Please contact your software provider';
  if (u.org_status === 'paused') {
    return { code: 'account_paused', error: `The portal for ${u.org_name} is paused${u.org_status_reason ? ` (${u.org_status_reason})` : ''}.${contact}.` };
  }
  if (u.org_auto_off && u.org_paid_until && u.org_paid_until < todayIndia()) {
    return { code: 'account_expired', error: `The subscription for ${u.org_name} ended on ${dayText(u.org_paid_until)}.${contact} to renew.` };
  }
  return null;
}

// u must carry the org_* fields from USER_WITH_ORG
function publicUser(u) {
  const sub = u.org_paid_until ? { paid_until: u.org_paid_until, days_left: daysBetween(todayIndia(), u.org_paid_until), auto_off: u.org_auto_off } : null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, org_id: u.org_id, org_name: u.org_name, state_code: u.org_state || null,
    platform_admin: isPlatformAdmin(u), subscription: sub };
}
const USER_WITH_ORG = `select u.*, o.name org_name, o.state_code org_state, o.status org_status, o.status_reason org_status_reason,
  o.paid_until::text org_paid_until, o.auto_off org_auto_off from users u join organizations o on o.id=u.org_id`;

// Usage: each 5-minute window in which someone does anything counts once (about 5 minutes of use).
const lastWindow = new Map();
function trackUse(u) {
  const w = Math.floor(Date.now() / 300000);
  if (lastWindow.get(u.id) === w) return;
  lastWindow.set(u.id, w);
  db.query(`insert into usage_blocks (user_id, org_id, day, blocks) values ($1,$2,$3,1)
    on conflict (user_id, day) do update set blocks = usage_blocks.blocks + 1`, [u.id, u.org_id, todayIndia()]).catch(() => {});
  db.query('update users set last_seen_at=now() where id=$1', [u.id]).catch(() => {});
}
const checkState = code => {
  if (!STATE_NAME[code]) throw new HttpError(400, 'Please choose the state where your business is registered for GST.');
};

/** Sends the OTP. In demo mode the code is returned to the browser and printed in the server log. */
async function issueOtp(email, purpose, payload) {
  const recent = await db.query(
    `select count(*)::int n from otps where email=$1 and created_at > now() - interval '10 minutes'`, [email]);
  if (recent.rows[0].n >= 5) throw new HttpError(429, 'Too many codes requested. Please wait 10 minutes.');
  const code = String(crypto.randomInt(100000, 1000000));
  await db.query(`update otps set used_at=now() where email=$1 and purpose=$2 and used_at is null`, [email, purpose]);
  await db.query(
    `insert into otps (email, purpose, code_hash, payload, expires_at)
     values ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`,
    [email, purpose, hashCode(code), JSON.stringify(payload), String(OTP_MINUTES)]);
  // Production: send `code` by email here (Resend, SES, SMTP...).
  console.log(`[OTP] ${purpose} code for ${email}: ${code}`);
  return OTP_DEMO ? { demo_code: code } : {};
}

async function consumeOtp(email, purpose, code) {
  const r = await db.query(
    `select * from otps where email=$1 and purpose=$2 and used_at is null and expires_at > now()
     order by created_at desc limit 1`, [email, purpose]);
  const otp = r.rows[0];
  if (!otp) throw new HttpError(400, 'This code has expired. Please ask for a new code.');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(400, 'Too many wrong tries. Please ask for a new code.');
  if (otp.code_hash !== hashCode(String(code || '').trim())) {
    await db.query(`update otps set attempts = attempts + 1 where id=$1`, [otp.id]);
    throw new HttpError(400, 'Wrong code. Please check and try again.');
  }
  await db.query(`update otps set used_at=now() where id=$1`, [otp.id]);
  return otp.payload;
}

export const authRouter = Router();

// Step 1 of sign-up: details + password -> OTP sent
authRouter.post('/register', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const name = String(req.body.name || '').trim();
  const business = String(req.body.business_name || '').trim();
  const state_code = String(req.body.state_code || '').trim();
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!name) throw new HttpError(400, 'Please enter your name.');
  checkPassword(req.body.password);
  const exists = await db.query('select 1 from users where email=$1', [email]);
  if (exists.rows.length) throw new HttpError(409, 'This email already has an account. Please log in.');
  const invite = (await db.query('select i.*, o.name org_name from invites i join organizations o on o.id=i.org_id where email=$1 order by i.created_at desc limit 1', [email])).rows[0];
  if (!invite) {
    if (!business) throw new HttpError(400, 'Please enter your business name.');
    checkState(state_code);
  }
  const password_hash = await bcrypt.hash(String(req.body.password), 10);
  const extra = await issueOtp(email, 'register', { name, business, state_code, password_hash });
  res.json({ ok: true, email, joining: invite ? invite.org_name : null, ...extra });
}));

// Step 2 of sign-up: OTP -> account created and logged in
authRouter.post('/verify', wrap(async (req, res) => {
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
      orgId = (await t.query('insert into organizations (name, state_code) values ($1,$2) returning id',
        [payload.business, payload.state_code || null])).rows[0].id;
      role = 'owner'; newBusiness = true;
    }
    return (await t.query(
      `insert into users (org_id, email, name, password_hash, role, last_login_at) values ($1,$2,$3,$4,$5, now()) returning *`,
      [orgId, email, payload.name, payload.password_hash, role])).rows[0];
  });
  const u = (await db.query(USER_WITH_ORG + ' where u.id=$1', [user.id])).rows[0];
  if (newBusiness) {
    await logActivity(req, 'account.created', `Created the business account "${u.org_name}" (${STATE_NAME[u.org_state] || 'no state'})`, {}, u);
  } else {
    await logActivity(req, 'account.joined', `Joined as ${ROLE_LABEL[u.role]}`, { email }, u);
  }
  res.json({ token: sign(u), user: publicUser(u) });
}));

authRouter.post('/login', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const u = (await db.query(USER_WITH_ORG + ' where email=$1', [email])).rows[0];
  const ok = u && await bcrypt.compare(String(req.body.password || ''), u.password_hash);
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
  await db.query('update users set last_login_at=now() where id=$1', [u.id]);
  await logActivity(req, 'login.success', 'Logged in', {}, u);
  res.json({ token: sign(u), user: publicUser(u) });
}));

authRouter.post('/forgot', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const u = (await db.query('select id from users where email=$1 and active', [email])).rows[0];
  // Same answer whether or not the account exists, so emails can't be probed.
  const extra = u ? await issueOtp(email, 'reset', {}) : {};
  res.json({ ok: true, ...extra });
}));

authRouter.post('/reset', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  checkPassword(req.body.password);
  await consumeOtp(email, 'reset', req.body.code);
  const hash = await bcrypt.hash(String(req.body.password), 10);
  const u = (await db.query('update users set password_hash=$1 where email=$2 returning id, org_id, name', [hash, email])).rows[0];
  if (u) await logActivity(req, 'login.password_reset', 'Changed their password using an email code', {}, u);
  res.json({ ok: true });
}));

// ---- middleware ----
export const requireAuth = wrap(async (req, _res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET); } catch { throw new HttpError(401, 'Your login has expired. Please log in again.'); }
  // role is re-read from the DB on every request, so a role change applies immediately
  const u = (await db.query(USER_WITH_ORG + ' where u.id=$1', [claims.sub])).rows[0];
  if (!u || !u.active) throw new HttpError(401, 'Please log in.');
  if (claims.pv && claims.pv !== passwordStamp(u)) throw new HttpError(401, 'Your password was changed. Please log in again.');
  const block = accessBlock(u);
  if (block) throw new HttpError(403, block.error, { code: block.code });
  u.platform_admin = isPlatformAdmin(u);
  req.user = u;
  trackUse(u);
  next();
});

export const requireRole = min => (req, _res, next) => {
  if (rank(req.user.role) < rank(min)) return next(new HttpError(403, `Only ${ROLE_LABEL[min]} or above can do this.`));
  next();
};

// also hands back a fresh token, which keeps the session going for another 30 days
authRouter.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), token: sign(req.user) }));

// the token simply expires; this is only so the log shows when someone logged out
authRouter.post('/logout', requireAuth, wrap(async (req, res) => {
  await logActivity(req, 'login.logout', 'Logged out');
  res.json({ ok: true });
}));

// ---- business details ----
export const orgRouter = Router();
orgRouter.use(requireAuth);

orgRouter.patch('/', requireRole('owner'), wrap(async (req, res) => {
  const name = req.body.name === undefined ? req.user.org_name : String(req.body.name).trim();
  const state = req.body.state_code === undefined ? req.user.org_state : String(req.body.state_code);
  if (!name) throw new HttpError(400, 'Please enter your business name.');
  checkState(state);
  await db.query('update organizations set name=$1, state_code=$2 where id=$3', [name, state, req.user.org_id]);
  const changes = [];
  if (name !== req.user.org_name) changes.push(`name from "${req.user.org_name}" to "${name}"`);
  if (state !== req.user.org_state) changes.push(`state from ${STATE_NAME[req.user.org_state] || 'not set'} to ${STATE_NAME[state]}`);
  if (changes.length) await logActivity(req, 'business.updated', 'Changed business ' + changes.join(' and '), { name, state_code: state });
  res.json({ user: publicUser({ ...req.user, org_name: name, org_state: state }) });
}));

// ---- team management ----
export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get('/', requireRole('admin'), wrap(async (req, res) => {
  const users = (await db.query(
    `select id, email, name, role, active, created_at, last_login_at from users where org_id=$1 order by created_at`, [req.user.org_id])).rows;
  const invites = (await db.query(`select id, email, role, created_at from invites where org_id=$1 order by created_at`, [req.user.org_id])).rows;
  res.json({ users, invites });
}));

function canAssign(actor, role) {
  if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role.');
  if ((role === 'owner' || role === 'admin') && actor.role !== 'owner') throw new HttpError(403, 'Only the Owner can give Admin or Owner access.');
}

usersRouter.post('/invite', requireRole('admin'), wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const role = req.body.role || 'viewer';
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  canAssign(req.user, role);
  if ((await db.query('select 1 from users where email=$1', [email])).rows.length) throw new HttpError(409, 'This person already has an account.');
  await db.query(
    `insert into invites (org_id, email, role, invited_by) values ($1,$2,$3,$4)
     on conflict (org_id, email) do update set role=excluded.role`, [req.user.org_id, email, role, req.user.id]);
  await logActivity(req, 'team.invited', `Added ${email} as ${ROLE_LABEL[role]}`, { email, role });
  res.json({ ok: true });
}));

usersRouter.delete('/invite/:id', requireRole('admin'), wrap(async (req, res) => {
  const gone = (await db.query('delete from invites where id=$1 and org_id=$2 returning email', [req.params.id, req.user.org_id])).rows[0];
  if (gone) await logActivity(req, 'team.invite_removed', `Removed the invite for ${gone.email}`, { email: gone.email });
  res.json({ ok: true });
}));

usersRouter.patch('/:id', requireRole('admin'), wrap(async (req, res) => {
  const target = (await db.query('select * from users where id=$1 and org_id=$2', [req.params.id, req.user.org_id])).rows[0];
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.id === req.user.id) throw new HttpError(400, 'You cannot change your own access.');
  if (target.role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'Only the Owner can change another Owner.');
  if (req.body.role) canAssign(req.user, req.body.role);
  if (target.role === 'owner' && (req.body.role && req.body.role !== 'owner' || req.body.active === false)) {
    const owners = (await db.query(`select count(*)::int n from users where org_id=$1 and role='owner' and active`, [req.user.org_id])).rows[0].n;
    if (owners <= 1) throw new HttpError(400, 'There must always be at least one Owner.');
  }
  await db.query('update users set role=coalesce($1, role), active=coalesce($2, active) where id=$3',
    [req.body.role ?? null, typeof req.body.active === 'boolean' ? req.body.active : null, target.id]);
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
