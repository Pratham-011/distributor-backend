// Platform admin: for the people who run this software (PLATFORM_ADMIN_EMAILS), not for the businesses using it.
// Every business with its data size, users and use, subscription (price, setup fee, period), pause / resume and renewals.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, todayIndia } from '../auth.js';
import { HttpError, wrap } from '../http.js';
import { logActivity } from '../activity.js';

export const platformRouter = Router();
platformRouter.use(requireAuth, (req, _res, next) => next(req.user.platform_admin ? undefined : new HttpError(403, 'Only the platform admin can open this page.')));

const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const PERIOD_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
// tables that hold a business's data; size per business = its rows × the table's average row size (incl. indexes)
const DATA_TABLES = ['doc_lines', 'receipts', 'outstanding_bills', 'stock_items', 'uploads', 'mapping_templates', 'activity_log', 'usage_blocks', 'org_payments'];

const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** active | paused | expired | expiring (7 days) | no_plan */
function stateOf(o, today) {
  if (o.status === 'paused') return 'paused';
  if (!o.paid_until) return 'no_plan';
  if (o.paid_until < today) return o.auto_off ? 'expired' : 'overdue';
  return daysBetween(today, o.paid_until) <= 7 ? 'expiring' : 'active';
}

async function rowSizes() {
  const sizes = {};
  for (const t of DATA_TABLES) {
    const r = await one(`select pg_total_relation_size('${t}')::bigint b, (select count(*) from ${t})::bigint n`);
    sizes[t] = Number(r.n) ? Number(r.b) / Number(r.n) : 0;
  }
  return sizes;
}
async function rowCounts(orgId) {
  const where = orgId ? 'where org_id=$1' : '';
  const out = {};
  for (const t of DATA_TABLES) {
    for (const r of await q(`select org_id, count(*)::int n from ${t} ${where} group by org_id`, orgId ? [orgId] : [])) {
      (out[r.org_id] ||= {})[t] = r.n;
    }
  }
  return out;
}

platformRouter.get('/orgs', wrap(async (_req, res) => {
  const today = todayIndia(), since = addDays(today, -29);
  const [orgs, users, use, files, sizes, counts] = await Promise.all([
    q(`select id, name, state_code, created_at, status, status_reason, plan_name, plan_price, billing_period, setup_fee,
         period_start::text period_start, paid_until::text paid_until, auto_off from organizations order by created_at`),
    q(`select org_id, count(*)::int users, count(*) filter (where active)::int active_users,
         count(*) filter (where last_seen_at > now() - interval '30 days')::int used_30, max(coalesce(last_seen_at, last_login_at)) last_seen
       from users group by org_id`),
    q(`select org_id, coalesce(sum(blocks),0)::int blocks, count(distinct day)::int days from usage_blocks where day >= $1 group by org_id`, [since]),
    q(`select org_id, count(*)::int uploads, coalesce(sum(stored_bytes),0)::bigint stored, max(created_at) last_upload
       from uploads where status <> 'deleted' group by org_id`),
    rowSizes(), rowCounts(),
  ]);
  const by = (list, k = 'org_id') => Object.fromEntries(list.map(x => [x[k], x]));
  const U = by(users), S = by(use), F = by(files);
  const list = orgs.map(o => {
    const c = counts[o.id] || {};
    const dbBytes = Object.entries(c).reduce((a, [t, n]) => a + n * (sizes[t] || 0), 0);
    return {
      ...o, state: stateOf(o, today), days_left: o.paid_until ? daysBetween(today, o.paid_until) : null,
      users: U[o.id]?.users || 0, active_users: U[o.id]?.active_users || 0, used_30: U[o.id]?.used_30 || 0, last_seen: U[o.id]?.last_seen || null,
      minutes_30: (S[o.id]?.blocks || 0) * 5, days_used_30: S[o.id]?.days || 0,
      uploads: F[o.id]?.uploads || 0, last_upload: F[o.id]?.last_upload || null, file_bytes: Number(F[o.id]?.stored || 0),
      db_bytes: Math.round(dbBytes), rows: (c.doc_lines || 0) + (c.receipts || 0) + (c.outstanding_bills || 0) + (c.stock_items || 0),
    };
  });
  const monthly = o => (o.plan_price && PERIOD_MONTHS[o.billing_period] ? Number(o.plan_price) / PERIOD_MONTHS[o.billing_period] : 0);
  const db_total = Number((await one(`select pg_database_size(current_database())::bigint b`)).b);
  res.json({
    today, orgs: list,
    totals: {
      businesses: list.length, active: list.filter(o => ['active', 'expiring', 'no_plan'].includes(o.state)).length,
      paused: list.filter(o => o.state === 'paused').length, expired: list.filter(o => o.state === 'expired').length,
      expiring: list.filter(o => o.state === 'expiring').length,
      users: list.reduce((a, o) => a + o.users, 0), db_bytes: db_total, file_bytes: list.reduce((a, o) => a + o.file_bytes, 0),
      monthly_revenue: list.filter(o => o.state !== 'paused' && o.state !== 'expired').reduce((a, o) => a + monthly(o), 0).toFixed(2),
    },
  });
}));

