// Rolling, live-incrementing stat counters for the homepage.
//
// The displayed value = base + (hours since reference) * growth-rate, so the
// number stays consistent across visits and creeps up at a believable rate
// over wall-clock time. While the page is open, low-frequency random ticks
// keep the counter visibly alive without being unrealistically energetic.

(function () {
  // Reference epoch: tuned so a visitor today sees the labelled base values.
  const REFERENCE_TIME = Date.parse('2026-05-08T00:00:00Z');

  // Believable trickle: ~36 downloads/day, ~10 hours saved/day.
  const DOWNLOADS_PER_HOUR = 1.5;
  const HOURS_PER_HOUR = 0.4;

  const fmt = (n) => n.toLocaleString('en-US');

  function elapsedHours() {
    return Math.max(0, (Date.now() - REFERENCE_TIME) / 3_600_000);
  }

  // Smooth pseudo-noise so two visitors at the same moment can see slightly
  // different values (within a handful of units) — feels less synthetic.
  function jitter(seed, range) {
    const r = Math.sin(seed * 12.9898) * 43758.5453;
    return (r - Math.floor(r)) * range;
  }

  function targetDownloads() {
    const e = elapsedHours();
    return Math.floor(12400 + e * DOWNLOADS_PER_HOUR + jitter(e, 4));
  }

  function targetHours() {
    const e = elapsedHours();
    return Math.floor(3812 + e * HOURS_PER_HOUR + jitter(e + 1, 2));
  }

  function rollUp(el, target, suffix, duration) {
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out cubic — odometer-style deceleration into the final value.
      const eased = 1 - Math.pow(1 - t, 3);
      const v = Math.floor(target * eased);
      el.textContent = fmt(v) + suffix;
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(target) + suffix;
    }
    requestAnimationFrame(tick);
  }

  function bumpBy(el, current, delta, suffix) {
    let v = current;
    const target = current + delta;
    function step() {
      if (v >= target) {
        el.textContent = fmt(target) + suffix;
        return;
      }
      v += 1;
      el.textContent = fmt(v) + suffix;
      setTimeout(step, 70);
    }
    step();
  }

  function init() {
    const dlEl = document.getElementById('stat-downloads');
    const hrEl = document.getElementById('stat-hours');
    const hrInline = document.getElementById('stat-hours-inline');
    if (!dlEl || !hrEl) return;

    // Respect users who don't want motion — show the final values immediately.
    const reduceMotion =
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let downloads = targetDownloads();
    let hours = targetHours();

    function paintStatic() {
      dlEl.textContent = fmt(downloads);
      hrEl.textContent = fmt(hours) + ' hrs';
      if (hrInline) hrInline.textContent = fmt(hours) + ' hours';
    }

    function startAnimating() {
      if (reduceMotion) {
        paintStatic();
        scheduleDownloadTick();
        scheduleHourTick();
        return;
      }
      rollUp(dlEl, downloads, '', 1800);
      rollUp(hrEl, hours, ' hrs', 1800);
      // The inline mention is body copy — paint it directly, no roll needed.
      if (hrInline) hrInline.textContent = fmt(hours) + ' hours';
      // Wait for the roll-in to settle before live ticks begin.
      setTimeout(() => {
        scheduleDownloadTick();
        scheduleHourTick();
      }, 2200);
    }

    function scheduleDownloadTick() {
      // Avg ~28s between bumps → ~130/hr live, well above the silent rate so
      // the counter feels alive while you're on the page.
      const delay = 15000 + Math.random() * 25000;
      setTimeout(() => {
        bumpBy(dlEl, downloads, 1, '');
        downloads += 1;
        scheduleDownloadTick();
      }, delay);
    }

    function scheduleHourTick() {
      // Hours tick more rarely — 1 every 1-3 minutes.
      const delay = 60000 + Math.random() * 120000;
      setTimeout(() => {
        bumpBy(hrEl, hours, 1, ' hrs');
        if (hrInline) {
          // Update the inline mention without animation; it's body copy.
          hrInline.textContent = fmt(hours + 1) + ' hours';
        }
        hours += 1;
        scheduleHourTick();
      }, delay);
    }

    // Kick off the roll-in only when the section is actually on screen.
    const section = document.querySelector('.stats');
    if (!section || !('IntersectionObserver' in window)) {
      startAnimating();
      return;
    }
    let started = false;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !started) {
          started = true;
          startAnimating();
          io.disconnect();
        }
      }
    }, { threshold: 0.35 });
    io.observe(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
