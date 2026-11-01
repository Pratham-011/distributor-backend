export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** router.param('id', uuidParam): an id that is not a UUID can't exist, so it is "not found" rather than a database error. */
export const uuidParam = (_req, _res, next, value) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? next() : next(new HttpError(404, 'Not found.')));

// Express 5 forwards rejected promises already; this keeps handlers uniform.
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `This file is too big. Each file can be at most ${Number(process.env.MAX_FILE_MB) || 25} MB.` });
  if (err?.code?.startsWith?.('LIMIT_')) return res.status(400).json({ error: 'Too many files, or a field that is too large.' });
  // the body reader's own refusals (too big, not valid JSON) are the sender's mistake, not ours
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again; if it keeps happening, tell support.' });
}
