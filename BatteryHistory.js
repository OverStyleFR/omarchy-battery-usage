function formatDuration(seconds) {
  if (seconds === "" || seconds == null) return "—"
  var total = Number(seconds)
  if (!isFinite(total) || total < 0) return "—"
  if (total < 60) return "less than 1 minute"
  var totalMinutes = Math.round(total / 60)
  if (totalMinutes < 60) return totalMinutes + "m"
  return Math.floor(totalMinutes / 60) + "h " + totalMinutes % 60 + "m"
}

var chargingStatusMessages = [
  "Charging",
  "Powering up",
  "Topping up",
  "Filling up",
  "Taking a charge",
  "Getting some power",
  "Recharging"
]

var MAX_CONTINUOUS_SAMPLE_GAP_SECONDS = 60
var DEFAULT_RECHARGE_MARGIN_PERCENT = 1.0

function continuousSampleSeconds(startEpoch, endEpoch) {
  var seconds = Number(endEpoch) - Number(startEpoch)
  if (!isFinite(seconds) || seconds <= 0 || seconds > MAX_CONTINUOUS_SAMPLE_GAP_SECONDS) return 0
  return seconds
}

function normalizedRandom(value) {
  var number = Number(value)
  if (!isFinite(number)) return 0
  return Math.max(0, Math.min(0.999999, number))
}

function nextChargingStatusMessage(current, randomValue) {
  var choices = []
  for (var i = 0; i < chargingStatusMessages.length; i++) {
    if (chargingStatusMessages[i] !== current) choices.push(chargingStatusMessages[i])
  }
  if (choices.length === 0) return current || "Charging"
  return choices[Math.floor(normalizedRandom(randomValue) * choices.length)]
}

function chargingStatusRotationInterval(randomValue) {
  return Math.floor(4000 + normalizedRandom(randomValue) * 4001)
}

function externalPowerConnected(powerState, onBattery) {
  var state = String(powerState || "")
  if (state === "charging" || state === "fully-charged" || state === "holding" || state === "pending-charge") return true
  if (state === "discharging") return false
  return onBattery === false
}

function activelyCharging(powerState, onBattery) {
  return String(powerState || "") === "charging" && externalPowerConnected(powerState, onBattery)
}

function rechargeAcrossGap(previousItem, currentItem, marginPercent) {
  if (!previousItem || currentItem.acOnline !== 0) return false
  if (previousItem.acOnline !== 0) return false
  var gap = Number(currentItem.epoch) - Number(previousItem.epoch)
  if (!isFinite(gap) || gap <= MAX_CONTINUOUS_SAMPLE_GAP_SECONDS) return false
  var previousPercent = Number(previousItem.batteryPercent)
  var currentPercent = Number(currentItem.batteryPercent)
  if (!isFinite(previousPercent) || !isFinite(currentPercent)) return false
  return currentPercent - previousPercent > Number(marginPercent)
}

function newActivityState() {
  return {
    prev: null,
    unpluggedStart: null,
    unpluggedSeconds: 0,
    lastUnpluggedObservation: null,
    chargingStart: null,
    lastChargingObservation: null,
    lastTimeOnBattery: null,
    lastChargingDuration: null,
    lastChargeAt: null
  }
}

function foldActivity(state, item, rechargeMargin) {
  var epoch = Number(item.epoch)
  if (!isFinite(epoch)) return state

  if (item.acOnline === 0 && rechargeAcrossGap(state.prev, item, rechargeMargin)) {
    if (state.unpluggedStart != null && state.unpluggedSeconds > 0) state.lastTimeOnBattery = state.unpluggedSeconds
    state.unpluggedStart = epoch
    state.unpluggedSeconds = 0
    state.lastUnpluggedObservation = epoch
  } else if (item.acOnline === 0) {
    if (state.unpluggedStart == null) {
      state.unpluggedStart = epoch
      state.unpluggedSeconds = 0
    } else if (state.lastUnpluggedObservation != null) {
      state.unpluggedSeconds += continuousSampleSeconds(state.lastUnpluggedObservation, epoch)
    }
    state.lastUnpluggedObservation = epoch
  } else if (item.acOnline === 1 && state.unpluggedStart != null) {
    var unpluggedDuration = state.unpluggedSeconds + continuousSampleSeconds(state.lastUnpluggedObservation, epoch)
    if (isFinite(unpluggedDuration) && unpluggedDuration > 0) state.lastTimeOnBattery = unpluggedDuration
    state.unpluggedStart = null
    state.unpluggedSeconds = 0
    state.lastUnpluggedObservation = null
  } else if (item.acOnline !== 1 && state.unpluggedStart != null) {
    // An unknown AC observation cannot prove the laptop stayed awake.
    state.lastUnpluggedObservation = null
  }

  if (item.powerState === "charging") {
    if (state.chargingStart == null) state.chargingStart = epoch
    state.lastChargingObservation = epoch
  } else if (state.chargingStart != null) {
    var chargingEnd = epoch - state.lastChargingObservation <= 300 ? epoch : state.lastChargingObservation
    var chargingDuration = chargingEnd - state.chargingStart
    if (isFinite(chargingDuration) && chargingDuration > 0) {
      state.lastChargingDuration = chargingDuration
      state.lastChargeAt = chargingEnd
    }
    state.chargingStart = null
    state.lastChargingObservation = null
  }

  state.prev = item
  return state
}

