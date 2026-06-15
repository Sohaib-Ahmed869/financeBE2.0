const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const ATLAS = 'mongodb+srv://sohaibsipra869:nvidia940MX@testdbpayments.tryds9j.mongodb.net/?appName=TESTDBPAYMENTS';
const KEY = Buffer.from('2efcd57777f7baf37c997b46d341287b83322acc2c664b9ce89a0c307b5558fa', 'hex');

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

(async () => {
  // 1. Atlas reachability
  const t0 = Date.now();
  const a = new MongoClient(ATLAS, { serverSelectionTimeoutMS: 15000 });
  try {
    await a.connect();
    await a.db('admin').command({ ping: 1 });
    console.log(`ATLAS OK (${Date.now() - t0}ms)`);
    const { databases } = await a.db().admin().listDatabases();
    console.log('Atlas existing dbs:', databases.map((d) => d.name).join(', '));
  } catch (e) {
    console.error('ATLAS FAIL:', e.message);
  } finally {
    await a.close();
  }

  // 2. Decrypt existing company URIs from local master
  const l = new MongoClient('mongodb://127.0.0.1:27017');
  try {
    await l.connect();
    const companies = await l.db('hff_master').collection('companies').find({}).toArray();
    console.log('\nCompanies in local master:');
    for (const c of companies) {
      let uri = '(none)';
      try { uri = decrypt(c.mongoUri); } catch (e) { uri = 'DECRYPT_ERR: ' + e.message; }
      console.log(`  key=${c.key} name=${c.name} mongoUri=${uri}`);
    }
  } catch (e) {
    console.error('LOCAL FAIL:', e.message);
  } finally {
    await l.close();
  }
})();
