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
  if (typeof window.Lenis !== 'undefined') {
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
          .from(panel.querySelector('img'), { scale: 1.3, duration: 1.6 }, 0.3);
      }
      tl.from('.hero__caption', { y: 14, opacity: 0, duration: 0.6 }, 1.0)
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