platformRouter.get('/orgs/:id', wrap(async (req, res) => {
  const id = req.params.id;
  const org = await one(`select id, name from organizations where id=$1`, [id]);
  if (!org) throw new HttpError(404, 'Business not found.');
  const since = addDays(todayIndia(), -29);
  const [users, payments, sizes, counts] = await Promise.all([
    q(`select u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at, u.last_seen_at,
         coalesce(sum(b.blocks) filter (where b.day >= $2), 0)::int * 5 minutes_30, count(b.day) filter (where b.day >= $2)::int days_30,
         coalesce(sum(b.blocks), 0)::int * 5 minutes_all
       from users u left join usage_blocks b on b.user_id = u.id where u.org_id=$1 group by u.id order by u.last_seen_at desc nulls last`, [id, since]),
    q(`select id, paid_on::text paid_on, amount, kind, period_from::text period_from, period_to::text period_to, note, created_by, created_at
       from org_payments where org_id=$1 order by paid_on desc, created_at desc`, [id]),
    rowSizes(), rowCounts(id),
  ]);
  const LABEL = { doc_lines: 'Sales, purchase and note lines', receipts: 'Receipts', outstanding_bills: 'Outstanding bills', stock_items: 'Stock statement rows',
    uploads: 'Uploaded files (records)', mapping_templates: 'Saved file formats', activity_log: 'Activity log', usage_blocks: 'Usage records', org_payments: 'Payments' };
  const c = counts[id] || {};
  const data = DATA_TABLES.map(t => ({ name: LABEL[t], rows: c[t] || 0, bytes: Math.round((c[t] || 0) * (sizes[t] || 0)) })).filter(x => x.rows);
  res.json({ users, payments, data });
}));

const clean = v => (v === '' || v === undefined ? null : v);
platformRouter.patch('/orgs/:id', wrap(async (req, res) => {
  const b = req.body;
  if (b.billing_period && !['monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'].includes(b.billing_period)) throw new HttpError(400, 'Unknown billing period.');
  for (const k of ['period_start', 'paid_until']) if (clean(b[k]) && !ISO.test(b[k])) throw new HttpError(400, 'Please enter dates as dates.');
  for (const k of ['plan_price', 'setup_fee']) if (clean(b[k]) !== null && !(Number(b[k]) >= 0)) throw new HttpError(400, 'Prices must be numbers.');
  const o = await one(`update organizations set plan_name=$2, plan_price=$3, billing_period=$4, setup_fee=$5, period_start=$6, paid_until=$7,
      auto_off=$8, billing_notes=$9 where id=$1 returning id, name`,
    [req.params.id, clean(b.plan_name), clean(b.plan_price), clean(b.billing_period), clean(b.setup_fee), clean(b.period_start), clean(b.paid_until),
      b.auto_off !== false, clean(b.billing_notes)]);
  if (!o) throw new HttpError(404, 'Business not found.');
  res.json({ ok: true });
}));

