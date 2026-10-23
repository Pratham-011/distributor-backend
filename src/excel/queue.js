// Reading an Excel file holds every cell in memory, so files are read one at a time (PARSE_CONCURRENCY to change).
// The rest wait their turn here instead of all reading at once and running the server out of memory.
// Each request can carry an X-Job-Id header; GET /api/uploads/progress/:id then says where it is in the line.
import crypto from 'node:crypto';

const LIMIT = Math.max(1, Number(process.env.PARSE_CONCURRENCY) || 1);
let running = 0;
const waiting = [];          // [{ id, start }] in arrival order
const reading = new Set();   // ids being read now

export const jobIdOf = req => {
  const id = String(req.get('X-Job-Id') || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : crypto.randomUUID();
};

/** Runs fn when it's this job's turn. */
export async function inLine(id, fn) {
  if (running >= LIMIT) await new Promise(start => waiting.push({ id, start }));
  running++;
  reading.add(id);
  try {
    return await fn();
  } finally {
    reading.delete(id);
    running--;
    waiting.shift()?.start();
  }
}

/** Where a job is: waiting (with how many are ahead of it), reading, or not known (finished or never seen). */
export function jobState(id) {
  if (reading.has(id)) return { state: 'reading' };
  const i = waiting.findIndex(w => w.id === id);
  return i >= 0 ? { state: 'waiting', ahead: i + running } : { state: 'unknown' };
}
