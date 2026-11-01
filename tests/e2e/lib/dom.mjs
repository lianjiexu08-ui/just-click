/**
 * 迭代 6 E2E：页面侧断言工具。
 *
 * 这里的函数都会被 Playwright 序列化后丢进真实浏览器执行，
 * 所以必须自包含（不能引用模块作用域的变量），读到的值也必须是浏览器里的 DOM 真值。
 */

/** 深度收集 document + 任意层级 shadowRoot。 */
export function readByIds(ids) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const all = roots[i].querySelectorAll('*');
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) roots.push(all[j].shadowRoot);
    }
  }
  const find = (id) => {
    for (const root of roots) {
      const el = root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
      if (el) return el;
    }
    return null;
  };
  const out = {};
  for (const id of ids) {
    const el = find(id);
    out[id] = el ? el.value : null;
  }
  return out;
}

/** 深度统计 .jc-filled-highlight（含 shadow 内）。 */
export function countHighlights() {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const all = roots[i].querySelectorAll('*');
    for (let j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) roots.push(all[j].shadowRoot);
    }
  }
  const byId = {};
  let total = 0;
  for (const root of roots) {
    const hits = root.querySelectorAll('.jc-filled-highlight');
    total += hits.length;
    for (const el of hits) {
      if (el.id) byId[el.id] = (byId[el.id] || 0) + 1;
    }
  }
  return { total, byId };
}

/**
 * 两层 shadow 取值：hostId -> shadowRoot -> innerHostId -> shadowRoot -> #id
 * @param {{hostId:string, innerHostId:string, ids:string[]}} spec
 */
export function readNestedShadow(spec) {
  const host = document.getElementById(spec.hostId);
  const outer = host && host.shadowRoot;
  if (!outer) return { error: 'outer shadowRoot missing' };
  const innerHost = outer.getElementById ? outer.getElementById(spec.innerHostId) : outer.querySelector('#' + spec.innerHostId);
  const inner = innerHost && innerHost.shadowRoot;
  if (!inner) return { error: 'inner shadowRoot missing' };
  const out = {};
  for (const id of spec.ids) {
    const el = inner.getElementById ? inner.getElementById(id) : inner.querySelector('#' + id);
    out[id] = el ? el.value : null;
  }
  out.__innerHighlights = inner.querySelectorAll('.jc-filled-highlight').length;
  out.__outerHighlights = outer.querySelectorAll('.jc-filled-highlight').length;
  return out;
}

/** 页面上下文里的“提交是否被点过”。 */
export function readSubmitted() {
  return typeof window.__submitted === 'number' ? window.__submitted : null;
}
