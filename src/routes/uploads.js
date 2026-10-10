import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db, bulkInsert } from '../db.js';
import { requireAuth, requireRole, hasRole } from '../auth.js';
import { HttpError, wrap } from '../http.js';
import { logActivity, periodText } from '../activity.js';
import { putFile, getFile, removeFile } from '../storage.js';
import { REPORT_TYPES, TYPE_LIST, suggestMapping } from '../excel/reportTypes.js';
import { readGrid, guessHeaderRow, bannerOf, headersOf, detectType, periodOf, bodyOf, signatureOf, sha256, cellText } from '../excel/read.js';
import { applyMapping } from '../excel/importer.js';

const TMP = process.env.TMP_UPLOAD_DIR || './data/tmp';
const TMP_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FILE_MB = 50;   // same limit in the browser (web/src/pages/Upload.jsx) and the message in http.js
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 } });

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

// ---------- helpers ----------
async function saveTmp(orgId, file) {
  const token = crypto.randomUUID();
  await fs.mkdir(TMP, { recursive: true });
  await fs.writeFile(path.join(TMP, token + '.bin'), file.buffer);
  await fs.writeFile(path.join(TMP, token + '.json'), JSON.stringify({ org_id: orgId, name: file.originalname, size: file.size, at: Date.now() }));
  return token;
}
async function loadTmp(orgId, token) {
  if (!/^[0-9a-f-]{36}$/.test(token || '')) throw new HttpError(400, 'Bad file reference.');
  try {
    const meta = JSON.parse(await fs.readFile(path.join(TMP, token + '.json'), 'utf8'));
    if (meta.org_id !== orgId) throw new Error();
    const buffer = await fs.readFile(path.join(TMP, token + '.bin'));
    return { meta, buffer };
  } catch {
    throw new HttpError(410, 'This file has expired. Please choose it again.');
  }
}
async function dropTmp(token) {
  await fs.rm(path.join(TMP, token + '.bin'), { force: true });
  await fs.rm(path.join(TMP, token + '.json'), { force: true });
}
export async function cleanTmp() {
  try {
    for (const f of await fs.readdir(TMP)) {
      if (!f.endsWith('.json')) continue;
      const meta = JSON.parse(await fs.readFile(path.join(TMP, f), 'utf8'));
      if (Date.now() - meta.at > TMP_TTL_MS) await dropTmp(f.replace('.json', ''));
    }
  } catch { /* nothing to clean */ }
}

// ids of suggested corrections the person accepted, like "134:discount"
const acceptList = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string' && /^\d+:[a-z_]+$/.test(x)).slice(0, 20000) : []);

function sampleValues(body, headers) {
  const out = {};
  for (const h of headers) {
    const vals = [];
    for (const r of body.rows) {
      const v = cellText(r[h]);
      if (v && !vals.includes(v)) vals.push(v);
      if (vals.length >= 3) break;
    }
    out[h] = vals;
  }
  return out;
}

async function overlapInfo(orgId, type, period, hash) {
  const dup = (await db.query(
    `select id, created_at, file_name from uploads where org_id=$1 and file_hash=$2 and status='active' limit 1`, [orgId, hash])).rows[0];
  let existing = [];
  if (period.from && period.to) {
    existing = (await db.query(
      `select id, file_name, period_from, period_to, created_at, row_count from uploads
       where org_id=$1 and report_type=$2 and status='active' and period_from <= $4 and period_to >= $3
       order by created_at`, [orgId, type, period.from, period.to])).rows;
  }
  return { duplicate: dup || null, existing };
}

