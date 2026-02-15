// app/ui/assets/theme.js
(() => {
  "use strict";

  const KEY = "hydromonitor.theme.v1";
  const root = document.documentElement;

  function systemPref() {
    try {
      return window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  }

  function setTheme(theme, { persist = false, source = "manual" } = {}) {
    const t = theme === "light" ? "light" : "dark";

    // aplica al root -> tu CSS ya reacciona a :root[data-theme="light"]
    root.dataset.theme = t;

    if (persist) localStorage.setItem(KEY, t);

    // botón
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      const isLight = t === "light";
      btn.textContent = isLight ? "🌙" : "☀️";
      btn.setAttribute("aria-pressed", isLight ? "true" : "false");
      btn.title = isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro";
    }

    // notifica a la app (para que charts/UI recalculen colores)
    window.dispatchEvent(new CustomEvent("hydromonitor:themechange", {
      detail: { theme: t, source }
    }));
  }

  function getSaved() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  // 1) Set inicial lo más pronto posible
  const saved = getSaved();
  setTheme(saved || systemPref(), { persist: false, source: saved ? "saved" : "system" });

  // 2) DOM listo: engancha el toggle y escucha cambios del sistema
  document.addEventListener("DOMContentLoaded", () => {
    // re-aplica por si el HTML se cargó antes que este script
    const savedNow = getSaved();
    setTheme(savedNow || systemPref(), { persist: false, source: savedNow ? "saved" : "system" });

    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const cur = root.dataset.theme || "dark";
        const next = cur === "dark" ? "light" : "dark";
        setTheme(next, { persist: true, source: "toggle" });
      });
    }

    // si NO hay preferencia guardada, sigue al sistema
    try {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => {
        if (getSaved()) return; // si el usuario ya eligió, no lo pisamos
        setTheme(systemPref(), { persist: false, source: "system" });
      };

      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch {
      // ignore
    }
  });
})();
