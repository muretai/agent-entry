// SPDX-License-Identifier: MIT
// Preloaded with `node --import` by conformance/vendor-ranges-helper.mjs when it runs the helper
// as a CLI. Replaces the global `fetch` with one that fails the way an offline machine does, so
// the CLI path is exercised end to end with no network at all.
globalThis.fetch = async (url) => {
  throw new TypeError(`fetch failed (stubbed: no network in tests) for ${String(url).slice(0, 80)}`);
};
