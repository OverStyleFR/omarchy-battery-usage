const assert = require("node:assert/strict");
const history = require("../BatteryHistory.js");

const raw = [
  "state\tstart_epoch\tend_epoch\tstart_percent\tend_percent\tduration_seconds\tcomplete",
  "discharging\t100\t160\t80.0\t79.0\t60\t1",
  "charging\t200\t260\t79.0\t82.0\t60\t1",
  "discharging\t300\t360\t82.0\t81.0\t60\t0",
].join("\n");

const sessions = history.parseSessions(raw);
assert.equal(sessions.length, 3);
assert.deepEqual(sessions.map((session) => session.state), ["discharging", "charging", "discharging"]);
assert.equal(sessions[0].percentChange, 1);
assert.equal(sessions[1].percentageDelta, 3);
assert.equal(sessions[2].complete, false);

const lastCharge = history.lastCompletedChargingSession([
  ...sessions,
  { state: "charging", startEpoch: 400, endEpoch: 460, complete: false },
]);
assert.equal(lastCharge.startEpoch, 200, "an active charge does not replace the last completed charge");
assert.equal(history.lastCompletedChargingSession([]), null);

const recent = history.recentDischargeSessions(sessions, 7);
assert.deepEqual(recent.map((session) => session.startEpoch), [100, 300], "meters remain chronological");

assert.deepEqual(history.presentationState(false, "", [], "—", false), {
  loading: true,
  degraded: false,
  empty: false,
  populated: false,
  status: "Idle on AC",
});
assert.equal(history.presentationState(true, "read failed", [], "—", true).degraded, true);
assert.equal(history.presentationState(true, "", [], "fully-charged", false).empty, true);

const populated = history.presentationState(true, "", sessions, "discharging", true);
assert.equal(populated.populated, true);
assert.equal(populated.status, "Discharging now · 1m");

console.log("PASS: fixture-driven history presentation states");
