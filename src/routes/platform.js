// Platform admin: for the people who run this software (PLATFORM_ADMIN_EMAILS), not for the businesses using it.
// Every business with its data size, users, use and activity; subscription, seats, linked companies; pause / resume;
// payments, expenses and profit; the pricing rules.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, todayIndia, revokeUserSessions, deviceOf, notifyAdded } from '../auth.js';
import { HttpError, wrap } from '../http.js';
import { logActivity } from '../activity.js';
import { getSettings, saveSettings, DEFAULTS } from '../settings.js';
import { STATE_NAME } from '../states.js';
import { KINDS } from './requests.js';
import { removeFile } from '../storage.js';

export const platformRouter = Router();
platformRouter.use(requireAuth, (req, _res, next) => next(req.user.platform_admin ? undefined : new HttpError(403, 'Only the platform admin can open this page.')));

const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;
export const PERIOD_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const ONLINE_MIN = 5;
const IDLE_HOURS = Number(process.env.SESSION_IDLE_HOURS) || 8;
// tables that hold a business's data; size per business = the exact stored size of its rows
const DATA_TABLES = ['doc_lines', 'receipts', 'outstanding_bills', 'stock_items', 'uploads', 'mapping_templates', 'activity_log', 'usage_blocks', 'org_payments', 'sessions', 'settled_bills'];
const PAYMENT_KINDS = ['setup', 'subscription', 'extra_user', 'extra_company', 'other'];
const EXPENSE_CATEGORIES = ['hosting', 'database', 'domain', 'email', 'support', 'marketing', 'tools', 'salary', 'other'];

const id = req => { if (!UUID.test(req.params.id || '')) throw new HttpError(400, 'Bad business reference.'); return req.params.id; };
const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const clean = v => (v === '' || v === undefined ? null : v);
const money = (v, what) => { const n = Number(v); if (!(n >= 0) || n > 1e9) throw new HttpError(400, `Please enter ${what} as a number.`); return n.toFixed(2); };
const text = (v, max) => (clean(v) === null ? null : String(v).trim().slice(0, max));

/** active | paused | expired | overdue | expiring (7 days) | no_plan | trial */
function stateOf(o, today) {
  if (o.status === 'paused') return 'paused';
  if (!o.paid_until) return 'no_plan';
  if (o.paid_until < today) return o.auto_off ? 'expired' : 'overdue';
  if (o.trial) return 'trial';
  return daysBetween(today, o.paid_until) <= 7 ? 'expiring' : 'active';
}

/** Exact rows and bytes each business holds, per table: pg_column_size is the real stored size of every row (nothing is averaged). */
async function rowStats(orgId) {
  const where = orgId ? 'where t.org_id=$1' : '';
  const out = {};
  for (const t of DATA_TABLES) {
    for (const r of await q(`select t.org_id, count(*)::int n, coalesce(sum(pg_column_size(t.*)), 0)::bigint b from ${t} t ${where} group by t.org_id`, orgId ? [orgId] : []))
      (out[r.org_id] ||= {})[t] = { n: r.n, b: Number(r.b) };
  }
  return out;
}

