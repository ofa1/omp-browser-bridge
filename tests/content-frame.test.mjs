import test from "node:test";
import assert from "node:assert/strict";

test("content: container with tabindex and interactive children is not treated as a leaf interactive element", () => {
  const CONTAINER_TAGS = new Set(["div", "section", "article", "main", "aside", "header", "footer", "nav", "form", "fieldset"]);

  function isInteractive(el) {
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0 && el.localName !== "body") {
      if (CONTAINER_TAGS.has(el.localName)) {
        return !el.querySelector("a[href], button, input, select, textarea, iframe, frame, [role='button'], [role='link']");
      }
      return true;
    }
    return false;
  }

  // Simulating OCI loom container with tabindex="0" containing an iframe
  const ociContainer = {
    localName: "div",
    getAttribute: (name) => (name === "tabindex" ? "0" : null),
    querySelector: (sel) => (sel.includes("iframe") ? { localName: "iframe" } : null),
  };

  assert.equal(isInteractive(ociContainer), false, "Container with iframe should not be marked as leaf interactive");

  // Simulating custom focusable clickable card with no interactive children
  const clickableCard = {
    localName: "div",
    getAttribute: (name) => (name === "tabindex" ? "0" : null),
    querySelector: () => null,
  };

  assert.equal(isInteractive(clickableCard), true, "Div with tabindex and no interactive children should be interactive");
});

