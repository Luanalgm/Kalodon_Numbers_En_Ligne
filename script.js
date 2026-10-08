(() => {
  'use strict';

  /* ---------------- Configuration ---------------- */
  const PDF_URL   = 'kalodon_numbers_comptabilite_fr.pdf';
  const PAGE_W    = 1280;   // dimensions d'une page (16:9)
  const PAGE_H    = 720;
  const RENDER_W  = 1920;   // largeur du canvas rendu (netteté vs mémoire)
  const FLIP_TIME = 1000;   // durée de la pliure (ms), identique pour TOUTES les pages

  const pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const bookEl  = document.getElementById('book');
  const stageEl = document.getElementById('stage');
  const loader  = document.getElementById('loader');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');

  let pageFlip = null;
  let lastIsSingle = true;
  let spreads  = 0;          // nombre de "vues" (couverture, doubles pages, dernière page)

  /* ---------------- Rendu PDF -> canvas (paresseux) ----------------
     Un catalogue entier à 1920 px de large dépasse la mémoire du navigateur
     (pages blanches ou manquantes). On ne garde donc en mémoire que les pages
     proches de la vue courante, les autres sont libérées puis re-rendues
     à la demande. */
  let pdf = null;
  let items = [];        // une entrée par page du PDF : { num, canvas, status }
  let bookItems = [];    // item (ou null pour une page vide) par position dans le livre
  const WINDOW = 2;      // vues conservées de chaque côté de la vue courante

  async function draw(item) {
    if (item.status !== 'idle') return;
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
  function refresh(spread) {
    const first = (spread - WINDOW) * 2, last = (spread + WINDOW) * 2 + 1;
    const wanted = [];
    bookItems.forEach((item, i) => {
      if (!item) return;
      if (i >= first && i <= last) wanted.push({ item, d: Math.abs(i - spread * 2 - 0.5) });
      else release(item);
    });
    wanted.sort((a, b) => a.d - b.d);              // les plus proches d'abord
    wanted.forEach(({ item }) => { drawChain = drawChain.then(() => draw(item)); });
    return drawChain;
  }

  function makePage(item) {
    const div = document.createElement('div');
    div.className = 'page' + (item ? '' : ' page--blank');
    div.dataset.density = 'soft';          // pliure souple pour TOUTES les pages
    if (item) div.appendChild(item.canvas);
    return div;
  }

  function updateCounter() {
    const s = currentSpread();
    const nums = [bookItems[2 * s], bookItems[2 * s + 1]].filter(Boolean).map((i) => i.num);
    document.getElementById('counter').textContent =
      nums.length > 1 ? `${nums[0]}–${nums[1]} / ${items.length}` : `${nums[0]} / ${items.length}`;
  }

  /* ---------------- Taille du livre (double page = 32:9) ---------------- */
  function fitBook() {
    const availW = stageEl.clientWidth  * 0.97;
    const availH = stageEl.clientHeight * 0.97;
    const ratio = (PAGE_W * 2) / PAGE_H;
    const w = Math.min(availW, availH * ratio);
    bookEl.style.width  = Math.floor(w) + 'px';
    bookEl.style.height = Math.floor(w / ratio) + 'px';
  }

  /* ---------------- Vue courante ---------------- */
  // Livre : [vide, couverture, p2, p3, ..., dernière, vide]
  // => vue 0 = couverture (moitié droite), dernière vue = 4e de couverture (moitié gauche)
  function currentSpread() {
    return Math.floor(pageFlip.getCurrentPageIndex() / 2);
  }

  /* ---------------- Centrage animé, lié à la pliure ----------------
     Le livre glisse de 25 % de sa largeur pendant que la page tourne,
     en temps réel (pas de transition CSS) : la reliure suit le papier. */
  const shiftFor = (s) => (s <= 0 ? -25 : (s >= spreads - 1 && lastIsSingle) ? 25 : 0);

  let shiftNow = -25, shiftTarget = -25, shiftRaf = 0;

  function applyShift(v) {
    shiftNow = v;
    bookEl.style.transform = `translate3d(${v}%, 0, 0)`;
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

  /* ---------------- Boutons ---------------- */
  function updateButtons() {
    const s = currentSpread();
    btnPrev.classList.toggle('is-hidden', s <= 0);
    btnNext.classList.toggle('is-hidden', s >= spreads - 1);
    updateCounter();
    refresh(s);
  }

  function go(dir) {                       // dir = +1 (suivant) / -1 (précédent)
    if (!pageFlip) return;
    const target = Math.max(0, Math.min(spreads - 1, currentSpread() + dir));
    animateShift(shiftFor(target));
    dir > 0 ? pageFlip.flipNext() : pageFlip.flipPrev();
  }

  /* ---------------- Initialisation ---------------- */
  async function init() {
    try {
      pdf = await pdfjsLib.getDocument(PDF_URL).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const canvas = document.createElement('canvas');
        canvas.width = 1; canvas.height = 1;
        items.push({ num: n, canvas, status: 'idle' });
      }

      // Page vide invisible avant la couverture : elle s'affiche seule, souple, à droite.
      bookItems = [null, ...items];
      // Nombre de pages PDF pair  -> 4e de couverture seule (page vide invisible après).
      // Nombre de pages PDF impair -> aucune page vide : la dernière vue est une
      // double page normale (avant-dernière + dernière), sans vue parasite à moitié vide.
      if (bookItems.length % 2 !== 0) bookItems.push(null);
      lastIsSingle = bookItems[bookItems.length - 1] === null;
      const pages = bookItems.map(makePage);
      spreads = pages.length / 2;

      loader.textContent = 'Chargement de la couverture…';
      await draw(items[0]);     // la couverture d'abord, le reste se charge en arrière-plan
      refresh(0);

      fitBook();
      applyShift(shiftFor(0));

      pageFlip = new St.PageFlip(bookEl, {
        width: PAGE_W,
        height: PAGE_H,
        size: 'stretch',
        minWidth: 200,  maxWidth: 2000,
        minHeight: 112, maxHeight: 1125,
        showCover: false,         // showCover rend les couvertures rigides : on s'en passe
        usePortrait: false,       // toujours en mode livre ouvert
        autoSize: true,
        drawShadow: true,
        maxShadowOpacity: 0.35,
        flippingTime: FLIP_TIME,
        mobileScrollSupport: false,
        useMouseEvents: false,    // navigation par boutons / clavier : plus de coin de page qui se soulève au survol
        swipeDistance: 30,
        showPageCorners: false,
        startPage: 0
      });

      pageFlip.loadFromHTML(pages);

      // Glisser à la souris / au doigt : on récupère la direction de la pliure
      pageFlip.on('changeState', (e) => {
        if (e.data === 'flipping') {
          try {
            const dir = pageFlip.getFlipController().getCalculation().getDirection();
            const s = currentSpread() + (dir === 0 ? 1 : -1);
            animateShift(shiftFor(Math.max(0, Math.min(spreads - 1, s))));
          } catch (_) { /* corrigé à la fin par l'événement 'flip' */ }
        }
        if (e.data === 'read') {
          animateShift(shiftFor(currentSpread()));
          updateButtons();
        }
      });
      pageFlip.on('flip', () => {
        animateShift(shiftFor(currentSpread()));
        updateButtons();
      });

      bookEl.classList.add('ready');
      loader.classList.add('is-hidden');
      updateButtons();
    } catch (err) {
      console.error(err);
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

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitBook();
      if (pageFlip) pageFlip.update();
    }, 120);
  });

  init();
})();