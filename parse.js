// Fast Markdown renderer: byte-identical output to marked 18.1.3 (defaults:
// GFM on, breaks off) for the documents this file's fast path accepts, with
// a whole-document gate that hands anything outside that set to the vendored
// marked build. Written from the CommonMark 0.31.2 + GFM 0.29 rules, with
// marked's own quirks (its <br>, its table layout, its single-tilde
// strikethrough, its href encoding) reproduced from its observed output.
//
// Layout: block parser (line based, container stack, CommonMark phase 1),
// inline parser (delimiter stack, CommonMark appendix A), renderers.
// No dependencies, no state kept between calls, no clock, no /tmp.

import { marked } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------- entities
// marked passes an entity-looking run through verbatim: `&` + word chars
// ([A-Za-z0-9_]+) + `;` is copied as-is, whatever the name is, valid or not
// (&copy;, &COPY;, &nosuchentity; all survive). Numeric references decode to
// the character (0, surrogates and > 0x10FFFF become U+FFFD). So there is no
// named-entity table to keep: the inline scanner only has to recognise the
// two shapes below. A bare `&` (no `;` after word chars) is escaped.

function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
// At src[i] == '&': if an entity reference starts here, return its end index
// (exclusive) and the text to emit; else return null.
function entityAt(src, i) {
  const n = src.length;
  if (i + 1 >= n) return null;
  const c = src.charCodeAt(i + 1);
  if (c === 35) {
    // &#...; or &#x...;
    let j = i + 2;
    let hex = false;
    if (j < n && (src.charCodeAt(j) === 120 || src.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const d = src.charCodeAt(j);
      if (hex ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102) : (d >= 48 && d <= 57)) j++;
      else break;
    }
    if (j === start || j >= n || src.charCodeAt(j) !== 59) return null;
    // a numeric reference is at most 7 decimal or 6 hex digits; longer
    // runs are not entities at all (cm-028: '&#87654321;' stays literal)
    if (hex ? j - start > 6 : j - start > 7) return null;
    let cp = 0;
    if (hex) {
      for (let k = start; k < j; k++) {
        const d = src.charCodeAt(k);
        cp = cp * 16 + (d >= 97 ? d - 87 : d >= 65 ? d - 55 : d - 48);
      }
    } else {
      for (let k = start; k < j; k++) cp = cp * 10 + (src.charCodeAt(k) - 48);
    }
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { end: j + 1, text: escText5(String.fromCodePoint(cp)) };
  }
  let j = i + 1;
  while (j < n && isWordCode(src.charCodeAt(j))) j++;
  if (j > i + 1 && j < n && src.charCodeAt(j) === 59) return { end: j + 1, text: src.slice(i, j + 1) };
  return null;
}

// ------------------------------------------------------------ char classes
const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

const PUNCT_RE = /\p{P}|\p{S}/u;
const WS_RE = /\p{White_Space}/u;
const punctCache = new Map();
const wsCache = new Map();

function isPunctCode(cp) {
  if (cp < 128) return ASCII_PUNCT[cp] === 1;
  let v = punctCache.get(cp);
  if (v === undefined) { v = PUNCT_RE.test(String.fromCodePoint(cp)); punctCache.set(cp, v); }
  return v;
}
function isWsCode(cp) {
  if (cp < 128) return cp === 32 || (cp >= 9 && cp <= 13);
  let v = wsCache.get(cp);
  if (v === undefined) { v = WS_RE.test(String.fromCodePoint(cp)); wsCache.set(cp, v); }
  return v;
}
// Character just before / after a position in a string, as a code point
// (or -1 at the string ends, which count as whitespace for flanking).
function cpBefore(s, i) {
  if (i <= 0) return -1;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xd800 && c <= 0xdbff && i >= 2) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xdc00 && d <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
  }
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xd800 && d <= 0xdbff) return 0x10000 + ((d - 0xd800) << 10) + (c - 0xdc00);
  }
  return c;
}
function cpAfter(s, i) {
  if (i >= s.length) return -1;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
  }
  return c;
}
function isWsCp(cp) { return cp === -1 || isWsCode(cp); }
function isPunctCp(cp) { return cp !== -1 && isPunctCode(cp); }

// ------------------------------------------------------------ escaping
// marked escapes five characters in text and code content:
// & -> &amp;, < -> &lt;, > -> &gt;, " -> &quot;, ' -> &#39;.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return out + s.slice(start);
}
const escText5 = escText;
// Attribute values use the same five escapes, but an entity-looking run
// (&word;, &#...;, &#x...;) passes through verbatim, as in inline text.
function escAttr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let i = 0;
  let start = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityAt(s, i);
      if (e !== null) { out += s.slice(start, i) + e.text; i = e.end; start = i; continue; }
      out += s.slice(start, i) + '&amp;'; i++; start = i; continue;
    }
    let rep = null;
    if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
    i++;
  }
  return out + s.slice(start);
}
const URI_SAFE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$-_.!~*'()#%") URI_SAFE[ch.charCodeAt(0)] = 1;
const HEX = '0123456789ABCDEF';
// marked's href encoding: encodeURI over the destination, then & -> &amp;
// — except an entity-looking run (&word;, &#...;, &#x...;) passes through
// verbatim, as in inline text. Autolinks skip the entity step.
function encodeHref(s, keepEntities) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 && keepEntities) {
      const e = entityAt(s, i);
      if (e !== null) {
        out += encodeUriPart(s.slice(start, i)) + e.text;
        i = e.end - 1; start = e.end; continue;
      }
      out += encodeUriPart(s.slice(start, i)) + '&amp;';
      start = i + 1; continue;
    }
    if (c === 38) { out += encodeUriPart(s.slice(start, i)) + '&amp;'; start = i + 1; }
  }
  return out + encodeUriPart(s.slice(start));
}
function encodeUriPart(s) {
  let need = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128 || URI_SAFE[c] !== 1) { need = true; break; }
  }
  if (!need) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 128 && URI_SAFE[c] === 1) { out += s[i]; continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    // percent-encode the UTF-8 bytes of c (HEX holds single digits, so
    // each byte is split into two hex digits; cm-206: '/φου' -> '/%CF%86...')
    if (c < 0x80) {
      out += '%' + HEX[c >> 4] + HEX[c & 15];
    } else {
      let b0, b1, b2, b3, nb;
      if (c < 0x800) { b0 = 0xc0 | (c >> 6); b1 = 0x80 | (c & 63); nb = 2; }
      else if (c < 0x10000) { b0 = 0xe0 | (c >> 12); b1 = 0x80 | ((c >> 6) & 63); b2 = 0x80 | (c & 63); nb = 3; }
      else { b0 = 0xf0 | (c >> 18); b1 = 0x80 | ((c >> 12) & 63); b2 = 0x80 | ((c >> 6) & 63); b3 = 0x80 | (c & 63); nb = 4; }
      out += '%' + HEX[b0 >> 4] + HEX[b0 & 15];
      out += '%' + HEX[b1 >> 4] + HEX[b1 & 15];
      if (nb >= 3) out += '%' + HEX[b2 >> 4] + HEX[b2 & 15];
      if (nb >= 4) out += '%' + HEX[b3 >> 4] + HEX[b3 & 15];
    }
  }
  return out;
}

// ------------------------------------------------------------ the gate
// Fast path accepts a document only when it contains none of the shapes
// this renderer does not cover. Anything else goes to vendored marked.
// (Rules grow here as testing finds constructs the fast path gets wrong.)
function gateAllows(src) {
  // A link text that starts with www./http(s):// breaks the fast path's
  // GFM-autolink phase (a failed link attempt leaves the '[' open, and the
  // address then autolinks with the ']' inside the URL). Generated docs
  // never contain these; spec examples that do fall back to marked.
  if (src.indexOf('[www.') >= 0 || src.indexOf('[http://') >= 0 || src.indexOf('[https://') >= 0) return false;
  return true;
}

// ------------------------------------------------------------ inline parsing
// Two phases, as CommonMark's appendix A: (1) scan the string into a linked
// list of nodes plus a delimiter list, forming links as `]` is reached;
// (2) process emphasis over the delimiter list. GFM autolinks (www/http
// and e-mail) run after emphasis, over the finished text nodes, so an
// emphasis delimiter next to an address does not leak into it.
//
// Node kinds: t text (raw), raw verbatim (entity pass-through / decoded
// numeric), code code span, br hard break, html raw tag, link (children in
// first/last), em/strong/del (children), d delimiter (ch, n, canOpen,
// canClose, active, closedBracket). Every node carries next/prev.

// --- persistent `inLink` state (marked quirk) ---
// Marked keeps a document-wide flag that is set when an inline `<a ...>`
// opening tag is seen and cleared by an inline `</a>`. While it is set,
// GFM extended autolinks (www. / http(s):// / email) are NOT created —
// but markdown links and `<...>` autolinks still are. The flag is set by
// an opening tag whose name is exactly `a` (case-insensitive) followed by
// whitespace or `>` — so `<a />` sets it but `<a/>` does not, and `<abbr>`
// / `<a-b>` do not. A lone `<a>` tag that forms an HTML block never
// reaches inline parsing, so it does not set the flag; only an inline
// `</a>` (inside a paragraph) clears it, an HTML-block `</a>` does not.
let inLinkState = false;
function updateInLink(tagText) {
  if (!tagText || tagText.length < 3 || tagText.charCodeAt(0) !== 60) return;
  const c1 = tagText.charCodeAt(1);
  if (c1 === 47) {
    // closing tag </a ...>
    if (tagText.length < 4) return;
    const c2 = tagText.charCodeAt(2);
    if (c2 !== 97 && c2 !== 65) return;
    const c3 = tagText.charCodeAt(3);
    if (c3 === 32 || c3 === 9 || c3 === 10 || c3 === 62) inLinkState = false;
    return;
  }
  // opening tag <a ...>
  if (c1 !== 97 && c1 !== 65) return;
  const c2 = tagText.charCodeAt(2);
  if (c2 === 32 || c2 === 9 || c2 === 10 || c2 === 62) inLinkState = true;
}