test("content: frame resolution inside target iframe", () => {
  const innerBtn = { localName: "button", id: "change-img" };
  const mockIframeDoc = {
    querySelector: (sel) => (sel === "#change-img" ? innerBtn : null),
  };
  const mockFrame = {
    contentDocument: mockIframeDoc,
  };
  const mockDocument = {
    querySelector: (sel) => (sel === "#sandbox-maui-preact-container" ? mockFrame : null),
    querySelectorAll: () => [mockFrame],
  };

  function resolve({ selector, frameSelector } = {}) {
    let root = mockDocument;
    if (frameSelector) {
      const frame = mockDocument.querySelector(frameSelector);
      if (!frame) throw new Error(`No frame matches frameSelector ${frameSelector}`);
      root = frame.contentDocument || root;
    }
    let el = root.querySelector(selector);
    if (!el && !frameSelector) {
      for (const frame of mockDocument.querySelectorAll("iframe, frame")) {
        const doc = frame.contentDocument;
        if (doc) {
          el = doc.querySelector(selector);
          if (el) break;
        }
      }
    }
    if (!el) throw new Error(`No element matches selector ${selector}`);
    return el;
  }

  // Resolving with explicit frameSelector
  const resolvedWithFrame = resolve({ selector: "#change-img", frameSelector: "#sandbox-maui-preact-container" });
  assert.equal(resolvedWithFrame, innerBtn);

  // Auto-resolving without frameSelector (deep search)
  const resolvedAuto = resolve({ selector: "#change-img" });
  assert.equal(resolvedAuto, innerBtn);

  // Fails with non-matching selector
  assert.throws(() => resolve({ selector: "#missing" }), /No element matches selector #missing/);
});
test("content: querySelectorDeep resolves elements in open and closed shadow roots", () => {
  function querySelectorDeep(root, selector) {
    if (!root) return null;
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch {}

    function search(node) {
      const shadow = node.openOrClosedShadowRoot || node.shadowRoot;
      if (shadow) {
        try {
          const match = shadow.querySelector(selector);
          if (match) return match;
        } catch {}
        for (const child of shadow.children) {
          const res = search(child);
          if (res) return res;
        }
      }
      for (const child of node.children) {
        const res = search(child);
        if (res) return res;
      }
      return null;
    }

    if (root.nodeType === 9 || root.nodeType === 11) {
      for (const child of root.children) {
        const res = search(child);
        if (res) return res;
      }
      return null;
    }
    return search(root);
  }

  const innerBtn = { localName: "button", id: "shadow-btn", children: [] };
  const shadowDom = {
    children: [innerBtn],
    querySelector: (sel) => (sel === "#shadow-btn" ? innerBtn : null),
  };
  const webComponent = {
    localName: "custom-card",
    children: [],
    // Simulating Firefox chrome/content-script openOrClosedShadowRoot or standard shadowRoot
    openOrClosedShadowRoot: shadowDom,
    querySelector: () => null,
  };
  const mockDoc = {
    nodeType: 9,
    children: [webComponent],
    querySelector: () => null,
  };

  const found = querySelectorDeep(mockDoc, "#shadow-btn");
  assert.equal(found, innerBtn, "Should locate element inside openOrClosedShadowRoot");

  // Also test standard shadowRoot fallback
  const innerInput = { localName: "input", id: "std-input", children: [] };
  const stdShadow = {
    children: [innerInput],
    querySelector: (sel) => (sel === "#std-input" ? innerInput : null),
  };
  const stdComponent = {
    localName: "std-card",
    children: [],
    shadowRoot: stdShadow,
    querySelector: () => null,
  };
  const doc2 = {
    nodeType: 9,
    children: [stdComponent],
    querySelector: () => null,
  };
  const foundStd = querySelectorDeep(doc2, "#std-input");
  assert.equal(foundStd, innerInput, "Should locate element inside standard shadowRoot");
});

test("content: textContentDeep extracts text across shadow boundaries", () => {
  function textContentDeep(root) {
    if (!root) return "";
    let text = root.innerText || root.textContent || "";
    function walkShadows(node) {
      const shadow = node.openOrClosedShadowRoot || node.shadowRoot;
      if (shadow) {
        text += " " + (shadow.innerText || shadow.textContent || "");
        for (const child of shadow.children) walkShadows(child);
      }
      for (const child of node.children) walkShadows(child);
    }
    if (root.nodeType === 9 || root.nodeType === 11) {
      for (const child of root.children) walkShadows(child);
    } else if (root.nodeType === 1) {
      walkShadows(root);
    }
    return text.trim();
  }

  const shadowChild = {
    localName: "span",
    innerText: "Inside Shadow DOM",
    children: [],
  };
  const shadowRoot = {
    innerText: "Inside Shadow DOM",
    children: [shadowChild],
  };
  const host = {
    nodeType: 1,
    localName: "custom-elem",
    innerText: "Outer Text",
    children: [],
    openOrClosedShadowRoot: shadowRoot,
  };

  const text = textContentDeep(host);
  assert.match(text, /Outer Text/, "Includes outer host text");
  assert.match(text, /Inside Shadow DOM/, "Includes shadow DOM text");
});

test("content: rectOf accumulates enclosing iframe bounding rects and border/padding", () => {
  // Simulate top-level window and iframe hierarchy
  const topWindow = {
    scrollX: 10,
    scrollY: 25,
  };

  const iframeEl = {
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 600, height: 400 }),
  };

  const iframeWindow = {
    frameElement: iframeEl,
    parent: topWindow,
  };

  const iframeDoc = {
    defaultView: iframeWindow,
  };

  const targetEl = {
    ownerDocument: iframeDoc,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 50, top: 75, width: 120, height: 40 }),
  };

  function getComputedStyle(el) {
    if (el === iframeEl) {
      return {
        borderLeftWidth: "4px",
        borderTopWidth: "6px",
        paddingLeft: "8px",
        paddingTop: "10px",
      };
    }
    return {};
  }

  function computeRectOf(el, topWin, styleResolver) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== topWin && win.frameElement) {
      const frameEl = win.frameElement;
      const fr = frameEl.getBoundingClientRect();
      const cs = (win.parent || topWin) ? styleResolver(frameEl) : {};
      x += fr.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      y += fr.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      win = win.parent;
    }
    return {
      x: x + topWin.scrollX,
      y: y + topWin.scrollY,
      width: Math.max(1, r.width),
      height: Math.max(1, r.height),
    };
  }

  const rect = computeRectOf(targetEl, topWindow, getComputedStyle);

  // Expected x: 50 (el.left) + 100 (frame.left) + 4 (border) + 8 (padding) + 10 (topWin.scrollX) = 172
  // Expected y: 75 (el.top) + 200 (frame.top) + 6 (border) + 10 (padding) + 25 (topWin.scrollY) = 316
  assert.equal(rect.x, 172);
  assert.equal(rect.y, 316);
  assert.equal(rect.width, 120);
  assert.equal(rect.height, 40);
});

