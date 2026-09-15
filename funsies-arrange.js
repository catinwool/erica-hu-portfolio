(() => {
  const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!isLocalhost) return;

  const STORAGE_KEY = "portfolio-funsies-layout-v2";
  const DESKTOP = window.matchMedia("(min-width: 721px)");

  const fun = document.querySelector(".fun");
  const flow = document.querySelector(".fun-flow");
  const toggle = document.querySelector(".fun-arrange-toggle");
  if (!fun || !flow || !toggle) return;

  const cards = [...flow.querySelectorAll(".fun-card")];
  let arranging = false;
  let bar = null;
  let z = 3;

  const letter = (card) => {
    const match = [...card.classList].find((name) => /^fun-card--[a-z]$/.test(name));
    return match ? match.slice(-1) : "";
  };

  const readSaved = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "");
      if (saved && saved.v === 1 && saved.cards) return saved;
    } catch (_) {}
    return null;
  };

  const writeSaved = (layout) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  };

  const measure = () => {
    const flowRect = flow.getBoundingClientRect();
    const next = { v: 1, minHeight: 0, cards: {} };
    let maxBottom = 0;
    cards.forEach((card) => {
      const id = letter(card);
      if (!id) return;
      const rect = card.getBoundingClientRect();
      const left = rect.left - flowRect.left;
      const top = rect.top - flowRect.top;
      next.cards[id] = {
        left: `${((left / flow.clientWidth) * 100).toFixed(2)}%`,
        top: `${Math.round(top)}px`,
      };
      maxBottom = Math.max(maxBottom, top + rect.height);
    });
    const padBottom = parseFloat(getComputedStyle(flow).paddingBottom) || 0;
    next.minHeight = Math.round(maxBottom + padBottom);
    return next;
  };

  const apply = (layout) => {
    if (!layout) return;
    flow.classList.add("fun-flow--placed");
    flow.style.minHeight = `${layout.minHeight}px`;
    cards.forEach((card) => {
      const pos = layout.cards[letter(card)];
      if (!pos) return;
      card.style.left = pos.left;
      card.style.top = pos.top;
      card.style.marginLeft = "0";
    });
  };

  const toCSS = (layout) => {
    const rules = [
      `@media (min-width: 721px) {`,
      `  .fun-flow {`,
      `    position: relative;`,
      `    min-height: ${layout.minHeight}px;`,
      `  }`,
      `  .fun-card {`,
      `    position: absolute;`,
      `    margin-left: 0;`,
      `  }`,
    ];
    Object.entries(layout.cards).forEach(([id, pos]) => {
      rules.push(`  .fun-card--${id} { left: ${pos.left}; top: ${pos.top}; }`);
    });
    rules.push(`}`);
    return rules.join("\n");
  };

  const promoteFromFlow = () => {
    const flowRect = flow.getBoundingClientRect();
    const snapshot = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        card,
        left: rect.left - flowRect.left,
        top: rect.top - flowRect.top,
        bottom: rect.top - flowRect.top + rect.height,
      };
    });
    const padBottom = parseFloat(getComputedStyle(flow).paddingBottom) || 0;
    const minHeight = Math.round(
      Math.max(...snapshot.map((item) => item.bottom)) + padBottom
    );
    flow.classList.add("fun-flow--placed");
    flow.style.minHeight = `${minHeight}px`;
    snapshot.forEach(({ card, left, top }) => {
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.marginLeft = "0";
    });
  };

  const expandCanvas = (card) => {
    const flowRect = flow.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const bottom = rect.bottom - flowRect.top + parseFloat(getComputedStyle(flow).paddingBottom);
    const needed = Math.round(bottom);
    if (needed > (parseFloat(flow.style.minHeight) || 0)) {
      flow.style.minHeight = `${needed}px`;
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  };

  const ensureBar = () => {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.className = "fun-arrange-bar";
    bar.innerHTML = `
      <p>Drag each funsies card. Positions save in this browser.</p>
      <button type="button" data-copy-css>Copy CSS</button>
      <button type="button" data-copy-json>Copy JSON</button>
      <button type="button" data-reset>Reset</button>
    `;
    document.body.appendChild(bar);
    const cssBtn = bar.querySelector("[data-copy-css]");
    const jsonBtn = bar.querySelector("[data-copy-json]");
    bar.querySelector("[data-copy-css]").addEventListener("click", async () => {
      const layout = measure();
      writeSaved(layout);
      const ok = await copyText(toCSS(layout));
      cssBtn.textContent = ok ? "Copied CSS" : "Copy failed";
      setTimeout(() => (cssBtn.textContent = "Copy CSS"), 1600);
    });
    bar.querySelector("[data-copy-json]").addEventListener("click", async () => {
      const layout = measure();
      writeSaved(layout);
      const ok = await copyText(JSON.stringify(layout, null, 2));
      jsonBtn.textContent = ok ? "Copied JSON" : "Copy failed";
      setTimeout(() => (jsonBtn.textContent = "Copy JSON"), 1600);
    });
    bar.querySelector("[data-reset]").addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      flow.classList.remove("fun-flow--placed");
      flow.style.minHeight = "";
      cards.forEach((card) => {
        card.style.left = "";
        card.style.top = "";
        card.style.marginLeft = "";
        card.style.zIndex = "";
      });
    });
    return bar;
  };

  const bindDrag = (card) => {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;
    let dragging = false;

    card.setAttribute("draggable", "false");
    card.querySelectorAll("img, a").forEach((node) => {
      node.setAttribute("draggable", "false");
    });
    card.addEventListener("dragstart", (event) => event.preventDefault());

    const onMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.hypot(dx, dy) > 4) moved = true;
      card.style.left = `${originLeft + dx}px`;
      card.style.top = `${Math.max(0, originTop + dy)}px`;
      expandCanvas(card);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("is-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) writeSaved(measure());
    };

    card.addEventListener("mousedown", (event) => {
      if (!arranging || event.button !== 0 || dragging) return;
      event.preventDefault();
      const flowRect = flow.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left - flowRect.left;
      originTop = rect.top - flowRect.top;
      moved = false;
      dragging = true;
      z += 1;
      card.style.zIndex = String(z);
      card.classList.add("is-dragging");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    card.addEventListener(
      "click",
      (event) => {
        if (arranging && moved) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );
  };

  const setArranging = (on) => {
    if (!DESKTOP.matches) on = false;
    if (on && !flow.classList.contains("fun-flow--placed")) {
      promoteFromFlow();
    }
    arranging = on;
    document.body.classList.toggle("is-arranging-funsies", on);
    flow.classList.toggle("fun-flow--arrange", on);
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
    toggle.textContent = on ? "Done" : "Arrange";
    if (on) {
      ensureBar().hidden = false;
    } else if (bar) {
      bar.hidden = true;
      if (flow.classList.contains("fun-flow--placed")) writeSaved(measure());
    }
  };

  cards.forEach(bindDrag);
  toggle.hidden = !DESKTOP.matches;
  toggle.addEventListener("click", () => setArranging(!arranging));

  const boot = () => {
    if (!DESKTOP.matches) return;
    if (new URLSearchParams(location.search).has("arrange")) setArranging(true);
  };

  DESKTOP.addEventListener("change", () => {
    toggle.hidden = !DESKTOP.matches;
    if (!DESKTOP.matches) {
      setArranging(false);
      flow.classList.remove("fun-flow--placed");
      flow.style.minHeight = "";
      cards.forEach((card) => {
        card.style.left = "";
        card.style.top = "";
        card.style.marginLeft = "";
        card.style.zIndex = "";
      });
    } else {
      boot();
    }
  });

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot);
})();