// ---------------------------------------------------------------- businesses
platformRouter.get('/orgs', wrap(async (_req, res) => {
  const today = todayIndia(), since = addDays(today, -29);
  const [orgs, users, invites, use, files, counts, settings] = await Promise.all([
    q(`select id, name, state_code, created_at, status, status_reason, plan_name, plan_price, billing_period, setup_fee, extra_users, parent_org_id, trial,
         period_start::text period_start, paid_until::text paid_until, auto_off from organizations order by created_at`),
    q(`select org_id, count(*)::int users, count(*) filter (where active)::int active_users,
         count(*) filter (where last_seen_at > now() - interval '30 days')::int used_30, max(coalesce(last_seen_at, last_login_at)) last_seen from users group by org_id`),
    q(`select org_id, count(*)::int n from invites group by org_id`),
    q(`select org_id, coalesce(sum(blocks),0)::int blocks, count(distinct day)::int days from usage_blocks where day >= $1 group by org_id`, [since]),
    q(`select org_id, count(*)::int uploads, coalesce(sum(stored_bytes),0)::bigint stored, max(created_at) last_upload from uploads where status <> 'deleted' group by org_id`),
    rowStats(), getSettings(),
  ]);
  const online = await q(`select org_id, count(distinct user_id)::int n from sessions where revoked_at is null and last_seen_at > now() - ($1 || ' minutes')::interval group by org_id`, [String(ONLINE_MIN)]);
  const by = (list, k = 'org_id') => Object.fromEntries(list.map(x => [x[k], x]));
  const U = by(users), S = by(use), F = by(files), I = by(invites), O = by(online), names = Object.fromEntries(orgs.map(o => [o.id, o.name]));
  const list = orgs.map(o => {
    const c = counts[o.id] || {};
    const dbBytes = Object.values(c).reduce((a, x) => a + x.b, 0);
    const max = 1 + settings.included_users + o.extra_users;
    return {
      ...o, state: stateOf(o, today), days_left: o.paid_until ? daysBetween(today, o.paid_until) : null, parent_name: names[o.parent_org_id] || null,
      users: U[o.id]?.users || 0, active_users: U[o.id]?.active_users || 0, used_30: U[o.id]?.used_30 || 0, last_seen: U[o.id]?.last_seen || null,
      invites: I[o.id]?.n || 0, seats_max: max, seats_used: (U[o.id]?.active_users || 0) + (I[o.id]?.n || 0), online: O[o.id]?.n || 0,
      minutes_30: (S[o.id]?.blocks || 0) * 5, days_used_30: S[o.id]?.days || 0,
      uploads: F[o.id]?.uploads || 0, last_upload: F[o.id]?.last_upload || null, file_bytes: Number(F[o.id]?.stored || 0),
      db_bytes: Math.round(dbBytes), rows: (c.doc_lines?.n || 0) + (c.receipts?.n || 0) + (c.outstanding_bills?.n || 0) + (c.stock_items?.n || 0),
    };
  });
  const monthly = o => (o.plan_price && PERIOD_MONTHS[o.billing_period] ? Number(o.plan_price) / PERIOD_MONTHS[o.billing_period] : 0);
  const db_total = Number((await one(`select pg_database_size(current_database())::bigint b`)).b);
  const on = o => !['paused', 'expired'].includes(o.state);
  res.json({
    today, settings, orgs: list,
    totals: {
      businesses: list.length, active: list.filter(o => ['active', 'expiring', 'no_plan', 'trial'].includes(o.state)).length,
      trial: list.filter(o => o.state === 'trial').length, paused: list.filter(o => o.state === 'paused').length, expired: list.filter(o => o.state === 'expired').length,
      expiring: list.filter(o => o.state === 'expiring').length, online: list.reduce((a, o) => a + o.online, 0),
      users: list.reduce((a, o) => a + o.users, 0), db_bytes: list.reduce((a, o) => a + o.db_bytes, 0), db_total_bytes: db_total, db_other_bytes: db_total - list.reduce((a, o) => a + o.db_bytes, 0), file_bytes: list.reduce((a, o) => a + o.file_bytes, 0),
      monthly_revenue: list.filter(on).reduce((a, o) => a + monthly(o), 0).toFixed(2),
    },
  });
}));

platformRouter.get('/orgs/:id', wrap(async (req, res) => {
  const orgId = id(req);
  const org = await one(`select id, name from organizations where id=$1`, [orgId]);
  if (!org) throw new HttpError(404, 'Business not found.');
  const today = todayIndia(), since = addDays(today, -29);
  const [users, payments, counts, daily, linked, sessions] = await Promise.all([
    q(`select u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at, u.last_seen_at,
         coalesce(sum(b.blocks) filter (where b.day >= $2), 0)::int * 5 minutes_30, count(b.day) filter (where b.day >= $2)::int days_30,
         coalesce(sum(b.blocks), 0)::int * 5 minutes_all,
         (select s.user_agent from sessions s where s.user_id=u.id and s.revoked_at is null and s.last_seen_at > now() - ($3 || ' hours')::interval order by s.last_seen_at desc limit 1) device,
         exists (select 1 from sessions s where s.user_id=u.id and s.revoked_at is null and s.last_seen_at > now() - ($4 || ' minutes')::interval) online
       from users u left join usage_blocks b on b.user_id = u.id where u.org_id=$1 group by u.id order by u.last_seen_at desc nulls last`,
    [orgId, since, String(IDLE_HOURS), String(ONLINE_MIN)]),
    q(`select id, paid_on::text paid_on, amount, kind, period_from::text period_from, period_to::text period_to, note, created_by from org_payments where org_id=$1 order by paid_on desc, created_at desc`, [orgId]),
    rowStats(orgId),
    q(`select day::text as day, sum(blocks)::int * 5 as minutes, count(*)::int as users from usage_blocks where org_id=$1 and day >= $2 group by day order by day`, [orgId, since]),
    q(`select id, name, status, paid_until::text paid_until from organizations where parent_org_id=$1 order by created_at`, [orgId]),
    q(`select s.id, u.name, u.email, s.created_at, s.last_seen_at, s.ip, s.user_agent, s.revoked_at, s.revoked_why from sessions s join users u on u.id=s.user_id
       where s.org_id=$1 order by s.created_at desc limit 40`, [orgId]),
  ]);
  for (const u of users) { u.signed_in = u.device != null; u.device = u.device != null ? deviceOf(u.device) : null; }
  for (const s of sessions) { s.device = deviceOf(s.user_agent); delete s.user_agent; }
  const LABEL = { doc_lines: 'Sales, purchase and note lines', receipts: 'Receipts', outstanding_bills: 'Outstanding bills', stock_items: 'Stock statement rows',
    uploads: 'Uploaded files (records)', mapping_templates: 'Saved file formats', activity_log: 'Activity log', usage_blocks: 'Usage records', org_payments: 'Payments', sessions: 'Sign-in records', settled_bills: 'Settled bills' };
  const c = counts[orgId] || {};
  const data = DATA_TABLES.map(t => ({ name: LABEL[t], rows: c[t]?.n || 0, bytes: c[t]?.b || 0 })).filter(x => x.rows);
  res.json({ users, payments, data, daily, linked, sessions });
}));