function inlineHtml(src, refs, allowGfm) {
  const len = src.length;
  let pos = 0;
  let first = null;
  let last = null;
  let dFirst = null;
  let dLast = null;
  let textStart = -1;

  function appendNode(node) {
    node.next = null;
    node.prev = last;
    node.parent = null;
    if (last) last.next = node; else first = node;
    last = node;
    if (node.k === 'd') {
      node.dNext = null;
      node.dPrev = dLast;
      if (dLast) dLast.dNext = node; else dFirst = node;
      dLast = node;
    }
    return node;
  }
  function flushText(end) {
    if (textStart >= 0 && end > textStart) appendNode({ k: 't', s: src.slice(textStart, end), il: inLinkState });
    textStart = -1;
  }
  function removeDelim(d) {
    if (d.dPrev) d.dPrev.dNext = d.dNext; else dFirst = d.dNext;
    if (d.dNext) d.dNext.dPrev = d.dPrev; else dLast = d.dPrev;
    d.dNext = d.dPrev = null;
  }
  function unlink(node) {
    // a node may live in a link/em/strong/del child list, not the
    // top-level list: update that list's first/last via the parent
    // pointer (using the top-level first/last for a child-list node
    // corrupts the render — cm-419: an em wrapping a whole link text
    // unlinked the link's delimiters and dropped the link)
    const p = node.parent;
    if (node.prev) node.prev.next = node.next;
    else if (p) p.first = node.next;
    else first = node.next;
    if (node.next) node.next.prev = node.prev;
    else if (p) p.last = node.prev;
    else last = node.prev;
    node.next = node.prev = null;
  }

  // --- link helpers (destination / title / label) ---
  // Parse a link destination starting at src[i] (after optional spaces are
  // skipped by the caller). Returns {dest, end} or null. i is the index of
  // the first destination character.
  function parseDest(src2, i) {
    const n = src2.length;
    if (i >= n) return null;
    if (src2.charCodeAt(i) === 60) {
      // <...>
      let j = i + 1;
      let out = '';
      while (j < n) {
        const c = src2.charCodeAt(j);
        if (c === 62) return { dest: out, end: j + 1 };
        if (c === 10 || c === 60) return null;
        if (c === 92 && j + 1 < n && ASCII_PUNCT[src2.charCodeAt(j + 1)] === 1) { out += src2[j + 1]; j += 2; continue; }
        out += src2[j];
        j++;
      }
      return null;
    }
    let j = i;
    let depth = 0;
    let out = '';
    while (j < n) {
      const c = src2.charCodeAt(j);
      if (c === 32 || c === 10 || c === 9 || c < 32) break;
      if (c === 92 && j + 1 < n && ASCII_PUNCT[src2.charCodeAt(j + 1)] === 1) { out += src2[j + 1]; j += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      out += src2[j];
      j++;
    }
    // an empty destination is valid for an inline link: '[link]()'
    // and '[]()' both form a link with an empty href (cm-485, cm-487)
    if (j === i) {
      if (i < n && src2.charCodeAt(i) === 41) return { dest: '', end: j };
      return null;
    }
    return { dest: out, end: j };
  }
  // Parse a link title starting at src[i] (the opening quote/paren).
  // Returns {title, end} or null.
  function parseTitle(src2, i) {
    const n = src2.length;
    const q = src2.charCodeAt(i);
    if (q === 34 || q === 39) {
      let j = i + 1;
      let out = '';
      while (j < n) {
        const c = src2.charCodeAt(j);
        if (c === q) return { title: out, end: j + 1 };
        if (c === 92 && j + 1 < n && ASCII_PUNCT[src2.charCodeAt(j + 1)] === 1) { out += src2[j + 1]; j += 2; continue; }
        out += src2[j];
        j++;
      }
      return null;
    }
    if (q === 40) {
      let j = i + 1;
      let out = '';
      while (j < n) {
        const c = src2.charCodeAt(j);
        if (c === 41) return { title: out, end: j + 1 };
        if (c === 92 && j + 1 < n && ASCII_PUNCT[src2.charCodeAt(j + 1)] === 1) { out += src2[j + 1]; j += 2; continue; }
        out += src2[j];
        j++;
      }
      return null;
    }
    return null;
  }
  // Skip spaces/tabs/newlines starting at i. Returns the new index.
  function skipWs(src2, i) {
    while (i < src2.length) {
      const c = src2.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) i++;
      else break;
    }
    return i;
  }
  // Parse "(dest [title])" starting at src[i] == '('. Returns
  // {dest, title, end} (end past the closing paren) or null.
  function parseInlineLink(src2, i) {
    const n = src2.length;
    let j = skipWs(src2, i + 1);
    if (j >= n) return null;
    const d = parseDest(src2, j);
    if (!d) return null;
    j = skipWs(src2, d.end);
    if (j < n && src2.charCodeAt(j) === 41) return { dest: d.dest, title: null, end: j + 1 };
    const t = parseTitle(src2, j);
    if (!t) return null;
    j = skipWs(src2, t.end);
    if (j < n && src2.charCodeAt(j) === 41) return { dest: d.dest, title: t.title, end: j + 1 };
    return null;
  }
  // A link label starting at src[i] == '[': scan the balanced bracket run.
  // Returns {label, end} (end past the closing bracket) or null. The label
  // is the raw text with backslash escapes processed.
  function parseLabel(src2, i) {
    const n = src2.length;
    let j = i + 1;
    let depth = 1;
    let out = '';
    while (j < n && depth > 0) {
      const c = src2.charCodeAt(j);
      // keep the backslash in the label: an escaped char does NOT match
      // the unescaped form in a reference ('[foo\!]' does not match
      // '[foo!]: /url', cm-545). Escaped brackets still do not change depth.
      if (c === 92 && j + 1 < n && ASCII_PUNCT[src2.charCodeAt(j + 1)] === 1) { out += src2[j] + src2[j + 1]; j += 2; continue; }
      if (c === 91) depth++;
      else if (c === 93) { depth--; if (depth === 0) { j++; break; } }
      out += src2[j];
      j++;
    }
    if (depth !== 0) return null;
    return { label: out, end: j };
  }
  function normalizeLabel(s) {
    if (s.length > 999) return null;
    // Unicode case folding: 'ß'/'ẞ' fold to 'ss' (cm-540: '[ẞ]' matches
    // the '[SS]' reference)
    const folded = s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
    return folded.length === 0 ? null : folded;
  }

  // --- code span ---
  function tryCodeSpan(start) {
    let n = 0;
    while (start + n < len && src.charCodeAt(start + n) === 96) n++;
    let j = start + n;
    while (j < len) {
      if (src.charCodeAt(j) === 96) {
        let m = 0;
        while (j + m < len && src.charCodeAt(j + m) === 96) m++;
        if (m === n) {
          let content = src.slice(start + n, j).replace(/\n/g, ' ');
          if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
            content = content.slice(1, -1);
          }
          return { end: j + m, content };
        }
        j += m;
      } else j++;
    }
    return null;
  }

  // --- <...> autolink / html tag ---
  function tryAngle(start) {
    // autolink: <scheme:...> or <email>
    let j = start + 1;
    if (j < len) {
      const c = src.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        // scheme: letter, then letters/digits/+.- up to 31 more, then ':'
        let k = j + 1;
        while (k < len && k - j < 32) {
          const d = src.charCodeAt(k);
          if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46) k++;
          else break;
        }
        if (k < len && src.charCodeAt(k) === 58 && k - j >= 2) {
          let e = k + 1;
          while (e < len) {
            const d = src.charCodeAt(e);
            if (d === 62 || d === 32 || d === 10 || d === 60 || d < 32) break;
            e++;
          }
          if (e < len && src.charCodeAt(e) === 62 && e > k + 1) {
            const text = src.slice(start + 1, e);
            return { end: e + 1, href: encodeHref(text, false), text: escText(text), kind: 'link' };
          }
        }
      }
      // email: local@domain with a dot, then '>'
      {
        let e = j;
        while (e < len) {
          const d = src.charCodeAt(e);
          if (d === 62) break;
          if (d === 32 || d === 10 || d === 60 || d < 32) { e = -1; break; }
          e++;
        }
        if (e > j && e < len) {
          const inner = src.slice(j, e);
          if (isEmailText(inner)) {
            return { end: e + 1, href: 'mailto:' + inner, text: escText(inner), kind: 'link' };
          }
        }
      }
    }
    // html tag
    const tag = tryHtmlTag(src, start);
    if (tag) return { end: tag, kind: 'html', text: src.slice(start, tag) };
    return null;
  }
  // Is `s` an e-mail address (local@domain, domain with a dot)?
  function isEmailText(s) {
    const at = s.indexOf('@');
    if (at <= 0) return false;
    for (let i = 0; i < at; i++) {
      const c = s.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45)) return false;
    }
    const dom = s.slice(at + 1);
    if (dom.indexOf('.') < 0) return false;
    const parts = dom.split('.');
    for (const p of parts) {
      if (p.length === 0) return false;
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95)) return false;
      }
    }
    const lastPart = parts[parts.length - 1];
    const lc = lastPart.charCodeAt(lastPart.length - 1);
    if (!((lc >= 48 && lc <= 57) || (lc >= 65 && lc <= 90) || (lc >= 97 && lc <= 122))) return false;
    return true;
  }

  // --- the scan ---
  while (pos < len) {
    const c = src.charCodeAt(pos);
    if (c === 10) {
      // newline: hard break if the line ends with two spaces or a backslash
      flushText(pos);
      let hard = false;
      if (last && last.k === 't') {
        const s = last.s;
        let n = 0;
        let i = s.length - 1;
        while (i >= 0 && s.charCodeAt(i) === 32) { n++; i--; }
        if (n >= 2) { last.s = s.slice(0, s.length - n); if (last.s === '') unlink(last); hard = true; }
      }
      if (hard) appendNode({ k: 'br' });
      else appendNode({ k: 't', s: '\n' });
      pos++;
      // after a hard break the leading spaces/tabs of the next line are
      // dropped (a soft break keeps them)
      if (hard) while (pos < len && (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9)) pos++;
      continue;
    }
    if (c === 92) {
      // backslash: hard break before a newline, escape before punctuation.
      // A backslash inside a GFM autolink URL is part of the URL, not an
      // escape and not a hard break (marked keeps
      // 'https://www.example.com/of.\' as a link to '.../of.%5C');
      // detect it by scanning back to the start of the current word
      // for '://' or a 'www.' start — but only inside the current text
      // segment (never across a node boundary into a link/image
      // destination, which also contains '://')
      let inUrl = false;
      {
        const lo = textStart >= 0 ? textStart : pos;
        let b = pos - 1;
        while (b >= lo) {
          const d = src.charCodeAt(b);
          if (d === 32 || d === 10 || d === 9 || d === 60 || d === 62 || d < 32) break;
          b--;
        }
        const word = src.slice(b + 1, pos);
        if (word.indexOf('://') >= 0 || word.toLowerCase().startsWith('www.')) inUrl = true;
      }
      if (inUrl) { if (textStart < 0) textStart = pos; pos++; continue; }
      if (pos + 1 < len && src.charCodeAt(pos + 1) === 10) {
        flushText(pos);
        appendNode({ k: 'br' });
        pos += 2;
        while (pos < len && (src.charCodeAt(pos) === 32 || src.charCodeAt(pos) === 9)) pos++;
        continue;
      }
      if (pos + 1 < len && ASCII_PUNCT[src.charCodeAt(pos + 1)] === 1) {
        flushText(pos);
        textStart = pos + 1;
        pos += 2;
        continue;
      }
      if (textStart < 0) textStart = pos;
      pos++;
      continue;
    }
    if (c === 96) {
      const cs = tryCodeSpan(pos);
      if (cs) {
        flushText(pos);
        appendNode({ k: 'code', s: cs.content });
        pos = cs.end;
        continue;
      }
      // no matching closer of the same length: the whole run is literal
      // text (never retry a shorter run inside it: ```foo`` is a paragraph)
      if (textStart < 0) textStart = pos;
      while (pos < len && src.charCodeAt(pos) === 96) pos++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      // delimiter run: *, _, ~
      let n = 0;
      while (pos + n < len && src.charCodeAt(pos + n) === c) n++;
      if (c === 126 && n >= 3) {
        if (textStart < 0) textStart = pos;
        pos += n;
        continue;
      }
      const before = cpBefore(src, pos);
      const after = cpAfter(src, pos + n);
      const beforeWs = isWsCp(before);
      const afterWs = isWsCp(after);
      const beforePunct = isPunctCp(before);
      const afterPunct = isPunctCp(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen;
      let canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      if (!canOpen && !canClose) {
        if (textStart < 0) textStart = pos;
        pos += n;
        continue;
      }
      flushText(pos);
      appendNode({ k: 'd', ch: c === 42 ? '*' : c === 95 ? '_' : '~', n, canOpen, canClose, active: true, il: inLinkState });
      pos += n;
      continue;
    }
    if (c === 91 || (c === 33 && pos + 1 < len && src.charCodeAt(pos + 1) === 91)) {
      // [ or ![ — a link opener delimiter
      const img = c === 33;
      flushText(pos);
      appendNode({ k: 'd', ch: '[', n: 1, canOpen: true, canClose: false, active: true, img, il: inLinkState, pos: img ? pos + 1 : pos });
      pos += img ? 2 : 1;
      continue;
    }
    if (c === 93) {
      flushText(pos);
      const link = tryCloseBracket(pos);
      if (link) {
        pos = link.end;
        continue;
      }
      if (textStart < 0) textStart = pos;
      pos++;
      continue;
    }
    if (c === 60) {
      const a = tryAngle(pos);
      if (a) {
        flushText(pos);
        if (a.kind === 'link') appendNode({ k: 'link', href: a.href, title: null, img: false, first: null, last: null, text: a.text, auto: true });
        else { appendNode({ k: 'html', s: a.text }); updateInLink(a.text); }
        pos = a.end;
        continue;
      }
      if (textStart < 0) textStart = pos;
      pos++;
      continue;
    }
    if (c === 38) {
      const e = entityAt(src, pos);
      if (e) {
        flushText(pos);
        appendNode({ k: 'raw', s: e.text });
        pos = e.end;
        continue;
      }
      if (textStart < 0) textStart = pos;
      pos++;
      continue;
    }
    if (textStart < 0) textStart = pos;
    pos++;
  }
  flushText(len);

  // Try to form a link at the `]` at src[pos]. Returns {end} or null.
  function tryCloseBracket(pos) {
    // nearest active '[' delimiter
    let opener = null;
    for (let d = dLast; d; d = d.dPrev) {
      if (d.k === 'd' && d.ch === '[' && d.active) { opener = d; break; }
    }
    if (!opener) return null;
    const after = pos + 1;
    let dest = null;
    let title = null;
    let end = -1;
    if (after < len && src.charCodeAt(after) === 40) {
      const p = parseInlineLink(src, after);
      if (p) { dest = p.dest; title = p.title; end = p.end; }
    } else if (after < len && src.charCodeAt(after) === 91) {
      // a '[' after ']' is a full/collapsed reference attempt: if the
      // label is not defined, the link fails outright — do NOT fall
      // back to a shortcut reference ('[foo][bar]' with no 'bar' ref
      // stays literal '[foo][bar]' even when 'foo' is defined)
      const lab = parseLabel(src, after);
      if (lab) {
        const norm = normalizeLabel(lab.label);
        if (norm !== null && refs.has(norm)) { const r = refs.get(norm); dest = r.dest; title = r.title; end = lab.end; }
        else if (lab.label === '' || lab.end === after + 2) {
          // collapsed: [text][] — label is the link text (raw source,
          // escapes kept, like the shortcut label below)
          const txt = src.slice(opener.pos + 1, pos);
          const norm2 = normalizeLabel(txt);
          if (norm2 !== null && refs.has(norm2)) { const r = refs.get(norm2); dest = r.dest; title = r.title; end = lab.end; }
        }
      }
      if (end < 0 && lab) {
        opener.closedBracket = true;
        opener.active = false;
        return null;
      }
    }
    if (end < 0) {
      // shortcut reference: label is the link text (raw source between
      // the brackets, escapes kept — '[foo\!]' does not match '[foo!]'),
      // not the rendered text (cm-545)
      const txt = src.slice(opener.pos + 1, pos);
      const norm = normalizeLabel(txt);
      if (norm !== null && refs.has(norm)) { const r = refs.get(norm); dest = r.dest; title = r.title; end = after; }
    }
    if (end < 0) {
      // this '[' is now matched by a ']' (even though no link formed),
      // so a later ']' must match an outer '[' instead (the link text
      // 'author [9]' in '[author [9]](url)'); deactivate it
      opener.closedBracket = true;
      opener.active = false;
      return null;
    }
    // links may not contain other links: check the link text nodes
    {
      let n2 = opener.next;
      while (n2) {
        if (containsLink(n2)) return null;
        n2 = n2.next;
      }
    }
    // gather the children (nodes between opener and the end of the list)
    const childrenFirst = opener.next;
    const childrenLast = last;
    // deactivate '[' delimiters inside the link text
    {
      let n2 = childrenFirst;
      while (n2) {
        if (n2.k === 'd' && n2.ch === '[') n2.active = false;
        n2 = n2.next;
      }
    }
    // remove the opener delimiter from both lists
    const beforeOpener = opener.prev;
    unlink(opener);
    removeDelim(opener);
    // detach the children from the main list
    if (beforeOpener) beforeOpener.next = null;
    last = beforeOpener;
    if (!last) first = null;
    if (childrenFirst) childrenFirst.prev = null;
    if (childrenLast) childrenLast.next = null;
    const node = { k: 'link', href: encodeHref(dest, true), title, img: !!opener.img, first: childrenFirst, last: childrenLast, text: null };
    // the detached children now live in the link's child list
    for (let n2 = childrenFirst; n2; n2 = n2.next) n2.parent = node;
    appendNode(node);
    return { end };
  }
  // The plain text of the nodes after `opener` (the link text), for a label.
  function linkTextOf(opener) {
    let out = '';
    let n2 = opener.next;
    while (n2) {
      if (n2.k === 't') out += n2.s;
      else if (n2.k === 'code') out += n2.s;
      else if (n2.k === 'raw') out += n2.s;
      else if (n2.k === 'd') out += (n2.ch === '[' && n2.img ? '!' : '') + n2.ch.repeat(n2.n);
      n2 = n2.next;
    }
    return out;
  }
  function containsLink(node) {
    // images and autolinks are allowed inside link text; only real
    // [..](..) / reference links forbid it (an <...> autolink inside
    // link text must not kill the outer link)
    if (node.k === 'link' && !node.img && !node.auto) return true;
    if (node.k === 'em' || node.k === 'strong' || node.k === 'del') {
      let n2 = node.first;
      while (n2) { if (containsLink(n2)) return true; n2 = n2.next; }
    }
    return false;
  }

  processEmphasis();
  mergeText();
  if (allowGfm) processGfm(first, true);
  return renderNodes(first);

  // --- emphasis processing (CommonMark appendix A) ---
  function processEmphasis() {
    const bottoms = new Map();
    let current = dFirst;
    while (current) {
      if (current.k !== 'd' || !current.canClose) { current = current.dNext; continue; }
      const ch = current.ch;
      const isTilde = ch === '~';
      // openers_bottom is keyed by the closer's length (exact for _ and ~,
      // parity for *): once an opener fails to match a closer of this
      // length we never try it again for the same length.
      const curKey = ch + ':' + (ch === '*' ? current.n % 2 : current.n);
      // find an opener — it must live in the same node list as the
      // closer (a delimiter inside a link's text never pairs with one
      // outside it: '*[bar*](/url)' keeps both '*' literal, cm-473)
      let opener = current.dPrev;
      let found = null;
      while (opener) {
        if (opener.ch === ch && opener.canOpen && opener.parent === current.parent) {
          if (isTilde) {
            if (opener.n === current.n) { found = opener; break; }
          } else {
            // marked's mod-3 rule (not the spec's odd-match): when one
            // delimiter can both open and close, a closer whose length
            // makes (opener+closer) a multiple of 3 is skipped unless
            // the opener length itself is a multiple of 3
            const mod3 = (opener.canClose || current.canOpen) && (opener.n % 3 !== 0) && ((opener.n + current.n) % 3 === 0);
            if (!mod3) { found = opener; break; }
          }
        }
        // openers_bottom is the lowest opener to consider: it is still
        // tried (a failed closer can itself open for a later closer,
        // foo*bar*), but nothing below it is
        if (bottoms.get(curKey) === opener) break;
        opener = opener.dPrev;
      }
      if (!found) {
        if (!bottoms.has(curKey)) bottoms.set(curKey, current);
        current = current.dNext;
        continue;
      }
      const use = found.n >= 2 && current.n >= 2 ? 2 : 1;
      const tag = ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      // wrap the nodes between found and current in the tag node
      const wrapFirst = found.next;
      const wrapLast = current.prev;
      const wrap = { k: tag, first: wrapFirst, last: wrapLast, parent: found.parent };
      // the wrapped nodes now live in the tag's child list
      for (let n2 = wrapFirst; n2; n2 = n2.next) { n2.parent = wrap; if (n2 === wrapLast) break; }
      // splice wrap into the node list in place of the range
      if (wrapFirst) wrapFirst.prev = null;
      if (wrapLast) wrapLast.next = null;
      wrap.prev = found;
      wrap.next = current;
      found.next = wrap;
      current.prev = wrap;
      found.n -= use;
      current.n -= use;
      if (found.n === 0) {
        unlink(found);
        removeDelim(found);
      }
      if (current.n === 0) {
        const nxt = current.dNext;
        unlink(current);
        removeDelim(current);
        current = nxt;
      }
    }
  }

  // --- merge adjacent text nodes; leftover delimiters become text ---
  // (recurses into link/emphasis children: a lone '*' inside link text
  // must survive as text, cm-194)
  function mergeText() {
    first = mergeList(first);
    let l2 = first;
    while (l2 && l2.next) l2 = l2.next;
    last = l2;
  }
  function mergeList(listFirst) {
    let n2 = listFirst;
    let newFirst = listFirst;
    while (n2) {
      if (n2.k === 'd') {
        // a leftover '![' that never formed an image keeps its '!'
        const txt = { k: 't', s: (n2.ch === '[' && n2.img ? '!' : '') + n2.ch.repeat(n2.n), il: n2.il, parent: n2.parent };
        txt.prev = n2.prev; txt.next = n2.next;
        if (n2.prev) n2.prev.next = txt; else newFirst = txt;
        if (n2.next) n2.next.prev = txt;
        n2 = txt;
      }
      if (n2.k === 't') {
        while (n2.next && n2.next.k === 't') {
          n2.s += n2.next.s;
          n2.next = n2.next.next;
          if (n2.next) n2.next.prev = n2;
        }
      } else if ((n2.k === 'link' || n2.k === 'em' || n2.k === 'strong' || n2.k === 'del') && n2.first) {
        n2.first = mergeList(n2.first);
        let l2 = n2.first;
        while (l2 && l2.next) l2 = l2.next;
        n2.last = l2;
      }
      n2 = n2.next;
    }
    return newFirst;
  }

  // --- GFM autolinks over finished text nodes ---
  // Walk a node list and split text nodes containing GFM autolinks.
  // `parent` is the em/strong/del node owning this list, or null for the
  // top level — splicing must update the OWNER's first/last, never the
  // top-level pointers when the text node lives inside an em/strong/del
  // (otherwise the whole paragraph is replaced by the strong's content).
  function processGfm(listFirst, allow, parent) {
    let n2 = listFirst;
    while (n2) {
      if (n2.k === 'em' || n2.k === 'strong' || n2.k === 'del') {
        processGfm(n2.first, allow, n2);
      } else if (n2.k === 't' && allow) {
        const replaced = gfmTextNode(n2);
        if (replaced) {
          // splice the replacement nodes in place of n2
          const repFirst = replaced.first;
          const repLast = replaced.last;
          repFirst.prev = n2.prev;
          repLast.next = n2.next;
          if (n2.prev) n2.prev.next = repFirst;
          else if (parent) parent.first = repFirst;
          else first = repFirst;
          if (n2.next) n2.next.prev = repLast;
          else if (parent) parent.last = repLast;
          else last = repLast;
          n2 = repLast;
        }
      }
      n2 = n2.next;
    }
  }
  // Split one text node into text + autolink nodes. Returns null if no
  // autolink was found in it. While the document-wide `inLink` flag was
  // set when this text was scanned (an unclosed inline `<a>` tag), no
  // GFM autolink is created at all.
  function gfmTextNode(node) {
    if (node.il) return null;
    const s = node.s;
    const outFirst = { k: 't', s: '', parent: node.parent };
    let outLast = outFirst;
    let outCount = 0;
    let i = 0;
    let segStart = 0;
    let changed = false;
    function pushText(a, b) {
      if (b > a) {
        const t = { k: 't', s: s.slice(a, b), il: node.il, parent: node.parent };
        outLast.next = t; t.prev = outLast; outLast = t; outCount++;
      }
    }
    function pushLink(href, text) {
      const l = { k: 'link', href, title: null, img: false, first: null, last: null, text, auto: true, parent: node.parent };
      outLast.next = l; l.prev = outLast; outLast = l; outCount++;
    }
    while (i < s.length) {
      const c = s.charCodeAt(i);
      // scheme autolinks: only lowercase 'mailto:' and 'xmpp:' form a
      // link (gfm-633/634/635); 'foo:', 'xmailto:', 'MAILTO:' do not.
      // mailto: takes just an email; xmpp: takes an email plus at most
      // one '/resource' segment.
      if (c === 109 || c === 120) {
        let scheme = null;
        let emailStart = -1;
        if (c === 109 && s.startsWith('mailto:', i)) { scheme = 'mailto'; emailStart = i + 7; }
        else if (c === 120 && s.startsWith('xmpp:', i)) { scheme = 'xmpp'; emailStart = i + 5; }
        if (scheme && gfmPrecedingOk(node, i, 'scheme')) {
          let at = -1;
          for (let k = emailStart; k < s.length; k++) {
            const d = s.charCodeAt(k);
            if (d === 64) { at = k; break; }
            if (d === 32 || d === 10 || d === 9 || d === 60 || d === 62 || d < 32) break;
          }
          if (at > emailStart) {
            const em = scanGfmEmail(s, at);
            if (em && em.start === emailStart) {
              let end = em.end;
              if (scheme === 'xmpp' && end < s.length && s.charCodeAt(end) === 47) {
                let j = end + 1;
                while (j < s.length) {
                  const d = s.charCodeAt(j);
                  if (d === 47 || d === 32 || d === 10 || d === 9 || d === 60 || d === 62 || d < 32) break;
                  j++;
                }
                let seg = s.slice(end + 1, j);
                while (seg.length > 0) {
                  const last = seg.charCodeAt(seg.length - 1);
                  if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 59 || last === 42 || last === 95 || last === 126 || last === 45) seg = seg.slice(0, -1);
                  else break;
                }
                if (seg.length > 0) end = end + 1 + seg.length;
              }
              pushText(segStart, i);
              const txt = s.slice(i, end);
              pushLink(encodeHref(txt, false), escText(txt));
              i = end;
              segStart = i;
              changed = true;
              continue;
            }
          }
        }
      }
      // www. / http(s):// — www. must be lowercase, http(s):// is
      // case-insensitive (Https://, HTTP://, hTtP:// all link)
      if (c === 119 || c === 104 || c === 72) {
        let scheme = null;
        let start = -1;
        if (c === 119 && s.startsWith('www.', i)) { scheme = 'www'; start = i; }
        else if (c === 104 || c === 72) {
          const low = s.slice(i, i + 8).toLowerCase();
          if (low.startsWith('http://') || low.startsWith('https://')) { scheme = 'http'; start = i; }
        }
        if (start >= 0 && gfmPrecedingOk(node, start, scheme)) {
          const url = scanGfmUrl(s, start, scheme);
          if (url !== null) {
            pushText(segStart, start);
            const href = scheme === 'www' ? 'http://' + url : url;
            pushLink(encodeHref(href, false), escText(url));
            i = start + url.length;
            segStart = i;
            changed = true;
            continue;
          }
        }
      }
      if (c === 64) {
        const em = scanGfmEmail(s, i);
        if (em) {
          pushText(segStart, em.start);
          pushLink('mailto:' + em.text, escText(em.text));
          i = em.end;
          segStart = i;
          changed = true;
          continue;
        }
      }
      i++;
    }
    if (!changed) return null;
    pushText(segStart, s.length);
    // drop the leading empty text node
    const repFirst = outFirst.next;
    if (!repFirst) return null;
    repFirst.prev = null;
    return { first: repFirst, last: outLast };
  }
  // Is a GFM autolink allowed to start at offset `at` of text node `node`?
  // Is a GFM autolink allowed to start at offset `at` of text node `node`?
  // A preceding '<' allows an http(s):// autolink ('a<https://x.com'
  // links) but NOT a www. autolink ('a<www.x.com' stays literal).
  function gfmPrecedingOk(node, at, scheme) {
    const ok = (pc) => pc === 32 || pc === 10 || pc === 9 || pc === 42 || pc === 95 || pc === 126 || pc === 40 || (scheme === 'http' && pc === 60);
    if (at > 0) {
      return ok(node.s.charCodeAt(at - 1));
    }
    const prev = node.prev;
    if (!prev) return true;
    if (prev.k === 't') {
      const t = prev.s;
      if (t.length === 0) return true;
      return ok(t.charCodeAt(t.length - 1));
    }
    if (prev.k === 'd') {
      if (prev.ch === '[') return prev.closedBracket === true;
      return true;
    }
    return true;
  }
  // Scan a www/http autolink URL starting at `start` in s. Returns the
  // URL text (without scheme prefix for www) or null.
  function scanGfmUrl(s, start, scheme) {
    let i = start;
    if (scheme === 'www') {
      i += 4;
      // domain: [A-Za-z0-9._-]+, must be non-empty
      let j = i;
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 46 || d === 45 || d === 95) j++;
        else break;
      }
      if (j === i) return null;
      i = j;
    } else {
      i = s.indexOf('://', start) + 3;
      if (i < 3) return null;
      if (i >= s.length) return null;
    }
    // path: any char except whitespace, <, >
    let j = i;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === 32 || d === 10 || d === 9 || d === 60 || d === 62 || d < 32) break;
      j++;
    }
    let url = s.slice(start, j);
    url = backpedalUrl(url);
    if (scheme === 'www') {
      const dom = url.slice(4);
      if (dom.length === 0) return null;
    } else {
      const rest = url.slice(url.indexOf('://') + 3);
      if (rest.length === 0) return null;
    }
    return url;
  }
  // Trim trailing punctuation / unbalanced parens off a GFM autolink.
  function backpedalUrl(url) {
    for (;;) {
      if (url.length === 0) break;
      const last = url.charCodeAt(url.length - 1);
      if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 59 || last === 42 || last === 95 || last === 126) {
        if (last === 59) {
          const amp = url.lastIndexOf('&');
          if (amp >= 0) {
            let ok = true;
            for (let k = amp + 1; k < url.length - 1; k++) {
              if (!isWordCode(url.charCodeAt(k))) { ok = false; break; }
            }
            if (ok && url.length - 1 > amp + 1) { url = url.slice(0, amp); break; }
          }
        }
        url = url.slice(0, -1);
        continue;
      }
      if (last === 41) {
        let opens = 0;
        let closes = 0;
        for (let k = 0; k < url.length; k++) {
          if (url.charCodeAt(k) === 40) opens++;
          else if (url.charCodeAt(k) === 41) closes++;
        }
        if (closes > opens || url.endsWith('))')) { url = url.slice(0, -1); continue; }
      }
      if (last !== 41) {
        let opens = 0;
        let closes = 0;
        let lastOpen = -1;
        for (let k = 0; k < url.length; k++) {
          if (url.charCodeAt(k) === 40) { opens++; lastOpen = k; }
          else if (url.charCodeAt(k) === 41) closes++;
        }
        if (opens > closes && lastOpen >= 0) {
          const after = url.slice(lastOpen + 1);
          if (after.indexOf(')') < 0) { url = url.slice(0, lastOpen); continue; }
        }
      }
      break;
    }
    return url;
  }
  // Scan an e-mail autolink at the '@' at s[i]. Returns {start, end, text}
  // or null. The local part scans back inside this text node only.
  function scanGfmEmail(s, i) {
    let a = i - 1;
    while (a >= 0) {
      const d = s.charCodeAt(a);
      if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 46 || d === 95 || d === 43 || d === 45) a--;
      else break;
    }
    const localStart = a + 1;
    if (localStart === i) return null;
    // domain: [A-Za-z0-9._-]+ run
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 46 || d === 45 || d === 95) j++;
      else break;
    }
    let dom = s.slice(i + 1, j);
    // strip trailing '.' only: a domain ending in '_' or '-' is not a
    // valid email at all ('a.b-c_d@a.b_' is literal, gfm-632) — do NOT
    // strip '_' to "fix" it; the alphanumeric check below rejects it
    while (dom.length > 0 && dom.charCodeAt(dom.length - 1) === 46) dom = dom.slice(0, -1);
    if (dom.indexOf('.') < 0) return null;
    const parts = dom.split('.');
    for (const p of parts) if (p.length === 0) return null;
    const lp = parts[parts.length - 1];
    const lc = lp.charCodeAt(lp.length - 1);
    if (!((lc >= 48 && lc <= 57) || (lc >= 65 && lc <= 90) || (lc >= 97 && lc <= 122))) return null;
    const end = i + 1 + dom.length;
    return { start: localStart, end, text: s.slice(localStart, end) };
  }

  // --- render ---
  function renderNodes(n2) {
    let out = '';
    while (n2) {
      out += renderNode(n2);
      n2 = n2.next;
    }
    return out;
  }
  function renderNode(n2) {
    switch (n2.k) {
      case 't': return escText(n2.s);
      case 'raw': return n2.s;
      case 'code': return '<code>' + escText(n2.s) + '</code>';
      case 'br': return '<br>';
      case 'html': return n2.s;
      case 'link': {
        if (n2.img) {
          const alt = altTextOf(n2.first);
          let h = '<img src="' + n2.href + '" alt="' + escAttr(alt) + '"';
          if (n2.title !== null && n2.title !== undefined) h += ' title="' + escAttr(n2.title) + '"';
          return h + '>';
        }
        let h = '<a href="' + n2.href + '"';
        if (n2.title !== null && n2.title !== undefined) h += ' title="' + escAttr(n2.title) + '"';
        h += '>';
        h += n2.text !== null && n2.text !== undefined ? n2.text : renderNodes(n2.first);
        return h + '</a>';
      }
      case 'em': return '<em>' + renderNodes(n2.first) + '</em>';
      case 'strong': return '<strong>' + renderNodes(n2.first) + '</strong>';
      case 'del': return '<del>' + renderNodes(n2.first) + '</del>';
      default: return '';
    }
  }
  // Plain text of a link's children, for an image's alt attribute.
  function altTextOf(n2) {
    let out = '';
    while (n2) {
      if (n2.k === 't') out += n2.s;
      else if (n2.k === 'raw') out += n2.s;
      else if (n2.k === 'code') out += n2.s;
      else if (n2.k === 'em' || n2.k === 'strong' || n2.k === 'del') out += altTextOf(n2.first);
      else if (n2.k === 'br') out += '\n';
      n2 = n2.next;
    }
    return out;
  }
}

