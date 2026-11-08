const STORAGE_KEY = "wolfcoin.mobile.v1";

const TIMEFRAMES = [
  { id: "24h", days: "1", interval: "15m", limit: 96 },
  { id: "3d", days: "3", interval: "1h", limit: 72 },
  { id: "1w", days: "7", interval: "1h", limit: 168 },
  { id: "1m", days: "30", interval: "4h", limit: 180 },
  { id: "3m", days: "90", interval: "1d", limit: 90 },
  { id: "6m", days: "180", interval: "1d", limit: 180 },
  { id: "1y", days: "365", interval: "1d", limit: 365 },
  { id: "3y", days: "1095", interval: "3d", limit: 365 },
  { id: "5y", days: "1825", interval: "1w", limit: 260 },
  { id: "All", days: "max", interval: "1w", limit: 1000 },
];

const COLORS = ["#47f2ff", "#ff9e1f", "#8c66ff", "#40e673", "#ff4d8d"];

const DEFAULT_STATE = {
  currency: "eur",
  holdings: [
    { id: "bitcoin", symbol: "BTC", name: "Bitcoin", amount: "0.03264654" },
    { id: "ethereum", symbol: "ETH", name: "Ethereum", amount: "0.59200935" },
    { id: "stellar", symbol: "XLM", name: "Stellar", amount: "1523.8461449" },
  ],
};

const state = {
  ...loadState(),
  quotes: {},
  chartSeries: {},
  totalSeries: [],
  sparkSeries: [],
  sparkHover: null,
  timeframe: "1w",
  visible: { GESAMT: true },
  hover: null,
  selectedCoin: null,
  chartsLoading: false,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return {
      currency: parsed.currency === "usd" ? "usd" : "eur",
      holdings: Array.isArray(parsed.holdings) ? parsed.holdings : structuredClone(DEFAULT_STATE.holdings),
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ currency: state.currency, holdings: state.holdings })
  );
}

function money(value, currency = state.currency) {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: value >= 100 ? 0 : 2,
    minimumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatChange(pct) {
  if (pct == null || Number.isNaN(pct)) return "—";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1).replace(".", ",")}%`;
}

function formatDate(ms) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function holdingValue(h) {
  const q = state.quotes[h.id];
  if (!q) return null;
  return Number(h.amount) * q.price;
}

function totalValue() {
  let sum = 0;
  let ok = false;
  for (const h of state.holdings) {
    const v = holdingValue(h);
    if (v == null) continue;
    sum += v;
    ok = true;
  }
  return ok ? sum : null;
}

function dayMove() {
  let now = 0;
  let prev = 0;
  let ok = false;
  for (const h of state.holdings) {
    const q = state.quotes[h.id];
    if (!q || q.change24h == null) continue;
    const value = Number(h.amount) * q.price;
    const factor = 1 + q.change24h / 100;
    if (factor === 0) continue;
    now += value;
    prev += value / factor;
    ok = true;
  }
  if (!ok || prev === 0) return null;
  return ((now - prev) / prev) * 100;
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 429) throw new Error("Rate limit – bitte kurz warten.");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshPrices() {
  if (!state.holdings.length) {
    state.quotes = {};
    renderHome();
    return;
  }
  const ids = state.holdings.map((h) => h.id).join(",");
  const code = state.currency;
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=${code}&include_24hr_change=true&include_last_updated_at=true`;
  const data = await fetchJSON(url);
  const next = {};
  for (const h of state.holdings) {
    const row = data[h.id];
    if (!row || row[code] == null) continue;
    next[h.id] = {
      price: Number(row[code]),
      change24h: row[`${code}_24h_change`] ?? null,
      updatedAt: row.last_updated_at ? row.last_updated_at * 1000 : Date.now(),
    };
  }
  state.quotes = next;
  renderHome();
}

async function searchCoins(query) {
  if (!query.trim()) return [];
  const data = await fetchJSON(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query.trim())}`
  );
  return (data.coins || []).slice(0, 8).map((c) => ({
    id: c.id,
    name: c.name,
    symbol: String(c.symbol || "").toUpperCase(),
  }));
}

async function binanceSeries(symbol, currency, tf) {
  const pair = `${symbol.toUpperCase()}${currency.toUpperCase()}`;
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${pair}` +
    `&interval=${tf.interval}&limit=${tf.limit}`;
  const rows = await fetchJSON(url);
  return rows.map((row) => ({ t: row[0], v: Number(row[4]) })).filter((p) => Number.isFinite(p.v));
}

