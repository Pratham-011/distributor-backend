// The six daily files and the fields we need from each.
// `match` = header names (lower-case, spaces/punctuation removed) we auto-pick.
// kind: date | text | money (2 dp) | qty | rate (4 dp) | pct | int

const lineFields = (dateLabel, noLabel, partyWord) => [
  { key: 'doc_date', label: dateLabel, kind: 'date', required: true, match: ['invdate', 'vdate', 'date', 'billdate', 'cndate', 'dndate'] },
  { key: 'doc_no', label: noLabel, kind: 'text', required: true, match: ['invno', 'vno', 'billno', 'cnno', 'dnno', 'voucherno'] },
  { key: 'party_code', label: `${partyWord} code`, kind: 'text', match: ['partycode', 'suppliercode', 'accode'] },
  { key: 'party_name', label: `${partyWord} name`, kind: 'text', match: ['partyname', 'suppliername', 'customername'] },
  { key: 'sku_code', label: 'Item code (SKU)', kind: 'text', required: true, match: ['skucode', 'itemcode', 'productcode'] },
  { key: 'sku_name', label: 'Item name', kind: 'text', required: true, match: ['skuname', 'itemname', 'productname'] },
  { key: 'hsn', label: 'HSN code', kind: 'text', match: ['hsncode', 'hsn'] },
  { key: 'qty', label: 'Quantity', kind: 'qty', required: true, match: ['qty', 'quantity'] },
  { key: 'rate', label: 'Rate', kind: 'rate', match: ['rate'] },
  { key: 'mrp', label: 'MRP', kind: 'money', match: ['mrp'] },
  { key: 'amount', label: 'Amount (before discount)', kind: 'money', match: ['amount', 'grossamount'] },
  { key: 'discount', label: 'Discount', kind: 'money', match: ['disc', 'discount'] },
  { key: 'taxable', label: 'Taxable amount', kind: 'money', required: true, match: ['taxableamount', 'taxable', 'taxablevalue'] },
  { key: 'igst_pct', label: 'IGST %', kind: 'pct', match: ['igst'] },
  { key: 'igst', label: 'IGST amount', kind: 'money', match: ['igstamt', 'igstamount'] },
  { key: 'cgst_pct', label: 'CGST %', kind: 'pct', match: ['cgst'] },
  { key: 'cgst', label: 'CGST amount', kind: 'money', required: true, match: ['cgstamt', 'cgstamount'] },
  { key: 'sgst_pct', label: 'SGST %', kind: 'pct', match: ['sgst'] },
  { key: 'sgst', label: 'SGST amount', kind: 'money', required: true, match: ['sgstamt', 'sgstamount'] },
  { key: 'cess_pct', label: 'Cess %', kind: 'pct', match: ['cess'] },
  { key: 'cess', label: 'Cess amount', kind: 'money', match: ['cessamt', 'cessamount'] },
  { key: 'net_amount', label: 'Bill total (net amount)', kind: 'money', match: ['netamount', 'net', 'billamount', 'total'] },
];

