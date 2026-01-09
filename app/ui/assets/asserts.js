/* global Chart */
(() => {
  "use strict";

  const $title = document.getElementById("metric-title");
  const $subtitle = document.getElementById("metric-subtitle");
  const $desc = document.getElementById("metric-desc");
  const $blog = document.getElementById("blog");

  const $btnPdf = document.getElementById("btn-export-pdf");
  const $btnXlsx = document.getElementById("btn-export-xlsx");

  const DAYS = 30;
  const LIMIT = 5000;

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getMetricKeyFromPath() {
    // /metric/<key>
    const parts = location.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[1] || "");
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} ${txt}`);
    }
    return res.json();
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

  function buildChart(rows) {
    const canvas = document.getElementById("history-chart");
    if (!canvas) return;

    const labels = [];
    const data = [];

    for (const r of (rows || [])) {
      const ts = r.ts ? new Date(r.ts) : null;
      labels.push(ts ? ts.toLocaleString() : "");
      const v = (r.value === null || r.value === undefined) ? null : Number(r.value);
      data.push(Number.isFinite(v) ? Number(v.toFixed(2)) : null);
    }

    new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{ data, borderWidth: 2, pointRadius: 0, tension: 0.25 }]
      },
      options: chartOptions()
    });
  }

  function buildBlog(rows, unitFallback = "") {
    if (!Array.isArray(rows) || rows.length === 0) {
      $blog.innerHTML = `<div style="opacity:.8;">No hay lecturas en los últimos ${DAYS} días.</div>`;
      return;
    }

    // blog: más reciente primero
    const copy = [...rows].reverse();

    $blog.innerHTML = copy.map(r => {
      const ts = escapeHtml(r.ts || "");
      const value = (r.value === null || r.value === undefined) ? "--" : Number(r.value).toFixed(2);
      const unit = escapeHtml(r.unit || unitFallback || "");
      const dev = escapeHtml(r.device_id || "");
      const topic = escapeHtml(r.topic || "");

      return `
        <div style="padding:12px 10px; border-bottom:1px solid rgba(255,255,255,.06);">
          <div style="font-size:12px; opacity:.8;">${ts}</div>
          <div style="font-size:18px; margin-top:4px;">
            <strong>${value}</strong> <span style="opacity:.8;">${unit}</span>
          </div>
          <div style="font-size:12px; opacity:.75; margin-top:6px;">
            ${dev ? `device: <strong>${dev}</strong> • ` : ""}topic: <code style="opacity:.9;">${topic}</code>
          </div>
        </div>
      `;
    }).join("");
  }

  async function boot() {
    const key = getMetricKeyFromPath();
    if (!key) {
      $title.textContent = "Historial";
      $subtitle.textContent = "Métrica inválida";
      return;
    }

    // export se hace en el próximo paso
    $btnPdf.disabled = true;
    $btnXlsx.disabled = true;

    $title.textContent = `Historial: ${key}`;
    $subtitle.textContent = `Cargando últimos ${DAYS} días…`;
    $desc.textContent = `Últimos ${DAYS} días (máximo ${LIMIT} registros)`;

    const metrics = await fetchJson("/api/metrics");
    const meta = Array.isArray(metrics) ? metrics.find(m => m.key === key) : null;

    if (meta) {
      $title.textContent = `Historial: ${meta.name}`;
      $subtitle.textContent = `${meta.key} • ${meta.kind || ""} • ${meta.unit || ""}`.trim();
    } else {
      $subtitle.textContent = `${key} • (métrica no encontrada en /api/metrics)`;
    }

    const rows = await fetchJson(`/api/metrics/${encodeURIComponent(key)}/readings?days=${DAYS}&limit=${LIMIT}`);

    buildChart(rows);
    buildBlog(rows, meta?.unit || "");
  }

  boot().catch(err => {
    console.error(err);
    $subtitle.textContent = "Error cargando historial";
    $blog.innerHTML = `<div style="opacity:.8;">Error: ${escapeHtml(err.message || String(err))}</div>`;
  });
})();
