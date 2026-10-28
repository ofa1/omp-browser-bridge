// Injected on demand into the tab's content-script (isolated) world. Idempotent per document.
(() => {
  if (typeof window.__omp?.snapshot === "function") return;

  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "canvas", "video", "audio", "object", "embed"]);
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
    "section", "table", "tbody", "thead", "tfoot", "tr", "ul", "caption", "legend", "menu",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "combobox", "listbox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "file",
  ]);
  const VALUE_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider", "combobox"]);

  // Refs stay stable for the life of the document; strong refs keep Xray wrapper identity stable.
  const idOf = new WeakMap();
  const byId = new Map();
  let nextId = 1;

  function refOf(el) {
    let id = idOf.get(el);
    if (!id) {
      id = nextId++;
      idOf.set(el, id);
      byId.set(id, el);
    }
    return id;
  }

  function escapeRefMarkers(s) {
    return (s || "").replace(/\[(\d+)\]/g, "\\[$1]");
  }

  function clean(s, max = 80) {
    s = (s || "").replace(/\s+/g, " ").trim();
    s = escapeRefMarkers(s);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  function shortUrl(href) {
    try {
      const u = new URL(href, location.href);
      const s = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
      return clean(s, 100);
    } catch {
      return clean(href, 100);
    }
  }

  function style(el) {
    const win = el.ownerDocument.defaultView || window;
    return win.getComputedStyle(el);
  }

  function visible(el) {
    if (el.checkVisibility) {
      if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
      return style(el).display === "contents";
    }
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    switch (el.localName) {
      case "a":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
      case "summary":
        return "button";
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "textarea":
        return "textbox";
      case "input": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return null;
        const map = {
          checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
          button: "button", submit: "button", reset: "button", image: "button", file: "file",
        };
        return map[t] || "textbox";
      }
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return "textbox";
    return null;
  }

  const CONTAINER_TAGS = new Set(["div", "section", "article", "main", "aside", "header", "footer", "nav", "form", "fieldset"]);

  function isInteractive(el) {
    const role = roleOf(el);
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0 && el.localName !== "body") {
      if (CONTAINER_TAGS.has(el.localName)) {
        return !el.querySelector("a[href], button, input, select, textarea, iframe, frame, [role='button'], [role='link']");
      }
      return true;
    }
    return el.hasAttribute("onclick");
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return clean(t);
    }
    if (el.labels?.length) {
      const t = [...el.labels].map((l) => l.innerText).join(" ");
      if (t.trim()) return clean(t);
    }
    if (el.localName === "input") {
      if (["submit", "button", "reset"].includes(el.type)) return clean(el.value);
      if (el.type === "image") return clean(el.alt);
    }
    if (el.localName !== "select" && !el.isContentEditable) {
      const t = el.innerText;
      if (t?.trim()) return clean(t);
    }
    const img = el.querySelector?.("img[alt]");
    if (img?.alt.trim()) return clean(img.alt);
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
  }

  function describe(el) {
    const role = roleOf(el) || "clickable";
    const parts = [`[${refOf(el)}] ${role}`];
    const name = nameOf(el);
    if (name) parts.push(JSON.stringify(name));
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`→ ${shortUrl(el.href || href)}`);
    }
    if (el.localName === "select") {
      const selected = [...el.selectedOptions].map((o) => clean(o.text, 40));
      parts.push(`= ${JSON.stringify(selected.join(", "))}`);
      const opts = [...el.options].slice(0, 15).map((o) => clean(o.text, 30));
      parts.push(`options: ${opts.join(" | ")}${el.options.length > 15 ? ` | …(${el.options.length})` : ""}`);
    } else if (VALUE_ROLES.has(role)) {
      if (el.isContentEditable) {
        const v = clean(el.innerText, 200);
        if (v) parts.push(`= ${JSON.stringify(v)}`);
      } else if ("value" in el) {
        const v = el.type === "password" ? "•".repeat(Math.min(el.value.length, 8)) : clean(String(el.value), 200);
        if (v) parts.push(`= ${JSON.stringify(v)}`);
        else if (el.placeholder && el.placeholder !== name) parts.push(`placeholder=${JSON.stringify(clean(el.placeholder, 60))}`);
      }
      if (el.type && el.type !== "text" && role === "textbox" && el.localName === "input") parts.push(`type=${el.type}`);
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const checked = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
      parts.push(checked ? "checked" : "unchecked");
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) parts.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    if (el.getAttribute("aria-pressed") === "true") parts.push("pressed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.join(" ");
  }

  function snapshot({ mode = "page", scope = "page", selector, frameSelector, maxChars = 10000, offset = 0 } = {}) {
    let root = document.body;
    if (frameSelector) {
      const frame = document.querySelector(frameSelector);
      if (!frame) throw new Error(`No frame matches frameSelector ${frameSelector}`);
      try {
        root = frame.contentDocument?.body || root;
      } catch {
        throw new Error(`Cannot access frame document for ${frameSelector} (cross-origin or sandboxed)`);
      }
    }
    if (selector) {
      root = root.querySelector(selector);
      if (!root) throw new Error(`No element matches selector ${selector}`);
    }
    for (const [id, el] of byId) if (!el.isConnected) byId.delete(id);

    const onlyRefs = mode === "interactive";
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const lines = [];
    let cur = "";
    let refs = 0;
    const flush = () => {
      const t = cur.replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
      cur = "";
    };
    const outOfView = (el) => {
      if (scope !== "viewport" || el.ownerDocument !== document) return false;
      const rects = el.getClientRects();
      if (!rects.length) return false;
      const r = el.getBoundingClientRect();
      return r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw;
    };

    const walkChildren = (node) => {
      const shadow = node.openOrClosedShadowRoot || node.shadowRoot;
      let kids = shadow ? shadow.childNodes : node.childNodes;
      if (!shadow && node.localName === "slot") {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) kids = assigned;
      }
      for (const kid of kids) walk(kid);
    };

    const walk = (node) => {
      if (node.nodeType === 3) {
        if (!onlyRefs) cur += escapeRefMarkers(node.data);
        return;
      }
      if (node.nodeType === 11) return walkChildren(node);
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.localName;
      if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true") return;
      if (!visible(el) || outOfView(el)) return;

      if (tag === "iframe" || tag === "frame") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {}
        flush();
        if (doc?.body) {
          const frameLabel = el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : shortUrl(el.src || ""));
          if (!onlyRefs) lines.push(`--- [frame ${frameLabel}] ---`);
          walk(doc.body);
          if (!onlyRefs) lines.push(`--- [end frame ${frameLabel}] ---`);
        } else {
          lines.push(`[iframe ${shortUrl(el.src)}]`);
        }
        flush();
        return;
      }
      if (isInteractive(el)) {
        refs++;
        if (onlyRefs) lines.push(describe(el));
        else cur += ` ${describe(el)} `;
        return;
      }
      if (tag === "img") {
        if (!onlyRefs && el.alt?.trim()) cur += ` [img ${JSON.stringify(clean(el.alt, 60))}] `;
        return;
      }
      if (tag === "br") return flush();

      const block = BLOCK.has(tag);
      if (block) flush();
      if (!onlyRefs) {
        if (/^h[1-6]$/.test(tag)) cur += `${"#".repeat(Number(tag[1]))} `;
        else if (tag === "li") cur += "- ";
        else if (tag === "td" || tag === "th") cur += " | ";
      }
      // A label's text is already the name of its control; skip it to avoid printing it twice.
      if (tag === "label" && el.control && !onlyRefs) {
        for (const kid of el.childNodes) if (kid.nodeType === 1) walk(kid);
      } else walkChildren(el);
      if (block) flush();
    };

    walk(root);
    flush();
    const full = lines.join("\n");
    const text = full.slice(offset, offset + maxChars);
    return {
      title: (document.title || "").replace(/[\r\n]+/g, " ").trim(),
      url: location.href,
      text,
      offset,
      total: full.length,
      nextOffset: offset + maxChars < full.length ? offset + maxChars : null,
      refs,
      scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight, viewport: vh },
    };
  }

  function resolve({ ref, selector, frameSelector } = {}) {
    if (ref !== undefined && ref !== null) {
      const el = byId.get(Number(ref));
      if (!el || !el.isConnected) throw new Error(`Ref [${ref}] is stale or unknown; take a new snapshot`);
      return el;
    }
    if (selector) {
      let root = document;
      if (frameSelector) {
        const frame = document.querySelector(frameSelector);
        if (!frame) throw new Error(`No frame matches frameSelector ${frameSelector}`);
        try {
          root = frame.contentDocument || root;
        } catch {
          throw new Error(`Cannot access frame document for ${frameSelector} (cross-origin or sandboxed)`);
        }
      }
      let el = root.querySelector(selector);
      if (!el && !frameSelector) {
        for (const frame of document.querySelectorAll("iframe, frame")) {
          try {
            const doc = frame.contentDocument;
            if (doc) {
              el = doc.querySelector(selector);
              if (el) break;
            }
          } catch {}
        }
      }
      if (!el) throw new Error(`No element matches selector ${selector}`);
      return el;
    }
    return null;
  }

  function mouse(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView || window;
    const init = {
      bubbles: !type.endsWith("enter"),
      cancelable: true,
      composed: true,
      view: win,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      ...extra,
    };
    const Ctor = type.startsWith("pointer") ? (win.PointerEvent || PointerEvent) : (win.MouseEvent || MouseEvent);
    if (Ctor === win.PointerEvent || Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true });
    return el.dispatchEvent(new Ctor(type, init));
  }

  function hover(el) {
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t);
  }

  function click(el, count = 1) {
    hover(el);
    for (let i = 1; i <= count; i++) {
      mouse(el, "pointerdown", { buttons: 1, detail: i });
      mouse(el, "mousedown", { buttons: 1, detail: i });
      if (i === 1) el.focus?.({ preventScroll: true });
      mouse(el, "pointerup", { detail: i });
      mouse(el, "mouseup", { detail: i });
      el.click();
    }
    if (count === 2) mouse(el, "dblclick", { detail: 2 });
  }

  function input(el, inputType, data) {
    const win = el.ownerDocument.defaultView || window;
    const Ctor = win.InputEvent || InputEvent;
    el.dispatchEvent(new Ctor("input", { bubbles: true, composed: true, inputType, data }));
  }

  function fill(el, value) {
    el.focus();
    if (el.isContentEditable) {
      const doc = el.ownerDocument;
      const win = doc.defaultView || window;
      const sel = win.getSelection?.();
      if (sel) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      doc.execCommand("selectAll");
      let ok = false;
      try {
        ok = doc.execCommand("insertText", false, value);
      } catch {}
      if (!ok) {
        el.textContent = value;
      }
      const InputEventCtor = win.InputEvent || InputEvent;
      el.dispatchEvent(new InputEventCtor("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: value }));
      input(el, "insertText", value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (!("value" in el) || el.localName === "select") throw new Error("Element is not a text field; use click/select");
    // Xray assignment hits the native setter, so framework value trackers (React) see a change.
    el.value = value;
    input(el, "insertReplacementText", value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function keyInit(key, mods) {
    let code = key;
    if (key.length === 1) code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : "";
    return {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt") || mods.has("option"),
      metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
    };
  }

  function insertChar(el, ch) {
    if (el.isContentEditable) {
      el.ownerDocument.execCommand("insertText", false, ch);
    } else if ("value" in el) {
      el.value += ch;
      input(el, "insertText", ch);
    }
  }

  function typeText(el, text) {
    el.focus();
    for (const ch of text) {
      const init = keyInit(ch, new Set());
      if (el.dispatchEvent(new KeyboardEvent("keydown", init))) {
        el.dispatchEvent(new KeyboardEvent("keypress", init));
        insertChar(el, ch);
      }
      el.dispatchEvent(new KeyboardEvent("keyup", init));
    }
    if (!el.isContentEditable) el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function focusables() {
    return [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex],[contenteditable='true']")].filter(
      (e) => !e.disabled && e.tabIndex >= 0 && visible(e),
    );
  }

  function press(el, combo) {
    if (!combo) throw new Error("press needs value, e.g. \"Enter\" or \"Control+a\"");
    const parts = String(combo).split("+");
    const key = parts.pop() || "+";
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const init = keyInit(key, mods);
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (proceed && key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    if (proceed) {
      if (key === "Enter") {
        if (el.localName === "input" && el.form) el.form.requestSubmit();
        else if (["a", "button", "summary"].includes(el.localName) || roleOf(el) === "button") el.click();
      } else if (key === "Tab") {
        const list = focusables();
        const i = list.indexOf(el);
        list[(i + (init.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      } else if (key === "Backspace" && "value" in el && !el.isContentEditable) {
        el.value = String(el.value).slice(0, -1);
        input(el, "deleteContentBackward", null);
      } else if (key.length === 1 && !init.ctrlKey && !init.metaKey) {
        insertChar(el, key);
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function select(el, value) {
    if (el.localName !== "select") throw new Error("select works on <select>; for custom dropdowns click the option");
    const wanted = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim().toLowerCase());
    let matched = 0;
    for (const o of el.options) {
      const hit = wanted.includes(o.value.toLowerCase()) || wanted.includes(o.text.trim().toLowerCase());
      if (hit) matched++;
      if (el.multiple || hit) o.selected = hit;
    }
    if (!matched) throw new Error(`No option matches ${JSON.stringify(value)}`);
    input(el, "insertReplacementText", null);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function scroll(el, value) {
    const target = el || document.scrollingElement || document.documentElement;
    const page = el ? el.clientHeight : window.innerHeight;
    const v = value ?? "down";
    if (v === "top") target.scrollTo({ top: 0, behavior: "instant" });
    else if (v === "bottom") target.scrollTo({ top: target.scrollHeight, behavior: "instant" });
    else {
      const dy = v === "down" ? page * 0.85 : v === "up" ? -page * 0.85 : Number(v);
      if (!Number.isFinite(dy)) throw new Error(`scroll value must be up/down/top/bottom or pixels, got ${v}`);
      target.scrollBy({ top: dy, behavior: "instant" });
    }
    return `scrollY=${Math.round(el ? el.scrollTop : window.scrollY)} of ${target.scrollHeight}`;
  }

  function upload(el, files) {
    const input =
      el.localName === "input" && el.type === "file" ? el : el.control?.type === "file" ? el.control : el.querySelector('input[type="file"]');
    if (!input) throw new Error("Element is not a file input, a label for one, or a container with one; try selector 'input[type=file]'");
    if (input.disabled) throw new Error("File input is disabled");
    if (!Array.isArray(files) || !files.length) throw new Error("upload needs files");
    if (files.length > 1 && !input.multiple) throw new Error(`File input takes one file; got ${files.length}`);
    // Built in content-script scope: a page-compartment FileList is silently dropped by the Xray `files` setter.
    const dt = new DataTransfer();
    let bytes = 0;
    for (const f of files) {
      const data = Uint8Array.fromBase64(f.data);
      bytes += data.length;
      dt.items.add(new File([data], f.name, { type: f.type }));
    }
    input.files = dt.files;
    if (input.files.length !== files.length) throw new Error("The page did not accept the files");
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    return `→ ${files.map((f) => f.name).join(", ")} (${size})`;
  }

  function act(step) {
    const { action } = step;
    const el = resolve(step);
    if (!el && !["press", "scroll"].includes(action)) throw new Error(`${action} needs ref or selector`);
    if (el && action !== "scroll") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const desc = el ? describe(el) : "";
    let note = "";
    switch (action) {
      case "click":
        click(el, 1);
        break;
      case "dblclick":
        click(el, 2);
        break;
      case "hover":
        hover(el);
        break;
      case "focus":
        el.focus();
        break;
      case "fill":
        fill(el, String(step.value ?? ""));
        break;
      case "type":
        typeText(el, String(step.value ?? ""));
        break;
      case "press":
        press(el || document.activeElement || document.body, step.value);
        break;
      case "select":
        select(el, step.value);
        break;
      case "check":
      case "uncheck": {
        const checked = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
        if (checked !== (action === "check")) click(el, 1);
        break;
      }
      case "submit": {
        const form = el.form || el.closest("form");
        if (!form) throw new Error("Element is not inside a form");
        form.requestSubmit();
        break;
      }
      case "scroll":
        note = scroll(el, step.value);
        break;
      case "upload":
        note = upload(el, step.files);
        break;
      default:
        throw new Error(`Unknown action ${action}`);
    }
    return [desc, note].filter(Boolean).join(" ");
  }

  function check({ selector, text, gone, frameSelector } = {}) {
    let found = true;
    let root = document;
    if (frameSelector) {
      const frame = document.querySelector(frameSelector);
      if (frame) {
        try { root = frame.contentDocument || root; } catch {}
      }
    }
    if (selector) {
      let el = root.querySelector(selector);
      if (!el && !frameSelector) {
        for (const frame of document.querySelectorAll("iframe, frame")) {
          try {
            const doc = frame.contentDocument;
            if (doc) {
              el = doc.querySelector(selector);
              if (el) break;
            }
          } catch {}
        }
      }
      found = !!el && visible(el);
    }
    if (found && text) {
      const bodyText = root.body?.innerText || "";
      found = bodyText.includes(text);
      if (!found && !frameSelector) {
        for (const frame of document.querySelectorAll("iframe, frame")) {
          try {
            const doc = frame.contentDocument;
            if (doc?.body?.innerText?.includes(text)) {
              found = true;
              break;
            }
          } catch {}
        }
      }
    }
    return gone ? !found : found;
  }

  function rectOf(target) {
    const el = resolve(target);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  function pageRect() {
    const d = document.documentElement;
    return { x: 0, y: 0, width: Math.max(d.scrollWidth, window.innerWidth), height: Math.min(Math.max(d.scrollHeight, window.innerHeight), 16384) };
  }

  // JSON-safe conversion for eval results: DOM nodes, cycles, functions, bigint.
  function toJSONSafe(value) {
    const seen = new WeakSet();
    const text = JSON.stringify(value === undefined ? null : value, (_k, v) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
      if (v && typeof v === "object") {
        if (typeof v.nodeType === "number" && typeof v.nodeName === "string") {
          return v.nodeType === 1 ? (isInteractive(v) ? describe(v) : clean(v.outerHTML, 300)) : clean(v.textContent, 300);
        }
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    return text === undefined ? null : JSON.parse(text);
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id) return;
    if (!msg || typeof msg.op !== "string") return;
    return (async () => {
      try {
        let result;
        switch (msg.op) {
          case "snapshot":
            result = snapshot(msg.args);
            break;
          case "act":
            result = act(msg.args);
            break;
          case "check":
            result = check(msg.args);
            break;
          case "rectOf":
            result = rectOf(msg.args);
            break;
          case "pageRect":
            result = pageRect();
            break;
          default:
            throw new Error(`Unknown content op: ${msg.op}`);
        }
        return { ok: true, v: toJSONSafe(result) };
      } catch (e) {
        return { ok: false, e: String((e && e.message) || e) };
      }
    })();
  });

  window.__omp = { snapshot, resolve, act, check, rectOf, pageRect, toJSONSafe, describe };
})();
true;
