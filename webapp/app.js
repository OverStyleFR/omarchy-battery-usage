const state = {
  minutes: 360,
  viewMode: "auto",
  summary: null,
  history: [],
  daily: [],
  chargeDaily: [],
  historyHoverX: null,
  dailyHoverX: null,
  historyGeometry: null,
  dailyGeometry: null,
  loading: false,
};

const $ = (id) => document.getElementById(id);

const MIN_DISCHARGE_WATTS = 1.0;
const MIN_CHARGE_WATTS = 0.05;

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function rangeValue() {
  return state.minutes === "all" ? "all" : String(state.minutes);
}

function rangeLabel(minutes = state.minutes) {
  if (minutes === "all" || minutes === null) return "All retained history";
  if (minutes < 60) return `Last ${minutes} minutes`;
  if (minutes < 1440) return `Last ${minutes / 60} hours`;
  return `Last ${minutes / 1440} days`;
}

function number(value, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "--";
}

function formatWatts(value) {
  return `${number(value, 1)} W`;
}

function formatWh(value) {
  return `${number(value, 2)} Wh`;
}

function formatCoverage(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours < 24) return `${hours}h ${String(remaining).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatDateTime(epoch, withDate = false) {
  if (!epoch) return "--";
  const options = withDate
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(Number(epoch) * 1000));
}

function formatDay(day) {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function currentColor(variable, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

function withAlpha(color, alpha) {
  const value = String(color).trim().replace(/^#/, "");
  if (/^hsl\(/i.test(String(color).trim())) {
    return String(color).trim().replace(/^hsl\((.*)\)$/i, `hsl($1 / ${alpha})`);
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return color;
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function shiftedHue(color) {
  const value = String(color).trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#f6bd60";
  const red = parseInt(value.slice(0, 2), 16) / 255;
  const green = parseInt(value.slice(2, 4), 16) / 255;
  const blue = parseInt(value.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  let hue = 0;
  let saturation = 0;
  if (maximum !== minimum) {
    const delta = maximum - minimum;
    saturation = lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum);
    if (maximum === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
    else if (maximum === green) hue = ((blue - red) / delta + 2) / 6;
    else hue = ((red - green) / delta + 4) / 6;
  }
  hue = (hue + 0.12) % 1;
  saturation = Math.max(0.5, saturation);
  const adjustedLightness = Math.min(0.72, Math.max(0.45, lightness));
  return `hsl(${Math.round(hue * 360)} ${Math.round(saturation * 100)}% ${Math.round(adjustedLightness * 100)}%)`;
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme)) {
    if (/^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(`--${name}`, value);
  }
  if (theme.accent) root.style.setProperty("--charge", shiftedHue(theme.accent));
}

function setConnection(status, label) {
  const element = $("connectionStatus");
  element.classList.remove("is-loading", "is-live", "is-error");
  element.classList.add(`is-${status}`);
  setText("connectionText", label);
}

function setEmpty(id, visible) {
  const element = $(id);
  if (element) element.hidden = !visible;
}

function updateExportLinks() {
  const minutes = encodeURIComponent(rangeValue());
  $("exportCsv").href = `/api/export?minutes=${minutes}&format=csv`;
  $("exportJson").href = `/api/export?minutes=${minutes}&format=json`;
}

function effectiveMode(summary) {
  if (state.viewMode !== "auto") return state.viewMode;
  const battery = (summary && summary.battery) || {};
  return battery.state === "charging" ? "charge" : "discharge";
}

function renderSummary(summary) {
  const battery = summary.battery || {};
  const percentage = Number.parseFloat(String(battery.percentage || ""));
  const profile = summary.activeProfile || "--";
  const mode = effectiveMode(summary);
  const isCharge = mode === "charge";
  const liveState = battery.state === "charging" && summary.currentChargeWatts > 0.05;

  const stats = isCharge ? (summary.chargeStats || {}) : summary;
  const currentValue = isCharge ? summary.currentChargeWatts : summary.currentWatts;

  setText("currentLabel", isCharge ? "CURRENT CHARGE" : "CURRENT DRAW");
  $("currentWatts").classList.toggle("metric-value--charge", isCharge);
  setText("currentWatts", isCharge ? `+${formatWatts(currentValue)}` : formatWatts(currentValue));
  const currentDirection = isCharge
    ? `charging ${formatWatts(summary.currentChargeWatts)}`
    : `sample ${formatDateTime(summary.sampleEnd)}`;
  setText("currentState", `${battery.state || "Unknown state"} / ${currentDirection}`);

  setText("averageLabel", isCharge ? "AVERAGE CHARGE" : "AVERAGE");
  setText("averageWatts", formatWatts(stats.averageWatts));
  setText("rangeCaption", rangeLabel());

  setText("peakLabel", isCharge ? "PEAK CHARGE" : "PEAK");
  setText("peakWatts", formatWatts(stats.peakWatts));
  setText("minimumWatts", `Min ${formatWatts(stats.minimumWatts)}`);

  setText("energyLabel", isCharge ? "CHARGE ENERGY" : "ENERGY");
  setText("energyWh", formatWh(stats.energyWh));
  setText("coverageCaption", `${formatCoverage(stats.coverageSeconds)} measured`);

  setText("runtimeLabel", isCharge ? "TIME TO FULL" : "EST. RUNTIME");
  setText("runtime", isCharge ? (battery.time || "--") : (summary.runtime || "--"));

  setText("profileCaption", `Profile ${profile}`);
  setText("sampleCount", String(stats.count ?? "--"));
  setText("measuredCoverage", formatCoverage(stats.coverageSeconds));
  setText("historyRetained", `${Number(summary.retainedCount || 0).toLocaleString()} / ${formatCoverage(summary.retainedSeconds)}`);
  setText("lastSample", formatDateTime(summary.sampleEnd, true));

  setText("batteryPercent", Number.isFinite(percentage) ? `${Math.round(percentage)}%` : "--%");
  setText("batteryState", battery.state || "--");
  setText("batteryRate", battery.rate || "--");
  setText("batterySize", battery.size || "--");
  setText("batteryCycles", battery.cycles || "--");
  setText("batteryThreshold", battery.threshold || "--");
  setText("batteryTime", battery.time || "--");
  setText("batteryProfile", profile);

  const fill = $("batteryMeterFill");
  fill.style.width = `${Math.max(0, Math.min(100, Number.isFinite(percentage) ? percentage : 0))}%`;
}

function renderHistoryMeta(summary, history) {
  const count = Number(summary?.count || history.length || 0);
  setText("historyMeta", `${count.toLocaleString()} samples / ${formatCoverage(summary?.coverageSeconds)}`);
  setText("historyStart", formatDateTime(summary?.sampleStart, true));
  setText("historyEnd", formatDateTime(summary?.sampleEnd, true));
}

function renderDailyList() {
  const list = $("dailyList");
  const days = state.viewMode === "charge" ? state.chargeDaily : state.daily;
  const recent = days.slice(-7).reverse();
  list.innerHTML = recent.length
    ? recent.map(([day, value]) => `<div><span>${day}</span><strong>${formatWh(value)}</strong></div>`).join("")
    : "<div><span>No daily totals yet</span><strong>--</strong></div>";
  setText("dailyMeta", days.length ? `${days.length} day${days.length === 1 ? "" : "s"} recorded` : "No daily totals");
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function roundedBox(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
}

function drawChip(ctx, x, y, lines, bounds) {
  const title = lines[0];
  const subtitle = lines[1] || "";
  ctx.font = "700 13px ui-monospace, SFMono-Regular, monospace";
  const titleWidth = ctx.measureText(title).width;
  ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
  const subtitleWidth = ctx.measureText(subtitle).width;
  const width = Math.max(titleWidth, subtitleWidth) + 24;
  const height = subtitle ? 42 : 28;
  const chipX = Math.max(bounds.left, Math.min(x - width / 2, bounds.right - width));
  const chipY = Math.max(bounds.top, Math.min(y, bounds.bottom - height));
  const surface = currentColor("--surface-strong", "#151828");
  const accent = currentColor("--accent", "#82FB9C");
  const fg = currentColor("--fg", "#ddf7ff");

  roundedBox(ctx, chipX, chipY, width, height, 7);
  ctx.fillStyle = withAlpha(surface, 0.96);
  ctx.fill();
  ctx.strokeStyle = withAlpha(accent, 0.65);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "700 13px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = accent;
  ctx.fillText(title, chipX + 12, chipY + 7);
  if (subtitle) {
    ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
    ctx.fillStyle = withAlpha(fg, 0.72);
    ctx.fillText(subtitle, chipX + 12, chipY + 25);
  }
}

function drawHistory() {
  const canvas = $("historyChart");
  const { ctx, width, height } = prepareCanvas(canvas);
  const points = state.history;
  const padding = { left: 52, right: 18, top: 22, bottom: 30 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const fg = currentColor("--fg", "#ddf7ff");
  const muted = currentColor("--muted", "#9aa3bf");
  const accent = currentColor("--accent", "#82FB9C");

  state.historyGeometry = null;
  if (!points.length) {
    setEmpty("historyEmpty", false);
    return;
  }
  setEmpty("historyEmpty", true);

  const firstEpoch = points[0][0];
  const lastEpoch = points[points.length - 1][0];
  const timeSpan = Math.max(60, lastEpoch - firstEpoch);
  const maximumObserved = Math.max(0, ...points.map((point) => Math.max(point[1], point[2])));
  const minimum = 0;
  const maximum = maximumObserved < 0.5 ? 1 : maximumObserved * 1.12;

  const xFor = (epoch) => padding.left + ((epoch - firstEpoch) / timeSpan) * plotWidth;
  const yFor = (watts) => padding.top + (1 - (watts - minimum) / (maximum - minimum)) * plotHeight;
  state.historyGeometry = { firstEpoch, lastEpoch, padding, plotWidth, plotHeight, xFor, yFor };

  ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (plotHeight * index) / 4;
    const watts = maximum - ((maximum - minimum) * index) / 4;
    ctx.strokeStyle = withAlpha(fg, index === 4 ? 0.2 : 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotWidth, y);
    ctx.stroke();
    ctx.fillStyle = withAlpha(muted, 0.82);
    ctx.fillText(`${watts.toFixed(1)} W`, padding.left - 10, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let index = 0; index <= 4; index += 1) {
    const epoch = firstEpoch + (timeSpan * index) / 4;
    const x = xFor(epoch);
    ctx.fillStyle = withAlpha(muted, 0.82);
    ctx.fillText(formatDateTime(epoch), x, padding.top + plotHeight + 10);
  }

  const charge = currentColor("--charge", "#f6bd60");
  const drawSeries = (column, color, minValue) => {
    let active = false;
    let lastX = 0;
    ctx.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const value = points[index][column];
      const gap = index > 0 ? points[index][0] - points[index - 1][0] : 0;
      if (value <= minValue || gap > 60) {
        if (active) {
          ctx.lineTo(lastX, padding.top + plotHeight);
          ctx.closePath();
          active = false;
        }
        continue;
      }
      const x = xFor(points[index][0]);
      const y = yFor(value);
      if (!active) {
        ctx.moveTo(x, padding.top + plotHeight);
        ctx.lineTo(x, y);
        active = true;
      } else {
        ctx.lineTo(x, y);
      }
      lastX = x;
    }
    if (active) {
      ctx.lineTo(lastX, padding.top + plotHeight);
      ctx.closePath();
    }
    ctx.fillStyle = withAlpha(color, 0.13);
    ctx.fill();

    active = false;
    ctx.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const value = points[index][column];
      const gap = index > 0 ? points[index][0] - points[index - 1][0] : 0;
      if (value <= minValue || gap > 60) {
        active = false;
        continue;
      }
      const x = xFor(points[index][0]);
      const y = yFor(value);
      if (!active) {
        ctx.moveTo(x, y);
        active = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  };

  drawSeries(1, accent, MIN_DISCHARGE_WATTS);
  drawSeries(2, charge, MIN_CHARGE_WATTS);

  const latest = points[points.length - 1];
  if (latest[1] > MIN_DISCHARGE_WATTS) {
    ctx.beginPath();
    ctx.arc(xFor(latest[0]), yFor(latest[1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  if (latest[2] > MIN_CHARGE_WATTS) {
    ctx.beginPath();
    ctx.arc(xFor(latest[0]), yFor(latest[2]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = charge;
    ctx.fill();
  }

  if (state.historyHoverX !== null) {
    const hoverX = Math.max(padding.left, Math.min(state.historyHoverX, padding.left + plotWidth));
    const targetEpoch = firstEpoch + ((hoverX - padding.left) / plotWidth) * timeSpan;
    const index = nearestPoint(points, targetEpoch);
    const selected = points[index];
    const isCharging = selected[2] > 0.05;
    const selectedWatts = isCharging ? selected[2] : selected[1];
    const selectedColor = isCharging ? charge : accent;
    const selectedX = xFor(selected[0]);
    const selectedY = yFor(selectedWatts);
    ctx.strokeStyle = withAlpha(fg, 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(selectedX, padding.top);
    ctx.lineTo(selectedX, padding.top + plotHeight);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(selectedX, selectedY, 4, 0, Math.PI * 2);
    ctx.fillStyle = selectedColor;
    ctx.fill();
    drawChip(ctx, selectedX, padding.top + 8, [
      `${isCharging ? "CHARGE" : "DRAIN"} ${formatWatts(selectedWatts)}`,
      formatDateTime(selected[0], true),
    ], {
      left: padding.left,
      right: padding.left + plotWidth,
      top: padding.top,
      bottom: padding.top + plotHeight,
    });
  }
}

function nearestPoint(points, epoch) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle][0] < epoch) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const before = points[low - 1];
  const after = points[low];
  return Math.abs(before[0] - epoch) <= Math.abs(after[0] - epoch) ? low - 1 : low;
}

function drawDaily() {
  const canvas = $("dailyChart");
  const { ctx, width, height } = prepareCanvas(canvas);
  const rows = (state.viewMode === "charge" ? state.chargeDaily : state.daily).slice(-60);
  const padding = { left: 52, right: 18, top: 18, bottom: 34 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const fg = currentColor("--fg", "#ddf7ff");
  const muted = currentColor("--muted", "#9aa3bf");
  const accent = currentColor("--accent", "#82FB9C");

  state.dailyGeometry = null;
  if (!rows.length) {
    setEmpty("dailyEmpty", false);
    return;
  }
  setEmpty("dailyEmpty", true);

  const maximum = Math.max(1, ...rows.map((row) => Number(row[1]) || 0));
  const step = plotWidth / rows.length;
  const barWidth = Math.max(3, step * 0.68);
  const yFor = (value) => padding.top + plotHeight - (value / maximum) * plotHeight;
  state.dailyGeometry = { padding, plotWidth, plotHeight, step, barWidth, yFor, rows };

  ctx.font = "11px ui-monospace, SFMono-Regular, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let index = 0; index <= 3; index += 1) {
    const value = (maximum * (3 - index)) / 3;
    const y = padding.top + (plotHeight * index) / 3;
    ctx.strokeStyle = withAlpha(fg, index === 3 ? 0.2 : 0.1);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotWidth, y);
    ctx.stroke();
    ctx.fillStyle = withAlpha(muted, 0.82);
    ctx.fillText(`${value.toFixed(1)} Wh`, padding.left - 10, y);
  }

  rows.forEach(([day, value], index) => {
    const numericValue = Number(value) || 0;
    const x = padding.left + index * step + (step - barWidth) / 2;
    const y = yFor(numericValue);
    const isHovered = state.dailyHoverX !== null && dailyIndexAtX(state.dailyHoverX) === index;
    ctx.fillStyle = isHovered ? fg : withAlpha(accent, 0.82);
    roundedBox(ctx, x, y, barWidth, padding.top + plotHeight - y, 4);
    ctx.fill();
    if (index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 5) === 0) {
      ctx.fillStyle = withAlpha(muted, 0.82);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(formatDay(day), x + barWidth / 2, padding.top + plotHeight + 10);
    }
  });

  if (state.dailyHoverX !== null) {
    const index = dailyIndexAtX(state.dailyHoverX);
    if (index >= 0) {
      const [day, value] = rows[index];
      const x = padding.left + index * step + step / 2;
      const y = yFor(Number(value) || 0);
      drawChip(ctx, x, Math.max(padding.top, y - 48), [formatWh(value), formatDay(day)], {
        left: padding.left,
        right: padding.left + plotWidth,
        top: padding.top,
        bottom: padding.top + plotHeight,
      });
    }
  }
}

function dailyIndexAtX(x) {
  const geometry = state.dailyGeometry;
  if (!geometry) return -1;
  const index = Math.floor((x - geometry.padding.left) / geometry.step);
  return Math.max(0, Math.min(geometry.rows.length - 1, index));
}

async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadDashboard() {
  if (state.loading) return;
  state.loading = true;
  try {
    const minutes = encodeURIComponent(rangeValue());
    const [summary, history, daily, theme] = await Promise.all([
      getJson(`/api/summary?minutes=${minutes}`),
      getJson(`/api/history?minutes=${minutes}`),
      getJson("/api/daily?days=90"),
      getJson("/api/theme"),
    ]);
    applyTheme(theme);
    state.summary = summary;
    state.history = (history.samples || []).map(([epoch, discharge, charge = 0]) => [
      Number(epoch), Number(discharge), Number(charge),
    ]);
    state.daily = (daily.days || []).map(([day, value]) => [String(day), Number(value)]);
    state.chargeDaily = (daily.chargeDays || []).map(([day, value]) => [String(day), Number(value)]);
    renderSummary(summary);
    renderHistoryMeta(summary, state.history);
    renderDailyList();
    updateExportLinks();
    drawHistory();
    drawDaily();
    updateViewButtons();
    setConnection("live", "LIVE");
    setText("lastUpdated", `Updated ${formatDateTime(summary.serverTime, true)}`);
  } catch (error) {
    setConnection("error", "OFFLINE");
    setText("lastUpdated", `Error: ${error.message}`);
  } finally {
    state.loading = false;
  }
}

function updateViewButtons() {
  document.querySelectorAll(".view-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.viewMode);
  });
}

function bindRangeButtons() {
  document.querySelectorAll(".range-button").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.minutes;
      state.minutes = raw === "all" ? "all" : Number(raw);
      document.querySelectorAll(".range-button").forEach((item) => item.classList.toggle("is-active", item === button));
      setText("rangeDescription", rangeLabel());
      loadDashboard();
    });
  });
}

function bindViewButtons() {
  document.querySelectorAll(".view-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.viewMode = button.dataset.view;
      if (state.summary) renderSummary(state.summary);
      renderDailyList();
      drawDaily();
      updateViewButtons();
    });
  });
}

function bindCanvasInteractions() {
  const historyCanvas = $("historyChart");
  historyCanvas.addEventListener("pointermove", (event) => {
    const rect = historyCanvas.getBoundingClientRect();
    state.historyHoverX = event.clientX - rect.left;
    drawHistory();
  });
  historyCanvas.addEventListener("pointerleave", () => {
    state.historyHoverX = null;
    drawHistory();
  });

  const dailyCanvas = $("dailyChart");
  dailyCanvas.addEventListener("pointermove", (event) => {
    const rect = dailyCanvas.getBoundingClientRect();
    state.dailyHoverX = event.clientX - rect.left;
    drawDaily();
  });
  dailyCanvas.addEventListener("pointerleave", () => {
    state.dailyHoverX = null;
    drawDaily();
  });
}

$("refreshButton").addEventListener("click", loadDashboard);
bindRangeButtons();
bindViewButtons();
bindCanvasInteractions();
window.addEventListener("resize", () => {
  drawHistory();
  drawDaily();
});

setText("rangeDescription", rangeLabel());
loadDashboard();
window.setInterval(loadDashboard, 5000);
