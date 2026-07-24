// Shared static header + tab bar (served auth-exempt at /appheader.js; carries no
// secret -- the ?k= token is read from the HOST page's URL and only ever re-appended
// to same-origin links, exactly as each page already did with its own nav links).
//
// Every page used to hand-roll its own <div class="top"> with an h1, a "#sub" info
// span and an ad-hoc, inconsistent set of nav links (Library had 3, Collection had
// 5, Setup had a different 3). This replaces all of them with ONE bar so the
// surfaces stop drifting: same brand, same info slot, same tabs in the same order,
// and the current page's tab is visibly DEPRESSED so there is never a question of
// where you are.
//
// Usage (once per page, before the page's own load()):
//   AppHeader.mount({ active:'curate', token:K, info:'Loading…' });
//   AppHeader.setInfo('187 entries · 20 categories');
//
// COMPATIBILITY NOTE: the info slot is given id="sub" because every page already
// does document.getElementById('sub').textContent = ... . Pages must therefore
// delete their own #sub when they drop their old .top block, or the id collides.
(function () {
  // Order is the natural workflow: capture -> browse -> organise -> set up.
  const TABS = [
    { key: 'gallery',    href: '/gallery',        label: 'Staging',    icon: '📥' },
    { key: 'library',    href: '/library',        label: 'Library',    icon: '📚' },
    { key: 'curate',     href: '/curate',         label: 'Curate',     icon: '✎'  },
    { key: 'collection', href: '/collection',     label: 'Collection', icon: '🗃' },
    { key: 'categories', href: '/category-setup', label: 'Categories', icon: '⚙'  },
    { key: 'scan',       href: '/setup',          label: 'Scan',       icon: '📁' }
  ];

  const CSS = `
  .ah-bar{ position:sticky; top:0; z-index:800; background:#11131a; border-bottom:1px solid #2c313c;
           box-shadow:0 6px 18px rgba(0,0,0,.45); font-family:system-ui,sans-serif; }
  .ah-row1{ display:flex; align-items:center; gap:.8rem; padding:.55rem 1.25rem .45rem; flex-wrap:wrap; }
  .ah-brand{ display:flex; align-items:baseline; gap:.5rem; font-weight:700; color:#fff; font-size:1.05rem; white-space:nowrap; }
  .ah-brand .ah-mark{ font-size:1.1rem; }
  .ah-brand .ah-page{ font-weight:600; color:#9ec5ff; font-size:.95rem; }
  .ah-brand .ah-sep{ color:#3a4150; font-weight:400; }
  .ah-info{ color:#8b93a0; font-size:.85rem; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ah-grow{ flex:1 1 auto; }
  .ah-scan{ display:inline-flex; align-items:center; gap:.4rem; cursor:pointer; text-decoration:none; white-space:nowrap;
            background:#1b3a5c; border:1px solid #3b6ea5; color:#cfe6ff; border-radius:8px; padding:.35rem .8rem; font-size:.84rem; font-weight:600; }
  .ah-scan:hover{ background:#245084; border-color:#5b93d0; }

  /* Tab strip. The active tab is DEPRESSED: pushed down a pixel, darkened, inset
     shadow, and its bottom border removed so it reads as continuous with the page
     body below it. That's the whole point -- "which page am I on" at a glance. */
  .ah-tabs{ display:flex; gap:.25rem; padding:0 1.25rem; overflow-x:auto; scrollbar-width:thin; }
  .ah-tab{ position:relative; top:1px; display:inline-flex; align-items:center; gap:.4rem; white-space:nowrap;
           text-decoration:none; color:#aab3c0; font-size:.86rem; font-weight:600;
           background:#171a22; border:1px solid #2c313c; border-bottom-color:transparent;
           border-radius:8px 8px 0 0; padding:.4rem .95rem .45rem; transition:background .12s, color .12s, transform .08s; }
  .ah-tab:hover{ background:#1e222c; color:#e8eaed; }
  .ah-tab.ah-on{ background:#14161a; color:#fff; border-color:#2c313c; border-bottom-color:#14161a;
                 box-shadow:inset 0 3px 8px rgba(0,0,0,.55); transform:translateY(1px); cursor:default; }
  .ah-tab.ah-on .ah-ic{ filter:none; }
  .ah-tab .ah-ic{ font-size:.95em; filter:grayscale(.35); }
  @media (max-width:720px){ .ah-tab .ah-lb{ display:none; } .ah-tab{ padding:.4rem .7rem .45rem; } }`;

  let infoEl = null;

  function q(token) { return token ? `?k=${encodeURIComponent(token)}` : ''; }

  const AppHeader = {
    tabs: TABS,

    // opts: { active, token, info?, title? }
    mount(opts) {
      opts = opts || {};
      const token = opts.token || new URLSearchParams(location.search).get('k') || '';
      const kq = q(token);
      const cur = TABS.find(t => t.key === opts.active);

      const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

      const bar = document.createElement('div');
      bar.className = 'ah-bar';
      bar.innerHTML =
        `<div class="ah-row1">
           <span class="ah-brand"><span class="ah-mark">🗂</span>LoRA Librarian` +
             (cur ? `<span class="ah-sep">/</span><span class="ah-page">${opts.title || cur.label}</span>` : '') +
           `</span>
           <span class="ah-info" id="sub"></span>
           <span class="ah-grow"></span>
           <a class="ah-scan" id="ahScan" href="/setup${kq}${kq ? '&' : '?'}new=1" title="Hash any new .safetensors in your LoRA folder and match them to Civitai">🔄 Scan for new additions</a>
         </div>
         <div class="ah-tabs">` +
           TABS.map(t => {
             const on = t.key === opts.active;
             return `<a class="ah-tab${on ? ' ah-on' : ''}" href="${on ? 'javascript:void 0' : t.href + kq}"` +
                    `${on ? ' aria-current="page"' : ''}><span class="ah-ic">${t.icon}</span><span class="ah-lb">${t.label}</span></a>`;
           }).join('') +
         `</div>`;

      // Bleed the bar out to the window edges regardless of the host page's body
      // padding, and drop the body's top padding so `position:sticky; top:0`
      // actually pins to the viewport top rather than floating below a gap.
      const cs = getComputedStyle(document.body);
      const padL = cs.paddingLeft, padR = cs.paddingRight;
      bar.style.marginLeft = `-${padL}`;
      bar.style.marginRight = `-${padR}`;
      bar.style.marginTop = `-${cs.paddingTop}`;
      bar.style.marginBottom = '1rem';
      document.body.insertBefore(bar, document.body.firstChild);

      infoEl = bar.querySelector('#sub');
      if (opts.info) infoEl.textContent = opts.info;
      return bar;
    },

    setInfo(text) { if (infoEl) infoEl.textContent = text == null ? '' : String(text); },

    // Same-origin link with the capability token re-attached -- for pages that
    // still need to build their own cross-page links (e.g. a CTA in the body).
    link(routePath, token) { return routePath + q(token || new URLSearchParams(location.search).get('k') || ''); }
  };

  window.AppHeader = AppHeader;
})();
