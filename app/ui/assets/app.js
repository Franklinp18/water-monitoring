/* global Chart */
(() => {
  const STORAGE_KEY = "hydromonitor.metrics.v1";
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

  function loadMetrics() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveMetrics(metrics) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
  }

  function slugify(s) {
    return (s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function openModal() {
    $modal.classList.remove("hidden");
  }
  function closeModal() {
    $modal.classList.add("hidden");
    $form.reset();
    $form.elements.demo.checked = true;
  }

  function setEmptyState(isEmpty) {
    $empty.style.display = isEmpty ? "block" : "none";
    $subtitle.textContent = isEmpty
      ? 'Sin métricas aún. Crea la primera con “Agregar métrica”.'
      : "Métricas configuradas localmente (MVP).";
  }

  function clearCharts() {
    for (const c of charts.values()) c.destroy();
    charts.clear();
  }

  // --- demo data
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

  // --- sidebar collapse (persistente)
  function applySidebarState() {
    const collapsed = localStorage.getItem(SIDEBAR_KEY) === "1";
    document.body.classList.toggle("sidebar-collapsed", collapsed);
  }

  function toggleSidebar() {
    const isCollapsed = document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem(SIDEBAR_KEY, isCollapsed ? "1" : "0");
  }

  // --- CRUD local
  function addMetric(metric) {
    const metrics = loadMetrics();

    if (metrics.some(m => m.key === metric.key)) {
      alert("Ese key ya existe. Usa otro (ej: flow_in, pressure_main).");
      return;
    }
    metrics.push(metric);
    saveMetrics(metrics);
    render();
  }

  function removeMetric(key) {
    const metrics = loadMetrics().filter(m => m.key !== key);
    saveMetrics(metrics);
    render();
  }

  // --- rendering
  function render() {
    const metrics = loadMetrics();
    setEmptyState(metrics.length === 0);

    // sidebar list
    $list.innerHTML = "";
    for (const m of metrics) {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="small">${escapeHtml(m.key)} • ${escapeHtml(m.type)}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <div class="pill">${escapeHtml(m.unit || "")}</div>
          <button class="trash-btn" title="Eliminar métrica" data-del="${escapeHtml(m.key)}" type="button">🗑</button>
        </div>
      `;
      item.querySelector("[data-del]")?.addEventListener("click", () => removeMetric(m.key));
      $list.appendChild(item);
    }

    // dashboard grid
    clearCharts();
    $grid.innerHTML = "";
    for (const m of metrics) $grid.appendChild(buildWidget(m));

    // mount charts
    for (const m of metrics) {
      if (m.type === "line") mountLineChart(m);
      if (m.type === "bar") mountBarChart(m);
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

    const series = makeSeries(24, 10, 2);
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: series.labels,
        datasets: [{ data: series.data, borderWidth: 2, pointRadius: 0, tension: 0.25 }]
      },
      options: chartOptions()
    });
    charts.set(metric.key, chart);
  }

  function mountBarChart(metric) {
    const canvas = document.getElementById(`cv-${metric.key}`);
    if (!canvas) return;

    const labels = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
    const data = labels.map(() => Number((Math.random() * 100).toFixed(1)));
    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [{ data, borderWidth: 1 }] },
      options: chartOptions()
    });
    charts.set(metric.key, chart);
  }

  function tickDemo() {
    const metrics = loadMetrics();

    // KPIs
    for (const m of metrics) {
      if (m.type === "kpi") {
        const el = document.getElementById(`kpi-${m.key}`);
        if (el) el.textContent = Number((Math.random() * 100).toFixed(2));
      }
      if (m.type === "table") {
        const tb = document.getElementById(`tb-${m.key}`);
        if (tb) {
          tb.innerHTML = "";
          for (let i = 0; i < 6; i++) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${new Date(Date.now() - i * 60000).toLocaleString()}</td><td>${(Math.random() * 100).toFixed(2)}</td><td>${escapeHtml(m.unit || "")}</td>`;
            tb.appendChild(tr);
          }
        }
      }
    }

    // Charts (solo si demo)
    for (const m of metrics) {
      if (!m.demo) continue;
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

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // events
  $btnAdd.addEventListener("click", openModal);
  $btnAddEmpty.addEventListener("click", openModal);
  $btnClose.addEventListener("click", closeModal);
  $btnCancel.addEventListener("click", closeModal);

  $modal.addEventListener("click", (e) => {
    if (e.target === $modal) closeModal();
  });

  $form.addEventListener("submit", (e) => {
    e.preventDefault();

    const name = $form.elements.name.value.trim();
    const keyRaw = $form.elements.key.value.trim();
    const key = slugify(keyRaw || name);
    const type = $form.elements.type.value;
    const unit = $form.elements.unit.value.trim();
    const desc = $form.elements.desc.value.trim();
    const demo = !!$form.elements.demo.checked;

    addMetric({ name, key, type, unit, desc, demo });
    closeModal();
  });

  $sidebarToggle.addEventListener("click", toggleSidebar);

  // boot
  applySidebarState();
  render();
  tickDemo();
  setInterval(tickDemo, 5000);

  // table minimal style
  const style = document.createElement("style");
  style.textContent = `
    table.tbl{ width:100%; border-collapse: collapse; font-size: 13px; }
    .tbl th,.tbl td{ padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); color: rgba(226,232,240,.86); }
    .tbl th{ text-align:left; font-size:12px; color: rgba(148,163,184,.70); background: rgba(2,6,23,.22); }
  `;
  document.head.appendChild(style);
})();
