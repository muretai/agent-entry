// SPDX-License-Identifier: MIT
// Preloaded with `node --import` by conformance/decide.mjs into a `decide` child when
// AE_FIXED_NOW_MS names a time: Date.now() answers that time, so the child's confirmReceipt signs
// at the same second the runner's does, and Ed25519 being deterministic, the two texts are one.
const fixed = Number(process.env.AE_FIXED_NOW_MS);
if (Number.isSafeInteger(fixed) && fixed > 0) Date.now = () => fixed;
