/* ═══════════════════════════════════════════════════════════════════════════
   OpenFleet Hero Particle / Constellation Canvas
   Lightweight, performant, no dependencies.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const canvas = document.getElementById('hero-particles');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const PARTICLE_COUNT = 60;
  const LINE_DIST = 140;
  const PARTICLE_SPEED = 0.25;
  const COLOR = { r: 96, g: 204, b: 93 }; // VirtEngine green

  let particles = [];
  let width, height;
  let mouse = { x: -9999, y: -9999 };
  let animId;

  function resize() {
    const hero = canvas.parentElement;
    width = canvas.width = hero.offsetWidth;
    height = canvas.height = hero.offsetHeight;
  }

  function createParticle() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * PARTICLE_SPEED,
      vy: (Math.random() - 0.5) * PARTICLE_SPEED,
      size: Math.random() * 2 + 0.5,
      opacity: Math.random() * 0.5 + 0.2,
    };
  }

  function init() {
    resize();
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(createParticle());
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Draw connections
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < LINE_DIST) {
          const alpha = (1 - dist / LINE_DIST) * 0.15;
          ctx.strokeStyle = `rgba(${COLOR.r}, ${COLOR.g}, ${COLOR.b}, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }

      // Mouse-particle connection
      const mdx = particles[i].x - mouse.x;
      const mdy = particles[i].y - mouse.y;
      const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
      if (mDist < LINE_DIST * 1.5) {
        const alpha = (1 - mDist / (LINE_DIST * 1.5)) * 0.35;
        ctx.strokeStyle = `rgba(${COLOR.r}, ${COLOR.g}, ${COLOR.b}, ${alpha})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }
    }

    // Draw particles
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${COLOR.r}, ${COLOR.g}, ${COLOR.b}, ${p.opacity})`;
      ctx.fill();
    }
  }

  function update() {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;

      // Gentle mouse repulsion
      const mdx = p.x - mouse.x;
      const mdy = p.y - mouse.y;
      const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
      if (mDist < 100 && mDist > 0) {
        p.vx += (mdx / mDist) * 0.02;
        p.vy += (mdy / mDist) * 0.02;
      }

      // Speed damping
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > PARTICLE_SPEED * 2) {
        p.vx *= 0.98;
        p.vy *= 0.98;
      }

      // Wrap around edges
      if (p.x < -10) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;
      if (p.y < -10) p.y = height + 10;
      if (p.y > height + 10) p.y = -10;
    }
  }

  function loop() {
    update();
    draw();
    animId = requestAnimationFrame(loop);
  }

  // Mouse tracking (throttled)
  let mouseThrottle = false;
  canvas.addEventListener('mousemove', function (e) {
    if (mouseThrottle) return;
    mouseThrottle = true;
    requestAnimationFrame(function () {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouseThrottle = false;
    });
  });

  canvas.addEventListener('mouseleave', function () {
    mouse.x = -9999;
    mouse.y = -9999;
  });

  // Responsive
  let resizeThrottle;
  window.addEventListener('resize', function () {
    clearTimeout(resizeThrottle);
    resizeThrottle = setTimeout(function () {
      resize();
      // Re-clamp particle positions
      for (const p of particles) {
        if (p.x > width) p.x = Math.random() * width;
        if (p.y > height) p.y = Math.random() * height;
      }
    }, 200);
  });

  // Pause when not visible
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelAnimationFrame(animId);
    } else {
      loop();
    }
  });

  // Defer start until hero in view
  const heroEl = document.getElementById('hero');
  if (heroEl && 'IntersectionObserver' in window) {
    const obs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        init();
        loop();
        obs.disconnect();
      }
    }, { threshold: 0.1 });
    obs.observe(heroEl);
  } else {
    init();
    loop();
  }
})();
