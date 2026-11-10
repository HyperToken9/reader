// PROTOTYPE 46 — throwaway. Do not build on this file; build: tickets start fresh in extension/.
// Paints the sentence spotlight (dim the rest of the main content), the nested dim and the word
// cursor with the CSS Custom Highlight API, per-colour buckets as in #45. The voice is FAKE:
// words advance on a ~180 wpm estimate.
(() => {
  if (window.__p46) return;
  window.__p46 = true;

  /* ------------------------------------------------------------ settings (in memory only) */
  const DIMS = { light: 0.55, medium: 0.4, strong: 0.25 }; // alpha kept on dimmed text
  const WDIM = 0.72;                                        // alpha kept on the rest of the lit sentence
  const S = {
    dim: 'medium',
    cursor: 'dim',         // 'dim' = nested dim (Blitz #16 default) | 'tint' = soft background on the word
    place: 'bottom',       // 'bottom' | 'near' | 'topright'
    speed: 1,
    perf: 'incremental',   // 'incremental' = only the nested dim per word | 'full' = re-register everything per word
    info: false,
  };
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

  /* ------------------------------------------------------------ helpers */
  const parentEl = n => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const shadowOf = el => {
    if (el.shadowRoot) return el.shadowRoot;
    try { return chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null; } catch (e) { return null; }
  };
  const SKIP = 'script,style,noscript,template,svg,math,button,input,select,textarea,nav,pre,' +
    '[aria-hidden="true"],[contenteditable=""],[contenteditable="true"],ra46-pill';
  const NOBREAK = 'a,code';

  /* ------------------------------------------------------------ main content */
  function textLen(el) { return (el.innerText || el.textContent || '').length; }
  function pickScope() { // Reading Lenses src/content.js, the #45 fallback
    const direct = document.querySelector('article, main, [role="main"]');
    if (direct && textLen(direct) > 500) return direct;
    const ps = [...document.querySelectorAll('p')].filter(p => p.textContent.trim().length > 60);
    if (!ps.length) return document.body;
    const score = new Map();
    for (const p of ps) { let n = p.parentElement, d = 0; while (n && n !== document.documentElement && d < 3) { score.set(n, (score.get(n) || 0) + p.textContent.length); n = n.parentElement; d++; } }
    let max = 0; score.forEach(v => { if (v > max) max = v; });
    let best = document.body, bd = -1;
    score.forEach((v, el) => { if (v < max * 0.75) return; let d = 0, n = el; while (n) { d++; n = n.parentElement; } if (d > bd) { bd = d; best = el; } });
    return best;
  }

  function readabilityKept() {
    const t0 = performance.now();
    const clone = document.cloneNode(true);
    const live = [];
    const w1 = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    const w2 = document.createTreeWalker(clone.documentElement, NodeFilter.SHOW_ELEMENT);
    let a = w1.currentNode, b = w2.currentNode, n = 0;
    while (a && b) { b.setAttribute('data-ra-i', n); live[n++] = a; a = w1.nextNode(); b = w2.nextNode(); }
    let art = null;
    try { art = new Readability(clone, { serializer: el => el }).parse(); } catch (e) { console.warn('[p46] readability failed', e); }
    if (!art || !art.content) return null;
    const kept = new Set();
    for (const el of art.content.querySelectorAll('[data-ra-i]')) kept.add(live[+el.getAttribute('data-ra-i')]);
    return { kept, ms: performance.now() - t0 };
  }

  /* ------------------------------------------------------------ text model */
  let shadowRoots = [];
  // Walk visible text in rendering order (into open/closed shadow roots, through slots).
  function walkTexts(root, onText, onBreak) {
    const visit = node => {
      if (node.nodeType === 3) { onText(node); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        if (node.matches(SKIP)) return;
        if (node.tagName === 'BR') { onBreak(); return; }
        if (node.checkVisibility && !node.checkVisibility({ visibilityProperty: true }) && getComputedStyle(node).display !== 'contents') return; // display:contents has no box (MDN's <main>)
        if (node.tagName === 'SLOT') { const as = node.assignedNodes({ flatten: true }); if (as.length) { as.forEach(visit); return; } }
        const sr = shadowOf(node);
        if (sr) { if (!shadowRoots.includes(sr)) shadowRoots.push(sr); visit(sr); return; }
      }
      for (let c = node.firstChild; c; c = c.nextSibling) visit(c);
    };
    visit(root);
  }

  const displayCache = new Map();
  function blockOf(n) {
    let el = parentEl(n);
    while (el) {
      let d = displayCache.get(el);
      if (d === undefined) { d = getComputedStyle(el).display; displayCache.set(el, d); }
      if (!d.startsWith('inline') && d !== 'contents') return el;
      el = parentEl(el);
    }
    return document.body;
  }

  const ABBR = /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|e\.g|i\.e|al|Fig|Figs|Eq|No|cf|approx|Jr|Sr|Inc|Ltd|Co|Corp|U\.S|Vol|pp|p)\.$/i;
  const INITIAL = /(?:^|[\s(])[A-Z]\.$/;
  const seg = new Intl.Segmenter(document.documentElement.lang || 'en', { granularity: 'sentence' });

  function buildModel(root, accept, mode) {
    displayCache.clear();
    const t0 = performance.now();
    const blocks = [];
    let cur = null, curKey = null, forceNew = false;
    const styleCache = new Map();
    walkTexts(root, node => {
      if (accept && !accept(node)) return;
      if (!node.data.length) return;
      const key = blockOf(node);
      if (!cur || key !== curKey || forceNew) { cur = { el: key, text: '', runs: [] }; blocks.push(cur); curKey = key; forceNew = false; }
      const pe = parentEl(node);
      let st = styleCache.get(pe);
      if (!st) { const cs = getComputedStyle(pe); st = { color: cs.color, fill: cs.webkitTextFillColor }; styleCache.set(pe, st); }
      const nb = !!(pe.closest && pe.closest(NOBREAK));
      cur.runs.push({ node, start: cur.text.length, end: cur.text.length + node.data.length, color: st.color, fill: st.fill, nb });
      cur.text += node.data;
    }, () => { forceNew = true; });

    const sentences = [];
    const byNode = new Map();
    for (const b of blocks) {
      if (!/[\p{L}\p{N}]/u.test(b.text)) continue;
      b.sents = [];
      for (const r of b.runs) byNode.set(r.node, { b, r });
      // sentence boundaries, with #42-style merges
      const cuts = [0];
      // UAX #29 treats LF as a paragraph separator and always breaks there, so raw source newlines
      // (PG's essays, most hand-written HTML) cut sentences in half. Segment a copy with them blanked.
      for (const s of seg.segment(b.text.replace(/[\n\r\t\f\u2028\u2029]/g, ' '))) {
        const i = s.index; if (i === 0) continue;
        const before = b.text.slice(0, i).trimEnd();
        if (ABBR.test(before) || INITIAL.test(before)) continue;           // Dr. | Smith, J. | R. R.
        if (!/\s/.test(b.text[i - 1] || ' ')) continue;                    // mid-token (URLs: a?|b=1)
        if (b.runs.some(r => r.nb && r.start < i && i < r.end && /\S/.test(b.text.slice(r.start, i)))) continue; // inside <a>/<code>
        cuts.push(i);
      }
      cuts.push(b.text.length);
      for (let k = 0; k < cuts.length - 1; k++) {
        let s = cuts[k], e = cuts[k + 1];
        while (s < e && /\s/.test(b.text[s])) s++;
        while (e > s && /\s/.test(b.text[e - 1])) e--;
        if (e <= s || !/[\p{L}\p{N}]/u.test(b.text.slice(s, e))) continue;
        const words = [];
        const re = /\S+/g; re.lastIndex = s; let m;
        const sub = b.text.slice(0, e);
        while ((m = re.exec(sub))) {
          let ws = m.index, we = m.index + m[0].length;
          const lead = m[0].match(/^[("'“‘\[«]+/), trail = m[0].match(/[)"'”’\].,;:!?»]+$/);
          if (lead && lead[0].length < m[0].length) ws += lead[0].length;
          if (trail && we - trail[0].length > ws) we -= trail[0].length;
          words.push([ws, we]);
        }
        const si = sentences.length;
        sentences.push({ b, s, e, words });
        b.sents.push(si);
      }
    }
    return { blocks: blocks.filter(b => b.sents), sentences, byNode, mode, ms: performance.now() - t0 };
  }

  function locate(b, off, isEnd) {
    const runs = b.runs;
    let lo = 0, hi = runs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid].end < off || (!isEnd && runs[mid].end === off)) lo = mid + 1; else hi = mid; }
    const r = runs[lo];
    return [r.node, Math.max(0, Math.min(r.node.data.length, off - r.start))];
  }
  function rangeOf(b, s, e) { const R = new Range(); R.setStart(...locate(b, s, false)); R.setEnd(...locate(b, e, true)); return R; }

  let model = null;
  function mainModel() {
    if (model && model.mode !== 'adhoc' && model.blocks.every(b => b.runs[0].node.isConnected)) return model;
    shadowRoots = [];
    const scope = pickScope();
    const rd = readabilityKept();
    let m = null;
    if (rd) {
      const kept = rd.kept;
      // Light-DOM text: its parent must have survived Readability. Shadow text: Readability never saw it
      // (cloneNode drops shadow roots), so accept it if its host, or the host's parent, survived.
      const accept = n => {
        let p = parentEl(n);
        if (p.getRootNode() === document) return kept.has(p);
        while (p && p.getRootNode() !== document) p = p.getRootNode().host;
        return !!p && (kept.has(p) || kept.has(p.parentElement));
      };
      m = buildModel(document.body, accept, 'readability');
      m.readabilityMs = rd.ms;
      const rl = m.blocks.reduce((a, b) => a + b.text.length, 0);
      if (rl < 0.4 * textLen(scope)) { console.log('[p46] readability kept too little', rl, textLen(scope)); m = null; }
    }
    if (!m || !m.sentences.length) m = buildModel(scope, null, 'fallback:' + (scope.tagName || '').toLowerCase());
    return (model = m);
  }
  function adhocModel(root) { return (model = buildModel(root, null, 'adhoc')); }

  /* ------------------------------------------------------------ hit-testing */
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y, { shadowRoots }); if (c) return [c.offsetNode, c.offset]; }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r ? [r.startContainer, r.startOffset] : null;
  }
  function firstText(node, offset) { // element endpoint -> first text node at/after it
    if (node.nodeType === 3) return [node, offset];
    const start = node.childNodes[offset] || node;
    const tw = document.createTreeWalker(start.nodeType === 1 ? start : node, NodeFilter.SHOW_TEXT);
    const t = tw.nextNode();
    return t ? [t, 0] : null;
  }
  function sentenceAt(m, node, offset, preferNext) {
    const hit = m.byNode.get(node);
    if (!hit) return -1;
    const off = hit.r.start + offset;
    const ids = hit.b.sents;
    for (const si of ids) { const s = m.sentences[si]; if (off < s.e || (!preferNext && off === s.e)) return si; }
    return ids[ids.length - 1];
  }

  /* ------------------------------------------------------------ painting */
  let sheet = null, cssRoute = null, styleEl = null;
  const colourIdx = new Map(); // "color|fill" -> k
  const registered = new Set();
  function baseOf(key) { const [c, f] = key.split('|'); return f && f !== c && f !== 'rgba(0, 0, 0, 0)' ? f : c; }
  function cssText() {
    let css = '::highlight(ra46-probe){color:rgb(1, 2, 3)}\n';
    const a = DIMS[S.dim];
    colourIdx.forEach((k, key) => {
      const base = baseOf(key);
      const d = `rgb(from ${base} r g b / calc(alpha * ${a}))`, w = `rgb(from ${base} r g b / calc(alpha * ${WDIM}))`;
      // A transparent fill means background-clip:text gradient text: setting a fill would paint over the
      // gradient, and colour alone can't fade a background, so such text simply doesn't dim.
      const clear = key.split('|')[1] === 'rgba(0, 0, 0, 0)';
      css += `::highlight(ra46-d-${k}){color:${d};${clear ? '' : '-webkit-text-fill-color:' + d}}\n`;
      css += `::highlight(ra46-w-${k}){color:${w};${clear ? '' : '-webkit-text-fill-color:' + w}}\n`;
    });
    css += '::highlight(ra46-cur){background-color:rgba(255, 196, 0, 0.38)}\n';
    return css;
  }
  async function applyCss() {
    const css = cssText();
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      try { document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) { console.warn('[p46] adoptedStyleSheets failed', e); }
      // probe: did the adopted sheet reach the cascade?
      const probe = getComputedStyle(document.body, '::highlight(ra46-probe)').color;
      if (probe === 'rgb(1, 2, 3)') cssRoute = 'adoptedStyleSheets';
      else {
        styleEl = document.createElement('style'); styleEl.textContent = css; document.documentElement.appendChild(styleEl);
        if (getComputedStyle(document.body, '::highlight(ra46-probe)').color === 'rgb(1, 2, 3)') cssRoute = '<style> element';
        else { styleEl.remove(); styleEl = null; cssRoute = 'chrome.scripting.insertCSS'; }
      }
      console.log('[p46] css route:', cssRoute);
    }
    if (cssRoute === 'adoptedStyleSheets') sheet.replaceSync(css);
    else if (cssRoute === '<style> element') styleEl.textContent = css;
    else await chrome.runtime.sendMessage({ cmd: 'insertCSS', css });
  }
  function keyOf(r) { const key = r.color + '|' + r.fill; if (!colourIdx.has(key)) { colourIdx.set(key, colourIdx.size); cssDirty = true; } return colourIdx.get(key); }
  let cssDirty = true;

  // Push [b, s, e] pieces into per-colour buckets as StaticRanges, one per run piece.
  function bucketPieces(pieces, buckets) {
    for (const [b, s, e] of pieces) {
      for (const r of b.runs) {
        if (r.end <= s || r.start >= e) continue;
        const a = Math.max(s, r.start) - r.start, z = Math.min(e, r.end) - r.start;
        if (z <= a) continue;
        const k = keyOf(r);
        let arr = buckets.get(k); if (!arr) buckets.set(k, (arr = []));
        arr.push(new StaticRange({ startContainer: r.node, startOffset: a, endContainer: r.node, endOffset: z }));
      }
    }
  }
  function register(prefix, buckets) {
    for (const name of [...registered]) if (name.startsWith(prefix)) { CSS.highlights.delete(name); registered.delete(name); }
    buckets.forEach((rs, k) => { const name = prefix + k; CSS.highlights.set(name, new Highlight(...rs)); registered.add(name); });
  }
  function paintDim(m, si) {
    const cur = m.sentences[si], pieces = [];
    for (const b of m.blocks) {
      if (b !== cur.b) { pieces.push([b, 0, b.text.length]); continue; }
      pieces.push([b, 0, cur.s], [b, cur.e, b.text.length]);
    }
    const buckets = new Map(); bucketPieces(pieces, buckets); register('ra46-d-', buckets);
  }
  function paintWord(m, si, wi) {
    const s = m.sentences[si], w = s.words[wi] || [s.e, s.e];
    const buckets = new Map();
    if (S.cursor === 'dim') bucketPieces([[s.b, s.s, w[0]], [s.b, w[1], s.e]], buckets);
    register('ra46-w-', buckets);
    if (S.cursor === 'tint') { CSS.highlights.set('ra46-cur', new Highlight(rangeOf(s.b, w[0], w[1]))); registered.add('ra46-cur'); }
    else { CSS.highlights.delete('ra46-cur'); registered.delete('ra46-cur'); }
  }
  function clearPaint() { for (const n of registered) CSS.highlights.delete(n); registered.clear(); }

  // timings
  const T = { word: [], frame: [], sentence: [] };
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
  function measureFrame() { // time from the paint call to the frame after it was presented
    const t0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => { T.frame.push(performance.now() - t0); if (T.frame.length > 400) T.frame.shift(); }));
  }

  /* ------------------------------------------------------------ fake voice */
  const R = { m: null, si: 0, wi: 0, end: 0, playing: false, timer: 0, lastSi: -1 };
  function wordMs(word) { const base = 60000 / (180 * S.speed); return base * Math.min(2.2, 0.55 + 0.09 * word.length); }
  async function paint(force) {
    const m = R.m; if (!m) return;
    const t0 = performance.now();
    if (force || R.si !== R.lastSi || S.perf === 'full') { const ts = performance.now(); paintDim(m, R.si); T.sentence.push(performance.now() - ts); }
    paintWord(m, R.si, R.wi);
    const dt = performance.now() - t0;
    T.word.push(dt); if (T.word.length > 400) T.word.shift();
    if (cssDirty) { cssDirty = false; await applyCss(); }
    measureFrame();
    if (R.si !== R.lastSi) { R.lastSi = R.si; follow(); }
    placePill();
    renderPill();
  }
  function schedule() {
    clearTimeout(R.timer);
    if (!R.playing) return;
    const s = R.m.sentences[R.si], w = s.words[R.wi];
    const word = w ? s.b.text.slice(w[0], w[1]) : '';
    let ms = wordMs(word);
    if (R.wi === s.words.length - 1) ms += 280 / S.speed;
    R.timer = setTimeout(() => {
      R.wi++;
      if (R.wi >= s.words.length) {
        R.wi = 0; R.si++;
        if (R.si > R.end) { stop(); return; }
      }
      paint(); schedule();
    }, ms);
  }
  function start(m, si, end) {
    if (!m || si < 0 || !m.sentences[si]) { toast('P46: nothing readable found here'); return; }
    R.m = m; R.si = si; R.wi = 0; R.end = end == null ? m.sentences.length - 1 : end; R.playing = true; R.lastSi = -1;
    cssDirty = true;
    ensurePill();
    window.addEventListener('click', onClickJump, true);
    paint(true); schedule();
  }
  function stop() {
    clearTimeout(R.timer); R.playing = false; R.m = null; clearPaint();
    window.removeEventListener('click', onClickJump, true);
    if (pillHost) { pillHost.remove(); pillHost = null; }
  }
  function jump(si) { R.si = Math.max(0, Math.min(R.m.sentences.length - 1, si)); R.wi = 0; paint(); schedule(); }

  function follow() {
    const s = R.m.sentences[R.si];
    const rect = rangeOf(s.b, s.s, s.e).getBoundingClientRect();
    if (rect.top < 70 || rect.bottom > innerHeight - 110) window.scrollBy({ top: rect.top - innerHeight * 0.33, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------ entry points */
  let lastCtx = null;
  window.addEventListener('contextmenu', e => { lastCtx = { x: e.clientX, y: e.clientY }; }, true);

  function readFromPoint(x, y) {
    const m = mainModel();
    const c = caretAt(x, y);
    if (c) {
      let si = sentenceAt(m, c[0], c[1], true);
      if (si >= 0) return start(m, si);
      // outside the main content: read from the clicked block to the end of its container
      const blk = blockOf(c[0]);
      const am = adhocModel(parentEl(blk) || blk);
      si = sentenceAt(am, c[0], c[1], true);
      if (si >= 0) return start(am, si);
    }
    // nearest following block in the main model
    const el = document.elementFromPoint(x, y);
    if (el) {
      const i = m.blocks.findIndex(b => b.el === el || el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (i >= 0) return start(m, m.blocks[i].sents[0]);
    }
    start(m, 0);
  }
  function selectionRange() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed && !sel.rangeCount) return null;
    if (sel.getComposedRanges) {
      let rs = null;
      try { rs = sel.getComposedRanges({ shadowRoots }); } catch (e) { try { rs = sel.getComposedRanges(...shadowRoots); } catch (e2) { } }
      if (rs && rs.length && !rs[0].collapsed) return { r: rs[0], via: 'getComposedRanges' };
    }
    if (sel.rangeCount && !sel.getRangeAt(0).collapsed) return { r: sel.getRangeAt(0), via: 'getRangeAt' };
    return null;
  }
  let lastSelVia = '-';
  function readThis() {
    mainModel(); // also collects shadowRoots for getComposedRanges
    const got = selectionRange();
    if (!got) { toast('P46: select some text first'); return; }
    lastSelVia = got.via;
    const r = got.r;
    const a = firstText(r.startContainer, r.startOffset), z = r.endContainer.nodeType === 3 ? [r.endContainer, r.endOffset] : firstText(r.endContainer, Math.max(0, r.endOffset - 1));
    if (!a || !z) { toast('P46: selection has no text'); return; }
    let m = model, s0 = sentenceAt(m, a[0], a[1], true), s1 = sentenceAt(m, z[0], z[1], false);
    if (s0 < 0 || s1 < 0) {
      // ad-hoc model from the selection's own container
      let root = a[0].getRootNode() === z[0].getRootNode() && r instanceof Range ? r.commonAncestorContainer : parentEl(blockOf(a[0]));
      if (root.nodeType === 3) root = parentEl(root);
      root = parentEl(blockOf(root.firstChild || root)) || root;
      m = adhocModel(root.nodeType === 1 ? root : parentEl(root));
      s0 = sentenceAt(m, a[0], a[1], true); s1 = sentenceAt(m, z[0], z[1], false);
      if (s0 < 0 || s1 < 0) { toast('P46: could not map the selection'); return; }
    }
    getSelection().removeAllRanges();
    start(m, s0, Math.max(s0, s1));
  }

  function onClickJump(e) {
    if (!R.m) return;
    const path = e.composedPath();
    if (pillHost && path.includes(pillHost)) return;
    const t = path[0];
    if (t.closest && t.closest('a[href],button,input,select,textarea,label,summary,[contenteditable]')) return;
    if (!getSelection().isCollapsed) return;
    const c = caretAt(e.clientX, e.clientY); if (!c) return;
    const si = sentenceAt(R.m, c[0], c[1], false);
    if (si >= 0) jump(si);
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.cmd === 'readFromHere') { const p = lastCtx || { x: innerWidth / 2, y: innerHeight / 3 }; readFromPoint(p.x, p.y); }
    else if (msg.cmd === 'readThis') readThis();
    else if (msg.cmd === 'toolbar') { if (selectionRange()) readThis(); else { const m = mainModel(); start(m, 0); } }
    else if (msg.cmd === 'set') { Object.assign(S, msg.s); cssDirty = true; if (R.m) paint(true); placePill(); }
    else if (msg.cmd === 'stop') stop();
    else if (msg.cmd === 'pause') { R.playing = false; clearTimeout(R.timer); renderPill(); }
    else if (msg.cmd === 'jump') jump(msg.si);
    else if (msg.cmd === 'probe') { // debugging aid for the automated check
      const m = mainModel(), c = caretAt(msg.x, msg.y);
      const blocks = m.blocks.map(b => b.el.tagName + ': ' + b.text.trim().slice(0, 50));
      reply({ mode: m.mode, caret: c && { node: c[0].nodeName, text: (c[0].data || '').slice(0, 40), parent: parentEl(c[0]) && parentEl(c[0]).tagName, inModel: m.byNode.has(c[0]) },
        nBlocks: blocks.length, first: blocks.slice(0, 4), last: blocks.slice(-3), sample: m.sentences.slice(0, 6).map(s => s.b.text.slice(s.s, s.e).slice(0, 60)) });
      return;
    }
    reply(stats());
  });

  function stats() {
    const m = R.m || model;
    const s = R.m && R.m.sentences[R.si];
    return {
      playing: R.playing, mode: m && m.mode, sentences: m && m.sentences.length, blocks: m && m.blocks.length,
      runs: m && m.blocks.reduce((a, b) => a + b.runs.length, 0), si: R.si, wi: R.wi,
      sentence: s ? s.b.text.slice(s.s, s.e).slice(0, 160) : null,
      word: s && s.words[R.wi] ? s.b.text.slice(...s.words[R.wi]) : null,
      colours: colourIdx.size, cssRoute, highlights: registered.size, selVia: lastSelVia, shadowRoots: shadowRoots.length,
      modelMs: m && +m.ms.toFixed(1), readabilityMs: m && m.readabilityMs && +m.readabilityMs.toFixed(1),
      wordMs: { p50: pct(T.word, 0.5), p95: pct(T.word, 0.95), max: pct(T.word, 1), n: T.word.length },
      dimRebuildMs: { p50: pct(T.sentence, 0.5), p95: pct(T.sentence, 0.95), n: T.sentence.length },
      frameMs: { p50: pct(T.frame, 0.5), p95: pct(T.frame, 0.95), max: pct(T.frame, 1), n: T.frame.length },
      settings: { ...S },
    };
  }
  window.addEventListener('p46-reset-timings', () => { T.word = []; T.frame = []; T.sentence = []; });

  /* ------------------------------------------------------------ reading pill (rough) */
  let pillHost = null, pillRoot = null;
  const PILL_CSS = `
    :host{all:initial}
    .pill{position:fixed;z-index:2147483647;font:13px/1.2 system-ui,sans-serif;color:#eef;background:rgba(24,26,34,.94);
      border-radius:22px;box-shadow:0 4px 18px rgba(0,0,0,.35);padding:6px 10px;display:flex;flex-direction:column;gap:4px;
      align-items:center;user-select:none;transition:top .18s,left .18s}
    .row{display:flex;gap:4px;align-items:center}
    button{all:unset;cursor:pointer;min-width:26px;height:26px;padding:0 6px;border-radius:13px;text-align:center;line-height:26px;color:#eef}
    button:hover{background:rgba(255,255,255,.12)}
    .play{background:#f2f2f6;color:#111;font-weight:700}
    .small button{height:18px;line-height:18px;font-size:11px;min-width:0;padding:0 6px;color:#aab}
    .small button.on{background:rgba(255,255,255,.18);color:#fff}
    .lab{font-size:10px;color:#889;margin-left:4px}
    .info{font:10px/1.3 ui-monospace,monospace;color:#9ab;max-width:420px;white-space:pre-wrap}
  `;
  function ensurePill() {
    if (pillHost) return;
    pillHost = document.createElement('ra46-pill');
    pillRoot = pillHost.attachShadow({ mode: 'closed' });
    const st = new CSSStyleSheet(); st.replaceSync(PILL_CSS); pillRoot.adoptedStyleSheets = [st];
    pillRoot.innerHTML = '<div class="pill"></div>';
    pillRoot.firstChild.addEventListener('click', onPillClick);
    document.documentElement.appendChild(pillHost);
    // If the adopted sheet did not land (CSP?), fall back to inline <style> inside the shadow root.
    if (getComputedStyle(pillRoot.firstChild).position !== 'fixed') { const s = document.createElement('style'); s.textContent = PILL_CSS; pillRoot.prepend(s); }
    window.addEventListener('scroll', () => requestAnimationFrame(placePill), { passive: true });
  }
  function btn(act, label, on, title) { return `<button data-a="${act}" class="${on ? 'on' : ''}" title="${title || ''}">${label}</button>`; }
  function renderPill() {
    if (!pillRoot) return;
    const p = pillRoot.firstChild;
    const st = stats();
    p.innerHTML =
      `<div class="row">${btn('back', '⏮', 0, 'sentence back')}<button class="play" data-a="play">${R.playing ? '❚❚' : '▶'}</button>${btn('fwd', '⏭', 0, 'sentence forward')}` +
      `${btn('speed', S.speed + '×', 0, 'speed')}${btn('close', '✕', 0, 'close')}</div>` +
      `<div class="row small"><span class="lab">dim</span>${Object.keys(DIMS).map(d => btn('dim:' + d, d[0].toUpperCase(), S.dim === d, d)).join('')}` +
      `<span class="lab">cursor</span>${btn('cursor:dim', 'nested dim', S.cursor === 'dim')}${btn('cursor:tint', 'tint', S.cursor === 'tint')}` +
      `<span class="lab">pill</span>${btn('place:bottom', 'bottom', S.place === 'bottom')}${btn('place:near', 'near', S.place === 'near')}${btn('place:topright', 'top-right', S.place === 'topright')}` +
      `${btn('info', 'i', S.info, 'show state')}</div>` +
      (S.info ? `<div class="info">${st.mode} · ${st.sentences} sentences · sentence ${st.si + 1} · ${st.colours} colours · css: ${st.cssRoute}\n` +
        `per word ${st.wordMs.p50}/${st.wordMs.p95} ms (p50/p95) · frame ${st.frameMs.p50}/${st.frameMs.p95} ms · perf ${S.perf} · sel ${st.selVia}</div>` : '');
  }
  function onPillClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    e.stopPropagation();
    const [a, v] = b.dataset.a.split(':');
    if (a === 'play') { R.playing = !R.playing; if (R.playing) schedule(); else clearTimeout(R.timer); }
    else if (a === 'back') jump(R.wi < 2 ? R.si - 1 : R.si);
    else if (a === 'fwd') jump(R.si + 1);
    else if (a === 'speed') S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
    else if (a === 'close') return stop();
    else if (a === 'dim') { S.dim = v; cssDirty = true; }
    else if (a === 'cursor') { S.cursor = v; }
    else if (a === 'place') S.place = v;
    else if (a === 'info') S.info = !S.info;
    paint(true);
  }
  function placePill() {
    if (!pillRoot) return;
    const p = pillRoot.firstChild, st = p.style;
    st.top = st.left = st.right = st.bottom = st.transform = '';
    if (S.place === 'bottom') { st.bottom = '20px'; st.left = '50%'; st.transform = 'translateX(-50%)'; }
    else if (S.place === 'topright') { st.top = '16px'; st.right = '16px'; }
    else if (R.m) {
      const s = R.m.sentences[R.si];
      const rects = [...rangeOf(s.b, s.s, s.e).getClientRects()];
      if (!rects.length) return;
      const last = rects[rects.length - 1], first = rects[0];
      const h = p.offsetHeight || 64, w = p.offsetWidth || 300;
      let top = last.bottom + 10;
      if (top + h > innerHeight - 8) top = first.top - h - 10;
      top = Math.max(8, Math.min(innerHeight - h - 8, top));
      const left = Math.max(8, Math.min(innerWidth - w - 8, first.left));
      st.top = top + 'px'; st.left = left + 'px';
    }
  }

  function toast(text) {
    const d = document.createElement('ra46-pill');
    const r = d.attachShadow({ mode: 'closed' });
    r.innerHTML = `<div style="position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);background:#222;color:#fff;font:13px system-ui;padding:8px 14px;border-radius:16px">${text}</div>`;
    document.documentElement.appendChild(d); setTimeout(() => d.remove(), 2200);
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && R.m) stop(); }, true);
})();
