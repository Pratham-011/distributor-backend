// Report APIs. All sums happen in Postgres NUMERIC and come back as exact strings.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError, wrap } from '../http.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function range(req) {
  const { from, to } = req.query;
  if (!ISO.test(from || '') || !ISO.test(to || '')) throw new HttpError(400, 'Please choose a date range.');
  if (from > to) throw new HttpError(400, 'The start date is after the end date.');
  return [req.user.org_id, from, to];
}
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

// Common WHERE for a doc type in a date range: $1 org, $2 from, $3 to
const W = type => `org_id=$1 and doc_type='${type}' and doc_date between $2 and $3`;

async function docTotals(type, p) {
  return one(`
    select count(*)::int lines, count(distinct doc_no)::int docs, count(distinct party_code)::int parties,
           coalesce(sum(qty),0) qty, coalesce(sum(amount),0) gross, coalesce(sum(discount),0) discount,
           coalesce(sum(taxable),0) taxable, coalesce(sum(cgst),0) cgst, coalesce(sum(sgst),0) sgst,
           coalesce(sum(igst),0) igst, coalesce(sum(cess),0) cess,
           coalesce(sum(cgst+sgst+igst+cess),0) tax,
           (select coalesce(sum(v),0) from (select max(doc_value) v from doc_lines where ${W(type)} group by doc_no) d) value
    from doc_lines where ${W(type)}`, p);
}

const byBrand = (type, p, limit = 50) => q(`
  select brand name, sum(qty) qty, sum(taxable) taxable from doc_lines where ${W(type)}
  group by brand order by sum(taxable) desc limit ${limit}`, p);

async function latestSnapshot(orgId, onOrBefore) {
  const r = await one(`select max(as_on) d from outstanding_bills where org_id=$1 ${onOrBefore ? 'and as_on <= $2' : ''}`,
    onOrBefore ? [orgId, onOrBefore] : [orgId]);
  return r?.d || null;
}

const BUCKETS = `case when age_weeks <= 1 then '0-1 week' when age_weeks <= 4 then '2-4 weeks'
  when age_weeks <= 8 then '5-8 weeks' when age_weeks <= 12 then '9-12 weeks' else 'Over 12 weeks' end`;
const BUCKET_ORDER = ['0-1 week', '2-4 weeks', '5-8 weeks', '9-12 weeks', 'Over 12 weeks'];

async function outstandingSummary(orgId, asOn) {
  if (!asOn) return null;
  const p = [orgId, asOn];
  const t = await one(`select count(*)::int bills, count(distinct coalesce(party_code, party_name))::int parties,
      coalesce(sum(balance),0) total, coalesce(sum(balance) filter (where age_weeks > 4),0) over_4,
      coalesce(sum(balance) filter (where age_weeks > 8),0) over_8,
      count(distinct coalesce(party_code, party_name)) filter (where age_weeks > 8)::int over_8_parties
    from outstanding_bills where org_id=$1 and as_on=$2`, p);
  const b = await q(`select ${BUCKETS} name, count(*)::int bills, sum(balance) balance from outstanding_bills
    where org_id=$1 and as_on=$2 group by 1`, p);
  t.buckets = BUCKET_ORDER.map(n => b.find(x => x.name === n) || { name: n, bills: 0, balance: '0' });
  t.as_on = asOn;
  return t;
}

// ---------- which dates have data ----------
reportsRouter.get('/dates', wrap(async (req, res) => {
  const org = req.user.org_id;
  const rows = await q(`
    select doc_type t, doc_date::text d from doc_lines where org_id=$1 group by 1,2
    union all select 'receipt', v_date::text from receipts where org_id=$1 group by 2
    union all select 'outstanding', as_on::text from outstanding_bills where org_id=$1 group by 2
    order by 2 desc`, [org]);
  const latest = {};
  const days = {};
  for (const r of rows) {
    latest[r.t] ||= r.d;
    (days[r.d] ||= []).push(r.t);
  }
  res.json({ latest, days: Object.entries(days).slice(0, 400).map(([date, types]) => ({ date, types })) });
}));