function finishActivity(state, now, uptimeSeconds) {
  var result = {
    lastTimeOnBattery: state.lastTimeOnBattery,
    lastChargingDuration: state.lastChargingDuration,
    currentTimeOnBattery: null,
    lastChargeAt: state.lastChargeAt,
    currentChargingStartedAt: null,
    currentChargingDuration: null
  }
  var last = state.prev
  if (last && last.acOnline === 0 && state.unpluggedStart != null) {
    var currentEpoch = Number(now)
    if (isFinite(currentEpoch) && state.lastUnpluggedObservation != null && currentEpoch >= state.lastUnpluggedObservation) {
      result.currentTimeOnBattery = state.unpluggedSeconds + continuousSampleSeconds(state.lastUnpluggedObservation, currentEpoch)
      var uptime = Number(uptimeSeconds)
      if (isFinite(uptime) && result.currentTimeOnBattery > uptime) result.currentTimeOnBattery = uptime
    }
  }
  if (last && last.acOnline === 1 && last.powerState === "charging" && state.chargingStart != null) {
    var currentChargingDuration = Number(now) - state.chargingStart
    if (isFinite(currentChargingDuration) && currentChargingDuration >= 0) {
      result.currentChargingStartedAt = state.chargingStart
      result.currentChargingDuration = currentChargingDuration
    }
  }
  return result
}

function batteryActivitySummary(observations, now, uptimeSeconds, rechargeMargin) {
  if (rechargeMargin == null || !isFinite(Number(rechargeMargin))) {
    rechargeMargin = DEFAULT_RECHARGE_MARGIN_PERCENT
  }
  var state = newActivityState()
  var list = observations || []
  for (var i = 0; i < list.length; i++) foldActivity(state, list[i], rechargeMargin)
  return finishActivity(state, now, uptimeSeconds)
}

function batteryActivityPresentation(activity) {
  var source = activity || {}
  var names = ["lastTimeOnBattery", "lastChargingDuration", "currentTimeOnBattery", "currentChargingDuration"]
  var values = {}
  var maximum = 0
  for (var i = 0; i < names.length; i++) {
    var value = Number(source[names[i]])
    var supplied = source[names[i]] !== null && source[names[i]] !== undefined && source[names[i]] !== ""
    var available = supplied && (names[i] === "currentChargingDuration" ? value >= 0 : value > 0)
    values[names[i]] = isFinite(value) && available ? value : null
    if (values[names[i]] != null && values[names[i]] > 0) maximum = Math.max(maximum, values[names[i]])
  }

  var result = {}
  for (var j = 0; j < names.length; j++) {
    var name = names[j]
    var seconds = values[name]
    var ratio = seconds != null && maximum > 0 ? seconds / maximum : 0
    result[name] = {
      seconds: seconds,
      value: seconds == null ? "—" : formatDuration(seconds),
      ratio: Math.max(0, Math.min(1, isFinite(ratio) ? ratio : 0))
    }
  }
  var lastChargeAt = Number(source.lastChargeAt)
  result.lastChargeAt = isFinite(lastChargeAt) && lastChargeAt > 0 ? lastChargeAt : null
  return result
}

function parseObservations(raw) {
  var list = []
  var lines = String(raw || "").split("\n")
  var fields = lines.length > 0 ? lines[0].split("\t") : []
  for (var i = 1; i < lines.length; i++) {
    var parts = lines[i].split("\t")
    if (parts.length !== fields.length) continue
    var record = {}
    for (var field = 0; field < fields.length; field++) record[fields[field]] = parts[field]
    var epoch = Number(record.epoch)
    if (!isFinite(epoch)) continue
    var batteryPercent = record.battery_percent === "" ? NaN : Number(record.battery_percent)
    list.push({
      epoch: epoch,
      powerState: record.power_state,
      acOnline: record.ac_online === "0" ? 0 : record.ac_online === "1" ? 1 : null,
      batteryPercent: isFinite(batteryPercent) ? batteryPercent : null
    })
  }
  return list
}

