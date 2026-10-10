// Original files are gzip-compressed and kept so any number can be traced back.
//  - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set -> Supabase Storage bucket (private)
//  - otherwise -> ./data/files on local disk (demo)
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const BUCKET = process.env.SUPABASE_BUCKET || 'uploads';
const LOCAL_DIR = process.env.LOCAL_FILES_DIR || './data/files';

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export const storageKind = supabase ? 'supabase' : 'local';

export async function ensureBucket() {
  if (!supabase) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
}

/** Compress and store. Returns the number of bytes stored. */
export async function putFile(key, buffer) {
  const gz = await gzip(buffer, { level: 9 });
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(key, gz, {
      contentType: 'application/gzip', upsert: true,
    });
    if (error) throw new Error('Could not save file to storage: ' + error.message);
  } else {
    const p = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, gz);
  }
  return gz.length;
}

/** Fetch and decompress. */
export async function getFile(key) {
  let gz;
  if (supabase) {
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error) throw new Error('Could not read file from storage: ' + error.message);
    gz = Buffer.from(await data.arrayBuffer());
  } else {
    gz = await fs.readFile(path.join(LOCAL_DIR, key));
  }
  return gunzip(gz);
}

/** Deletes for good. Throws if Supabase refuses, so the caller can keep track and try again. */
export async function removeFile(key) {
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).remove([key]);
    if (error) throw new Error('Could not delete file from storage: ' + error.message);
  } else {
    await fs.rm(path.join(LOCAL_DIR, key), { force: true });
  }
}