// ------------------------------------------------------------ html tags
// Try to match an inline HTML tag at src[i] == '<'. Returns the end index
// (exclusive) or 0.
function tryHtmlTag(src, i) {
  const n = src.length;
  if (i + 1 >= n) return 0;
  const c1 = src.charCodeAt(i + 1);
  // comment <!-- ... --> — marked is lenient: '--' inside the content
  // does not end or reject it; the comment runs to the first '-->'
  // (even '--->' terminates it). '<!-->' and '<!--->' are valid
  // (abruptly closed) comments too (cm-626).
  if (src.startsWith('<!--', i)) {
    let j = i + 4;
    if (j < n && src.charCodeAt(j) === 62) return j + 1;
    if (j + 1 < n && src.startsWith('->', j)) return j + 2;
    const e = src.indexOf('-->', j);
    return e >= 0 ? e + 3 : 0;
  }
  // processing instruction <? ... ?>
  if (c1 === 63) {
    const e = src.indexOf('?>', i + 2);
    return e >= 0 ? e + 2 : 0;
  }
  // declaration <!A ... > / CDATA <![CDATA[ ... ]]>
  if (c1 === 33) {
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      return e >= 0 ? e + 3 : 0;
    }
    let j = i + 2;
    if (j < n && src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) {
      while (j < n && src.charCodeAt(j) !== 62) j++;
      return j < n ? j + 1 : 0;
    }
    return 0;
  }
  // closing tag </name ...>
  if (c1 === 47) {
    let j = i + 2;
    if (j >= n) return 0;
    const c = src.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 0;
    while (j < n) {
      const d = src.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
      else break;
    }
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j < n && src.charCodeAt(j) === 62) return j + 1;
    return 0;
  }
  // open tag <name ...>
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return 0;
  let j = i + 1;
  while (j < n) {
    const d = src.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
    else break;
  }
  // an attribute name must be preceded by whitespace: a tag name
  // followed directly by a non-delimiter char is not a tag
  // ('<m:abc>' is literal text, cm-609)
  if (j < n) {
    const d0 = src.charCodeAt(j);
    if (d0 !== 32 && d0 !== 9 && d0 !== 10 && d0 !== 62 && d0 !== 47) return 0;
  }
  for (;;) {
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j >= n) return 0;
    const d = src.charCodeAt(j);
    if (d === 62) return j + 1;
    if (d === 47) {
      if (j + 1 < n && src.charCodeAt(j + 1) === 62) return j + 2;
      return 0;
    }
    // attribute name
    const ac = src.charCodeAt(j);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58)) return 0;
    j++;
    while (j < n) {
      const e2 = src.charCodeAt(j);
      if ((e2 >= 65 && e2 <= 90) || (e2 >= 97 && e2 <= 122) || (e2 >= 48 && e2 <= 57) || e2 === 95 || e2 === 58 || e2 === 46 || e2 === 45) j++;
      else break;
    }
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
    if (j < n && src.charCodeAt(j) === 61) {
      j++;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
      if (j >= n) return 0;
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return 0;
        j++;
        // after a quoted value the next char must be whitespace, '>' or
        // '/': "<a href='bar'title=title>" is literal text (cm-622)
        if (j < n) {
          const d3 = src.charCodeAt(j);
          if (d3 !== 32 && d3 !== 9 && d3 !== 10 && d3 !== 62 && d3 !== 47) return 0;
        }
      } else {
        let start = j;
        while (j < n) {
          const e2 = src.charCodeAt(j);
          if (e2 === 32 || e2 === 9 || e2 === 10 || e2 === 34 || e2 === 39 || e2 === 61 || e2 === 60 || e2 === 62 || e2 === 96) break;
          j++;
        }
        if (j === start) return 0;
      }
    }
  }
}

