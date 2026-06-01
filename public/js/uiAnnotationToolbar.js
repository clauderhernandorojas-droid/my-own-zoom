/**
 * uiAnnotationToolbar.js — barra de herramientas reutilizable (aspecto del tablero, IDs propios).
 */
(function (global) {
  const COLORS = [
    { color: "#111111", title: "Negro" },
    { color: "#e53935", title: "Rojo" },
    { color: "#fb8c00", title: "Naranja" },
    { color: "#fdd835", title: "Amarillo" },
    { color: "#43a047", title: "Verde" },
    { color: "#1e88e5", title: "Azul" },
    { color: "#8e24aa", title: "Violeta" },
  ];

  const LINE_WIDTHS = [
    { value: 2, label: "Fino" },
    { value: 4, label: "Medio" },
    { value: 7, label: "Grueso" },
  ];

  const TEXT_SIZES = [16, 24, 30, 36, 42, 48];

  const EMOJIS = global.BoardToolCatalog?.BOARD_EMOJIS || [
    "😀", "😂", "😍", "🤔", "👏", "👍", "🎉", "✅",
  ];

  /**
   * @param {object} opts
   * @param {string} opts.idPrefix
   * @param {HTMLElement} opts.hostEl
   * @param {function(): void} [opts.onClose]
   * @param {function(string): void} [opts.onToolChange]
   * @param {function(string): void} [opts.onColorChange]
   * @param {function(number): void} [opts.onLineWidthChange]
   * @param {function(number): void} [opts.onTextSizeChange]
   * @param {function(string): void} [opts.onEmojiInsert]
   * @param {function(): void} [opts.onUndo]
   * @param {function(): void} [opts.onRedo]
   */
  function create(opts) {
    const idPrefix = opts.idPrefix || "annotToolbar";
    const hostEl = opts.hostEl;
    if (!hostEl) throw new Error("uiAnnotationToolbar: hostEl requerido");

    let activeTool = "pointer";
    let activeColor = "#111111";
    let lineWidth = 4;
    let textSize = 24;
    let openMenu = "";

    const ids = {
      pointer: `${idPrefix}BtnPointer`,
      pencil: `${idPrefix}BtnPencil`,
      eraser: `${idPrefix}BtnEraser`,
      text: `${idPrefix}BtnText`,
      emoji: `${idPrefix}BtnEmoji`,
      palette: `${idPrefix}BtnPalette`,
      lineWidth: `${idPrefix}BtnLineWidth`,
      textSize: `${idPrefix}BtnTextSize`,
      undo: `${idPrefix}BtnUndo`,
      redo: `${idPrefix}BtnRedo`,
      close: `${idPrefix}BtnClose`,
      paletteMenu: `${idPrefix}PaletteMenu`,
      lineWidthMenu: `${idPrefix}LineWidthMenu`,
      textSizeMenu: `${idPrefix}TextSizeMenu`,
      emojiMenu: `${idPrefix}EmojiMenu`,
      colorInput: `${idPrefix}ColorInput`,
    };

    hostEl.innerHTML = "";
    hostEl.classList.add("screen-overlay-toolbar-root");

    const panel = document.createElement("div");
    panel.className = "screen-overlay-toolbar-panel";

    const wrap = document.createElement("div");
    wrap.className = "screen-overlay-vtoolbar";
    wrap.setAttribute("role", "toolbar");
    wrap.setAttribute("aria-label", "Anotaciones sobre pantalla compartida");

    wrap.innerHTML = `
      <button type="button" id="${ids.pointer}" class="tool-btn active" title="Puntero">
        <svg class="board-tool-icon board-tool-icon--cursor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 3l7.8 15 2.1-5.5 5.6-2.2z"></path>
        </svg>
      </button>
      <button type="button" id="${ids.pencil}" class="tool-btn" title="Lápiz">
        <span class="board-tool-emoji" aria-hidden="true">✏️</span>
      </button>
      <button type="button" id="${ids.eraser}" class="tool-btn" title="Borrador">
        <span class="board-tool-emoji" aria-hidden="true">🧽</span>
      </button>
      <button type="button" id="${ids.text}" class="tool-btn" title="Texto">
        <span class="board-tool-glyph" aria-hidden="true">T</span>
      </button>
      <button type="button" id="${ids.emoji}" class="tool-btn" title="Emoji">
        <span class="board-tool-emoji" aria-hidden="true">😀</span>
      </button>
      <button type="button" id="${ids.palette}" class="tool-btn" title="Colores">
        <span class="board-tool-emoji" aria-hidden="true">🎨</span>
      </button>
      <button type="button" id="${ids.lineWidth}" class="tool-btn" title="Grosor del lápiz">━</button>
      <button type="button" id="${ids.textSize}" class="tool-btn" title="Tamaño de texto">A</button>
      <div class="tool-sep"></div>
      <button type="button" id="${ids.undo}" class="tool-btn screen-overlay-history-btn" title="Deshacer">↶</button>
      <button type="button" id="${ids.redo}" class="tool-btn screen-overlay-history-btn" title="Rehacer">↷</button>
      <div class="tool-sep"></div>
      <button type="button" id="${ids.close}" class="tool-btn screen-overlay-close-btn" title="Cerrar barra">×</button>
    `;

    panel.appendChild(wrap);
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("click", (e) => e.stopPropagation());

    const paletteMenu = document.createElement("div");
    paletteMenu.id = ids.paletteMenu;
    paletteMenu.className = "screen-overlay-side-menu hidden";
    paletteMenu.setAttribute("role", "menu");
    paletteMenu.innerHTML = `<p class="screen-overlay-side-menu__title">Color</p>
      <div class="screen-overlay-color-grid">${COLORS.map(
        (c) =>
          `<button type="button" class="screen-overlay-color-swatch${c.color === activeColor ? " active" : ""}" data-color="${c.color}" style="background:${c.color}" title="${c.title}"></button>`
      ).join("")}
      </div>
      <input id="${ids.colorInput}" type="color" value="${activeColor}" title="Color personalizado" style="margin-top:8px;width:100%" />`;

    const lineWidthMenu = document.createElement("div");
    lineWidthMenu.id = ids.lineWidthMenu;
    lineWidthMenu.className = "screen-overlay-side-menu hidden";
    lineWidthMenu.innerHTML = `<p class="screen-overlay-side-menu__title">Grosor</p>${LINE_WIDTHS.map(
      (lw) =>
        `<button type="button" class="screen-overlay-menu-choice screen-overlay-line-width-choice${lw.value === lineWidth ? " screen-overlay-menu-choice--active" : ""}" data-line-width="${lw.value}">${lw.label}</button>`
    ).join("")}`;

    const textSizeMenu = document.createElement("div");
    textSizeMenu.id = ids.textSizeMenu;
    textSizeMenu.className = "screen-overlay-side-menu hidden";
    textSizeMenu.innerHTML = `<p class="screen-overlay-side-menu__title">Tamaño</p>${TEXT_SIZES.map(
      (s) =>
        `<button type="button" class="screen-overlay-menu-choice screen-overlay-text-size-choice${s === textSize ? " screen-overlay-menu-choice--active" : ""}" data-text-size="${s}">${s}px</button>`
    ).join("")}`;

    const emojiMenu = document.createElement("div");
    emojiMenu.id = ids.emojiMenu;
    emojiMenu.className = "screen-overlay-side-menu hidden";
    emojiMenu.setAttribute("role", "menu");
    emojiMenu.innerHTML = `<p class="screen-overlay-side-menu__title">Insertar emoji</p>
      <div class="screen-overlay-emoji-grid">${EMOJIS.map(
        (em) =>
          `<button type="button" class="screen-overlay-emoji-btn" data-emoji="${em}">${em}</button>`
      ).join("")}</div>`;

    for (const menu of [paletteMenu, lineWidthMenu, textSizeMenu, emojiMenu]) {
      menu.addEventListener("pointerdown", (e) => e.stopPropagation());
      menu.addEventListener("click", (e) => e.stopPropagation());
    }

    hostEl.appendChild(panel);
    hostEl.appendChild(paletteMenu);
    hostEl.appendChild(lineWidthMenu);
    hostEl.appendChild(textSizeMenu);
    hostEl.appendChild(emojiMenu);

    function $(id) {
      return hostEl.querySelector(`#${CSS.escape(id)}`);
    }

    function closeMenus() {
      openMenu = "";
      paletteMenu.classList.add("hidden");
      lineWidthMenu.classList.add("hidden");
      textSizeMenu.classList.add("hidden");
      emojiMenu.classList.add("hidden");
    }

    function syncToolUi() {
      $(ids.pointer)?.classList.toggle("active", activeTool === "pointer");
      $(ids.pencil)?.classList.toggle("active", activeTool === "pencil");
      $(ids.eraser)?.classList.toggle("active", activeTool === "eraser");
      $(ids.text)?.classList.toggle("active", activeTool === "text");
      paletteMenu.querySelectorAll(".screen-overlay-color-swatch").forEach((el) => {
        el.classList.toggle("active", (el.dataset.color || "").toLowerCase() === activeColor.toLowerCase());
      });
      const colorInput = $(ids.colorInput);
      if (colorInput && colorInput.value.toLowerCase() !== activeColor.toLowerCase()) {
        colorInput.value = activeColor;
      }
    }

    function setTool(tool) {
      activeTool = tool;
      syncToolUi();
      opts.onToolChange?.(tool);
    }

    function toggleMenu(name, anchorBtn) {
      if (openMenu === name) {
        closeMenus();
        return;
      }
      closeMenus();
      openMenu = name;
      const menu =
        name === "palette"
          ? paletteMenu
          : name === "lineWidth"
            ? lineWidthMenu
            : name === "textSize"
              ? textSizeMenu
              : emojiMenu;
      menu.classList.remove("hidden");
      if (anchorBtn) {
        const hostRect = hostEl.getBoundingClientRect();
        const btnRect = anchorBtn.getBoundingClientRect();
        menu.style.top = `${btnRect.top - hostRect.top}px`;
        menu.style.left = `${btnRect.right - hostRect.left + 8}px`;
      }
    }

    function onDocClick(e) {
      if (!hostEl.contains(e.target)) closeMenus();
    }

    document.addEventListener("click", onDocClick);

    const bindToolBtn = (el, tool) => {
      if (!el) return;
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", () => setTool(tool));
    };

    bindToolBtn($(ids.pointer), "pointer");
    bindToolBtn($(ids.pencil), "pencil");
    bindToolBtn($(ids.eraser), "eraser");
    bindToolBtn($(ids.text), "text");

    $(ids.emoji)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("emoji", e.currentTarget);
    });

    $(ids.palette)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("palette", e.currentTarget);
    });

    $(ids.lineWidth)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("lineWidth", e.currentTarget);
    });

    $(ids.textSize)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("textSize", e.currentTarget);
    });

    $(ids.close)?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenus();
      opts.onClose?.();
    });

    paletteMenu.querySelectorAll(".screen-overlay-color-swatch").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeColor = btn.dataset.color || "#111111";
        syncToolUi();
        opts.onColorChange?.(activeColor);
        closeMenus();
      });
    });

    $(ids.colorInput)?.addEventListener("input", (e) => {
      activeColor = e.target.value || "#111111";
      syncToolUi();
      opts.onColorChange?.(activeColor);
    });

    lineWidthMenu.querySelectorAll("[data-line-width]").forEach((btn) => {
      btn.addEventListener("click", () => {
        lineWidth = Number(btn.dataset.lineWidth) || 4;
        lineWidthMenu.querySelectorAll("[data-line-width]").forEach((b) => {
          b.classList.toggle("screen-overlay-menu-choice--active", b === btn);
        });
        opts.onLineWidthChange?.(lineWidth);
        closeMenus();
      });
    });

    textSizeMenu.querySelectorAll("[data-text-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        textSize = Number(btn.dataset.textSize) || 24;
        textSizeMenu.querySelectorAll("[data-text-size]").forEach((b) => {
          b.classList.toggle("screen-overlay-menu-choice--active", b === btn);
        });
        opts.onTextSizeChange?.(textSize);
        closeMenus();
      });
    });

    emojiMenu.querySelectorAll("[data-emoji]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const emoji = btn.dataset.emoji || "";
        if (emoji) opts.onEmojiInsert?.(emoji);
        closeMenus();
      });
    });

    $(ids.undo)?.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onUndo?.();
    });
    $(ids.redo)?.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onRedo?.();
    });

    syncToolUi();

    return {
      getTool: () => activeTool,
      getColor: () => activeColor,
      getLineWidth: () => lineWidth,
      getTextSize: () => textSize,
      setTool,
      setHistoryButtons(canUndo, canRedo) {
        const u = $(ids.undo);
        const r = $(ids.redo);
        if (u) u.disabled = !canUndo;
        if (r) r.disabled = !canRedo;
      },
      closeMenus,
      destroy() {
        document.removeEventListener("click", onDocClick);
        hostEl.innerHTML = "";
      },
    };
  }

  global.UiAnnotationToolbar = { create };
})(typeof window !== "undefined" ? window : global);
