/* REMAK MAKİNA - arayüz ve kaydırma animasyonları */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var header = document.getElementById('site-header');
  var toggle = document.getElementById('nav-toggle');
  var body = document.body;

  /* Mobil menü */
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.querySelectorAll('#nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && body.classList.contains('nav-open')) {
        body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* Başlık çubuğu: sayfa kaydırılınca koyu zemin */
  var sentinel = document.querySelector('.scroll-sentinel');
  if (sentinel && header && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      header.classList.toggle('is-scrolled', !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  } else if (header) {
    header.classList.add('is-scrolled');
  }

  /* Yumuşak kaydırma (sayfa içi bağlantılar) */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var target = id ? document.getElementById(id) : null;
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  });

  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  if (!hasGsap || reduce) {
    document.documentElement.classList.add('no-motion');
    return;
  }

  document.documentElement.classList.add('motion-ready');
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });

  /* Giriş animasyonu: hero / sayfa başlıkları */
  var heroEls = gsap.utils.toArray('[data-hero]');
  if (heroEls.length) {
    gsap.from(heroEls, { y: 28, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.11, delay: 0.05, clearProps: 'transform' });
  }

  /* Hero arka planı paralaks */
  var heroBg = document.querySelector('.hero__bg');
  if (heroBg) {
    gsap.to(heroBg, { yPercent: 16, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  }
  var heroPanel = document.querySelector('.hero__panel');
  if (heroPanel) {
    gsap.to(heroPanel, { yPercent: -10, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  }

  /* Görünüme girince ortaya çıkan bloklar */
  var revealEls = gsap.utils.toArray('[data-reveal]');
  if (revealEls.length) {
    ScrollTrigger.batch(revealEls, {
      start: 'top 88%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, overwrite: true, clearProps: 'transform' });
      }
    });
  }

  /* Fotoğraf paralaksı */
  gsap.utils.toArray('[data-parallax] img').forEach(function (img) {
    gsap.fromTo(img, { yPercent: -7 }, {
      yPercent: 7, ease: 'none',
      scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true }
    });
  });

  /* Sayaçlar */
  gsap.utils.toArray('[data-count]').forEach(function (el) {
    var target = parseFloat(el.getAttribute('data-count'));
    if (isNaN(target)) return;
    var obj = { v: 0 };
    gsap.to(obj, {
      v: target, duration: 1.4, ease: 'power2.out',
      onUpdate: function () { el.textContent = Math.round(obj.v); },
      scrollTrigger: { trigger: el, start: 'top 85%', once: true }
    });
  });

  /* Makine parkuru: dikey kaydırmayı yatay harekete çevir (masaüstü) */
  var mm = gsap.matchMedia();
  mm.add('(min-width: 1024px)', function () {
    var wrap = document.querySelector('[data-hpan]');
    if (!wrap) return;
    var track = wrap.querySelector('[data-hpan-track]');
    if (!track) return;
    var distance = function () { return Math.max(0, track.scrollWidth - wrap.clientWidth); };
    if (distance() <= 0) return;
    gsap.to(track, {
      x: function () { return -distance(); },
      ease: 'none',
      scrollTrigger: {
        trigger: wrap,
        start: 'top top',
        end: function () { return '+=' + distance(); },
        pin: true,
        scrub: 1,
        anticipatePin: 1,
        invalidateOnRefresh: true
      }
    });
  });

  window.addEventListener('load', function () { ScrollTrigger.refresh(); });
})();
