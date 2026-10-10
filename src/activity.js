// Activity log: one line for everything people do in the app, shown to Admins and Owners.
import { db } from './db.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
export const periodText = (from, to) => (!from ? 'no dates' : from === to ? day(from) : `${day(from)} to ${day(to)}`);

/**
 * Records one line. `actor` is the person who did it (defaults to the logged-in user).
 * Never fails the request it belongs to.
 */
export async function logActivity(req, action, message, details = {}, actor = req.user) {
  try {
    await db.query(
      `insert into activity_log (org_id, user_id, user_name, action, message, details, ip) values ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.org_id, actor.id ?? null, actor.name ?? null, action, message, JSON.stringify(details), req.ip || null]);
  } catch (e) {
    console.error('[activity] could not record', action, e.message);
  }
}
