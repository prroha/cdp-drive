// The JavaScript cdp-drive evaluates inside the page.
import { elementExpression, quote } from "./page.mjs";

const SNAPSHOT_LIMIT = 150;
const ELEMENT_NAME_LIMIT = 80;
const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[data-testid]";

// Visible means it occupies space and is not hidden by style. offsetParent is
// not the test: it is null for every position:fixed element.
const VISIBLE_HELPER = `const isVisible = (el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }
  const style = view.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
};`;

// A selector that resolves from the document root, so iframes under different
// parents each get one that actually matches them.
const CSS_PATH_HELPER = `const cssPath = (el) => {
  const escape = (value) => (view.CSS && view.CSS.escape ? view.CSS.escape(value) : value);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.id) {
      parts.unshift(node.tagName.toLowerCase() + '#' + escape(node.id));
      break;
    }
    const parent = node.parentElement;
    if (!parent) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const twins = [...parent.children].filter((child) => child.tagName === node.tagName);
    const step = twins.length > 1
      ? node.tagName.toLowerCase() + ':nth-of-type(' + (twins.indexOf(node) + 1) + ')'
      : node.tagName.toLowerCase();
    parts.unshift(step);
    node = parent;
  }
  return parts.join(' > ');
};`;

export function snapshotExpression(root) {
  return `(() => {
    const root = ${root};
    const view = root.defaultView || window;
    ${VISIBLE_HELPER}
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      type: el.getAttribute('type') || undefined,
      name: (el.getAttribute('aria-label') || el.name || el.placeholder ||
             (el.innerText || '').trim().slice(0, ${ELEMENT_NAME_LIMIT})) || undefined,
      id: el.id || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      href: el.getAttribute('href') || undefined,
    });
    const elements = [...root.querySelectorAll(${quote(INTERACTIVE_SELECTOR)})]
      .filter(isVisible)
      .slice(0, ${SNAPSHOT_LIMIT})
      .map(describe);
    return { url: view.location.href, title: root.title, interactive: elements };
  })()`;
}

export function framesExpression(root) {
  return `(() => {
    const root = ${root};
    const view = root.defaultView || window;
    ${CSS_PATH_HELPER}
    return [...root.querySelectorAll('iframe')].map((frame, index) => {
      let reachable = false;
      try {
        reachable = !!frame.contentDocument;
      } catch {
        reachable = false;
      }
      return {
        index,
        src: frame.getAttribute('src') || undefined,
        id: frame.id || undefined,
        name: frame.name || undefined,
        selector: cssPath(frame),
        reachable,
      };
    });
  })()`;
}

// Set through the element's own native setter so React and Vue see the change.
export function fillExpression(root, selector, value) {
  return elementExpression(
    root,
    selector,
    `const view = el.ownerDocument.defaultView;
     if (el.isContentEditable) {
       el.focus();
       el.textContent = ${quote(value)};
       el.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     }
     const proto = el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype
       : el instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype
       : el instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype
       : null;
     if (!proto) {
       throw new Error('cannot fill <' + el.tagName.toLowerCase() +
         '>: not an input, textarea, select or contenteditable element');
     }
     const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
     el.focus();
     if (setter) { setter.call(el, ${quote(value)}); } else { el.value = ${quote(value)}; }
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));
     return true;`,
  );
}
