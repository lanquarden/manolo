// Model replies are markdown in practice (headings, lists, tables, fenced code, Mermaid diagrams). Rendering has to be
// safe: the text comes from a model, so raw HTML is never interpreted, links are restricted to http(s) and mailto, and
// images are not loaded from anywhere (the page's CSP would block them anyway; a broken image is worse than a link).
// Mermaid fences are drawn with Pele, the same renderer the statechart skill uses: it parses Mermaid and returns an SVG
// with CSS variables, so a diagram follows the workspace theme.
const MERMAID_MAX_SOURCE = 12_000;
const MERMAID_MAX_SVG = 500_000;
const MAX_MARKDOWN = 200_000;
const MAX_DIAGRAMS = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';
// Pele escapes the text it draws, but the SVG string crosses into our DOM, so the boundary is enforced here: only these
// elements and attributes survive, no attribute may start with `on`, and a reference must be local to the document.
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'marker', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'symbol', 'use',
]);
const SVG_ATTRIBUTES = new Set([
  'class', 'id', 'role', 'aria-label', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
  'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor',
  'dominant-baseline', 'marker-end', 'marker-start', 'marker-mid', 'clip-path', 'mask', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'patternUnits', 'preserveAspectRatio', 'xmlns',
]);
let diagramSequence = 0;

function sanitizeSvg(root, prefix) {
  // Rename every id and every reference to it, so two diagrams (or a diagram and the page) cannot collide.
  const ids = new Map();
  for (const node of root.querySelectorAll('[id]')) {
    const next = `${prefix}-${ids.size}`;
    ids.set(node.getAttribute('id'), next);
    node.setAttribute('id', next);
  }
  // `url(#id)` inside a paint attribute must follow the rename; any other URL is an external fetch and is dropped.
  const rewrite = value => value.replace(/url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g, (whole, id) => {
    const next = ids.get(id);
    return next === undefined ? 'none' : `url(#${next})`;
  });
  const clean = node => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name;
      const value = attribute.value;
      if (name.startsWith('on') || !SVG_ATTRIBUTES.has(name)) { node.removeAttribute(name); continue; }
      if (name === 'href' || name === 'xlink:href') {
        if (!value.startsWith('#')) node.removeAttribute(name);
        else node.setAttribute('href', `#${ids.get(value.slice(1)) ?? ''}`);
        continue;
      }
      if (name === 'style' || /javascript:|data:|https?:/i.test(value)) { node.removeAttribute(name); continue; }
      if (value.includes('url(')) node.setAttribute(name, rewrite(value));
    }
  };
  // The root is not part of `querySelectorAll('*')`, so it is checked first and then every descendant.
  clean(root);
  for (const node of [...root.querySelectorAll('*')]) {
    if (node.namespaceURI !== SVG_NS || !SVG_ELEMENTS.has(node.localName)) {
      node.remove();
      continue;
    }
    clean(node);
  }
  return root;
}

let markdown;
let diagramRender;
let enginePromise;

// markdown-it ships as a UMD bundle. Loading it on first use keeps it out of the critical path: the workspace paints
// without waiting for a 124 KB script, and a page that never shows markdown never fetches it.
async function loadEngine() {
  if (globalThis.markdownit !== undefined) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/markdown-it.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('markdown-it unavailable'));
    document.head.append(script);
  });
}