test("content: key combo parsing and normalization", () => {
  function parseCombo(combo) {
    if (!combo) throw new Error("press needs value");
    const raw = String(combo);
    const parts = [];
    let start = 0;
    while (start < raw.length) {
      const plusIdx = raw.indexOf("+", start);
      if (plusIdx === -1) {
        parts.push(raw.slice(start));
        break;
      }
      if (plusIdx === raw.length - 1 && parts.length > 0) {
        parts.push("+");
        break;
      }
      parts.push(raw.slice(start, plusIdx));
      start = plusIdx + 1;
    }
    let key = parts.pop() || "+";
    if (key === "") key = "+";
    const mods = new Set(parts.map((p) => p.toLowerCase()));

    let code = key;
    if (key === " " || key.toLowerCase() === "space" || key.toLowerCase() === "spacebar") {
      key = " ";
      code = "Space";
    } else if (key.toLowerCase() === "esc") {
      key = "Escape";
      code = "Escape";
    } else if (key.toLowerCase() === "del") {
      key = "Delete";
      code = "Delete";
    } else if (key.toLowerCase() === "up") {
      key = "ArrowUp";
      code = "ArrowUp";
    } else if (key.toLowerCase() === "down") {
      key = "ArrowDown";
      code = "ArrowDown";
    } else if (key.toLowerCase() === "left") {
      key = "ArrowLeft";
      code = "ArrowLeft";
    } else if (key.toLowerCase() === "right") {
      key = "ArrowRight";
      code = "ArrowRight";
    } else if (key.length === 1) {
      code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key === "+" ? "Equal" : "";
    }

    return {
      key,
      code,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt") || mods.has("option"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    };
  }

  // Space
  const spaceParsed = parseCombo("Space");
  assert.equal(spaceParsed.key, " ");
  assert.equal(spaceParsed.code, "Space");
  assert.equal(spaceParsed.ctrlKey, false);

  // Esc -> Escape
  const escParsed = parseCombo("Esc");
  assert.equal(escParsed.key, "Escape");
  assert.equal(escParsed.code, "Escape");

  // Single "+"
  const singlePlus = parseCombo("+");
  assert.equal(singlePlus.key, "+");
  assert.equal(singlePlus.ctrlKey, false);

  // "Control++"
  const ctrlPlus = parseCombo("Control++");
  assert.equal(ctrlPlus.key, "+");
  assert.equal(ctrlPlus.ctrlKey, true);

  // Arrow keys
  const arrowUp = parseCombo("Up");
  assert.equal(arrowUp.key, "ArrowUp");
  assert.equal(arrowUp.code, "ArrowUp");
});

test("content: <details>/<summary> expanded/collapsed state and inert element skipping", () => {
  function describe(el) {
    const parts = [`summary "${el.textContent.trim()}"`];
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) {
      parts.push(expanded === "true" ? "expanded" : "collapsed");
    } else if (el.localName === "summary" && el.parentElement?.localName === "details") {
      parts.push(el.parentElement.open ? "expanded" : "collapsed");
    }
    return parts.join(" ");
  }

  // Open <details>
  const openDetails = { localName: "details", open: true };
  const summaryOpen = {
    localName: "summary",
    parentElement: openDetails,
    textContent: "More Info",
    getAttribute: () => null,
  };
  assert.equal(describe(summaryOpen), 'summary "More Info" expanded');

  // Closed <details>
  const closedDetails = { localName: "details", open: false };
  const summaryClosed = {
    localName: "summary",
    parentElement: closedDetails,
    textContent: "More Info",
    getAttribute: () => null,
  };
  assert.equal(describe(summaryClosed), 'summary "More Info" collapsed');

  // Explicit aria-expanded takes precedence
  const customSummary = {
    localName: "summary",
    parentElement: closedDetails,
    textContent: "More Info",
    getAttribute: (attr) => (attr === "aria-expanded" ? "true" : null),
  };
  assert.equal(describe(customSummary), 'summary "More Info" expanded');

  // Skipping inert elements during walk
  const walked = [];
  function walk(el) {
    if (el.inert || el.hasAttribute("inert")) return;
    walked.push(el.id);
    for (const child of el.children || []) walk(child);
  }

  const tree = {
    id: "root",
    inert: false,
    hasAttribute: () => false,
    children: [
      { id: "active", inert: false, hasAttribute: () => false, children: [] },
      { id: "hidden-panel", inert: true, hasAttribute: (a) => a === "inert", children: [{ id: "sub-inert", inert: false, hasAttribute: () => false }] },
    ],
  };

  walk(tree);
  assert.deepEqual(walked, ["root", "active"]);
});
