// 节目简介是第三方 HTML。这里把它解析后按白名单重建，绝不直接插入页面。

const ALLOWED = new Set(['p', 'br', 'a', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i']);
// 这些标签连同内容一起丢弃；其余不在白名单里的标签只保留里面的文字。
const DROPPED = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math',
  'head', 'title', 'link', 'meta', 'form', 'input', 'button', 'select', 'textarea',
  'img', 'picture', 'video', 'audio', 'source', 'canvas',
]);
const BLOCKS = new Set(['p', 'ul', 'ol', 'li', 'br']);

function safeHref(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function copy(node, target, doc) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      target.append(doc.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    if (!ALLOWED.has(tag)) {
      copy(child, target, doc);
      continue;
    }
    if (tag === 'a') {
      const href = safeHref(child.getAttribute('href'));
      if (!href) {
        copy(child, target, doc);
        continue;
      }
      const link = doc.createElement('a');
      link.setAttribute('href', href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      copy(child, link, doc);
      target.append(link);
      continue;
    }
    const el = doc.createElement(tag);
    copy(child, el, doc);
    target.append(el);
  }
}

export function renderSafeHtml(html, doc = document) {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const fragment = doc.createDocumentFragment();
  copy(parsed.body, fragment, doc);

  // 纯文本的简介没有任何块级标签：按换行拆成段落，否则会挤成一行。
  const hasBlocks = [...fragment.childNodes].some(
    (node) => node.nodeType === 1 && BLOCKS.has(node.tagName.toLowerCase())
  );
  if (hasBlocks) return fragment;

  const wrapped = doc.createDocumentFragment();
  let paragraph = doc.createElement('p');
  const flush = () => {
    if (paragraph.textContent.trim()) wrapped.append(paragraph);
    paragraph = doc.createElement('p');
  };
  for (const node of [...fragment.childNodes]) {
    if (node.nodeType !== 3) {
      paragraph.append(node);
      continue;
    }
    const lines = node.nodeValue.split(/\n\s*\n|\r\n\s*\r\n/);
    lines.forEach((line, index) => {
      if (index > 0) flush();
      paragraph.append(doc.createTextNode(line));
    });
  }
  flush();
  return wrapped;
}