/** Everything the mapping screen needs for one file. */
async function analyse(orgId, buffer, fileName, opts = {}) {
  const { grid } = readGrid(buffer, fileName);
  const headerRow = opts.header_row ?? guessHeaderRow(grid);
  const banner = bannerOf(grid, headerRow);
  const headers = headersOf(grid, headerRow);
  const type = opts.report_type || detectType(banner, headers);
  const period = periodOf(banner);
  const body = bodyOf(grid, headerRow, headers);
  const hash = sha256(buffer);

  const result = {
    file_name: fileName, size: buffer.length, header_row: headerRow, banner: banner.slice(0, 8),
    headers, samples: sampleValues(body, headers), data_rows: body.rows.length, has_totals: !!body.totals,
    rows_preview: grid.slice(0, Math.min(grid.length, 30)).map((r, i) => ({ row: i + 1, text: r.map(cellText).filter(Boolean).slice(0, 6).join(' · ') })),
    report_type: type, period, template: null, mapping: {}, date_format: 'DMY', needs_mapping: true,
  };
  if (!type) return result;

  const sig = signatureOf(type, headers);
  const tpl = (await db.query(
    `select * from mapping_templates where org_id=$1 and report_type=$2 and signature=$3`, [orgId, type, sig])).rows[0];
  if (tpl && tpl.header_row === headerRow) {
    Object.assign(result, { template: { id: tpl.id, name: tpl.name }, mapping: tpl.mapping, date_format: tpl.date_format });
  } else {
    // new layout: start from the latest saved format for this type, fill the rest by name
    const prev = (await db.query(
      `select * from mapping_templates where org_id=$1 and report_type=$2 order by updated_at desc limit 1`, [orgId, type])).rows[0];
    const guess = suggestMapping(type, headers);
    const carried = {};
    if (prev) for (const [k, h] of Object.entries(prev.mapping)) if (headers.includes(h)) carried[k] = h;
    result.mapping = { ...guess, ...carried };
    if (prev) result.date_format = prev.date_format;
  }
  // Dry run so the person sees problems before saving
  const dry = applyMapping(type, body, result.mapping, { dateFormat: result.date_format, banner: period, homeState: opts.homeState });
  result.check = { errors: dry.errors, issues: dry.issues, reconciliation: dry.reconciliation, stats: dry.stats, period: dry.period };
  result.needs_mapping = !result.template || dry.errors;
  Object.assign(result, await overlapInfo(orgId, type, dry.period, hash));
  return result;
}

// ---------- routes ----------
uploadsRouter.get('/meta', (_req, res) => {
  res.json({ types: TYPE_LIST, fields: Object.fromEntries(Object.values(REPORT_TYPES).map(t => [t.key, t.fields.map(({ key, label, kind, required }) => ({ key, label, kind, required: !!required }))])) });
});

uploadsRouter.post('/preview', requireRole('writer'), upload.array('files', 20), wrap(async (req, res) => {
  if (!req.files?.length) throw new HttpError(400, 'Please choose at least one file.');
  cleanTmp();
  const out = [];
  for (const f of req.files) {
    f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8');
    if (!/\.(xlsx?|csv)$/i.test(f.originalname)) { out.push({ file_name: f.originalname, error: 'Only Excel (.xls, .xlsx) or CSV files can be uploaded.' }); continue; }
    try {
      const token = await saveTmp(req.user.org_id, f);
      out.push({ token, ...(await analyse(req.user.org_id, f.buffer, f.originalname, { homeState: req.user.org_state })) });
    } catch (e) {
      out.push({ file_name: f.originalname, error: e instanceof HttpError ? e.message : (e.message || 'Could not read this file.') });
    }
  }
  res.json({ files: out });
}));

// the person removed a file from the list before saving it
uploadsRouter.delete('/preview/:token', requireRole('writer'), wrap(async (req, res) => {
  const token = req.params.token;
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new HttpError(400, 'Bad file reference.');
  try {
    const meta = JSON.parse(await fs.readFile(path.join(TMP, token + '.json'), 'utf8'));
    if (meta.org_id === req.user.org_id) await dropTmp(token);
  } catch { /* already gone */ }
  res.json({ ok: true });
}));

