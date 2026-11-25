// Model replies are markdown in practice (headings, lists, tables, fenced code, Mermaid diagrams). Rendering has to be
// safe: the text comes from a model, so raw HTML is never interpreted, links are restricted to http(s) and mailto, and
// images are not loaded from anywhere (the page's CSP would block them anyway; a broken image is worse than a link).
// Mermaid fences are drawn with Pele, the same renderer the statechart skill uses: it parses Mermaid and returns an SVG
// with CSS variables, so a diagram follows the workspace theme.
const MERMAID_MAX_SOURCE = 12_000;
const MERMAID_MAX_SVG = 500_000;
const MAX_MARKDOWN = 200_000;

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
  if (root.nodeName === 'parsererror' || root.nodeName !== 'svg') throw new Error('Unreadable diagram');
  root.setAttribute('role', 'img');
  wrapper.append(document.importNode(root, true));
  const toggle = document.createElement('details');
  toggle.className = 'md-diagram-source';
  toggle.append(Object.assign(document.createElement('summary'), { textContent: 'Mermaid source' }),
    Object.assign(document.createElement('pre'), { textContent: source }));
  wrapper.append(toggle);
  return wrapper;
}

async function mermaidNodes(fragment) {
  const render = await renderer();
  for (const block of [...fragment.querySelectorAll('pre > code.language-mermaid')]) {
    const source = block.textContent ?? '';
    const holder = document.createElement('div');
    holder.className = 'md-diagram';
    if (render === null) {
      holder.append(Object.assign(document.createElement('pre'), { textContent: source }));
      holder.querySelector('pre').className = 'md-diagram-failed';
    } else {
      try {
        const result = source.length > MERMAID_MAX_SOURCE ? null : render(source, { links: false, images: false, maxEdges: 400 });
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