// ---------- overview ----------
reportsRouter.get('/overview', wrap(async (req, res) => {
  const p = range(req);
  const [sales, cn, purchase, dn] = await Promise.all(['sales', 'credit_note', 'purchase', 'debit_note'].map(t => docTotals(t, p)));
  const receipts = await one(`select count(*)::int n, coalesce(sum(amount),0) total,
      coalesce(sum(amount) filter (where mode='Cash'),0) cash, coalesce(sum(amount) filter (where mode<>'Cash'),0) bank
    from receipts where org_id=$1 and v_date between $2 and $3`, p);
  const asOn = await latestSnapshot(p[0], p[2]) || await latestSnapshot(p[0]);   // outstanding is a position: show the nearest one we have
  const daily = await q(`
    select d::text date, coalesce(s.taxable,0) sales, coalesce(r.amount,0) collected from
      (select doc_date d from doc_lines where ${W('sales')} union select v_date from receipts where org_id=$1 and v_date between $2 and $3) days
      left join (select doc_date, sum(taxable) taxable from doc_lines where ${W('sales')} group by 1) s on s.doc_date=days.d
      left join (select v_date, sum(amount) amount from receipts where org_id=$1 and v_date between $2 and $3 group by 1) r on r.v_date=days.d
    order by 1`, p);
  res.json({
    sales, credit_note: cn, purchase, debit_note: dn, receipts,
    net_sales: (await one(`select ($1::numeric - $2::numeric) v`, [sales.taxable, cn.taxable])).v,
    outstanding: await outstandingSummary(p[0], asOn),
    brands: await byBrand('sales', p, 8),
    daily,
  });
}));

// ---------- sales ----------
reportsRouter.get('/sales', wrap(async (req, res) => {
  const p = range(req);
  const totals = await docTotals('sales', p);
  const [brands, series, b2b, parties, skus, daily] = await Promise.all([
    byBrand('sales', p),
    q(`select coalesce(nullif(substring(doc_no from '^[A-Za-z]+'),''),'Numbers only') name, count(distinct doc_no)::int invoices, sum(taxable) taxable
       from doc_lines where ${W('sales')} group by 1 order by 3 desc`, p),
    q(`select coalesce(gstr1_section, case when gstin is null then 'B2C' else 'B2B' end) name, count(distinct doc_no)::int invoices,
          sum(taxable) taxable, sum(cgst+sgst+igst+cess) tax
       from doc_lines where ${W('sales')} group by 1 order by 1`, p),
    q(`select party_code code, max(party_name) name, count(distinct doc_no)::int bills, sum(qty) qty, sum(taxable) taxable
       from doc_lines where ${W('sales')} group by party_code order by sum(taxable) desc limit 25`, p),
    q(`select sku_code code, max(sku_name) name, max(brand) brand, sum(qty) qty, sum(taxable) taxable
       from doc_lines where ${W('sales')} group by sku_code order by sum(taxable) desc limit 25`, p),
    q(`select doc_date::text date, sum(taxable) taxable, count(distinct doc_no)::int invoices from doc_lines where ${W('sales')} group by 1 order by 1`, p),
  ]);
  res.json({ totals, brands, series, b2b, parties, skus, daily,
    round_off: (await one(`select ($1::numeric - $2::numeric - $3::numeric) v`, [totals.value, totals.taxable, totals.tax])).v });
}));

