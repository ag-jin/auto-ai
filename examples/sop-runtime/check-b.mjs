import assert from 'node:assert/strict';
const { FEE_MARKER } = await import('./fee.mjs');
assert.equal(FEE_MARKER, 'stable', `SOP_CHECK_B: FEE_MARKER=${FEE_MARKER}`);
console.log('SOP_CHECK_B passed');