// ------------------------------------------------------------ link helpers
// (module level: used by both the block parser's reference-definition
// extraction and the inline parser.)
// Skip spaces/tabs/newlines starting at i.
function skipWs2(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}
// Parse a link destination starting at s[i]. Returns {dest, end} or null.
function parseDest2(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s.charCodeAt(i) === 60) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return { dest: out, end: j + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < n && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) { out += s[j + 1]; j += 2; continue; }
      out += s[j];
      j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 10 || c === 9 || c < 32) break;
    if (c === 92 && j + 1 < n && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) { out += s[j + 1]; j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    out += s[j];
    j++;
  }
  if (j === i) return null;
  return { dest: out, end: j };
}
// Parse a link title starting at s[i] (the opening quote/paren).
function parseTitle2(s, i) {
  const n = s.length;
  const q = s.charCodeAt(i);
  if (q === 34 || q === 39) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === q) return { title: out, end: j + 1 };
      if (c === 92 && j + 1 < n && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) { out += s[j + 1]; j += 2; continue; }
      out += s[j];
      j++;
    }
    return null;
  }
  if (q === 40) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 41) return { title: out, end: j + 1 };
      if (c === 92 && j + 1 < n && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) { out += s[j + 1]; j += 2; continue; }
      out += s[j];
      j++;
    }
    return null;
  }
  return null;
}
// Parse "(dest [title])" starting at s[i] == '('. Returns {dest, title, end}
// (end past the closing paren) or null.
function parseInlineLink2(s, i) {
  const n = s.length;
  let j = skipWs2(s, i + 1);
  if (j >= n) return null;
  const d = parseDest2(s, j);
  if (!d) return null;
  j = skipWs2(s, d.end);
  if (j < n && s.charCodeAt(j) === 41) return { dest: d.dest, title: null, end: j + 1 };
  const t = parseTitle2(s, j);
  if (!t) return null;
  j = skipWs2(s, t.end);
  if (j < n && s.charCodeAt(j) === 41) return { dest: d.dest, title: t.title, end: j + 1 };
  return null;
}
// A link label starting at s[i] == '['. Returns {label, end} (end past the
// closing bracket) or null. Backslash escapes in the label are processed.
function parseLabel2(s, i) {
  const n = s.length;
  let j = i + 1;
  let depth = 1;
  let out = '';
  while (j < n && depth > 0) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ASCII_PUNCT[s.charCodeAt(j + 1)] === 1) { out += s[j] + s[j + 1]; j += 2; continue; }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) { j++; break; } }
    out += s[j];
    j++;
  }
  if (depth !== 0) return null;
  return { label: out, end: j };
}
// A reference label, normalised for lookup: whitespace runs collapse to one
// space, the ends are trimmed, the case is folded. Null when empty/too long.
function normalizeLabel2(s) {
  if (s.length > 999) return null;
  const folded = s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
  return folded.length === 0 ? null : folded;
}

