/* Reading Lenses — in-page engine.
   Runs in the isolated world on every page and stays inert until a lens is on. */
(function () {
  'use strict';
  if (window.__rlLoaded) return;
  window.__rlLoaded = true;

  var DEFAULTS = {
    font: 'page',                 // page | atkinson | lexend | opendyslexic | system | georgia
    ls: 0, ws: 0, lh: 0, size: 0, measure: 0,   // 0 means "leave the page alone"
    bionic: false, bstr: 3,
    beeline: false,
    mask: false, aperture: 2,
    engine: 'none',               // none | pacer | tts | rsvp
    wpm: 300, rate: 1, rsvpWpm: 380, orp: true, pauses: true
  };
  var FONTS = {
    page: '',
    atkinson: '"RL Atkinson", system-ui, sans-serif',
    lexend: '"RL Lexend", system-ui, sans-serif',
    opendyslexic: '"RL OpenDyslexic", system-ui, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    georgia: 'Georgia, "Times New Roman", serif'
  };
  var RATIO = [0.25, 0.33, 0.42, 0.50, 0.62];

  var S = Object.assign({}, DEFAULTS);
  var scope = null, words = [], wrapped = false, paused = false;

  /* ------------------------------------------------------------------ scope */

  function textLen(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim().length : 0; }

  function pickScope() {
    var direct = document.querySelector('article, main, [role="main"]');
    if (direct && textLen(direct) > 500) return direct;

    var ps = Array.prototype.slice.call(document.querySelectorAll('p'))
      .filter(function (p) { return p.textContent.trim().length > 60; });
    if (!ps.length) return document.body;

    var score = new Map();
    ps.forEach(function (p) {
      var n = p.parentElement, d = 0;
      while (n && n !== document.documentElement && d < 3) {
        score.set(n, (score.get(n) || 0) + p.textContent.length);
        n = n.parentElement; d++;
      }
    });
    var max = 0;
    score.forEach(function (v) { if (v > max) max = v; });
    // Among the candidates holding most of the prose, take the most specific one.
    var best = document.body, bestDepth = -1;
    score.forEach(function (v, el) {
      if (v < max * 0.75) return;
      var depth = 0, n = el;
      while (n) { depth++; n = n.parentElement; }
      if (depth > bestDepth) { bestDepth = depth; best = el; }
    });
    return best;
  }
  function ensureScope() { if (!scope || !scope.isConnected) scope = pickScope(); return scope; }

  /* ------------------------------------------------------- word wrapping */

  var SKIP = 'script,style,noscript,code,pre,samp,kbd,textarea,select,option,svg,math,' +
             'button,input,label,nav,rl-t,reading-lenses,[contenteditable="true"],[aria-hidden="true"]';

  function wrap() {
    if (wrapped) return;
    var root = ensureScope();
    var seen = new Map(), nodes = [];
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        var vis = seen.get(p);
        if (vis === undefined) {
          var cs = getComputedStyle(p);
          vis = cs.display !== 'none' && cs.visibility !== 'hidden';
          seen.set(p, vis);
        }
        return vis ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    for (var n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n);

    words = [];
    nodes.forEach(function (node) {
      var orig = node.nodeValue;
      var holder = document.createElement('rl-t');
      holder.__rlText = orig;
      orig.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { holder.appendChild(document.createTextNode(part)); return; }
        var w = document.createElement('rl-w');
        w.textContent = part;
        holder.appendChild(w);
        words.push({ el: w, text: part });
      });
      if (node.parentNode) node.parentNode.replaceChild(holder, node);
    });
    wrapped = true;
  }

  function unwrap() {
    if (!wrapped) return;
    Array.prototype.forEach.call(document.querySelectorAll('rl-t'), function (h) {
      h.replaceWith(document.createTextNode(h.__rlText != null ? h.__rlText : h.textContent));
    });
    words = []; wrapped = false;
  }

  function needsWords() { return S.bionic || S.beeline || S.engine === 'pacer' || S.engine === 'tts'; }
  function syncWrap() { if (needsWords()) wrap(); else { stopAll(); unwrap(); } }

  /* ---------------------------------------------------------- typography */

  function applyTypo() {
    var el = ensureScope();
    var fam = FONTS[S.font] || '';
    el.classList.toggle('rl-typo', !!fam);
    if (fam) el.style.setProperty('--rl-font', fam); else el.style.removeProperty('--rl-font');

    var spacing = S.ls > 0 || S.ws > 0 || S.lh > 0;
    el.classList.toggle('rl-space', spacing);
    el.style.setProperty('--rl-ls', S.ls ? S.ls + 'em' : 'normal');
    el.style.setProperty('--rl-ws', S.ws ? S.ws + 'em' : 'normal');
    el.style.setProperty('--rl-lh', S.lh ? String(S.lh) : 'normal');

    el.classList.toggle('rl-size', S.size > 0);
    if (S.size) el.style.setProperty('--rl-size', S.size + 'px');

    el.classList.toggle('rl-measure', S.measure > 0);
    if (S.measure) el.style.setProperty('--rl-measure', S.measure + 'ch');

    relayout();
  }
  function clearTypo() {
    if (!scope) return;
    ['rl-typo', 'rl-space', 'rl-size', 'rl-measure'].forEach(function (c) { scope.classList.remove(c); });
    ['--rl-font', '--rl-ls', '--rl-ws', '--rl-lh', '--rl-size', '--rl-measure']
      .forEach(function (p) { scope.style.removeProperty(p); });
  }

  /* -------------------------------------------------------------- bionic */

  function applyBionic() {
    var r = RATIO[S.bstr - 1];
    words.forEach(function (w) {
      if (!S.bionic) { if (w.el.firstElementChild) w.el.textContent = w.text; return; }
      var m = w.text.match(/^[^\p{L}]*\p{L}+/u);
      var head = m ? m[0].length : w.text.length;
      var cut = Math.max(1, Math.min(w.text.length, Math.round(head * r)));
      var b = document.createElement('rl-b');
      b.textContent = w.text.slice(0, cut);
      w.el.textContent = '';
      w.el.appendChild(b);
      w.el.appendChild(document.createTextNode(w.text.slice(cut)));
    });
    relayout();
  }

  /* ------------------------------------------------ chromatic guidance */

  var HUES = [188, 246, 340, 38];
  function hueLerp(a, b, t) { var d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; }

  function pageIsDark() {
    var el = ensureScope();
    while (el && el !== document.documentElement) {
      var bg = getComputedStyle(el).backgroundColor;
      var m = bg && bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(',').map(parseFloat);
        if (p.length < 4 || p[3] > 0.1) return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128;
      }
      el = el.parentElement;
    }
    var body = getComputedStyle(document.body).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (body) {
      var q = body[1].split(',').map(parseFloat);
      return (0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]) < 128;
    }
    return false;
  }

  function paintBeeline() {
    if (!S.beeline) {
      words.forEach(function (w) { w.el.style.removeProperty('color'); });
      return;
    }
    var tops = words.map(function (w) {
      return Math.round(w.el.getBoundingClientRect().top + window.scrollY);
    });
    var lines = [], cur = null, last = null;
    tops.forEach(function (t, i) {
      if (t !== last) { cur = []; lines.push(cur); last = t; }
      cur.push(i);
    });
    var dark = pageIsDark();
    var S_ = dark ? '55%' : '64%', L_ = dark ? '72%' : '33%';
    lines.forEach(function (g, li) {
      var h0 = HUES[li % HUES.length], h1 = HUES[(li + 1) % HUES.length];
      g.forEach(function (idx, j) {
        var w = words[idx];
        // Leave links alone so the page keeps its own affordances.
        if (w.el.closest('a')) { w.el.style.removeProperty('color'); return; }
        var t = g.length > 1 ? j / (g.length - 1) : 0;
        w.el.style.setProperty('color',
          'hsl(' + hueLerp(h0, h1, t).toFixed(1) + ', ' + S_ + ', ' + L_ + ')', 'important');
      });
    });
  }

  var pending = false;
  function relayout() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; paintBeeline(); sizeBand(); });
  }
  var rzT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzT); rzT = setTimeout(relayout, 180);
  });

  /* ----------------------------------------------------------- shadow UI */

  var host = document.createElement('reading-lenses');
  var shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  var UI_CSS = "" +
  ":host{all:initial}" +
  "*,*::before,*::after{box-sizing:border-box}" +
  ".r{--bg:#FAFBF8;--bg2:#EFF1EC;--ink:#14171B;--ink2:#454B52;--mut:#6C747A;--rule:#D5D9D2;" +
  "--rule2:#B7BEB6;--acc:#0E6E78;--acci:#fff;--soft:#D7E7E8;--rose:#C0456B;--shadow:0 2px 6px rgba(0,0,0,.10),0 18px 44px -20px rgba(0,0,0,.45)}" +
  "@media (prefers-color-scheme:dark){.r{--bg:#171B1E;--bg2:#1E2327;--ink:#E7EAE6;--ink2:#BAC1BC;--mut:#8A9490;" +
  "--rule:#2A3034;--rule2:#3C4449;--acc:#5AC7D1;--acci:#082427;--soft:#123035;--rose:#F08AA6;--shadow:0 2px 6px rgba(0,0,0,.5),0 18px 44px -20px rgba(0,0,0,.9)}}" +
  ".panel{position:fixed;right:18px;bottom:18px;width:306px;max-height:78vh;display:flex;flex-direction:column;" +
  "background:var(--bg);color:var(--ink);border:1px solid var(--rule2);border-radius:10px;box-shadow:var(--shadow);" +
  "font-family:'RL Atkinson',system-ui,sans-serif;font-size:12px;line-height:1.4;overflow:hidden}" +
  ".panel[hidden]{display:none}" +
  ".hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--bg2);border-bottom:1px solid var(--rule);cursor:grab;user-select:none;flex:none}" +
  ".hd.drag{cursor:grabbing}" +
  ".hd .nm{font-weight:700;font-size:12.5px;flex:1;letter-spacing:-.01em}" +
  ".ib{border:1px solid transparent;background:none;color:var(--mut);cursor:pointer;border-radius:4px;padding:2px 5px;font-size:12px;font-family:inherit}" +
  ".ib:hover{background:var(--soft);color:var(--ink)}" +
  ".bd{overflow-y:auto;padding:2px 0}" +
  ".g{padding:10px 12px;border-bottom:1px solid var(--rule);display:flex;flex-direction:column;gap:7px}" +
  ".g:last-child{border-bottom:none}" +
  ".gt{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--mut)}" +
  ".row{display:flex;align-items:center;gap:8px}" +
  ".row>label{font-size:11px;color:var(--ink2);width:66px;flex:none}" +
  ".row .v{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--mut);width:50px;text-align:right;flex:none;font-variant-numeric:tabular-nums}" +
  "input[type=range]{flex:1;min-width:0;accent-color:var(--acc);height:16px;margin:0}" +
  "select{width:100%;padding:5px 6px;border:1px solid var(--rule2);border-radius:5px;background:var(--bg2);color:var(--ink);font:inherit;font-size:11.5px}" +
  ".sw{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}" +
  ".sw input{position:absolute;opacity:0;width:0;height:0}" +
  ".tk{width:30px;height:17px;border-radius:99px;background:var(--rule2);position:relative;flex:none;transition:background .14s}" +
  ".tk::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--bg);transition:transform .14s}" +
  ".sw input:checked+.tk{background:var(--acc)}" +
  ".sw input:checked+.tk::after{transform:translateX(13px)}" +
  ".sw span:last-child{font-size:11.5px;color:var(--ink2)}" +
  ".bts{display:flex;gap:5px;flex-wrap:wrap}" +
  "button.b{padding:4px 9px;border:1px solid var(--rule2);border-radius:5px;background:var(--bg2);color:var(--ink);font:inherit;font-size:11px;cursor:pointer}" +
  "button.b:hover{border-color:var(--acc);background:var(--soft)}" +
  "button.b.pr{background:var(--acc);border-color:var(--acc);color:var(--acci);font-weight:700}" +
  ".seg{display:grid;grid-template-columns:1fr 1fr;gap:4px}" +
  ".seg label{position:relative;border:1px solid var(--rule2);border-radius:5px;background:var(--bg2);padding:5px 7px;cursor:pointer;font-size:11px;text-align:center}" +
  ".seg input{position:absolute;opacity:0;width:0;height:0}" +
  ".seg label:has(input:checked){background:var(--acc);border-color:var(--acc);color:var(--acci);font-weight:700}" +
  ".hint{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--mut);line-height:1.5}" +
  ".st{font-size:10.5px;color:var(--mut)}" +
  "[hidden]{display:none!important}" +
  ".mask{position:fixed;inset:0;pointer-events:none}" +
  ".band{position:absolute;left:0;right:0;box-shadow:0 0 0 100vmax rgba(12,14,16,.62)}" +
  ".band::before,.band::after{content:'';position:absolute;left:0;right:0;height:1px;background:#5AC7D1;opacity:.8}" +
  ".band::before{top:-1px}.band::after{bottom:-1px}" +
  ".rsvp{position:fixed;inset:0;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;" +
  "align-items:center;justify-content:center;gap:30px;font-family:'RL Atkinson',system-ui,sans-serif}" +
  ".rw{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;width:min(900px,86vw);" +
  "font-size:clamp(30px,5.4vw,58px);line-height:1.15;white-space:pre;position:relative}" +
  ".rw .l{text-align:right}.rw .r2{text-align:left}" +
  ".rw.orp .o{color:var(--rose)}" +
  ".ticks{position:absolute;left:50%;top:-26px;bottom:-26px;width:2px;background:var(--rose);opacity:.35}" +
  ".rmeta{width:min(900px,86vw);display:flex;justify-content:space-between;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}" +
  ".rbar{width:min(900px,86vw);height:3px;background:var(--rule);border-radius:99px;overflow:hidden}" +
  ".rbar i{display:block;height:100%;background:var(--acc);width:0}" +
  ".rctl{display:flex;gap:8px;align-items:center}";

  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    var st = document.createElement('style');
    st.textContent = UI_CSS;
    shadow.appendChild(st);
  }

  var wrapEl = document.createElement('div');
  wrapEl.className = 'r';
  wrapEl.innerHTML =
    '<div class="mask" id="mask" hidden><div class="band" id="band"></div></div>' +
    '<div class="rsvp" id="rsvpv" hidden>' +
      '<div class="rw orp" id="rw"><span class="ticks"></span><span class="l"></span><span class="o"></span><span class="r2"></span></div>' +
      '<div class="rmeta"><span id="rcount">—</span><span id="reta">—</span></div>' +
      '<div class="rbar"><i id="rbar"></i></div>' +
      '<div class="rctl">' +
        '<button class="b pr" id="rplay">Start</button>' +
        '<button class="b" id="rback">&larr; 10</button>' +
        '<button class="b" id="rfwd">10 &rarr;</button>' +
        '<button class="b" id="rclose">Close (Esc)</button>' +
      '</div>' +
      '<div class="hint">&larr; &rarr; step &nbsp;·&nbsp; &uarr; &darr; speed &nbsp;·&nbsp; space play/pause</div>' +
    '</div>' +
    '<div class="panel" id="panel" hidden>' +
      '<div class="hd" id="hd"><span class="nm">Reading Lenses</span>' +
        '<button class="ib" id="rescan" title="Re-scan the page">&#8635;</button>' +
        '<button class="ib" id="reset" title="Remove every lens">Reset</button>' +
        '<button class="ib" id="close" title="Hide panel">&#10005;</button></div>' +
      '<div class="bd">' +
        '<div class="g"><div class="gt">Typeface</div>' +
          '<select id="font">' +
            '<option value="page">Page default</option>' +
            '<option value="atkinson">Atkinson Hyperlegible</option>' +
            '<option value="lexend">Lexend</option>' +
            '<option value="opendyslexic">OpenDyslexic</option>' +
            '<option value="system">System sans</option>' +
            '<option value="georgia">Georgia</option>' +
          '</select></div>' +
        '<div class="g"><div class="gt">Crowding &amp; spacing</div>' +
          '<div class="row"><label>Tracking</label><input type="range" id="ls" min="0" max="0.14" step="0.01"><span class="v" id="ls_v"></span></div>' +
          '<div class="row"><label>Word gap</label><input type="range" id="ws" min="0" max="0.4" step="0.02"><span class="v" id="ws_v"></span></div>' +
          '<div class="row"><label>Leading</label><input type="range" id="lh" min="0" max="2.2" step="0.05"><span class="v" id="lh_v"></span></div>' +
          '<div class="row"><label>Size</label><input type="range" id="size" min="0" max="30" step="1"><span class="v" id="size_v"></span></div>' +
          '<div class="row"><label>Measure</label><input type="range" id="measure" min="0" max="90" step="1"><span class="v" id="measure_v"></span></div>' +
          '<div class="bts"><button class="b" id="p_off">Page</button><button class="b" id="p_crowd">Reduced crowding</button></div></div>' +
        '<div class="g"><div class="gt">Fixation anchoring</div>' +
          '<label class="sw"><input type="checkbox" id="bionic"><span class="tk"></span><span>Bold word openings</span></label>' +
          '<div class="row"><label>Strength</label><input type="range" id="bstr" min="1" max="5" step="1"><span class="v" id="bstr_v"></span></div></div>' +
        '<div class="g"><div class="gt">Chromatic line guidance</div>' +
          '<label class="sw"><input type="checkbox" id="beeline"><span class="tk"></span><span>Ramp hues per line</span></label>' +
          '<div class="hint">Links keep their own colour.</div></div>' +
        '<div class="g"><div class="gt">Reading mask</div>' +
          '<label class="sw"><input type="checkbox" id="mask_t"><span class="tk"></span><span>Aperture follows cursor</span></label>' +
          '<div class="row"><label>Aperture</label><input type="range" id="aperture" min="1" max="4" step="1"><span class="v" id="aperture_v"></span></div></div>' +
        '<div class="g"><div class="gt">Pacing engine</div>' +
          '<div class="seg" id="eng">' +
            '<label><input type="radio" name="e" value="none">Off</label>' +
            '<label><input type="radio" name="e" value="pacer">Pacer</label>' +
            '<label><input type="radio" name="e" value="tts">Read aloud</label>' +
            '<label><input type="radio" name="e" value="rsvp">RSVP</label></div>' +
          '<div id="c_pacer" hidden>' +
            '<div class="row"><label>Target</label><input type="range" id="wpm" min="150" max="700" step="10"><span class="v" id="wpm_v"></span></div>' +
            '<div class="bts"><button class="b pr" id="pplay">Start</button><button class="b" id="preset2">Reset</button></div></div>' +
          '<div id="c_tts" hidden>' +
            '<div class="row"><label>Speed</label><input type="range" id="rate" min="0.6" max="2" step="0.1"><span class="v" id="rate_v"></span></div>' +
            '<div class="row"><label>Voice</label><select id="voice"></select></div>' +
            '<div class="bts"><button class="b pr" id="tplay">Speak</button><button class="b" id="tstop">Stop</button></div>' +
            '<div class="st" id="tstat">Ready.</div></div>' +
          '<div id="c_rsvp" hidden>' +
            '<div class="row"><label>Target</label><input type="range" id="rsvpWpm" min="150" max="900" step="10"><span class="v" id="rsvpWpm_v"></span></div>' +
            '<label class="sw"><input type="checkbox" id="orp"><span class="tk"></span><span>Mark the ORP</span></label>' +
            '<label class="sw"><input type="checkbox" id="pauses"><span class="tk"></span><span>Hold on punctuation</span></label>' +
            '<div class="bts"><button class="b pr" id="ropen">Open reader</button></div>' +
            '<div class="hint">Uses the selection if you have one.</div></div>' +
          '<div class="hint">Alt-click any word to start from there.</div></div>' +
        '<div class="g"><div class="hint">Alt+R panel &nbsp;·&nbsp; Alt+M mask &nbsp;·&nbsp; Alt+S RSVP</div></div>' +
      '</div>' +
    '</div>';
  shadow.appendChild(wrapEl);

  var $ = function (id) { return shadow.getElementById(id); };
  var panel = $('panel');

  /* --------------------------------------------------------------- mask */

  var maskEl = $('mask'), band = $('band'), bandY = null;

  function lineHeightPx() {
    var el = ensureScope();
    var probe = el.querySelector('p') || el;
    var lh = parseFloat(getComputedStyle(probe).lineHeight);
    if (isNaN(lh)) lh = parseFloat(getComputedStyle(probe).fontSize) * 1.5;
    return lh || 28;
  }
  function sizeBand() {
    if (!S.mask) return;
    var h = lineHeightPx() * S.aperture + 8;
    var y = bandY == null ? innerHeight * 0.42 : bandY;
    y = Math.max(h / 2, Math.min(innerHeight - h / 2, y));
    bandY = y;
    band.style.height = h + 'px';
    band.style.top = (y - h / 2) + 'px';
  }
  function applyMask() {
    maskEl.hidden = !S.mask;
    if (S.mask) sizeBand();
  }
  window.addEventListener('pointermove', function (e) {
    if (!S.mask) return;
    bandY = e.clientY;
    sizeBand();
  }, { passive: true });

  /* ------------------------------------------------------ pacing shared */

  function duration(text, msPerWord, pauses) {
    var letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    var m = Math.min(1.7, 0.78 + letters * 0.052);
    if (pauses) {
      if (/[.!?]["'’)\]]?$/.test(text)) m *= 2.1;
      else if (/[,;:—–]["'’)\]]?$/.test(text)) m *= 1.55;
    }
    return msPerWord * m;
  }
  function clearHi() { words.forEach(function (w) { w.el.classList.remove('rl-on'); }); }
  function hi(i) {
    clearHi();
    if (i < 0 || i >= words.length) return;
    var el = words[i].el;
    el.classList.add('rl-on');
    var r = el.getBoundingClientRect();
    if (r.top < 100 || r.bottom > innerHeight - 140) el.scrollIntoView({ block: 'center' });
  }
  function stopAll() { stopPacer(); stopTts(); }

  /* -------------------------------------------------------------- pacer */

  var pac = { raf: 0, i: 0, acc: 0, last: 0, run: false };
  function pacerStep(ts) {
    if (!pac.run) return;
    if (!pac.last) pac.last = ts;
    pac.acc += ts - pac.last; pac.last = ts;
    if (!words[pac.i]) { stopPacer(); return; }
    var need = duration(words[pac.i].text, 60000 / S.wpm, true);
    if (pac.acc >= need) {
      pac.acc -= need; pac.i++;
      if (pac.i >= words.length) { stopPacer(); return; }
      hi(pac.i);
    }
    pac.raf = requestAnimationFrame(pacerStep);
  }
  function startPacer() {
    wrap();
    if (!words.length) return;
    pac.run = true; pac.last = 0; pac.acc = 0;
    hi(pac.i);
    $('pplay').textContent = 'Pause';
    pac.raf = requestAnimationFrame(pacerStep);
  }
  function stopPacer() {
    pac.run = false;
    cancelAnimationFrame(pac.raf);
    var b = $('pplay'); if (b) b.textContent = pac.i > 0 ? 'Resume' : 'Start';
  }

  /* ---------------------------------------------------------- read aloud */

  var synth = window.speechSynthesis;
  var tts = { chunks: [], speaking: false, cursor: 0, fb: 0, timer: 0, got: false };

  function fillVoices() {
    if (!synth) return;
    var sel = $('voice'); if (!sel) return;
    var vs = synth.getVoices();
    var en = vs.filter(function (v) { return /^en/i.test(v.lang); });
    if (en.length) vs = en;
    sel.innerHTML = '<option value="">System default</option>';
    vs.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name; o.textContent = v.name + ' · ' + v.lang;
      sel.appendChild(o);
    });
  }
  if (synth) { fillVoices(); synth.addEventListener('voiceschanged', fillVoices); }

  function buildChunks() {
    // Chrome drops long utterances, so speak in blocks and track a word offset.
    var out = [], size = 220;
    for (var i = 0; i < words.length; i += size) {
      var slice = words.slice(i, i + size);
      var text = '', starts = [];
      slice.forEach(function (w, j) {
        starts.push(text.length);
        text += w.text + (j < slice.length - 1 ? ' ' : '');
      });
      out.push({ base: i, text: text, starts: starts });
    }
    return out;
  }
  function startTts(from) {
    if (!synth) return;
    wrap();
    if (!words.length) return;
    stopTts();
    tts.chunks = buildChunks();
    tts.speaking = true; tts.got = false;
    var startAt = from || 0;
    var vName = $('voice').value;
    var voice = vName ? synth.getVoices().filter(function (v) { return v.name === vName; })[0] : null;

    tts.chunks.forEach(function (c) {
      if (c.base + c.starts.length <= startAt) return;
      var u = new SpeechSynthesisUtterance(c.text);
      u.rate = S.rate;
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.onboundary = function (e) {
        if (e.name && e.name !== 'word') return;
        tts.got = true; clearTimeout(tts.fb); clearInterval(tts.timer);
        var k = 0;
        while (k + 1 < c.starts.length && c.starts[k + 1] <= e.charIndex) k++;
        hi(c.base + k);
      };
      u.onerror = function (ev) {
        if (ev && ev.error === 'interrupted') return;
        $('tstat').textContent = 'The speech engine refused to start on this page.';
        tts.speaking = false; $('tplay').textContent = 'Speak';
      };
      synth.speak(u);
    });
    var lastU = new SpeechSynthesisUtterance(' ');
    lastU.onend = function () {
      tts.speaking = false; clearInterval(tts.timer);
      $('tplay').textContent = 'Speak'; $('tstat').textContent = 'Finished.';
    };
    synth.speak(lastU);

    hi(startAt);
    $('tplay').textContent = 'Pause';
    $('tstat').textContent = 'Speaking…';
    tts.fb = setTimeout(function () {
      if (tts.got || !tts.speaking) return;
      $('tstat').textContent = 'This voice sends no word events — highlight is estimated.';
      var i = startAt, ms = 60000 / (170 * S.rate);
      tts.timer = setInterval(function () {
        if (!tts.speaking) { clearInterval(tts.timer); return; }
        i++; if (i >= words.length) { clearInterval(tts.timer); return; }
        hi(i);
      }, ms);
    }, 1400);
  }
  function stopTts() {
    if (!synth) return;
    clearTimeout(tts.fb); clearInterval(tts.timer);
    tts.speaking = false;
    try { synth.cancel(); } catch (e) {}
    var b = $('tplay'); if (b) b.textContent = 'Speak';
  }

  /* --------------------------------------------------------------- RSVP */

  var rv = { list: [], i: 0, t: 0, run: false };
  var rsvpv = $('rsvpv'), rw = $('rw');
  var rL = rw.querySelector('.l'), rO = rw.querySelector('.o'), rR = rw.querySelector('.r2');

  function orpIndex(n) { return n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4; }

  function rsvpSource() {
    var sel = String(window.getSelection());
    if (sel && sel.trim().split(/\s+/).length > 3) return sel.trim().split(/\s+/);
    if (wrapped && words.length) return words.map(function (w) { return w.text; });
    return ensureScope().innerText.trim().split(/\s+/);
  }
  function showWord(i) {
    var t = rv.list[i] || '';
    var k = orpIndex(t.length);
    rL.textContent = t.slice(0, k);
    rO.textContent = t.charAt(k);
    rR.textContent = t.slice(k + 1);
    $('rcount').textContent = 'word ' + (i + 1) + ' / ' + rv.list.length;
    $('rbar').style.width = ((i + 1) / rv.list.length * 100) + '%';
    $('reta').textContent = Math.round(60000 / S.rsvpWpm) + ' ms/word · ~' +
      Math.round((rv.list.length - i - 1) / S.rsvpWpm * 60) + 's left · ' + S.rsvpWpm + ' wpm';
  }
  function rsvpNext() {
    if (!rv.run) return;
    showWord(rv.i);
    rv.t = setTimeout(function () {
      rv.i++;
      if (rv.i >= rv.list.length) { rv.run = false; $('rplay').textContent = 'Start'; return; }
      rsvpNext();
    }, duration(rv.list[rv.i], 60000 / S.rsvpWpm, S.pauses));
  }
  function rsvpPause() { rv.run = false; clearTimeout(rv.t); $('rplay').textContent = 'Resume'; }
  function rsvpPlay() { rv.run = true; $('rplay').textContent = 'Pause'; rsvpNext(); }
  function openRsvp(from) {
    rv.list = rsvpSource();
    if (!rv.list.length) return;
    rv.i = from || 0;
    rsvpv.hidden = false;
    rw.classList.toggle('orp', S.orp);
    showWord(rv.i);
    rsvpPlay();
  }
  function closeRsvp() { rv.run = false; clearTimeout(rv.t); rsvpv.hidden = true; }

  $('rplay').addEventListener('click', function () { rv.run ? rsvpPause() : rsvpPlay(); });
  $('rclose').addEventListener('click', closeRsvp);
  $('rback').addEventListener('click', function () { rv.i = Math.max(0, rv.i - 10); showWord(rv.i); });
  $('rfwd').addEventListener('click', function () { rv.i = Math.min(rv.list.length - 1, rv.i + 10); showWord(rv.i); });

  window.addEventListener('keydown', function (e) {
    if (rsvpv.hidden) return;
    var k = e.key;
    if (k === 'Escape') { closeRsvp(); e.preventDefault(); }
    else if (k === ' ') { rv.run ? rsvpPause() : rsvpPlay(); e.preventDefault(); }
    else if (k === 'ArrowLeft') { rv.i = Math.max(0, rv.i - 5); showWord(rv.i); e.preventDefault(); }
    else if (k === 'ArrowRight') { rv.i = Math.min(rv.list.length - 1, rv.i + 5); showWord(rv.i); e.preventDefault(); }
    else if (k === 'ArrowUp') { patch({ rsvpWpm: Math.min(900, S.rsvpWpm + 20) }); showWord(rv.i); e.preventDefault(); }
    else if (k === 'ArrowDown') { patch({ rsvpWpm: Math.max(150, S.rsvpWpm - 20) }); showWord(rv.i); e.preventDefault(); }
  }, true);

  /* ------------------------------------------------- alt-click to start */

  document.addEventListener('click', function (e) {
    if (!e.altKey) return;
    var w = e.target && e.target.closest && e.target.closest('rl-w');
    if (!w) return;
    var idx = words.findIndex(function (x) { return x.el === w; });
    if (idx < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (S.engine === 'tts') { startTts(idx); }
    else if (S.engine === 'rsvp') { openRsvp(idx); }
    else { pac.i = idx; stopPacer(); startPacer(); }
  }, true);

  /* ------------------------------------------------------------ settings */

  function apply(changed) {
    if (paused) return;
    applyTypo();
    syncWrap();
    if (wrapped) applyBionic();
    applyMask();
    relayout();
    // engine panels
    $('c_pacer').hidden = S.engine !== 'pacer';
    $('c_tts').hidden = S.engine !== 'tts';
    $('c_rsvp').hidden = S.engine !== 'rsvp';
    if (changed === 'engine') { stopAll(); clearHi(); }
  }

  var saveT = 0;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      try { chrome.storage.local.set({ settings: S }); } catch (e) {}
    }, 250);
  }
  function patch(p, silent) {
    Object.assign(S, p);
    var k = Object.keys(p)[0];
    apply(k);
    if (!silent) { syncUI(); save(); }
  }

  /* ------------------------------------------------------------- UI wire */

  var FMT = {
    ls: function (v) { return v > 0 ? (+v).toFixed(2) + 'em' : 'page'; },
    ws: function (v) { return v > 0 ? (+v).toFixed(2) + 'em' : 'page'; },
    lh: function (v) { return v > 0 ? (+v).toFixed(2) : 'page'; },
    size: function (v) { return v > 0 ? v + 'px' : 'page'; },
    measure: function (v) { return v > 0 ? v + 'ch' : 'page'; },
    bstr: function (v) { return Math.round(RATIO[v - 1] * 100) + '%'; },
    wpm: function (v) { return v + ' wpm'; },
    rsvpWpm: function (v) { return v + ' wpm'; },
    aperture: function (v) { return v + (+v === 1 ? ' line' : ' lines'); },
    rate: function (v) { return (+v).toFixed(1) + '×'; }
  };
  var RANGES = ['ls', 'ws', 'lh', 'size', 'measure', 'bstr', 'aperture', 'wpm', 'rate', 'rsvpWpm'];
  var CHECKS = { bionic: 'bionic', beeline: 'beeline', mask: 'mask_t', orp: 'orp', pauses: 'pauses' };

  RANGES.forEach(function (k) {
    $(k).addEventListener('input', function () {
      var v = +this.value;
      $(k + '_v').textContent = FMT[k](this.value);
      patch(obj(k, v), true);
      save();
    });
  });
  Object.keys(CHECKS).forEach(function (k) {
    $(CHECKS[k]).addEventListener('change', function () { patch(obj(k, this.checked), true); save(); });
  });
  $('font').addEventListener('change', function () { patch({ font: this.value }, true); save(); });
  function obj(k, v) { var o = {}; o[k] = v; return o; }

  Array.prototype.forEach.call(shadow.querySelectorAll('input[name=e]'), function (r) {
    r.addEventListener('change', function () { patch({ engine: this.value }); });
  });

  $('p_off').addEventListener('click', function () { patch({ ls: 0, ws: 0, lh: 0, size: 0, measure: 0 }); });
  $('p_crowd').addEventListener('click', function () { patch({ ls: 0.08, ws: 0.26, lh: 1.75, size: 20, measure: 62 }); });
  $('pplay').addEventListener('click', function () { pac.run ? stopPacer() : startPacer(); });
  $('preset2').addEventListener('click', function () { stopPacer(); pac.i = 0; clearHi(); $('pplay').textContent = 'Start'; });
  if (synth) {
    $('tplay').addEventListener('click', function () {
      if (tts.speaking && !synth.paused) { synth.pause(); this.textContent = 'Resume'; return; }
      if (tts.speaking && synth.paused) { synth.resume(); this.textContent = 'Pause'; return; }
      startTts(0);
    });
    $('tstop').addEventListener('click', function () { stopTts(); clearHi(); $('tstat').textContent = 'Stopped.'; });
  } else {
    $('tplay').disabled = true; $('tstat').textContent = 'No speech engine in this browser.';
  }
  $('ropen').addEventListener('click', function () { openRsvp(0); });

  $('close').addEventListener('click', function () { panel.hidden = true; });
  $('rescan').addEventListener('click', function () {
    stopAll(); unwrap(); clearTypo(); scope = null;
    apply(); syncUI();
  });
  $('reset').addEventListener('click', function () {
    stopAll(); closeRsvp(); unwrap(); clearTypo();
    S = Object.assign({}, DEFAULTS);
    scope = null; bandY = null;
    apply(); syncUI(); save();
  });

  // drag the panel by its header
  (function () {
    var hd = $('hd'), dx = 0, dy = 0, on = false;
    hd.addEventListener('pointerdown', function (e) {
      on = true; hd.classList.add('drag'); hd.setPointerCapture(e.pointerId);
      var r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
    });
    hd.addEventListener('pointermove', function (e) {
      if (!on) return;
      panel.style.left = Math.max(4, Math.min(innerWidth - 60, e.clientX - dx)) + 'px';
      panel.style.top = Math.max(4, Math.min(innerHeight - 40, e.clientY - dy)) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    hd.addEventListener('pointerup', function () { on = false; hd.classList.remove('drag'); });
  })();

  function syncUI() {
    RANGES.forEach(function (k) { $(k).value = S[k]; $(k + '_v').textContent = FMT[k](S[k]); });
    Object.keys(CHECKS).forEach(function (k) { $(CHECKS[k]).checked = !!S[k]; });
    $('font').value = S.font;
    var r = shadow.querySelector('input[name=e][value="' + S.engine + '"]');
    if (r) r.checked = true;
    $('c_pacer').hidden = S.engine !== 'pacer';
    $('c_tts').hidden = S.engine !== 'tts';
    $('c_rsvp').hidden = S.engine !== 'rsvp';
  }

  /* ------------------------------------------------------------ messages */

  chrome.runtime.onMessage.addListener(function (msg, _s, reply) {
    if (msg.type === 'state') { reply({ settings: S, paused: paused, words: words.length }); return; }
    if (msg.type === 'patch') { patch(msg.patch); reply({ ok: true }); return; }
    if (msg.type === 'panel') { panel.hidden = !panel.hidden; reply({ ok: true }); return; }
    if (msg.type === 'rsvp') { rsvpv.hidden ? openRsvp(0) : closeRsvp(); reply({ ok: true }); return; }
    if (msg.type === 'mask') { patch({ mask: !S.mask }); reply({ ok: true }); return; }
    if (msg.type === 'pause') {
      paused = msg.value;
      if (paused) { stopAll(); closeRsvp(); unwrap(); clearTypo(); maskEl.hidden = true; panel.hidden = true; }
      else apply();
      reply({ ok: true }); return;
    }
    if (msg.type === 'reset') { $('reset').click(); reply({ ok: true }); return; }
  });

  /* ---------------------------------------------------------------- boot */

  try {
    chrome.storage.local.get(['settings', 'pausedSites'], function (d) {
      var sites = d.pausedSites || [];
      paused = sites.indexOf(location.origin) >= 0;
      S = Object.assign({}, DEFAULTS, d.settings || {});
      S.engine = 'none';            // engines never auto-start on load
      syncUI();
      if (!paused) apply();
    });
  } catch (e) { syncUI(); }
})();
