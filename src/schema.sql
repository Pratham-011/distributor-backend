-- Reportly schema.
-- Run once in the Supabase SQL editor (the server also runs it on start; every statement is idempotent).

create table if not exists organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  created_at    timestamptz not null default now()
);

-- roles, lowest to highest: viewer < writer < admin < owner
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  email         text not null,
  name          text not null,
  password_hash text not null,
  role          text not null check (role in ('viewer','writer','admin','owner')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- people an owner/admin has added; they finish sign-up themselves with an OTP
create table if not exists invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('viewer','writer','admin','owner')),
  invited_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);

create table if not exists otps (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  purpose     text not null check (purpose in ('register','reset')),
  code_hash   text not null,
  payload     jsonb not null default '{}'::jsonb,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists otps_email_idx on otps (email, purpose);

-- saved column matching ("file formats"), one per org + report type + header signature
create table if not exists mapping_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  report_type   text not null,
  name          text not null,
  signature     text not null,
  headers       jsonb not null,
  header_row    int not null,
  mapping       jsonb not null,           -- { field_key: "Column header in file" }
  date_format   text not null default 'DMY',
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  times_used    int not null default 0,
  unique (org_id, report_type, signature)
);

create table if not exists uploads (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  report_type     text not null,
  file_name       text not null,
  file_hash       text not null,
  size_bytes      int not null,
  stored_bytes    int not null,
  storage_path    text not null,
  period_from     date,
  period_to       date,
  row_count       int not null default 0,
  status          text not null default 'active' check (status in ('active','replaced','deleted')),
  totals_ok       boolean not null default true,
  reconciliation  jsonb not null default '[]'::jsonb,
  issues          jsonb not null default '[]'::jsonb,
  template_id     uuid references mapping_templates(id) on delete set null,
  uploaded_by     uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists uploads_org_idx on uploads (org_id, report_type, status, period_from);

-- one row per SKU line for the four GST registers
create table if not exists doc_lines (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  upload_id     uuid not null references uploads(id) on delete cascade,
  doc_type      text not null check (doc_type in ('sales','purchase','credit_note','debit_note')),
  row_no        int not null,
  doc_date      date not null,
  doc_no        text not null,
  party_code    text,
  party_name    text,
  party_type    text,
  gstin         text,
  sku_code      text,
  sku_name      text,
  brand         text,
  hsn           text,
  qty           numeric(14,3) not null default 0,
  rate          numeric(14,4) not null default 0,
  mrp           numeric(14,2) not null default 0,
  amount        numeric(14,2) not null default 0,
  discount      numeric(14,2) not null default 0,
  taxable       numeric(14,2) not null default 0,
  igst_pct      numeric(6,2) not null default 0,
  igst          numeric(14,2) not null default 0,
  cgst_pct      numeric(6,2) not null default 0,
  cgst          numeric(14,2) not null default 0,
  sgst_pct      numeric(6,2) not null default 0,
  sgst          numeric(14,2) not null default 0,
  cess_pct      numeric(6,2) not null default 0,
  cess          numeric(14,2) not null default 0,
  net_amount    numeric(14,2) not null default 0,   -- document total as printed (repeated per line)
  doc_value     numeric(14,2) not null default 0,   -- document total we trust (printed, or computed if blank)
  gstr1_section text,
  note_type     text,
  ref_no        text,
  ref_date      date,
  supplier_bill_no   text,
  supplier_bill_date date
);
create index if not exists doc_lines_q on doc_lines (org_id, doc_type, doc_date);
create index if not exists doc_lines_upload on doc_lines (upload_id);

create table if not exists receipts (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  upload_id     uuid not null references uploads(id) on delete cascade,
  row_no        int not null,
  v_date        date not null,
  v_no          text not null,
  party_code    text,
  party_name    text,
  city          text,
  amount        numeric(14,2) not null,
  account       text,
  mode          text not null,           -- Cash | Cheque | Online
  cheque_no     text,
  cheque_date   date,
  bank          text,
  collected_by  text
);
create index if not exists receipts_q on receipts (org_id, v_date);

-- outstanding is a snapshot "as on" a date
create table if not exists outstanding_bills (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  upload_id     uuid not null references uploads(id) on delete cascade,
  row_no        int not null,
  as_on         date not null,
  bill_date     date,
  trn           text,
  bill_no       text not null,
  party_code    text,
  party_name    text,
  salesman      text,
  bill_amount   numeric(14,2) not null default 0,
  received      numeric(14,2) not null default 0,
  balance       numeric(14,2) not null default 0,
  age_weeks     int not null default 0
);
create index if not exists outstanding_q on outstanding_bills (org_id, as_on);

-- ---- added later (safe to re-run on an existing database) ----
-- GST state code of the business (first two digits of its GSTIN), used for the IGST check
alter table organizations add column if not exists state_code text;
-- how the file was read, so it can be read back exactly when a later upload is undone
alter table uploads add column if not exists import_settings jsonb;
alter table uploads add column if not exists undone_at timestamptz;
alter table uploads add column if not exists undone_by uuid references users(id) on delete set null;
alter table uploads drop constraint if exists uploads_status_check;
alter table uploads add constraint uploads_status_check check (status in ('active','replaced','deleted','undone'));

-- stock is a snapshot "as on" a date (from the Stock Statement / closing stock report); batch-wise files give several rows per item
create table if not exists stock_items (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  upload_id     uuid not null references uploads(id) on delete cascade,
  row_no        int not null,
  as_on         date not null,
  sku_code      text not null,
  sku_name      text,
  brand         text,
  batch         text,
  expiry        date,
  opening_qty   numeric(14,3),
  in_qty        numeric(14,3),
  out_qty       numeric(14,3),
  closing_qty   numeric(14,3) not null default 0,
  rate          numeric(14,4),
  mrp           numeric(14,2),
  value         numeric(14,2)
);
create index if not exists stock_q on stock_items (org_id, as_on);
create index if not exists stock_upload on stock_items (upload_id);
-- for "sold per day" and "estimated stock today" on the Stock page
create index if not exists doc_lines_sku on doc_lines (org_id, sku_code, doc_type, doc_date);

-- ---- platform (you, the software owner): subscription and access per business ----
alter table organizations add column if not exists status text not null default 'active';   -- active | paused
alter table organizations add column if not exists status_reason text;
alter table organizations add column if not exists plan_name text;
alter table organizations add column if not exists plan_price numeric(12,2);                  -- per billing period
alter table organizations add column if not exists billing_period text;                       -- monthly | quarterly | half_yearly | yearly | custom
alter table organizations add column if not exists setup_fee numeric(12,2);                    -- one-time
alter table organizations add column if not exists period_start date;
alter table organizations add column if not exists paid_until date;                            -- null = no end date
alter table organizations add column if not exists auto_off boolean not null default true;     -- block access after paid_until
alter table organizations add column if not exists billing_notes text;
create table if not exists org_payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  paid_on     date not null,
  amount      numeric(12,2) not null,
  kind        text not null,               -- setup | subscription | other
  period_from date,
  period_to   date,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists org_payments_q on org_payments (org_id, paid_on desc);
-- how much each person uses the app: one "block" = a 5-minute window in which they did something
alter table users add column if not exists last_seen_at timestamptz;
create table if not exists usage_blocks (
  user_id  uuid not null references users(id) on delete cascade,
  org_id   uuid not null references organizations(id) on delete cascade,
  day      date not null,
  blocks   int not null default 0,
  primary key (user_id, day)
);
create index if not exists usage_blocks_q on usage_blocks (org_id, day);

-- ---- seats, linked companies, sessions, platform settings and expenses ----
-- seats: 1 owner + included_users are in the plan (platform_settings); extra_users are bought on top
alter table organizations add column if not exists extra_users int not null default 0;
-- a second company bought by the same customer: its parent is the first company (billing is on the parent)
alter table organizations add column if not exists parent_org_id uuid references organizations(id) on delete set null;
alter table organizations add column if not exists trial boolean not null default false;      -- self-signed-up, not paid yet

-- one row per sign-in. A user can have only one live session (one device at a time).
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  org_id       uuid not null references organizations(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ip           text,
  user_agent   text,
  revoked_at   timestamptz,
  revoked_why  text          -- logout | other_device | admin | password | access_off
);
create index if not exists sessions_user on sessions (user_id, revoked_at);
create index if not exists sessions_org on sessions (org_id, created_at desc);

create table if not exists platform_settings (
  key   text primary key,
  value jsonb not null
);
create table if not exists platform_expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null,
  category    text not null,            -- hosting | database | domain | email | support | marketing | tools | other
  vendor      text,
  amount      numeric(12,2) not null,
  repeat      text,                      -- null = once, 'monthly' = every month from spent_on until ends_on
  ends_on     date,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists platform_expenses_q on platform_expenses (spent_on desc);
alter table org_payments drop constraint if exists org_payments_kind_check;

-- everything people do in the app, newest first
create table if not exists activity_log (
  id          bigserial primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  user_name   text,                      -- kept as it was at the time
  action      text not null,             -- group.verb, e.g. upload.saved
  message     text not null,
  details     jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists activity_log_q on activity_log (org_id, id desc);

-- ---- one person in several businesses, business profile, requests ----
-- The same email can have a row in each business it belongs to (own role, own seat); the rows share one password.
alter table users drop constraint if exists users_email_key;
create unique index if not exists users_org_email on users (org_id, email);
create index if not exists users_email on users (email);

alter table organizations add column if not exists address text;
alter table organizations add column if not exists gstin text;
alter table organizations add column if not exists phone text;
alter table organizations add column if not exists contact_email text;

-- what customers ask for: another business, another person, help, a bug. Also emailed to the support inbox.
create table if not exists requests (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  kind        text not null,                    -- add_business | add_user | support | bug | other
  subject     text not null,
  message     text not null default '',
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'new' check (status in ('new','in_progress','done','rejected')),
  admin_note  text,
  emailed     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists requests_org on requests (org_id, created_at desc);
create index if not exists requests_status on requests (status, created_at desc);

-- The app talks to Postgres directly from the server. Turning on row level security with no policies
-- blocks Supabase's public REST API (anon / authenticated keys) from reading these tables at all.
alter table organizations     enable row level security;
alter table users             enable row level security;
alter table invites           enable row level security;
alter table otps              enable row level security;
alter table mapping_templates enable row level security;
alter table uploads           enable row level security;
alter table doc_lines         enable row level security;
alter table receipts          enable row level security;
alter table outstanding_bills enable row level security;
alter table activity_log      enable row level security;
alter table stock_items       enable row level security;
alter table org_payments      enable row level security;
alter table usage_blocks      enable row level security;
alter table sessions          enable row level security;
alter table platform_settings enable row level security;
alter table platform_expenses enable row level security;
alter table requests          enable row level security;
