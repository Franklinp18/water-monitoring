/* global Chart */
(() => {
  "use strict";

  const $title = document.getElementById("metric-title");
  const $subtitle = document.getElementById("metric-subtitle");
  const $desc = document.getElementById("metric-desc");
  const $blog = document.getElementById("blog");

  const $btnPdf = document.getElementById("btn-export-pdf");
  const $btnCsv = document.getElementById("btn-export-csv");

  const DAYS = 30;
  const LIMIT = 5000;

  // ✅ Bitácora: "Ver más"
  const BLOG_PAGE_SIZE = 25; // cambia a 20/30 si quieres
  let blogVisible = BLOG_PAGE_SIZE;
  let blogCache = []; // rows normalizados (asc)
  let blogUnitFallback = "";

  let chartInstance = null;

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function cssVar(name, fallback = "") {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ✅ Soporta metric.html?key=xxx (principal) + fallback por path
  function getMetricKey() {
    try {
      const u = new URL(window.location.href);
      const q = (u.searchParams.get("key") || "").trim();
      if (q) return q;

      // fallback: /metric/<key> o /metric.html/<key>
      const parts = u.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1] || "";
      if (last && !last.endsWith(".html")) return decodeURIComponent(last);
      return "";
    } catch {
      return "";
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? ` -> ${txt}` : ""}`);
    }
    return res.json();
  }

  function chartOptions() {
    const grid = cssVar("--chart-grid", "rgba(148,163,184,0.18)");
    const tick = cssVar("--chart-tick", "rgba(148,163,184,0.85)");
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { color: grid }, ticks: { color: tick } },
        y: { grid: { color: grid }, ticks: { color: tick } }
      }
    };
  }

  function normalizeRows(rows) {
    const safe = Array.isArray(rows) ? rows : [];
    // ordenar por ts asc
    return safe
      .map(r => ({ ...r }))
      .sort((a, b) => {
        const ta = a.ts ? new Date(a.ts).getTime() : 0;
        const tb = b.ts ? new Date(b.ts).getTime() : 0;
        return ta - tb;
      });
  }

  function buildChart(rows, unit = "") {
    const canvas = document.getElementById("history-chart");
    if (!canvas) return;

    const labels = [];
    const data = [];

    for (const r of rows) {
      const ts = r.ts ? new Date(r.ts) : null;
      labels.push(ts ? ts.toLocaleString() : "");
      const v = (r.value === null || r.value === undefined) ? null : Number(r.value);
      data.push(Number.isFinite(v) ? Number(v.toFixed(2)) : null);
    }

    if (chartInstance) {
      try { chartInstance.destroy(); } catch {}
      chartInstance = null;
    }

    const accent = cssVar("--accent", "#22d3ee");

    chartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data,
          borderColor: accent,
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25
        }]
      },
      options: chartOptions()
    });
  }

  // ✅ Render incremental con "Ver más"
  function renderBlogSlice() {
    if (!Array.isArray(blogCache) || blogCache.length === 0) {
      $blog.innerHTML = `<div style="opacity:.8;">No hay lecturas en los últimos ${DAYS} días.</div>`;
      return;
    }

    const total = blogCache.length;

    // más reciente primero
    const reversed = [...blogCache].reverse();
    const visible = reversed.slice(0, blogVisible);

    const itemsHtml = visible.map(r => {
      const ts = escapeHtml(r.ts ? new Date(r.ts).toLocaleString() : "");
      const num = (r.value === null || r.value === undefined) ? null : Number(r.value);
      const value = Number.isFinite(num) ? num.toFixed(2) : "--";
      const unit = escapeHtml(r.unit || blogUnitFallback || "");
      const dev = escapeHtml(r.device_id || "");
      const topic = escapeHtml(r.topic || "");

      return `
        <div style="padding:12px 10px; border-bottom:1px solid var(--tbl-border, rgba(255,255,255,.06));">
          <div style="font-size:12px; opacity:.8;">${ts}</div>
          <div style="font-size:18px; margin-top:4px;">
            <strong>${value}</strong> <span style="opacity:.8;">${unit}</span>
          </div>
          <div style="font-size:12px; opacity:.75; margin-top:6px;">
            ${dev ? `device: <strong>${dev}</strong> • ` : ""}topic:
            <code style="opacity:.9;">${topic}</code>
          </div>
        </div>
      `;
    }).join("");

    const remaining = total - visible.length;

    const controlsHtml = `
      <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; padding:12px 10px;">
        <div style="font-size:12px; opacity:.75;">
          Mostrando <strong>${visible.length}</strong> de <strong>${total}</strong>
        </div>
        <div>
          ${
            remaining > 0
              ? `<button class="btn ghost" id="btn-blog-more" type="button">Ver más (${remaining})</button>`
              : `<span style="font-size:12px; opacity:.7;">Fin</span>`
          }
        </div>
      </div>
    `;

    $blog.innerHTML = itemsHtml + controlsHtml;

    const $more = document.getElementById("btn-blog-more");
    $more?.addEventListener("click", () => {
      blogVisible = Math.min(blogVisible + BLOG_PAGE_SIZE, total);
      renderBlogSlice();
      try { $more.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
    });
  }

  function refreshChartTheme() {
    if (!chartInstance) return;
    try {
      const accent = cssVar("--accent", "#22d3ee");
      chartInstance.data.datasets[0].borderColor = accent;
      chartInstance.options = chartOptions();
      chartInstance.update();
    } catch {
      // ignore
    }
  }

  async function boot() {
    const key = getMetricKey();

    if (!key) {
      $title.textContent = "Historial";
      $subtitle.textContent = "Métrica inválida (falta ?key=...)";
      $desc.textContent = "Ejemplo: metric.html?key=humedad_suelo";
      return;
    }

    if ($btnPdf) $btnPdf.disabled = true;

    if ($btnCsv) {
      $btnCsv.disabled = false;
      $btnCsv.addEventListener("click", () => {
        const url = `/api/metrics/${encodeURIComponent(key)}/export.csv?days=${DAYS}`;
        window.location.href = url;
      });
    }

    $title.textContent = `Historial: ${key}`;
    $subtitle.textContent = `Cargando últimos ${DAYS} días…`;
    $desc.textContent = `Últimos ${DAYS} días (máx. ${LIMIT} registros)`;

    const metrics = await fetchJson("/api/metrics");
    const meta = Array.isArray(metrics) ? metrics.find(m => m.key === key) : null;

    if (meta) {
      $title.textContent = `Historial: ${meta.name}`;
      const kind = meta.kind || "";
      const unit = meta.unit || "";
      $subtitle.textContent = `${meta.key}${kind ? ` • ${kind}` : ""}${unit ? ` • ${unit}` : ""}`;
      blogUnitFallback = unit || "";
    } else {
      $subtitle.textContent = `${key} • (métrica no encontrada en /api/metrics)`;
      blogUnitFallback = "";
    }

    const rowsRaw = await fetchJson(
      `/api/metrics/${encodeURIComponent(key)}/readings?days=${DAYS}&limit=${LIMIT}`
    );

    const rows = normalizeRows(rowsRaw);

    buildChart(rows, meta?.unit || "");

    // ✅ Cache + primera página
    blogCache = rows;
    blogVisible = BLOG_PAGE_SIZE;
    renderBlogSlice();

    window.addEventListener("hydromonitor:themechange", () => {
      refreshChartTheme();
      // por si cambian vars de borde/texto
      renderBlogSlice();
    });
  }

  boot().catch(err => {
    console.error(err);
    $subtitle.textContent = "Error cargando historial";
    $blog.innerHTML = `<div style="opacity:.8;">Error: ${escapeHtml(err.message || String(err))}</div>`;
  });
})();
