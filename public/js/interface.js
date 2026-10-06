/* Appearance and keyboard access; application behavior stays in existing modules. */
(function () {
  "use strict";
  function theme(value) {
    document.documentElement.dataset.theme = Object.hasOwn(
      window.lewisAppearance.palettes,
      value,
    )
      ? value
      : "tech";
    window.electronAPI?.setAppearance?.(document.documentElement.dataset.theme);
  }
  try {
    theme(
      window.lewisAppearance.resolveTheme(
        JSON.parse(localStorage.getItem("lewis_settings") || "{}"),
      ),
    );
  } catch {
    theme("tech");
  }
  document.addEventListener("DOMContentLoaded", () => {
    const panel = document.getElementById("settingsPanel"),
      root = document.querySelector(".app");
    let previous;
    const menus = [
      ...document.querySelectorAll(".desktop-titlebar nav > details"),
    ];
    const closeMenus = (except) =>
      menus.forEach((menu) => {
        if (menu !== except) menu.open = false;
      });
    for (const menu of menus) {
      const summary = menu.querySelector("summary");
      summary.addEventListener("click", () => closeMenus(menu));
      menu.addEventListener("toggle", () => {
        summary.setAttribute("aria-expanded", String(menu.open));
        if (menu.open) closeMenus(menu);
      });
      menu.addEventListener("click", (event) => {
        if (event.target.closest("button,a")) closeMenus();
      });
    }
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".desktop-titlebar nav > details"))
        closeMenus();
    });
    if (window.electronAPI) {
      document.body.classList.add("desktop");
      document.querySelector(".desktop-titlebar").hidden = false;
    }
    window.lewisSettingsCategory = (category) => {
      for (const section of panel.querySelectorAll("[data-settings-page]"))
        section.hidden = section.dataset.settingsPage !== category;
      for (const button of panel.querySelectorAll("[data-settings-category]"))
        button.classList.toggle(
          "active",
          button.dataset.settingsCategory === category,
        );
    };
    window.lewisSettingsCategory("general");
    document.getElementById("startCameraSettings").onclick = () =>
      window.lewisVision?.start().catch(() => {
        document.getElementById("gestureStatus").textContent =
          "摄像头未能开启，请检查权限或设备占用";
      });
    for (const button of panel.querySelectorAll("[data-settings-category]"))
      button.onclick = () =>
        window.lewisSettingsCategory(button.dataset.settingsCategory);
    window.lewisNavigate = (page = "chat") => {
      document.body.dataset.page = page;
      document.getElementById("pluginsPage").hidden = page !== "plugins";
      document.getElementById("skillPanel").hidden = true;
      for (const button of document.querySelectorAll(".sidebar-icon"))
        button.classList.toggle(
          "active",
          page === "plugins"
            ? button.id === "pluginMarketBtn"
            : button.title === "对话",
        );
      window.dispatchEvent(new Event("resize"));
    };
    for (const button of document.querySelectorAll("[data-plugin-tab]"))
      button.onclick = () => {
        for (const page of document.querySelectorAll("[data-plugin-page]"))
          page.hidden = page.dataset.pluginPage !== button.dataset.pluginTab;
        for (const item of document.querySelectorAll("[data-plugin-tab]"))
          item.setAttribute("aria-selected", String(item === button));
      };
    for (const button of document.querySelectorAll("[data-menu]"))
      button.onclick = () => {
        button.closest("details").open = false;
        document.getElementById(button.dataset.menu).click();
      };
    document.getElementById("diagnosticMenu").onclick = () => {
      document.getElementById("settingsBtn").click();
      window.lewisSettingsCategory("data");
    };
    document.getElementById("helpBtn").onclick = () => {
      document.getElementById("settingsBtn").click();
      window.lewisSettingsCategory("general");
    };
    document
      .querySelector('[data-settings-page="general"]')
      .insertAdjacentHTML(
        "beforeend",
        '<section class="settings-group"><h3>使用帮助</h3><p>输入任务后按 Enter 发送；Shift + Enter 换行。点击输入区的 + 添加图片、拍照或截图。</p><p>左侧切换历史对话、插件广场和手势工作室。说“Lewis 停下”可打断播报。</p></section>',
      );
    document
      .getElementById("newChatBtn")
      .addEventListener("click", () => window.lewisNavigate());
    document
      .getElementById("historySessions")
      .addEventListener("change", () => window.lewisNavigate());
    const historySelect = document.getElementById("historySessions"),
      historyList = document.createElement("div");
    historyList.id = "historyList";
    historySelect.after(historyList);
    historySelect.hidden = true;
    const renderHistory = () => {
      historyList.replaceChildren();
      for (const option of historySelect.options) {
        if (!option.value) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = option.textContent;
        button.title = option.textContent;
        button.classList.toggle("active", option.value === historySelect.value);
        button.onclick = () => {
          historySelect.value = option.value;
          historySelect.dispatchEvent(new Event("change"));
          renderHistory();
        };
        historyList.append(button);
      }
    };
    new MutationObserver(renderHistory).observe(historySelect, {
      childList: true,
      subtree: true,
    });
    historySelect.addEventListener("change", renderHistory);
    renderHistory();
    const choice = document.getElementById("themeChoice");
    choice.value = document.documentElement.dataset.theme;
    choice.addEventListener("change", () => theme(choice.value));
    document.getElementById("skillsClose").addEventListener("click", () => {
      document.getElementById("skillPanel").hidden = true;
      document.querySelector('[title="技能"]').focus();
    });
    document.querySelector('[title="对话"]').addEventListener("click", () => {
      window.lewisNavigate();
      document.getElementById("skillPanel").hidden = true;
      document.getElementById("messageInput").focus({ preventScroll: true });
    });
    for (const input of document.querySelectorAll(".settings-input")) {
      const label = input.previousElementSibling;
      if (label?.classList.contains("settings-label")) {
        label.id = input.id + "-label";
        input.setAttribute("aria-labelledby", label.id);
      }
    }
    document.getElementById("sendBtn").setAttribute("aria-label", "发送消息");
    document.getElementById("voiceBtn").setAttribute("aria-label", "语音输入");
    document
      .getElementById("messageInput")
      .setAttribute("aria-label", "对话指令");
    const sync = () => {
      const opened = panel.classList.contains("open");
      panel.inert = !opened;
      panel.setAttribute("aria-hidden", String(!opened));
      root.inert = opened;
      if (opened) {
        previous = document.activeElement;
        document.getElementById("settingsClose").focus();
      } else if (previous) {
        previous.focus();
        previous = null;
      }
    };
    sync();
    new MutationObserver(sync).observe(panel, {
      attributes: true,
      attributeFilter: ["class"],
    });
    document.addEventListener("keydown", (event) => {
      if (
        !event.isComposing &&
        (event.ctrlKey || event.metaKey) &&
        event.key === ","
      ) {
        event.preventDefault();
        document.getElementById("settingsBtn").click();
        return;
      }
      if (
        window.electronAPI &&
        !panel.classList.contains("open") &&
        event.ctrlKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        document.getElementById("newChatBtn").click();
        return;
      }
      if (event.key === "Escape") {
        document
          .querySelectorAll(".desktop-titlebar details,.composer-attachments")
          .forEach((el) => (el.open = false));
        if (panel.classList.contains("open"))
          document.getElementById("settingsClose").click();
        else if (!document.getElementById("skillPanel").hidden)
          document.getElementById("skillsClose").click();
        return;
      }
      if (event.key !== "Tab" || !panel.classList.contains("open")) return;
      const items = [
        ...panel.querySelectorAll("button,input,textarea,select,a,summary"),
      ].filter((el) => !el.disabled && el.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
  });
})();