export const REPORT_TYPES = {
  sales: {
    key: 'sales', label: 'Sales Register', short: 'Sales', table: 'doc_lines',
    titles: ['gst sales register', 'sales register'],
    fields: [
      ...lineFields('Invoice date', 'Invoice number', 'Party'),
      { key: 'party_type', label: 'Registered / Unregistered', kind: 'text', match: ['partytype'] },
      { key: 'gstin', label: 'Party GSTIN', kind: 'text', match: ['gstrno', 'gstin', 'gstno'] },
      { key: 'gstr1_section', label: 'GSTR-1 section (B2B/B2C)', kind: 'text', match: ['gstr1'] },
    ],
  },
  purchase: {
    key: 'purchase', label: 'Purchase Register', short: 'Purchase', table: 'doc_lines',
    titles: ['gst purchase register', 'purchase register'],
    fields: [
      ...lineFields('Voucher date', 'Voucher number', 'Supplier'),
      { key: 'supplier_bill_no', label: "Supplier's bill number", kind: 'text', match: ['billno'] },
      { key: 'supplier_bill_date', label: "Supplier's bill date", kind: 'date', match: ['billdate'] },
    ],
  },
  credit_note: {
    key: 'credit_note', label: 'Credit Note Register', short: 'Credit notes', table: 'doc_lines',
    titles: ['gst credit note register', 'credit note register'],
    fields: [
      ...lineFields('Credit note date', 'Credit note number', 'Party'),
      { key: 'gstin', label: 'Party GSTIN', kind: 'text', match: ['gstrno', 'gstin', 'gstno'] },
      { key: 'note_type', label: 'Return type', kind: 'text', match: ['crntype', 'returntype', 'type'] },
      { key: 'ref_no', label: 'Original invoice number', kind: 'text', match: ['refinvno'] },
      { key: 'ref_date', label: 'Original invoice date', kind: 'date', match: ['refinvdate'] },
    ],
  },
  debit_note: {
    key: 'debit_note', label: 'Debit Note Register', short: 'Debit notes', table: 'doc_lines',
    titles: ['gst debit note register', 'debit note register'],
    fields: [
      ...lineFields('Debit note date', 'Debit note number', 'Supplier'),
      { key: 'ref_no', label: 'Original bill number', kind: 'text', match: ['refinvno'] },
      { key: 'ref_date', label: 'Original bill date', kind: 'date', match: ['refinvdate'] },
    ],
  },
  receipt: {
    key: 'receipt', label: 'Receipt Book', short: 'Receipts', table: 'receipts',
    titles: ['receipt book', 'receipt register'],
    fields: [
      { key: 'v_date', label: 'Receipt date', kind: 'date', required: true, match: ['voucherdate', 'vdate', 'date'] },
      { key: 'v_no', label: 'Receipt number', kind: 'text', required: true, match: ['vno', 'voucherno'] },
      { key: 'party_code', label: 'Party code', kind: 'text', match: ['accode', 'partycode'] },
      { key: 'party_name', label: 'Party name (paid by)', kind: 'text', required: true, match: ['creditaccount', 'partyname'] },
      { key: 'city', label: 'City', kind: 'text', match: ['city'] },
      { key: 'amount', label: 'Amount received', kind: 'money', required: true, match: ['amount'] },
      { key: 'account', label: 'Received into (cash / bank)', kind: 'text', required: true, match: ['debitaccount', 'account'] },
      { key: 'cheque_no', label: 'Cheque / UTR number', kind: 'text', match: ['chequeno', 'utr'] },
      { key: 'cheque_date', label: 'Cheque date', kind: 'date', match: ['chequedate'] },
      { key: 'bank', label: 'Bank', kind: 'text', match: ['bank'] },
      { key: 'collected_by', label: 'Collected by (salesman)', kind: 'text', match: ['salesman', 'collectedby'] },
    ],
  },
  outstanding: {
    key: 'outstanding', label: 'Outstanding Debtors', short: 'Outstanding', table: 'outstanding_bills',
    titles: ['outstanding debtors', 'outstanding'],
    fields: [
      { key: 'bill_date', label: 'Bill date', kind: 'date', required: true, match: ['date', 'billdate'] },
      { key: 'trn', label: 'Entry type', kind: 'text', match: ['trn'] },
      { key: 'bill_no', label: 'Bill number', kind: 'text', required: true, match: ['billno'] },
      { key: 'party_name', label: 'Party name', kind: 'text', required: true, match: ['partyname'] },
      { key: 'party_code', label: 'Party code', kind: 'text', match: ['partycode'] },
      { key: 'bill_amount', label: 'Bill amount', kind: 'money', required: true, match: ['billamount'] },
      { key: 'received', label: 'Amount received', kind: 'money', match: ['receipt', 'received'] },
      { key: 'balance', label: 'Balance due', kind: 'money', required: true, match: ['balance'] },
      { key: 'age_weeks', label: 'Age in weeks', kind: 'int', match: ['wk', 'weeks'] },
      { key: 'salesman', label: 'Salesman', kind: 'text', match: ['salesmanname', 'salesman'] },
    ],
  },
  // Delivery Report Collection: the bills that were delivered and settled (one file per load). It does not add sales of its
  // own; it tells the reports which bills are "settled". A bill is settled when its number appears in any uploaded file.
  // Files add up (several loads on one day), so a new file never replaces an earlier one unless it is the very same file.
  delivery: {
    key: 'delivery', label: 'Delivery Report Collection', short: 'Settled bills', table: 'settled_bills', additive: true,
    titles: ['delivery report collection'],
    // the file also holds #LINE and summary rows (CASH BILLS 22 ...): only rows with a bill number are bills
    keepRow: rec => /^\d+$/.test(String(rec.bill_no || '').trim()),
    fields: [
      { key: 'bill_no', label: 'Bill number', kind: 'text', required: true, match: ['billno'] },
      { key: 'series', label: 'Series (A, Z ...; empty = numbers only)', kind: 'text', match: ['series'] },
      { key: 'bill_ref', label: 'Bill number with series (like A\\15727)', kind: 'text', match: ['billno2'] },
      { key: 'party_name', label: 'Party name', kind: 'text', match: ['partyname'] },
      { key: 'bill_amount', label: 'Bill amount', kind: 'money', required: true, match: ['billamt', 'billamount'] },
      { key: 'cash', label: 'Cash', kind: 'money', match: ['cash'] },
      { key: 'cheque', label: 'Cheque', kind: 'money', match: ['cheque'] },
      { key: 'credit', label: 'Credit', kind: 'money', match: ['credit'] },
      { key: 'pending', label: 'Pending', kind: 'money', match: ['pending'] },
      { key: 'scheme', label: 'Scheme', kind: 'money', match: ['scheme'] },
      { key: 'cd', label: 'Cash discount (CD)', kind: 'money', match: ['cd'] },
    ],
  },
  // Closing stock / stock summary, "as on" a date (like Outstanding). Batch-wise files are fine: rows are added up per item.
  stock: {
    key: 'stock', label: 'Stock Statement', short: 'Stock', table: 'stock_items', snapshot: true,
    titles: ['stock statement', 'stock summary', 'closing stock', 'stock report', 'stock position', 'stock register', 'inventory'],
    fields: [
      { key: 'sku_code', label: 'Item code (SKU)', kind: 'text', required: true, match: ['skucode', 'itemcode', 'productcode', 'code'] },
      { key: 'sku_name', label: 'Item name', kind: 'text', required: true, match: ['skuname', 'itemname', 'productname', 'description', 'particulars', 'item'] },
      { key: 'opening_qty', label: 'Opening quantity', kind: 'qty', match: ['openingqty', 'opqty', 'opening', 'openingstock'] },
      { key: 'in_qty', label: 'Received (in) quantity', kind: 'qty', match: ['inwardqty', 'inqty', 'inward', 'receiptqty', 'purchaseqty'] },
      { key: 'out_qty', label: 'Issued (out) quantity', kind: 'qty', match: ['outwardqty', 'outqty', 'outward', 'issueqty', 'salesqty'] },
      { key: 'closing_qty', label: 'Closing quantity (in stock)', kind: 'qty', required: true,
        match: ['closingqty', 'clqty', 'closingstock', 'closing', 'stockqty', 'balanceqty', 'stock', 'qty', 'quantity'] },
      { key: 'rate', label: 'Rate (cost per unit)', kind: 'rate', match: ['rate', 'costrate', 'purchaserate', 'landingrate'] },
      { key: 'value', label: 'Stock value', kind: 'money', match: ['closingvalue', 'clvalue', 'stockvalue', 'value', 'amount'] },
      { key: 'mrp', label: 'MRP', kind: 'money', match: ['mrp'] },
      { key: 'batch', label: 'Batch', kind: 'text', match: ['batchno', 'batch'] },
      { key: 'expiry', label: 'Expiry date', kind: 'date', match: ['expirydate', 'expdate', 'expiry'] },
    ],
  },
};
export const SNAPSHOT_TYPES = Object.values(REPORT_TYPES).filter(t => t.snapshot || t.key === 'outstanding').map(t => t.key);

export const TYPE_LIST = Object.values(REPORT_TYPES).map(t => ({ key: t.key, label: t.label, short: t.short }));

export const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '').replace(/%/g, '');

/** Pick the best header for each field. Exact normalised matches first, never reuse a column. */
export function suggestMapping(typeKey, headers) {
  const t = REPORT_TYPES[typeKey];
  const used = new Set();
  const map = {};
  const normed = headers.map(h => ({ h, n: norm(h) }));
  // Raw header text for % columns ("IGST %") vs amount columns ("IGST Amt"): keep them apart
  const isPct = h => /%/.test(h);
  for (const f of t.fields) {
    for (const m of f.match) {
      const hit = normed.find(x => !used.has(x.h) && x.n === m && (f.kind === 'pct' ? isPct(x.h) : !isPct(x.h)));
      if (hit) { map[f.key] = hit.h; used.add(hit.h); break; }
    }
  }
  return map;
}
