// Email through Brevo (https://www.brevo.com): sign-up and password-reset codes, "you were added" emails and customer requests.
//   BREVO_API_KEY      an API key from Brevo (SMTP & API -> API Keys)
//   MAIL_FROM_EMAIL    the sender: must be a sender you verified in Brevo (default app.reportly@gmail.com)
//   MAIL_FROM_NAME     the name people see (default Reportly)
//   APP_URL            the web address of the app, used in the "you were added" email
const { BREVO_API_KEY, MAIL_FROM_EMAIL = 'app.reportly@gmail.com', MAIL_FROM_NAME = 'Reportly' } = process.env;
const API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';   // changed only by tests
export const mailReady = !!BREVO_API_KEY;
export const APP_URL = (process.env.APP_URL || String(process.env.CORS_ORIGIN || '').split(',')[0] || '').trim().replace(/\/+$/, '');

const addr = list => [].concat(list || []).filter(Boolean).map(email => ({ email }));

/** `opts`: cc (string or list), replyTo. Throws when Brevo refuses, with Brevo's own reason. */
export async function sendMail(to, subject, text, opts = {}) {
  if (!mailReady) throw new Error('Email is not set up (BREVO_API_KEY).');
  const body = { sender: { name: MAIL_FROM_NAME, email: MAIL_FROM_EMAIL }, to: addr(to), subject, textContent: text };
  if (opts.cc?.length) body.cc = addr(opts.cc);
  if (opts.replyTo) body.replyTo = { email: opts.replyTo };
  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new Error(`Could not reach Brevo: ${e.message}`); }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(`Brevo refused the email (${res.status}): ${d.message || d.code || 'unknown reason'}`);
  }
}

/** The email a person gets when an Owner or Admin adds them to a business. */
export function addedMail({ orgName, roleLabel, byName, existing }) {
  const url = APP_URL || 'the Reportly website';
  const lines = [`${byName} added you to ${orgName} on Reportly as ${roleLabel}.`, ''];
  if (existing) lines.push('You already have a Reportly login, so just log in with your usual email and password.', `Then choose "${orgName}" in the Business box at the top of the menu.`);
  else lines.push(`Open ${url}, choose "Create an account" and use THIS email address.`, 'You will get a code by email to confirm it, then you choose your own password.');
  lines.push('', url, '', 'If you were not expecting this, you can ignore this email.');
  return { subject: `You were added to ${orgName} on Reportly`, text: lines.join('\n') };
}
