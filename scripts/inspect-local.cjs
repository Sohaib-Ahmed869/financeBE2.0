const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient('mongodb://127.0.0.1:27017');
  try {
    await c.connect();
    const { databases } = await c.db().admin().listDatabases();
    for (const d of databases) {
      if (!['hff_master', 'hff_paris', 'hff_bordeaux', 'hff_lyon'].includes(d.name)) continue;
      const db = c.db(d.name);
      const cols = await db.listCollections().toArray();
      console.log(`\n# ${d.name}`);
      for (const col of cols) {
        const n = await db.collection(col.name).countDocuments();
        console.log(`  ${col.name}: ${n}`);
      }
    }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  } finally {
    await c.close();
  }
})();
