/* global Chart */
(() => {
  const SIDEBAR_KEY = "hydromonitor.sidebarCollapsed.v1";

  const $grid = document.getElementById("grid");
  const $list = document.getElementById("metrics-list");
  const $empty = document.getElementById("empty");
  const $subtitle = document.getElementById("subtitle");

  const $modal = document.getElementById("modal-backdrop");
  const $btnAdd = document.getElementById("btn-add");
  const $btnAddEmpty = document.getElementById("btn-add-empty");
  const $btnClose = document.getElementById("btn-close");
  const $btnCancel = document.getElementById("btn-cancel");
  const $form = document.getElementById("metric-form");

  const $sidebarToggle = document.getElementById("sidebar-toggle");

  const charts = new Map(); // key -> Chart instance

  const state = {
    apiOnline: true,
    wsOnline: false,
    metrics: [],
    byKey: new Map(),
    series: new Map(), // key -> {labels,data}
    bars: new Map(),   // key -> {labels,data}
    tables: new Map(), // key -> rows
    kpis: new Map()    // key -> last
  };

  // ---------- API ----------
  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return null;
  }

  async function apiGetMetrics() {
    return fetchJson("/api/metrics");
  }
  async function apiCreateMetric(metric) {
    return fetchJson("/api/metrics", { method: "POST", body: JSON.stringify(metric) });
  }
  async function apiDeleteMetric(key) {
    return fetchJson(`/api/metrics/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  async function syncMetricsFromServer() {
    try {
      const metrics = await apiGetMetrics();
      state.apiOnline = true;

      // Backend devuelve: key,name,unit,kind,topic,desc,demo
      const arr = Array.isArray(metrics) ? metrics : [];
      state.metrics = arr.map(m => ({
        key: m.key,
        name: m.name,
        unit: m.unit || "",
        type: m.kind || "line",
        topic: m.topic || "",
        desc: m.desc || "",
        demo: !!m.demo
      }));

      state.byKey.clear();
      for (const m of state.metrics) state.byKey.set(m.key, m);
    } catch (e) {
      console.warn("[API] offline:", e);
      state.apiOnline = false;
      state.metrics = [];
      state.byKey.clear();
    }
  }

  // ---------- Utils ----------
  function slugify(s) {
    return (s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function mqttMatch(filter, topic) {
    // MQTT wildcards:
    // + matches one level, # matches all remaining levels
    if (!filter) return false;
    const f = String(filter).split("/");
    const t = String(topic).split("/");

    for (let i = 0, j = 0; i < f.length; i++, j++) {
      const fp = f[i];
      if (fp === "#") return true;
      if (j >= t.length) return false;
      if (fp === "+") continue;
      if (fp !== t[j]) return false;
    }
    return f.length === t.length;
  }

  function setEmptyState(isEmpty) {
    $empty.style.display = isEmpty ? "block" : "none";

    if (!state.apiOnline) {
      $subtitle.textContent = "API no disponible. No se pueden cargar/guardar métricas.";
      return;
    }

    const ws = state.wsOnline ? "WS: conectado" : "WS: desconectado";
    $subtitle.textContent = isEmpty
      ? `Sin métricas aún. Crea la primera con “Agregar métrica”. • ${ws}`
      : `Métricas configuradas. Esperando lecturas MQTT… • ${ws}`;
  }

  // ---------- Sidebar collapse ----------
  function applySidebarState() {
    const collapsed = localStorage.getItem(SIDEBAR_KEY) === "1";
    document.body.classList.toggle("sidebar-collapsed", collapsed);
  }

  function toggleSidebar() {
    const isCollapsed = document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem(SIDEBAR_KEY, isCollapsed ? "1" : "0");
  }

  // ---------- Demo data ----------
  function nowLabel() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function makeSeries(n = 24, base = 10, amp = 2) {
    const labels = [];
    const data = [];
    let v = base;
    for (let i = 0; i < n; i++) {
      labels.push(nowLabel());
      v += (Math.random() - 0.5) * amp;
      data.push(Number(v.toFixed(2)));
    }
    return { labels, data };
  }

  function chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "rgba(148,163,184,0.10)" }, ticks: { color: "rgba(148,163,184,0.80)" } },
        y: { grid: { color: "rgba(148,163,184,0.10)" }, ticks: { color: "rgba(148,163,184,0.80)" } }
      }
    };
  }

  // ---------- CRUD ----------
  async function addMetric(metric) {
    if (state.byKey.has(metric.key)) {
      alert("Ese key ya existe. Usa otro.");
      return;
    }

    await apiCreateMetric({
      key: metric.key,
      name: metric.name,
      unit: metric.unit || null,
      kind: metric.type || "line",
      topic: metric.topic,
      desc: metric.desc || "",
      demo: !!metric.demo
    });

    await syncMetricsFromServer();
    render();
  }

  async function removeMetric(key) {
    await apiDeleteMetric(key);

    charts.get(key)?.destroy?.();
    charts.delete(key);
    state.series.delete(key);
    state.bars.delete(key);
    state.tables.delete(key);
    state.kpis.delete(key);

    await syncMetricsFromServer();
    render();
  }

  // ---------- Render ----------
  function clearCharts() {
    for (const c of charts.values()) c.destroy();
    charts.clear();
  }

  function render() {
    const metrics = state.metrics || [];
    setEmptyState(metrics.length === 0);

    $list.innerHTML = "";
    for (const m of metrics) {
      const item = document.createElement("div");
      item.className = "sidebar-item";

      const demoTag = m.demo ? `<div class="pill" title="Demo activado">DEMO</div>` : "";
      const unitTag = `<div class="pill">${escapeHtml(m.unit || "")}</div>`;

      item.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="small">${escapeHtml(m.key)} • ${escapeHtml(m.type)} • ${escapeHtml(m.topic)}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          ${demoTag}
          ${unitTag}
          <button class="trash-btn" title="Eliminar métrica" data-del="${escapeHtml(m.key)}" type="button">🗑</button>
        </div>
      `;
      item.querySelector("[data-del]")?.addEventListener("click", () => removeMetric(m.key));
      $list.appendChild(item);
    }

    clearCharts();
    $grid.innerHTML = "";
    for (const m of metrics) $grid.appendChild(buildWidget(m));

    for (const m of metrics) {
      if (m.type === "line") mountLineChart(m);
      if (m.type === "bar") mountBarChart(m);
      if (m.type === "table") paintTable(m.key, state.tables.get(m.key) || [], m.unit || "");
      if (m.type === "kpi") {
        const last = state.kpis.get(m.key);
        const el = document.getElementById(`kpi-${m.key}`);
        if (el && last && Number.isFinite(last.value)) el.textContent = last.value.toFixed(2);
      }
    }
  }

  function buildWidget(metric) {
    const el = document.createElement("div");
    el.className = "widget";
    el.style.gridColumn = metric.type === "kpi" ? "span 3" : "span 6";
    if (metric.type === "table") el.style.gridColumn = "span 12";

    const sub = metric.desc ? `<div class="widget-sub">${escapeHtml(metric.desc)}</div>` : "";

    el.innerHTML = `
      <div class="widget-top">
        <div>
          <div class="widget-title">${escapeHtml(metric.name)}</div>
          ${sub}
        </div>
        <div class="widget-actions">
          <button class="trash-btn" title="Eliminar" data-del="${escapeHtml(metric.key)}" type="button">🗑</button>
        </div>
      </div>
      ${widgetBody(metric)}
    `;

    el.querySelector("[data-del]")?.addEventListener("click", () => removeMetric(metric.key));
    return el;
  }

  function widgetBody(metric) {
    if (metric.type === "kpi") {
      return `
        <div class="kpi">
          <div class="val" id="kpi-${metric.key}">--</div>
          <div class="unit">${escapeHtml(metric.unit || "")}</div>
        </div>
      `;
    }

    if (metric.type === "line" || metric.type === "bar") {
      return `<div class="chart-box"><canvas id="cv-${metric.key}"></canvas></div>`;
    }

    if (metric.type === "table") {
      return `
        <div class="table-box">
          <table class="tbl">
            <thead>
              <tr><th>Timestamp</th><th>Valor</th><th>Unidad</th></tr>
            </thead>
            <tbody id="tb-${metric.key}">
              <tr><td>--</td><td>--</td><td>${escapeHtml(metric.unit || "")}</td></tr>
            </tbody>
          </table>
        </div>
      `;
    }

    return "";
  }

  function mountLineChart(metric) {
    const canvas = document.getElementById(`cv-${metric.key}`);
    if (!canvas) return;

    let labels = [];
    let data = [];

    if (metric.demo) {
      const s = makeSeries(24, 10, 2);
      labels = s.labels;
      data = s.data;
    } else {
      const s = state.series.get(metric.key) || { labels: [], data: [] };
      labels = s.labels;
      data = s.data;
    }

    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{ data, borderWidth: 2, pointRadius: 0, tension: 0.25 }]
      },
      options: chartOptions()
    });

    charts.set(metric.key, chart);
  }

  function mountBarChart(metric) {
    const canvas = document.getElementById(`cv-${metric.key}`);
    if (!canvas) return;

    const labels = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
    let data = labels.map(() => 0);

    if (metric.demo) {
      data = labels.map(() => Number((Math.random() * 100).toFixed(1)));
    } else {
      const b = state.bars.get(metric.key);
      if (b && Array.isArray(b.data)) data = b.data;
    }

    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [{ data, borderWidth: 1 }] },
      options: chartOptions()
    });

    charts.set(metric.key, chart);
  }

  function paintTable(key, rows, unit) {
    const tb = document.getElementById(`tb-${key}`);
    if (!tb) return;

    tb.innerHTML = "";
    const safeRows = Array.isArray(rows) ? rows : [];

    if (safeRows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>--</td><td>--</td><td>${escapeHtml(unit || "")}</td>`;
      tb.appendChild(tr);
      return;
    }

    for (const r of safeRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(r.ts)}</td><td>${escapeHtml(r.value)}</td><td>${escapeHtml(r.unit || unit || "")}</td>`;
      tb.appendChild(tr);
    }
  }

  // ---------- WS apply ----------
  function applyReading(msg) {
    // msg trae topic, value, ts, unit, etc.
    const topic = msg.topic || "";
    const valueNum = typeof msg.value === "number" ? msg.value : Number(msg.value);

    // Actualiza TODAS las métricas que hacen match por topic
    for (const m of state.metrics) {
      if (m.demo) continue;
      if (!mqttMatch(m.topic, topic)) continue;

      const unit = msg.unit || m.unit || "";
      const tsLabel = msg.ts ? new Date(msg.ts).toLocaleString() : new Date().toLocaleString();

      if (m.type === "kpi") {
        const el = document.getElementById(`kpi-${m.key}`);
        if (el) el.textContent = Number.isFinite(valueNum) ? valueNum.toFixed(2) : "--";
        state.kpis.set(m.key, { value: valueNum, unit, ts: msg.ts });
      }

      if (m.type === "table") {
        const rows = state.tables.get(m.key) || [];
        rows.unshift({ ts: tsLabel, value: Number.isFinite(valueNum) ? valueNum.toFixed(2) : "--", unit });
        rows.splice(6);
        state.tables.set(m.key, rows);
        paintTable(m.key, rows, unit);
      }

      if (m.type === "line") {
        const s = state.series.get(m.key) || { labels: [], data: [] };
        const label = msg.ts
          ? new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        s.labels.push(label);
        s.data.push(Number.isFinite(valueNum) ? Number(valueNum.toFixed(2)) : null);

        const MAX = 120;
        if (s.labels.length > MAX) {
          s.labels = s.labels.slice(-MAX);
          s.data = s.data.slice(-MAX);
        }

        state.series.set(m.key, s);

        const chart = charts.get(m.key);
        if (chart) {
          chart.data.labels = s.labels;
          chart.data.datasets[0].data = s.data;
          chart.update();
        }
      }

      if (m.type === "bar") {
        const labels = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
        const b = state.bars.get(m.key) || { labels, data: labels.map(() => 0) };
        b.data = [...b.data.slice(1), Number.isFinite(valueNum) ? Number(valueNum.toFixed(1)) : 0];
        state.bars.set(m.key, b);

        const chart = charts.get(m.key);
        if (chart) {
          chart.data.datasets[0].data = b.data;
          chart.update();
        }
      }
    }
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      state.wsOnline = true;
      setEmptyState((state.metrics || []).length === 0);
    };

    ws.onclose = () => {
      state.wsOnline = false;
      setEmptyState((state.metrics || []).length === 0);
      setTimeout(connectWS, 1500);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg && msg.type === "reading") applyReading(msg);
      } catch {
        // ignore
      }
    };
  }

  // ---------- Demo tick ----------
  function tickDemo() {
    for (const m of state.metrics) {
      if (!m.demo) continue;

      if (m.type === "kpi") {
        const el = document.getElementById(`kpi-${m.key}`);
        if (el) el.textContent = Number((Math.random() * 100).toFixed(2));
      }

      if (m.type === "table") {
        const rows = [];
        for (let i = 0; i < 6; i++) {
          rows.push({
            ts: new Date(Date.now() - i * 60000).toLocaleString(),
            value: (Math.random() * 100).toFixed(2),
            unit: m.unit || ""
          });
        }
        state.tables.set(m.key, rows);
        paintTable(m.key, rows, m.unit || "");
      }

      const chart = charts.get(m.key);
      if (!chart) continue;

      if (m.type === "line") {
        const s = makeSeries(24, 10, 2);
        chart.data.labels = s.labels;
        chart.data.datasets[0].data = s.data;
        chart.update();
      }

      if (m.type === "bar") {
        chart.data.datasets[0].data = chart.data.labels.map(() => Number((Math.random() * 100).toFixed(1)));
        chart.update();
      }
    }
  }

  // ---------- Modal / Events ----------
  function openModal() {
    $modal.classList.remove("hidden");
  }
  function closeModal() {
    $modal.classList.add("hidden");
    $form.reset();
  }

  $btnAdd.addEventListener("click", openModal);
  $btnAddEmpty.addEventListener("click", openModal);
  $btnClose.addEventListener("click", closeModal);
  $btnCancel.addEventListener("click", closeModal);
  $modal.addEventListener("click", (e) => {
    if (e.target === $modal) closeModal();
  });

  $form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = $form.elements.name.value.trim();
    const keyRaw = $form.elements.key.value.trim();
    const key = slugify(keyRaw || name);

    const type = $form.elements.type.value;
    const unit = $form.elements.unit.value.trim();
    const topic = ($form.elements.topic.value || "").trim();
    const desc = ($form.elements.desc.value || "").trim();
    const demo = !!($form.elements.demo && $form.elements.demo.checked);

    if (!topic) {
      alert("Topic MQTT es obligatorio. Ej: hydromonit/+/humedad_suelo");
      return;
    }

    await addMetric({ name, key, type, unit, topic, desc, demo });
    closeModal();
  });

  $sidebarToggle.addEventListener("click", toggleSidebar);

  // ---------- Boot ----------
  async function boot() {
    applySidebarState();
    await syncMetricsFromServer();
    render();
    connectWS();

    tickDemo();
    setInterval(tickDemo, 5000);
  }

  // table minimal style
  const style = document.createElement("style");
  style.textContent = `
    table.tbl{ width:100%; border-collapse: collapse; font-size: 13px; }
    .tbl th,.tbl td{ padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); color: rgba(226,232,240,.86); }
    .tbl th{ text-align:left; font-size:12px; color: rgba(148,163,184,.70); background: rgba(2,6,23,.22); }
  `;
  document.head.appendChild(style);

  boot();
})();
