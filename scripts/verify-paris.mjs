import { MongoClient } from 'mongodb';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const LOCAL_URI = process.env.LOCAL_PARIS_MONGO_URI || 'mongodb://127.0.0.1:27017/hff_paris';
const ATLAS_URI = process.env.TENANT_PARIS_MONGO_URI;

// Hash the sorted list of _id strings — identical hash => identical _id sets.
async function fingerprint(db) {
  const cols = (await db.listCollections().toArray())
    .filter((c) => c.type === 'collection')
    .map((c) => c.name)
    .sort();
  const out = {};
  for (const name of cols) {
    const col = db.collection(name);
    const count = await col.countDocuments();
    const ids = await col.find({}, { projection: { _id: 1 } }).map((d) => String(d._id)).toArray();
    ids.sort();
    const hash = crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 12);
    out[name] = { count, hash };
  }
  return out;
}

async function load(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    return await fingerprint(client.db());
  } finally {
    await client.close().catch(() => {});
  }
}

const [src, dst] = await Promise.all([load(LOCAL_URI), load(ATLAS_URI)]);
const names = [...new Set([...Object.keys(src), ...Object.keys(dst)])].sort();

let allMatch = true;
console.log('collection                    local(cnt/hash)        atlas(cnt/hash)        match');
for (const n of names) {
  const s = src[n] || { count: '-', hash: '-' };
  const d = dst[n] || { count: '-', hash: '-' };
  const ok = s.count === d.count && s.hash === d.hash;
  if (!ok && (s.count || d.count)) allMatch = false;
  const sCol = `${s.count}/${s.hash}`.padEnd(22);
  const dCol = `${d.count}/${d.hash}`.padEnd(22);
  console.log(`${n.padEnd(28)}  ${sCol} ${dCol} ${ok ? 'OK' : 'DIFF'}`);
}
console.log(`\nRESULT: ${allMatch ? 'IDENTICAL — local and Atlas Paris are fully in sync' : 'DIFFERENCES FOUND — see DIFF rows above'}`);
process.exit(0);
