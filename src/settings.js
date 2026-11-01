// Pricing rules the platform admin can change (Platform admin -> Pricing). Cached for 30 seconds.
import { db } from './db.js';

export const DEFAULTS = {
  included_users: 2,          // people besides the Owner that every business gets (1 Owner + 2 = 3 in total)
  extra_user_price: 3000,     // ₹ per extra person, per year
  extra_company_price: 5000,  // ₹ for each extra company linked to a customer, per year
};
let cache = null, at = 0;

export async function getSettings() {
  if (cache && Date.now() - at < 30000) return cache;
  const rows = (await db.query('select key, value from platform_settings')).rows;
  cache = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && Number(r.value) >= 0) cache[r.key] = Number(r.value);
  at = Date.now();
  return cache;
}

export async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    const n = Number(v);
    if (!(n >= 0) || (k === 'included_users' && !Number.isInteger(n))) throw new Error(`Please enter a valid number for ${k}.`);
    await db.query(`insert into platform_settings (key, value) values ($1,$2) on conflict (key) do update set value=excluded.value`, [k, JSON.stringify(n)]);
  }
  cache = null;
  return getSettings();
}

/** How many people a business may have, and how many it has (active people + invites not yet used). */
export async function seatInfo(orgId) {
  const [s, o, used] = await Promise.all([
    getSettings(),
    db.query('select extra_users from organizations where id=$1', [orgId]),
    db.query(`select (select count(*) from users where org_id=$1 and active)::int + (select count(*) from invites where org_id=$1)::int n`, [orgId]),
  ]);
  const extra = o.rows[0]?.extra_users || 0;
  return { included: 1 + s.included_users, extra, max: 1 + s.included_users + extra, used: used.rows[0].n, extra_price: s.extra_user_price };
}
