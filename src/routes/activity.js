import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap } from '../http.js';

const PAGE = 100;
const isUuid = s => /^[0-9a-f-]{36}$/i.test(s || '');

export const activityRouter = Router();
activityRouter.use(requireAuth, requireRole('admin'));

// ?before=<id> for the next page, ?user=<uuid>, ?kind=upload|login|team|format|business|account
activityRouter.get('/', wrap(async (req, res) => {
  const where = ['org_id=$1'], params = [req.user.org_id];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (Number(req.query.before) > 0) add('id < ?', Number(req.query.before));
  if (isUuid(req.query.user)) add('user_id = ?', req.query.user);
  if (req.query.kind) add(`split_part(action, '.', 1) = ?`, String(req.query.kind));
  const rows = (await db.query(
    `select id, created_at, user_id, user_name, action, message, details, ip from activity_log
     where ${where.join(' and ')} order by id desc limit ${PAGE + 1}`, params)).rows;
  res.json({ entries: rows.slice(0, PAGE), more: rows.length > PAGE });
}));
