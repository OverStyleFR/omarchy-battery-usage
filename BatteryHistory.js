function formatDuration(seconds) {
  if (seconds === "" || seconds == null) return "—"
  var total = Number(seconds)
  if (!isFinite(total) || total < 0) return "—"
  if (total < 60) return "less than 1 minute"
  var totalMinutes = Math.round(total / 60)
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

function copySession(session) {
  return {
    state: session.state,
    startEpoch: session.startEpoch,
    endEpoch: session.endEpoch,
    startPercent: session.startPercent,
    endPercent: session.endPercent,
    durationSeconds: session.durationSeconds,
    complete: session.complete,
    percentageDelta: session.percentageDelta,
    percentChange: session.percentChange
  }
}

function recomputeSession(session) {
  session.durationSeconds = Math.max(0, session.endEpoch - session.startEpoch)
  if (session.startPercent != null && session.endPercent != null && isFinite(session.startPercent) && isFinite(session.endPercent)) {
    session.percentageDelta = session.endPercent - session.startPercent
    session.percentChange = Math.abs(session.percentageDelta)
  }
  return session
}

function mergeSessionInterruptions(sessions, now, energyFlow) {
  var list = []
  var i
  for (i = 0; i < (sessions || []).length; i++) list.push(copySession(sessions[i]))

  var changed = true
  while (changed) {
    changed = false
    for (i = 0; i + 2 < list.length; i++) {
      var first = list[i]
      var blip = list[i + 1]
      var resume = list[i + 2]
      if (first.state !== resume.state) continue
      if (!isLiveFlow(first.state) || !isLiveFlow(blip.state) || first.state === blip.state) continue
      var blipEnd = blip.complete ? blip.endEpoch : now
      if (blipEnd - blip.startEpoch >= SESSION_INTERRUPTION_SECONDS) continue
      var merged = copySession(first)
      merged.endEpoch = resume.endEpoch
      merged.endPercent = resume.endPercent
      merged.complete = resume.complete
      recomputeSession(merged)
      list.splice(i, 3, merged)
      changed = true
      break
    }
  }

  if (!isLiveFlow(energyFlow) && list.length > 0) {
    var last = list[list.length - 1]
    var previous = list.length > 1 ? list[list.length - 2] : null
    if (previous && isLiveFlow(previous.state) && isLiveFlow(last.state) && previous.state !== last.state) {
      var lastDuration = (last.complete ? last.endEpoch : now) - last.startEpoch
      if (lastDuration < SESSION_INTERRUPTION_SECONDS) {
        var completed = copySession(previous)
        completed.endEpoch = now
        completed.endPercent = last.endPercent != null ? last.endPercent : completed.endPercent
        completed.complete = true
        recomputeSession(completed)
        list = list.slice(0, list.length - 2)
        list.push(completed)
      }
    }
  }

  return list
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
    formatDuration: formatDuration,
    lastCompletedChargingSession: lastCompletedChargingSession,
    lastCompletedDischargingSession: lastCompletedDischargingSession,
    maxDischargeChange: maxDischargeChange,
    mergeSessionInterruptions: mergeSessionInterruptions,
    parseSessions: parseSessions,
    presentationState: presentationState,
    recentDischargeSessions: recentDischargeSessions,
    sessionRow: sessionRow,
    sessionSummaryFromSessions: sessionSummaryFromSessions
  }
}
