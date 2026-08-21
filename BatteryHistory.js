function formatDuration(seconds) {
  var totalMinutes = Math.max(0, Math.round(Number(seconds) / 60))
  if (totalMinutes < 60) return totalMinutes + "m"
  return Math.floor(totalMinutes / 60) + "h " + totalMinutes % 60 + "m"
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

function activeSessionText(sessions) {
  for (var i = sessions.length - 1; i >= 0; i--) {
    var session = sessions[i]
    if (!session.complete) {
      var direction = session.state === "charging" ? "Charging" : "Discharging"
      return direction + " now · " + formatDuration(session.durationSeconds)
    }
  }
  return ""
}

function presentationState(loaded, error, sessions, stateLabel, onBattery) {
  var active = activeSessionText(sessions)
  var degraded = String(error || "").length > 0
  return {
    loading: !loaded && !degraded,
    degraded: degraded,
    empty: loaded && !degraded && sessions.length === 0,
    populated: loaded && !degraded && sessions.length > 0,
    status: active || (stateLabel !== "—" ? stateLabel : (onBattery ? "On battery" : "Idle on AC"))
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    activeSessionText: activeSessionText,
    formatDuration: formatDuration,
    lastCompletedChargingSession: lastCompletedChargingSession,
    maxDischargeChange: maxDischargeChange,
    parseSessions: parseSessions,
    presentationState: presentationState,
    recentDischargeSessions: recentDischargeSessions
  }
}
