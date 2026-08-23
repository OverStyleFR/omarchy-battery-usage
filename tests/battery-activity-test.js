const assert = require("node:assert/strict");
const history = require("../BatteryHistory.js");

function observation(epoch, powerState, acOnline) {
  return { epoch, powerState, acOnline };
}

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "discharging", 0),
      observation(160, "charging", 1),
      observation(220, "idle", 1),
      observation(280, "discharging", 0),
    ],
    340
  ),
  {
    lastTimeOnBattery: 60,
    lastChargingDuration: 60,
    currentTimeOnBattery: 60,
    lastChargeAt: 220,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "completed and active connection intervals stay separate from charging activity"
);

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "idle", 1),
      observation(200, "charging", 1),
      observation(260, "charging", 1),
    ],
    500
  ),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: null,
    currentTimeOnBattery: null,
    lastChargeAt: null,
    currentChargingStartedAt: 200,
    currentChargingDuration: 300,
  },
  "an active charge restores its observed start and advances using wall-clock time"
);

assert.equal(
  history.batteryActivitySummary(
    [observation(200, "charging", 1), observation(500, "idle", 1)],
    700
  ).currentChargingDuration,
  null,
  "connected idle time is not current charging time"
);

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "charging", 1),
      observation(160, "charging", 1),
      observation(220, "idle", 1),
      observation(5000, "idle", 1),
      observation(5100, "discharging", 0),
      observation(5160, "discharging", 0),
      observation(9000, "discharging", 0),
      observation(9060, "discharging", 0),
    ],
    9120
  ),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: 120,
    currentTimeOnBattery: 180,
    lastChargeAt: 220,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "current time on battery excludes an unobserved suspend or shutdown gap"
);

assert.equal(
  history.batteryActivitySummary(
    [
      observation(100, "discharging", 0),
      observation(160, "discharging", 0),
      observation(5000, "discharging", 0),
      observation(5060, "discharging", 0),
      observation(5120, "charging", 1),
    ],
    5120
  ).lastTimeOnBattery,
  180,
  "last time on battery excludes an unobserved suspend or shutdown gap"
);

assert.equal(history.continuousSampleSeconds(100, 160), 60);
assert.equal(
  history.continuousSampleSeconds(100, 161),
  0,
  "live elapsed time does not jump forward after sampling was paused"
);

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "discharging", null),
      observation(200, "idle", 1),
      observation(300, "charging", 1),
      observation(300, "idle", 1),
    ],
    250
  ),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: null,
    currentTimeOnBattery: null,
    lastChargeAt: null,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "missing boundaries, zero durations, and a backward clock remain unavailable"
);

assert.deepEqual(
  history.batteryActivitySummary([], 1000),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: null,
    currentTimeOnBattery: null,
    lastChargeAt: null,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "fresh history is explicitly unavailable"
);

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "idle", 1),
      observation(200, "discharging", 0),
      observation(200, "idle", 1),
      observation(300, "charging", 1),
      observation(360, "charging", 1),
      observation(1000, "unknown", null),
      observation(1100, "idle", 1),
    ],
    1200
  ),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: 60,
    currentTimeOnBattery: null,
    lastChargeAt: 360,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "zero unplugged boundaries and unobserved charging gaps cannot fabricate activity"
);

assert.deepEqual(
  history.parseObservations(
    "epoch\tpower_state\tac_online\n100\tdischarging\t0\n200\tidle\t1\ninvalid\tcharging\t1\n"
  ),
  [observation(100, "discharging", 0), observation(200, "idle", 1)],
  "persisted observation rows preserve connection state and reject invalid timestamps"
);

assert.deepEqual(
  history.batteryActivityPresentation({
    lastTimeOnBattery: 3600,
    lastChargingDuration: 900,
    currentTimeOnBattery: 1800,
    currentChargingDuration: 450,
    lastChargeAt: 5000,
  }),
  {
    lastTimeOnBattery: { seconds: 3600, value: "1h 0m", ratio: 1 },
    lastChargingDuration: { seconds: 900, value: "15m", ratio: 0.25 },
    currentTimeOnBattery: { seconds: 1800, value: "30m", ratio: 0.5 },
    currentChargingDuration: { seconds: 450, value: "8m", ratio: 0.125 },
    lastChargeAt: 5000,
  },
  "activity values retain exact text while bars compare against the longest duration"
);

const unavailablePresentation = history.batteryActivityPresentation({
  lastTimeOnBattery: 0,
  lastChargingDuration: Infinity,
    currentTimeOnBattery: -1,
    currentChargingDuration: 0,
  lastChargeAt: NaN,
});
assert.deepEqual(
  unavailablePresentation,
  {
    lastTimeOnBattery: { seconds: null, value: "—", ratio: 0 },
    lastChargingDuration: { seconds: null, value: "—", ratio: 0 },
    currentTimeOnBattery: { seconds: null, value: "—", ratio: 0 },
    currentChargingDuration: { seconds: 0, value: "less than 1 minute", ratio: 0 },
    lastChargeAt: null,
  },
  "invalid and non-positive activity cannot establish the comparison scale"
);

assert.deepEqual(history.chargingStatusMessages, [
  "Charging",
  "Powering up",
  "Topping up",
  "Filling up",
  "Taking a charge",
  "Getting some power",
  "Recharging",
]);
assert.equal(
  history.nextChargingStatusMessage("Charging", 0),
  "Powering up",
  "rotation excludes the currently displayed phrase"
);
assert.equal(history.nextChargingStatusMessage("Powering up", 0.999), "Recharging");
assert.equal(history.chargingStatusRotationInterval(0), 4000);
assert.equal(history.chargingStatusRotationInterval(0.999999), 8000);

assert.equal(
  history.externalPowerConnected("charging", true),
  true,
  "normalized charging establishes external power even when UPower.onBattery is stale"
);
assert.equal(history.externalPowerConnected("fully-charged", true), true);
assert.equal(history.externalPowerConnected("discharging", false), false);
assert.equal(history.externalPowerConnected("unknown", false), true);
assert.equal(history.activelyCharging("charging", true), true);
assert.equal(history.activelyCharging("idle", false), false);
assert.deepEqual(
  history.batteryActivityPresentation({ currentChargingDuration: 0 }).currentChargingDuration,
  { seconds: 0, value: "less than 1 minute", ratio: 0 },
  "a newly observed live charge is immediately available instead of rendering as missing"
);

console.log("PASS: battery activity calculation contract");