// re-analyse after the person changes the header row, the file type or the column choices
uploadsRouter.post('/preview/:token', requireRole('writer'), wrap(async (req, res) => {
  const { meta, buffer } = await loadTmp(req.user.org_id, req.params.token);
  const opts = { header_row: req.body.header_row, report_type: req.body.report_type, homeState: req.user.org_state };
  const a = await analyse(req.user.org_id, buffer, meta.name, opts);
  if (req.body.mapping && a.report_type) {
    const { grid } = readGrid(buffer, meta.name);
    const body = bodyOf(grid, a.header_row, a.headers);
    a.mapping = req.body.mapping;
    a.date_format = req.body.date_format || a.date_format;
    const dry = applyMapping(a.report_type, body, a.mapping, { dateFormat: a.date_format, banner: a.period, homeState: req.user.org_state, accept: acceptList(req.body.accept) });
    a.check = { errors: dry.errors, issues: dry.issues, reconciliation: dry.reconciliation, stats: dry.stats, period: dry.period };
    Object.assign(a, await overlapInfo(req.user.org_id, a.report_type, dry.period, sha256(buffer)));
  }
  res.json({ token: req.params.token, ...a });
}));

uploadsRouter.post('/commit', requireRole('writer'), wrap(async (req, res) => {
  const { token, report_type, header_row, mapping, date_format = 'DMY', save_template = true, template_name } = req.body;
  const T = REPORT_TYPES[report_type];
  if (!T) throw new HttpError(400, 'Please choose what kind of file this is.');
  const { meta, buffer } = await loadTmp(req.user.org_id, token);
  const { grid } = readGrid(buffer, meta.name);
  const headers = headersOf(grid, header_row);
  const banner = periodOf(bannerOf(grid, header_row));
  const body = bodyOf(grid, header_row, headers);
  for (const h of Object.values(mapping || {})) if (h && !headers.includes(h)) throw new HttpError(400, `Column "${h}" is not in this file.`);
  const accept = acceptList(req.body.accept);
  const r = applyMapping(report_type, body, mapping, { dateFormat: date_format, banner, homeState: req.user.org_state, accept });
  const corrections = r.issues.find(i => i.corrections)?.corrections || [];
  if (r.errors) throw new HttpError(422, 'This file has problems that must be fixed before saving.', { issues: r.issues, reconciliation: r.reconciliation });

  const orgId = req.user.org_id;
  const hash = sha256(buffer);
  const uploadId = crypto.randomUUID();
  const key = `${orgId}/${(r.period.from || 'undated').slice(0, 7)}/${uploadId}/${meta.name.replace(/[^\w.\- ]+/g, '_')}.gz`;
  const storedBytes = await putFile(key, buffer);

  let replaced = [];
  try {
    replaced = await db.tx(async t => {
      // 1. saved format
      let templateId = null;
      if (save_template) {
        const sig = signatureOf(report_type, headers);
        const name = (template_name || `${T.label} format`).slice(0, 80);
        templateId = (await t.query(
          `insert into mapping_templates (org_id, report_type, name, signature, headers, header_row, mapping, date_format, created_by, times_used)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
           on conflict (org_id, report_type, signature) do update
             set mapping=excluded.mapping, header_row=excluded.header_row, date_format=excluded.date_format,
                 name=coalesce(nullif($3,''), mapping_templates.name), updated_at=now(), times_used=mapping_templates.times_used+1
           returning id`,
          [orgId, report_type, name, sig, JSON.stringify(headers), header_row, JSON.stringify(mapping), date_format, req.user.id])).rows[0].id;
      }

      // 2. replace earlier data for the same dates
      const rep = await replaceExisting(t, orgId, report_type, r.period);

      // 3. upload record
      await t.query(
        `insert into uploads (id, org_id, report_type, file_name, file_hash, size_bytes, stored_bytes, storage_path, period_from, period_to,
                              row_count, totals_ok, reconciliation, issues, template_id, uploaded_by, import_settings)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [uploadId, orgId, report_type, meta.name, hash, buffer.length, storedBytes, key, r.period.from, r.period.to,
          r.rows.length, r.reconciliation.every(x => x.status !== 'mismatch'), JSON.stringify(r.reconciliation),
          JSON.stringify(r.issues), templateId, req.user.id, JSON.stringify({ header_row, mapping, date_format, accept: corrections.map(c => c.id) })]);

      // 4. rows
      await insertRows(t, T, orgId, uploadId, report_type, r);
      return rep;
    });
  } catch (e) {
    await removeFile(key).catch(() => {});
    throw e;
  }
  await dropTmp(token);
  await logActivity(req, 'upload.saved',
    `Uploaded ${T.label} "${meta.name}" for ${periodText(r.period.from, r.period.to)} (${r.rows.length} rows)` +
      (replaced.length ? `, replacing ${replaced.map(n => `"${n}"`).join(', ')}` : '') +
      (corrections.length ? `, with ${corrections.length} accepted correction${corrections.length > 1 ? 's' : ''} (` +
        corrections.slice(0, 5).map(c => `row ${c.row} ${c.label} ${c.from} → ${c.to}`).join('; ') + (corrections.length > 5 ? '; …' : '') + ')' : ''),
    { upload_id: uploadId, report_type, file_name: meta.name, period: r.period, rows: r.rows.length, replaced, corrections });
  res.json({
    upload: { id: uploadId, report_type, file_name: meta.name, period: r.period, rows: r.rows.length, stored_bytes: storedBytes, size_bytes: buffer.length },
    stats: r.stats, issues: r.issues, reconciliation: r.reconciliation, replaced,
  });
}));

async function replaceExisting(t, orgId, type, period) {
  if (!period.from || !period.to) return [];
  const olds = (await t.query(
    `select id, file_name from uploads where org_id=$1 and report_type=$2 and status='active' and period_from <= $4 and period_to >= $3`,
    [orgId, type, period.from, period.to])).rows;
  if (!olds.length) return [];
  const ids = olds.map(o => o.id);
  if (type === 'outstanding') {
    await t.query(`delete from outstanding_bills where org_id=$1 and as_on between $2 and $3`, [orgId, period.from, period.to]);
  } else if (type === 'receipt') {
    await t.query(`delete from receipts where org_id=$1 and v_date between $2 and $3`, [orgId, period.from, period.to]);
  } else {
    await t.query(`delete from doc_lines where org_id=$1 and doc_type=$2 and doc_date between $3 and $4`, [orgId, type, period.from, period.to]);
  }
  const table = type === 'outstanding' ? 'outstanding_bills' : type === 'receipt' ? 'receipts' : 'doc_lines';
  for (const id of ids) {
    const n = (await t.query(`select count(*)::int n from ${table} where upload_id=$1`, [id])).rows[0].n;
    await t.query(`update uploads set row_count=$1, status=case when $1=0 then 'replaced' else status end where id=$2`, [n, id]);
  }
  return olds.map(o => o.file_name);
}

async function insertRows(t, T, orgId, uploadId, type, r) {
  if (T.table === 'doc_lines') {
    const cols = ['doc_date', 'doc_no', 'party_code', 'party_name', 'party_type', 'gstin', 'sku_code', 'sku_name', 'brand', 'hsn', 'qty', 'rate', 'mrp',
      'amount', 'discount', 'taxable', 'igst_pct', 'igst', 'cgst_pct', 'cgst', 'sgst_pct', 'sgst', 'cess_pct', 'cess', 'net_amount', 'doc_value',
      'gstr1_section', 'note_type', 'ref_no', 'ref_date', 'supplier_bill_no', 'supplier_bill_date'];
    await bulkInsert(t, 'doc_lines', r.rows.map(x => {
      const o = { org_id: orgId, upload_id: uploadId, doc_type: type, row_no: x.row_no };
      for (const c of cols) o[c] = x[c] ?? null;
      for (const c of ['qty', 'rate', 'mrp', 'amount', 'discount', 'taxable', 'igst_pct', 'igst', 'cgst_pct', 'cgst', 'sgst_pct', 'sgst', 'cess_pct', 'cess', 'net_amount', 'doc_value']) o[c] ??= '0';
      if (o.gstin) o.gstin = o.gstin.toUpperCase();
      return o;
    }), 300);
  } else if (type === 'receipt') {
    await bulkInsert(t, 'receipts', r.rows.map(x => ({
      org_id: orgId, upload_id: uploadId, row_no: x.row_no, v_date: x.v_date, v_no: x.v_no, party_code: x.party_code ?? null,
      party_name: x.party_name ?? null, city: x.city ? x.city.replace(/\s+/g, ' ').trim() : null, amount: x.amount, account: x.account ?? null,
      mode: x.mode, cheque_no: x.cheque_no ?? null, cheque_date: x.cheque_date ?? null, bank: x.bank ?? null, collected_by: x.collected_by,
    })));
  } else {
    await bulkInsert(t, 'outstanding_bills', r.rows.map(x => ({
      org_id: orgId, upload_id: uploadId, row_no: x.row_no, as_on: r.period.to, bill_date: x.bill_date ?? null, trn: x.trn ?? null,
      bill_no: x.bill_no, party_code: x.party_code ?? null, party_name: x.party_name, salesman: x.salesman,
      bill_amount: x.bill_amount, received: x.received ?? '0', balance: x.balance, age_weeks: x.age_weeks ?? 0,
    })), 1000);
  }
}

uploadsRouter.get('/', wrap(async (req, res) => {
  const rows = (await db.query(
    `select u.id, u.report_type, u.file_name, u.size_bytes, u.stored_bytes, u.period_from, u.period_to, u.row_count, u.status,
            u.totals_ok, u.issues, u.created_at, us.name uploaded_by, u.uploaded_by uploaded_by_id, u.undone_at, ub.name undone_by
     from uploads u left join users us on us.id=u.uploaded_by left join users ub on ub.id=u.undone_by
     where u.org_id=$1 and u.status <> 'deleted' order by u.created_at desc limit 300`, [req.user.org_id])).rows;
  res.json({ uploads: rows.map(r => ({ ...r, warnings: (r.issues || []).filter(i => i.level === 'warning').length, issues: undefined })) });
}));

uploadsRouter.get('/:id', wrap(async (req, res) => {
  const u = (await db.query(`select * from uploads where id=$1 and org_id=$2`, [req.params.id, req.user.org_id])).rows[0];
  if (!u) throw new HttpError(404, 'Upload not found.');
  res.json({ upload: u });
}));

uploadsRouter.get('/:id/download', wrap(async (req, res) => {
  const u = (await db.query(`select * from uploads where id=$1 and org_id=$2 and status <> 'deleted'`, [req.params.id, req.user.org_id])).rows[0];
  if (!u) throw new HttpError(404, 'Upload not found.');
  const buf = await getFile(u.storage_path);
  await logActivity(req, 'upload.downloaded', `Downloaded the original file "${u.file_name}"`, { upload_id: u.id });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(u.file_name)}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(buf);
}));

// ---------- undo ----------
// Undo takes an upload's data out of the reports and puts back what it replaced, day by day:
// for each day the upload covered, the latest earlier upload for that day is read again from its
// stored original file. Days that a later upload has since taken over are left alone.
// The undone upload's own file is kept, so it can still be downloaded.

const ROW_DATE = { doc_lines: 'doc_date', receipts: 'v_date', outstanding_bills: 'as_on' };

function daysOf(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Reads a stored original file again, the same way it was read when it was saved. */
async function readBack(u, homeState) {
  let s = u.import_settings, exact = true;
  if (!s && u.template_id) {
    // uploads saved before import settings were kept: use their saved format
    s = (await db.query(`select header_row, mapping, date_format from mapping_templates where id=$1`, [u.template_id])).rows[0];
    exact = false;
  }
  if (!s) return null;
  const buffer = await getFile(u.storage_path);
  const { grid } = readGrid(buffer, u.file_name);
  const headers = headersOf(grid, s.header_row);
  const body = bodyOf(grid, s.header_row, headers);
  const r = applyMapping(u.report_type, body, s.mapping, { dateFormat: s.date_format, banner: periodOf(bannerOf(grid, s.header_row)), homeState, accept: s.accept || [] });
  // with the exact settings the file was accepted once already; a saved format may have changed since
  return r.rows.length && (exact || !r.errors) ? r : null;
}

uploadsRouter.post('/:id/undo', requireRole('writer'), wrap(async (req, res) => {
  const u = await findUpload(req);
  if (u.status === 'undone') throw new HttpError(409, 'This upload has already been undone.');
  if (u.uploaded_by !== req.user.id && !hasRole(req.user, 'admin')) throw new HttpError(403, 'Only an Admin can undo an upload made by someone else.');
  const restored = await takeOut(req, u, 'undone');
  await logActivity(req, 'upload.undone',
    `Undid the upload of ${REPORT_TYPES[u.report_type].label} "${u.file_name}" for ${periodText(u.period_from, u.period_to)}` +
      (restored.length ? `; brought back the data from ${restored.map(n => `"${n}"`).join(', ')}` : ''),
    { upload_id: u.id, report_type: u.report_type, restored });
  res.json({ ok: true, restored });
}));

// Delete = undo (if not undone already), then the original file is removed from storage (Supabase)
// and the upload's record is removed from the database. The activity log keeps a line about it.
uploadsRouter.delete('/:id', requireRole('admin'), wrap(async (req, res) => {
  const u = await findUpload(req);
  let restored = [];
  if (u.status === 'undone') await db.query(`update uploads set status='deleted' where id=$1`, [u.id]);
  else restored = await takeOut(req, u, 'deleted');
  const purged = await purge(u);
  await logActivity(req, 'upload.deleted',
    `Deleted the upload of ${REPORT_TYPES[u.report_type].label} "${u.file_name}" for ${periodText(u.period_from, u.period_to)} and its original file` +
      (restored.length ? `; brought back the data from ${restored.map(n => `"${n}"`).join(', ')}` : ''),
    { upload_id: u.id, report_type: u.report_type, file_name: u.file_name, restored, file_removed: purged });
  res.json({ ok: true, restored, file_removed: purged });
}));

/** Removes a deleted upload's file from storage, then its record. If storage fails, the record stays (status 'deleted') for a retry. */
async function purge(u) {
  try {
    await removeFile(u.storage_path);
  } catch (e) {
    console.error(`[delete] ${u.id}: ${e.message} (will retry when the server restarts)`);
    return false;
  }
  await db.query(`delete from uploads where id=$1 and status='deleted'`, [u.id]);
  return true;
}

/** On start: finish any deletes whose file could not be removed earlier. */
export async function purgeDeleted() {
  // undone_at is set only by the new delete; older deletes already removed their files and must stay as markers
  const left = (await db.query(`select * from uploads where status='deleted' and undone_at is not null`)).rows;
  for (const u of left) await purge(u);
  if (left.length) console.log(`[delete] retried ${left.length} deleted upload(s)`);
}

async function findUpload(req) {
  const u = (await db.query(`select * from uploads where id=$1 and org_id=$2 and status <> 'deleted'`, [req.params.id, req.user.org_id])).rows[0];
  if (!u) throw new HttpError(404, 'Upload not found.');
  return u;
}

/** Takes an upload's rows out of the reports and restores what it replaced. Returns the restored file names. */
async function takeOut(req, u, finalStatus) {
  const orgId = req.user.org_id;
  const T = REPORT_TYPES[u.report_type];

  // which earlier upload owned each day before this one replaced it.
  // Uploads taken out with undo/delete (undone_at set) already gave their days back, so they don't count.
  const restore = new Map();   // upload id -> { prev, days }
  if (u.period_from && u.period_to) {
    const others = (await db.query(
      `select * from uploads where org_id=$1 and report_type=$2 and id<>$3 and undone_at is null
         and period_from <= $5 and period_to >= $4 order by created_at`,
      [orgId, u.report_type, u.id, u.period_from, u.period_to])).rows;
    for (const day of daysOf(u.period_from, u.period_to)) {
      const covering = others.filter(o => o.period_from <= day && o.period_to >= day);
      if (covering.some(o => o.created_at > u.created_at)) continue;   // a later upload owns this day now
      const prev = covering.at(-1);
      if (!prev || prev.status === 'deleted') continue;
      if (!restore.has(prev.id)) restore.set(prev.id, { prev, days: new Set() });
      restore.get(prev.id).days.add(day);
    }
  }

  const batches = [];
  for (const { prev, days } of restore.values()) {
    const r = await readBack(prev, req.user.org_state).catch(() => null);
    if (!r) {
      throw new HttpError(409, `This upload cannot be taken out automatically: the earlier file "${prev.file_name}" that it replaced could not be read back. ` +
        'Upload the correct file again instead; it will replace this one.');
    }
    const key = ROW_DATE[T.table];
    const rows = key === 'as_on' ? (days.has(prev.period_to) ? r.rows : []) : r.rows.filter(x => days.has(x[key]));
    batches.push({ prev, days: [...days], r: { ...r, rows, period: { from: prev.period_from, to: prev.period_to } } });
  }

  await db.tx(async t => {
    const cur = (await t.query(`select status from uploads where id=$1 for update`, [u.id])).rows[0];
    if (cur.status !== u.status) throw new HttpError(409, 'This upload was just changed by someone else. Please refresh the page.');
    await t.query(`delete from ${T.table} where upload_id=$1`, [u.id]);
    await t.query(`update uploads set status=$3, row_count=0, undone_at=now(), undone_by=$2 where id=$1`, [u.id, req.user.id, finalStatus]);
    const dateCol = ROW_DATE[T.table];
    for (const { prev, days, r } of batches) {
      // nothing of prev should be left on these days, but never insert twice
      await t.query(`delete from ${T.table} where upload_id=$1 and ${dateCol} = any($2::date[])`, [prev.id, days]);
      await insertRows(t, T, orgId, prev.id, prev.report_type, r);
      const n = (await t.query(`select count(*)::int n from ${T.table} where upload_id=$1`, [prev.id])).rows[0].n;
      await t.query(`update uploads set row_count=$1, status=case when $1>0 then 'active' else status end where id=$2`, [n, prev.id]);
    }
  });

  return batches.filter(b => b.r.rows.length).map(b => b.prev.file_name);
}

// ---------- saved formats ----------
export const templatesRouter = Router();
templatesRouter.use(requireAuth);
templatesRouter.get('/', wrap(async (req, res) => {
  res.json({ templates: (await db.query(
    `select t.id, t.report_type, t.name, t.headers, t.header_row, t.mapping, t.date_format, t.times_used, t.updated_at, u.name created_by
     from mapping_templates t left join users u on u.id=t.created_by where t.org_id=$1 order by t.report_type, t.updated_at desc`, [req.user.org_id])).rows });
}));
templatesRouter.patch('/:id', requireRole('writer'), wrap(async (req, res) => {
  const t = (await db.query(`select * from mapping_templates where id=$1 and org_id=$2`, [req.params.id, req.user.org_id])).rows[0];
  if (!t) throw new HttpError(404, 'Saved format not found.');
  const mapping = req.body.mapping ?? t.mapping;
  for (const h of Object.values(mapping)) if (h && !t.headers.includes(h)) throw new HttpError(400, `Column "${h}" is not in this format.`);
  const missing = REPORT_TYPES[t.report_type].fields.filter(f => f.required && !mapping[f.key]);
  if (missing.length) throw new HttpError(400, 'Please choose a column for: ' + missing.map(f => f.label).join(', '));
  await db.query(`update mapping_templates set name=coalesce($1,name), mapping=$2, date_format=coalesce($3,date_format), updated_at=now() where id=$4`,
    [req.body.name ?? null, JSON.stringify(mapping), req.body.date_format ?? null, t.id]);
  await logActivity(req, 'format.changed', `Changed the saved file format "${req.body.name || t.name}" (${REPORT_TYPES[t.report_type].label})`,
    { template_id: t.id, before: t.mapping, after: mapping });
  res.json({ ok: true });
}));
templatesRouter.delete('/:id', requireRole('admin'), wrap(async (req, res) => {
  const t = (await db.query(`delete from mapping_templates where id=$1 and org_id=$2 returning name, report_type`, [req.params.id, req.user.org_id])).rows[0];
  if (t) await logActivity(req, 'format.forgotten', `Forgot the saved file format "${t.name}" (${REPORT_TYPES[t.report_type].label})`);
  res.json({ ok: true });
}));