async function geckoSeries(id, currency, days) {
  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart` +
    `?vs_currency=${currency}&days=${days}`;
  const data = await fetchJSON(url);
  return (data.prices || []).map(([t, v]) => ({ t, v: Number(v) }));
}

function downsample(points, limit = 240) {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  const out = [];
  for (let i = 0; i < limit; i++) {
    out.push(points[Math.min(points.length - 1, Math.round(i * step))]);
  }
  return out;
}

function nearestPrice(points, t) {
  let best = points[0];
  let bestDelta = Math.abs(best.t - t);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].t - t);
    if (d < bestDelta) {
      best = points[i];
      bestDelta = d;
    }
    if (points[i].t > t && d > bestDelta) break;
  }
  return best.v;
}

function buildTotal(holdings, seriesMap) {
  const masterId = holdings.map((h) => h.id).find((id) => seriesMap[id]?.length);
  if (!masterId) return [];
  const master = seriesMap[masterId];
  const out = [];
  for (const sample of master) {
    let sum = 0;
    let ok = true;
    for (const h of holdings) {
      const pts = seriesMap[h.id];
      if (!pts?.length) {
        ok = false;
        break;
      }
      sum += nearestPrice(pts, sample.t) * Number(h.amount);
    }
    if (ok) out.push({ t: sample.t, v: sum });
  }
  return out;
}

async function loadCharts() {
  const status = document.getElementById("charts-status");
  const btn = document.getElementById("reload-charts");
  const tf = TIMEFRAMES.find((t) => t.id === state.timeframe) || TIMEFRAMES[2];
  state.chartsLoading = true;
  btn.disabled = true;
  status.textContent = "Lade Kurse…";

  const seriesMap = {};
  const tasks = state.holdings.map(async (h) => {
    try {
      let pts = await binanceSeries(h.symbol, state.currency, tf);
      if (pts.length < 2) pts = await geckoSeries(h.id, state.currency, tf.days);
      seriesMap[h.id] = downsample(pts);
    } catch {
      try {
        seriesMap[h.id] = downsample(await geckoSeries(h.id, state.currency, tf.days));
      } catch {
        seriesMap[h.id] = [];
      }
    }
  });

  await Promise.all(tasks);
  state.chartSeries = seriesMap;
  state.totalSeries = buildTotal(state.holdings, seriesMap);
  for (const h of state.holdings) {
    if (state.visible[h.symbol] == null) state.visible[h.symbol] = true;
  }
  state.chartsLoading = false;
  btn.disabled = false;
  const loaded = Object.values(seriesMap).filter((p) => p.length >= 2).length;
  status.textContent = loaded
    ? `Fertig · ${loaded}/${state.holdings.length} Coins`
    : "Keine Chartdaten – später erneut versuchen.";
  renderVisibility();
  renderCharts();
  updateReadout();
}

function updateReadout() {
  const valueEl = document.getElementById("readout-value");
  const labelEl = document.getElementById("readout-label");
  const dateEl = document.getElementById("readout-date");
  const mathEl = document.getElementById("math-equation");
  const strip = document.querySelector(".math-strip");

  const titleEl = document.querySelector(".math-title");
  if (state.hover) {
    valueEl.textContent = money(state.hover.value);
    labelEl.textContent = state.hover.label;
    dateEl.textContent = `· ${formatDate(state.hover.t)}`;
    if (titleEl) titleEl.textContent = "WERT ZU DIESEM ZEITPUNKT";
  } else {
    const last = state.totalSeries[state.totalSeries.length - 1];
    if (last) {
      valueEl.textContent = money(last.v);
      labelEl.textContent = "GESAMT";
      dateEl.textContent = `· ${formatDate(last.t)}`;
    } else {
      const total = totalValue();
      valueEl.textContent = total == null ? "—" : money(total);
      labelEl.textContent = "GESAMT";
      const times = Object.values(state.quotes).map((q) => q.updatedAt).filter(Boolean);
      dateEl.textContent = times.length ? `· ${formatDate(Math.max(...times))}` : "· —";
    }
    if (titleEl) titleEl.textContent = "SO RECHNET SICH DAS";
  }
  if (strip) strip.style.opacity = "1";

  if (mathEl) renderMathEquation(mathEl);
}

function nearestSeriesValue(points, t) {
  if (!points || !points.length) return null;
  let best = points[0];
  let bestD = Math.abs(best.t - t);
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best.v;
}

function renderMathEquation(el) {
  const at = state.hover?.t ?? null;
  const parts = [];
  const values = [];
  state.holdings.forEach((h, index) => {
    let val = null;
    if (at != null) {
      const unit = state.chartSeries[h.id] || [];
      const spot = nearestSeriesValue(unit, at);
      if (spot != null) val = spot * Number(h.amount);
    } else {
      val = holdingValue(h);
    }
    values.push(val);
    const color = COLORS[(index + 1) % COLORS.length];
    if (index > 0) parts.push(`<span class="math-op">+</span>`);
    parts.push(
      `<div class="math-chip" style="--chip:${color}">
        <span class="sym">${h.symbol}</span>
        <span class="val">${val == null ? "—" : money(val)}</span>
      </div>`
    );
  });
  let total = null;
  if (at != null) {
    total = nearestSeriesValue(state.totalSeries, at);
    if (total == null && values.every((v) => v != null)) total = values.reduce((a, b) => a + b, 0);
  } else {
    total = totalValue();
  }
  parts.push(`<span class="math-op eq">=</span>`);
  parts.push(
    `<div class="math-chip total" style="--chip:${COLORS[0]}">
      <span class="sym">GESAMT</span>
      <span class="val">${total == null ? "—" : money(total)}</span>
    </div>`
  );
  el.innerHTML = parts.join("");
}

function renderHome() {
  const total = totalValue();
  const move = dayMove();
  const glyph = state.currency === "usd" ? "$" : "€";
  document.getElementById("home-glyph").textContent = glyph;
  document.getElementById("home-total").textContent =
    total == null ? (state.holdings.length ? "…" : "0") : money(total).replace(/\s?[€$]/g, "").trim();
  document.getElementById("home-total-pill").textContent = total == null ? "—" : money(total);
  document.getElementById("top-total").textContent = total == null ? "…" : money(total);

  const changePill = document.getElementById("home-change-pill");
  if (move == null) {
    changePill.classList.add("hidden");
  } else {
    changePill.classList.remove("hidden");
    changePill.textContent = formatChange(move);
  }

  const rows = document.getElementById("home-rows");
  rows.innerHTML = state.holdings
    .map((h) => {
      const q = state.quotes[h.id];
      const val = holdingValue(h);
      return `<div class="coin-row">
        <span class="sym">${h.symbol}</span>
        <span class="chg">${q?.change24h == null ? "" : formatChange(q.change24h)}</span>
        <span class="val">${val == null ? "—" : money(val)}</span>
      </div>`;
    })
    .join("");

  const times = Object.values(state.quotes).map((q) => q.updatedAt).filter(Boolean);
  const fresh = document.getElementById("home-fresh");
  if (!times.length) fresh.textContent = "Lade Preise…";
  else {
    const d = new Date(Math.max(...times));
    fresh.textContent = `Updated ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  updateReadout();
  renderHomeMath();
  drawHomeSpark();
}

