(() => {
  'use strict';

  /* ---------------- Configuration ---------------- */
  const PDF_URL    = 'kalodon_numbers_comptabilite_fr.pdf';
  const PAGE_W     = 1280;   // dimensions d'une page (16:9)
  const PAGE_H     = 720;
  const RENDER_W   = 1920;   // largeur du canvas rendu (netteté vs mémoire)
  const FLIP_TIME  = 1000;   // durée de la pliure (ms), identique pour TOUTES les pages
  const SINGLE_MAX = 640;    // en dessous de cette largeur d'écran : 1 page à la fois (téléphone en portrait)
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
  }

  function go(dir) {                       // +1 suivant / -1 précédent
    if (!pageFlip || building) return;
    animateShift(shiftFor(clampView(currentView() + dir)));
    dir > 0 ? pageFlip.flipNext() : pageFlip.flipPrev();
  }

  /* ---------------- Construction du livre ---------------- */
  async function build(startNum) {
    building = true;
    cancelAnimationFrame(shiftRaf); shiftRaf = 0;

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
    if (bookEl.isConnected) bookEl.replaceWith(fresh); else stageEl.prepend(fresh);
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
      useMouseEvents: false,              // aucune interaction directe : ni coins, ni clic, ni glisser (boutons / clavier uniquement)
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
      }
    }, 150);
  });

  init();
})();