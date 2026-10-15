// Phase 2 — dry-dock categorization. NOT BUILT YET; nothing calls this.
//
// Plan (docs/SCOPE.md §5):
//   - a nightly + post-import job batches ~25 uncategorized, non-transfer rows
//   - POST $DRYDOCK_BASE_URL/api/v1/generate with pool UNSET (survives a sleeping
//     MacBook), system prompt = category list + streams + ~30 of Will's own past
//     picks as few-shot, strict JSON out: [{ id, category_id, stream_id, confidence, reason }]
//   - validate every id against real categories; write rows to ai_suggestions
//     (status 'pending', with the worker/pool dry-dock reports) — never straight
//     onto the transaction until acceptance rates per category justify auto-apply
//   - 503 → defer to next run; 504 → halve the batch; 401/422 → fail loudly
//   - the review queue already reads ai_suggestions, so suggestions appear there
//     with no UI change
// Copy the Node client from dry-dock's DRYDOCK-API.md into src/lib/drydock.js.
const { notImplemented } = require('../lib/errors');

async function suggestCategories() {
  throw notImplemented('dry-dock categorization arrives in Phase 2');
}

module.exports = { suggestCategories };