// ------------------------------------------------------------ line cursor
// A cursor over one source line, tracking a character offset and a column
// (a tab advances to the next multiple of 4). A tab consumed part-way
// leaves virtual spaces at the current position.
function makeCursor(s) {
  return { s, i: 0, col: 0, partial: 0 };
}
function curPeek(cur) {
  if (cur.partial > 0) return 32;
  if (cur.i >= cur.s.length) return -1;
  return cur.s.charCodeAt(cur.i);
}
function curAdvance(cur) {
  if (cur.partial > 0) { cur.partial--; cur.col++; return; }
  const c = cur.s.charCodeAt(cur.i);
  if (c === 9) { cur.col += 4 - (cur.col % 4); cur.i++; }
  else { cur.col++; cur.i++; }
}
function curAdvanceTo(cur, target) {
  while (cur.col < target) {
    if (cur.partial > 0) {
      const take = Math.min(cur.partial, target - cur.col);
      cur.partial -= take;
      cur.col += take;
      continue;
    }
    if (cur.i >= cur.s.length) break;
    const c = cur.s.charCodeAt(cur.i);
    if (c === 9) {
      const w = 4 - (cur.col % 4);
      if (cur.col + w > target) {
        cur.partial = cur.col + w - target;
        cur.col = target;
        cur.i++;
      } else { cur.col += w; cur.i++; }
    } else if (c === 32) { cur.col++; cur.i++; }
    else break;
  }
}
function curRest(cur) {
  if (cur.partial > 0) return ' '.repeat(cur.partial) + cur.s.slice(cur.i);
  return cur.s.slice(cur.i);
}
function curIsBlank(cur) {
  if (cur.partial > 0) return false;
  for (let i = cur.i; i < cur.s.length; i++) {
    const c = cur.s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Columns of leading whitespace from the cursor position. A partially
// consumed tab contributes its remaining width first, then the whitespace
// after it is counted from the tab's far column.
function curIndent(cur) {
  let col = cur.col + cur.partial;
  let i = cur.i;
  while (i < cur.s.length) {
    const c = cur.s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { indent: col - cur.col, end: i, partial: 0 };
}

// Is the raw line string blank (only spaces/tabs)?
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Does the raw line start a list item (after up to 3 spaces of indent)?
function isListMarkerLine(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= s.length) return false;
  const c = s.charCodeAt(i);
  if (c === 45 || c === 42 || c === 43) {
    const n = s.charCodeAt(i + 1);
    return n === 32 || n === 9 || i + 1 >= s.length;
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    let digits = 0;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57 && digits < 10) { j++; digits++; }
    if (digits === 0 || digits > 9) return false;
    const m = s.charCodeAt(j);
    if (m !== 46 && m !== 41) return false;
    const n = s.charCodeAt(j + 1);
    return n === 32 || n === 9 || j + 1 >= s.length;
  }
  return false;
}

// ------------------------------------------------------------ block parser
// CommonMark phase 1, line based, with an explicit container stack.
// A line is matched against the open containers outside-in; unmatched
// containers close; then new blocks start in the innermost open one.

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

// Try an HTML block start at the cursor (content start). Returns
// {type, endMarker} or null. Types 1-5 end at a line containing endMarker;
// types 6-7 end at a blank line.
function tryHtmlBlockStart(cur) {
  const s = cur.s;
  const i = cur.i;
  if (s.charCodeAt(i) !== 60) return null;
  if (s.startsWith('<!--', i)) return { type: 2, endMarker: '-->' };
  if (s.charCodeAt(i + 1) === 63) return { type: 3, endMarker: '?>' };
  if (s.charCodeAt(i + 1) === 33) {
    if (s.startsWith('<![CDATA[', i)) return { type: 5, endMarker: ']]>' };
    const c = s.charCodeAt(i + 2);
    if (c >= 65 && c <= 90) return { type: 4, endMarker: '>' };
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= s.length) return null;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  let k = j;
  while (k < s.length) {
    const d = s.charCodeAt(k);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) k++;
    else break;
  }
  const name = s.slice(j, k).toLowerCase();
  if (k < s.length) {
    const d = s.charCodeAt(k);
    if (d !== 32 && d !== 9 && d !== 62 && d !== 47) return null;
    if (d === 47 && (k + 1 >= s.length || s.charCodeAt(k + 1) !== 62)) return null;
  }
  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    return { type: 1, endMarker: '</' + name };
  }
  if (BLOCK_TAGS.has(name)) return { type: 6, endMarker: null };
  // type 7: the tag must be complete on this line, with only whitespace
  // after it (cm-091: '<a title="a lot' with no '>' is a paragraph line,
  // not an HTML block)
  const tagEnd = tryHtmlTag(s, i);
  if (tagEnd > 0) {
    let m = tagEnd;
    while (m < s.length && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m >= s.length) return { type: 7, endMarker: null };
  }
  return null;
}
// Does the line at the cursor (content start, indent <= 3) close the fenced
// code block? Restores the cursor when it does not.
function isClosingFence(cur, block) {
  const saveI = cur.i;
  const saveCol = cur.col;
  const savePartial = cur.partial;
  const ind = curIndent(cur);
  if (ind.indent > 3) { cur.i = saveI; cur.col = saveCol; cur.partial = savePartial; return false; }
  curAdvanceTo(cur, cur.col + ind.indent);
  const s = cur.s;
  let i = cur.i;
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) === block.fenceChar) n++;
  if (n < block.fenceLen) { cur.i = saveI; cur.col = saveCol; cur.partial = savePartial; return false; }
  let j = i + n;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d !== 32 && d !== 9) { cur.i = saveI; cur.col = saveCol; cur.partial = savePartial; return false; }
    j++;
  }
  return true;
}
// Setext underline level at the cursor (content start): 1 for '=', 2 for
// '-', 0 when the line is not a setext underline. The underline is a run
// of the character followed only by spaces/tabs; spaces between the
// characters disqualify it (cm-088: '= =' and '--- -' are not underlines).
function setextLevel(cur) {
  const s = cur.s;
  const i = cur.i;
  const c = s.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === c) j++;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d !== 32 && d !== 9) return 0;
    j++;
  }
  return c === 61 ? 1 : 2;
}
// A table delimiter row at the cursor (content start). Returns the array of
// alignments ('left' | 'right' | 'center' | null) or null.
function parseTableDelim(cur) {
  const s = cur.s;
  let i = cur.i;
  if (s.charCodeAt(i) === 124) i++;
  const aligns = [];
  for (;;) {
    while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    let left = false;
    let right = false;
    if (i < s.length && s.charCodeAt(i) === 58) { left = true; i++; }
    let dashes = 0;
    while (i < s.length && s.charCodeAt(i) === 45) { dashes++; i++; }
    if (dashes === 0) return null;
    if (i < s.length && s.charCodeAt(i) === 58) { right = true; i++; }
    while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    if (i < s.length && s.charCodeAt(i) === 124) {
      i++;
      let j = i;
      while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j >= s.length) return aligns;
      continue;
    }
    if (i >= s.length) return aligns;
    return null;
  }
}
// Thematic break at the cursor (content start): 3+ of *, - or _ with only
// spaces between them.
function isThematicBreak(cur) {
  const s = cur.s;
  const i = cur.i;
  const c = s.charCodeAt(i);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let n = 0;
  let j = i;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d === c) n++;
    else if (d === 32 || d === 9) { /* skip */ }
    else return false;
    j++;
  }
  return n >= 3;
}
// ATX heading at the cursor (content start). Returns {level, text} or null.
function tryAtx(cur) {
  const s = cur.s;
  const i = cur.i;
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const after = i + n;
  if (after < s.length) {
    const c = s.charCodeAt(after);
    if (c !== 32 && c !== 9) return null;
  }
  let j = after;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  let text = s.slice(j);
  // strip a closing hash run (preceded by a space, followed by spaces only)
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  let h = end;
  while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
  if (h < end && h > 0 && (text.charCodeAt(h - 1) === 32 || text.charCodeAt(h - 1) === 9)) text = text.slice(0, h).replace(/[ \t]+$/, '');
  else if (h < end && h === 0) text = '';
  else text = text.slice(0, end);
  return { level: n, text };
}
// Fenced code start at the cursor (content start). Returns
// {fenceChar, fenceLen, info} or null.
function tryFence(cur) {
  const s = cur.s;
  const i = cur.i;
  const c = s.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) === c) n++;
  if (n < 3) return null;
  const info = s.slice(i + n);
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return { fenceChar: c, fenceLen: n, info };
}
// List item marker at the cursor (content start). Returns
// {ordered, marker, start, markerLen, empty} or null. `empty` is true when
// nothing but whitespace follows the marker.
function tryListMarker(cur) {
  const s = cur.s;
  const i = cur.i;
  const c = s.charCodeAt(i);
  let ordered = false;
  let marker = null;
  let start = null;
  let markerLen = 0;
  if (c === 45 || c === 42 || c === 43) {
    marker = String.fromCharCode(c);
    markerLen = 1;
  } else if (c >= 48 && c <= 57) {
    let j = i;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j - i > 9 || j >= s.length) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    marker = String.fromCharCode(d);
    start = parseInt(s.slice(i, j), 10);
    markerLen = j + 1 - i;
  } else return null;
  const after = i + markerLen;
  if (after >= s.length) return { ordered, marker, start, markerLen, empty: true };
  const d = s.charCodeAt(after);
  if (d !== 32 && d !== 9) return null;
  let empty = true;
  for (let k = after; k < s.length; k++) {
    const e = s.charCodeAt(k);
    if (e !== 32 && e !== 9) { empty = false; break; }
  }
  return { ordered, marker, start, markerLen, empty };
}