function renderHomeMath() {
  const el = document.getElementById("home-math-equation");
  const title = document.querySelector("#home-math .math-title");
  if (!el) return;
  const at = state.sparkHover?.t ?? null;
  if (title) title.textContent = at == null ? "SO RECHNET SICH DAS" : "WERT ZU DIESEM ZEITPUNKT";
  const parts = [];
  const values = [];
  state.holdings.forEach((h, index) => {
    let val = null;
    if (at != null && state._sparkByCoin?.[h.id]) {
      const spot = nearestSeriesValue(state._sparkByCoin[h.id], at);
      if (spot != null) val = spot * Number(h.amount);
    } else {
      val = holdingValue(h);
    }
    values.push(val);
    const color = COLORS[(index + 1) % COLORS.length];
    if (index > 0) parts.push(`<span class="math-op">+</span>`);
    parts.push(
      `<div class="math-chip" style="--chip:${color}">
        <span class="sym">${h.symbol}</span>
        <span class="val">${val == null ? "—" : money(val)}</span>
      </div>`
    );
  });
  let total = null;
  if (at != null) {
    total = nearestSeriesValue(state.sparkSeries, at);
    if (total == null && values.every((v) => v != null)) total = values.reduce((a, b) => a + b, 0);
  } else total = totalValue();
  parts.push(`<span class="math-op eq">=</span>`);
  parts.push(
    `<div class="math-chip total" style="--chip:${COLORS[0]}">
      <span class="sym">GESAMT</span>
      <span class="val">${total == null ? "—" : money(total)}</span>
    </div>`
  );
  el.innerHTML = parts.join("");
}

