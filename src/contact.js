// Where customers reach Reportly, and where their requests are emailed. Everything can be changed with environment variables.
const list = (v, fallback) => String(v ?? fallback).split(',').map(s => s.trim()).filter(Boolean);

export const CONTACT = {
  phones: list(process.env.SUPPORT_PHONE, '98928 41898,81692 25516'),
  whatsapp: String(process.env.SUPPORT_WHATSAPP ?? '919892841898').replace(/[^0-9]/g, '') || null,
  email: process.env.SUPPORT_EMAIL ?? 'app.reportly@gmail.com',
  hours: process.env.SUPPORT_HOURS || null,
  text: process.env.SUPPORT_CONTACT || null,
};
// every request is emailed to REQUEST_TO, with REQUEST_CC copied
export const REQUEST_TO = process.env.REQUEST_TO || 'app.reportly@gmail.com';
export const REQUEST_CC = list(process.env.REQUEST_CC, 'pratham.ds02@gmail.com,kunj.mm@gmail.com');
