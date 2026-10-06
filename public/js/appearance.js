/* Shared appearance choices for the renderer, recorder and native window controls. */
(function (root) {
  "use strict";
  const palettes = {
    tech: { color: "#0c1b2b", symbolColor: "#e1f3ff", height: 40 },
    dark: { color: "#262729", symbolColor: "#ededee", height: 40 },
    light: { color: "#f7f7f8", symbolColor: "#242528", height: 40 },
  };
  function resolveTheme(settings = {}) {
    // Apply the requested new palette once; later explicit choices remain saved.
    return settings.techPaletteConfigured &&
      Object.hasOwn(palettes, settings.theme)
      ? settings.theme
      : "tech";
  }
  const api = { palettes, resolveTheme };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.lewisAppearance = api;
})(typeof window === "object" ? window : globalThis);