async function loadSpark() {
  const tf = { interval: "15m", limit: 96, days: "1" };
  const seriesMap = {};
  await Promise.all(
    state.holdings.map(async (h) => {
      try {
        let pts = await binanceSeries(h.symbol, state.currency, tf);
        if (pts.length < 2) pts = await geckoSeries(h.id, state.currency, tf.days);
        seriesMap[h.id] = downsample(pts, 64);
      } catch {
        try {
          seriesMap[h.id] = downsample(await geckoSeries(h.id, state.currency, tf.days), 64);
        } catch {
          seriesMap[h.id] = [];
        }
      }
    })
  );
  state._sparkByCoin = seriesMap;
  state.sparkSeries = buildTotal(state.holdings, seriesMap);
  drawHomeSpark();
  renderHomeMath();
}

function drawHomeSpark() {
  const canvas = document.getElementById("home-spark");
  const hoverEl = document.getElementById("home-spark-hover");
  if (!canvas) return;
  const points = state.sparkSeries;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
  const height = 56;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!points || points.length < 2) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.font = "11px Space Grotesk";
    ctx.fillText(state.holdings.length ? "Lade 24h…" : "Keine Coins", 10, 32);
    return;
  }

  const pad = { l: 6, r: 6, t: 8, b: 8 };
  const vals = points.map((p) => p.v);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = maxV - minV || 1;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const tSpan = maxT - minT || 1;
  const color = vals[vals.length - 1] >= vals[0] ? "#0d8c3f" : "#ff2d8a";
  const xAt = (t) => pad.l + ((t - minT) / tSpan) * (width - pad.l - pad.r);
  const yAt = (v) => pad.t + (1 - (v - minV) / span) * (height - pad.t - pad.b);

  const strokeFill = () => {
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(p.t);
      const y = yAt(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.lineTo(xAt(points[points.length - 1].t), height - pad.b);
    ctx.lineTo(xAt(points[0].t), height - pad.b);
    ctx.closePath();
    ctx.fillStyle = color + "2a";
    ctx.fill();
  };
  strokeFill();

  if (state.sparkHover) {
    const pt = points.reduce((best, p) =>
      Math.abs(p.t - state.sparkHover.t) < Math.abs(best.t - state.sparkHover.t) ? p : best
    );
    const x = xAt(pt.t);
    const y = yAt(pt.v);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (hoverEl) {
      hoverEl.textContent = money(pt.v);
      hoverEl.classList.remove("hidden");
    }
  } else if (hoverEl) {
    hoverEl.classList.add("hidden");
  }

  if (!canvas._sparkBound) {
    canvas._sparkBound = true;
    const pick = (clientX) => {
      const pts = state.sparkSeries;
      if (!pts?.length) return null;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || width;
      const x = clientX - rect.left;
      const t0 = pts[0].t;
      const t1 = pts[pts.length - 1].t;
      const t = t0 + ((x - 6) / Math.max(1, w - 12)) * (t1 - t0 || 1);
      return pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));
    };
    const scrub = (e) => {
      const pt = pick(e.clientX);
      if (!pt) return;
      state.sparkHover = pt;
      renderHomeMath();
      drawHomeSpark();
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      scrub(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons || e.pointerType === "mouse" || canvas.hasPointerCapture?.(e.pointerId)) scrub(e);
    });
    const clear = () => {
      state.sparkHover = null;
      renderHomeMath();
      drawHomeSpark();
    };
    canvas.addEventListener("pointerup", clear);
    canvas.addEventListener("pointerleave", () => {
      if (window.matchMedia("(pointer:fine)").matches) clear();
    });
  }
}

function renderTimeframes() {
  const el = document.getElementById("timeframes");
  el.innerHTML = TIMEFRAMES.map(
    (t) => `<button class="chip ${t.id === state.timeframe ? "on" : ""}" data-tf="${t.id}" type="button">${t.id}</button>`
  ).join("");
}

function renderVisibility() {
  const el = document.getElementById("visibility");
  const items = [{ key: "GESAMT", label: "GESAMT" }, ...state.holdings.map((h) => ({ key: h.symbol, label: h.symbol }))];
  el.innerHTML = items
    .map((item) => {
      const on = state.visible[item.key] !== false;
      return `<button class="chip eye ${on ? "on" : ""}" data-vis="${item.key}" type="button">${item.label}</button>`;
    })
    .join("");
}

