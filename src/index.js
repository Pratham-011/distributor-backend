process.env.TZ = 'UTC';   // Excel dates are calendar dates; keep the server clock out of it
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { db, migrate } from './db.js';
import { ensureBucket, storageKind } from './storage.js';
import { authRouter, usersRouter, orgRouter, OTP_DEMO } from './auth.js';
import { uploadsRouter, templatesRouter, purgeDeleted } from './routes/uploads.js';
import { reportsRouter } from './routes/reports.js';
import { activityRouter } from './routes/activity.js';
import { platformRouter } from './routes/platform.js';
import { requestsRouter } from './routes/requests.js';
import { CONTACT } from './contact.js';
import { errorHandler } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
// Render (and most hosts) put a proxy in front: trust its address header so client IPs, rate limits and logs are real
app.set('trust proxy', process.env.TRUST_PROXY === undefined ? 1 : Number(process.env.TRUST_PROXY));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
// API answers are data only: nothing in them may ever be run or framed
app.use('/api', (_req, res, next) => { res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"); res.set('Cache-Control', 'no-store'); next(); });
// every API call, per IP: far above normal use, a brake on scripts
if (!(process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_DISABLED === '1')) {
  app.use('/api', rateLimit({ windowMs: 60000, limit: 900, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down and try again in a minute.' }) }));
}
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '1mb' }));

// Where users can reach you (no login needed: also shown on the login page)
app.get('/api/support', (_req, res) => res.json({ phone: CONTACT.phones[0] || null, phones: CONTACT.phones, whatsapp: CONTACT.whatsapp, email: CONTACT.email, hours: CONTACT.hours, text: CONTACT.text }));
app.get('/api/health', (_req, res) => res.json({ ok: true, db: db.kind, storage: storageKind, otp_demo: OTP_DEMO }));
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/org', orgRouter);
app.use('/api/activity', activityRouter);
app.use('/api/platform', platformRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app (npm run build in /web) from the same server in production
const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: '1h', index: false }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}
app.use(errorHandler);

await migrate();
await ensureBucket();
purgeDeleted().catch(e => console.error('[delete] retry failed:', e.message));
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Server on http://localhost:${port}  (database: ${db.kind}, files: ${storageKind}, demo OTP: ${OTP_DEMO})`);
});
