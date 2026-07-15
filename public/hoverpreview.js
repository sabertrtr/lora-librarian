// Shared hover-preview window for lora thumbnails (library + collection + search).
// - appears 2s after the cursor settles on a thumb, centered on the cursor
// - image fills the window; ‹ › arrows + counter + a mouse-wheel toggle are
//   overlaid on it (shown only when the model has >1 image)
// - tabs through the model's other gallery images via ‹ › buttons, ← → keys,
//   and (when the overlaid mouse-wheel toggle is lit green) the mouse wheel
// - swaps images flash-free: the visible <img> stays hidden until the NEW image
//   has fully decoded, and a generation counter drops stale loads, so the
//   previous full-size image is never shown under a newer request
// Usage: HoverPreview.init({ headers }); then HoverPreview.bind(thumbEl) where the
// element carries data-full (first full url), data-version and/or data-model.
(function () {
  const WHEEL_KEY = 'hp_wheel';
  const HOVER_KEY = 'hp_seconds';   // shared open-delay + despawn-delay (user-set on the image)
  const RING_C = 2 * Math.PI * 15;  // despawn-ring circumference
  function loadHoverMs(){ const v = parseFloat(localStorage.getItem(HOVER_KEY)); return (v && v > 0) ? Math.min(Math.max(v, 0.5), 30) * 1000 : 2000; }
  let hoverMs = loadHoverMs();
  // mouse body + scroll wheel + up/down arrows, drawn with currentColor so the
  // toggle can recolor it (green+glow ON, gray OFF).
  const WHEEL_SVG =
    '<svg viewBox="0 0 28 40" width="19" height="27" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M10 7 L14 3 L18 7"/>' +
    '<rect x="7" y="10" width="14" height="20" rx="7"/>' +
    '<line x1="14" y1="13.5" x2="14" y2="17.5"/>' +
    '<path d="M10 33 L14 37 L18 33"/></svg>';
  let headers = {};
  let win, imgEl, counterEl, spinner, wheelBtn, cue, ringFg, secsEl, secsInput;
  let wheelOn = false;
  let lastX = 0, lastY = 0;
  let showTimer = null, hideTimer = null, despawnTimer = null;
  let current = null;          // { key, images:[{full,...}], index }
  let gen = 0;                 // bumped on every image swap AND on hide
  let positioned = false;      // window placement is locked after the first image
                               // of an open session, so ‹ ›/arrow/wheel nav does
                               // NOT make the window chase the cursor
  const cache = new Map();     // key -> images[]

  document.addEventListener('mousemove', e => { lastX = e.clientX; lastY = e.clientY; });

  const CSS = `
  #hpWin{ position:fixed; z-index:9999; display:none; background:#0b0d11; border:2px solid #3a4152;
          border-radius:12px; box-shadow:0 14px 52px rgba(0,0,0,.82); padding:0; overflow:hidden; }
  #hpWin .hp-imgwrap{ position:relative; line-height:0; min-width:120px; min-height:80px; }
  #hpWin .hp-img{ display:block; max-width:46vw; max-height:86vh; }
  #hpWin .hp-spin{ position:absolute; inset:0; display:none; align-items:center; justify-content:center;
                   color:#8b93a0; font:12px system-ui,sans-serif; }
  /* overlay controls: shown only when the model has >1 image */
  #hpWin .hp-nav{ position:absolute; top:50%; transform:translateY(-50%); display:none; align-items:center;
                  justify-content:center; width:2.6rem; height:3.6rem; border:none; border-radius:10px;
                  background:rgba(0,0,0,.4); color:#fff; font-size:2.4rem; line-height:1; cursor:pointer; }
  #hpWin .hp-nav:hover{ background:rgba(0,0,0,.64); }
  #hpWin .hp-prev{ left:8px; } #hpWin .hp-next{ right:8px; }
  #hpWin .hp-bottom{ position:absolute; left:0; right:0; bottom:10px; display:none; flex-direction:column;
                     align-items:center; gap:6px; }
  #hpWin.multi .hp-nav{ display:flex; }
  #hpWin.multi .hp-bottom{ display:flex; }
  #hpWin .hp-count{ background:rgba(0,0,0,.6); color:#fff; border-radius:999px; padding:2px 12px;
                    font:600 12px system-ui,sans-serif; letter-spacing:.02em; }
  #hpWin .hp-wheel{ background:rgba(0,0,0,.55); border:1px solid rgba(255,255,255,.22); border-radius:9px;
                    padding:3px 7px; color:#7a828e; cursor:pointer; display:inline-flex; align-items:center; line-height:0;
                    transition:color .15s, box-shadow .15s, border-color .15s; }
  #hpWin .hp-wheel.on{ color:#35c76e; border-color:#35c76e; box-shadow:0 0 12px rgba(53,199,110,.75); }
  /* auto-close ring (bottom-right): full while hovering, empties over the despawn
     time once the cursor leaves; click it to set that time */
  #hpWin .hp-despawn{ position:absolute; right:8px; bottom:8px; display:flex; align-items:center; gap:5px;
                      background:none; border:none; padding:0; cursor:pointer; }
  #hpWin .hp-despawn svg{ display:block; filter:drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  #hpWin .hp-despawn .ring-fg{ stroke-dasharray:${RING_C}; stroke-dashoffset:0; }
  #hpWin .hp-secs{ color:#cbd5e1; font:600 11px system-ui,sans-serif; background:rgba(0,0,0,.55); border-radius:6px; padding:1px 5px; }
  #hpWin .hp-setsecs{ position:absolute; right:8px; bottom:40px; display:none; width:5.5rem; background:#0b0d11;
                      border:1px solid #3a4152; border-radius:7px; color:#fff; font:12px system-ui; padding:3px 6px; }
  #hpWin .hp-setsecs.on{ display:block; }
  /* on-thumbnail "full image about to load" cue: a highlight ring + a translucent
     alpha wipe that fills the ENTIRE thumbnail over the open-delay, so it's obvious */
  #hpCue{ position:fixed; z-index:9998; display:none; pointer-events:none; border-radius:12px;
          box-shadow:0 0 0 2px rgba(158,197,255,.85) inset, 0 0 16px rgba(158,197,255,.35); }
  #hpCue .hp-cuebar{ position:absolute; inset:0; width:0; background:rgba(158,197,255,.30); border-radius:11px; }
  #hpCue.run .hp-cuebar{ width:100%; }
  #hpCue.snap .hp-cuebar{ width:100%; transition:none !important; background:rgba(158,197,255,.48); }`;

  function build() {
    if (win) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    win = document.createElement('div');
    win.id = 'hpWin';
    win.innerHTML =
      '<div class="hp-imgwrap">' +
        '<img class="hp-img" alt="">' +
        '<div class="hp-spin">loading…</div>' +
        '<button class="hp-nav hp-prev" data-d="-1" title="Previous (←)">‹</button>' +
        '<button class="hp-nav hp-next" data-d="1" title="Next (→)">›</button>' +
        '<div class="hp-bottom">' +
          '<div class="hp-count"></div>' +
          '<button class="hp-wheel" title="Toggle mousewheel image scroll">' + WHEEL_SVG + '</button>' +
        '</div>' +
        '<button class="hp-despawn" title="Click to set the auto-close time">' +
          '<svg viewBox="0 0 36 36" width="26" height="26">' +
            '<circle cx="18" cy="18" r="15" fill="rgba(0,0,0,.5)" stroke="rgba(255,255,255,.25)" stroke-width="2"/>' +
            '<circle class="ring-fg" cx="18" cy="18" r="15" fill="none" stroke="#9ec5ff" stroke-width="3" stroke-linecap="round" transform="rotate(-90 18 18)"/>' +
          '</svg><span class="hp-secs"></span>' +
        '</button>' +
        '<input class="hp-setsecs" type="number" min="0.5" max="30" step="0.5" title="auto-close seconds">' +
      '</div>';
    document.body.appendChild(win);
    imgEl = win.querySelector('.hp-img');
    counterEl = win.querySelector('.hp-count');
    spinner = win.querySelector('.hp-spin');
    ringFg = win.querySelector('.ring-fg');
    secsEl = win.querySelector('.hp-secs');
    secsInput = win.querySelector('.hp-setsecs');
    updateSecsLabel();
    win.querySelector('.hp-despawn').addEventListener('click', e => { e.stopPropagation(); openSecs(); });
    secsInput.addEventListener('click', e => e.stopPropagation());
    secsInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') applySecs(); });
    secsInput.addEventListener('change', applySecs);
    secsInput.addEventListener('blur', () => secsInput.classList.remove('on'));
    wheelBtn = win.querySelector('.hp-wheel');
    wheelOn = localStorage.getItem(WHEEL_KEY) === '1';
    wheelBtn.classList.toggle('on', wheelOn);
    wheelBtn.addEventListener('click', e => {
      e.stopPropagation();
      wheelOn = !wheelOn;
      wheelBtn.classList.toggle('on', wheelOn);
      localStorage.setItem(WHEEL_KEY, wheelOn ? '1' : '0');
    });
    win.querySelectorAll('.hp-nav').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); nav(parseInt(b.dataset.d, 10)); }));
    win.addEventListener('mouseenter', () => { clearTimeout(hideTimer); cancelDespawn(); });
    win.addEventListener('mouseleave', startDespawn);
    win.addEventListener('wheel', e => {
      if (!current) return;
      if (wheelOn) { e.preventDefault(); nav(e.deltaY > 0 ? 1 : -1); }
    }, { passive: false });

    cue = document.createElement('div');
    cue.id = 'hpCue';
    cue.innerHTML = '<div class="hp-cuebar"></div>';
    document.body.appendChild(cue);
  }

  // Overlay a highlight ring + a 2s progress bar on the thumb the cursor is over,
  // signalling the full image is about to load. snapCue() completes it instantly
  // (on click); hideCue() clears it.
  function showCue(el) {
    if (!cue) return;
    const r = el.getBoundingClientRect();
    cue.style.left = r.left + 'px'; cue.style.top = r.top + 'px';
    cue.style.width = r.width + 'px'; cue.style.height = r.height + 'px';
    cue.style.display = 'block';
    cue.classList.remove('run', 'snap');
    const bar = cue.querySelector('.hp-cuebar');
    bar.style.transition = 'width ' + hoverMs + 'ms linear';   // match the open-delay
    void cue.offsetWidth;                 // reflow so the width transition restarts
    cue.classList.add('run');
  }
  function snapCue() { if (cue) { cue.classList.remove('run'); cue.classList.add('snap'); } }
  function hideCue() { if (cue) { cue.style.display = 'none'; cue.classList.remove('run', 'snap'); } }

  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 160); }
  function hide() { clearTimeout(despawnTimer); if (win) win.style.display = 'none'; current = null; gen++; positioned = false; }

  // Despawn: leaving the window empties the ring over hoverMs, then hides. Any
  // re-entry cancels it (ring snaps back to full).
  function startDespawn() {
    clearTimeout(hideTimer);
    if (!win || win.style.display !== 'block' || !current) return;
    if (ringFg) {
      ringFg.style.transition = 'none'; ringFg.style.strokeDashoffset = '0';
      void ringFg.getBoundingClientRect();
      ringFg.style.transition = 'stroke-dashoffset ' + hoverMs + 'ms linear';
      ringFg.style.strokeDashoffset = String(RING_C);
    }
    clearTimeout(despawnTimer);
    despawnTimer = setTimeout(hide, hoverMs);
  }
  function cancelDespawn() {
    clearTimeout(despawnTimer);
    if (ringFg) { ringFg.style.transition = 'none'; ringFg.style.strokeDashoffset = '0'; }
  }
  function updateSecsLabel() { if (secsEl) secsEl.textContent = (hoverMs / 1000).toString().replace(/\.0$/, '') + 's'; }
  function openSecs() { cancelDespawn(); secsInput.value = hoverMs / 1000; secsInput.classList.add('on'); secsInput.focus(); secsInput.select(); }
  function applySecs() {
    let v = parseFloat(secsInput.value);
    if (!(v > 0)) v = hoverMs / 1000;
    v = Math.min(Math.max(v, 0.5), 30);
    hoverMs = v * 1000;
    localStorage.setItem(HOVER_KEY, String(v));
    updateSecsLabel();
    secsInput.classList.remove('on');
  }

  function reposition() {
    if (!win) return;
    const w = win.offsetWidth, h = win.offsetHeight, m = 8;
    let left = lastX - w / 2, top = lastY - h / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - w - m));
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    win.style.left = left + 'px';
    win.style.top = top + 'px';
  }

  // Flash-free swap: keep the current image hidden until the requested one has
  // loaded; a stale onload (older gen) is ignored so a slow previous image can
  // never flash in over a newer one.
  function setImage(url) {
    const my = ++gen;
    imgEl.style.visibility = 'hidden';
    spinner.style.display = 'flex';
    const pre = new Image();
    pre.onload = () => {
      if (my !== gen) return;
      imgEl.src = url;
      imgEl.style.visibility = 'visible';
      spinner.style.display = 'none';
      // Center on the cursor only for the first image of a session; keep the
      // window fixed for every subsequent nav so it doesn't follow the cursor.
      if (!positioned) { reposition(); positioned = true; }
    };
    pre.onerror = () => { if (my === gen) { spinner.textContent = '(image failed)'; } };
    pre.src = url;
  }

  function updateCounter() {
    if (!current) return;
    const n = current.images.length;
    counterEl.textContent = n ? (current.index + 1) + ' / ' + n : '';
    win.classList.toggle('multi', n > 1);   // reveals overlay arrows + bottom controls
  }

  function nav(d) {
    if (!current || current.images.length < 2) return;
    const n = current.images.length;
    current.index = (current.index + d + n) % n;
    setImage(current.images[current.index].full);
    updateCounter();
  }

  async function fetchImages(key, versionId, modelId) {
    if (cache.has(key)) return cache.get(key);
    const qs = versionId ? 'versionId=' + encodeURIComponent(versionId) : 'modelId=' + encodeURIComponent(modelId);
    const r = await fetch('/model-images?' + qs, { headers });
    if (!r.ok) throw new Error(r.status);
    const imgs = (await r.json()).images || [];
    cache.set(key, imgs);
    return imgs;
  }

  async function show(el) {
    build();
    const versionId = el.dataset.version || '';
    const modelId = el.dataset.model || '';
    const firstFull = el.dataset.full || '';
    if (!firstFull && !versionId && !modelId) return;
    const key = versionId ? 'v' + versionId : 'm' + modelId;

    win.style.display = 'block';
    positioned = false;          // re-center once for this new open, then lock
    cancelDespawn();             // ring starts full
    if (secsInput) secsInput.classList.remove('on');
    current = { key, images: firstFull ? [{ full: firstFull }] : [], index: 0 };
    if (firstFull) setImage(firstFull);
    else { imgEl.style.visibility = 'hidden'; spinner.style.display = 'flex'; }
    updateCounter();
    reposition();

    if (!versionId && !modelId) return;
    try {
      const full = await fetchImages(key, versionId, modelId);
      if (!current || current.key !== key) return;   // user already moved on
      if (full.length) {
        let idx = firstFull ? full.findIndex(i => i.full === firstFull) : 0;
        if (idx < 0) idx = 0;
        current.images = full;
        current.index = idx;
        updateCounter();
        if (!firstFull) setImage(full[0].full);       // no seed image yet -> show first now
      }
    } catch (e) { /* keep the single seed image */ }
  }

  document.addEventListener('keydown', e => {
    if (!win || win.style.display !== 'block' || !current) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
    else if (e.key === 'Escape') { hide(); }
  });
  // Clicking anywhere off the window instantly despawns it (a click on a hover
  // thumb is exempt -- that opens/reopens the window instead).
  document.addEventListener('click', e => {
    if (!win || win.style.display !== 'block') return;
    if (win.contains(e.target)) return;
    if (e.target.closest && e.target.closest('[data-hp]')) return;
    hide();
  });

  window.HoverPreview = {
    init(opts) { headers = (opts && opts.headers) || {}; build(); },
    bind(el) {
      el.dataset.hp = '1';                 // marks a hover thumb: its own click opens, not closes
      el.addEventListener('mouseenter', () => {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showCue(el);
        showTimer = setTimeout(() => { hideCue(); show(el); }, hoverMs);
      });
      el.addEventListener('mouseleave', () => {
        clearTimeout(showTimer);
        hideCue();
        scheduleHide();
      });
      // A click short-circuits the 2s wait: snap the cue to complete, open now.
      el.addEventListener('click', () => {
        clearTimeout(showTimer);
        snapCue();
        show(el);
        setTimeout(hideCue, 150);
      });
    }
  };
})();