function renderCharts() {
  const list = document.getElementById("chart-list");
  const cards = [];
  if (state.visible.GESAMT !== false) {
    cards.push({ label: "GESAMT", points: state.totalSeries, color: COLORS[0] });
  }
  state.holdings.forEach((h, index) => {
    if (state.visible[h.symbol] === false) return;
    const unit = state.chartSeries[h.id] || [];
    const points = unit.map((p) => ({ t: p.t, v: p.v * Number(h.amount) }));
    cards.push({ label: h.symbol, points, color: COLORS[(index + 1) % COLORS.length] });
  });

  list.innerHTML = cards
    .map((c, i) => {
      const extremes = minMax(c.points);
      const extremeHtml = extremes
        ? `<div class="chart-extremes">
            <div>
              <div class="ext-label">MIN ${money(extremes.min.v)}</div>
              <div class="ext-date">${formatDate(extremes.min.t)}</div>
            </div>
            <div>
              <div class="ext-label">MAX ${money(extremes.max.v)}</div>
              <div class="ext-date">${formatDate(extremes.max.t)}</div>
            </div>
          </div>`
        : "";
      return `<article class="chart-card" style="--accent:${c.color}">
        <h3>${c.label}</h3>
        ${extremeHtml}
        <canvas data-chart="${i}" height="160"></canvas>
      </article>`;
    })
    .join("");

  cards.forEach((c, i) => {
    const canvas = list.querySelector(`canvas[data-chart="${i}"]`);
    drawChart(canvas, c.points, c.color, c.label);
  });
  updateReadout();
}

function minMax(points) {
  if (!points || points.length < 2) return null;
  let min = points[0];
  let max = points[0];
  for (const p of points) {
    if (p.v < min.v) min = p;
    if (p.v > max.v) max = p;
  }
  return { min, max };
}

function drawChart(canvas, points, color, label) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const height = 160;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!points || points.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "14px Space Grotesk";
    ctx.fillText("Nicht genug Daten.", 12, 28);
    return;
  }

  const pad = { l: 8, r: 8, t: 12, b: 8 };
  const vals = points.map((p) => p.v);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = maxV - minV || 1;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const tSpan = maxT - minT || 1;

  const xAt = (t) => pad.l + ((t - minT) / tSpan) * (width - pad.l - pad.r);
  const yAt = (v) => pad.t + (1 - (v - minV) / span) * (height - pad.t - pad.b);

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(p.t);
    const y = yAt(p.v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = "round";
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.lineTo(xAt(last.t), height - pad.b);
  ctx.lineTo(xAt(points[0].t), height - pad.b);
  ctx.closePath();
  ctx.fillStyle = color + "26";
  ctx.fill();

  let active = null;
  const pick = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = minT + ((x - pad.l) / (width - pad.l - pad.r)) * tSpan;
    let best = points[0];
    let bestD = Math.abs(best.t - t);
    for (const p of points) {
      const d = Math.abs(p.t - t);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  };

  const paintActive = () => {
    drawChart(canvas, points, color, label);
    if (!active) return;
    const x = xAt(active.t);
    const y = yAt(active.v);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  };

  // Redraw base only once above; attach listeners once per canvas via property flag.
  if (canvas._wolfBound) return;
  canvas._wolfBound = true;

  const onMove = (clientX) => {
    active = pick(clientX);
    state.hover = { label, value: active.v, t: active.t };
    updateReadout();
    // Full redraw with guide
    const dpr2 = window.devicePixelRatio || 1;
    ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(p.t);
      const y = yAt(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.lineTo(xAt(last.t), height - pad.b);
    ctx.lineTo(xAt(points[0].t), height - pad.b);
    ctx.closePath();
    ctx.fillStyle = color + "26";
    ctx.fill();
    const x = xAt(active.t);
    const y = yAt(active.v);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    onMove(e.clientX);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons || e.pointerType === "touch" || canvas.hasPointerCapture?.(e.pointerId)) {
      onMove(e.clientX);
    } else if (e.pointerType === "mouse") {
      onMove(e.clientX);
    }
  });
  canvas.addEventListener("pointerup", () => {
    active = null;
    state.hover = null;
    updateReadout();
    renderCharts();
  });
  canvas.addEventListener("pointerleave", () => {
    if (window.matchMedia("(pointer:fine)").matches) {
      active = null;
      state.hover = null;
      updateReadout();
      renderCharts();
    }
  });

  void paintActive;
}