// ---------- GST ----------
reportsRouter.get('/gst', wrap(async (req, res) => {
  const p = range(req);
  const [sales, cn, purchase, dn] = await Promise.all(['sales', 'credit_note', 'purchase', 'debit_note'].map(t => docTotals(t, p)));
  const pos = await one(`select ($1::numeric - $2::numeric) net_output, ($3::numeric - $4::numeric) net_input,
     ($1::numeric - $2::numeric) - ($3::numeric - $4::numeric) position`, [sales.tax, cn.tax, purchase.tax, dn.tax]);
  const hsn = await q(`select hsn, string_agg(distinct brand, ', ') brands, sum(qty) qty, sum(taxable) taxable,
      sum(cgst) cgst, sum(sgst) sgst, sum(igst) igst, sum(cess) cess, sum(cgst+sgst+igst+cess) tax
    from doc_lines where ${W('sales')} group by hsn order by sum(taxable) desc`, p);
  const rates = await q(`select (cgst_pct+sgst_pct+igst_pct)::text rate, sum(taxable) taxable, sum(cgst) cgst, sum(sgst) sgst, sum(igst) igst, sum(cess) cess
    from doc_lines where ${W('sales')} group by 1 order by 1`, p);
  const noGstin = await one(`select count(distinct doc_no)::int invoices, coalesce(sum(taxable),0) taxable from doc_lines
    where ${W('sales')} and upper(coalesce(party_type,''))='REGISTERED' and gstin is null`, p);
  res.json({ sales, credit_note: cn, purchase, debit_note: dn, ...pos, hsn, rates, no_gstin: noGstin });
}));

// ---------- returns ----------
reportsRouter.get('/returns', wrap(async (req, res) => {
  const p = range(req);
  const [cn, dn, sales] = await Promise.all([docTotals('credit_note', p), docTotals('debit_note', p), docTotals('sales', p)]);
  const [cnList, cnTypes, cnBrands, dnBrands, dnSkus, dnList] = await Promise.all([
    q(`select doc_no, doc_date::text date, max(party_name) party, max(note_type) type, count(*)::int lines, sum(qty) qty, max(doc_value) value
       from doc_lines where ${W('credit_note')} group by doc_no, doc_date order by doc_date, doc_no`, p),
    q(`select coalesce(note_type,'Not given') name, count(distinct doc_no)::int notes, sum(taxable) taxable, sum(cgst+sgst+igst+cess) tax
       from doc_lines where ${W('credit_note')} group by 1 order by 3 desc`, p),
    byBrand('credit_note', p),
    byBrand('debit_note', p),
    q(`select max(sku_name) name, sum(qty) qty, sum(taxable) taxable from doc_lines where ${W('debit_note')}
       group by sku_code order by sum(taxable) desc limit 15`, p),
    q(`select doc_no, doc_date::text date, max(party_name) party, count(*)::int lines, sum(qty) qty, max(doc_value) value
       from doc_lines where ${W('debit_note')} group by doc_no, doc_date order by doc_date`, p),
  ]);
  res.json({ credit_note: cn, debit_note: dn, sales_taxable: sales.taxable, cn_list: cnList, cn_types: cnTypes,
    cn_brands: cnBrands, dn_brands: dnBrands, dn_skus: dnSkus, dn_list: dnList });
}));

// ---------- purchases ----------
reportsRouter.get('/purchases', wrap(async (req, res) => {
  const p = range(req);
  const totals = await docTotals('purchase', p);
  const [bills, brands] = await Promise.all([
    q(`select doc_no, doc_date::text date, max(supplier_bill_no) bill_no, max(supplier_bill_date)::text bill_date, max(party_name) supplier,
          count(*)::int lines, sum(qty) qty, sum(taxable) taxable, sum(cgst+sgst+igst+cess) tax, max(doc_value) value
       from doc_lines where ${W('purchase')} group by doc_no, doc_date order by doc_date, doc_no`, p),
    byBrand('purchase', p),
  ]);
  res.json({ totals, bills, brands });
}));

