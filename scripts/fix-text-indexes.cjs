const { MongoClient } = require('mongodb');
const SRC = 'mongodb://127.0.0.1:27017';
const ATLAS_BASE = 'mongodb+srv://sohaibsipra869:nvidia940MX@testdbpayments.tryds9j.mongodb.net';
const ATLAS_OPTS = 'retryWrites=true&w=majority&appName=TESTDBPAYMENTS';

const TARGETS = [
  { db: 'hff_paris', col: 'customers' },
  { db: 'hff_paris', col: 'items' },
];

(async () => {
  const src = new MongoClient(SRC);
  const dst = new MongoClient(`${ATLAS_BASE}/admin?${ATLAS_OPTS}`);
  await src.connect();
  await dst.connect();

  for (const { db, col } of TARGETS) {
    const idx = await src.db(db).collection(col).indexes();
    const text = idx.find((i) => i.key && i.key._fts === 'text');
    if (!text) { console.log(`${db}.${col}: no text index in source, skipping`); continue; }

    // Rebuild a proper text-index key from weights, preserving options.
    const key = {};
    for (const f of Object.keys(text.weights || {})) key[f] = 'text';
    const opts = {
      name: text.name,
      weights: text.weights,
      default_language: text.default_language,
      language_override: text.language_override,
    };
    Object.keys(opts).forEach((k) => opts[k] === undefined && delete opts[k]);

    const dCol = dst.db(db).collection(col);
    await dCol.createIndex(key, opts);
    console.log(`${db}.${col}: created text index '${text.name}' on ${Object.keys(key).join(', ')}`);
  }

  // Show final index sets on Atlas.
  for (const { db, col } of TARGETS) {
    const names = (await dst.db(db).collection(col).indexes()).map((i) => i.name);
    console.log(`  ${db}.${col} indexes: ${names.join(', ')}`);
  }

  await src.close();
  await dst.close();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
