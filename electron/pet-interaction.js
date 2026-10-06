"use strict";
function hitRegion(point, region) {
  if (region.kind === "circle") {
    return (
      ((point.x - region.x - region.width / 2) / (region.width / 2)) ** 2 +
        ((point.y - region.y - region.height / 2) / (region.height / 2)) ** 2 <=
      1
    );
  }
  return (
    point.x >= region.x &&
    point.y >= region.y &&
    point.x <= region.x + region.width &&
    point.y <= region.y + region.height
  );
}
// 主进程检查屏幕光标，即便透明窗口不接收鼠标，也能恢复头像的拖动/右键交互。
function createPetInteraction(window, screen) {
  let regions = [],
    dragging = false,
    ignored,
    dragOrigin,
    menuOpen = false,
    dragStarted = 0;
  function refresh() {
    if (window.isDestroyed()) return;
    if (dragging && window.isVisible()) {
      if (Date.now() - dragStarted > 60000) dragging = false;
      else if (dragOrigin && typeof window.setPosition === "function") {
        const cursor = screen.getCursorScreenPoint();
        let x = Math.round(dragOrigin.x + cursor.x - dragOrigin.cursor.x),
          y = Math.round(dragOrigin.y + cursor.y - dragOrigin.cursor.y);
        const area = screen.getDisplayNearestPoint?.(cursor)?.workArea;
        if (area) {
          const bounds = window.getContentBounds();
          x = Math.max(area.x, Math.min(area.x + area.width - bounds.width, x));
          y = Math.max(
            area.y,
            Math.min(area.y + area.height - bounds.height, y),
          );
        }
        window.setPosition(x, y);
      }
    }
    let next = true;
    if (window.isVisible()) {
      const bounds = window.getContentBounds(),
        cursor = screen.getCursorScreenPoint();
      next = !(
        dragging ||
        menuOpen ||
        regions.some((region) =>
          hitRegion({ x: cursor.x - bounds.x, y: cursor.y - bounds.y }, region),
        )
      );
    } else dragging = false;
    if (next !== ignored) {
      window.setIgnoreMouseEvents(next, { forward: true });
      ignored = next;
    }
  }
  function report(value) {
    if (!Array.isArray(value) || value.length > 2) return;
    const bounds = window.getContentBounds();
    if (
      !value.every(
        (region) =>
          region &&
          ["circle", "rect"].includes(region.kind) &&
          ["x", "y", "width", "height"].every((key) =>
            Number.isFinite(region[key]),
          ) &&
          region.width > 0 &&
          region.height > 0 &&
          region.x >= -5 &&
          region.y >= -5 &&
          region.x + region.width <= bounds.width + 5 &&
          region.y + region.height <= bounds.height + 5,
      )
    )
      return;
    regions = value.map((region) => ({ ...region }));
    refresh();
  }
  const timer = setInterval(refresh, 40);
  timer.unref?.();
  refresh();
  return {
    report,
    refresh,
    setDragging: (value) => {
      if (typeof value === "boolean") {
        dragging = value;
        if (value) {
          const bounds = window.getContentBounds();
          dragOrigin = {
            x: bounds.x,
            y: bounds.y,
            cursor: screen.getCursorScreenPoint(),
          };
          dragStarted = Date.now();
        } else dragOrigin = null;
        refresh();
      }
    },
    setMenuOpen: (value) => {
      menuOpen = Boolean(value);
      refresh();
    },
    reset: () => {
      dragging = false;
      menuOpen = false;
      dragOrigin = null;
      ignored = undefined;
      refresh();
    },
    destroy: () => clearInterval(timer),
  };
}
module.exports = { hitRegion, createPetInteraction };
