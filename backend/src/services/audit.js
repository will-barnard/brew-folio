// Append-only record of every edit. Takes a client so it commits (or rolls
// back) with the change it describes.
async function audit(db, { actor, action, entity, entityId, before = null, after = null }) {
  await db.query(
    `INSERT INTO audit_log (actor, action, entity, entity_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor || 'system', action, entity, entityId == null ? null : String(entityId),
      before && JSON.stringify(before), after && JSON.stringify(after)],
  );
}

module.exports = { audit };
