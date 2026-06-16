import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const LOCAL_URI = process.env.LOCAL_PARIS_MONGO_URI || 'mongodb://127.0.0.1:27017/hff_paris';
const ATLAS_URI = process.env.TENANT_PARIS_MONGO_URI;

async function summarize(label, uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = client.db(); // db name taken from the URI path
    const cols = await db.listCollections().toArray();
    const rows = [];
    for (const c of cols.filter((c) => c.type === 'collection')) {
      const count = await db.collection(c.name).estimatedDocumentCount();
      rows.push({ collection: c.name, docs: count });
    }
    rows.sort((a, b) => a.collection.localeCompare(b.collection));
    console.log(`\n=== ${label} ===`);
    console.log(`uri db: ${db.databaseName}`);
    if (!rows.length) console.log('  (no collections)');
    for (const r of rows) console.log(`  ${r.collection.padEnd(28)} ${r.docs}`);
    return rows;
  } catch (e) {
    console.log(`\n=== ${label} ===`);
    console.log(`  ERROR: ${e.message}`);
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

await summarize('SOURCE  local hff_paris', LOCAL_URI);
await summarize('TARGET  Atlas hff_paris', ATLAS_URI);
process.exit(0);
