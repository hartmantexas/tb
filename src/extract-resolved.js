/*
 * In-page CSS cascade resolver + styled-tree extractor for Lightpanda.
 *
 * Lightpanda parses CSS (document.styleSheets[].cssRules is populated) and
 * matches selectors (el.matches works), but it does NOT run the cascade into
 * getComputedStyle — every computed value comes back as the UA default. So we
 * run the cascade ourselves: collect every style rule, match it against each
 * element, merge by specificity + source order, expand the shorthands Takumi
 * needs as longhands, then emit a {type, props:{style, children}} tree that
 * takumi-renderer.ts consumes directly.
 *
 * This file is plain JS (no template-literal escaping) and is shipped to the
 * page as a string via readFileSync + Runtime.evaluate.
 */
(() => {
  var SKIP = {
    SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, NOSCRIPT: 1, IFRAME: 1, TEMPLATE: 1,
    HEAD: 1, TITLE: 1, SVG: 1, PATH: 1, CIRCLE: 1, RECT: 1, LINE: 1, POLYGON: 1,
    POLYLINE: 1, ELLIPSE: 1, DEFS: 1, CLIPPATH: 1, MASK: 1, G: 1, USE: 1,
    SYMBOL: 1, BR: 1, HR: 1,
  };
  var INLINE = {
    A: 1, SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, SMALL: 1, CODE: 1, LABEL: 1,
    ABBR: 1, TIME: 1, U: 1, MARK: 1, SUB: 1, SUP: 1, CITE: 1, Q: 1, S: 1,
  };
  var count = 0;
  var MAX = 800;

  function camel(p) {
    return p.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  // First color-ish token in a value (also used to give gradients a solid fallback).
  function extractColor(v) {
    var m = v.match(/#[0-9a-fA-F]{3,8}/) || v.match(/rgba?\([^)]*\)/) || v.match(/hsla?\([^)]*\)/);
    if (m) return m[0];
    var kw = v.match(/\b(white|black|silver|gray|grey|red|maroon|yellow|olive|lime|green|aqua|teal|blue|navy|fuchsia|purple|orange|gold|pink|brown|crimson|coral|indigo|violet|tomato|salmon|khaki|cyan|magenta|transparent)\b/i);
    return kw ? kw[0] : null;
  }

  // 1/2/3/4-value box shorthand → four longhands.
  function setBox(into, base, val) {
    var p = val.trim().split(/\s+/);
    var t, r, b, l;
    if (p.length === 1) { t = r = b = l = p[0]; }
    else if (p.length === 2) { t = b = p[0]; r = l = p[1]; }
    else if (p.length === 3) { t = p[0]; r = l = p[1]; b = p[2]; }
    else { t = p[0]; r = p[1]; b = p[2]; l = p[3]; }
    into[base + 'Top'] = t; into[base + 'Right'] = r;
    into[base + 'Bottom'] = b; into[base + 'Left'] = l;
  }

  function setBorder(into, val) {
    var w = (val.match(/(\d*\.?\d+)(px|em|rem)/) || [])[0] || '1px';
    var st = (val.match(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset|none)\b/) || [])[1] || 'solid';
    var c = extractColor(val) || '#888';
    ['Top', 'Right', 'Bottom', 'Left'].forEach(function (s) {
      into['border' + s + 'Width'] = w;
      into['border' + s + 'Style'] = st;
      into['border' + s + 'Color'] = c;
    });
  }

  function parseDecl(css, into) {
    if (!css) return;
    var parts = css.split(';');
    for (var i = 0; i < parts.length; i++) {
      var ci = parts[i].indexOf(':');
      if (ci === -1) continue;
      var prop = parts[i].slice(0, ci).trim().toLowerCase();
      var val = parts[i].slice(ci + 1).trim();
      if (!prop || !val) continue;
      if (val.indexOf('var(') !== -1 || val === 'inherit' || val === 'initial' || val === 'unset') continue;
      if (prop === 'padding') { setBox(into, 'padding', val); continue; }
      if (prop === 'margin') { setBox(into, 'margin', val); continue; }
      if (prop === 'background' || prop === 'background-color') {
        var col = extractColor(val);
        if (col) into.backgroundColor = col;
        continue;
      }
      if (prop === 'border') { setBorder(into, val); continue; }
      if (prop === 'border-color') {
        var c2 = extractColor(val);
        if (c2) ['Top', 'Right', 'Bottom', 'Left'].forEach(function (s) { into['border' + s + 'Color'] = c2; });
        continue;
      }
      if (prop === 'border-width') { setBox(into, 'borderWidthSide', val); continue; }
      if (prop === 'border-style') {
        ['Top', 'Right', 'Bottom', 'Left'].forEach(function (s) { into['border' + s + 'Style'] = val; });
        continue;
      }
      into[camel(prop)] = val;
    }
    // border-width longhand fixup (setBox can't emit borderTopWidth directly)
    if (into.borderWidthSideTop) {
      into.borderTopWidth = into.borderWidthSideTop;
      into.borderRightWidth = into.borderWidthSideRight;
      into.borderBottomWidth = into.borderWidthSideBottom;
      into.borderLeftWidth = into.borderWidthSideLeft;
      delete into.borderWidthSideTop; delete into.borderWidthSideRight;
      delete into.borderWidthSideBottom; delete into.borderWidthSideLeft;
    }
  }

  // ---- Collect every style rule with specificity + source order ----
  var rules = [];
  var order = 0;
  function spec(sel) {
    var a = (sel.match(/#[\w-]+/g) || []).length;
    var b = (sel.match(/\.[\w-]+/g) || []).length
      + (sel.match(/\[[^\]]+\]/g) || []).length
      + (sel.match(/:[\w-]+/g) || []).length;
    var c = (sel.replace(/[#.][\w-]+/g, ' ').replace(/::?[\w-]+(\([^)]*\))?/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length;
    return a * 10000 + b * 100 + c;
  }
  function collect(list) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.type === 1 && r.selectorText && r.style) {
        var css = r.style.cssText || '';
        var ss = r.selectorText.split(',');
        for (var j = 0; j < ss.length; j++) {
          var sl = ss[j].trim();
          if (sl) rules.push({ sel: sl, spec: spec(sl), order: order++, css: css });
        }
      } else if (r.cssRules) {
        collect(r.cssRules); // @media / @supports — assume the condition holds
      }
    }
  }
  try {
    var sh = document.styleSheets;
    for (var s = 0; s < sh.length; s++) {
      var cr;
      try { cr = sh[s].cssRules || sh[s].rules; } catch (e) { continue; }
      if (cr) collect(cr);
    }
  } catch (e) {}

  function resolve(el) {
    var matched = [];
    for (var i = 0; i < rules.length; i++) {
      var sel = rules[i].sel, ok = false;
      if (sel === '*') {
        ok = true;
      } else {
        // el.matches can't handle pseudo-elements/classes — strip them, keep structure.
        var test = sel.replace(/::[\w-]+/g, '').replace(/:[\w-]+(\([^)]*\))?/g, '').trim();
        if (!test) continue;
        try { ok = el.matches(test); } catch (e) { ok = false; }
      }
      if (ok) matched.push(rules[i]);
    }
    matched.sort(function (a, b) { return a.spec - b.spec || a.order - b.order; });
    var st = {};
    for (var k = 0; k < matched.length; k++) parseDecl(matched[k].css, st);
    var inl = el.getAttribute && el.getAttribute('style');
    if (inl) parseDecl(inl, st);

    // Gradient text (background-clip:text + transparent fill): there's no fill
    // box — the gradient IS the text. Repaint the text with the gradient's
    // representative color instead of leaving a solid filled block.
    if (st.webkitBackgroundClip === 'text' || st.backgroundClip === 'text') {
      if (st.backgroundColor) st.color = st.backgroundColor;
      delete st.backgroundColor;
      delete st.webkitTextFillColor;
    } else if (st.webkitTextFillColor && st.webkitTextFillColor !== 'transparent') {
      st.color = st.webkitTextFillColor;
    }
    return st;
  }

  function txt(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function mapType(tag) {
    if (tag === 'IMG') return 'img';
    if (INLINE[tag]) return 'span';
    return 'div';
  }

  function build(node, depth) {
    if (count > MAX || depth > 18) return null;
    if (node.nodeType === 3) {
      var t = (node.textContent || '').replace(/\s+/g, ' ');
      return t.trim() ? t : null;
    }
    if (node.nodeType !== 1) return null;
    var tag = node.tagName;
    if (SKIP[tag]) return null;
    count++;
    var s = resolve(node);

    // User-agent defaults Lightpanda doesn't fold into our resolved styles.
    if (/^H[1-6]$/.test(tag)) {
      if (!s.fontWeight) s.fontWeight = '700';
      if (!s.fontSize) s.fontSize = { H1: '32px', H2: '24px', H3: '19px', H4: '16px', H5: '13px', H6: '11px' }[tag];
    } else if (tag === 'B' || tag === 'STRONG' || tag === 'TH') {
      if (!s.fontWeight) s.fontWeight = '700';
    } else if (tag === 'I' || tag === 'EM') {
      if (!s.fontStyle) s.fontStyle = 'italic';
    } else if (tag === 'A') {
      if (!s.color) s.color = '#0a66c2';
    }
    // max-width + margin:0 auto → centered block.
    if (s.marginLeft === 'auto' && s.marginRight === 'auto') s.alignSelf = 'center';

    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return null;
    if (s.position === 'fixed' && !txt(node)) return null;
    if (s.position === 'absolute' && !txt(node) && tag !== 'IMG') return null;

    if (tag === 'IMG') {
      var src = node.getAttribute('src') || '';
      if (src.indexOf('data:') !== 0) src = ''; // only inline images; remote fetch is unreliable
      return { type: 'img', props: { style: s, src: src, children: [] } };
    }

    var kids = [];
    var cn = node.childNodes;
    for (var i = 0; i < cn.length; i++) {
      var k = build(cn[i], depth + 1);
      if (k != null) kids.push(k);
    }

    var tl = tag.toLowerCase();
    if (tl === 'table' || tl === 'thead' || tl === 'tbody' || tl === 'tfoot') {
      s.display = 'flex'; s.flexDirection = 'column';
      if (tl === 'table' && !s.width) s.width = '100%';
    } else if (tl === 'tr') {
      s.display = 'flex'; s.flexDirection = 'row'; if (!s.width) s.width = '100%';
    } else if (tl === 'td' || tl === 'th') {
      s.display = 'flex'; s.flexDirection = 'column'; if (!s.flex && !s.width) s.flex = '1';
    } else if (tl === 'ul' || tl === 'ol') {
      s.display = 'flex'; s.flexDirection = 'column';
    } else if (tl === 'li') {
      if (!s.display || s.display === 'list-item') s.display = 'flex';
    }

    if (kids.length === 0 && !txt(node)) return null;

    // Inline-flow heuristic: a block whose element children are all inline /
    // inline-block (e.g. a row of chips/pills) should lay them out in a wrapping
    // row instead of stretching each to full width down a column.
    var elemKids = kids.filter(function (k) { return k && typeof k === 'object'; });
    if (elemKids.length >= 2 && elemKids.length === kids.length &&
        elemKids.every(function (k) {
          var d = k.props && k.props.style && k.props.style.display;
          return d === 'inline-block' || d === 'inline-flex' || d === 'inline';
        })) {
      s.display = 'flex'; s.flexDirection = 'row'; s.flexWrap = 'wrap';
      if (!s.gap) s.gap = '6px';
      if (!s.alignItems) s.alignItems = 'center';
    }

    return {
      type: mapType(tag),
      props: { style: s, children: kids.length === 1 ? kids[0] : kids },
    };
  }

  var root = document.body || document.documentElement;
  var tree = build(root, 0);
  if (tree && tree.props) {
    // Ensure the root carries body styling and lays out as a column.
    var bs = resolve(root);
    if (!tree.props.style) tree.props.style = {};
    for (var kk in bs) {
      if (tree.props.style[kk] === undefined) tree.props.style[kk] = bs[kk];
    }
    tree.props.style.display = 'flex';
    tree.props.style.flexDirection = 'column';
  }
  return tree;
})()
