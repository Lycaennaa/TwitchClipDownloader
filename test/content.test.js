import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.children = [];
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
  }

  set id(value) {
    this._id = value;
    this.document.elements.set(value, this);
  }

  get id() {
    return this._id;
  }

  set innerHTML(value) {
    for (const match of value.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"([^>]*)>/gi)) {
      const child = new FakeElement(match[1], this.document);
      child.id = match[2];
      child.parentElement = this;
      child.hidden = /\shidden(?:\s|>|$)/i.test(match[3]);
      child.disabled = /\sdisabled(?:\s|>|$)/i.test(match[3]);
      this.children.push(child);
    }
  }

  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get isConnected() {
    let element = this;
    while (element) {
      if (element === this.document.documentElement) return true;
      element = element.parentElement;
    }
    return false;
  }

  querySelector(selector) {
    return selector.startsWith("#") ? this.document.getElementById(selector.slice(1)) : null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      button: 0,
      pointerId: 1,
      preventDefault() {},
      target: this,
      currentTarget: this,
      ...properties,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  click() {
    this.dispatch("click");
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  closest(selector) {
    return selector === "button" && this.tagName === "BUTTON" ? this : null;
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  getBoundingClientRect() {
    if (this.customRect) return this.customRect;
    if (this.id !== "tcd-panel") return { left: 0, top: 0, width: 0, height: 0 };
    const width = 320;
    const height = this.rectHeight || 400;
    const left = Number.parseFloat(this.style.left) || 1000 - width - 20;
    const top = Number.parseFloat(this.style.top) || 800 - height - 20;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

async function loadContentScript() {
  const elements = new Map();
  const mutationObservers = [];
  const resizeObservers = [];
  const document = {
    elements,
    readyState: "complete",
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector !== 'button[aria-label*="Search"]') return [];
      const matches = [];
      const visit = (element) => {
        if (element.tagName === "BUTTON" && element.getAttribute("aria-label")?.includes("Search")) matches.push(element);
        for (const child of element.children) visit(child);
      };
      visit(document.body);
      return matches;
    },
  };
  document.body = new FakeElement("body", document);
  document.documentElement = document.body;
  const hiddenSearchHost = new FakeElement("div", document);
  hiddenSearchHost.opacity = "0";
  const hiddenSearchButton = new FakeElement("button", document);
  hiddenSearchButton.setAttribute("aria-label", "Search hidden content");
  hiddenSearchButton.customRect = { left: 100, top: 9, width: 30, height: 32, right: 130, bottom: 41 };
  hiddenSearchHost.append(hiddenSearchButton);
  document.body.append(hiddenSearchHost);
  const offscreenSearchButton = new FakeElement("button", document);
  offscreenSearchButton.setAttribute("aria-label", "Search offscreen content");
  offscreenSearchButton.customRect = { left: -100, top: 9, width: 30, height: 32, right: -70, bottom: 41 };
  document.body.append(offscreenSearchButton);
  const searchHost = new FakeElement("div", document);
  const searchButton = new FakeElement("button", document);
  searchButton.setAttribute("aria-label", "Search for term");
  searchButton.customRect = { left: 760, top: 9, width: 30, height: 32, right: 790, bottom: 41 };
  searchHost.append(searchButton);
  document.body.append(searchHost);

  const windowListeners = new Map();
  const window = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    postMessage() {},
    getComputedStyle(element) {
      return { display: element.display || "block", opacity: element.opacity || "1", visibility: element.visibility || "visible" };
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout,
    clearTimeout,
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "GET_FILESYSTEM_STATUS") {
          callback({ ok: true, fileSystem: { configured: false, name: "" } });
        } else {
          callback({
            ok: true,
            queue: { total: 0, completed: 0, skipped: 0, active: 0, pending: 0, failed: 0, activeDownloads: [] },
          });
        }
      },
    },
  };
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe(target) {
      resizeObservers.push({ callback: this.callback, target });
    }

    disconnect() {}
  }
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {
      mutationObservers.push(this);
    }
  }

  const source = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { chrome, console, document, Map, MutationObserver, Promise, ResizeObserver, window });
  return {
    document,
    searchButton,
    searchHost,
    triggerMutation() {
      for (const observer of mutationObservers) observer.callback();
    },
    triggerResize(target) {
      for (const observer of resizeObservers.filter((item) => item.target === target)) observer.callback();
    },
  };
}

test("dashboard panel closes, reopens, and stays inside viewport when moved", async () => {
  const { document, searchButton, searchHost, triggerMutation, triggerResize } = await loadContentScript();
  const panel = document.getElementById("tcd-panel");
  const toolbarButton = document.getElementById("tcd-toolbar-button");
  const closeButton = document.getElementById("tcd-close");
  const handle = document.getElementById("tcd-panel-header");
  assert.equal(toolbarButton.parentElement, searchHost);
  assert.equal(searchHost.classList.contains("tcd-toolbar-anchor"), true);

  searchButton.opacity = "0";
  const replacementSearchHost = new FakeElement("div", document);
  const replacementSearchButton = new FakeElement("button", document);
  replacementSearchButton.setAttribute("aria-label", "Search for term");
  replacementSearchButton.customRect = { left: 600, top: 9, width: 30, height: 32, right: 630, bottom: 41 };
  replacementSearchHost.append(replacementSearchButton);
  document.body.append(replacementSearchHost);
  triggerMutation();
  assert.equal(toolbarButton.parentElement, replacementSearchHost);
  assert.equal(searchHost.classList.contains("tcd-toolbar-anchor"), false);
  assert.equal(replacementSearchHost.classList.contains("tcd-toolbar-anchor"), true);

  closeButton.click();
  assert.equal(panel.hidden, true);
  assert.equal(toolbarButton.getAttribute("aria-expanded"), "false");

  toolbarButton.click();
  assert.equal(panel.hidden, false);
  assert.equal(toolbarButton.getAttribute("aria-expanded"), "true");

  handle.dispatch("pointerdown", { clientX: 700, clientY: 500 });
  handle.dispatch("pointermove", { clientX: -100, clientY: -100 });
  assert.equal(panel.style.left, "8px");
  assert.equal(panel.style.top, "8px");

  handle.dispatch("pointermove", { clientX: 2000, clientY: 2000 });
  assert.equal(panel.style.left, "672px");
  assert.equal(panel.style.top, "392px");
  handle.dispatch("pointerup");

  panel.rectHeight = 700;
  triggerResize(panel);
  assert.equal(panel.style.top, "92px");
});