// ---------- collections ----------
reportsRouter.get('/collections', wrap(async (req, res) => {
  const p = range(req);
  const R = `org_id=$1 and v_date between $2 and $3`;
  const [totals, modes, people, parties, cheques, accounts, daily] = await Promise.all([
    one(`select count(*)::int n, coalesce(sum(amount),0) total from receipts where ${R}`, p),
    q(`select mode name, count(*)::int n, sum(amount) amount from receipts where ${R} group by 1 order by 3 desc`, p),
    q(`select collected_by name, count(*)::int n, sum(amount) amount from receipts where ${R} group by 1 order by 3 desc`, p),
    q(`select max(party_name) name, count(*)::int n, sum(amount) amount from receipts where ${R}
       group by coalesce(party_code, party_name) order by 3 desc limit 20`, p),
    q(`select v_no, v_date::text date, party_name, bank, cheque_no, cheque_date::text cheque_date, amount from receipts
       where ${R} and mode='Cheque' order by cheque_date nulls last, v_no`, p),
    q(`select account name, count(*)::int n, sum(amount) amount from receipts where ${R} group by 1 order by 3 desc`, p),
    q(`select v_date::text date, sum(amount) amount, count(*)::int n from receipts where ${R} group by 1 order by 1`, p),
  ]);
  const chequeTotal = (await one(`select coalesce(sum(amount),0) v from receipts where ${R} and mode='Cheque'`, p)).v;
  res.json({ totals, modes, people, parties, cheques, cheque_total: chequeTotal, accounts, daily });
}));

// ---------- outstanding ----------
reportsRouter.get('/outstanding', wrap(async (req, res) => {
  const org = req.user.org_id;
  const snapshots = (await q(`select as_on::text d from outstanding_bills where org_id=$1 group by 1 order by 1 desc limit 60`, [org])).map(r => r.d);
  const asOn = ISO.test(req.query.as_on || '') ? req.query.as_on : await latestSnapshot(org, ISO.test(req.query.to || '') ? req.query.to : null) || snapshots[0];
  if (!asOn) return res.json({ snapshots, summary: null });
  const p = [org, asOn];
  const [summary, salesmen, parties, oldest] = await Promise.all([
    outstandingSummary(org, asOn),
    q(`select salesman name, count(*)::int bills,
          coalesce(sum(balance) filter (where age_weeks <= 1),0) b1, coalesce(sum(balance) filter (where age_weeks between 2 and 4),0) b2,
          coalesce(sum(balance) filter (where age_weeks between 5 and 8),0) b3, coalesce(sum(balance) filter (where age_weeks between 9 and 12),0) b4,
          coalesce(sum(balance) filter (where age_weeks > 12),0) b5, sum(balance) total
       from outstanding_bills where org_id=$1 and as_on=$2 group by 1 order by sum(balance) desc`, p),
    q(`select coalesce(party_code,'') code, max(party_name) name, max(salesman) salesman, count(*)::int bills, max(age_weeks) oldest, sum(balance) balance
       from outstanding_bills where org_id=$1 and as_on=$2 group by coalesce(party_code, party_name), party_code order by sum(balance) desc limit 25`, p),
    q(`select bill_date::text date, bill_no, party_name, salesman, age_weeks, balance from outstanding_bills
       where org_id=$1 and as_on=$2 order by age_weeks desc, bill_date limit 20`, p),
  ]);
  res.json({ snapshots, as_on: asOn, summary, salesmen, parties, oldest });
}));

// "How much does this party owe?" — search box on the Outstanding page
reportsRouter.get('/outstanding/search', wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ bills: [] });
  const asOn = ISO.test(req.query.as_on || '') ? req.query.as_on : await latestSnapshot(req.user.org_id);
  const bills = await q(`select bill_date::text date, bill_no, party_name, party_code, salesman, bill_amount, received, balance, age_weeks
    from outstanding_bills where org_id=$1 and as_on=$2 and (party_name ilike $3 or party_code ilike $3 or bill_no ilike $3)
    order by party_name, bill_date limit 300`, [req.user.org_id, asOn, '%' + term.replace(/[%_]/g, '') + '%']);
  res.json({ as_on: asOn, bills });
}));
