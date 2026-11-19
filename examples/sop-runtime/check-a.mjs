import assert from 'node:assert/strict';
const { SUBTOTAL_MARKER } = await import('./subtotal.mjs');
assert.equal(SUBTOTAL_MARKER, 'reworked', `SOP_CHECK_A: SUBTOTAL_MARKER=${SUBTOTAL_MARKER}`);
console.log('SOP_CHECK_A passed');
