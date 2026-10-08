(() => {
  'use strict';

  /* ---------------- Configuration ---------------- */
  const PDF_URL    = 'kalodon_numbers_comptabilite_fr.pdf';
  const PAGE_W     = 1280;   // dimensions d'une page (16:9)
  const PAGE_H     = 720;
  const RENDER_W   = 1920;   // largeur du canvas rendu (netteté vs mémoire)
  const FLIP_TIME  = 1000;   // durée de la pliure (ms), identique pour TOUTES les pages
  const SINGLE_MAX = 640;    // en dessous de cette largeur d'écran : 1 page à la fois (téléphone en portrait)
  const ZOOM_MAX   = 4;      // zoom maximum
  const HI_W       = 3840;   // largeur de rendu haute définition (pages visibles quand on zoome)
  const WINDOW     = 2;      // vues gardées en mémoire de chaque côté de la vue courante

  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const stageEl = document.getElementById('stage');
  const loader  = document.getElementById('loader');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const counter = document.getElementById('counter');
  let bookEl    = document.getElementById('book');

  // Le zoom crée lui-même son conteneur, ses boutons et son style :
  // le script reste fonctionnel même si index.html / style.css n'ont pas été mis à jour.
  function ensureZoomUI() {
    let z = document.getElementById('zoom');
    if (!z) {
      z = document.createElement('div');
      z.id = 'zoom';
      bookEl.parentNode.insertBefore(z, bookEl);
      z.appendChild(bookEl);
    }
    z.style.flex = 'none';
    z.style.transformOrigin = 'center center';
    stageEl.style.touchAction = 'none';

    if (!document.getElementById('zoom-style')) {
      const st = document.createElement('style');
      st.id = 'zoom-style';
      st.textContent = `
        .stage.is-zoomed { overflow: hidden; cursor: grab; }
        .stage.is-panning { cursor: grabbing; }
        .zoom-tools { position: absolute; top: 6px; right: 10px; display: flex; gap: 6px; z-index: 60; }
        .zbtn { min-width: 40px; height: 40px; padding: 0 10px; font-weight: 700; font-size: 1.25rem; line-height: 1;
                font-family: inherit; color: #fff; background: var(--green, #3bc49c); border: 2px solid var(--green, #3bc49c);
                border-radius: 999px; cursor: pointer; transition: background .2s, border-color .2s, opacity .2s; }
        .zbtn--pct { font-size: .85rem; min-width: 58px; }
        .zbtn:hover:not(:disabled), .zbtn:focus-visible { background: var(--blue-light, #0098DA); border-color: var(--blue-light, #0098DA); outline: none; }
        .zbtn:focus-visible { box-shadow: 0 0 0 3px #fff; }
        .zbtn:disabled { opacity: .4; cursor: default; }
        @media (max-height: 500px) { .zbtn { min-width: 32px; height: 32px; font-size: 1.05rem; } .zbtn--pct { font-size: .75rem; min-width: 50px; } }`;
      document.head.appendChild(st);
    }
    if (!document.getElementById('zoom-tools')) {
      const t = document.createElement('div');
      t.id = 'zoom-tools'; t.className = 'zoom-tools';
      t.setAttribute('role', 'group'); t.setAttribute('aria-label', 'Zoom');
      t.innerHTML =
        '<button type="button" id="zoom-out" class="zbtn" aria-label="Zoom arrière">−</button>' +
        '<button type="button" id="zoom-reset" class="zbtn zbtn--pct" aria-label="Réinitialiser le zoom">100%</button>' +
        '<button type="button" id="zoom-in" class="zbtn" aria-label="Zoom avant">+</button>';
      stageEl.appendChild(t);
    }
    return z;
  }
  const zoomEl  = ensureZoomUI();
  const zoomIn  = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomRst = document.getElementById('zoom-reset');

  let pdf = null;
  let items = [];            // une entrée par page du PDF : { num, canvas, status }
  let bookItems = [];        // item (ou null = page vide) par position dans le livre
  let pageFlip = null;
  let mode = 'spread';       // 'single' (téléphone portrait) | 'spread' (double page)
  let perView = 2;           // pages par vue : 1 ou 2
  let views = 0;             // nombre de vues
  let lastIsSingle = true;   // 4e de couverture seule (mode double page, nb de pages pair)
  let building = false;

  const isSingle = () => window.innerWidth < SINGLE_MAX;

  /* ---------------- Rendu PDF -> canvas (paresseux) ---------------- */
  async function draw(item) {
    if (!item || item.status !== 'idle') return;
    item.status = 'busy';
    try {
      const page = await pdf.getPage(item.num);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RENDER_W / base.width });
      item.canvas.width  = Math.round(viewport.width);
      item.canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: item.canvas.getContext('2d'), viewport }).promise;
      item.status = 'done';
    } catch (err) {
      console.error('Page ' + item.num + ' non rendue', err);
      item.status = 'idle';
    }
  }

  function release(item) {
    if (item.status !== 'done') return;
    item.canvas.width = 1; item.canvas.height = 1;
    item.status = 'idle';
    item.hi = false;
  }

  // Re-rendu d'une page à une autre définition, sans clignotement :
  // on dessine hors écran puis on remplace le contenu d'un coup.
  async function swapResolution(item, width, hi) {
    item.hi = hi;
    try {
      const page = await pdf.getPage(item.num);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const tmp = document.createElement('canvas');
      tmp.width = Math.round(viewport.width);
      tmp.height = Math.round(viewport.height);
      await page.render({ canvasContext: tmp.getContext('2d'), viewport }).promise;
      if (item.hi !== hi || item.status !== 'done') return;   // changé entre-temps
      item.canvas.width = tmp.width;
      item.canvas.height = tmp.height;
      item.canvas.getContext('2d').drawImage(tmp, 0, 0);
    } catch (err) {
      console.error('Re-rendu page ' + item.num, err);
      item.hi = !hi;
    }
  }

  // Haute définition uniquement pour les pages visibles quand on zoome
  function syncResolution() {
    if (!pageFlip) return;
    const wantHi = zoom > 1.4;
    const v = currentView();
    bookItems.forEach((item, i) => {
      if (!item || item.status !== 'done') return;
      const visible = Math.floor(i / perView) === v;
      if (wantHi && visible && !item.hi) swapResolution(item, HI_W, true);
      else if (item.hi && !(wantHi && visible)) swapResolution(item, RENDER_W, false);
    });
  }

  let drawChain = Promise.resolve();
  function refresh(view) {
    const first  = (view - WINDOW) * perView;
    const last   = (view + WINDOW) * perView + perView - 1;
    const center = view * perView + (perView - 1) / 2;
    const wanted = [];
    bookItems.forEach((item, i) => {
      if (!item) return;
      if (i >= first && i <= last) wanted.push({ item, d: Math.abs(i - center) });
      else release(item);
    });
    wanted.sort((a, b) => a.d - b.d);               // les plus proches d'abord
    wanted.forEach(({ item }) => { drawChain = drawChain.then(() => draw(item)); });
    return drawChain;
  }

  function makePage(item) {
    const div = document.createElement('div');
    div.className = 'page' + (item ? '' : ' page--blank');
    div.dataset.density = 'soft';                   // pliure souple pour TOUTES les pages
    if (item) div.appendChild(item.canvas);
    return div;
  }

  /* ---------------- Taille du livre ---------------- */
  function fitBook() {
    let w;
    if (mode === 'single') {
      // 1 page 16:9 : on prend toute la largeur (max 599 px pour rester en mode portrait)
      const availW = Math.min(stageEl.clientWidth, 599);
      const availH = stageEl.clientHeight;
      w = Math.min(availW, availH * (PAGE_W / PAGE_H));
    } else {
      // double page = 2 x 16:9
      const availW = stageEl.clientWidth  * 0.97;
      const availH = stageEl.clientHeight * 0.97;
      w = Math.min(availW, availH * ((PAGE_W * 2) / PAGE_H));
    }
    const h = w / (mode === 'single' ? PAGE_W / PAGE_H : (PAGE_W * 2) / PAGE_H);
    bookEl.style.width  = Math.floor(w) + 'px';
    bookEl.style.height = Math.floor(h) + 'px';
  }

  /* ---------------- Vue courante ---------------- */
  function currentView() {
    const i = pageFlip.getCurrentPageIndex();
    return perView === 2 ? Math.floor(i / 2) : i;
  }
  const clampView = (v) => Math.max(0, Math.min(views - 1, v));

  /* ---------------- Centrage animé (mode double page) ----------------
     Le livre glisse de 25 % de sa largeur pendant que la page tourne,
     en temps réel : la reliure suit le papier. En mode 1 page : aucun décalage. */
  const shiftFor = (v) => {
    if (mode === 'single') return 0;
    if (v <= 0) return -25;
    if (v >= views - 1 && lastIsSingle) return 25;
    return 0;
  };

  let shiftNow = 0, shiftTarget = 0, shiftRaf = 0;

  function applyShift(v) {
    shiftNow = v;
    bookEl.style.transform = v ? `translate3d(${v}%, 0, 0)` : 'none';
  }

  function animateShift(target) {
    if (target === shiftTarget) return;
    shiftTarget = target;
    cancelAnimationFrame(shiftRaf);
    const from = shiftNow, t0 = performance.now();
    const step = (t) => {
      const k = Math.min((t - t0) / FLIP_TIME, 1);
      applyShift(from + (target - from) * k);       // linéaire, comme la pliure
      shiftRaf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    shiftRaf = requestAnimationFrame(step);
  }

  /* ---------------- Boutons et compteur ---------------- */
  function updateButtons() {
    if (!pageFlip) return;
    const v = currentView();
    btnPrev.classList.toggle('is-hidden', v <= 0);
    btnNext.classList.toggle('is-hidden', v >= views - 1);
    const nums = bookItems.slice(v * perView, v * perView + perView).filter(Boolean).map((i) => i.num);
    counter.textContent = nums.length > 1
      ? `${nums[0]}–${nums[1]} / ${items.length}`
      : `${nums[0]} / ${items.length}`;
    refresh(v);
    syncResolution();
  }

  function go(dir) {                       // +1 suivant / -1 précédent
    if (!pageFlip || building) return;
    animateShift(shiftFor(clampView(currentView() + dir)));
    dir > 0 ? pageFlip.flipNext() : pageFlip.flipPrev();
  }


  /* ---------------- Zoom (boutons, molette, pincement, glisser pour déplacer) ---------------- */
  let zoom = 1, tx = 0, ty = 0;
  let pinch = null, touchPan = null, mousePan = null;
  const inTools = (t) => t.closest && t.closest('#zoom-tools');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function clampPan() {
    const maxX = Math.max(0, (bookEl.offsetWidth  * zoom - stageEl.clientWidth)  / 2);
    const maxY = Math.max(0, (bookEl.offsetHeight * zoom - stageEl.clientHeight) / 2);
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  function applyZoom() {
    zoomEl.style.transform = (zoom === 1 && !tx && !ty)
      ? 'none' : `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
    stageEl.classList.toggle('is-zoomed', zoom > 1);
    zoomRst.textContent = Math.round(zoom * 100) + '%';
    zoomIn.disabled  = zoom >= ZOOM_MAX - 0.001;
    zoomOut.disabled = zoom <= 1.001;
  }

  let syncTimer;
  // fx, fy : point fixe du zoom, relatif au centre de la zone (px)
  function setZoom(nz, fx = 0, fy = 0) {
    nz = clamp(nz, 1, ZOOM_MAX);
    const k = nz / zoom;
    tx = fx - (fx - tx) * k;
    ty = fy - (fy - ty) * k;
    zoom = nz;
    if (zoom <= 1.001) { zoom = 1; tx = ty = 0; }
    clampPan();
    applyZoom();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncResolution, 150);
  }

  function resetZoom() { zoom = 1; tx = ty = 0; applyZoom(); }

  const STEPS = [1, 1.5, 2, 3, 4];
  zoomIn.addEventListener('click',  () => setZoom(STEPS.find((s) => s > zoom + 0.01) || ZOOM_MAX));
  zoomOut.addEventListener('click', () => setZoom([...STEPS].reverse().find((s) => s < zoom - 0.01) || 1));
  zoomRst.addEventListener('click', () => setZoom(1));

  // Molette / pincement du pavé tactile (ctrl + molette)
  stageEl.addEventListener('wheel', (e) => {
    if (inTools(e.target)) return;
    e.preventDefault();
    const r = stageEl.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setZoom(zoom * f, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
  }, { passive: false });

  // Doigts : pincer pour zoomer, 1 doigt pour déplacer quand on est zoomé.
  // Écouteurs en phase de capture : le livre ne reçoit pas ces gestes (pas de pliure accidentelle).
  const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  stageEl.addEventListener('touchstart', (e) => {
    if (inTools(e.target)) return;
    if (e.touches.length === 2) {
      e.stopPropagation(); e.preventDefault();
      try { pageFlip && pageFlip.getFlipController().stopMove(); } catch (_) {}
      touchPan = null;
      pinch = { d: tdist(e.touches[0], e.touches[1]), z: zoom };
    } else if (e.touches.length === 1 && zoom > 1) {
      e.stopPropagation(); e.preventDefault();
      touchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { capture: true, passive: false });

  stageEl.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.stopPropagation(); e.preventDefault();
      const [a, b] = e.touches, r = stageEl.getBoundingClientRect();
      setZoom(pinch.z * tdist(a, b) / pinch.d,
              (a.clientX + b.clientX) / 2 - (r.left + r.width / 2),
              (a.clientY + b.clientY) / 2 - (r.top + r.height / 2));
    } else if (touchPan && e.touches.length === 1) {
      e.stopPropagation(); e.preventDefault();
      const t = e.touches[0];
      tx += t.clientX - touchPan.x; ty += t.clientY - touchPan.y;
      touchPan = { x: t.clientX, y: t.clientY };
      clampPan(); applyZoom();
    }
  }, { capture: true, passive: false });

  const touchEnd = (e) => {
    const handled = pinch || touchPan || zoom > 1;
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 0) touchPan = null;
    else if (e.touches.length === 1 && zoom > 1) touchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (handled && !inTools(e.target)) e.stopPropagation();
  };
  stageEl.addEventListener('touchend', touchEnd, true);
  stageEl.addEventListener('touchcancel', touchEnd, true);

  // Souris : glisser pour déplacer quand on est zoomé
  stageEl.addEventListener('mousedown', (e) => {
    if (zoom <= 1 || e.button !== 0 || inTools(e.target)) return;
    e.stopPropagation(); e.preventDefault();
    mousePan = { x: e.clientX, y: e.clientY };
    stageEl.classList.add('is-panning');
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!mousePan) return;
    tx += e.clientX - mousePan.x; ty += e.clientY - mousePan.y;
    mousePan = { x: e.clientX, y: e.clientY };
    clampPan(); applyZoom();
  });
  window.addEventListener('mouseup', () => {
    mousePan = null;
    stageEl.classList.remove('is-panning');
  });

  /* ---------------- Construction du livre ---------------- */
  async function build(startNum) {
    building = true;
    cancelAnimationFrame(shiftRaf); shiftRaf = 0;

    resetZoom();
    mode    = isSingle() ? 'single' : 'spread';
    perView = mode === 'single' ? 1 : 2;
    document.body.dataset.mode = mode;

    if (mode === 'single') {
      bookItems = items.slice();                         // 1 page = 1 vue
    } else {
      bookItems = [null, ...items];                      // page vide invisible avant la couverture
      if (bookItems.length % 2 !== 0) bookItems.push(null); // pair : 4e de couverture seule
    }
    lastIsSingle = mode === 'spread' && bookItems[bookItems.length - 1] === null;
    views = bookItems.length / perView;

    const startView = clampView(mode === 'single' ? startNum - 1 : Math.floor(startNum / 2));

    // Nouveau conteneur propre
    if (pageFlip) { try { pageFlip.destroy(); } catch (_) {} pageFlip = null; }
    const fresh = document.createElement('div');
    fresh.id = 'book';
    if (bookEl.isConnected) bookEl.replaceWith(fresh); else zoomEl.prepend(fresh);
    bookEl = fresh;
    fitBook();

    // Page(s) de la vue de départ d'abord, le reste en arrière-plan
    await Promise.all(
      bookItems.slice(startView * perView, startView * perView + perView).map(draw)
    );
    refresh(startView);

    pageFlip = new St.PageFlip(bookEl, {
      width: PAGE_W,
      height: PAGE_H,
      size: 'stretch',
      minWidth: 300,  maxWidth: 2000,     // 2 x 300 = 600 : en dessous, StPageFlip passe en 1 page
      minHeight: 160, maxHeight: 1125,
      showCover: false,                   // showCover rend les couvertures rigides : on s'en passe
      usePortrait: true,
      autoSize: true,
      drawShadow: true,
      maxShadowOpacity: 0.35,
      flippingTime: FLIP_TIME,
      mobileScrollSupport: false,
      useMouseEvents: mode === 'single',  // glisser au doigt : 1 page seulement (pas de page vide ni de décalage)
      swipeDistance: 30,
      showPageCorners: false,
      startPage: startView * perView
    });
    pageFlip.loadFromHTML(bookItems.map(makePage));

    pageFlip.on('changeState', (e) => {
      if (e.data === 'flipping') {
        try {
          const dir = pageFlip.getFlipController().getCalculation().getDirection();
          animateShift(shiftFor(clampView(currentView() + (dir === 0 ? 1 : -1))));
        } catch (_) { /* corrigé à la fin par l'événement 'flip' */ }
      }
      if (e.data === 'read') { animateShift(shiftFor(currentView())); updateButtons(); }
    });
    pageFlip.on('flip', () => { animateShift(shiftFor(currentView())); updateButtons(); });

    shiftNow = shiftTarget = shiftFor(startView);
    applyShift(shiftNow);
    bookEl.classList.add('ready');
    loader.classList.add('is-hidden');
    updateButtons();
    building = false;
  }

  async function init() {
    try {
      pdf = await pdfjsLib.getDocument(PDF_URL).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const canvas = document.createElement('canvas');
        canvas.width = 1; canvas.height = 1;
        items.push({ num: n, canvas, status: 'idle' });
      }
      loader.textContent = 'Chargement de la couverture…';
      await build(1);
    } catch (err) {
      console.error(err);
      building = false;
      loader.classList.remove('is-hidden');
      loader.textContent =
        'Impossible de charger le PDF. Ouvrez la page via un serveur web (pas en file://) et vérifiez le nom du fichier.';
    }
  }

  /* ---------------- Événements ---------------- */
  btnPrev.addEventListener('click', () => go(-1));
  btnNext.addEventListener('click', () => go(+1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  go(-1);
    if (e.key === 'ArrowRight') go(+1);
    if (e.key === '+' || e.key === '=') zoomIn.click();
    if (e.key === '-') zoomOut.click();
    if (e.key === '0') setZoom(1);
  });

  // Rotation / redimensionnement : on bascule entre 1 page et double page
  // en restant sur la même page du catalogue.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      if (!pageFlip || building) return;
      if ((mode === 'single') !== isSingle()) {
        const v = currentView();
        const it = bookItems[v * perView] || bookItems[v * perView + 1];
        await build(it ? it.num : 1);
      } else {
        fitBook();
        pageFlip.update();
        applyShift(shiftFor(currentView()));
        clampPan(); applyZoom();
      }
    }, 150);
  });

  init();
})();