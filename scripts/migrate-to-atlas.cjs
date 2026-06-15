/**
 * One-shot migration: local MongoDB -> Atlas (testdbpayments cluster).
 * Copies hff_master + hff_paris data, creates hff_bordeaux + hff_lyon structure,
 * then re-encrypts the Company.mongoUri docs to the new Atlas URIs.
 * Shows live percentage progress.
 */
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const SRC = 'mongodb://127.0.0.1:27017';
const ATLAS_BASE = 'mongodb+srv://sohaibsipra869:nvidia940MX@testdbpayments.tryds9j.mongodb.net';
const ATLAS_OPTS = 'retryWrites=true&w=majority&appName=TESTDBPAYMENTS';
const KEY = Buffer.from('2efcd57777f7baf37c997b46d341287b83322acc2c664b9ce89a0c307b5558fa', 'hex');

const DBS = ['hff_master', 'hff_paris', 'hff_bordeaux', 'hff_lyon'];
const BATCH = 1000;

const atlasUriFor = (db) => `${ATLAS_BASE}/${db}?${ATLAS_OPTS}`;
const tenantUriForKey = (key) => atlasUriFor(`hff_${key}`);

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

const bar = (pct) => {
  const n = Math.round(pct / 5);
  return '[' + '#'.repeat(n) + '-'.repeat(20 - n) + ']';
};

(async () => {
  const startedAt = Date.now();
  const src = new MongoClient(SRC, { serverSelectionTimeoutMS: 15000 });
  const dst = new MongoClient(atlasUriFor('admin'), { serverSelectionTimeoutMS: 20000 });
  await src.connect();
  await dst.connect();
  console.log('Connected to local source and Atlas destination.\n');

  // --- Plan: gather collections + counts, compute grand total ---
  const plan = [];
  let grandTotal = 0;
  for (const dbName of DBS) {
    const sdb = src.db(dbName);
    const cols = (await sdb.listCollections().toArray())
      .filter((c) => c.type === 'collection' && !c.name.startsWith('system.'));
    for (const col of cols) {
      const count = await sdb.collection(col.name).countDocuments();
      plan.push({ dbName, name: col.name, count });
      grandTotal += count;
    }
  }
  console.log(`Migrating ${plan.length} collections across ${DBS.length} databases — ${grandTotal} documents total.\n`);

  let migrated = 0;
  for (const { dbName, name, count } of plan) {
    const sCol = src.db(dbName).collection(name);
    const dCol = dst.db(dbName).collection(name);

    // Idempotent: drop dest collection if present, recreate fresh.
    await dCol.drop().catch(() => {});
    await dst.db(dbName).createCollection(name).catch(() => {});

    // Copy indexes (skip default _id_).
    const idx = await sCol.indexes();
    const toCreate = idx
      .filter((i) => i.name !== '_id_')
      .map((i) => ({ key: i.key, name: i.name, unique: !!i.unique, sparse: !!i.sparse }));
    if (toCreate.length) await dCol.createIndexes(toCreate).catch((e) => console.log(`  idx warn ${dbName}.${name}: ${e.message}`));

    if (count === 0) {
      const overall = grandTotal ? ((migrated / grandTotal) * 100) : 100;
      console.log(`${bar(overall)} ${overall.toFixed(1)}%  ${dbName}.${name}: empty (structure created)`);
      continue;
    }

    let done = 0;
    const cursor = sCol.find({}, { noCursorTimeout: false }).batchSize(BATCH);
    let buf = [];
    const flush = async () => {
      if (!buf.length) return;
      await dCol.insertMany(buf, { ordered: false });
      done += buf.length;
      migrated += buf.length;
      buf = [];
      const overall = (migrated / grandTotal) * 100;
      const colPct = (done / count) * 100;
      console.log(`${bar(overall)} ${overall.toFixed(1)}%  ${dbName}.${name}  ${done}/${count} (${colPct.toFixed(0)}%)`);
    };
    for await (const doc of cursor) {
      buf.push(doc);
      if (buf.length >= BATCH) await flush();
    }
    await flush();
  }

  console.log('\nData copy complete. Re-pointing Company.mongoUri docs to Atlas...');
  const companies = dst.db('hff_master').collection('companies');
  for (const key of ['paris', 'bordeaux', 'lyon']) {
    const uri = tenantUriForKey(key);
    const res = await companies.updateOne({ key }, { $set: { mongoUri: encrypt(uri) } });
    console.log(`  ${key}: ${res.matchedCount ? 'updated' : 'NOT FOUND'} -> ${uri}`);
  }

  // --- Verify destination counts ---
  console.log('\nVerification (dest doc counts):');
  let ok = true;
  for (const { dbName, name, count } of plan) {
    const got = await dst.db(dbName).collection(name).countDocuments();
    if (got !== count) {
      ok = false;
      console.log(`  MISMATCH ${dbName}.${name}: src=${count} dst=${got}`);
    }
  }
  console.log(ok ? '  All collection counts match source. ✅' : '  ⚠ Some counts mismatch (see above).');

  await src.close();
  await dst.close();
  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
})().catch((e) => {
  console.error('\nMIGRATION FAILED:', e);
  process.exit(1);
});