function parseSessions(raw) {
  var list = []
  var lines = String(raw || "").split("\n")
  if (lines.length === 0) return list
  var fields = lines[0].split("\t")
  for (var i = 1; i < lines.length; i++) {
    var parts = lines[i].split("\t")
    if (parts.length !== fields.length) continue
    var record = {}
    for (var field = 0; field < fields.length; field++) record[fields[field]] = parts[field]
    var startEpoch = Number(record.start_epoch)
    var endEpoch = Number(record.end_epoch)
    var startPercent = record.start_percent === "" ? NaN : Number(record.start_percent)
    var endPercent = record.end_percent === "" ? NaN : Number(record.end_percent)
    var durationSeconds = Number(record.duration_seconds)
    if (!isFinite(startEpoch) || !isFinite(endEpoch) || !isFinite(durationSeconds)) continue
    list.push({
      state: record.state,
      startEpoch: startEpoch,
      endEpoch: endEpoch,
      startPercent: isFinite(startPercent) ? startPercent : null,
      endPercent: isFinite(endPercent) ? endPercent : null,
      durationSeconds: durationSeconds,
      complete: Number(record.complete) === 1,
      percentageDelta: isFinite(startPercent) && isFinite(endPercent) ? endPercent - startPercent : null,
      percentChange: isFinite(startPercent) && isFinite(endPercent) ? Math.abs(endPercent - startPercent) : 0
    })
  }
  return list
}

function lastCompletedChargingSession(sessions) {
  for (var i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].state === "charging" && sessions[i].complete) return sessions[i]
  }
  return null
}

function lastCompletedDischargingSession(sessions) {
  for (var i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].state === "discharging" && sessions[i].complete) return sessions[i]
  }
  return null
}

function sessionSummaryFromSessions(sessions) {
  var dischargeCount = 0
  var dischargeSeconds = 0
  var chargeCount = 0
  var chargeSeconds = 0
  var list = sessions || []
  for (var i = 0; i < list.length; i++) {
    if (!list[i].complete) continue
    if (list[i].state === "discharging") {
      dischargeCount++
      dischargeSeconds += Number(list[i].durationSeconds || 0)
    } else if (list[i].state === "charging") {
      chargeCount++
      chargeSeconds += Number(list[i].durationSeconds || 0)
    }
  }
  return {
    completed_discharge_sessions: dischargeCount,
    average_discharge_seconds: dischargeCount ? Math.round(dischargeSeconds / dischargeCount) : 0,
    completed_charge_sessions: chargeCount,
    average_charge_seconds: chargeCount ? Math.round(chargeSeconds / chargeCount) : 0
  }
}

function recentDischargeSessions(sessions, limit) {
  var list = []
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].state !== "discharging") continue
    list.push(sessions[i])
    if (list.length > limit) list.shift()
  }
  return list
}

function maxDischargeChange(sessions) {
  var maximum = 1
  for (var i = 0; i < sessions.length; i++) maximum = Math.max(maximum, sessions[i].percentChange)
  return maximum
}

var SESSION_INTERRUPTION_SECONDS = 300

function isLiveFlow(energyFlow) {
  return energyFlow === "charging" || energyFlow === "discharging"
}

function recomputeSession(session) {
  session.durationSeconds = Math.max(0, session.endEpoch - session.startEpoch)
  if (session.startPercent != null && session.endPercent != null && isFinite(session.startPercent) && isFinite(session.endPercent)) {
    session.percentageDelta = session.endPercent - session.startPercent
    session.percentChange = Math.abs(session.percentageDelta)
  }
  return session
}

function directionOf(energyFlow) {
  if (energyFlow === "charging" || energyFlow === "discharging") return energyFlow
  return "idle"
}

function makeSession(state, startEpoch, endEpoch, complete, startPercent, endPercent) {
  return recomputeSession({
    state: state,
    startEpoch: startEpoch,
    endEpoch: endEpoch,
    startPercent: startPercent == null ? null : startPercent,
    endPercent: endPercent == null ? null : endPercent,
    complete: complete,
    durationSeconds: 0,
    percentageDelta: null,
    percentChange: 0
  })
}