function engine() {
  if (markdown !== undefined) return markdown;
  // markdown-it is served as its prebuilt UMD bundle, so `window.markdownit` is the constructor. Without it, the caller
  // falls back to plain text rather than showing nothing.
  markdown = globalThis.markdownit === undefined ? null : globalThis.markdownit({
    html: false, linkify: true, breaks: true, typographer: false,
    validateLink: url => /^(https?:|mailto:)/i.test(url),
  });
  if (markdown) {
    // An image would be a network fetch to a model-chosen origin. Keep the alt text and the URL readable instead.
    markdown.renderer.rules.image = (tokens, index) => {
      const token = tokens[index];
      const alt = token.content || 'image';
      const href = markdown.utils.escapeHtml(token.attrGet('src') ?? '');
      return `<span class="md-image">${markdown.utils.escapeHtml(alt)}${href ? ` <span class="md-image-url">${href}</span>` : ''}</span>`;
    };
    // Every link opens in a new tab and cannot reach back into the page.
    const open = markdown.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
    markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
      tokens[index].attrSet('target', '_blank');
      tokens[index].attrSet('rel', 'noopener noreferrer');
      return open(tokens, index, options, env, self);
    };
  }
  return markdown;
}

async function renderer() {
  if (diagramRender !== undefined) return diagramRender;
  try {
    ({ render: diagramRender } = await import('/vendor/pele.js'));
  } catch {
    diagramRender = null;
  }
  return diagramRender;
}

// Pele returns an SVG string with one inline style attribute that only sets its CSS variables. The page's CSP keeps
// `style-src 'self'`, so the attribute is dropped and the variables live in style.css instead.
function diagramNode(svg, source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'md-diagram';
  const trimmed = svg.replace(/\sstyle="[^"]*"/, '');
  const parsed = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.nodeName === 'parsererror' || root.nodeName !== 'svg' || root.namespaceURI !== SVG_NS) throw new Error('Unreadable diagram');
  const clean = sanitizeSvg(document.importNode(root, true), `d${++diagramSequence}`);
  clean.setAttribute('role', 'img');
  wrapper.append(clean);
  const toggle = document.createElement('details');
  toggle.className = 'md-diagram-source';
  toggle.append(Object.assign(document.createElement('summary'), { textContent: 'Mermaid source' }),
    Object.assign(document.createElement('pre'), { textContent: source }));
  wrapper.append(toggle);
  return wrapper;
}

async function mermaidNodes(fragment) {
  const render = await renderer();
  let drawn = 0;
  for (const block of [...fragment.querySelectorAll('pre > code.language-mermaid')]) {
    if (++drawn > MAX_DIAGRAMS) break;
    const source = block.textContent ?? '';
    const holder = document.createElement('div');
    holder.className = 'md-diagram';
    if (render === null) {
      holder.append(Object.assign(document.createElement('pre'), { textContent: source }));
      holder.querySelector('pre').className = 'md-diagram-failed';
    } else {
      try {
        const result = source.length > MERMAID_MAX_SOURCE
          ? null
          : render(source, { links: false, images: false, maxEdges: 400, idPrefix: `d${diagramSequence + 1}` });
        if (!result || typeof result.svg !== 'string' || result.svg.length > MERMAID_MAX_SVG) throw new Error('Diagram too large');
        block.parentElement.replaceWith(diagramNode(result.svg, source));
        continue;
      } catch {
        holder.append(Object.assign(document.createElement('pre'), { textContent: `Could not draw this diagram.\n\n${source}` }));
        holder.querySelector('pre').className = 'md-diagram-failed';
      }
    }
    block.parentElement.replaceWith(holder);
  }
}

/**
 * Markdown text as a DOM node. Returns an element even when there is nothing to render, and degrades to plain text if the
 * markdown engine is unavailable. Callers insert the result; they never inject HTML strings.
 */
export async function renderMarkdown(text) {
  const container = document.createElement('div');
  container.className = 'markdown';
  const value = typeof text === 'string' ? text.slice(0, MAX_MARKDOWN) : '';
  enginePromise ??= loadEngine().catch(() => {});
  await enginePromise;
  const md = engine();
  if (md === null || value === '') {
    container.classList.add('plain-text');
    container.textContent = value;
    return container;
  }
  container.innerHTML = md.render(value);
  await mermaidNodes(container);
  return container;
}

/** True when the text contains markdown a plain-text renderer would visibly mangle. */
export function looksLikeMarkdown(text) {
  return typeof text === 'string' &&
    /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\|)/.test(text);
}
