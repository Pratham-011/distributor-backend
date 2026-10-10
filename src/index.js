process.env.TZ = 'UTC';   // Excel dates are calendar dates; keep the server clock out of it
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { db, migrate } from './db.js';
import { ensureBucket, storageKind } from './storage.js';
import { authRouter, usersRouter, orgRouter, OTP_DEMO } from './auth.js';
import { uploadsRouter, templatesRouter, purgeDeleted } from './routes/uploads.js';
import { reportsRouter } from './routes/reports.js';
import { activityRouter } from './routes/activity.js';
import { errorHandler } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, db: db.kind, storage: storageKind, otp_demo: OTP_DEMO }));
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/org', orgRouter);
app.use('/api/activity', activityRouter);
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
