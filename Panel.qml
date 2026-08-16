import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Ui

// Omarchy bar widget showing the live battery draw (󱐋<watts> W); left-click
// opens a panel with a live consumption graph, stats and battery details.
//
// Sampling cadence adapts to the power state: 1s on AC, and on battery it
// follows the active power profile (power-saver 5s, balanced 2s, performance
// 1s). Every sample is persisted to the SQLite database
// ~/.local/state/tomv.battery-usage/power.db, so history survives shell
// restarts and can feed the optional web dashboard. The graph only renders
// while the panel is open, so the constant cost is one tiny bash read per
// tick.
Panel {
  id: root
  moduleName: "tomv.battery-usage"
  ipcTarget: "tomv.battery-usage"

  // ------------------------------------------------------------ live state

  property real currentWatts: 0
  property real currentChargeWatts: 0
  property var samples: []
  property int samplesRevision: 0
  property string activeProfile: ""
  property var batteryInfo: ({})
  property int statsMinutes: 10
  readonly property int graphMinutes: 10
  property bool historyLoaded: false
  property real graphHoverX: -1
  readonly property color chargeGraphColor: {
    var hue = Color.accent.hslHue
    if (hue < 0) hue = 0.08
    return Qt.hsla(
      (hue + 0.12) % 1,
      Math.max(0.5, Color.accent.hslSaturation),
      Math.min(0.72, Math.max(0.45, Color.accent.hslLightness)),
      1
    )
  }

  function minutesLabel(minutes) {
    return minutes >= 60 ? Math.round(minutes / 60) + "h" : minutes + "m"
  }
  property real averageWatts: 0
  property real peakWatts: 0
  property real energyWh: 0
  property string trendGlyph: "→"

  readonly property string readoutText: {
    if (currentWatts > 0.05) return "󱐋" + currentWatts.toFixed(1) + " W"
    if (currentChargeWatts > 0.05) return "+" + currentChargeWatts.toFixed(1) + " W"
    return "󱐋--.- W"
  }

  readonly property bool batteryPresent: {
    var device = UPower.displayDevice
    return !!(device && device.isPresent)
  }

  // Hidden while idle on AC (battery neither charging nor discharging, ~0 W),
  // but kept visible while charging so the charge rate is explicit.
  readonly property bool showWidget: {
    return batteryPresent && (UPower.onBattery || currentWatts > 0.05 || currentChargeWatts > 0.05)
  }

  // 1s on AC; on battery the cadence follows the active power profile.
  readonly property int samplingSeconds: {
    if (!UPower.onBattery) return 1
    if (activeProfile === "power-saver") return 5
    if (activeProfile === "performance") return 1
    return 2
  }

  readonly property string percentText: batteryInfo.percentage || "—"
  readonly property string stateLabel: {
    var s = String(batteryInfo.state || "")
    if (s === "holding") return "Holding"
    if (s === "charging") return "Charging"
    if (s === "discharging") return "Discharging"
    if (s === "fully-charged") return "Fully charged"
    if (s === "pending-charge") return "Pending charge"
    return s || "—"
  }
  readonly property bool discharging: {
    var s = String(batteryInfo.state || "")
    return UPower.onBattery && s !== "charging" && s !== "holding"
  }
  readonly property string timeLabel: {
    if (String(batteryInfo.state || "") === "holding") return "—"
    return batteryInfo.time || "—"
  }
  readonly property string runtimeText: {
    if (!discharging || averageWatts <= 0.05) return "—"
    var size = parseFloat(String(batteryInfo.size || ""))
    var pct = parseFloat(String(batteryInfo.percentage || "").replace("%", ""))
    if (!isFinite(size) || !isFinite(pct)) return "—"
    return humanDuration(size * (pct / 100) / averageWatts)
  }

  function humanDuration(hours) {
    if (!isFinite(hours) || hours < 0) return "—"
    var totalMin = Math.round(hours * 60)
    var h = Math.floor(totalMin / 60)
    var m = totalMin % 60
    return h > 0 ? h + "h " + m + "m" : m + "m"
  }

  function formatWatts(watts) {
    return watts.toFixed(1) + " W"
  }

  // -------------------------------------------------------------- sampling

  function refreshProfile() {
    profileProc.running = true
  }

  function refreshBatteryInfo() {
    batteryProc.running = true
  }

  function backfill() {
    if (root.historyLoaded) return
    tailProc.running = true
  }

  function sampleLine(epoch, dischargeWatts, chargeWatts) {
    samples.push({ t: epoch, w: dischargeWatts, c: chargeWatts })
    var cap = 24000
    if (samples.length > cap) samples.splice(0, samples.length - cap)
    samplesRevision++
  }

  function onSample(epoch, dischargeWatts, chargeWatts) {
    currentWatts = dischargeWatts
    currentChargeWatts = chargeWatts
    if (dischargeWatts > 0.05 || chargeWatts > 0.05) {
      sampleLine(epoch, dischargeWatts, chargeWatts)
    }
    recomputeStats()
    updateTrend()
  }

  function parseTail(raw) {
    var lines = String(raw || "").split("\n")
    var list = []
    var cap = 24000
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split(/\s+/)
      if (parts.length < 2) continue
      var t = Number(parts[0])
      var dischargeWatts = Number(parts[1])
      var chargeWatts = parts.length >= 3 ? Number(parts[2]) : 0
      if (!isFinite(t) || !isFinite(dischargeWatts) || !isFinite(chargeWatts)) continue
      if (dischargeWatts <= 0.05 && chargeWatts <= 0.05) continue
      list.push({ t: t, w: dischargeWatts, c: chargeWatts })
      if (list.length > cap) list.shift()
    }
    samples = list
    samplesRevision++
    root.historyLoaded = true
    if (opened) {
      recomputeStats()
      updateTrend()
    }
  }

  function updateKeyValue(raw) {
    var next = {}
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var idx = lines[i].indexOf("\t")
      if (idx <= 0) continue
      next[lines[i].substring(0, idx)] = lines[i].substring(idx + 1).trim()
    }
    if (Object.keys(next).length === 0) return
    batteryInfo = next
  }

  function parseProfiles(raw) {
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("\t")
      if (parts.length >= 2 && String(parts[1]).trim() === "1") {
        activeProfile = String(parts[0]).trim()
        return
      }
    }
  }

  // ------------------------------------------------------------- stats/graph

  function windowSamples(minutes) {
    var cutoff = Math.floor(Date.now() / 1000) - minutes * 60
    var list = []
    for (var i = samples.length - 1; i >= 0; i--) {
      if (samples[i].t < cutoff) break
      list.push(samples[i])
    }
    list.reverse()
    return list
  }

  function dischargeSamples(minutes) {
    var source = windowSamples(minutes)
    var list = []
    for (var i = 0; i < source.length; i++) {
      if (source[i].w > 0.05) list.push(source[i])
    }
    return list
  }

  function recomputeStats() {
    var list = dischargeSamples(root.statsMinutes)
    if (list.length === 0) {
      averageWatts = 0
      peakWatts = 0
      energyWh = 0
      return
    }
    var sum = 0
    var peak = 0
    var energy = 0
    for (var i = 0; i < list.length; i++) {
      sum += list[i].w
      if (list[i].w > peak) peak = list[i].w
      // Never integrate across charging/sleep gaps: a gap longer than one
      // minute means sampling was paused and the last draw is not
      // representative of the whole interval.
      if (i > 0) {
        var dt = list[i].t - list[i - 1].t
        if (dt > 0 && dt <= 60) energy += list[i].w * dt / 3600
      }
    }
    averageWatts = sum / list.length
    peakWatts = peak
    energyWh = energy
  }

  function updateTrend() {
    var list = dischargeSamples(root.statsMinutes)
    if (list.length < 2) {
      trendGlyph = "→"
      return
    }
    var now = list[list.length - 1].w
    var ref = list[0].w
    if (now > ref + 0.05) trendGlyph = "↑"
    else if (now < ref - 0.05) trendGlyph = "↓"
    else trendGlyph = "→"
  }

  function drawGraph(ctx) {
    var w = graph.width
    var h = graph.height
    if (!opened || w <= 0 || h <= 0) return

    ctx.clearRect(0, 0, w, h)

    var fg = root.bar.foreground
    var accent = Color.accent
    var chargeAccent = root.chargeGraphColor
    var list = windowSamples(root.graphMinutes)

    var padL = Style.space(4)
    var padR = Style.space(4)
    var padT = Style.space(16)
    var padB = Style.space(4)
    var pw = w - padL - padR
    var ph = h - padT - padB

    // Grid: baseline plus two mid lines.
    ctx.strokeStyle = Qt.rgba(fg.r, fg.g, fg.b, 0.10)
    ctx.lineWidth = 1
    for (var g = 0; g <= 3; g++) {
      var gy = padT + ph * g / 3
      ctx.beginPath()
      ctx.moveTo(padL, gy)
      ctx.lineTo(padL + pw, gy)
      ctx.stroke()
    }

    if (list.length < 2) return

    var maxW = 0
    var maxChargeW = 0
    for (var i = 0; i < list.length; i++) {
      if (list[i].w > maxW) maxW = list[i].w
      if (list[i].c > maxChargeW) maxChargeW = list[i].c
    }
    maxW = Math.max(maxW, maxChargeW)
    var span = maxW > 0 ? maxW : 1
    var t0 = list[0].t
    var t1 = list[list.length - 1].t
    var tSpan = (t1 - t0) > 0 ? (t1 - t0) : 1

    function xAt(s) { return padL + (s.t - t0) / tSpan * pw }
    function yAtValue(value) { return padT + ph - Math.min(1, value / span) * ph }
    function yAt(s) { return yAtValue(s.w) }

    function drawArea(key, color) {
      var active = false
      var lastX = 0
      ctx.beginPath()
      for (var j = 0; j < list.length; j++) {
        var value = key === "charge" ? list[j].c : list[j].w
        var gap = j > 0 ? list[j].t - list[j - 1].t : 0
        if (value <= 0.05 || gap > 60) {
          if (active) {
            ctx.lineTo(lastX, padT + ph)
            ctx.closePath()
            active = false
          }
          continue
        }
        var x = xAt(list[j])
        var y = yAtValue(value)
        if (!active) {
          ctx.moveTo(x, padT + ph)
          ctx.lineTo(x, y)
          active = true
        } else {
          ctx.lineTo(x, y)
        }
        lastX = x
      }
      if (active) {
        ctx.lineTo(lastX, padT + ph)
        ctx.closePath()
      }
      ctx.fillStyle = Qt.rgba(color.r, color.g, color.b, 0.14)
      ctx.fill()
    }

    function drawLine(key, color) {
      var active = false
      ctx.beginPath()
      for (var j = 0; j < list.length; j++) {
        var value = key === "charge" ? list[j].c : list[j].w
        var gap = j > 0 ? list[j].t - list[j - 1].t : 0
        if (value <= 0.05 || gap > 60) {
          active = false
          continue
        }
        var x = xAt(list[j])
        var y = yAtValue(value)
        if (!active) {
          ctx.moveTo(x, y)
          active = true
        } else {
          ctx.lineTo(x, y)
        }
      }
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.stroke()
    }

    // Keep charge visually distinct while excluding it from the stats.
    drawArea("discharge", accent)
    drawArea("charge", chargeAccent)
    drawLine("discharge", accent)
    drawLine("charge", chargeAccent)

    // Current sample dot.
    var last = list[list.length - 1]
    if (last.w > 0.05) {
      ctx.beginPath()
      ctx.arc(xAt(last), yAtValue(last.w), 3.5, 0, Math.PI * 2)
      ctx.fillStyle = accent
      ctx.fill()
    }
    if (last.c > 0.05) {
      ctx.beginPath()
      ctx.arc(xAt(last), yAtValue(last.c), 3.5, 0, Math.PI * 2)
      ctx.fillStyle = chargeAccent
      ctx.fill()
    }

    // Labels.
    ctx.fillStyle = Qt.rgba(fg.r, fg.g, fg.b, 0.55)
    ctx.font = Style.font.family + " " + Style.font.caption + "px"
    ctx.textBaseline = "top"
    ctx.textAlign = "left"
    ctx.fillText(maxW.toFixed(1) + " W", padL, 0)
    ctx.textBaseline = "alphabetic"
    ctx.fillText(root.minutesLabel(root.graphMinutes), padL + pw, padT + ph)

    // Hover crosshair: vertical line + dot on the curve + value chip.
    if (root.graphHoverX >= padL && root.graphHoverX <= padL + pw) {
      var ratio = (root.graphHoverX - padL) / pw
      var ht = t0 + ratio * tSpan
      var hovered = list[0]
      var best = Math.abs(list[0].t - ht)
      for (i = 1; i < list.length; i++) {
        var dist = Math.abs(list[i].t - ht)
        if (dist < best) { best = dist; hovered = list[i] }
      }
      var hx = xAt(hovered)
      var hoveringCharge = hovered.c > 0.05
      var hoveredWatts = hoveringCharge ? hovered.c : hovered.w
      var hy = yAtValue(hoveredWatts)
      var hoverColor = hoveringCharge ? chargeAccent : accent

      ctx.beginPath()
      ctx.moveTo(hx, padT)
      ctx.lineTo(hx, padT + ph)
      ctx.strokeStyle = Qt.rgba(fg.r, fg.g, fg.b, 0.40)
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(hx, hy, 3, 0, Math.PI * 2)
      ctx.fillStyle = hoverColor
      ctx.fill()

      ctx.font = Style.font.family + " " + Style.font.bodySmall + "px"
      var chipText = (hoveringCharge ? "CHARGE " : "DRAIN ") + root.formatWatts(hoveredWatts)
      var chipW = ctx.measureText(chipText).width + Style.space(12)
      var chipH = Style.space(16)
      var chipX = Math.max(padL, Math.min(hx - chipW / 2, padL + pw - chipW))
      var bg = Color.background
      ctx.fillStyle = Qt.rgba(bg.r, bg.g, bg.b, 0.88)
      ctx.fillRect(chipX, padT, chipW, chipH)
      ctx.fillStyle = hoverColor
      ctx.textBaseline = "middle"
      ctx.textAlign = "center"
      ctx.fillText(chipText, chipX + chipW / 2, padT + chipH / 2)
    }
  }

  // ------------------------------------------------------------- processes

  function pluginScript(name) {
    var url = String(Qt.resolvedUrl("scripts/" + name))
    return decodeURIComponent(url.replace(/^file:\/\//, ""))
  }

  Process {
    id: sampleProc
    command: ["bash", "-lc", root.pluginScript("battery-power-sample")]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parts = String(text).split(/\s+/)
        if (parts.length >= 2) {
          var t = Number(parts[0])
          var dischargeWatts = Number(parts[1])
          var chargeWatts = parts.length >= 3 ? Number(parts[2]) : 0
          if (isFinite(t) && isFinite(dischargeWatts) && isFinite(chargeWatts)) {
            root.onSample(t, dischargeWatts, chargeWatts)
          }
        }
      }
    }
  }

  Process {
    id: profileProc
    command: ["omarchy-powerprofiles-list", "--active-state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseProfiles(text)
    }
  }

  Process {
    id: batteryProc
    command: ["omarchy-battery-status", "--shell"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.updateKeyValue(text)
    }
  }

  Process {
    id: tailProc
    command: ["bash", "-lc", root.pluginScript("battery-power-history") + " 24000"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseTail(text)
    }
  }

  // ---------------------------------------------------------------- timers

  Timer {
    id: sampleTimer
    interval: root.samplingSeconds * 1000
    running: root.batteryPresent
    repeat: true
    triggeredOnStart: true
    onTriggered: sampleProc.running = true
  }

  Timer {
    id: profileTimer
    interval: 30000
    repeat: true
    running: root.batteryPresent
    onTriggered: root.refreshProfile()
  }

  Timer {
    id: panelRefreshTimer
    interval: 5000
    repeat: true
    running: root.opened
    onTriggered: {
      root.refreshBatteryInfo()
      root.recomputeStats()
      root.updateTrend()
    }
  }

  // ------------------------------------------------------------- lifecycle

  onOpenedChanged: {
    if (opened) {
      backfill()
      refreshBatteryInfo()
      refreshProfile()
      recomputeStats()
      updateTrend()
    }
  }

  onBatteryPresentChanged: if (!batteryPresent) close()
  onShowWidgetChanged: if (!showWidget) close()
  onStatsMinutesChanged: {
    recomputeStats()
    updateTrend()
  }

  // ------------------------------------------------------------ bar button

  visible: root.showWidget
  implicitWidth: root.showWidget ? button.implicitWidth : 0
  implicitHeight: root.showWidget ? button.implicitHeight : 0
  // The open-panel mark spans the painted text, not the icon-sized slot.
  readonly property real openPanelIndicatorWidth: button.visible ? button.labelWidth : 0

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.readoutText
    fontSize: 12
    horizontalMargin: 2
    verticalPadding: 6
    tooltipText: "Instant battery power"
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.batteryPresent
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        // ------------------------------------------------------ hero
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            text: "󱐋"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: root.currentChargeWatts > 0.05 ? "BATTERY CHARGE" : "POWER DRAW"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: root.readoutText + (root.currentChargeWatts > 0.05 ? "" : "  " + root.trendGlyph)
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPercent
            text: root.percentText
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        // ------------------------------------------------------ graph
        Column {
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Math.max(windowHeader.implicitHeight, graphLegend.implicitHeight)

            Text {
              id: windowHeader
              text: "CONSUMPTION"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Row {
              id: graphLegend
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              Row {
                spacing: Style.space(3)

                Rectangle {
                  width: Style.space(6)
                  height: width
                  radius: width / 2
                  color: Color.accent
                  anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                  text: "DRAIN"
                  color: root.bar.foreground
                  opacity: 0.65
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }

              Row {
                spacing: Style.space(3)

                Rectangle {
                  width: Style.space(6)
                  height: width
                  radius: width / 2
                  color: root.chargeGraphColor
                  anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                  text: "CHARGE"
                  color: root.chargeGraphColor
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }
            }
          }

          Canvas {
            id: graph
            width: parent.width
            height: Style.space(130)
            onPaint: {
              var ctx = getContext("2d")
              root.drawGraph(ctx)
            }
            onWidthChanged: graph.requestPaint()
            onHeightChanged: graph.requestPaint()

            MouseArea {
              id: graphHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.CrossCursor
              onPositionChanged: function(mouse) {
                root.graphHoverX = mouse.x
                graph.requestPaint()
              }
              onExited: {
                root.graphHoverX = -1
                graph.requestPaint()
              }
            }

            Connections {
              target: root
              function onSamplesRevisionChanged() { if (root.opened) graph.requestPaint() }
            }
          }
        }

        // ------------------------------------------------------ stats
        Column {
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Math.max(statsHeader.implicitHeight, scaleButtons.implicitHeight)

            Text {
              id: statsHeader
              text: "STATS"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Row {
              id: scaleButtons
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              Repeater {
                model: [10, 30, 60, 180, 360]
                Button {
                  required property int modelData
                  required property int index
                  text: root.minutesLabel(modelData)
                  fontSize: Style.font.bodySmall
                  foreground: root.bar.foreground
                  fontFamily: root.bar.fontFamily
                  horizontalPadding: Style.spacing.controlPaddingX
                  verticalPadding: Style.spacing.controlPaddingY
                  bordered: true
                  active: root.statsMinutes === modelData
                  onClicked: root.statsMinutes = modelData
                }
              }
            }
          }

          Row {
            width: parent.width
            spacing: Style.space(12)

            StatCell { label: "Average"; value: root.formatWatts(root.averageWatts) }
            StatCell { label: "Peak"; value: root.formatWatts(root.peakWatts) }
            StatCell { label: "Energy"; value: root.energyWh.toFixed(2) + " Wh" }
            StatCell { label: "Runtime"; value: root.runtimeText }
          }
        }

        // ------------------------------------------------------ battery
        PanelSeparator {
          foreground: root.bar.foreground
        }

        Row {
          width: parent.width
          spacing: Style.space(20)

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair { label: "State"; value: root.stateLabel }
            InfoPair { label: root.discharging ? "Time left" : "Time to full"; value: root.timeLabel }
          }

          Column {
            width: (parent.width - parent.spacing) / 2
            spacing: Style.spacing.labelGap
            InfoPair { label: "Battery size"; value: batteryInfo.size || "—" }
            InfoPair { label: "Charge cycles"; value: batteryInfo.cycles || "—" }
          }
        }
      }
    }
  }

  component StatCell: Column {
    property string label: ""
    property string value: ""

    width: (parent.width - parent.spacing * 3) / 4
    spacing: Style.space(2)

    Text {
      text: label
      color: Qt.darker(root.bar.foreground, 1.4)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      font.letterSpacing: 1.0
    }

    Text {
      text: value
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      width: parent.width
    }
  }

  component InfoPair: Row {
    property string label: ""
    property string value: ""

    width: parent.width
    spacing: Style.space(8)

    InfoLabel { text: label }
    Item { width: Math.max(0, parent.width - parent.children[0].implicitWidth - parent.children[2].implicitWidth - parent.spacing * 2); height: 1 }
    InfoValue { text: value }
  }

  component InfoLabel: Text {
    color: root.bar.foreground
    opacity: 0.6
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component InfoValue: Text {
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
