const db = require('better-sqlite3')('.pueblo/test.db', {readonly: true});
const rows = db.prepare(`
  SELECT id, createdAt, sessionId, weight, kind, tags
  FROM memory_records
  WHERE sessionId IN (
    SELECT id FROM sessions WHERE humanFriendlyId = ?
  )
  ORDER BY weight DESC, createdAt ASC
  LIMIT 50
`).all('loop-mod3');
console.log('Total rows:', rows.length);
rows.forEach(r => {
  let tagsShort = (r.tags || '').substring(0, 100);
  let idShort = r.id.substring(0, 40);
  console.log(`${idShort} | w=${r.weight} | kind=${r.kind} | tags=${tagsShort}`);
});
db.close();
