/* ABxAG site animations — dependency-free vanilla JS.
 * Per Gemini + ChatGPT review: transform/opacity only, IntersectionObserver
 * with unobserve (production-safe), everything skipped under
 * prefers-reduced-motion. No-JS browsers see all content (JS adds hooks). */
(function () {
  'use strict';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  /* 1. Scroll reveal: .reveal → .is-visible once, then unobserve. */
  try {
    if ('IntersectionObserver' in window) {
      var targets = document.querySelectorAll('.card, .stat, .term, .ver-card, .ship-card, .sec-head, .dl-card, .chips');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      Array.prototype.forEach.call(targets, function (el) {
        el.classList.add('reveal');
        io.observe(el);
      });
      // Backstop: auto-translate and other DOM churn can detach observed
      // nodes (their callbacks never fire). Sweep visible ones into view
      // so content can never get stuck invisible.
      setTimeout(function () {
        try {
          var vh = window.innerHeight || 800;
          Array.prototype.forEach.call(
            document.querySelectorAll('.reveal:not(.is-visible)'),
            function (el) {
              var b = el.getBoundingClientRect();
              if (b.top < vh && b.bottom > 0) {
                el.classList.add('is-visible');
                io.unobserve(el);
              }
            }
          );
        } catch (e2) { /* reveal-all fallback below */ }
      }, 2500);
    }
  } catch (e) { /* content stays visible */ }

  /* 2. Stat count-up, once, eased. Static: <span data-countup="96">96</span>.
     Live (feed fills later): bare data-countup + abxag:countup event. */
  function animateCount(el, end) {
    end = Math.max(0, end | 0);
    var start = parseInt(el.textContent, 10);
    if (!isFinite(start) || start < 0) start = 0;
    if (start >= end) { el.textContent = String(end); return; }
    var t0 = performance.now(), dur = 1100;
    (function tick(t) {
      var p = Math.min(1, (t - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(start + (end - start) * eased));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }
  try {
    var nums = document.querySelectorAll('[data-countup]');
    if (nums.length && 'IntersectionObserver' in window) {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          var attr = el.getAttribute('data-countup');
          // Bare attribute + non-numeric text = live value not here yet;
          // keep observing, the abxag:countup event will animate it.
          if ((attr === null || attr === '') && !isFinite(parseInt(el.textContent, 10))) return;
          cio.unobserve(el);
          animateCount(el, parseInt(attr || el.textContent, 10) || 0);
        });
      }, { threshold: 0.4 });
      Array.prototype.forEach.call(nums, function (el) { cio.observe(el); });
    }
    document.addEventListener('abxag:countup', function (ev) {
      var el = ev && ev.detail && ev.detail.id && document.getElementById(ev.detail.id);
      if (el) animateCount(el, parseInt(el.getAttribute('data-countup'), 10) || 0);
    });
  } catch (e) { /* static numbers stay */ }

  /* 3. Card tilt: desktop pointers only, rAF-throttled, max 6deg. */
  try {
    if (!finePointer || !('requestAnimationFrame' in window)) return;
    var cards = document.querySelectorAll('.card, .ship-card');
    Array.prototype.forEach.call(cards, function (card) {
      var raf = 0;
      card.addEventListener('mousemove', function (ev) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var b = card.getBoundingClientRect();
          var rx = ((ev.clientY - b.top) / b.height - 0.5) * -8;
          var ry = ((ev.clientX - b.left) / b.width - 0.5) * 8;
          card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-2px)';
        });
      });
      card.addEventListener('mouseleave', function () {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        card.style.transform = '';
      });
    });
  } catch (e) { /* no tilt */ }
})();
