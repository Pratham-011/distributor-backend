// Requests from customers: another business, more people, help, a bug. Saved, emailed to the support inbox
// (REQUEST_TO, with REQUEST_CC copied) and shown to the platform admin under Requests.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { requireAuth, ROLE_LABEL, hasRole } from '../auth.js';
import { HttpError, wrap } from '../http.js';
import { logActivity } from '../activity.js';
import { sendMail, mailReady } from '../mail.js';
import { REQUEST_TO, REQUEST_CC } from '../contact.js';
import { STATE_NAME } from '../states.js';

export const KINDS = {
  add_business: 'Add another business',
  add_user: 'Add more people',
  support: 'Help / support',
  bug: 'Report a problem',
  other: 'Something else',
};
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

const limit = rateLimit({
  windowMs: 3600000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_DISABLED === '1',
  handler: (_req, res) => res.status(429).json({ error: 'You have sent many requests in the last hour. Please wait a little, or call us.' }),
});

export const requestsRouter = Router();
requestsRouter.use(requireAuth);

/** The part of the request that depends on its kind. Throws a friendly error when something is missing. */
function details(kind, user, b) {
  const p = b.payload || {};
  if (kind === 'add_business') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the Owner can ask for another business.');
    const business_name = clip(p.business_name, 150);
    if (!business_name) throw new HttpError(400, 'Please enter the name of the new business.');
    const state_code = clip(p.state_code, 2);
    if (!STATE_NAME[state_code]) throw new HttpError(400, 'Please choose the GST state of the new business.');
    const login = p.login === 'new' ? 'new' : 'same';
    const out = { business_name, state_code, login };
    if (login === 'new') {
      out.owner_name = clip(p.owner_name, 100); out.owner_email = clip(p.owner_email, 254).toLowerCase();
      if (!out.owner_name || !isEmail(out.owner_email)) throw new HttpError(400, 'For a new login, please enter the name and email of the person who will run the new business.');
    }
    return { payload: out, subject: `Add business: ${business_name}` };
  }
  if (kind === 'add_user') {
    if (!hasRole(user, 'admin')) throw new HttpError(403, 'Only an Owner or Admin can ask for more people.');
    const how_many = Math.floor(Number(p.how_many));
    if (!(how_many >= 1 && how_many <= 100)) throw new HttpError(400, 'Please enter how many more people you need (1 to 100).');
    return { payload: { how_many }, subject: `Add ${how_many} more ${how_many === 1 ? 'person' : 'people'}` };
  }
  const message = clip(b.message, 4000);
  if (message.length < 5) throw new HttpError(400, 'Please tell us a little more.');
  return { payload: {}, subject: clip(b.subject, 150) || `${KINDS[kind]}: ${message.slice(0, 60)}` };
}

function mailText(r, user, org) {
  const lines = [
    `New request from Reportly: ${KINDS[r.kind]}`, '',
    `Business: ${user.org_name}${org.parent ? ` (extra company of ${org.parent})` : ''}`,
    `From: ${user.name} <${user.email}> (${ROLE_LABEL[user.role]})`,
    org.phone ? `Business phone: ${org.phone}` : null,
    `Plan: ${org.plan || 'none'}${org.paid_until ? `, until ${org.paid_until}` : ''}`, '',
    `Subject: ${r.subject}`,
  ].filter(x => x !== null);
  for (const [k, v] of Object.entries(r.payload)) lines.push(`${k.replace(/_/g, ' ')}: ${k === 'state_code' ? (STATE_NAME[v] || v) : v}`);
  if (r.message) lines.push('', r.message);
  lines.push('', `Reply to this email to answer ${user.name}, or open Platform admin → Requests to handle it. Request id: ${r.id}`);
  return lines.join('\n');
}

requestsRouter.post('/', limit, wrap(async (req, res) => {
  const kind = Object.keys(KINDS).includes(req.body.kind) ? req.body.kind : null;
  if (!kind) throw new HttpError(400, 'Please choose what you need.');
  const { payload, subject } = details(kind, req.user, req.body);
  const message = clip(req.body.message, 4000);
  const r = (await db.query(
    `insert into requests (org_id, user_id, kind, subject, message, payload) values ($1,$2,$3,$4,$5,$6) returning id, kind, subject, message, payload, created_at`,
    [req.user.org_id, req.user.id, kind, subject, message, JSON.stringify(payload)])).rows[0];
  const org = (await db.query(
    `select o.plan_name plan, o.paid_until::text paid_until, o.phone, p.name parent from organizations o left join organizations p on p.id=o.parent_org_id where o.id=$1`, [req.user.org_id])).rows[0] || {};
  let emailed = false;
  if (mailReady) {
    try { await sendMail(REQUEST_TO, `[Reportly] ${KINDS[kind]} - ${req.user.org_name}`, mailText(r, req.user, org), { cc: REQUEST_CC, replyTo: req.user.email }); emailed = true; }
    catch (e) { console.error('[request] could not email request', r.id, e.message); }
  } else console.warn(`[request] email is not set up; request ${r.id} (${kind}) from ${req.user.email} is only saved`);
  if (emailed) await db.query('update requests set emailed=true where id=$1', [r.id]);
  await logActivity(req, 'request.sent', `Sent a request: ${subject}`, { request_id: r.id, kind });
  res.json({ ok: true, id: r.id, emailed });
}));

// Owners and Admins see every request of the business; everyone else sees their own
requestsRouter.get('/', wrap(async (req, res) => {
  const all = hasRole(req.user, 'admin');
  const rows = (await db.query(
    `select r.id, r.kind, r.subject, r.message, r.payload, r.status, r.admin_note, r.created_at, r.updated_at, u.name requested_by
     from requests r left join users u on u.id=r.user_id where r.org_id=$1 ${all ? '' : 'and r.user_id=$2'} order by r.created_at desc limit 50`,
    all ? [req.user.org_id] : [req.user.org_id, req.user.id])).rows;
  res.json({ requests: rows, kinds: KINDS });
}));
