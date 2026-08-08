/* ==========================================================================
   Deck core — stage scaling, slide navigation, fragments, chrome.
   ========================================================================== */
(function () {
  'use strict';

  var STAGE_W = 1600;
  var STAGE_H = 900;

  var Deck = {
    slides: [],
    index: 0,
    frag: 0,
    ready: false
  };
  window.Deck = Deck;

  /* ---- stage scaling ---------------------------------------------------- */
  function fitStage() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    var pad = 56;
    var s = Math.min((window.innerWidth - pad) / STAGE_W, (window.innerHeight - pad) / STAGE_H);
    /* a hidden or not-yet-laid-out viewport reports 0 — never scale to 0 or below */
    s = Math.max(0.2, Math.min(s, 1.35));
    stage.style.transform = 'scale(' + s + ')';
    Deck.scale = s;
  }

  /* ---- fragments -------------------------------------------------------- */
  function fragsOf(slide) {
    return Array.prototype.slice.call(slide.querySelectorAll('.frag, .frag-up'));
  }

  function applyFrags(slide, count) {
    fragsOf(slide).forEach(function (el, i) {
      el.classList.toggle('shown', i < count);
    });
  }

  /* ---- navigation ------------------------------------------------------- */
  function show(i, fragCount) {
    i = Math.max(0, Math.min(Deck.slides.length - 1, i));
    var prev = Deck.slides[Deck.index];
    var next = Deck.slides[i];

    if (prev && prev !== next) {
      prev.classList.remove('is-active');
      prev.dispatchEvent(new CustomEvent('slide:leave'));
    }

    Deck.index = i;
    next.classList.add('is-active');

    var total = fragsOf(next).length;
    Deck.frag = fragCount === undefined ? 0 : Math.max(0, Math.min(total, fragCount));
    applyFrags(next, Deck.frag);

    updateChrome();
    if (location.hash !== '#/' + (i + 1)) {
      history.replaceState(null, '', '#/' + (i + 1));
    }
    next.dispatchEvent(new CustomEvent('slide:enter'));
  }

  function next() {
    var slide = Deck.slides[Deck.index];
    var total = fragsOf(slide).length;
    if (Deck.frag < total) {
      Deck.frag++;
      applyFrags(slide, Deck.frag);
      updateChrome();
      return;
    }
    if (Deck.index < Deck.slides.length - 1) show(Deck.index + 1, 0);
  }

  function prev() {
    if (Deck.frag > 0) {
      Deck.frag--;
      applyFrags(Deck.slides[Deck.index], Deck.frag);
      updateChrome();
      return;
    }
    if (Deck.index > 0) {
      var target = Deck.slides[Deck.index - 1];
      show(Deck.index - 1, fragsOf(target).length);
    }
  }

  Deck.show = show;
  Deck.next = next;
  Deck.prev = prev;
  Deck.goTo = function (n) { show(n - 1, 0); };

  /* ---- chrome ----------------------------------------------------------- */
  function updateChrome() {
    var n = Deck.index + 1;
    var total = Deck.slides.length;
    var counter = document.getElementById('counter');
    if (counter) counter.innerHTML = '<b>' + String(n).padStart(2, '0') + '</b> / ' + total;

    var bar = document.getElementById('progress');
    if (bar) {
      var slide = Deck.slides[Deck.index];
      var f = fragsOf(slide).length;
      var sub = f ? Deck.frag / f : 0;
      bar.style.width = ((Deck.index + (f ? sub : 1) * 0.999) / total) * 100 + '%';
    }

    var sec = Deck.slides[Deck.index].dataset.section;
    Array.prototype.forEach.call(document.querySelectorAll('#rail .r-sec'), function (el) {
      el.classList.toggle('on', el.dataset.section === sec);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ov-card'), function (el) {
      el.classList.toggle('on', +el.dataset.i === Deck.index);
    });
  }

  function buildRail() {
    var rail = document.getElementById('rail');
    if (!rail) return;
    var sections = [];
    Deck.slides.forEach(function (s) {
      var name = s.dataset.section || '—';
      var last = sections[sections.length - 1];
      if (!last || last.name !== name) sections.push({ name: name, count: 1, first: Deck.slides.indexOf(s) });
      else last.count++;
    });
    rail.innerHTML = '';
    sections.forEach(function (sec) {
      var el = document.createElement('div');
      el.className = 'r-sec';
      el.dataset.section = sec.name;
      el.style.height = 10 + sec.count * 11 + 'px';
      el.innerHTML = '<span class="r-name">' + sec.name + '</span>';
      el.addEventListener('click', function () { show(sec.first, 0); });
      rail.appendChild(el);
    });
  }

  function buildOverview() {
    var grid = document.getElementById('ov-grid');
    if (!grid) return;
    grid.innerHTML = '';
    Deck.slides.forEach(function (s, i) {
      var card = document.createElement('div');
      card.className = 'ov-card';
      card.dataset.i = i;
      var accent = getComputedStyle(s).getPropertyValue('--accent');
      card.style.setProperty('--ov-accent', accent.trim());
      card.innerHTML =
        '<div class="n">' + String(i + 1).padStart(2, '0') + '</div>' +
        '<div class="t">' + (s.dataset.title || '') + '</div>' +
        '<div class="s">' + (s.dataset.section || '') + '</div>';
      card.addEventListener('click', function () {
        toggleOverview(false);
        show(i, 0);
      });
      grid.appendChild(card);
    });
  }

  function toggleOverview(force) {
    var ov = document.getElementById('overview');
    var on = force === undefined ? !ov.classList.contains('on') : force;
    ov.classList.toggle('on', on);
    if (on) {
      var active = ov.querySelector('.ov-card.on');
      if (active) active.scrollIntoView({ block: 'center' });
    }
  }

  function toggleHelp(force) {
    var h = document.getElementById('help');
    var on = force === undefined ? !h.classList.contains('on') : force;
    h.classList.toggle('on', on);
  }

  function toggleTheme() {
    var root = document.documentElement;
    var nowLight = root.getAttribute('data-theme') === 'light';
    root.setAttribute('data-theme', nowLight ? 'dark' : 'light');
    try { localStorage.setItem('bdm-theme', nowLight ? 'dark' : 'light'); } catch (e) {}
    document.dispatchEvent(new CustomEvent('theme:change'));
  }

  /* ---- keyboard --------------------------------------------------------- */
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var k = e.key;
    var ovOn = document.getElementById('overview').classList.contains('on');
    var helpOn = document.getElementById('help').classList.contains('on');

    if (k === 'Escape') {
      if (helpOn) return toggleHelp(false);
      if (ovOn) return toggleOverview(false);
      return;
    }
    if (helpOn && k !== '?') return;

    switch (k) {
      case 'ArrowRight': case 'PageDown': case ' ': case 'Enter':
        e.preventDefault(); next(); break;
      case 'ArrowLeft': case 'PageUp': case 'Backspace':
        e.preventDefault(); prev(); break;
      case 'ArrowDown':
        e.preventDefault(); show(Deck.index + 1, 0); break;
      case 'ArrowUp':
        e.preventDefault(); show(Deck.index - 1, 0); break;
      case 'Home': e.preventDefault(); show(0, 0); break;
      case 'End': e.preventDefault(); show(Deck.slides.length - 1, 0); break;
      case 'o': case 'O': toggleOverview(); break;
      case 't': case 'T': toggleTheme(); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case '?': toggleHelp(); break;
    }
  }

  /* ---- boot ------------------------------------------------------------- */
  function boot() {
    Deck.slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
    if (!Deck.slides.length) return;

    try {
      var saved = localStorage.getItem('bdm-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {}

    buildRail();
    buildOverview();
    fitStage();

    window.addEventListener('resize', fitStage);
    document.addEventListener('keydown', onKey);

    var elNext = document.getElementById('btn-next');
    var elPrev = document.getElementById('btn-prev');
    var elOv = document.getElementById('btn-ov');
    var elTh = document.getElementById('btn-theme');
    var elHp = document.getElementById('btn-help');
    if (elNext) elNext.addEventListener('click', next);
    if (elPrev) elPrev.addEventListener('click', prev);
    if (elOv) elOv.addEventListener('click', function () { toggleOverview(); });
    if (elTh) elTh.addEventListener('click', toggleTheme);
    if (elHp) elHp.addEventListener('click', function () { toggleHelp(); });
    var ovClose = document.getElementById('ov-close');
    if (ovClose) ovClose.addEventListener('click', function () { toggleOverview(false); });
    document.getElementById('help').addEventListener('click', function (e) {
      if (e.target.id === 'help') toggleHelp(false);
    });

    /* jump links inside slides: data-goto="7" */
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-goto]');
      if (t) { show(+t.dataset.goto - 1, 0); }
    });

    var start = 0;
    var m = /^#\/(\d+)$/.exec(location.hash);
    if (m) start = Math.max(0, Math.min(Deck.slides.length - 1, +m[1] - 1));

    Deck.ready = true;
    show(start, 0);
    document.dispatchEvent(new CustomEvent('deck:ready'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ---- helpers used by widgets ------------------------------------------ */
  Deck.onSlide = function (id, handler) {
    var el = document.getElementById(id);
    if (!el) return;
    var initialised = false;
    el.addEventListener('slide:enter', function () {
      if (!initialised) { initialised = true; handler.init && handler.init(el); }
      handler.enter && handler.enter(el);
    });
    el.addEventListener('slide:leave', function () { handler.leave && handler.leave(el); });
  };

  /* animated number counter */
  Deck.countTo = function (el, to, opts) {
    opts = opts || {};
    var dur = opts.duration || 900;
    var dec = opts.decimals === undefined ? 0 : opts.decimals;
    var from = opts.from === undefined ? 0 : opts.from;
    var t0 = performance.now();
    var fmt = function (v) { return (opts.prefix || '') + v.toFixed(dec).replace('.', ',') + (opts.suffix || ''); };
    /* write the final value first: if rAF never runs (hidden tab, reduced
       motion) the number is still correct rather than stuck at zero */
    el.textContent = fmt(to);
    function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };
})();