// Remove up to n leading whitespace characters (space/tab, each counting
// as one) from s: the opening fence's indentation is stripped from every
// content line of a fenced code block.
// A fenced code content line: strip the opening fence's indentation as
// up to N leading whitespace characters (cm-131: a tab counts as one),
// then, when the fence is nested in a container, expand leading tabs to
// spaces (marked expands them there, but preserves a leading tab in a
// top-level fence). col tracks the column for the tab stops.
function fenceContentLine(cur, block) {
  let s = curRest(cur);
  // a fence inside a blockquote expands leading tabs from column 2 (the
  // innermost '> ' prefix), no matter how deep the quote nesting is —
  // marked gives the same result for '> ' and '> > ' (N spaces before a
  // tab -> 2 spaces for N=0,1 and 6 for N>=2); a fence in a list item
  // keeps the absolute column
  let col = block.inQuote ? 2 : cur.col;
  // strip the opening fence's indentation (up to N leading whitespace
  // characters); the stripped characters do NOT advance the column —
  // the remaining content is treated as starting at the content column
  let n = 0;
  while (n < s.length && n < block.fenceIndent) {
    const c = s.charCodeAt(n);
    if (c === 32 || c === 9) n++;
    else break;
  }
  s = s.slice(n);
  if (block.nested) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
      else if (c === 32) { out += ' '; col++; i++; }
      else break;
    }
    if (out) s = out + s.slice(i);
  }
  return s;
}

function stripLeadingWs(s, n) {
  let i = 0;
  while (i < s.length && i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return s.slice(i);
}
// Split a table row into cells: unescaped '|' separates, a leading/trailing
// '|' drops its empty edge cell, each cell is trimmed. `\|` stays in the
// cell text for the inline parser to unescape.
function splitTableRow(s) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 124) {
      // a pipe preceded by an odd run of backslashes is an escaped pipe:
      // drop one backslash and keep the pipe literally in the cell
      // (marked strips it before inline parsing, so `a \| b` in a code
      // span renders as `a | b`); an even run means a cell boundary
      let bs = 0;
      let j = cur.length - 1;
      while (j >= 0 && cur.charCodeAt(j) === 92) { bs++; j--; }
      if (bs % 2 === 1) { cur = cur.slice(0, -1) + '|'; i++; continue; }
      cells.push(cur); cur = ''; i++; continue;
    }
    cur += s[i];
    i++;
  }
  cells.push(cur);
  // drop an empty edge cell when the row starts / ends with a pipe
  let start = 0;
  let end = cells.length;
  let lead = 0;
  while (lead < s.length && (s.charCodeAt(lead) === 32 || s.charCodeAt(lead) === 9)) lead++;
  if (lead < s.length && s.charCodeAt(lead) === 124 && cells[0].trim() === '') start = 1;
  let trail = s.length - 1;
  while (trail >= 0 && (s.charCodeAt(trail) === 32 || s.charCodeAt(trail) === 9)) trail--;
  if (trail >= 0 && s.charCodeAt(trail) === 124 && cells[cells.length - 1].trim() === '') end = cells.length - 1;
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// Extract link reference definitions from the start of a paragraph's text
// (lines joined with '\n'). Returns the remaining text, or null when the
// whole paragraph was definitions. First definition of a label wins.
function extractRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let i = pos;
    let spaces = 0;
    while (i < n && text.charCodeAt(i) === 32 && spaces < 3) { i++; spaces++; }
    if (i >= n || text.charCodeAt(i) === 9) break;
    if (text.charCodeAt(i) !== 91) break;
    const lab = parseLabel2(text, i);
    if (!lab) break;
    let j = skipWs2(text, lab.end);
    if (j >= n || text.charCodeAt(j) !== 58) break;
    j = skipWs2(text, j + 1);
    if (j >= n) break;
    const d = parseDest2(text, j);
    if (!d) break;
    // After the destination: an optional title, then only whitespace to
    // the end of the line. A title must be separated from the destination
    // by whitespace (cm-201: '<bar>(baz)' is not a valid definition).
    // The title may also sit on the next line.
    let title = null;
    let endLine = -1; // index just past the newline ending this def, or n
    let j1 = d.end;
    while (j1 < n && (text.charCodeAt(j1) === 32 || text.charCodeAt(j1) === 9)) j1++;
    if (j1 < n && j1 > d.end) {
      const t = parseTitle2(text, j1);
      if (t) {
        title = t.title;
        let j2 = t.end;
        while (j2 < n && (text.charCodeAt(j2) === 32 || text.charCodeAt(j2) === 9)) j2++;
        if (j2 >= n) endLine = n;
        else if (text.charCodeAt(j2) === 10) endLine = j2 + 1;
        else break;
      }
    }
    if (endLine < 0) {
      if (j1 >= n) endLine = n;
      else if (text.charCodeAt(j1) === 10) {
        // the title may sit on the next line, indented by any amount
        // of spaces/tabs (cm-193: 11 spaces)
        let m = j1 + 1;
        while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
        const t = m < n ? parseTitle2(text, m) : null;
        if (t) {
          let j2 = t.end;
          while (j2 < n && (text.charCodeAt(j2) === 32 || text.charCodeAt(j2) === 9)) j2++;
          if (j2 >= n) { title = t.title; endLine = n; }
          else if (text.charCodeAt(j2) === 10) { title = t.title; endLine = j2 + 1; }
          // junk after the next-line title: the title is not part of the
          // definition, but the definition itself (destination only) still
          // stands and the next line is leftover text (cm-210)
          else endLine = j1 + 1;
        } else endLine = j1 + 1;
      } else break;
    }
    const norm = normalizeLabel2(lab.label);
    if (norm === null) break;
    if (!refs.has(norm)) refs.set(norm, { dest: d.dest, title });
    pos = endLine;
  }
  if (pos === 0) return text;
  if (pos >= n) return null;
  return text.slice(pos);
}

