const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const ATLAS = 'mongodb+srv://sohaibsipra869:nvidia940MX@testdbpayments.tryds9j.mongodb.net/admin?retryWrites=true&w=majority&appName=TESTDBPAYMENTS';
const KEY = Buffer.from('2efcd57777f7baf37c997b46d341287b83322acc2c664b9ce89a0c307b5558fa', 'hex');
function decrypt(p) {
  const b = Buffer.from(p, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
(async () => {
  const c = new MongoClient(ATLAS);
  await c.connect();
  const { databases } = await c.db().admin().listDatabases();
  const hff = databases.filter((d) => d.name.startsWith('hff_')).map((d) => d.name);
  console.log('hff_* databases on Atlas:', hff.join(', '));
  for (const db of ['hff_master', 'hff_paris', 'hff_bordeaux', 'hff_lyon']) {
    const cols = await c.db(db).listCollections().toArray();
    let docs = 0;
    for (const col of cols) docs += await c.db(db).collection(col.name).countDocuments();
    console.log(`  ${db}: ${cols.length} collections, ${docs} docs`);
  }
  console.log('\nCompany.mongoUri (decrypted from Atlas master):');
  for (const co of await c.db('hff_master').collection('companies').find({}).toArray()) {
    console.log(`  ${co.key} -> ${decrypt(co.mongoUri)}`);
  }
  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