// what people did in this business (newest first), optionally one person or one kind of action
platformRouter.get('/orgs/:id/activity', wrap(async (req, res) => {
  const where = ['a.org_id=$1'], p = [id(req)];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
  if (Number(req.query.before) > 0) add('a.id < ?', Number(req.query.before));
  if (UUID.test(req.query.user || '')) add('a.user_id = ?', req.query.user);
  if (req.query.kind) add(`split_part(a.action, '.', 1) = ?`, String(req.query.kind).slice(0, 30));
  const rows = await q(`select a.id, a.created_at, a.user_name, a.action, a.message, a.ip from activity_log a where ${where.join(' and ')} order by a.id desc limit 101`, p);
  res.json({ entries: rows.slice(0, 100), more: rows.length > 100 });
}));

// latest activity across every business
platformRouter.get('/activity', wrap(async (req, res) => {
  const where = [], p = [];
  if (Number(req.query.before) > 0) { p.push(Number(req.query.before)); where.push(`a.id < $${p.length}`); }
  if (req.query.kind) { p.push(String(req.query.kind).slice(0, 30)); where.push(`split_part(a.action, '.', 1) = $${p.length}`); }
  const rows = await q(`select a.id, a.created_at, a.user_name, a.action, a.message, a.ip, o.name org_name, a.org_id
    from activity_log a join organizations o on o.id=a.org_id ${where.length ? 'where ' + where.join(' and ') : ''} order by a.id desc limit 101`, p);
  res.json({ entries: rows.slice(0, 100), more: rows.length > 100 });
}));

const platformActor = (req, orgId) => ({ org_id: orgId, id: null, name: `Platform admin (${req.user.email})` });