function parseBlocks(src) {
  const refs = new Map();
  const lines = src.split('\n');
  if (src.endsWith('\n')) lines.pop();
  const doc = { t: 'doc', children: [], lastBlank: false };
  const open = [doc];
  let curLine = 0; // index of the source line being processed
  let strippedStartCol = 0; // absolute column where the current line's
  // content starts after the container prefixes (set in startBlocks)

  function top() { return open[open.length - 1]; }
  function addChild(parent, child) {
    if (parent.t === 'item' && (parent.lastBlank || parent.blankChild) && parent.children.length > 0) {
      // a blank line separated two blocks inside this item: the list is loose
      const list = open[open.indexOf(parent) - 1];
      if (list && list.t === 'list') list.tight = false;
    }
    parent.children.push(child);
    parent.lastBlank = false;
    parent.blankChild = false;
    return child;
  }
  function finalize(b) {
    if (b.t === 'para') {
      const rest = extractRefDefs(b.lines.join('\n'), refs);
      if (rest === null) b.drop = true;
      else b.text = rest;
      // task list: the first paragraph of a list item starting with
      // '[ ]' / '[x]' / '[X]' plus a space is a checkbox; the marker
      // and one following space are stripped, the item remembers it
      if (!b.drop && b.text) {
        const parent = top();
        if (parent && parent.t === 'item' && parent.children[0] === b) {
          const t0 = b.text;
          if (t0.length >= 4 && t0.charCodeAt(0) === 91 && (t0.charCodeAt(1) === 32 || t0.charCodeAt(1) === 120 || t0.charCodeAt(1) === 88) && t0.charCodeAt(2) === 93 && (t0.charCodeAt(3) === 32 || t0.charCodeAt(3) === 9)) {
            parent.task = t0.charCodeAt(1) === 32 ? 'unchecked' : 'checked';
            b.text = t0.slice(4);
          }
        }
      }
    } else if (b.t === 'code') {
      // an indented code block drops trailing blank lines (they are
      // separators, not content); a fenced code block keeps them (cm-318:
      // 'b' + 2 blank lines renders 'b\n\n', not 'b\n')
      if (!b.fenced) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
    } else if (b.t === 'html') {
      // an HTML block's output ends with a newline unless the line after
      // it is blank (cm-169: a <pre> block closed by its end marker and
      // followed by a paragraph keeps its trailing newline; cm-148: one
      // followed by a blank line does not). Inside a container the block
      // is lexed from the container's content string, which changes the
      // rule (marked's ge() + list/quote text model).
      const nextIdx = b.lastLineIdx + 1;
      if (b.parentKind === 'item') {
        // the item's text ends with exactly one newline only when the
        // block is followed by exactly one blank line and then a new
        // list item (cm-175: no newline; '- <div>\n\n- foo' keeps one)
        if (nextIdx < lines.length && isBlankStr(lines[nextIdx])) {
          let j = nextIdx;
          while (j < lines.length && isBlankStr(lines[j])) j++;
          b.trailingNl = j - nextIdx === 1 && j < lines.length && isListMarkerLine(lines[j]);
        } else if (nextIdx < lines.length && isListMarkerLine(lines[nextIdx])) {
          // followed directly by a new list item: no trailing newline
          b.trailingNl = false;
        } else {
          // followed by another block in the same item (a paragraph):
          // the HTML block ends with a newline ('<!-- note -->\nMethod')
          b.trailingNl = nextIdx < lines.length;
        }
      } else if (b.parentKind === 'quote') {
        // the quote's text has no trailing newline unless its last line
        // is a blank line inside the quote ('>' / '> ')
        if (nextIdx >= lines.length) b.trailingNl = false;
        else if (/^ {0,3}>[ \t]*$/.test(lines[nextIdx])) b.trailingNl = nextIdx === lines.length - 1;
        else if (isBlankStr(lines[nextIdx])) b.trailingNl = false;
        else b.trailingNl = b.endMarker !== null;
      } else {
        if (nextIdx === lines.length) b.trailingNl = src.endsWith('\n');
        else b.trailingNl = !isBlankStr(lines[nextIdx]);
      }
    }
  }
  function popTo(n) {
    while (open.length > n) {
      const b = open.pop();
      // a block closed while blank propagates the blank to its parent:
      // a block added to the parent later is then separated from it by
      // the blank line (cm-325), but a new list item is not (cm-320)
      if (b.lastBlank || b.blankChild) {
        const p = top();
        if (p) p.blankChild = true;
      }
      finalize(b);
    }
  }

  // --- container matching ---
  function matchQuote(cur) {
    const ind = curIndent(cur);
    if (ind.indent > 3) return false;
    curAdvanceTo(cur, cur.col + ind.indent);
    if (curPeek(cur) !== 62) return false;
    curAdvance(cur);
    const c = curPeek(cur);
    // one optional space after '>'; a tab counts as a single column here,
    // leaving the rest of the tab as virtual spaces (cm-006: '>\t\tfoo'
    // is indented code '  foo', not 'foo').
    if (c === 32 || c === 9) curAdvanceTo(cur, cur.col + 1);
    return true;
  }
  function matchItem(b, cur) {
    // a blank line is inside the item (it only marks the list loose);
    // without this a blank line inside a quote (cm-259: '>>') would
    // close the item and the following paragraph would escape it
    if (curIsBlank(cur)) return true;
    const ind = curIndent(cur);
    if (ind.indent < b.contentIndent) return false;
    curAdvanceTo(cur, cur.col + b.contentIndent);
    return true;
  }

  // --- a new list item ---
  function startListItem(cur, marker) {
    const markerCol = cur.col;
    for (let k = 0; k < marker.markerLen; k++) curAdvance(cur);
    const spacesI = cur.i;
    const spacesCol = cur.col;
    const spacesPartial = cur.partial;
    while (curPeek(cur) === 32 || curPeek(cur) === 9) curAdvance(cur);
    const spacesCols = cur.col - spacesCol;
    let contentIndentAbs;
    if (marker.empty) {
      contentIndentAbs = markerCol + marker.markerLen + 1;
    } else if (spacesCols >= 5) {
      contentIndentAbs = markerCol + marker.markerLen + 1;
      cur.i = spacesI;
      cur.col = spacesCol;
      cur.partial = spacesPartial;
      curAdvanceTo(cur, contentIndentAbs);
    } else {
      contentIndentAbs = cur.col;
    }
    // the content indent is the content's column inside the stripped
    // content (after the container prefixes), so a continuation line
    // inside a quote whose prefix is shorter still matches (cm-259,
    // cm-260) while a tab/indented line at the top level advances to
    // the absolute content column (cm-004, cm-108, cm-257)
    const contentIndent = contentIndentAbs - strippedStartCol;
    const t = top();
    let list = null;
    if (t.t === 'list' && t.ordered === marker.ordered && t.marker === marker.marker) list = t;
    else {
      if (t.t === 'list') popTo(open.length - 1);
      list = { t: 'list', ordered: marker.ordered, marker: marker.marker, start: marker.start, tight: true, children: [], lastBlank: false };
      addChild(top(), list);
      open.push(list);
    }
    if (list.children.length > 0) {
      const prev = list.children[list.children.length - 1];
      if (prev.lastBlank) list.tight = false;
    }
    const item = { t: 'item', children: [], contentIndent, lastBlank: false };
    addChild(list, item);
    open.push(item);
    if (!marker.empty && !curIsBlank(cur)) startBlocks(cur);
  }

  // --- new blocks in the innermost open container ---
  function startBlocks(cur) {
    strippedStartCol = cur.col; // column where this line's content starts
    const ind = curIndent(cur);
    const t = top();
    // the cursor position after the container prefixes: paragraph lines
    // keep their leading spaces in full (only the container prefix is
    // consumed), so it is saved here and restored for the paragraph case.
    const saveI = cur.i;
    const saveCol = cur.col;
    const savePartial = cur.partial;
    if (ind.indent >= 4) {
      if (top().t === 'list') popTo(open.length - 1);
      if (top().t === 'para') {
        if (curIsBlank(cur)) return; // blank after the container prefixes
        top().lines.push(curRest(cur));
        top().lastLazy = false;
        return;
      }
      curAdvanceTo(cur, cur.col + 4);
      if (curIsBlank(cur)) return; // blank after the container prefixes
      const code = { t: 'code', fenced: false, info: '', lines: [], lastBlank: false };
      addChild(top(), code);
      open.push(code);
      code.lines.push(curRest(cur));
      return;
    }
    curAdvanceTo(cur, cur.col + ind.indent);
    if (curIsBlank(cur)) return; // nothing left after the container prefixes
    // a list stays open only for a new item of the same list; any other
    // block closes it first (cm-057: '***' between two lists is an <hr>
    // outside both lists, not a child of the first)
    if (top().t === 'list') {
      const m = tryListMarker(cur);
      // a thematic break ('* * *') is not a list item, even when it looks
      // like one (cm-060)
      if (m && m.ordered === top().ordered && m.marker === top().marker && !isThematicBreak(cur)) {
        startListItem(cur, m);
        return;
      }
      popTo(open.length - 1);
    }
    // setext underline / table delimiter (paragraph only)
    if (t.t === 'para') {
      const st = setextLevel(cur);
      if (st > 0) {
        const p = open.pop();
        const parent = top();
        parent.children.pop(); // the paragraph becomes the heading: remove it
        // reference definitions are extracted from the paragraph BEFORE
        // the setext conversion (cm-215: '[foo]: /url\nbar\n===' is an
        // <h1>bar</h1> with the definition consumed; cm-216: '[foo]:
        // /url\n===' is a paragraph '===\n[foo]', not a heading at all)
        const rest = extractRefDefs(p.lines.join('\n'), refs);
        if (rest !== null) {
          // a setext heading's text is the paragraph's lines with the
          // leading whitespace of the first line and the trailing whitespace
          // of the last line removed (cm-082)
          let text = rest;
          let a = 0;
          while (a < text.length && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
          let b = text.length;
          while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
          text = text.slice(a, b);
          addChild(parent, { t: 'heading', level: st, text, lastBlank: false });
          return;
        }
        // the paragraph was only definitions: no heading; the underline
        // line falls through to the normal block logic below
      }
      if (t.lines.length === 1) {
        const delim = parseTableDelim(cur);
        if (delim) {
          // the delimiter row must have at least as many cells as the
          // header, or the block is a paragraph, not a table (gfm-203:
          // a 2-cell header with a 1-cell delimiter is not a table)
          const headerCells = splitTableRow(t.lines[0]);
          if (delim.length < headerCells.length) {
            // fall through to the normal block logic below
          } else {
          const rest = extractRefDefs(t.lines[0], refs);
          if (rest !== null) {
            const p = open.pop();
            const parent = top();
            parent.children.pop(); // the paragraph becomes the table: remove it
            const tb = { t: 'table', header: rest, align: delim, rows: [], lastBlank: false };
            addChild(parent, tb);
            open.push(tb);
            return;
          }
          }
        }
      }
    }
    const atx = tryAtx(cur);
    if (atx) {
      if (top().t === 'para') popTo(open.length - 1);
      addChild(top(), { t: 'heading', level: atx.level, text: atx.text, lastBlank: false });
      return;
    }
    const fence = tryFence(cur);
    if (fence) {
      if (top().t === 'para') popTo(open.length - 1);
      const code = { t: 'code', fenced: true, info: fence.info, lines: [], fenceChar: fence.fenceChar, fenceLen: fence.fenceLen, fenceIndent: ind.indent, nested: top().t !== 'doc', inQuote: top().t === 'quote', lastBlank: false };
      addChild(top(), code);
      open.push(code);
      return;
    }
    const html = tryHtmlBlockStart(cur);
    // an HTML block of type 7 cannot interrupt a paragraph (cm-148)
    if (html && !(top().t === 'para' && html.type === 7)) {
      if (top().t === 'para') popTo(open.length - 1);
      // the first line keeps its leading indentation (cm-150: ' <div>')
      cur.i = saveI; cur.col = saveCol; cur.partial = savePartial;
      const hb = { t: 'html', htmlType: html.type, endMarker: html.endMarker, lines: [curRest(cur)], lastBlank: false, lastLineIdx: curLine, parentKind: top().t };
      addChild(top(), hb);
      if (html.endMarker === null || curRest(cur).toLowerCase().indexOf(html.endMarker) < 0) open.push(hb);
      else finalize(hb);
      return;
    }
    if (isThematicBreak(cur)) {
      if (top().t === 'para') popTo(open.length - 1);
      addChild(top(), { t: 'hr', lastBlank: false });
      return;
    }
    if (curPeek(cur) === 62) {
      if (top().t === 'para') popTo(open.length - 1);
      const q = { t: 'quote', children: [], lastBlank: false };
      addChild(top(), q);
      open.push(q);
      matchQuote(cur);
      startBlocks(cur);
      return;
    }
    const marker = tryListMarker(cur);
    if (marker) {
      // inside a list item any ordered list can interrupt the item's
      // paragraph and start a nested list ('- foo\n  49. bar' makes an
      // <ol start="49">); at the top level / in a blockquote an ordered
      // list still needs start 1 to interrupt a paragraph
      let insideItem = false;
      for (const b of open) if (b.t === 'item') { insideItem = true; break; }
      const canInterrupt = top().t !== 'para' || insideItem || (!marker.empty && (marker.ordered ? marker.start === 1 : true));
      if (canInterrupt) {
        if (top().t === 'para') popTo(open.length - 1);
        startListItem(cur, marker);
        return;
      }
    }
    if (top().t === 'para') {
      cur.i = saveI; cur.col = saveCol; cur.partial = savePartial;
      top().lines.push(curRest(cur));
      top().lastLazy = false;
    } else {
      const p = { t: 'para', lines: [], lastBlank: false, lastLazy: false };
      addChild(top(), p);
      open.push(p);
      cur.i = saveI; cur.col = saveCol; cur.partial = savePartial;
      p.lines.push(curRest(cur));
    }
  }

  // --- lazy continuations ---
  // A line that does not match the containers above an open paragraph may
  // still continue the paragraph lazily, unless it starts a block that can
  // interrupt a paragraph. A setext-underline-shaped lazy line is NOT a
  // setext underline: it stays paragraph text.
  function tryLazyContinuation(cur) {
    const para = top();
    // a line that is empty after the container prefixes is a blank line,
    // not a lazy continuation (cm-259/cm-260: '>>' between two paragraphs
    // inside a nested quote closes the first paragraph)
    if (curRest(cur) === '') return false;
    const ind = curIndent(cur);
    if (ind.indent <= 3) {
      const saveI = cur.i;
      const saveCol = cur.col;
      const savePartial = cur.partial;
      curAdvanceTo(cur, cur.col + ind.indent);
      let interrupts = false;
      const hb = tryHtmlBlockStart(cur);
      if (tryAtx(cur) || tryFence(cur) || isThematicBreak(cur)) interrupts = true;
      // an HTML block of type 7 cannot interrupt a paragraph (cm-148)
      else if (hb && hb.type !== 7) interrupts = true;
      else if (curPeek(cur) === 62) interrupts = true;
      else {
        const m = tryListMarker(cur);
        // an empty list item cannot interrupt a paragraph at the top
        // level, but inside a list item any marker line is a new item
        // at the outer list level and ends the current item (cm-278,
        // cm-283: '2.' starts a new item even though its start is not 1)
        let insideItem = false;
        for (const b of open) if (b.t === 'item') { insideItem = true; break; }
        if (m && (insideItem || (!m.empty && (m.ordered ? m.start === 1 : true)))) interrupts = true;
      }
      cur.i = saveI; cur.col = saveCol; cur.partial = savePartial;
      if (interrupts) return false;
    } else {
      // a lazy line indented 4+ columns has 4 columns stripped (cm-238:
      // '> foo\n    - bar' continues the paragraph as '- bar'; a tab
      // counts as 4 columns here)
      curAdvanceTo(cur, cur.col + 4);
    }
    addLazyLine(cur, para);
    return true;
  }
  function addLazyLine(cur, para) {
    let content = curRest(cur);
    // the setext-underline quirk (cm-093): a lazy line shaped like a setext
    // underline, following another lazy line, inside a blockquote, has its
    // leading spaces replaced by four spaces
    if (para.lastLazy && content.charCodeAt(0) !== 9) {
      let i = 0;
      let spaces = 0;
      while (i < content.length && content.charCodeAt(i) === 32 && spaces < 3) { i++; spaces++; }
      if (i < content.length) {
        const c = content.charCodeAt(i);
        if (c === 61 || c === 45) {
          let j = i;
          while (j < content.length && content.charCodeAt(j) === c) j++;
          let ok = true;
          while (j < content.length) {
            const d = content.charCodeAt(j);
            if (d !== 32 && d !== 9) { ok = false; break; }
            j++;
          }
          if (ok) {
            let insideQuote = false;
            for (const b of open) if (b.t === 'quote') { insideQuote = true; break; }
            if (insideQuote) content = '    ' + content.slice(i);
          }
        }
      }
    }
    para.lines.push(content);
    para.lastLazy = true;
  }

  function blankLineContent(cur) {
    // an empty list item followed by a blank line is closed; following
    // indented content is a separate block (cm-280). Mark it blank first
    // so the list still goes loose when a later item follows (cm-315).
    if (top().t === 'item' && top().children.length === 0) {
      top().lastBlank = true;
      popTo(open.length - 1);
    }
    while (open.length > 1) {
      const t = top();
      if (t.t === 'para') popTo(open.length - 1);
      else if (t.t === 'html' && (t.htmlType === 6 || t.htmlType === 7)) popTo(open.length - 1);
      else if (t.t === 'table') popTo(open.length - 1);
      else break;
    }
    const t = top();
    if (t.t === 'code') {
      if (t.fenced) t.lines.push(fenceContentLine(cur, t));
      else { curAdvanceTo(cur, cur.col + 4); t.lines.push(curRest(cur)); }
    } else if (t.t === 'html') {
      t.lines.push('');
      t.lastLineIdx = curLine;
    } else {
      t.lastBlank = true;
    }
  }

  for (let li = 0; li < lines.length; li++) {
    curLine = li;
    const cur = makeCursor(lines[li]);
    const blank = curIsBlank(cur);
    // a fenced code block swallows its content lines even when they do
    // not match the enclosing list item's indent (a line at column 0
    // inside a fence in an item stays code); a blockquote prefix is
    // still required, so quotes keep breaking it
    const inFence = top().t === 'code' && top().fenced;
    let k = 1;
    while (k < open.length) {
      const b = open[k];
      if (b.t === 'quote') {
        // a blank line matches a quote only when it carries the '>'
        // prefix (cm-242: a bare blank line closes the quote, so '> foo'
        // and '> bar' become two separate blockquotes)
        if (!matchQuote(cur)) break;
      } else if (b.t === 'item') {
        if (!blank && !matchItem(b, cur) && !inFence) break;
      } else if (b.t === 'list' || b.t === 'para' || b.t === 'html' || b.t === 'table') {
        // a blank line ends a table — except a line that is blank only
        // because of a tab, which is a table row of empty cells
        // ('| a |\n|---|\n| 1 |\n\t\n| 3 |' keeps the table going)
        if (blank && (b.t === 'para' || b.t === 'table' || (b.t === 'html' && (b.htmlType === 6 || b.htmlType === 7)))) {
          if (b.t === 'table' && curRest(cur).indexOf('\t') >= 0) { /* tab-only row: keep going */ }
          else break;
        }
      } else if (b.t === 'code') {
        if (!b.fenced && !blank) {
          const ind = curIndent(cur);
          if (ind.indent < 4) break;
        }
      }
      k++;
    }
    if (blank) {
      popTo(k);
      // a blank line that contains a tab, inside a table, is a table
      // row of empty cells — not a blank line ending the table
      if (top().t === 'table' && curRest(cur).indexOf('\t') >= 0) {
        top().rows.push(curRest(cur));
        continue;
      }
      blankLineContent(cur);
      continue;
    }
    // lazy continuation of an open paragraph (cm-093)
    if (k < open.length && top().t === 'para' && tryLazyContinuation(cur)) continue;
    popTo(k);
    const t = top();
    if (t.t === 'code') {
      if (t.fenced) {
        if (isClosingFence(cur, t)) popTo(open.length - 1);
        else t.lines.push(fenceContentLine(cur, t));
      } else {
        curAdvanceTo(cur, cur.col + 4);
        t.lines.push(curRest(cur));
      }
      continue;
    }
    if (t.t === 'table') {
      // a line that starts a new block (blockquote, list, ATX heading,
      // fence, thematic break, HTML block) ends the table instead of
      // becoming a row ('| 1 |\n> bar' makes a blockquote, not a row)
      const saveI = cur.i, saveCol = cur.col, savePartial = cur.partial;
      const ind = curIndent(cur);
      curAdvanceTo(cur, cur.col + ind.indent);
      const endsTable = ind.indent <= 3 && (curPeek(cur) === 62 || tryAtx(cur) || tryFence(cur) || isThematicBreak(cur) || tryListMarker(cur) || tryHtmlBlockStart(cur));
      cur.i = saveI; cur.col = saveCol; cur.partial = savePartial;
      if (endsTable) { popTo(open.length - 1); }
      else { t.rows.push(curRest(cur)); continue; }
    }
    if (t.t === 'html') {
      t.lines.push(curRest(cur));
      t.lastLineIdx = curLine;
      if (t.endMarker !== null && curRest(cur).toLowerCase().indexOf(t.endMarker) >= 0) popTo(open.length - 1);
      continue;
    }
    if (curIsBlank(cur)) {
      const rest = curRest(cur);
      if (rest !== '' && top().t === 'para') {
        // a line that is whitespace-only after the container prefixes is
        // a paragraph continuation line, not a blank line (cm-241: '>  '
        // adds a ' ' line to the paragraph; '> ' alone is blank)
        top().lines.push(rest);
        top().lastLazy = false;
        continue;
      }
      blankLineContent(cur);
      continue;
    }
    startBlocks(cur);
  }
  popTo(1);
  return { blocks: doc.children, refs };
}

// ------------------------------------------------------------ renderers
function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, true);
  return out;
}
function renderBlock(b, refs, tight) {
  switch (b.t) {
    case 'doc':
      return renderBlocks(b.children, refs);
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      let h = '<' + tag;
      if (b.ordered && b.start !== 1) h += ' start="' + b.start + '"';
      h += '>\n';
      for (const item of b.children) h += renderBlock(item, refs, b.tight);
      return h + '</' + tag + '>\n';
    }
    case 'item': {
      let h = '<li>';
      // a task-list item renders its checkbox before the first block's
      // content: bare inline in a tight list, inside the <p> in a loose one
      const box = b.task === 'checked' ? '<input checked="" disabled="" type="checkbox"> ' : b.task === 'unchecked' ? '<input disabled="" type="checkbox"> ' : '';
      for (let i = 0; i < b.children.length; i++) {
        const k = b.children[i];
        // in a tight list every paragraph renders as bare inline content,
        // not just the first one (cm-300: a paragraph after a heading in
        // the same item has no <p> tags)
        if (tight && k.t === 'para' && !k.drop) h += (i === 0 ? box : '') + inlineHtml(k.text, refs, true);
        else if (i === 0 && box && k.t === 'para' && !k.drop) h += '<p>' + box + inlineHtml(k.text, refs, true) + '</p>\n';
        else h += renderBlock(k, refs, tight);
      }
      return h + '</li>\n';
    }
    case 'para':
      if (b.drop) return '';
      return '<p>' + inlineHtml(b.text, refs, true) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + inlineHtml(b.text, refs, true) + '</h' + b.level + '>\n';
    case 'code': {
      let content = b.lines.join('\n');
      // a trailing newline is added only when the last line is non-empty;
      // when it is blank the join already ends with a newline (cm-318)
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] !== '') content += '\n';
      if (b.fenced) {
        // backslash escapes in the info string are processed (cm-024:
        // 'foo\+bar' becomes the language 'foo+bar')
        let info = '';
        const raw = b.info;
        for (let k = 0; k < raw.length; k++) {
          if (raw.charCodeAt(k) === 92 && k + 1 < raw.length && ASCII_PUNCT[raw.charCodeAt(k + 1)] === 1) { info += raw[k + 1]; k++; continue; }
          info += raw[k];
        }
        info = info.trim();
        const lang = info.length > 0 ? info.split(/\s+/)[0] : '';
        const cls = lang.length > 0 ? ' class="language-' + escAttr(lang) + '"' : '';
        return '<pre><code' + cls + '>' + escText(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escText(content) + '</code></pre>\n';
    }
    case 'html':
      return b.lines.join('\n') + (b.trailingNl ? '\n' : '');
    case 'hr':
      return '<hr>\n';
    case 'table': {
      let h = '<table>\n<thead>\n<tr>\n';
      const headerCells = splitTableRow(b.header);
      for (let i = 0; i < b.align.length; i++) {
        const cell = i < headerCells.length ? headerCells[i] : '';
        h += '<th' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + inlineHtml(cell, refs, true) + '</th>\n';
      }
      h += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        h += '<tbody>';
        for (const row of b.rows) {
          const cells = splitTableRow(row);
          h += '<tr>\n';
          for (let i = 0; i < b.align.length; i++) {
            const cell = i < cells.length ? cells[i] : '';
            h += '<td' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' + inlineHtml(cell, refs, true) + '</td>\n';
          }
          h += '</tr>\n';
        }
        h += '</tbody>';
      }
      return h + '</table>\n';
    }
    default:
      return '';
  }
}

// ------------------------------------------------------------ entry point
export function parse(markdown) {
  inLinkState = false;
  if (!gateAllows(markdown)) return marked.parse(markdown);
  const src = markdown.replace(/\r\n?/g, '\n');
  const { blocks, refs } = parseBlocks(src);
  return renderBlocks(blocks, refs);
}
