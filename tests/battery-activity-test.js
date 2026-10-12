const assert = require("node:assert/strict");
const history = require("../BatteryHistory.js");

function observation(epoch, powerState, acOnline, batteryPercent) {
  return { epoch, powerState, acOnline, batteryPercent };
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
    "epoch\tpower_state\tac_online\tbattery_percent\n100\tdischarging\t0\t\n200\tidle\t1\t\ninvalid\tcharging\t1\t\n"
  ),
  [
    { epoch: 100, powerState: "discharging", acOnline: 0, batteryPercent: null },
    { epoch: 200, powerState: "idle", acOnline: 1, batteryPercent: null },
  ],
  "persisted observation rows preserve connection state, battery level, and reject invalid timestamps"
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

assert.deepEqual(
  history.batteryActivitySummary(
    [
      observation(100, "discharging", 0, 80),
      observation(160, "discharging", 0, 79),
      observation(5000, "discharging", 0, 90),
      observation(5060, "discharging", 0, 89),
    ],
    5120
  ),
  {
    lastTimeOnBattery: 60,
    lastChargingDuration: null,
    currentTimeOnBattery: 120,
    lastChargeAt: null,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "a battery percentage rise across an unplugged gap closes the previous interval"
);

assert.equal(
  history.batteryActivitySummary(
    [
      observation(100, "discharging", 0, 80),
      observation(5000, "discharging", 0, 81),
    ],
    5060
  ).currentTimeOnBattery,
  60,
  "a small percentage rise stays within the configured margin and keeps the interval open"
);

assert.deepEqual(
  history.batteryActivitySummary(
    [observation(100, "discharging", 0, 50)],
    150,
    30,
    history.DEFAULT_RECHARGE_MARGIN_PERCENT
  ),
  {
    lastTimeOnBattery: null,
    lastChargingDuration: null,
    currentTimeOnBattery: 30,
    lastChargeAt: null,
    currentChargingStartedAt: null,
    currentChargingDuration: null,
  },
  "current time on battery is capped by system uptime"
);

console.log("PASS: battery activity calculation contract");

function seededRandom(seed) {
  var state = seed
  return function() {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

function randomObservations(random, count) {
  var list = []
  var epoch = 1000
  for (var i = 0; i < count; i++) {
    epoch += random() < 0.1 ? 120 + Math.floor(random() * 4000) : 1 + Math.floor(random() * 60)
    var acOnline = random() < 0.15 ? null : random() < 0.5 ? 0 : 1
    var powerState = acOnline === 1 && random() < 0.6 ? "charging" : random() < 0.5 ? "discharging" : "idle"
    var batteryPercent = random() < 0.05 ? null : Math.floor(random() * 100)
    list.push(observation(epoch, powerState, acOnline, batteryPercent))
  }
  return list
}

for (var seed = 1; seed <= 200; seed++) {
  var random = seededRandom(seed)
  var list = randomObservations(random, 300)
  var cut1 = Math.floor(random() * list.length)
  var cut2 = cut1 + Math.floor(random() * (list.length - cut1))
  var now = list[list.length - 1].epoch + Math.floor(random() * 600)
  var uptime = 100000
  var expected = history.batteryActivitySummary(list, now, uptime, 1.0)
  var state = history.newActivityState()
  var chunks = [list.slice(0, cut1), list.slice(cut1, cut2), list.slice(cut2)]
  for (var c = 0; c < chunks.length; c++) {
    var roundTripped = JSON.parse(JSON.stringify(state))
    state = roundTripped
    for (var k = 0; k < chunks[c].length; k++) history.foldActivity(state, chunks[c][k], 1.0)
  }
  assert.deepEqual(history.finishActivity(state, now, uptime), expected, "seed " + seed)
}

console.log("PASS: incremental activity fold matches full recomputation")
