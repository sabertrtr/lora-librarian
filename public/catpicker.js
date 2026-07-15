// Shared category picker + "create new category" popup for the collection and
// gallery cards. Replaces a native <select> whose long nested option names spill
// off the panel: this dropdown is width-clamped to the viewport and scrolls.
//
// Usage:
//   CatPicker.init({ headers, categories });           // once per page
//   const ctrl = CatPicker.create(hostEl, { value, placeholder, onChange });
//   ctrl.getValue();  ctrl.setValue('character');
(function () {
  let headers = {};
  let categories = [];
  let dropdown, listEl, filterEl, popup, active = null, lastCreated = null, popupArm = null;

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const CSS = `
  .cp-btn{ background:#0f1116; border:1px solid #2c313c; border-radius:8px; color:#fff; padding:.3rem .55rem;
           font:inherit; font-size:.84rem; cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; min-width:9rem; max-width:100%; }
  .cp-btn .cp-cur{ flex:1; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cp-btn.unset{ border-color:#c8912f; color:#ffcf7a; }
  .cp-btn .cp-caret{ color:#8b93a0; font-size:.7em; }
  .cp-dd{ position:fixed; z-index:9997; background:#161a22; border:1px solid #2c313c; border-radius:10px;
          box-shadow:0 12px 40px rgba(0,0,0,.62); padding:6px; display:none; flex-direction:column; gap:5px; }
  .cp-filter{ background:#0f1116; border:1px solid #2c313c; border-radius:6px; color:#fff; padding:.32rem .45rem; font:inherit; font-size:.82rem; }
  .cp-list{ max-height:min(320px,52vh); overflow-y:auto; display:flex; flex-direction:column; }
  .cp-item{ padding:.32rem .5rem; border-radius:6px; cursor:pointer; font-size:.82rem; color:#dfe4ea; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cp-item:hover{ background:#222838; }
  .cp-item.sel{ background:#2a3550; color:#fff; }
  .cp-item.justmade{ background:rgba(53,199,110,.18); color:#9ff0bf; }
  .cp-item.cp-new{ color:#9ec5ff; border-top:1px solid #2c313c; border-radius:0; margin-top:3px; padding-top:.42rem; }
  .cp-modal{ position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,.62); display:none; align-items:flex-start; justify-content:center; padding:8vh 3vw; }
  .cp-box{ background:#1c1f26; border:1px solid #2c313c; border-radius:12px; width:min(430px,96vw); padding:16px; display:flex; flex-direction:column; gap:11px; font:13px/1.4 system-ui,sans-serif; color:#e8eaed; }
  .cp-h{ font-size:1rem; font-weight:700; color:#fff; }
  .cp-l{ display:flex; flex-direction:column; gap:4px; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; color:#8b93a0; }
  .cp-l select,.cp-l input{ background:#0f1116; border:1px solid #2c313c; border-radius:8px; color:#fff; padding:.42rem .5rem; font:inherit; font-size:.86rem; text-transform:none; letter-spacing:0; }
  .cp-msg{ font-size:.76rem; color:#ffcf7a; }
  .cp-chk{ display:flex; gap:.5rem; align-items:center; font-size:.82rem; color:#dfe4ea; cursor:pointer; }
  .cp-actions{ display:flex; gap:.6rem; justify-content:flex-end; align-items:center; margin-top:2px; }
  .cp-cancel{ background:#20242d; border:1px solid #4b5563; color:#e8eaed; border-radius:8px; padding:.4rem .85rem; cursor:pointer; font:inherit; }
  .cp-create{ position:relative; overflow:hidden; background:#1f8b4c; border:none; color:#fff; border-radius:8px;
              padding:.4rem 1.1rem; cursor:not-allowed; opacity:.5; filter:grayscale(.6); font:inherit; transition:opacity .15s,filter .15s,transform .12s; }
  .cp-create.armed{ opacity:1; cursor:pointer; filter:none; box-shadow:0 0 0 2px rgba(53,199,110,.5); }
  .cp-create.armed:hover{ transform:scale(1.04); }
  .cp-create .cp-bar{ position:absolute; left:0; bottom:0; height:3px; width:0; background:rgba(255,255,255,.85); }
  .cp-create.counting .cp-bar{ width:100%; transition:width 2s linear; }
  .cp-err{ color:#ff9090; font-size:.78rem; min-height:1em; }`;

  function build() {
    if (dropdown) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    dropdown = document.createElement('div');
    dropdown.className = 'cp-dd';
    dropdown.innerHTML = '<input class="cp-filter" placeholder="filter categories…" autocomplete="off"><div class="cp-list"></div>';
    document.body.appendChild(dropdown);
    listEl = dropdown.querySelector('.cp-list');
    filterEl = dropdown.querySelector('.cp-filter');
    filterEl.addEventListener('input', () => renderList(filterEl.value));
    dropdown.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => closeDropdown());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDropdown(); closePopup(); } });

    popup = document.createElement('div');
    popup.className = 'cp-modal';
    popup.innerHTML =
      '<div class="cp-box" onclick="event.stopPropagation()">' +
        '<div class="cp-h">Create a category</div>' +
        '<label class="cp-l">Parent category<select class="cp-parent"></select></label>' +
        '<label class="cp-l">Category name<input class="cp-name" placeholder="e.g. azur_lane" autocomplete="off"></label>' +
        '<div class="cp-msg">This action will create a root-level category.</div>' +
        '<label class="cp-chk"><input type="checkbox" class="cp-return" checked> Select this Category and Return to Lora Page</label>' +
        '<div class="cp-actions"><button class="cp-cancel">Cancel</button>' +
          '<button class="cp-create">Create<span class="cp-bar"></span></button></div>' +
        '<div class="cp-err"></div>' +
      '</div>';
    document.body.appendChild(popup);
    popup.addEventListener('click', () => closePopup());
    popup.querySelector('.cp-parent').addEventListener('change', updateMsg);
    popup.querySelector('.cp-cancel').addEventListener('click', closePopup);
    popup.querySelector('.cp-create').addEventListener('click', () => {
      if (popup.querySelector('.cp-create').classList.contains('armed')) doCreate();
    });
  }

  function renderList(filter) {
    const f = (filter || '').toLowerCase();
    const cur = active && active.controller.getValue();
    listEl.innerHTML = '';
    for (const c of categories) {
      if (c === lastCreated) continue;                 // shown pinned below instead
      if (f && !c.toLowerCase().includes(f)) continue;
      listEl.appendChild(item(c, c === cur, false));
    }
    if (lastCreated && (!f || lastCreated.toLowerCase().includes(f))) {
      listEl.appendChild(item(lastCreated, lastCreated === cur, true));   // just above "create new"
    }
    const nw = document.createElement('div');
    nw.className = 'cp-item cp-new';
    nw.textContent = '＋ create new category';
    nw.addEventListener('click', e => { e.stopPropagation(); openPopup(); });
    listEl.appendChild(nw);
  }
  function item(c, sel, justmade) {
    const el = document.createElement('div');
    el.className = 'cp-item' + (sel ? ' sel' : '') + (justmade ? ' justmade' : '');
    el.textContent = c;
    el.addEventListener('click', e => { e.stopPropagation(); pick(c); });
    return el;
  }

  function pick(c) {
    if (active) { active.controller._set(c); if (active.controller._onChange) active.controller._onChange(c); }
    closeDropdown();
  }

  function positionDropdown(button) {
    dropdown.style.display = 'flex';
    const r = button.getBoundingClientRect();
    const w = Math.min(360, Math.max(220, r.width));
    dropdown.style.width = w + 'px';
    dropdown.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    const dh = dropdown.offsetHeight;
    let top = r.bottom + 4;
    if (top + dh > window.innerHeight - 8) top = Math.max(8, r.top - dh - 4);
    dropdown.style.top = top + 'px';
  }

  function openDropdown(controller, button) {
    build();
    active = { controller, button };
    filterEl.value = '';
    renderList('');
    positionDropdown(button);
    const sel = listEl.querySelector('.cp-item.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
    filterEl.focus();
  }
  function closeDropdown() { if (dropdown) dropdown.style.display = 'none'; }

  function updateMsg() {
    popup.querySelector('.cp-msg').style.display = popup.querySelector('.cp-parent').value ? 'none' : 'block';
  }
  function err(m) { popup.querySelector('.cp-err').textContent = m || ''; }

  function openPopup() {
    build();
    const psel = popup.querySelector('.cp-parent');
    psel.innerHTML = '<option value="">(none — root level)</option>' +
      categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const cur = active && active.controller.getValue();
    if (cur && categories.includes(cur)) psel.value = cur;
    popup.querySelector('.cp-name').value = '';
    popup.querySelector('.cp-return').checked = true;
    updateMsg(); err('');
    popup.style.display = 'flex';
    const cbtn = popup.querySelector('.cp-create');
    cbtn.classList.remove('armed', 'counting');
    requestAnimationFrame(() => cbtn.classList.add('counting'));
    clearTimeout(popupArm);
    popupArm = setTimeout(() => cbtn.classList.add('armed'), 2000);
    popup.querySelector('.cp-name').focus();
  }
  function closePopup() { if (popup) popup.style.display = 'none'; clearTimeout(popupArm); }

  async function doCreate() {
    const parent = popup.querySelector('.cp-parent').value;
    const name = popup.querySelector('.cp-name').value.trim();
    const ret = popup.querySelector('.cp-return').checked;
    if (!name) { err('enter a category name'); return; }
    err('');
    try {
      const r = await fetch('/categories/create', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent, name })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      categories = (d.categories || []).slice().sort();
      lastCreated = d.key;
      closePopup();
      if (ret) {
        // "Select this Category and Return to Lora Page"
        if (active) { active.controller._set(d.key); if (active.controller._onChange) active.controller._onChange(d.key); }
        closeDropdown();
      } else {
        // back to the list, cursor centered on "create new", new category just above it
        if (active) {
          renderList('');
          positionDropdown(active.button);
          const nw = listEl.querySelector('.cp-new');
          if (nw) nw.scrollIntoView({ block: 'center' });
        }
      }
    } catch (e) { err('' + e.message); }
  }

  const CatPicker = {
    init(opts) { headers = (opts && opts.headers) || {}; categories = ((opts && opts.categories) || []).slice().sort(); build(); },
    setCategories(list) { categories = (list || []).slice().sort(); },
    create(hostEl, opts) {
      build();
      opts = opts || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-btn';
      btn.innerHTML = '<span class="cp-cur"></span><span class="cp-caret">▾</span>';
      const controller = {
        el: btn,
        _value: '',
        _onChange: opts.onChange,
        _placeholder: opts.placeholder || '— select —',
        getValue() { return this._value; },
        setValue(v) { this._set(v); },
        _set(v) {
          this._value = v || '';
          btn.querySelector('.cp-cur').textContent = this._value || this._placeholder;
          btn.classList.toggle('unset', !this._value);
        }
      };
      controller._set(opts.value || '');
      btn.addEventListener('click', e => { e.stopPropagation(); openDropdown(controller, btn); });
      hostEl.appendChild(btn);
      return controller;
    },

    // THE shared "re-categorize a catalogued model" control. Same picker as when
    // assigning a category, but on pick it moves the entry (POST /recategorize by
    // stem + current category) and reports back. Use this identically on every
    // card surface so there's one repeatable UX and no platform drift.
    // opts: { stem, category, onDone(newCat), onError(msg) }
    recategorize(hostEl, opts) {
      opts = opts || {};
      let category = opts.category || '';
      const ctrl = CatPicker.create(hostEl, {
        value: category,
        placeholder: opts.placeholder || '— category —',
        onChange: async (picked) => {
          if (!picked || picked === category) return;
          const prev = category;
          try {
            const r = await fetch('/recategorize', {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ stem: opts.stem, fromCategory: prev, toCategory: picked })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
            category = picked;
            if (opts.onDone) opts.onDone(picked);
          } catch (e) {
            ctrl.setValue(prev);          // revert the button on failure
            if (opts.onError) opts.onError(e.message); else alert('Re-categorize failed: ' + e.message);
          }
        }
      });
      return ctrl;
    }
  };
  window.CatPicker = CatPicker;
})();
