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

  function setTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    root.dataset.theme = t;

    const btn = document.getElementById("theme-toggle");
    if (btn) {
      const isLight = t === "light";
      btn.textContent = isLight ? "🌙" : "☀️";
      btn.setAttribute("aria-pressed", isLight ? "true" : "false");
      btn.title = isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro";
    }
  }

  // Tema inicial
  const saved = localStorage.getItem(KEY);
  setTheme(saved || systemPref());

  // Click toggle
  document.addEventListener("DOMContentLoaded", () => {
    setTheme(localStorage.getItem(KEY) || systemPref());

    const btn = document.getElementById("theme-toggle");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const cur = root.dataset.theme || "dark";
      const next = cur === "dark" ? "light" : "dark";
      localStorage.setItem(KEY, next);
      setTheme(next);
    });
  });
})();
