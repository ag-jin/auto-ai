// Lightweight DOM/VM harness for public/app.js.
//
// This intentionally uses no third-party DOM package. It implements only the
// small element/text/event surface that public/app.js touches, so the tests can
// execute the real render and click handlers without a browser or web server.
// It does not claim to be a full browser DOM.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function camelAttribute(name) {
  return String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function createStyle() {
  return {
    setProperty() {},
  };
}

class FakeNode {
  constructor(tagName, nodeType, ownerDocument) {
    this.tagName = String(tagName || '').toUpperCase();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this._text = '';
    this._attributes = new Map();
    this._listeners = new Map();
    this.dataset = {};
    this.style = createStyle();
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
  }

  get textContent() {
    const own = this._text || '';
    const nested = this.children.map((child) => child.textContent || '').join('');
    return own + nested;
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  append(...nodes) {
    for (const raw of nodes.flat(Infinity)) {
      if (raw === null || raw === undefined || raw === false) continue;
      const child =
        raw instanceof FakeNode ? raw : new FakeText(String(raw), this.ownerDocument);
      if (child.parentNode) {
        const index = child.parentNode.children.indexOf(child);
        if (index >= 0) child.parentNode.children.splice(index, 1);
      }
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    const key = String(name);
    this._attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'title') this.title = String(value);
  }

  getAttribute(name) {
    return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this._attributes.has(String(name));
  }

  addEventListener(type, listener) {
    const key = String(type);
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(listener);
  }

  removeEventListener(type, listener) {
    const key = String(type);
    const list = this._listeners.get(key);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatchEvent(event) {
    if (!event || !event.type) return [];
    if (event.type === 'click' && this.disabled) return [];
    if (!event.target) event.target = this;
    event.currentTarget = this;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    const listeners = this._listeners.get(String(event.type)) || [];
    return listeners.map((listener) => listener.call(this, event));
  }

  click() {
    return this.dispatchEvent({ type: 'click' });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  querySelectorAll(selector) {
    return this.ownerDocument._query(selector, this, false);
  }

  querySelector(selector) {
    return this.ownerDocument._query(selector, this, true)[0] || null;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super(tagName, 1, ownerDocument);
    this.id = '';
    this.className = '';
    this.title = '';
  }
}

class FakeText extends FakeNode {
  constructor(text, ownerDocument) {
    super('#text', 3, ownerDocument);
    this._text = String(text);
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document', 9, null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
    this.children = [this.documentElement];
    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this._documentListeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(text) {
    return new FakeText(text, this);
  }

  addEventListener(type, listener) {
    const key = String(type);
    if (!this._documentListeners.has(key)) this._documentListeners.set(key, []);
    this._documentListeners.get(key).push(listener);
  }

  _walk(node, visit) {
    visit(node);
    for (const child of node.children || []) this._walk(child, visit);
  }

  _matches(node, selector) {
    if (!(node instanceof FakeElement)) return false;
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) {
      return String(node.className).split(/\s+/).includes(selector.slice(1));
    }
    const dataSelector = /^\[data-([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (dataSelector) {
      const key = camelAttribute(dataSelector[1]);
      if (!Object.prototype.hasOwnProperty.call(node.dataset || {}, key)) return false;
      if (dataSelector[2] !== undefined) return String(node.dataset[key]) === dataSelector[2];
      return true;
    }
    return node.tagName.toLowerCase() === selector.toLowerCase();
  }

  _query(selector, root, firstOnly) {
    const results = [];
    const visit = (node) => {
      if (node !== root && this._matches(node, selector)) {
        results.push(node);
        if (firstOnly) return true;
      }
      for (const child of node.children || []) {
        if (visit(child)) return true;
      }
      return false;
    };
    visit(root === this ? this.documentElement : root);
    return results;
  }

  querySelectorAll(selector) {
    return this._query(selector, this, false);
  }

  querySelector(selector) {
    return this._query(selector, this, true)[0] || null;
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

export function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async json() {
      return payload === undefined ? null : structuredClone(payload);
    },
  };
}

export function statePayload(candidates, overrides = {}) {
  return {
    settings: {
      repositories: [{ repo: 'owner/repo', localPath: '/tmp/example', baseRef: 'HEAD' }],
      rules: {
        repositories: ['owner/repo'],
        labels: ['ready'],
        authors: [],
        keywords: [],
        states: ['open'],
      },
      concurrency: { global: 2, perRepo: 2 },
    },
    candidates,
    runs: [],
    events: [],
    templates: [{ id: 'development', version: '1', role: 'worker', description: 'fixture', path: 'templates/development/1.md', templateRef: 'abc:templates/development/1.md', commit: 'abc' }],
    templateListError: null,
    runtime: { watching: false, intervalSeconds: 60, lastPollAt: null, activeDrafts: [] },
    capabilities: { githubReady: true, piReady: true },
    csrfToken: 'csrf-test',
    ...overrides,
  };
}

export async function createUiHarness(options = {}) {
  const baseState = options.state || statePayload([]);
  const responseHandler = options.handler || null;
  const fetchCalls = [];
  let fetchIndex = 0;

  const fetch = async (url, init = {}) => {
    const call = {
      index: fetchIndex,
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    fetchIndex += 1;
    fetchCalls.push(call);
    if (responseHandler) {
      const response = await responseHandler(call, { baseState, jsonResponse });
      if (response !== undefined) return response;
    }
    if (call.method === 'GET' && call.url === '/api/state') {
      return jsonResponse(200, baseState);
    }
    return jsonResponse(200, { ok: true });
  };

  const document = new FakeDocument();
  const window = {
    setInterval: () => 1,
    addEventListener: () => {},
    confirm: () => true,
  };

  const context = vm.createContext({
    document,
    window,
    fetch,
    Node: FakeNode,
    HTMLElement: FakeElement,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  const source = await readFile(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'public/app.js' });

  for (const id of ['scope-line', 'top-controls', 'banner-region', 'sidebar', 'main']) {
    const node = document.createElement('div');
    node.id = id;
    document.body.append(node);
  }

  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await flush();

  const harness = {
    context,
    document,
    window,
    fetchCalls,
    flush,
    state: (candidates, overrides) => statePayload(candidates, overrides),
    applyState: (state) => context.applyState(state),
    render: () => context.render(),
    renderCandidateDetail: (candidate) => context.renderCandidateDetail(candidate),
    renderAcceptanceDetail: (candidate) => context.renderAcceptanceDetail(candidate),
    currentDraftEntry: (candidate) => context.currentDraftEntry(candidate),
    updateDraftEntry: (id) => context.updateDraftEntry(id),
    click: (node) => node.click(),
    text: (node) => (node ? node.textContent : ''),
    findData: (root, name, value) => {
      const selector = value === undefined ? `[data-${name}]` : `[data-${name}="${value}"]`;
      return root.querySelector(selector);
    },
    findAllData: (root, name) => root.querySelectorAll(`[data-${name}]`),
    findButton: (root, label) => {
      const buttons = root.querySelectorAll('button');
      return buttons.find((button) => button.textContent.includes(label)) || null;
    },
    buttons: (root) => root.querySelectorAll('button'),
  };
  return harness;
}
