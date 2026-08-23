const assert = require("node:assert/strict");
const history = require("../BatteryHistory.js");

assert.equal(history.formatDuration(""), "—");
assert.equal(history.formatDuration(undefined), "—");
assert.equal(history.formatDuration(0), "less than 1 minute");
assert.equal(history.formatDuration(59), "less than 1 minute");
assert.equal(history.formatDuration(60), "1m");
assert.equal(history.formatDuration(3600), "1h 0m");
assert.equal(history.formatDuration(8100), "2h 15m");

assert.deepEqual(
  history.sessionRow([], "charging", 1700000000),
  { kind: "charging-for", seconds: 0, label: "Charging for", value: "less than 1 minute" },
  "charging with no session starts elapsed session time at now"
);
assert.deepEqual(
  history.sessionRow([], "discharging", 1700000000),
  { kind: "discharging-for", seconds: 0, label: "Discharging for", value: "less than 1 minute" },
  "discharging with no session starts elapsed session time at now"
);
["fully-charged", "holding", "pending-charge"].forEach((energyFlow) => {
  assert.deepEqual(
    history.sessionRow([], energyFlow, 1700000000),
    { kind: "empty", seconds: 0, label: "", value: "—" },
    energyFlow + " does not start a charging session"
  );
});
assert.deepEqual(
  history.sessionRow(
    [{ state: "charging", startEpoch: 1700000000, complete: false }],
    "charging",
    1700008100
  ),
  { kind: "charging-for", seconds: 8100, label: "Charging for", value: "2h 15m" },
  "restart while charging keeps the original start"
);
assert.deepEqual(
  history.sessionRow(
    [{ state: "charging", startEpoch: 1700000000, complete: false }],
    "fully-charged",
    1700003600
  ),
  { kind: "empty", seconds: 0, label: "", value: "—" },
  "fully charged ends the charging session with an idle row"
);

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

const dischargeSessions = [1, 2, 3, 4, 5, 6].map((startEpoch) => ({
  state: "discharging",
  startEpoch,
  percentChange: 1,
}));
const recent = history.recentDischargeSessions(dischargeSessions, 5);
assert.deepEqual(recent.map((session) => session.startEpoch), [2, 3, 4, 5, 6], "only the newest five discharge sessions are shown");

assert.deepEqual(history.presentationState(false, "", [], "—", 0), {
  loading: true,
  degraded: false,
  empty: false,
  populated: false,
  status: "—",
});
assert.equal(history.presentationState(true, "read failed", [], "—", 0).degraded, true);
assert.equal(history.presentationState(true, "", [], "fully-charged", 0).empty, true);

const populated = history.presentationState(true, "", sessions, "discharging", 360);
assert.equal(populated.populated, true);
assert.equal(populated.status, "Discharging for 1m");

const interrupted = history.mergeSessionInterruptions(
  [
    { state: "charging", startEpoch: 1000, endEpoch: 2000, complete: true },
    { state: "discharging", startEpoch: 2000, endEpoch: 2120, complete: true },
    { state: "charging", startEpoch: 2120, endEpoch: 3000, complete: false },
  ],
  3000,
  "charging"
);
assert.equal(interrupted.length, 1, "a two-minute discharge is discarded as a session interruption");
assert.equal(interrupted[0].startEpoch, 1000);
assert.equal(interrupted[0].complete, false);
assert.deepEqual(
  history.sessionRow(interrupted, "charging", 3000),
  { kind: "charging-for", seconds: 2000, label: "Charging for", value: "33m" },
  "charging resumes from the original start after a two-minute discharge"
);

const stillDischarging = history.mergeSessionInterruptions(
  [
    { state: "charging", startEpoch: 1000, endEpoch: 2000, complete: true },
    { state: "discharging", startEpoch: 2000, endEpoch: 2300, complete: false },
  ],
  2300,
  "discharging"
);
assert.equal(stillDischarging.length, 2, "five minutes of discharging keeps both sessions");
assert.deepEqual(
  history.sessionRow(stillDischarging, "discharging", 2300),
  { kind: "discharging-for", seconds: 300, label: "Discharging for", value: "5m" },
  "five minutes of discharging keeps the unplug start"
);

const briefCharge = history.mergeSessionInterruptions(
  [
    { state: "discharging", startEpoch: 1000, endEpoch: 2000, complete: true },
    { state: "charging", startEpoch: 2000, endEpoch: 2120, complete: true },
    { state: "discharging", startEpoch: 2120, endEpoch: 3000, complete: false },
  ],
  3000,
  "discharging"
);
assert.equal(briefCharge.length, 1);
assert.equal(briefCharge[0].state, "discharging");
assert.equal(briefCharge[0].startEpoch, 1000);