function renderSettings() {
  document.getElementById("currency-select").value = state.currency;
  const rows = document.getElementById("settings-rows");
  rows.innerHTML = state.holdings
    .map(
      (h) => `<div class="settings-row" data-id="${h.id}">
        <div>
          <strong>${h.symbol}</strong>
          <div class="meta">${h.name}</div>
        </div>
        <input type="text" inputmode="decimal" value="${h.amount}" aria-label="Menge ${h.symbol}" />
        <div class="actions">
          <button class="save" type="button" data-save="${h.id}">Speichern</button>
          <button class="del" type="button" data-del="${h.id}">Löschen</button>
        </div>
      </div>`
    )
    .join("");
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "charts" && !Object.keys(state.chartSeries).length && !state.chartsLoading) {
    loadCharts();
  }
  if (name === "settings") renderSettings();
}

function wire() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });

  renderTimeframes();
  document.getElementById("timeframes").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tf]");
    if (!btn) return;
    state.timeframe = btn.dataset.tf;
    renderTimeframes();
    loadCharts();
  });

  document.getElementById("visibility").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vis]");
    if (!btn) return;
    const key = btn.dataset.vis;
    state.visible[key] = state.visible[key] === false;
    renderVisibility();
    renderCharts();
  });

  document.getElementById("reload-charts").addEventListener("click", () => loadCharts());

  document.getElementById("currency-select").addEventListener("change", async (e) => {
    state.currency = e.target.value;
    saveState();
    await refreshPrices();
    if (document.getElementById("view-charts").classList.contains("active")) loadCharts();
  });

  let searchTimer;
  document.getElementById("coin-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const hits = await searchCoins(e.target.value).catch(() => []);
      const box = document.getElementById("search-hits");
      box.innerHTML = hits
        .map(
          (h) => `<button class="search-hit ${state.selectedCoin?.id === h.id ? "on" : ""}" type="button" data-hit='${JSON.stringify(h)}'>
            <strong>${h.symbol}</strong> · ${h.name}
          </button>`
        )
        .join("");
    }, 280);
  });

  document.getElementById("search-hits").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hit]");
    if (!btn) return;
    state.selectedCoin = JSON.parse(btn.dataset.hit);
    document.getElementById("coin-search").value = `${state.selectedCoin.symbol} · ${state.selectedCoin.name}`;
    document.querySelectorAll(".search-hit").forEach((el) => el.classList.toggle("on", el === btn));
  });

  document.getElementById("add-coin").addEventListener("click", async () => {
    if (!state.selectedCoin) {
      alert("Bitte zuerst einen Coin aus der Suche wählen.");
      return;
    }
    const amount = document.getElementById("coin-amount").value.trim().replace(",", ".");
    if (!amount || Number.isNaN(Number(amount))) {
      alert("Bitte eine gültige Menge eingeben.");
      return;
    }
    const existing = state.holdings.find((h) => h.id === state.selectedCoin.id);
    if (existing) existing.amount = amount;
    else {
      state.holdings.push({
        id: state.selectedCoin.id,
        symbol: state.selectedCoin.symbol,
        name: state.selectedCoin.name,
        amount,
      });
      state.visible[state.selectedCoin.symbol] = true;
    }
    saveState();
    document.getElementById("coin-amount").value = "";
    document.getElementById("search-hits").innerHTML = "";
    state.selectedCoin = null;
    renderSettings();
    await refreshPrices();
  });

  document.getElementById("settings-rows").addEventListener("click", async (e) => {
    const saveId = e.target.dataset.save;
    const delId = e.target.dataset.del;
    if (saveId) {
      const row = e.target.closest(".settings-row");
      const amount = row.querySelector("input").value.trim().replace(",", ".");
      const h = state.holdings.find((x) => x.id === saveId);
      if (h && amount && !Number.isNaN(Number(amount))) {
        h.amount = amount;
        saveState();
        await refreshPrices();
      }
    }
    if (delId) {
      state.holdings = state.holdings.filter((h) => h.id !== delId);
      saveState();
      renderSettings();
      await refreshPrices();
    }
  });
}

async function boot() {
  wire();
  renderHome();
  renderVisibility();
  try {
    await refreshPrices();
  } catch (err) {
    document.getElementById("home-fresh").textContent = err.message || "Preis-Fehler";
  }
  loadSpark().catch(() => {});
  setInterval(() => {
    refreshPrices().catch(() => {});
  }, 60_000);
  setInterval(() => {
    loadSpark().catch(() => {});
  }, 5 * 60_000);
}

boot();
