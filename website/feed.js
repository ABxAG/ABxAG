/* ABxAG release feed — dependency-free.
 * Reads GitHub API shape AND the mirror shape (releases.json), so the
 * version list works even where api.github.com is blocked. Same
 * normalization as electron/updates.cjs parseReleases. */
(function () {
  'use strict';
  function norm(list) {
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object' || r.draft) continue;
      const tag = r.tag_name || r.tag || '';
      const version = String(tag).replace(/^[vV]/, '');
      if (!version) continue;
      const assets = Array.isArray(r.assets) ? r.assets : [];
      const pick = (re) => assets.find((a) => re.test(a.name || ''));
      const url = (a) => (a && (a.browser_download_url || a.url)) || '';
      const setup = pick(/-Setup-.*\.exe$/i);
      const portable = pick(/-Portable-.*\.exe$/i);
      out.push({
        version,
        name: String(r.name || r.title || tag || ''),
        notes: String(r.body || r.notes || ''),
        date: r.published_at || r.date || null,
        prerelease: Boolean(r.prerelease),
        setup: setup ? { name: setup.name, url: url(setup), size: setup.size || 0 } : null,
        portable: portable ? { name: portable.name, url: url(portable), size: portable.size || 0 } : null,
      });
    }
    const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
    out.sort((a, b) => {
      const pa = parts(a.version), pb = parts(b.version);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });
    return out;
  }
  async function getJSON(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }
  async function load(base) {
    // 1) Bundled snapshot (always shippable). 2) Same-directory refresh.
    // 3) Site mirrors. 4) GitHub API last (blocked on some networks).
    const urls = [
      base + 'releases.json',
      'https://abxag.absup.dev/releases.json',
      'https://abxag.pages.dev/releases.json',
      'https://api.github.com/ABxAG/ABxAG/releases?per_page=30',
    ];
    for (const u of urls) {
      try {
        const rels = norm(await getJSON(u));
        if (rels.length) return rels;
      } catch (e) { /* try next mirror */ }
    }
    return [];
  }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtDate(iso) { try { return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; } catch (e) { return ''; } }
  /* Minimal markdown for release notes: ##/### headings, **bold**, `code`,
     - bullets, blank-line paragraphs. Everything escaped first. */
  function md(src, maxChars) {
    let text = String(src || '');
    const max = maxChars || 1200;
    // Cut on a word boundary so previews never end mid-word.
    if (text.length > max) {
      const cut = text.slice(0, max).replace(/\s+\S*$/, '');
      text = (cut || text.slice(0, max)) + ' …';
    }
    const lines = text.split('\n');
    let html = '', inList = false;
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    for (const line of lines) {
      const h3 = line.match(/^###\s+(.*)/);
      const h2 = line.match(/^##\s+(.*)/);
      const li = line.match(/^[-*]\s+(.*)/);
      if (h3 || h2) {
        if (inList) { html += '</ul>'; inList = false; }
        html += h3 ? '<div class="md-h">' + inline(h3[1]) + '</div>' : '<div class="md-h2">' + inline(h2[1]) + '</div>';
      } else if (li) {
        if (!inList) { html += '<ul class="md-ul">'; inList = true; }
        html += '<li>' + inline(li[1]) + '</li>';
      } else if (line.trim() === '') {
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + inline(line) + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }
  /* Clamp long notes with a Read more / Show less toggle. Call with the
     rendered list element after cards are in the DOM. */
  function wireClamp(scope) {
    const root = scope || document;
    const blocks = root.querySelectorAll ? root.querySelectorAll('.notes.clamp') : [];
    Array.prototype.forEach.call(blocks, (el) => {
      if (el.querySelector('.read-btn')) return;
      // Overflow check needs layout; run after paint.
      requestAnimationFrame(() => {
        if (el.scrollHeight <= el.clientHeight + 8) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'read-btn';
        btn.textContent = 'Read more';
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', () => {
          const open = el.classList.toggle('open');
          btn.textContent = open ? 'Show less' : 'Read more';
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // Outside the clamped box (it has overflow:hidden).
        el.parentNode.appendChild(btn);
      });
    });
  }
  window.ABxAGFeed = { load, mb, esc, fmtDate, md, wireClamp };
})();