function mergeSessionInterruptions(sessions, now, energyFlow) {
  var current = null
  var previous = null
  var completed = []

  function completeSession(session, endEpoch, endPercent) {
    completed.push(makeSession(
      session.state,
      session.startEpoch,
      endEpoch,
      true,
      session.startPercent,
      endPercent != null ? endPercent : session.endPercent
    ))
  }

  function completePrevious() {
    if (!previous) return
    completeSession(previous, previous.endEpoch, previous.endPercent)
    previous = null
  }

  function settle(t) {
    if (previous && (t - previous.endEpoch) >= SESSION_INTERRUPTION_SECONDS) completePrevious()
  }

  function observe(direction, t, startPercent, endPercent) {
    if (direction === "idle") {
      if (previous) {
        completePrevious()
        current = null
        return
      }
      if (current) {
        completeSession(current, t, endPercent)
        current = null
      }
      return
    }

    if (current && current.state === direction) {
      if (endPercent != null) current.endPercent = endPercent
      return
    }

    if (previous && previous.state === direction && (t - previous.endEpoch) < SESSION_INTERRUPTION_SECONDS) {
      current = previous
      previous = null
      if (endPercent != null) current.endPercent = endPercent
      return
    }

    if (current && current.state !== direction) {
      previous = {
        state: current.state,
        startEpoch: current.startEpoch,
        endEpoch: t,
        startPercent: current.startPercent,
        endPercent: current.endPercent
      }
      current = {
        state: direction,
        startEpoch: t,
        startPercent: startPercent != null ? startPercent : null,
        endPercent: endPercent != null ? endPercent : null
      }
      return
    }

    settle(t)
    current = {
      state: direction,
      startEpoch: t,
      startPercent: startPercent != null ? startPercent : null,
      endPercent: endPercent != null ? endPercent : null
    }
  }

  var list = sessions || []
  for (var i = 0; i < list.length; i++) {
    var group = list[i]
    var next = i + 1 < list.length ? list[i + 1] : null
    settle(group.startEpoch)
    observe(group.state, group.startEpoch, group.startPercent, group.endPercent)
    if (current && current.state === group.state && group.endPercent != null) current.endPercent = group.endPercent
    if (!group.complete) continue
    if (next && next.startEpoch > group.endEpoch && next.state !== group.state) {
      settle(group.endEpoch)
      observe("idle", group.endEpoch, null, group.endPercent)
    } else if (!next && directionOf(energyFlow) === "idle") {
      settle(group.endEpoch)
      observe("idle", group.endEpoch, null, group.endPercent)
    }
  }

  settle(now)
  observe(directionOf(energyFlow), now, null, null)
  settle(now)

  var out = completed.slice()
  if (current) {
    out.push(makeSession(
      current.state,
      current.startEpoch,
      now,
      false,
      current.startPercent,
      current.endPercent
    ))
  }
  return out
}

function sessionRow(sessions, energyFlow, now) {
  if (isLiveFlow(energyFlow)) {
    var start = now
    var list = sessions || []
    for (var i = list.length - 1; i >= 0; i--) {
      if (!list[i].complete && list[i].state === energyFlow) {
        start = list[i].startEpoch
        break
      }
    }
    var seconds = Math.max(0, now - start)
    return {
      kind: energyFlow === "charging" ? "charging-for" : "discharging-for",
      seconds: seconds,
      label: energyFlow === "charging" ? "Charging for" : "Discharging for",
      value: formatDuration(seconds)
    }
  }
  var lastCharge = lastCompletedChargingSession(sessions || [])
  var lastDischarge = lastCompletedDischargingSession(sessions || [])
  if (lastCharge && lastDischarge) {
    if (lastCharge.endEpoch >= lastDischarge.endEpoch) {
      return { kind: "last-charge", seconds: lastCharge.durationSeconds, label: "Last charge", value: formatDuration(lastCharge.durationSeconds) }
    }
    return { kind: "last-discharge", seconds: lastDischarge.durationSeconds, label: "Last discharge", value: formatDuration(lastDischarge.durationSeconds) }
  }
  if (lastCharge) {
    return { kind: "last-charge", seconds: lastCharge.durationSeconds, label: "Last charge", value: formatDuration(lastCharge.durationSeconds) }
  }
  if (lastDischarge) {
    return { kind: "last-discharge", seconds: lastDischarge.durationSeconds, label: "Last discharge", value: formatDuration(lastDischarge.durationSeconds) }
  }
  return { kind: "empty", seconds: 0, label: "", value: "—" }
}

function activeSessionText(sessions, energyFlow, now) {
  var row = sessionRow(sessions, energyFlow, now)
  if (row.kind === "charging-for" || row.kind === "discharging-for") return row.label + " " + row.value
  return ""
}

