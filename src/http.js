export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Express 5 forwards rejected promises already; this keeps handlers uniform.
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'This file is too big. Each file can be at most 50 MB.' });
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again; if it keeps happening, tell support.' });
}