const platformActor = (req, orgId) => ({ org_id: orgId, id: null, name: `Platform admin (${req.user.email})` });

// Extends "paid until" by whole billing periods and records the payment
platformRouter.post('/orgs/:id/renew', wrap(async (req, res) => {
  const o = await one(`select * from organizations where id=$1`, [req.params.id]);
  if (!o) throw new HttpError(404, 'Business not found.');
  const months = PERIOD_MONTHS[o.billing_period];
  if (!months) throw new HttpError(400, 'Set a billing period (monthly, quarterly, half-yearly or yearly) first, or set "paid until" by hand.');
  const periods = Math.max(1, Math.min(24, Math.floor(Number(req.body.periods) || 1)));
  const today = todayIndia();
  const paidUntil = o.paid_until ? String(o.paid_until).slice(0, 10) : null;
  // continue from the old end date if it hasn't passed, otherwise start today
  const from = paidUntil && paidUntil >= today ? addDays(paidUntil, 1) : today;
  const until = addDays(addMonths(from, months * periods), -1);
  const amount = req.body.amount === undefined || req.body.amount === '' ? Number(o.plan_price || 0) * periods : Number(req.body.amount);
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : today;
  await db.tx(async t => {
    await t.query(`update organizations set paid_until=$2, period_start=coalesce(period_start, $3) where id=$1`, [o.id, until, from]);
    await t.query(`insert into org_payments (org_id, paid_on, amount, kind, period_from, period_to, note, created_by) values ($1,$2,$3,'subscription',$4,$5,$6,$7)`,
      [o.id, paidOn, amount.toFixed(2), from, until, clean(req.body.note), req.user.email]);
  });
  await logActivity(req, 'business.renewed', `Subscription renewed: paid until ${until}`, { from, until, amount }, platformActor(req, o.id));
  res.json({ ok: true, paid_until: until, period_from: from });
}));

platformRouter.post('/orgs/:id/payments', wrap(async (req, res) => {
  const kind = ['setup', 'subscription', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
  if (!(Number(req.body.amount) >= 0)) throw new HttpError(400, 'Please enter the amount.');
  const paidOn = ISO.test(req.body.paid_on || '') ? req.body.paid_on : todayIndia();
  const r = await one(`insert into org_payments (org_id, paid_on, amount, kind, note, created_by) select id, $2, $3, $4, $5, $6 from organizations where id=$1 returning id`,
    [req.params.id, paidOn, Number(req.body.amount).toFixed(2), kind, clean(req.body.note), req.user.email]);
  if (!r) throw new HttpError(404, 'Business not found.');
  res.json({ ok: true });
}));

platformRouter.delete('/orgs/:id/payments/:pid', wrap(async (req, res) => {
  await db.query(`delete from org_payments where id=$1 and org_id=$2`, [req.params.pid, req.params.id]);
  res.json({ ok: true });
}));

platformRouter.post('/orgs/:id/pause', wrap(async (req, res) => {
  if (req.params.id === req.user.org_id) throw new HttpError(400, 'You cannot pause your own business here.');
  const reason = clean(String(req.body.reason ?? '').trim().slice(0, 200));
  const o = await one(`update organizations set status='paused', status_reason=$2 where id=$1 returning id`, [req.params.id, reason]);
  if (!o) throw new HttpError(404, 'Business not found.');
  await logActivity(req, 'business.paused', `Portal paused by the platform admin${reason ? `: ${reason}` : ''}`, { reason }, platformActor(req, o.id));
  res.json({ ok: true });
}));

platformRouter.post('/orgs/:id/resume', wrap(async (req, res) => {
  const o = await one(`update organizations set status='active', status_reason=null where id=$1 returning id`, [req.params.id]);
  if (!o) throw new HttpError(404, 'Business not found.');
  await logActivity(req, 'business.resumed', 'Portal turned back on by the platform admin', {}, platformActor(req, o.id));
  res.json({ ok: true });
}));
