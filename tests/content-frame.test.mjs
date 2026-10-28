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