platformRouter.post('/orgs/:id/users/:uid/signout', wrap(async (req, res) => {
  const orgId = id(req);
  if (!UUID.test(req.params.uid)) throw new HttpError(400, 'Bad user reference.');
  const u = await one(`select id, name, email from users where id=$1 and org_id=$2`, [req.params.uid, orgId]);
  if (!u) throw new HttpError(404, 'User not found.');
  await revokeUserSessions(u.id, 'admin');
  await logActivity(req, 'team.signed_out', `Signed ${u.name} (${u.email}) out of their device (platform admin)`, { user_id: u.id }, platformActor(req, orgId));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- subscription, seats, companies
platformRouter.patch('/orgs/:id', wrap(async (req, res) => {
  const b = req.body;
  if (b.billing_period && !['monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'].includes(b.billing_period)) throw new HttpError(400, 'Unknown billing period.');
  for (const k of ['period_start', 'paid_until']) if (clean(b[k]) && !ISO.test(b[k])) throw new HttpError(400, 'Please enter dates as dates.');
  const extra = b.extra_users === undefined ? null : Math.floor(Number(b.extra_users));
  if (extra !== null && !(extra >= 0 && extra <= 1000)) throw new HttpError(400, 'Extra users must be a whole number.');
  const o = await one(`update organizations set plan_name=$2::text, plan_price=$3, billing_period=$4, setup_fee=$5, period_start=$6, paid_until=$7,
      auto_off=$8, billing_notes=$9, extra_users=coalesce($10, extra_users),
      trial = case when $2::text is not null and $2::text <> 'Trial' then false else trial end where id=$1 returning id, name`,
    [id(req), text(b.plan_name, 80), clean(b.plan_price) === null ? null : money(b.plan_price, 'the price'), clean(b.billing_period),
      clean(b.setup_fee) === null ? null : money(b.setup_fee, 'the setup fee'), clean(b.period_start), clean(b.paid_until), b.auto_off !== false, text(b.billing_notes, 500), extra]);
  if (!o) throw new HttpError(404, 'Business not found.');
  res.json({ ok: true });
}));

// Extends "paid until" by whole billing periods and records the payment
platformRouter.post('/orgs/:id/renew', wrap(async (req, res) => {
  const o = await one(`select * from organizations where id=$1`, [id(req)]);
  if (!o) throw new HttpError(404, 'Business not found.');
  const months = PERIOD_MONTHS[o.billing_period];
  if (!months) throw new HttpError(400, 'Set a billing period (monthly, quarterly, half-yearly or yearly) first, or set "paid until" by hand.');
  const periods = Math.max(1, Math.min(24, Math.floor(Number(req.body.periods) || 1)));
  const today = todayIndia();
  const paidUntil = o.paid_until ? String(o.paid_until).slice(0, 10) : null;
  const from = paidUntil && paidUntil >= today ? addDays(paidUntil, 1) : today;
  const until = addDays(addMonths(from, months * periods), -1);
  const amount = clean(req.body.amount) === null ? Number(o.plan_price || 0) * periods : Number(money(req.body.amount, 'the amount'));
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : today;
  await db.tx(async t => {
    await t.query(`update organizations set paid_until=$2, period_start=coalesce(period_start, $3), trial=false where id=$1`, [o.id, until, from]);
    await t.query(`insert into org_payments (org_id, paid_on, amount, kind, period_from, period_to, note, created_by) values ($1,$2,$3,'subscription',$4,$5,$6,$7)`,
      [o.id, paidOn, amount.toFixed(2), from, until, text(req.body.note, 200), req.user.email]);
  });
  await logActivity(req, 'business.renewed', `Subscription renewed: paid until ${until}`, { from, until, amount }, platformActor(req, o.id));
  res.json({ ok: true, paid_until: until, period_from: from });
}));

// Adds extra people to a business's plan (₹ per person from the pricing rules) and records the payment
// Gives more trial (or subscription) days: from today if it has already ended, otherwise from its end date
platformRouter.post('/orgs/:id/extend', wrap(async (req, res) => {
  const orgId = id(req);
  const days = Math.floor(Number(req.body.days));
  if (!(days >= 1 && days <= 365)) throw new HttpError(400, 'Please enter the number of days (1 to 365).');
  const o = await one('select paid_until::text paid_until, trial from organizations where id=$1', [orgId]);
  if (!o) throw new HttpError(404, 'Business not found.');
  const today = todayIndia();
  const from = o.paid_until && o.paid_until >= today ? o.paid_until : today;
  const until = addDays(from, days);
  // a business that was waiting to be switched on (TRIAL_DAYS=0) starts running when its first days are given
  await db.query(`update organizations set paid_until=$2, period_start=coalesce(period_start, $3),
      status=case when status='paused' and status_reason='Waiting to be switched on' then 'active' else status end,
      status_reason=case when status_reason='Waiting to be switched on' then null else status_reason end where id=$1`, [orgId, until, today]);
  await logActivity(req, 'business.extended', `${o.trial ? 'Trial' : 'Subscription'} extended by ${days} days: ends ${until}`, { days, until }, platformActor(req, orgId));
  res.json({ ok: true, paid_until: until });
}));

platformRouter.post('/orgs/:id/seats', wrap(async (req, res) => {
  const orgId = id(req);
  const add = Math.floor(Number(req.body.add));
  if (!(add >= 1 && add <= 100)) throw new HttpError(400, 'Please enter how many people to add.');
  const s = await getSettings();
  const amount = clean(req.body.amount) === null ? add * s.extra_user_price : Number(money(req.body.amount, 'the amount'));
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : todayIndia();
  const o = await db.tx(async t => {
    const r = (await t.query(`update organizations set extra_users = extra_users + $2 where id=$1 returning extra_users`, [orgId, add])).rows[0];
    if (!r) return null;
    if (req.body.record !== false) {
      await t.query(`insert into org_payments (org_id, paid_on, amount, kind, note, created_by) values ($1,$2,$3,'extra_user',$4,$5)`,
        [orgId, paidOn, amount.toFixed(2), text(req.body.note, 200) || `${add} extra user${add === 1 ? '' : 's'}`, req.user.email]);
    }
    return r;
  });
  if (!o) throw new HttpError(404, 'Business not found.');
  await logActivity(req, 'business.seats_added', `${add} extra user${add === 1 ? '' : 's'} added to the plan (${o.extra_users} extra in total)`, { add, amount }, platformActor(req, orgId));
  res.json({ ok: true, extra_users: o.extra_users });
}));

// Links a second company (its own login and data) to a customer; the extra-company charge is recorded on the customer
platformRouter.post('/orgs/:id/link-company', wrap(async (req, res) => {
  const orgId = id(req);
  const child = String(req.body.child_id || '');
  if (!UUID.test(child) || child === orgId) throw new HttpError(400, 'Please choose the other company.');
  const [parent, kid] = await Promise.all([one(`select id, name, parent_org_id from organizations where id=$1`, [orgId]), one(`select id, name, parent_org_id from organizations where id=$1`, [child])]);
  if (!parent || !kid) throw new HttpError(404, 'Business not found.');
  if (parent.parent_org_id) throw new HttpError(400, `${parent.name} is itself a linked company. Link to the main company instead.`);
  if (kid.parent_org_id) throw new HttpError(400, `${kid.name} is already linked to another company.`);
  const kids = await one(`select count(*)::int n from organizations where parent_org_id=$1`, [child]);
  if (kids.n) throw new HttpError(400, `${kid.name} already has linked companies of its own.`);
  const s = await getSettings();
  const amount = clean(req.body.amount) === null ? s.extra_company_price : Number(money(req.body.amount, 'the amount'));
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : todayIndia();
  await db.tx(async t => {
    await t.query(`update organizations set parent_org_id=$2 where id=$1`, [child, orgId]);
    if (req.body.record !== false) {
      await t.query(`insert into org_payments (org_id, paid_on, amount, kind, note, created_by) values ($1,$2,$3,'extra_company',$4,$5)`,
        [orgId, paidOn, amount.toFixed(2), text(req.body.note, 200) || `Extra company: ${kid.name}`, req.user.email]);
    }
  });
  await logActivity(req, 'business.company_linked', `${kid.name} linked as an extra company`, { child }, platformActor(req, orgId));
  res.json({ ok: true });
}));

platformRouter.delete('/orgs/:id/link-company/:child', wrap(async (req, res) => {
  if (!UUID.test(req.params.child)) throw new HttpError(400, 'Bad reference.');
  await db.query(`update organizations set parent_org_id=null where id=$1 and parent_org_id=$2`, [req.params.child, id(req)]);
  res.json({ ok: true });
}));

platformRouter.post('/orgs/:id/payments', wrap(async (req, res) => {
  const kind = PAYMENT_KINDS.includes(req.body.kind) ? req.body.kind : 'other';
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : todayIndia();
  const r = await one(`insert into org_payments (org_id, paid_on, amount, kind, note, created_by) select id, $2, $3, $4, $5, $6 from organizations where id=$1 returning id`,
    [id(req), paidOn, money(req.body.amount, 'the amount'), kind, text(req.body.note, 200), req.user.email]);
  if (!r) throw new HttpError(404, 'Business not found.');
  res.json({ ok: true });
}));

platformRouter.delete('/orgs/:id/payments/:pid', wrap(async (req, res) => {
  if (!UUID.test(req.params.pid)) throw new HttpError(400, 'Bad reference.');
  await db.query(`delete from org_payments where id=$1 and org_id=$2`, [req.params.pid, id(req)]);
  res.json({ ok: true });
}));

platformRouter.post('/orgs/:id/pause', wrap(async (req, res) => {
  const orgId = id(req);
  if (orgId === req.user.org_id) throw new HttpError(400, 'You cannot pause your own business here.');
  const reason = text(req.body.reason, 200);
  const o = await one(`update organizations set status='paused', status_reason=$2 where id=$1 returning id`, [orgId, reason]);
  if (!o) throw new HttpError(404, 'Business not found.');
  await logActivity(req, 'business.paused', `Portal paused by the platform admin${reason ? `: ${reason}` : ''}`, { reason }, platformActor(req, o.id));
  res.json({ ok: true });
}));

platformRouter.post('/orgs/:id/resume', wrap(async (req, res) => {
  const o = await one(`update organizations set status='active', status_reason=null where id=$1 returning id`, [id(req)]);
  if (!o) throw new HttpError(404, 'Business not found.');
  await logActivity(req, 'business.resumed', 'Portal turned back on by the platform admin', {}, platformActor(req, o.id));
  res.json({ ok: true });
}));

// Deletes a business for good: its people and sign-ins, every upload and its original file in storage, all report data,
// saved formats, payments, requests and its activity log. The admin must type the business name to confirm.
// Its extra companies are not deleted: they are only unlinked. A line about the deletion goes into the admin's own activity log.
platformRouter.delete('/orgs/:id', wrap(async (req, res) => {
  const orgId = id(req);
  if (orgId === req.user.org_id) throw new HttpError(400, 'You cannot delete your own business here.');
  const o = await one(`select id, name from organizations where id=$1`, [orgId]);
  if (!o) throw new HttpError(404, 'Business not found.');
  if (String(req.body?.confirm ?? '').trim() !== o.name.trim()) throw new HttpError(400, `To confirm, type the business name exactly: ${o.name}`);
  // with_companies: its extra companies are deleted too (the whole customer); otherwise they are only unlinked
  const kids = await q(`select id, name from organizations where parent_org_id=$1 order by name`, [orgId]);
  const withKids = req.body?.with_companies === true && kids.length > 0;
  if (withKids && kids.some(k => k.id === req.user.org_id)) throw new HttpError(400, 'Your own business is one of its extra companies, so it cannot be deleted this way.');
  const ids = [orgId, ...(withKids ? kids.map(k => k.id) : [])];
  const [counts, files, emails] = await Promise.all([
    one(`select (select count(*) from users where org_id = any($1::uuid[]))::int users, (select count(*) from uploads where org_id = any($1::uuid[]))::int uploads,
           (select count(*) from doc_lines where org_id = any($1::uuid[]))::int doc_lines, (select count(*) from org_payments where org_id = any($1::uuid[]))::int payments`, [ids]),
    q(`select storage_path from uploads where org_id = any($1::uuid[])`, [ids]),
    q(`select distinct email from users where org_id = any($1::uuid[])`, [ids]),
  ]);
  // original files first: if storage refuses, the database is left as it was and the delete can simply be tried again
  const failed = [];
  for (const f of files) { try { await removeFile(f.storage_path); } catch (e) { failed.push(e.message); } }
  if (failed.length) {
    console.error(`[delete business] ${orgId}: ${failed.length} file(s) could not be removed: ${failed[0]}`);
    throw new HttpError(502, `${failed.length} of ${files.length} stored file(s) could not be deleted, so nothing else was deleted. Please try again.`);
  }
  await db.tx(async t => {
    await t.query(`delete from organizations where id = any($1::uuid[])`, [ids]);     // everything else of these businesses goes with them (on delete cascade)
    // sign-up / reset codes of people who no longer belong to any business
    await t.query(`delete from otps where email = any($1::text[]) and not exists (select 1 from users u where u.email = otps.email)`, [emails.map(e => e.email)]);
  });
  const names = withKids ? `"${o.name}" with its extra companies ${kids.map(k => `"${k.name}"`).join(', ')}` : `"${o.name}"`;
  await logActivity(req, 'business.deleted',
    `Deleted the business ${names} and all the data: ${counts.users} people, ${counts.uploads} uploads (and their files), ${counts.doc_lines} bill lines, ${counts.payments} payments` +
      (!withKids && kids.length ? `. Its extra companies were unlinked, not deleted: ${kids.map(k => k.name).join(', ')}` : ''),
    { org_ids: ids, name: o.name, ...counts }, platformActor(req, req.user.org_id));
  res.json({ ok: true, deleted: { name: o.name, businesses: ids.length, ...counts, files: files.length },
    companies_deleted: withKids ? kids.map(k => k.name) : [], unlinked: withKids ? [] : kids.map(k => k.name) });
}));

// every payment from every business, newest first (the revenue side of the money tab)
platformRouter.get('/payments', wrap(async (_req, res) => {
  res.json({ payments: await q(`select p.id, p.paid_on::text paid_on, p.amount, p.kind, p.period_from::text period_from, p.period_to::text period_to, p.note, o.name org_name, o.id org_id
    from org_payments p join organizations o on o.id=p.org_id order by p.paid_on desc, p.created_at desc limit 2000`) });
}));

// ---------------------------------------------------------------- another business for a customer
// Creates the new business (own data, billed on the main company) and its Owner: the same login as an existing person,
// or a new person (invited by email, or the existing account when that email already has one).
platformRouter.post('/orgs/:id/new-company', wrap(async (req, res) => {
  const b = req.body || {};
  const src = await one(`select * from organizations where id=$1`, [id(req)]);
  if (!src) throw new HttpError(404, 'Business not found.');
  const parent = src.parent_org_id ? await one(`select * from organizations where id=$1`, [src.parent_org_id]) : src;
  const name = text(b.name, 150);
  if (!name) throw new HttpError(400, 'Please enter the name of the new business.');
  if (!STATE_NAME[b.state_code]) throw new HttpError(400, 'Please choose the GST state of the new business.');
  const sameLogin = b.login !== 'new';
  let person;           // whose name and password the new Owner row copies
  let inviteEmail = null;
  if (sameLogin) {
    person = UUID.test(b.from_user_id || '')
      ? await one(`select name, email, password_hash from users where id=$1`, [b.from_user_id])
      : await one(`select name, email, password_hash from users where org_id=$1 and role='owner' and active order by created_at limit 1`, [src.id]);
    if (!person) throw new HttpError(400, 'There is no Owner in this business to reuse. Choose a new login instead.');
  } else {
    const email = String(b.owner_email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter the email of the person who will run the new business.');
    person = await one(`select name, email, password_hash from users where email=$1 order by last_login_at desc nulls last limit 1`, [email]);
    if (!person) inviteEmail = email;
  }
  const s = await getSettings();
  const amount = clean(b.amount) === null ? s.extra_company_price : Number(money(b.amount, 'the amount'));
  const kid = await db.tx(async t => {
    const o = (await t.query(
      `insert into organizations (name, state_code, parent_org_id, status, trial, plan_name, billing_period, period_start, paid_until, auto_off)
       values ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9) returning id, name`,
      [name, b.state_code, parent.id, parent.trial, parent.plan_name, parent.billing_period, parent.period_start, parent.paid_until, parent.auto_off])).rows[0];
    if (person) await t.query(`insert into users (org_id, email, name, password_hash, role) values ($1,$2,$3,$4,'owner')`, [o.id, person.email, person.name, person.password_hash]);
    else await t.query(`insert into invites (org_id, email, role) values ($1,$2,'owner')`, [o.id, inviteEmail]);
    if (b.record !== false) {
      await t.query(`insert into org_payments (org_id, paid_on, amount, kind, note, created_by) values ($1,$2,$3,'extra_company',$4,$5)`,
        [parent.id, todayIndia(), amount.toFixed(2), `Extra company: ${name}`, req.user.email]);
    }
    if (UUID.test(b.request_id || '')) {
      await t.query(`update requests set status='done', admin_note=coalesce(admin_note, 'Business created'), updated_at=now() where id=$1`, [b.request_id]);
    }
    return o;
  });
  await logActivity(req, 'business.company_created', `${name} created as an extra company (${person ? `Owner: ${person.email}` : `Owner invited: ${inviteEmail}`})`, { child: kid.id }, platformActor(req, parent.id));
  const owner = person ? person.email : inviteEmail;
  const emailed = await notifyAdded(owner, { orgName: name, role: 'owner', byName: 'The Reportly team', existing: !!person });
  res.json({ ok: true, id: kid.id, owner, needs_signup: !person, emailed });
}));

// ---------------------------------------------------------------- customer requests
platformRouter.get('/requests', wrap(async (req, res) => {
  const status = ['new', 'in_progress', 'done', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = await q(`select r.id, r.kind, r.subject, r.message, r.payload, r.status, r.admin_note, r.emailed, r.created_at, r.updated_at, r.org_id,
      o.name org_name, o.phone org_phone, u.name requested_by, u.email requested_email, u.id requested_user_id
    from requests r join organizations o on o.id=r.org_id left join users u on u.id=r.user_id ${status ? 'where r.status=$1' : ''} order by r.created_at desc limit 300`, status ? [status] : []);
  const counts = await q(`select status, count(*)::int n from requests group by status`);
  res.json({ requests: rows, counts: Object.fromEntries(counts.map(c => [c.status, c.n])), kinds: KINDS });
}));

platformRouter.patch('/requests/:rid', wrap(async (req, res) => {
  if (!UUID.test(req.params.rid)) throw new HttpError(400, 'Bad reference.');
  const status = ['new', 'in_progress', 'done', 'rejected'].includes(req.body.status) ? req.body.status : null;
  const r = await one(`update requests set status=coalesce($2, status), admin_note=case when $3::text is null then admin_note else $3::text end, updated_at=now() where id=$1 returning id`,
    [req.params.rid, status, req.body.admin_note === undefined ? null : text(req.body.admin_note, 1000) || '']);
  if (!r) throw new HttpError(404, 'Request not found.');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- pricing rules
platformRouter.get('/settings', wrap(async (_req, res) => res.json({ settings: await getSettings(), defaults: DEFAULTS })));
platformRouter.put('/settings', wrap(async (req, res) => {
  try { res.json({ settings: await saveSettings(req.body || {}) }); } catch (e) { throw new HttpError(400, e.message); }
}));

// ---------------------------------------------------------------- expenses
platformRouter.get('/expenses', wrap(async (_req, res) => {
  res.json({ categories: EXPENSE_CATEGORIES, expenses: await q(`select id, spent_on::text spent_on, category, vendor, amount, repeat, ends_on::text ends_on, note, created_by from platform_expenses order by spent_on desc, created_at desc limit 1000`) });
}));

platformRouter.post('/expenses', wrap(async (req, res) => {
  const b = req.body;
  if (!ISO.test(b.spent_on || '')) throw new HttpError(400, 'Please choose the date.');
  const category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'other';
  const repeat = b.repeat === 'monthly' ? 'monthly' : null;
  if (clean(b.ends_on) && !ISO.test(b.ends_on)) throw new HttpError(400, 'Please choose the end date.');
  await db.query(`insert into platform_expenses (spent_on, category, vendor, amount, repeat, ends_on, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [b.spent_on, category, text(b.vendor, 100), money(b.amount, 'the amount'), repeat, repeat ? clean(b.ends_on) : null, text(b.note, 300), req.user.email]);
  res.json({ ok: true });
}));

platformRouter.delete('/expenses/:eid', wrap(async (req, res) => {
  if (!UUID.test(req.params.eid)) throw new HttpError(400, 'Bad reference.');
  await db.query(`delete from platform_expenses where id=$1`, [req.params.eid]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- money: revenue, expenses, profit by month (cash basis)
platformRouter.get('/finance', wrap(async (req, res) => {
  const n = Math.max(1, Math.min(36, Math.floor(Number(req.query.months)) || 12));
  const today = todayIndia();
  const months = [];
  for (let i = n - 1; i >= 0; i--) months.push(addMonths(today.slice(0, 7) + '-01', -i).slice(0, 7));
  const first = months[0] + '-01';
  const [pay, exp, orgs] = await Promise.all([
    q(`select p.paid_on::text paid_on, p.amount, p.kind, p.org_id, o.name org_name from org_payments p join organizations o on o.id=p.org_id where p.paid_on >= $1`, [first]),
    q(`select spent_on::text spent_on, category, amount, repeat, ends_on::text ends_on from platform_expenses`),
    q(`select id, name from organizations`),
  ]);
  const KINDS = { setup: 'Setup fees', subscription: 'Subscriptions', extra_user: 'Extra users', extra_company: 'Extra companies', other: 'Other' };
  const row = m => ({ month: m, revenue: 0, expenses: 0, by_kind: {}, by_category: {} });
  const rows = Object.fromEntries(months.map(m => [m, row(m)]));
  const byOrg = {};
  for (const p of pay) {
    const r = rows[p.paid_on.slice(0, 7)]; if (!r) continue;
    r.revenue += Number(p.amount); r.by_kind[p.kind] = (r.by_kind[p.kind] || 0) + Number(p.amount);
    byOrg[p.org_id] = { name: p.org_name, revenue: (byOrg[p.org_id]?.revenue || 0) + Number(p.amount) };
  }
  for (const e of exp) {
    for (const m of months) {
      const start = m + '-01', end = addDays(addMonths(start, 1), -1);
      const counts = e.repeat === 'monthly' ? e.spent_on <= end && (!e.ends_on || e.ends_on >= start) : e.spent_on.slice(0, 7) === m;
      if (!counts) continue;
      rows[m].expenses += Number(e.amount); rows[m].by_category[e.category] = (rows[m].by_category[e.category] || 0) + Number(e.amount);
    }
  }
  const list = months.map(m => ({ ...rows[m], profit: rows[m].revenue - rows[m].expenses }));
  const sum = k => list.reduce((a, r) => a + r[k], 0);
  const cat = {}, kind = {};
  for (const r of list) { for (const [k, v] of Object.entries(r.by_category)) cat[k] = (cat[k] || 0) + v; for (const [k, v] of Object.entries(r.by_kind)) kind[k] = (kind[k] || 0) + v; }
  res.json({
    months: list, kinds: KINDS, categories: EXPENSE_CATEGORIES,
    totals: { revenue: sum('revenue'), expenses: sum('expenses'), profit: sum('profit'), by_category: cat, by_kind: kind },
    top_customers: Object.values(byOrg).sort((a, b) => b.revenue - a.revenue).slice(0, 10), businesses: orgs.length,
  });
}));