["fully-charged", "holding", "pending-charge"].forEach((energyFlow) => {
  const idle = history.mergeSessionInterruptions(
    [
      { state: "charging", startEpoch: 1000, endEpoch: 2000, complete: true },
      { state: "discharging", startEpoch: 2000, endEpoch: 2120, complete: false },
    ],
    2120,
    energyFlow
  );
  assert.equal(idle.length, 1, energyFlow + " ends a charging session immediately rather than interrupting");
  assert.equal(idle[0].state, "charging");
  assert.equal(idle[0].complete, true);
  assert.deepEqual(
    history.sessionRow(idle, energyFlow, 2120),
    { kind: "last-charge", seconds: 1120, label: "Last charge", value: "19m" },
    energyFlow + " shows last charge after the charging session ends"
  );
});

assert.deepEqual(
  history.sessionRow(
    [{ state: "discharging", startEpoch: 1000, endEpoch: 4600, durationSeconds: 3600, complete: true }],
    "fully-charged",
    4600
  ),
  { kind: "last-discharge", seconds: 3600, label: "Last discharge", value: "1h 0m" },
  "a discharging session that ends without charging becomes last discharge"
);

assert.deepEqual(
  history.sessionRow(
    [
      { state: "charging", startEpoch: 1000, endEpoch: 4600, durationSeconds: 3600, complete: true },
      { state: "charging", startEpoch: 5000, endEpoch: 5060, complete: false },
    ],
    "charging",
    5060
  ),
  { kind: "charging-for", seconds: 60, label: "Charging for", value: "1m" },
  "a live charging session wins over last charge"
);

assert.deepEqual(
  history.sessionRow(
    [
      { state: "charging", startEpoch: 10, endEpoch: 50, durationSeconds: 40, complete: true },
      { state: "discharging", startEpoch: 50, endEpoch: 80, durationSeconds: 30, complete: true },
    ],
    "fully-charged",
    100
  ),
  { kind: "last-discharge", seconds: 30, label: "Last discharge", value: "less than 1 minute" },
  "the idle row shows the most recently completed session"
);

assert.deepEqual(
  history.sessionSummaryFromSessions(interrupted),
  {
    completed_discharge_sessions: 0,
    average_discharge_seconds: 0,
    completed_charge_sessions: 0,
    average_charge_seconds: 0
  },
  "a discarded session interruption is not a completed session"
);

const twoMinuteUnplug = history.mergeSessionInterruptions(
  [
    { state: "charging", startEpoch: 1000, endEpoch: 2000, complete: true },
    { state: "discharging", startEpoch: 2000, endEpoch: 2120, complete: false },
  ],
  2120,
  "discharging"
);
assert.equal(twoMinuteUnplug.length, 1, "a two-minute unplug does not complete the original charging session");
assert.equal(twoMinuteUnplug[0].state, "discharging");
assert.equal(twoMinuteUnplug[0].complete, false);
assert.equal(twoMinuteUnplug[0].startEpoch, 2000);
assert.deepEqual(
  history.sessionRow(twoMinuteUnplug, "discharging", 2120),
  { kind: "discharging-for", seconds: 120, label: "Discharging for", value: "0h 2m" },
  "unplug while charging shows Discharging for immediately"
);

const replugBeforeThirdGroup = history.mergeSessionInterruptions(
  [
    { state: "charging", startEpoch: 1000, endEpoch: 2000, complete: true },
    { state: "discharging", startEpoch: 2000, endEpoch: 2120, complete: false },
  ],
  2120,
  "charging"
);
assert.equal(replugBeforeThirdGroup.length, 1, "replug inside five minutes resumes without a third sample group");
assert.equal(replugBeforeThirdGroup[0].state, "charging");
assert.equal(replugBeforeThirdGroup[0].startEpoch, 1000);
assert.equal(replugBeforeThirdGroup[0].complete, false);
assert.deepEqual(
  history.sessionRow(replugBeforeThirdGroup, "charging", 2120),
  { kind: "charging-for", seconds: 1120, label: "Charging for", value: "0h 18m" },
  "startup during a session interruption still resumes the original charging session"
);

const endedOnFull = history.mergeSessionInterruptions(
  [{ state: "charging", startEpoch: 1000, endEpoch: 2000, complete: false }],
  2000,
  "fully-charged"
);
assert.equal(endedOnFull.length, 1);
assert.equal(endedOnFull[0].complete, true);
assert.deepEqual(
  history.sessionRow(endedOnFull, "fully-charged", 2000),
  { kind: "last-charge", seconds: 1000, label: "Last charge", value: "0h 16m" },
  "fully charged completes the charging session for the idle line"
);
assert.equal(
  history.presentationState(true, "", endedOnFull, "fully-charged", 2000).status,
  "Last charge 0h 16m",
  "the history status line shows last completed duration, not the raw energy-flow state"
);

console.log("PASS: fixture-driven history presentation states");