function presentationState(loaded, error, sessions, energyFlow, now) {
  var row = sessionRow(sessions, energyFlow, now)
  var degraded = String(error || "").length > 0
  return {
    loading: !loaded && !degraded,
    degraded: degraded,
    empty: loaded && !degraded && sessions.length === 0,
    populated: loaded && !degraded && sessions.length > 0,
    status: row.kind === "empty" ? "—" : row.label + " " + row.value
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    activeSessionText: activeSessionText,
    activelyCharging: activelyCharging,
    batteryActivityPresentation: batteryActivityPresentation,
    batteryActivitySummary: batteryActivitySummary,
    foldActivity: foldActivity,
    finishActivity: finishActivity,
    newActivityState: newActivityState,
    DEFAULT_RECHARGE_MARGIN_PERCENT: DEFAULT_RECHARGE_MARGIN_PERCENT,
    chargingStatusMessages: chargingStatusMessages,
    chargingStatusRotationInterval: chargingStatusRotationInterval,
    continuousSampleSeconds: continuousSampleSeconds,
    externalPowerConnected: externalPowerConnected,
    formatDuration: formatDuration,
    lastCompletedChargingSession: lastCompletedChargingSession,
    lastCompletedDischargingSession: lastCompletedDischargingSession,
    maxDischargeChange: maxDischargeChange,
    mergeSessionInterruptions: mergeSessionInterruptions,
    nextChargingStatusMessage: nextChargingStatusMessage,
    parseObservations: parseObservations,
    parseSessions: parseSessions,
    presentationState: presentationState,
    recentDischargeSessions: recentDischargeSessions,
    sessionRow: sessionRow,
    sessionSummaryFromSessions: sessionSummaryFromSessions
  }
}

var ACTIVITY_STATE_VERSION = 1

if (typeof process !== "undefined" && typeof module !== "undefined" && require.main === module) {
  var cliMode = process.argv[2]
  var fs = require("fs")

  function readActivityState(file, dbInode) {
    try {
      var data = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (error) {
      return null
    }
    if (!data || data.version !== ACTIVITY_STATE_VERSION || String(data.dbInode) !== String(dbInode)) return null
    return data
  }

  function readStdin(callback) {
    var input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", function(chunk) { input += chunk })
    process.stdin.on("end", function() { callback(input) })
  }

  function printSummary(activity) {
    function output(name, value) {
      process.stdout.write(name + "\t" + (value == null ? "" : value) + "\n")
    }
    output("last_time_on_battery_seconds", activity.lastTimeOnBattery)
    output("last_charging_duration_seconds", activity.lastChargingDuration)
    output("current_time_on_battery_seconds", activity.currentTimeOnBattery)
    output("last_charge_at", activity.lastChargeAt)
    output("current_charging_started_at", activity.currentChargingStartedAt)
    output("current_charging_duration_seconds", activity.currentChargingDuration)
  }

  if (cliMode === "--activity") {
    readStdin(function(input) {
      var uptimeArg = Number(process.argv[4])
      var marginArg = Number(process.argv[5])
      printSummary(batteryActivitySummary(
        parseObservations(input),
        Number(process.argv[3]),
        isFinite(uptimeArg) && uptimeArg > 0 ? uptimeArg : null,
        isFinite(marginArg) && marginArg > 0 ? marginArg : DEFAULT_RECHARGE_MARGIN_PERCENT
      ))
    })
  }

  if (cliMode === "--activity-cursor") {
    var cursor = readActivityState(process.argv[3], process.argv[4])
    process.stdout.write(cursor ? cursor.lastEpoch + "\t" + cursor.rowCount + "\n" : "0\t0\n")
  }

  if (cliMode === "--activity-update") {
    var stateFile = process.argv[3]
    var dbInode = process.argv[4]
    var reset = process.argv[10] === "1"
    var stored = reset ? null : readActivityState(stateFile, dbInode)
    if (!reset && !stored) {
      process.exit(2)
    }
    readStdin(function(input) {
      var uptimeArg = Number(process.argv[6])
      var marginArg = Number(process.argv[7])
      var margin = isFinite(marginArg) && marginArg > 0 ? marginArg : DEFAULT_RECHARGE_MARGIN_PERCENT
      var fold = stored ? stored.fold : newActivityState()
      var list = parseObservations(input)
      for (var i = 0; i < list.length; i++) foldActivity(fold, list[i], margin)
      var next = {
        version: ACTIVITY_STATE_VERSION,
        dbInode: dbInode,
        lastEpoch: Number(process.argv[8]),
        rowCount: Number(process.argv[9]),
        fold: fold
      }
      var tmp = stateFile + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(next))
      fs.renameSync(tmp, stateFile)
      printSummary(finishActivity(fold, Number(process.argv[5]), isFinite(uptimeArg) && uptimeArg > 0 ? uptimeArg : null))
    })
  }
}
