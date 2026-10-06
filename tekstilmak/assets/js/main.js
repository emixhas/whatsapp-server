/* REMAK MAKİNA - arayüz, yumuşak kaydırma ve animasyon paketi
   Bağımlılıklar: gsap, ScrollTrigger, Lenis (hepsi yerel). Tüm hareketler
   prefers-reduced-motion ile kapanır; dokunmatik cihazlarda eğim/mıknatıs efektleri çalışmaz. */
(function () {
  'use strict';

  var html = document.documentElement;
  var body = document.body;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var header = document.getElementById('site-header');
  var toggle = document.getElementById('nav-toggle');
  var lenis = null;

  /* ------------------------------------------------------------------
   * Menü, başlık çubuğu, bağlantılar (animasyon kütüphanesinden bağımsız)
   * ---------------------------------------------------------------- */
  function setMenu(open) {
    body.classList.toggle('nav-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (lenis) { open ? lenis.stop() : lenis.start(); }
  }
  if (toggle) {
    toggle.addEventListener('click', function () { setMenu(!body.classList.contains('nav-open')); });
    document.querySelectorAll('#nav a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  }

  var sentinel = document.querySelector('.scroll-sentinel');
  if (sentinel && header && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      header.classList.toggle('is-scrolled', !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  } else if (header) {
    header.classList.add('is-scrolled');
  }

  function scrollToTarget(target) {
    if (lenis) { lenis.scrollTo(target, { offset: -88, duration: 1.1 }); return; }
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var target = id ? document.getElementById(id) : null;
      if (!target) return;
      e.preventDefault();
      scrollToTarget(target);
    });
  });

  /* Görseller yüklenince yumuşak geçiş */
  document.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
    var done = function () { img.classList.add('is-loaded'); };
    if (img.complete) { done(); } else { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); }
  });

  /* ------------------------------------------------------------------
   * Görsel galerisi (lightbox): [data-lightbox="grup"] bağlantıları
   * ---------------------------------------------------------------- */
  (function initLightbox() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a[data-lightbox]'));
    if (!links.length) return;
    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Görsel galerisi');
    box.innerHTML =
      '<div class="lightbox__backdrop"></div>' +
      '<div class="lightbox__count" aria-live="polite"></div>' +
      '<button class="lightbox__close" type="button" aria-label="Kapat"><i class="ph-bold ph-x" aria-hidden="true"></i></button>' +
      '<button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Önceki görsel"><i class="ph-bold ph-caret-left" aria-hidden="true"></i></button>' +
      '<button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Sonraki görsel"><i class="ph-bold ph-caret-right" aria-hidden="true"></i></button>' +
      '<figure class="lightbox__figure"><img class="lightbox__img" alt=""><figcaption class="lightbox__caption"></figcaption></figure>';
    body.appendChild(box);
    var img = box.querySelector('.lightbox__img');
    var cap = box.querySelector('.lightbox__caption');
    var count = box.querySelector('.lightbox__count');
    var btnClose = box.querySelector('.lightbox__close');
    var btnPrev = box.querySelector('.lightbox__nav--prev');
    var btnNext = box.querySelector('.lightbox__nav--next');
    var groups = {}, current = [], index = 0, lastFocus = null, switching = false;

    links.forEach(function (a) {
      var g = a.getAttribute('data-lightbox') || 'genel';
      (groups[g] = groups[g] || []).push(a);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        open(groups[g], groups[g].indexOf(a));
      });
    });

    function srcOf(a) { return a.getAttribute('data-full') || a.getAttribute('href'); }
    function captionOf(a) { var i = a.querySelector('img'); return a.getAttribute('data-caption') || (i ? i.alt : '') || ''; }

    function render(i) {
      var a = current[i];
      img.src = srcOf(a); img.alt = captionOf(a);
      cap.textContent = captionOf(a);
      count.textContent = (i + 1) + ' / ' + current.length;
      btnPrev.hidden = btnNext.hidden = current.length < 2;
      /* komşu görselleri önceden yükle */
      [i - 1, i + 1].forEach(function (k) { var n = current[(k + current.length) % current.length]; if (n) { var pre = new Image(); pre.src = srcOf(n); } });
    }

    function open(group, i) {
      current = group; index = i; lastFocus = document.activeElement;
      render(index);
      box.classList.add('is-open');
      body.classList.add('lightbox-open');
      if (lenis) lenis.stop();
      btnClose.focus();
    }
    function close() {
      box.classList.remove('is-open');
      body.classList.remove('lightbox-open');
      if (lenis) lenis.start();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function show(i, dir) {
      if (switching || current.length < 2) return;
      switching = true;
      index = (i + current.length) % current.length;
      var next = current[index];
      var pre = new Image();
      var swap = function () {
        img.classList.add('is-out');
        setTimeout(function () {
          render(index);
          img.classList.remove('is-out');
          img.classList.add('is-in');
          if (dir < 0) img.style.transform = 'translateX(-4%) scale(.98)';
          void img.offsetWidth;
          img.classList.remove('is-in');
          img.style.transform = '';
          switching = false;
        }, reduce ? 0 : 240);
      };
      pre.onload = swap; pre.onerror = swap;
      pre.src = srcOf(next);
    }

    btnClose.addEventListener('click', close);
    box.querySelector('.lightbox__backdrop').addEventListener('click', close);
    btnPrev.addEventListener('click', function () { show(index - 1, -1); });
    btnNext.addEventListener('click', function () { show(index + 1, 1); });
    document.addEventListener('keydown', function (e) {
      if (!box.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') show(index + 1, 1);
      else if (e.key === 'ArrowLeft') show(index - 1, -1);
    });
    /* dokunmatik kaydırma */
    var startX = null;
    box.addEventListener('pointerdown', function (e) { startX = e.clientX; });
    box.addEventListener('pointerup', function (e) {
      if (startX === null) return;
      var dx = e.clientX - startX; startX = null;
      if (Math.abs(dx) > 48) show(index + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    });
  })();

  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  if (!hasGsap || reduce) {
    html.classList.add('no-motion');
    html.classList.remove('preload');
    var pre = document.getElementById('preloader');
    if (pre) pre.remove();
    return;
  }

  html.classList.add('motion-ready');
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });

  /* ------------------------------------------------------------------
   * Lenis yumuşak kaydırma (ScrollTrigger ile senkron)
   * ---------------------------------------------------------------- */
  /* Yumuşak kaydırma yalnızca fare/dokunmatik yüzeyli cihazlarda; telefonlarda tarayıcının kendi kaydırması kalır */
  if (typeof window.Lenis !== 'undefined' && finePointer) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 1 });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
  }

  /* Kaydırma ilerleme çubuğu (CSS scroll-timeline desteklenmiyorsa) */
  var progress = document.getElementById('progress');
  if (progress && !(window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()'))) {
    ScrollTrigger.create({
      start: 0, end: 'max',
      onUpdate: function (self) { progress.style.transform = 'scaleX(' + self.progress + ')'; }
    });
  }

  /* Başlık çubuğu: aşağı kayarken gizlen, yukarı kayarken görün */
  if (header) {
    ScrollTrigger.create({
      start: 'top -200', end: 'max',
      onUpdate: function (self) {
        if (body.classList.contains('nav-open')) return;
        header.classList.toggle('is-hidden', self.direction === 1 && self.scroll() > 200);
      },
      onLeaveBack: function () { header.classList.remove('is-hidden'); }
    });
  }

  /* ------------------------------------------------------------------
   * Yardımcılar
   * ---------------------------------------------------------------- */
  function splitWords(el) {
    if (el.dataset.splitDone) return Array.prototype.slice.call(el.querySelectorAll('.wi'));
    var words = el.textContent.trim().split(/\s+/).filter(Boolean);
    el.textContent = '';
    var inners = [];
    words.forEach(function (w, i) {
      var outer = document.createElement('span'); outer.className = 'w';
      var inner = document.createElement('span'); inner.className = 'wi'; inner.textContent = w;
      outer.appendChild(inner); el.appendChild(outer);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
      inners.push(inner);
    });
    el.dataset.splitDone = '1';
    return inners;
  }

  function tilt(el, max) {
    max = max || 7;
    gsap.set(el, { transformPerspective: 1000 });
    var rx = gsap.quickTo(el, 'rotationX', { duration: 0.6, ease: 'power3' });
    var ry = gsap.quickTo(el, 'rotationY', { duration: 0.6, ease: 'power3' });
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      rx(-y * max * 2); ry(x * max * 2);
    });
    el.addEventListener('pointerenter', function () { gsap.to(el, { y: -6, duration: 0.5, ease: 'power3' }); });
    el.addEventListener('pointerleave', function () { rx(0); ry(0); gsap.to(el, { y: 0, duration: 0.6, ease: 'power3' }); });
  }

  function magnet(el, strength) {
    strength = strength || 0.3;
    var xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3' });
    var yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3' });
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * strength);
      yTo((e.clientY - (r.top + r.height / 2)) * strength);
    });
    el.addEventListener('pointerleave', function () { xTo(0); yTo(0); });
    el.addEventListener('pointerdown', function () { gsap.to(el, { scale: 0.96, duration: 0.15 }); });
    el.addEventListener('pointerup', function () { gsap.to(el, { scale: 1, duration: 0.3, ease: 'back.out(2)' }); });
  }

  /* ------------------------------------------------------------------
   * Giriş: ön yükleyici + hero
   * ---------------------------------------------------------------- */
  function startIntro() {
    var tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
    var heroTitle = document.querySelector('.hero__title[data-split]');
    if (heroTitle) {
      var words = splitWords(heroTitle);
      var bg = document.querySelector('.hero__bg');
      if (bg) tl.from(bg, { scale: 1.2, duration: 1.8, ease: 'power2.out' }, 0);
      tl.from(words, { yPercent: 110, duration: 1.1, stagger: 0.06 }, 0.1)
        .from('.hero__text', { y: 26, opacity: 0, duration: 0.9 }, 0.5)
        .from('.hero__actions .btn', { y: 22, opacity: 0, duration: 0.8, stagger: 0.08 }, 0.6);
      var panel = document.querySelector('.hero__panel');
      if (panel) {
        tl.fromTo(panel, { clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)', duration: 1.2 }, 0.3)
          .from(panel.querySelector('.hero__slide.is-active, img'), { scale: 1.3, duration: 1.6 }, 0.3);
      }
      tl.from('.hero__captions', { y: 14, opacity: 0, duration: 0.6, onComplete: startHeroSlider }, 1.0)
        .from('.pillar', { y: 18, opacity: 0, duration: 0.7, stagger: 0.07 }, 1.05);
    } else {
      var h1 = document.querySelector('h1[data-split]');
      if (h1) tl.from(splitWords(h1), { yPercent: 110, duration: 1, stagger: 0.05 }, 0.05);
      document.querySelectorAll('h1 [data-split]').forEach(function (part, i) {
        tl.from(splitWords(part), { yPercent: 110, duration: 1, stagger: 0.05 }, 0.05 + i * 0.12);
      });
      var heroEls = gsap.utils.toArray('[data-hero]:not([data-split])');
      if (heroEls.length) tl.from(heroEls, { y: 26, opacity: 0, duration: 0.9, stagger: 0.1 }, 0.25);
      var media = document.querySelector('.product-hero__media');
      if (media) {
        tl.fromTo(media, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 1.2 }, 0.2)
          .from(media.querySelector('img'), { scale: 1.3, duration: 1.6 }, 0.2);
      }
    }
    return tl;
  }

  var preloader = document.getElementById('preloader');
  if (html.classList.contains('preload') && preloader) {
    var countEl = preloader.querySelector('.preloader__count');
    var bar = preloader.querySelector('.preloader__bar span');
    var counter = { v: 0 };
    try { sessionStorage.setItem('remak-intro', '1'); } catch (e) { /* özel mod */ }
    if (lenis) lenis.stop();
    /* emniyet: bir şey takılırsa 4,5 sn sonra sayfayı serbest bırak */
    setTimeout(function () {
      if (!html.classList.contains('preload')) return;
      html.classList.remove('preload');
      if (preloader.parentNode) preloader.remove();
      if (lenis) lenis.start();
      startIntro();
    }, 4500);
    gsap.timeline({
      onComplete: function () {
        html.classList.remove('preload');
        preloader.remove();
        if (lenis) lenis.start();
        ScrollTrigger.refresh();
      }
    })
      .to(counter, { v: 100, duration: 1.1, ease: 'power2.inOut', onUpdate: function () {
        if (countEl) countEl.textContent = Math.round(counter.v) + '%';
        if (bar) bar.style.width = counter.v + '%';
      } })
      .to(preloader.querySelector('.preloader__inner'), { y: -30, opacity: 0, duration: 0.5, ease: 'power2.in' }, '-=0.1')
      .to(preloader, { yPercent: -100, duration: 0.9, ease: 'expo.inOut', onStart: startIntro }, '-=0.3');
  } else {
    html.classList.remove('preload');
    if (preloader) preloader.remove();
    startIntro();
  }

  /* ------------------------------------------------------------------
   * Hero ürün slaytı: belirli aralıkla perde geçişiyle değişir
   * ---------------------------------------------------------------- */
  var heroSliderStarted = false;
  function startHeroSlider() {
    if (heroSliderStarted) return;
    heroSliderStarted = true;
    var slider = document.querySelector('[data-slider]');
    if (!slider) return;
    var slides = gsap.utils.toArray(slider.querySelectorAll('.hero__slide'));
    var caps = gsap.utils.toArray(document.querySelectorAll('.hero__caption'));
    if (slides.length < 2) return;
    var hold = Math.max(400, parseInt(slider.getAttribute('data-interval'), 10) || 1000);
    var idx = 0, busy = false, hoverPaused = false, viewPaused = false;

    function go(next) {
      if (busy || next === idx) return;
      busy = true;
      var cur = slides[idx], nxt = slides[next];
      var curCap = caps[idx], nxtCap = caps[next];
      nxt.classList.add('is-active');
      gsap.set(nxt, { clipPath: 'inset(0 0 0 100%)', scale: 1.14, xPercent: 0, zIndex: 2 });
      gsap.set(cur, { zIndex: 1 });
      var tl = gsap.timeline({
        onComplete: function () {
          cur.classList.remove('is-active');
          gsap.set([cur, nxt], { clearProps: 'all' });
          if (curCap && nxtCap) { curCap.classList.remove('is-active'); nxtCap.classList.add('is-active'); gsap.set([curCap, nxtCap], { clearProps: 'all' }); }
          idx = next; busy = false;
        }
      });
      tl.to(nxt, { clipPath: 'inset(0 0 0 0%)', scale: 1, duration: 0.85, ease: 'expo.out' }, 0)
        .to(cur, { xPercent: -10, scale: 1.05, duration: 0.85, ease: 'power2.inOut' }, 0);
      if (curCap && nxtCap) {
        gsap.set(nxtCap, { opacity: 1, pointerEvents: 'auto' });
        tl.to(curCap, { yPercent: -120, duration: 0.4, ease: 'power2.in' }, 0)
          .fromTo(nxtCap, { yPercent: 120 }, { yPercent: 0, duration: 0.6, ease: 'expo.out' }, 0.25);
      }
    }
    function loop() {
      setTimeout(function () {
        if (!hoverPaused && !viewPaused && !document.hidden) go((idx + 1) % slides.length);
        loop();
      }, hold + 850);
    }
    loop();
    slider.addEventListener('pointerenter', function () { hoverPaused = true; });
    slider.addEventListener('pointerleave', function () { hoverPaused = false; });
    ScrollTrigger.create({ trigger: '.hero', start: 'top bottom', end: 'bottom top', onToggle: function (self) { viewPaused = !self.isActive; } });
  }
  if (!document.querySelector('.hero__title[data-split]')) startHeroSlider();

  /* ------------------------------------------------------------------
   * Kaydırma animasyonları
   * ---------------------------------------------------------------- */

  /* Hero paralaks */
  var heroBg = document.querySelector('.hero__bg');
  if (heroBg) gsap.to(heroBg, { yPercent: 18, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  var heroVisual = document.querySelector('.hero__visual');
  if (heroVisual) gsap.to(heroVisual, { yPercent: -12, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  var heroCopy = document.querySelector('.hero__copy');
  if (heroCopy) gsap.to(heroCopy, { yPercent: 10, opacity: 0.2, ease: 'none', scrollTrigger: { trigger: '.hero', start: '40% top', end: 'bottom top', scrub: true } });

  /* Bölüm başlıkları: kelime kelime */
  gsap.utils.toArray('[data-split]:not(.hero__title):not(h1 [data-split]):not(h1[data-split])').forEach(function (el) {
    var words = splitWords(el);
    gsap.from(words, { yPercent: 110, duration: 0.9, ease: 'expo.out', stagger: 0.04, scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
  });

  /* Görünüme girince beliren bloklar */
  var revealEls = gsap.utils.toArray('[data-reveal]:not([data-reveal="clip"])');
  if (revealEls.length) {
    ScrollTrigger.batch(revealEls, {
      start: 'top 90%', once: true,
      onEnter: function (batch) { gsap.to(batch, { opacity: 1, y: 0, duration: 1, ease: 'expo.out', stagger: 0.07 }); }
    });
  }
  gsap.utils.toArray('[data-reveal="clip"]').forEach(function (el) {
    var img = el.querySelector('img');
    var t = gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
    t.to(el, { clipPath: 'inset(0% 0 0% 0)', duration: 1.3, ease: 'expo.out' }, 0);
    if (img) t.to(img, { scale: 1, duration: 1.6, ease: 'expo.out' }, 0);
  });

  /* Fotoğraf paralaksı (görsel + metin düzenleri) */
  gsap.utils.toArray('[data-parallax] img').forEach(function (img) {
    gsap.fromTo(img, { yPercent: -7 }, { yPercent: 7, ease: 'none', scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } });
  });

  /* Farklı hızlarda kayan galeri parçaları */
  gsap.utils.toArray('[data-speed]').forEach(function (el) {
    var speed = parseFloat(el.getAttribute('data-speed')) || 1;
    gsap.to(el, { y: function () { return (1 - speed) * 160; }, ease: 'none', scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: true, invalidateOnRefresh: true } });
  });

  /* Sayaçlar */
  gsap.utils.toArray('[data-count]').forEach(function (el) {
    var target = parseFloat(el.getAttribute('data-count'));
    if (isNaN(target)) return;
    var obj = { v: 0 };
    gsap.to(obj, { v: target, duration: 1.6, ease: 'power2.out', onUpdate: function () { el.textContent = Math.round(obj.v); }, scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
  });

  /* Kayan yazı bandı: kaydırma hızına ve yönüne tepki verir */
  var marquee = document.querySelector('.marquee__track');
  if (marquee) {
    marquee.classList.add('is-gsap');
    var loop = gsap.to(marquee, { xPercent: -50, ease: 'none', duration: 28, repeat: -1 });
    ScrollTrigger.create({
      onUpdate: function (self) {
        var v = self.getVelocity();
        var ts = gsap.utils.clamp(-3, 3, 1 + v / 900);
        gsap.to(loop, { timeScale: ts, duration: 0.8, overwrite: true });
      }
    });
  }

  /* Eğim ve mıknatıs (yalnızca fare ile) */
  if (finePointer) {
    gsap.utils.toArray('[data-tilt]').forEach(function (el) { tilt(el, parseFloat(el.getAttribute('data-tilt')) || 6); });
    gsap.utils.toArray('[data-magnet]').forEach(function (el) { magnet(el, parseFloat(el.getAttribute('data-magnet')) || 0.3); });
  }

  var mm = gsap.matchMedia();

  /* Makine parkuru: dikey kaydırma -> yatay hareket (masaüstü) */
  mm.add('(min-width: 1024px)', function () {
    var wrap = document.querySelector('[data-hpan]');
    if (!wrap) return;
    var track = wrap.querySelector('[data-hpan-track]');
    if (!track) return;
    var distance = function () { return Math.max(0, track.scrollWidth - wrap.clientWidth); };
    if (distance() <= 0) return;
    var pan = gsap.to(track, {
      x: function () { return -distance(); }, ease: 'none',
      scrollTrigger: { trigger: wrap, start: 'top top', end: function () { return '+=' + distance(); }, pin: true, scrub: 1, anticipatePin: 1, invalidateOnRefresh: true }
    });
    /* Kartların görselleri hafifçe geride kalsın (derinlik) */
    track.querySelectorAll('.pcard__media img').forEach(function (img) {
      gsap.fromTo(img, { xPercent: -6 }, { xPercent: 6, ease: 'none', scrollTrigger: { trigger: wrap, start: 'top top', end: function () { return '+=' + distance(); }, scrub: 1 } });
    });
    var bar = wrap.querySelector('.showcase__progress span');
    if (bar) gsap.to(bar, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: wrap, start: 'top top', end: function () { return '+=' + distance(); }, scrub: true } });
    return function () { pan.kill(); };
  });

  /* Makine parkuru (mobil): parmakla sürüklenen, kendiliğinden ilerleyen karusel.
     Kaydırma kutusu kullanılmaz; şerit transform ile taşınır, dikey kaydırma tarayıcıda kalır. */
  mm.add('(max-width: 1023px)', function () {
    var wrap = document.querySelector('[data-hpan]');
    if (!wrap) return;
    var track = wrap.querySelector('[data-hpan-track]');
    if (!track) return;
    var cards = gsap.utils.toArray(track.querySelectorAll('.pcard'));
    if (cards.length < 2) return;
    var bar = wrap.querySelector('.showcase__progress span');
    var current = 0, userHold = 0, inView = false, timer = null;
    var dragging = false, moved = false, pid = null, startX = 0, startTrackX = 0, lastX = 0, lastT = 0, vel = 0;

    function step() { return cards[1].offsetLeft - cards[0].offsetLeft; }
    function offsetFor(i) { return -i * step(); }
    function setCurrent(i) {
      current = i;
      cards.forEach(function (c, k) { c.classList.toggle('is-current', k === i); });
      if (bar) gsap.to(bar, { scaleX: (i + 1) / cards.length, duration: 0.5, ease: 'power2.out' });
    }
    function goTo(i, immediate) {
      i = gsap.utils.clamp(0, cards.length - 1, i);
      setCurrent(i);
      gsap.to(track, { x: offsetFor(i), duration: immediate ? 0 : 0.85, ease: 'expo.out', overwrite: true });
    }
    gsap.set(track, { x: 0 });
    setCurrent(0);

    /* bölüm görünüme girince kart içerikleri sağdan sıralı gelir (kartın kendisi CSS ölçek geçişine bırakılır) */
    ScrollTrigger.create({
      trigger: wrap, start: 'top 80%', once: true,
      onEnter: function () {
        gsap.fromTo(track.querySelectorAll('.pcard__media, .pcard__body'), { x: 70, opacity: 0 }, { x: 0, opacity: 1, duration: 1, ease: 'expo.out', stagger: 0.05, clearProps: 'transform,opacity' });
      }
    });

    /* sürükleme (yalnızca yatay; dikey hareketi tarayıcı sayfa kaydırması olarak alır) */
    track.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging = true; moved = false; pid = e.pointerId;
      startX = lastX = e.clientX; lastT = e.timeStamp; vel = 0;
      startTrackX = parseFloat(gsap.getProperty(track, 'x')) || 0;
      gsap.killTweensOf(track);
      userHold = Date.now() + 6000;
    });
    track.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 6) return;
        moved = true;
        try { track.setPointerCapture(pid); } catch (err) { /* desteklenmiyor */ }
      }
      vel = (e.clientX - lastX) / Math.max(1, e.timeStamp - lastT);
      lastX = e.clientX; lastT = e.timeStamp;
      var min = offsetFor(cards.length - 1), max = 0, x = startTrackX + dx;
      if (x > max) x = max + (x - max) * 0.3;
      if (x < min) x = min + (x - min) * 0.3;
      gsap.set(track, { x: x });
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      var x = parseFloat(gsap.getProperty(track, 'x')) || 0;
      var idx = Math.round(-x / step());
      if (Math.abs(vel) > 0.35) idx = current + (vel < 0 ? 1 : -1);
      goTo(idx);
    }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('click', function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);

    /* kendiliğinden ilerleme */
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (inView && !dragging && !document.hidden && Date.now() > userHold) goTo((current + 1) % cards.length);
        schedule();
      }, 2600);
    }
    ScrollTrigger.create({ trigger: wrap, start: 'top bottom', end: 'bottom top', onToggle: function (self) { inView = self.isActive; } });
    var onRefresh = function () { goTo(current, true); };
    ScrollTrigger.addEventListener('refreshInit', onRefresh);
    schedule();

    return function () {
      clearTimeout(timer);
      ScrollTrigger.removeEventListener('refreshInit', onRefresh);
      gsap.set(track, { clearProps: 'x' });
      cards.forEach(function (c) { c.classList.remove('is-current'); });
    };
  });

  /* Neden REMAK: kartlar üst üste yığılır */
  mm.add('(min-width: 1024px)', function () {
    var list = document.querySelector('[data-stack]');
    if (!list) return;
    var cards = gsap.utils.toArray(list.children);
    cards.forEach(function (card, i) {
      if (i === cards.length - 1) return;
      gsap.to(card, {
        scale: 0.92, opacity: 0.35, filter: 'blur(2px)', ease: 'none',
        scrollTrigger: { trigger: cards[i + 1], start: 'top 80%', end: 'top 25%', scrub: true }
      });
    });
  });

  window.addEventListener('load', function () { ScrollTrigger.refresh(); });
})();
