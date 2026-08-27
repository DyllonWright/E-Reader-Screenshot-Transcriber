// gui/public/app.js

document.addEventListener("DOMContentLoaded", () => {
  // --- Handcrafted Cosmic Starfield Canvas Engine ---
  class CosmicStarfield {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext("2d");
      if (!this.ctx) return;

      this.stars = [];
      this.meteors = [];
      this.mouseX = 0;
      this.mouseY = 0;
      this.targetMouseX = 0;
      this.targetMouseY = 0;
      this.animationFrameId = null;
      this.lastTime = performance.now();
      this.nextMeteorTime = performance.now() + 6000 + Math.random() * 10000;
      this.isLowMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Realistic cosmic star color palette
      this.colors = [
        "rgba(255, 255, 255, ",   // Pure Radiant White
        "rgba(165, 243, 252, ",   // Quasar Cyan Tint
        "rgba(221, 214, 254, ",   // Esoteric Violet Tint
        "rgba(254, 240, 138, ",   // Golden Starlight Tint
        "rgba(251, 207, 232, "    // Warm Nebula Magenta Tint
      ];

      this.init();
    }

    init() {
      this.resize();
      this.createBlackHole();
      this.createStars();
      this.bindEvents();
      this.animate(performance.now());
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.ctx.scale(dpr, dpr);
      this.createBlackHole();
    }

    createBlackHole() {
      // Massive, colossal black hole positioned across lower background ("looking over the edge of a Gargantua void").
      // Raised slightly (0.68 vs the old 0.72) so scrolling down lets the south polar jet peek up from the bottom edge.
      this.bhCenterX = this.width * 0.5;
      this.bhCenterY = this.height * 0.68;
      this.bhRadius = 360; // Colossal event horizon radius
      this.diskRotation = 0;

      // Infalling accretion dust particles orbiting in the distant void
      this.accretionDust = [];
      const numDust = 50;
      for (let i = 0; i < numDust; i++) {
        this.accretionDust.push(this.generateDustParticle(true));
      }
    }

    generateDustParticle(randomRadius = false) {
      const minR = this.bhRadius + 20;
      const maxR = 900;
      const r = randomRadius ? minR + Math.random() * (maxR - minR) : maxR - Math.random() * 40;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.0003 + (200 / r) * 0.0002;
      const inwardSpeed = 0.04 + (1 - r / maxR) * 0.08;

      return {
        r: r,
        angle: angle,
        speed: speed,
        inwardSpeed: inwardSpeed,
        size: 0.7 + Math.random() * 1.4,
        baseHue: Math.random() < 0.5 ? 195 : 45
      };
    }

    createStars() {
      this.stars = [];
      const density = (this.width * this.height) / 8500;
      const totalStars = Math.min(Math.max(Math.floor(density), 130), 260);

      for (let i = 0; i < totalStars; i++) {
        const layer = Math.random() < 0.6 ? 1 : Math.random() < 0.85 ? 2 : 3;
        
        let baseRadius, baseOpacity, hasFlare;
        if (layer === 1) {
          baseRadius = 0.4 + Math.random() * 0.5;
          baseOpacity = 0.15 + Math.random() * 0.25;
          hasFlare = false;
        } else if (layer === 2) {
          baseRadius = 0.9 + Math.random() * 0.7;
          baseOpacity = 0.35 + Math.random() * 0.4;
          hasFlare = false;
        } else {
          baseRadius = 1.8 + Math.random() * 1.2;
          baseOpacity = 0.65 + Math.random() * 0.35;
          hasFlare = Math.random() < 0.75;
        }

        const randType = Math.random();
        let starType = "standard";
        if (randType > 0.92) {
          starType = "chromatic";
        } else if (randType > 0.82) {
          starType = "gold";
        }

        const initialX = Math.random() * this.width;
        const initialY = Math.random() * this.height;
        const dx = initialX - this.bhCenterX;
        const dy = initialY - this.bhCenterY;
        const polarDist = Math.hypot(dx, dy);
        const polarAngle = Math.atan2(dy, dx);
        const orbitalSpeed = (0.000008 / Math.sqrt(layer)) * (1 / (1 + polarDist * 0.0005));

        this.stars.push({
          polarDist: polarDist,
          polarAngle: polarAngle,
          orbitalSpeed: orbitalSpeed,
          radius: baseRadius,
          layer: layer,
          type: starType,
          hue: Math.random() * 360,
          hueSpeed: 0.02 + Math.random() * 0.05,
          baseOpacity: baseOpacity,
          twinkleSpeed: 0.001 + Math.random() * 0.003,
          twinklePhase: Math.random() * Math.PI * 2,
          hasFlare: hasFlare
        });
      }
    }

    bindEvents() {
      this.scrollY = 0;
      this.targetScrollY = 0;

      window.addEventListener("resize", () => {
        this.resize();
        this.createStars();
      }, { passive: true });

      window.addEventListener("mousemove", (e) => {
        if (this.isLowMotion) return;
        this.targetMouseX = (e.clientX - this.width / 2) * 0.015;
        this.targetMouseY = (e.clientY - this.height / 2) * 0.015;
      }, { passive: true });

      window.addEventListener("scroll", () => {
        if (this.isLowMotion) return;
        this.targetScrollY = window.scrollY || window.pageYOffset || 0;
      }, { passive: true });

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        } else {
          this.lastTime = performance.now();
          this.animate(performance.now());
        }
      });
    }

    spawnMeteor() {
      if (this.isLowMotion) return;
      const startX = Math.random() * (this.width * 0.7) + this.width * 0.3;
      const startY = Math.random() * (this.height * 0.4);
      const angle = (Math.PI / 4) + (Math.random() - 0.5) * 0.2;
      const speed = 7 + Math.random() * 6;

      this.meteors.push({
        x: startX,
        y: startY,
        vx: -Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        length: 80 + Math.random() * 70,
        life: 1.0,
        decay: 0.015 + Math.random() * 0.01
      });
    }

    renderPolarJetBeam(cx, cy, angle, isForeground) {
      const jetLen = Math.max(this.width, this.height) * 0.75;
      const alphaScale = isForeground ? 0.75 : 0.28;

      this.ctx.save();
      this.ctx.translate(cx, cy);
      this.ctx.rotate(angle);

      const jetGrad = this.ctx.createLinearGradient(0, 0, jetLen, 0);
      jetGrad.addColorStop(0, `rgba(255, 255, 255, ${alphaScale.toFixed(2)})`);
      jetGrad.addColorStop(0.12, `rgba(165, 243, 252, ${(alphaScale * 0.75).toFixed(2)})`);
      jetGrad.addColorStop(0.45, `rgba(168, 85, 247, ${(alphaScale * 0.35).toFixed(2)})`);
      jetGrad.addColorStop(1, "rgba(0, 0, 0, 0)");

      this.ctx.fillStyle = jetGrad;
      this.ctx.beginPath();
      this.ctx.moveTo(0, -3);
      this.ctx.lineTo(jetLen, -20);
      this.ctx.lineTo(jetLen, 20);
      this.ctx.lineTo(0, 3);
      this.ctx.fill();

      // Core intense photon beam ray
      this.ctx.strokeStyle = `rgba(255, 255, 255, ${(alphaScale * 0.9).toFixed(2)})`;
      this.ctx.lineWidth = 1.6;
      this.ctx.beginPath();
      this.ctx.moveTo(0, 0);
      this.ctx.lineTo(jetLen, 0);
      this.ctx.stroke();

      this.ctx.restore();
    }

    renderBlackHole(delta, now) {
      if (this.isLowMotion) return;
      // Pan the hole upward as you scroll so the south (bottom) jet rises into view.
      // Clamped: a short scroll gives a strong reveal, but it never flies off-screen
      // on taller wizard steps that scroll far.
      const scrollPanUp = Math.min((this.scrollY || 0) * 1.4, 430);
      const cx = this.bhCenterX + this.mouseX * 0.3;
      const cy = (this.bhCenterY - scrollPanUp) + this.mouseY * 0.3;
      const R = this.bhRadius;

      // --- Tilted-disk model ---
      // One angle drives the whole system: the screen-space lean of the disk's
      // major axis. Negative lifts the right edge ("/" lean).
      this.diskRotation += 0.00008 * delta;
      const diskTiltRotation = -0.38; // ~22° "/" lean

      // Disk lies in the equatorial plane. We view it near edge-on, so it reads
      // as a thin ellipse:
      //   - major axis: unscaled (diskScaleX = 1.0), so a ring at radius r lands
      //     at screen radius r — the inner ring at R*1.12 hugs the event-horizon
      //     circle instead of floating off to the side (the old 2.0 stretched
      //     every ring to twice the horizon width and detached the disk).
      //   - minor axis (depth): squashed by diskForeshorten for the edge-on look.
      const diskScaleX = 1.0;
      const diskForeshorten = 0.32;

      // The spin axis is PERPENDICULAR to the disk plane, so the jets emerge
      // through the disk's faces — along the disk's minor axis in screen space,
      // not along its length. north-pole direction = disk major axis turned 90°:
      // (sin θ, -cos θ). With θ = -0.38 that points up-and-left; the south pole
      // mirrors it down-and-right, so the two jets sit on the "\" diagonal and
      // cross the "/" disk at a right angle. (dot product with the disk major
      // axis is exactly 0 — provably perpendicular.)
      const axisX = Math.sin(diskTiltRotation);
      const axisY = -Math.cos(diskTiltRotation);

      // The axis also tilts toward the viewer, so the poles project onto the
      // sphere's faces rather than its silhouette. poleProject < 1 pulls each
      // pole in from the rim: the NEAR (north/top) pole lands on the visible
      // near face — in our sight — while the FAR (south/bottom) pole lands on
      // the back face, where the event-horizon fill (drawn after the south jet)
      // occludes it. 1.0 would put both back on the rim edge-on.
      const poleProject = 0.60;
      const northPoleX = cx + axisX * R * poleProject;
      const northPoleY = cy + axisY * R * poleProject;
      const southPoleX = cx - axisX * R * poleProject;
      const southPoleY = cy - axisY * R * poleProject;

      const northJetAngle = Math.atan2(axisY, axisX); // toward the (upper-left) north pole
      const southJetAngle = Math.atan2(-axisY, -axisX); // toward the (lower-right) south pole

      // Subtle precession wobble in jet angle
      const wobble = Math.sin(now * 0.00006) * 0.04;

      this.ctx.save();

      // --- Layer 1: South polar jet beam (behind disk & event horizon) ---
      this.renderPolarJetBeam(southPoleX, southPoleY, southJetAngle + wobble, false);

      // --- Layer 2: Accretion Disk (in front of south jet, behind north jet) ---
      // Disk geometry: We view the disk plane nearly edge-on.
      // The disk ellipse major axis is perpendicular to the spin axis.
      // diskScaleX = 1.0 (natural canvas units match R)
      // diskScaleY = sin(axisTilt) = how thin the edge-on foreshortening makes the disk
      // The rotation aligns the major axis perpendicular to spin axis in screen space.
      // To ring at radius r in disk coords: screen semi-major = r*diskScaleX, screen semi-minor = r*diskScaleY
      // So ring at R*1.15 will appear to just surround the event horizon circle of radius R.
      this.ctx.save();
      this.ctx.translate(cx, cy);
      this.ctx.rotate(diskTiltRotation);
      this.ctx.scale(diskScaleX, diskForeshorten);

      // Outer plasma glow gradient — starts at event horizon edge
      const outerGrad = this.ctx.createRadialGradient(0, 0, R, 0, 0, R * 4.5);
      outerGrad.addColorStop(0,    "rgba(255, 255, 255, 0.40)");
      outerGrad.addColorStop(0.10, "rgba(165, 243, 252, 0.22)");
      outerGrad.addColorStop(0.35, "rgba(245, 158, 11,  0.14)");
      outerGrad.addColorStop(0.70, "rgba(168,  85, 247, 0.08)");
      outerGrad.addColorStop(1,    "rgba(0, 0, 0, 0)");
      this.ctx.fillStyle = outerGrad;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, R * 4.5, 0, Math.PI * 2);
      this.ctx.fill();

      // Concentric ring bands proportional to event horizon radius R
      const ringRadii = [R * 1.12, R * 1.5, R * 2.1, R * 3.0];
      const ringAlphas = [0.22, 0.13, 0.08, 0.04];
      for (let rIdx = 0; rIdx < ringRadii.length; rIdx++) {
        this.ctx.strokeStyle = `rgba(165, 243, 252, ${ringAlphas[rIdx].toFixed(2)})`;
        this.ctx.lineWidth = 2.2 - rIdx * 0.4;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, ringRadii[rIdx], 0, Math.PI * 2);
        this.ctx.stroke();
      }

      // Spinning dust particles in disk plane
      for (let i = 0; i < this.accretionDust.length; i++) {
        const p = this.accretionDust[i];
        p.angle += p.speed * delta;
        p.r -= p.inwardSpeed * (delta / 16);

        if (p.r <= R + 8) {
          this.accretionDust[i] = this.generateDustParticle(false);
          continue;
        }

        const px = Math.cos(p.angle + this.diskRotation) * p.r;
        const py = Math.sin(p.angle + this.diskRotation) * p.r;
        const proximityRatio = Math.max(0, 1 - (p.r - R) / 700);
        const alpha = (0.10 + proximityRatio * 0.38).toFixed(2);
        const hue = p.baseHue + (200 - p.baseHue) * proximityRatio;

        this.ctx.fillStyle = `hsla(${hue.toFixed(0)}, 95%, 75%, ${alpha})`;
        this.ctx.beginPath();
        this.ctx.arc(px, py, p.size * (1 + proximityRatio * 0.4), 0, Math.PI * 2);
        this.ctx.fill();
      }

      this.ctx.restore();

      // --- Layer 3: Event Horizon void — drawn on top of disk, below north jet ---
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, R, 0, Math.PI * 2);
      this.ctx.fillStyle = "#010207";
      this.ctx.fill();

      // Photon sphere / gravitational lensing glow ring
      this.ctx.lineWidth = 2.0;
      this.ctx.strokeStyle = "rgba(165, 243, 252, 0.40)";
      this.ctx.stroke();

      const lensGrad = this.ctx.createRadialGradient(cx, cy, R, cx, cy, R * 1.6);
      lensGrad.addColorStop(0,   "rgba(255, 255, 255, 0.18)");
      lensGrad.addColorStop(0.4, "rgba(165, 243, 252, 0.08)");
      lensGrad.addColorStop(1,   "rgba(0, 0, 0, 0)");
      this.ctx.fillStyle = lensGrad;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, R * 1.6, 0, Math.PI * 2);
      this.ctx.fill();

      // --- Layer 4: North polar jet beam — on top of everything, emerging from pole apex ---
      this.renderPolarJetBeam(northPoleX, northPoleY, northJetAngle - wobble, true);

      this.ctx.restore();
    }

    animate(now) {
      const delta = now - this.lastTime;
      this.lastTime = now;

      this.mouseX += (this.targetMouseX - this.mouseX) * 0.05;
      this.mouseY += (this.targetMouseY - this.mouseY) * 0.05;
      this.scrollY += ((this.targetScrollY || 0) - (this.scrollY || 0)) * 0.08;

      this.ctx.clearRect(0, 0, this.width, this.height);

      this.renderBlackHole(delta, now);

      // Pan the hole upward as you scroll so the south (bottom) jet rises into view.
      // Clamped: a short scroll gives a strong reveal, but it never flies off-screen
      // on taller wizard steps that scroll far.
      const scrollPanUp = Math.min((this.scrollY || 0) * 1.4, 430);

      for (let i = 0; i < this.stars.length; i++) {
        const star = this.stars[i];

        star.polarAngle += star.orbitalSpeed * delta;
        const currentX = this.bhCenterX + Math.cos(star.polarAngle) * star.polarDist;
        const currentY = (this.bhCenterY - scrollPanUp) + Math.sin(star.polarAngle) * star.polarDist;

        const parallaxX = this.mouseX * star.layer;
        const parallaxY = this.mouseY * star.layer;
        const renderX = currentX + parallaxX;
        const renderY = currentY + parallaxY;

        star.twinklePhase += star.twinkleSpeed * delta;
        const twinkleAlpha = star.baseOpacity * (0.7 + 0.3 * Math.sin(star.twinklePhase));

        // Determine color styling based on star type
        let fillStyle, strokeStyle;
        if (star.type === "chromatic") {
          // Smoothly shift hue through red -> green -> blue -> cyan -> magenta
          star.hue = (star.hue + star.hueSpeed * delta) % 360;
          fillStyle = `hsla(${star.hue.toFixed(1)}, 95%, 68%, ${twinkleAlpha.toFixed(3)})`;
          strokeStyle = `hsla(${star.hue.toFixed(1)}, 95%, 68%, ${(twinkleAlpha * 0.55).toFixed(3)})`;
        } else if (star.type === "gold") {
          fillStyle = `hsla(45, 95%, 65%, ${twinkleAlpha.toFixed(3)})`;
          strokeStyle = `hsla(45, 95%, 65%, ${(twinkleAlpha * 0.5).toFixed(3)})`;
        } else {
          // Standard white star
          fillStyle = `rgba(255, 255, 255, ${twinkleAlpha.toFixed(3)})`;
          strokeStyle = `rgba(255, 255, 255, ${(twinkleAlpha * 0.45).toFixed(3)})`;
        }

        this.ctx.beginPath();
        this.ctx.arc(renderX, renderY, star.radius, 0, Math.PI * 2);
        this.ctx.fillStyle = fillStyle;
        this.ctx.fill();

        if (star.hasFlare && star.layer === 3) {
          const flareLen = star.radius * (3.5 + Math.sin(star.twinklePhase * 1.5) * 1.2);

          this.ctx.strokeStyle = strokeStyle;
          this.ctx.lineWidth = 0.7;
          this.ctx.beginPath();
          this.ctx.moveTo(renderX - flareLen, renderY);
          this.ctx.lineTo(renderX + flareLen, renderY);
          this.ctx.moveTo(renderX, renderY - flareLen);
          this.ctx.lineTo(renderX, renderY + flareLen);
          this.ctx.stroke();
        }
      }

      if (now > this.nextMeteorTime) {
        this.spawnMeteor();
        this.nextMeteorTime = now + 14000 + Math.random() * 18000;
      }

      for (let i = this.meteors.length - 1; i >= 0; i--) {
        const m = this.meteors[i];
        m.x += m.vx;
        m.y += m.vy;
        m.life -= m.decay;

        if (m.life <= 0 || m.x < 0 || m.y > this.height) {
          this.meteors.splice(i, 1);
          continue;
        }

        const tailX = m.x - (m.vx / Math.hypot(m.vx, m.vy)) * m.length;
        const tailY = m.y - (m.vy / Math.hypot(m.vx, m.vy)) * m.length;

        const grad = this.ctx.createLinearGradient(m.x, m.y, tailX, tailY);
        grad.addColorStop(0, `rgba(255, 255, 255, ${(m.life * 0.9).toFixed(3)})`);
        grad.addColorStop(0.3, `rgba(165, 243, 252, ${(m.life * 0.6).toFixed(3)})`);
        grad.addColorStop(1, `rgba(168, 85, 247, 0)`);

        this.ctx.strokeStyle = grad;
        this.ctx.lineWidth = 1.4 * m.life;
        this.ctx.lineCap = "round";
        this.ctx.beginPath();
        this.ctx.moveTo(m.x, m.y);
        this.ctx.lineTo(tailX, tailY);
        this.ctx.stroke();
      }

      this.animationFrameId = requestAnimationFrame((t) => this.animate(t));
    }
  }

  // Initialize Cosmic Canvas
  const cosmicStarfield = new CosmicStarfield("cosmos-canvas");

  // --- Background Toggle Handler (Cosmic FX vs Minimalist Mode) ---
  const btnToggleBg = document.getElementById("btn-toggle-bg");
  const bgToggleLabel = document.getElementById("bg-toggle-label");
  const cosmosEl = document.querySelector(".cosmos");

  function setBgMode(isMinimalist) {
    if (!cosmosEl) return;
    if (isMinimalist) {
      cosmosEl.classList.add("minimalist");
      if (bgToggleLabel) bgToggleLabel.textContent = "Minimal BG";
      localStorage.setItem("evie_bg_minimalist", "true");
    } else {
      cosmosEl.classList.remove("minimalist");
      if (bgToggleLabel) bgToggleLabel.textContent = "Cosmic FX";
      localStorage.setItem("evie_bg_minimalist", "false");
    }
  }

  // Restore saved user background preference
  const savedMinimalist = localStorage.getItem("evie_bg_minimalist") === "true";
  setBgMode(savedMinimalist);

  if (btnToggleBg) {
    btnToggleBg.addEventListener("click", () => {
      const isCurrentlyMinimal = cosmosEl ? cosmosEl.classList.contains("minimalist") : false;
      setBgMode(!isCurrentlyMinimal);
    });
  }

  // --- Panel Dimming Slider Handler ---
  const inputDimSlider = document.getElementById("input-dim-slider");

  function setPanelDim(val) {
    const opacity = parseFloat(val) || 0.88;
    document.documentElement.style.setProperty("--bg-card", `rgba(10, 11, 24, ${opacity})`);
    if (inputDimSlider) inputDimSlider.value = opacity;
    localStorage.setItem("evie_panel_dim", opacity.toString());
  }

  // Restore saved panel dimming preference
  const savedDim = localStorage.getItem("evie_panel_dim") || "0.88";
  setPanelDim(savedDim);

  if (inputDimSlider) {
    inputDimSlider.addEventListener("input", (e) => {
      setPanelDim(e.target.value);
    });
  }

  // --- Focus Mode Handler (Hide UI panels, show only cosmic canvas) ---
  const btnFocusMode = document.getElementById("btn-focus-mode");
  const focusModeLabel = document.getElementById("focus-mode-label");

  // Focus mode dims the whole workspace, so the class lives on <body>
  // (an ancestor of both the UI and the cosmos background), not on the
  // background layer itself — otherwise the CSS selectors reach nothing.
  function setFocusMode(active) {
    if (active) {
      document.body.classList.add("focus-mode");
      if (focusModeLabel) focusModeLabel.textContent = "Exit Focus";
      localStorage.setItem("evie_focus_mode", "true");
    } else {
      document.body.classList.remove("focus-mode");
      if (focusModeLabel) focusModeLabel.textContent = "Focus";
      localStorage.setItem("evie_focus_mode", "false");
    }
  }

  const savedFocusMode = localStorage.getItem("evie_focus_mode") === "true";
  setFocusMode(savedFocusMode);

  if (btnFocusMode) {
    btnFocusMode.addEventListener("click", () => {
      setFocusMode(!document.body.classList.contains("focus-mode"));
    });
  }

  // Esc always exits focus mode — a reliable way out if the pointer
  // strays from the header.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("focus-mode")) {
      setFocusMode(false);
    }
  });

  // --- Application State ---
  let appState = {
    bookTitle: "",
    recentBooks: [],
    dailyQuotaTarget: 50,
    apiKeyPresent: false,
    dates: [],
    datesInfo: [],
    archivedInfo: [],
    totalScreenshots: 0,
    groups: {},
    selectedDate: "",
    draftContent: "",
    illustrations: [], // From AI: { originalFile, suggestedName, time }
    lastRunStats: null
  };
  let ocrPollTimeout = null;
  let geminiTimerId = null;
  let archiveSse = null;

  // --- DOM Elements ---
  const stepConfig = document.getElementById("step-ind-config");
  const stepProcess = document.getElementById("step-ind-process");
  const stepReview = document.getElementById("step-ind-review");
  const stepSuccess = document.getElementById("step-ind-success");

  const panelConfig = document.getElementById("panel-config");
  const panelProcess = document.getElementById("panel-process");
  const panelReview = document.getElementById("panel-review");
  const panelSuccess = document.getElementById("panel-success");

  // Dev Stats DOM elements
  const btnDevStats = document.getElementById("btn-dev-stats");
  const modalDevStats = document.getElementById("modal-dev-stats");
  const btnCloseDevStats = document.getElementById("btn-close-dev-stats");
  const btnCloseDevStatsFooter = document.getElementById("btn-close-dev-stats-footer");
  const btnRefreshDevStats = document.getElementById("btn-refresh-dev-stats");
  const btnClearDevStats = document.getElementById("btn-clear-dev-stats");
  const devLastRunContainer = document.getElementById("dev-last-run-container");
  const devUtcWindowsContainer = document.getElementById("dev-utc-windows-container");
  const devCallsHistoryContainer = document.getElementById("dev-calls-history-container");
  const reviewBaselineBanner = document.getElementById("review-baseline-banner");

  const batchListContainer = document.getElementById("batch-list-container");
  const statWrapper = document.getElementById("stat-cards-wrapper");
  const statTotal = document.getElementById("stat-total-screens");
  const statText = document.getElementById("stat-text-pages");
  const statImage = document.getElementById("stat-illustrations");
  
  const formSettings = document.getElementById("form-settings");
  const inputBookTitle = document.getElementById("input-book-title");
  const inputApiKey = document.getElementById("input-api-key");
  const btnToggleKey = document.getElementById("btn-toggle-key");
  const keyStatusText = document.getElementById("key-status-text");
  const keyStatusRow = document.getElementById("key-status");
  const keyStatusBackups = document.getElementById("key-status-backups");

  /**
   * Paint the key-ring status row.
   *
   * `summary` is `{active: {label, fingerprint}, total, backups}` from the
   * server, already redacted there — the browser never receives the other
   * labels, so it cannot leak them. Pass null when no key is configured.
   */
  function renderKeyStatus(summary) {
    if (!keyStatusRow || !keyStatusText) return;

    if (!summary || !summary.active) {
      keyStatusRow.classList.remove("is-live");
      keyStatusRow.removeAttribute("title");
      keyStatusText.textContent = "No key configured — add one above, or put it in .env";
      if (keyStatusBackups) keyStatusBackups.hidden = true;
      return;
    }

    keyStatusRow.classList.add("is-live");
    keyStatusText.textContent = "";

    const label = document.createElement("span");
    label.textContent = summary.active.label;
    const fp = document.createElement("span");
    fp.className = "key-status-fp";
    fp.textContent = ` ${summary.active.fingerprint}`;
    keyStatusText.append(label, fp);

    const spares = summary.backups || 0;
    if (keyStatusBackups) {
      keyStatusBackups.hidden = spares === 0;
      keyStatusBackups.textContent = `+${spares} backup${spares === 1 ? "" : "s"}`;
    }
    keyStatusRow.title = spares
      ? `${spares} spare key${spares === 1 ? "" : "s"} rotate in automatically when this one hits its daily limit.`
      : "Only one key loaded. Add more to .env so a run survives hitting the daily limit.";
  }

  const inputFolderBar = document.getElementById("input-folder-bar");
  const filePicker = document.getElementById("input-file-picker");
  const ifbCount = document.getElementById("ifb-count");
  const btnRefreshBatches = document.getElementById("btn-refresh-batches");
  const btnOpenInput = document.getElementById("btn-open-input");
  const recentBooksEl = document.getElementById("recent-books");
  const uploadProgressContainer = document.getElementById("upload-progress-container");
  const uploadProgressFill = document.getElementById("upload-progress-bar");
  const uploadProgressLabel = document.getElementById("upload-progress-label");
  const uploadProgressPercent = document.getElementById("upload-progress-percent");

  // Archived batches strip
  const archivedSection = document.getElementById("archived-section");
  const archivedRecent = document.getElementById("archived-recent");
  const archivedRest = document.getElementById("archived-rest");
  const btnShowFullArchive = document.getElementById("btn-show-full-archive");
  const archiveFlagLabel = document.getElementById("archive-flag-label");

  // Stage 4 cleanup
  const cleanupCountEl = document.getElementById("cleanup-count");
  const cleanupDateEl = document.getElementById("cleanup-date");
  const cleanupActions = document.getElementById("cleanup-actions");
  const cleanupProgress = document.getElementById("cleanup-progress");
  const cleanupProgressLabel = document.getElementById("cleanup-progress-label");
  const cleanupProgressCount = document.getElementById("cleanup-progress-count");
  const cleanupProgressBar = document.getElementById("cleanup-progress-bar");
  const cleanupDone = document.getElementById("cleanup-done");
  const btnArchiveFinish = document.getElementById("btn-archive-finish");
  const btnDeleteRecycle = document.getElementById("btn-delete-recycle");
  const btnSkipCleanup = document.getElementById("btn-skip-cleanup");

  const illustrationsList = document.getElementById("illustration-helpers-list");
  const btnStart = document.getElementById("btn-start-processing");

  // Processing elements
  const processStepTitle = document.getElementById("process-step-title");
  const processPercent = document.getElementById("process-percentage");
  const processBarFill = document.getElementById("process-progress-bar");
  const consoleLogs = document.getElementById("terminal-logs");

  // Review elements
  const reviewGrid = document.getElementById("review-list-grid");
  const btnSaveFinalize = document.getElementById("btn-save-finalize");
  const btnBackConfig = document.getElementById("btn-back-to-config");

  // Success elements
  const outputMdName = document.getElementById("success-output-md");
  const outputImgFolderName = document.getElementById("success-output-img-folder");
  const btnExplorerFinal = document.getElementById("btn-show-in-explorer-final");
  const btnExplorerHeader = document.getElementById("btn-show-explorer-header");
  const btnResetPipeline = document.getElementById("btn-reset-pipeline");

  // --- Initialization ---
  generateStarfield();
  loadStatus();
  setupUploads();
  setupSlimBar();
  setupCleanup();
  setupEventListeners();

  // --- API Integrations ---

  // 1. Fetch backend configuration, screens status and pre-OCR classifications
  async function loadStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      appState.bookTitle = data.bookTitle;
      appState.recentBooks = data.recentBooks || [];
      appState.dailyQuotaTarget = data.dailyQuotaTarget || appState.dailyQuotaTarget || 50;
      appState.apiKeyPresent = data.apiKeyPresent;
      appState.dates = data.dates;
      appState.datesInfo = data.datesInfo || [];
      appState.archivedInfo = data.archivedInfo || [];
      appState.groups = data.groups;
      appState.lastRunStats = data.lastRunStats || null;
      appState.totalScreenshots = (data.datesInfo || []).reduce((sum, d) => sum + (d.totalFiles || 0), 0);

      // Populate Settings Inputs (don't clobber the field while the user is editing it)
      if (document.activeElement !== inputBookTitle) {
        inputBookTitle.value = data.bookTitle;
      }
      if (ifbCount) ifbCount.textContent = appState.totalScreenshots;
      renderRecentBooks();
      renderArchivedSection();
      // The active key, redacted, plus a count of the spares behind it. This
      // used to print every label in the ring, which on a thirteen-key ring
      // meant the owner's whole account list sat on screen to say "a key
      // works". The server now sends only the summary, so the full list is
      // not in the page, the JSON, or a screenshot of either.
      renderKeyStatus(data.apiKeyPresent ? data.keyRing : null);
 
      // Handle Background OCR Progress Heartbeat Widget
      const ocrCard = document.getElementById("ocr-progress-card");
      const ocrLabel = document.getElementById("ocr-count-label");
      const ocrFill = document.getElementById("ocr-progress-fill");
 
      if (data.ocrActive) {
        if (ocrCard) ocrCard.classList.remove("hidden");
        if (ocrLabel) ocrLabel.textContent = `${data.ocrProcessed} / ${data.ocrTotal}`;
        if (ocrFill) {
          const percent = data.ocrTotal > 0 ? Math.round((data.ocrProcessed / data.ocrTotal) * 100) : 0;
          ocrFill.style.width = `${percent}%`;
        }
        
        // Schedule next poll
        if (ocrPollTimeout) clearTimeout(ocrPollTimeout);
        ocrPollTimeout = setTimeout(loadStatus, 1500);
      } else {
        if (ocrCard) ocrCard.classList.add("hidden");
        if (ocrPollTimeout) {
          clearTimeout(ocrPollTimeout);
          ocrPollTimeout = null;
        }
      }
 
      // Render Batches List
      renderBatchList();
    } catch (err) {
      console.error("Failed to load system status:", err);
    }
  }

  // Render batches interactive cards list
  function renderBatchList() {
    const selected = appState.selectedDate;
    batchListContainer.innerHTML = "";

    if (appState.datesInfo.length === 0) {
      const hasArchive = appState.archivedInfo.length > 0;
      batchListContainer.innerHTML = hasArchive
        ? `<div class="batch-empty-hint">✨ All caught up — nothing waiting to process.<br>Recently archived batches are listed below.</div>`
        : `<div class="batch-empty-hint">No screenshots in the input folder yet.<br>Drop today's screenshots into the folder, then hit <b>Refresh</b>.</div>`;
      btnStart.disabled = true;
      statWrapper.classList.add("hidden");
      renderEmptyIllustrations();
      return;
    }

    appState.datesInfo.forEach(info => {
      const card = document.createElement("div");
      card.className = `batch-card status-${info.status}${info.date === selected ? ' selected' : ''}`;
      card.dataset.date = info.date;

      let statusBadgeHtml = "";
      let progressBarHtml = "";

      if (info.status === "completed") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-completed">🟣 Finalized</span>`;
      } else if (info.status === "paused") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-paused">🟠 Resume Draft</span>`;
      } else if (info.status === "ocr_done") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-ocr_done">🟢 Ready</span>`;
      } else {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-ocr_active">🔵 Analyzing…</span>`;
        const percent = info.totalFiles > 0 ? Math.round((info.ocrCachedCount / info.totalFiles) * 100) : 0;
        progressBarHtml = `
          <div class="batch-card-progress">
            <div class="batch-progress-info">
              <span>OCR heartbeat</span>
              <span>${info.ocrCachedCount} / ${info.totalFiles} (${percent}%)</span>
            </div>
            <div class="batch-progress-bar-bg">
              <div class="batch-progress-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="batch-card-header">
          <span class="batch-card-date">${info.date}</span>
          ${statusBadgeHtml}
        </div>
        <div class="batch-card-meta">
          <span>Total: ${info.totalFiles} screenshots</span>
        </div>
        ${progressBarHtml}
      `;

      card.addEventListener("click", () => {
        // Toggle selection
        document.querySelectorAll(".batch-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        updateSelectedBatchStats(info.date);
      });

      batchListContainer.appendChild(card);
    });

    if (selected && appState.dates.includes(selected)) {
      updateSelectedBatchStats(selected);
    } else {
      btnStart.disabled = true;
      statWrapper.classList.add("hidden");
      renderEmptyIllustrations();
    }
  }

  // Render the clickable "recently used books" chips (queue of 3)
  function renderRecentBooks() {
    if (!recentBooksEl) return;
    const books = appState.recentBooks || [];
    if (books.length === 0) {
      recentBooksEl.classList.add("hidden");
      recentBooksEl.innerHTML = "";
      return;
    }
    recentBooksEl.classList.remove("hidden");
    recentBooksEl.innerHTML = "";
    books.forEach(title => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `recent-book-chip${title === appState.bookTitle ? ' active' : ''}`;
      chip.textContent = title;
      chip.title = `Switch current book to: ${title}`;
      chip.addEventListener("click", () => switchBook(title));
      recentBooksEl.appendChild(chip);
    });
  }

  // Switch the active book (fills the field + persists immediately)
  async function switchBook(title) {
    inputBookTitle.value = title;
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookTitle: title })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      appState.bookTitle = title;
      loadStatus();
    } catch (err) {
      console.error("Failed to switch book:", err);
    }
  }

  // Render the "recently archived" strip: up to 3 recent + a flag to expand the rest
  function renderArchivedSection() {
    if (!archivedSection) return;
    const archived = appState.archivedInfo || [];
    if (archived.length === 0) {
      archivedSection.classList.add("hidden");
      archivedRecent.innerHTML = "";
      archivedRest.innerHTML = "";
      btnShowFullArchive.classList.add("hidden");
      return;
    }

    archivedSection.classList.remove("hidden");
    const recent = archived.slice(0, 3);
    const rest = archived.slice(3);

    archivedRecent.innerHTML = recent.map(archivedCardHtml).join("");
    if (rest.length > 0) {
      archivedRest.innerHTML = rest.map(archivedCardHtml).join("");
      btnShowFullArchive.classList.remove("hidden");
      if (archiveFlagLabel && archivedRest.classList.contains("hidden")) {
        archiveFlagLabel.textContent = `Show full archive (${rest.length} more)`;
      }
    } else {
      archivedRest.innerHTML = "";
      archivedRest.classList.add("hidden");
      btnShowFullArchive.classList.add("hidden");
    }
  }

  function archivedCardHtml(info) {
    const modeLabel = info.mode === "delete" ? "Recycled" : "Archived";
    const when = info.archivedAt ? new Date(info.archivedAt).toLocaleDateString() : "";
    const files = info.fileCount ? `${info.fileCount} screenshots` : "cleared";
    return `
      <div class="archived-card" title="${modeLabel}${when ? ' on ' + when : ''}">
        <div class="archived-card-left">
          <span class="archived-card-date">${info.date}</span>
          <span class="archived-card-meta">${modeLabel} · ${files}${when ? ' · ' + when : ''}</span>
        </div>
        <span class="batch-status-badge batch-status-archived">⚪ ${modeLabel}</span>
      </div>
    `;
  }

  // Handle batch selection change
  function updateSelectedBatchStats(date) {
    appState.selectedDate = date;
    const items = appState.groups[date] || [];

    const total = items.length;
    const images = items.filter(item => item.type === "image").length;
    const texts = items.filter(item => item.type === "text").length;
    const pending = items.filter(item => item.type === "pending").length;

    statTotal.textContent = total;
    statText.textContent = texts;
    statImage.textContent = images;
    statWrapper.classList.remove("hidden");

    // Check status of selected date batch
    const dateInfo = appState.datesInfo.find(d => d.date === date);
    const hasPending = pending > 0;
    const warningEl = document.getElementById("batch-pending-warning");
    
    if (hasPending) {
      if (warningEl) warningEl.classList.remove("hidden");
    } else {
      if (warningEl) warningEl.classList.add("hidden");
    }

    if (dateInfo) {
      if (dateInfo.status === "completed") {
        btnStart.textContent = "Load Saved Batch (Review / Redo Crops)";
        btnStart.disabled = false;
      } else if (dateInfo.status === "paused") {
        btnStart.textContent = "Resume Saved Batch (Review & Finalize)";
        btnStart.disabled = false;
      } else if (dateInfo.status === "ocr_active") {
        btnStart.textContent = "OCR Processing...";
        btnStart.disabled = true;
      } else {
        btnStart.textContent = "Run AI Transcription & Extractor";
        btnStart.disabled = hasPending || total === 0;
      }
    } else {
      btnStart.textContent = "Run AI Transcription & Extractor";
      btnStart.disabled = hasPending || total === 0;
    }

    // Render illustrations list for metadata capture
    renderIllustrationsConfig(items.filter(item => item.type === "image"));
  }

  // Renders empty illustrations text
  function renderEmptyIllustrations() {
    illustrationsList.innerHTML = `
      <div class="empty-illustrations">
        <p>No illustrations detected in this batch, or no batch selected.</p>
      </div>
    `;
  }

  // Render illustration config cards
  function renderIllustrationsConfig(images) {
    if (images.length === 0) {
      illustrationsList.innerHTML = `
        <div class="empty-illustrations">
          <p>No full-screen illustrations detected for this day (all screenshots are text pages).</p>
        </div>
      `;
      return;
    }

    illustrationsList.innerHTML = "";
    images.forEach(img => {
      const tile = document.createElement("div");
      tile.className = "ill-config-tile";
      tile.innerHTML = `
        <div class="thumbnail-wrapper">
          <img src="/api/screenshot/${img.file}" class="thumbnail-img" alt="Screenshot illustration">
        </div>
        <div class="ill-config-content">
          <div class="ill-meta-header">
            <span class="ill-name" title="${img.file}">${img.file}</span>
            <span class="ill-time">${img.time}</span>
          </div>
          <div class="form-group">
            <label>Context Description (Optional)</label>
            <input type="text" class="ill-ctx-input" data-file="${img.file}" value="${img.savedContext || ''}" placeholder="e.g. Chapter title illustration, map, character sketch" autocomplete="off">
          </div>
        </div>
      `;
      illustrationsList.appendChild(tile);
    });
  }

  // 2. Settings update
  formSettings.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bookTitle = inputBookTitle.value.trim();
    const apiKey = inputApiKey.value.trim();

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookTitle, apiKey })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      inputApiKey.value = ""; // Clear password input after saving
      alert("Settings saved successfully!");
      loadStatus();
    } catch (err) {
      alert(`Error saving settings: ${err.message}`);
    }
  });

  // Toggle API key view
  btnToggleKey.addEventListener("click", () => {
    if (inputApiKey.type === "password") {
      inputApiKey.type = "text";
      btnToggleKey.textContent = "Hide";
    } else {
      inputApiKey.type = "password";
      btnToggleKey.textContent = "Show";
    }
  });

  // 3. HTML5 Multi-image selector upload
  function setupUploads() {
    if (!inputFolderBar) return;

    // Hidden file picker still works as a rare manual-import fallback
    filePicker.addEventListener("change", () => {
      const files = Array.from(filePicker.files);
      if (files.length > 0) uploadFiles(files);
    });

    // Quiet drag-and-drop onto the slim bar (the usual workflow is ctrl+X into the folder)
    inputFolderBar.addEventListener("dragover", (e) => {
      e.preventDefault();
      inputFolderBar.classList.add("dragover");
    });

    inputFolderBar.addEventListener("dragleave", () => {
      inputFolderBar.classList.remove("dragover");
    });

    inputFolderBar.addEventListener("drop", (e) => {
      e.preventDefault();
      inputFolderBar.classList.remove("dragover");
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
      if (files.length > 0) uploadFiles(files);
    });
  }

  // Slim-bar controls: refresh (rescan input folder) + open input folder + archive expand
  function setupSlimBar() {
    if (btnRefreshBatches) {
      btnRefreshBatches.addEventListener("click", () => {
        btnRefreshBatches.classList.add("spinning");
        loadStatus();
        setTimeout(() => btnRefreshBatches.classList.remove("spinning"), 700);
      });
    }
    if (btnOpenInput) {
      btnOpenInput.addEventListener("click", () => openSystemExplorer("input"));
    }
    if (btnShowFullArchive) {
      btnShowFullArchive.addEventListener("click", () => {
        const nowHidden = archivedRest.classList.toggle("hidden");
        const count = archivedRest.querySelectorAll(".archived-card").length;
        if (archiveFlagLabel) {
          archiveFlagLabel.textContent = nowHidden ? `Show full archive (${count} more)` : "Hide full archive";
        }
      });
    }
  }

  // Upload sequential batch files via AJAX Base64
  async function uploadFiles(files) {
    uploadProgressContainer.classList.remove("hidden");
    let uploadedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      uploadProgressLabel.textContent = `Uploading file ${i + 1} of ${files.length}: ${file.name}`;
      
      try {
        const base64Data = await readFileAsBase64(file);
        
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, data: base64Data })
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error);

        uploadedCount++;
        const percent = Math.round((uploadedCount / files.length) * 100);
        uploadProgressFill.style.width = `${percent}%`;
        uploadProgressPercent.textContent = `${percent}%`;
      } catch (err) {
        console.error(`Failed uploading ${file.name}:`, err);
        alert(`Failed uploading ${file.name}: ${err.message}`);
      }
    }

    uploadProgressLabel.textContent = `Upload completed! Parsed ${uploadedCount} screenshots.`;
    setTimeout(() => {
      uploadProgressContainer.classList.add("hidden");
      uploadProgressFill.style.width = "0%";
      uploadProgressPercent.textContent = "0%";
      // Reload stats and drop list
      loadStatus();
    }, 1800);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
  }

  // 4. Run the OCR & Gemini streams or Resume Cache
  btnStart.addEventListener("click", async () => {
    const date = appState.selectedDate;
    if (!date) return;

    // Check if the selected batch can be loaded from cache directly
    const dateInfo = appState.datesInfo.find(d => d.date === date);
    const shouldLoadFromCache = dateInfo && (dateInfo.status === "completed" || dateInfo.status === "paused");

    if (shouldLoadFromCache) {
      try {
        btnStart.disabled = true;
        const res = await fetch(`/api/load-cache?date=${encodeURIComponent(date)}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        if (data.cache.lastRunSummary) {
          appState.lastRunStats = data.cache.lastRunSummary;
        }
        appState.draftContent = data.cache.draftContent;
        appState.illustrations = data.cache.illustrations.map(ill => ({
          ...ill,
          crop: ill.crop ? { ...ill.crop } : (ill.suggestedCrop ? { ...ill.suggestedCrop } : null)
        }));

        renderReviewPanel();
      } catch (err) {
        alert(`Failed to load cached pipeline: ${err.message}`);
      } finally {
        btnStart.disabled = false;
      }
      return;
    }

    // Collect custom inputs first and save them in state
    const inputs = document.querySelectorAll(".ill-ctx-input");
    const contexts = {};
    inputs.forEach(inp => {
      contexts[inp.dataset.file] = inp.value.trim();
    });

    try {
      // Save current contexts
      await fetch("/api/save-contexts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contexts })
      });

      // Switch to Processing panel
      setStepActive(stepProcess, panelProcess);
      consoleLogs.innerHTML = "";
      processBarFill.style.width = "0%";
      processPercent.textContent = "0%";
      processStepTitle.textContent = "Connecting to Pipeline...";

      // Open SSE logging Stream
      const sse = new EventSource(`/api/process-stream?date=${encodeURIComponent(date)}`);
      
      sse.addEventListener("message", (e) => {
        const data = JSON.parse(e.data);
        
        if (data.type === "log") {
          appendLog(data.message, "info");
        } 
        else if (data.type === "progress") {
          const isGemini = data.message.includes("Gemini") || data.message.includes("Contacting") || data.message.includes("Retrying");
          if (isGemini) {
            startGeminiTimer(data.message, data.value);
          } else {
            stopGeminiTimer();
            processStepTitle.textContent = data.message;
            if (data.value !== undefined) {
              processBarFill.style.width = `${data.value}%`;
              processPercent.textContent = `${data.value}%`;
            }
          }
        } 
        else if (data.type === "error") {
          stopGeminiTimer();
          appendLog(`ERROR: ${data.message}`, "error");
          processStepTitle.textContent = "Process Failed";
          sse.close();
          // Add standard back button in console for visual ease
          const backBtn = document.createElement("button");
          backBtn.className = "btn btn-secondary";
          backBtn.style.marginTop = "14px";
          backBtn.textContent = "Go back to Configuration";
          backBtn.onclick = () => setStepActive(stepConfig, panelConfig);
          consoleLogs.appendChild(backBtn);
        } 
        else if (data.type === "complete") {
          stopGeminiTimer();
          appendLog("AI Analysis Success!", "success");
          sse.close();

          if (data.lastRunSummary) {
            appState.lastRunStats = data.lastRunSummary;
          }
          appState.draftContent = data.reviewData.draftContent;
          appState.illustrations = data.reviewData.illustrations.map(ill => ({
            ...ill,
            crop: ill.suggestedCrop ? { ...ill.suggestedCrop } : null
          }));

          // Shift to review screen after a short 1s delay
          setTimeout(() => {
            renderReviewPanel();
          }, 1000);
        }
      });

      sse.onerror = (err) => {
        stopGeminiTimer();
        console.error("SSE Error:", err);
        appendLog("System stream connectivity failed. Pipeline terminated.", "error");
        sse.close();
      };

    } catch (err) {
      alert(`Process initialization error: ${err.message}`);
    }
  });

  function appendLog(msg, type = "info") {
    const p = document.createElement("p");
    p.className = `log-${type}`;
    p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleLogs.appendChild(p);
    consoleLogs.scrollTop = consoleLogs.scrollHeight; // Auto-scroll
  }

  // Timer helpers for Gemini processing steps
  function startGeminiTimer(baseMessage, progressValue) {
    if (geminiTimerId) clearInterval(geminiTimerId);
    const startTime = Date.now();
    function updateMessage() {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      processStepTitle.textContent = `${baseMessage} (${elapsed}s)`;
    }
    updateMessage();
    geminiTimerId = setInterval(updateMessage, 1000);
    if (progressValue !== undefined) {
      processBarFill.style.width = `${progressValue}%`;
      processPercent.textContent = `${progressValue}%`;
    }
  }

  function stopGeminiTimer() {
    if (geminiTimerId) {
      clearInterval(geminiTimerId);
      geminiTimerId = null;
    }
  }

  // 5. Review & Finalize Form Renders
  function renderReviewPanel() {
    setStepActive(stepReview, panelReview);
    renderBaselineBanner(reviewBaselineBanner, appState.lastRunStats);
    reviewGrid.innerHTML = "";

    if (appState.illustrations.length === 0) {
      reviewGrid.innerHTML = `
        <div class="empty-illustrations" style="grid-column: 1 / -1;">
          <p>No full-screen illustrations were detected. You are ready to finalize and save the daily Markdown note directly!</p>
        </div>
      `;
      return;
    }

    appState.illustrations.forEach((ill, idx) => {
      const tile = document.createElement("div");
      tile.className = "review-tile";

      // Render the percentage-based crop outline preview
      let cropOverlayHtml = "";
      if (ill.crop && ill.originalWidth > 0 && ill.originalHeight > 0) {
        const left = (ill.crop.x / ill.originalWidth) * 100;
        const top = (ill.crop.y / ill.originalHeight) * 100;
        const width = (ill.crop.w / ill.originalWidth) * 100;
        const height = (ill.crop.h / ill.originalHeight) * 100;
        cropOverlayHtml = `
          <div class="crop-overlay-container">
            <div class="crop-box-outline" style="left: ${left}%; top: ${top}%; width: ${width}%; height: ${height}%;"></div>
          </div>
        `;
      }

      tile.innerHTML = `
        <div class="review-thumb-wrapper" data-idx="${idx}" title="Click to adjust crop region">
          <img src="/api/screenshot/${ill.originalFile}" class="review-thumb-img" alt="Review Illustration">
          ${cropOverlayHtml}
          <div class="crop-click-hint">Click to Crop</div>
        </div>
        <div class="review-tile-content">
          <div class="review-meta-row">
            <span class="review-tag">Illustration ${idx + 1}</span>
            <span class="review-time">${ill.time}</span>
          </div>
          <div class="form-group">
            <label>Final Filename (.jpg)</label>
            <textarea class="review-name-input" rows="2" data-orig="${ill.originalFile}" style="resize: none;">${ill.suggestedName}</textarea>
            <small class="form-help text-muted">Original: ${ill.originalFile}</small>
          </div>
        </div>
      `;

      // Bind click handler to open crop modal
      const thumb = tile.querySelector(".review-thumb-wrapper");
      thumb.addEventListener("click", () => {
        openCropModal(idx);
      });

      reviewGrid.appendChild(tile);
    });
  }

  // --- Manual Crop Modal Logic ---
  const cropModal = document.getElementById("crop-modal");
  const cropImg = document.getElementById("crop-editor-img");
  const cropBox = document.getElementById("crop-editor-box");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const btnCancelCrop = document.getElementById("btn-cancel-crop");
  const btnSaveCrop = document.getElementById("btn-save-crop");

  let cropState = {
    idx: -1,
    dispW: 0,
    dispH: 0,
    origW: 0,
    origH: 0,
    scaleX: 1,
    scaleY: 1,
    
    // Crop box coordinates in display pixels
    left: 0,
    top: 0,
    width: 0,
    height: 0,

    isDragging: false,
    isResizing: false,
    activeHandle: null,
    
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0
  };

  function openCropModal(idx) {
    const ill = appState.illustrations[idx];
    if (!ill) return;

    cropState.idx = idx;
    cropState.origW = ill.originalWidth || 1080;
    cropState.origH = ill.originalHeight || 1920;

    // Load illustration image into cropping workspace
    cropImg.src = `/api/screenshot/${ill.originalFile}`;
    cropModal.classList.remove("hidden");

    cropImg.onload = () => {
      cropState.dispW = cropImg.clientWidth;
      cropState.dispH = cropImg.clientHeight;
      
      cropState.scaleX = cropState.dispW / cropState.origW;
      cropState.scaleY = cropState.dispH / cropState.origH;

      // Set active crop coordinates
      const activeCrop = ill.crop || ill.suggestedCrop || { x: 0, y: Math.round(cropState.origH * 0.08), w: cropState.origW, h: Math.round(cropState.origH * 0.84) };

      cropState.left = activeCrop.x * cropState.scaleX;
      cropState.top = activeCrop.y * cropState.scaleY;
      cropState.width = activeCrop.w * cropState.scaleX;
      cropState.height = activeCrop.h * cropState.scaleY;

      updateCropBoxStyle();
    };
  }

  function closeCropModal() {
    cropModal.classList.add("hidden");
    cropImg.src = "";
    cropImg.onload = null;
  }

  function updateCropBoxStyle() {
    cropBox.style.left = `${cropState.left}px`;
    cropBox.style.top = `${cropState.top}px`;
    cropBox.style.width = `${cropState.width}px`;
    cropBox.style.height = `${cropState.height}px`;
  }

  function onDragStart(e) {
    const target = e.target;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    if (target.classList.contains("crop-handle")) {
      cropState.isResizing = true;
      cropState.activeHandle = target.classList.contains("handle-tl") ? "tl" :
                               target.classList.contains("handle-tr") ? "tr" :
                               target.classList.contains("handle-bl") ? "bl" : "br";
    } else if (target === cropBox || cropBox.contains(target)) {
      cropState.isDragging = true;
    } else {
      return;
    }

    cropState.startX = clientX;
    cropState.startY = clientY;
    cropState.startLeft = cropState.left;
    cropState.startTop = cropState.top;
    cropState.startWidth = cropState.width;
    cropState.startHeight = cropState.height;

    e.preventDefault();
  }

  function onDragMove(e) {
    if (!cropState.isDragging && !cropState.isResizing) return;

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    const dx = clientX - cropState.startX;
    const dy = clientY - cropState.startY;

    if (cropState.isDragging) {
      let newLeft = cropState.startLeft + dx;
      let newTop = cropState.startTop + dy;

      newLeft = Math.max(0, Math.min(cropState.dispW - cropState.width, newLeft));
      newTop = Math.max(0, Math.min(cropState.dispH - cropState.height, newTop));

      cropState.left = newLeft;
      cropState.top = newTop;
    } 
    else if (cropState.isResizing) {
      const minSize = 25; // min width/height in display pixels

      if (cropState.activeHandle === "br") {
        let newWidth = cropState.startWidth + dx;
        let newHeight = cropState.startHeight + dy;

        newWidth = Math.max(minSize, Math.min(cropState.dispW - cropState.startLeft, newWidth));
        newHeight = Math.max(minSize, Math.min(cropState.dispH - cropState.startTop, newHeight));

        cropState.width = newWidth;
        cropState.height = newHeight;
      } 
      else if (cropState.activeHandle === "tr") {
        let newTop = cropState.startTop + dy;
        let newHeight = cropState.startHeight - dy;
        let newWidth = cropState.startWidth + dx;

        if (newTop < 0) {
          newHeight = cropState.startTop + cropState.startHeight;
          newTop = 0;
        } else if (newHeight < minSize) {
          newHeight = minSize;
          newTop = cropState.startTop + cropState.startHeight - minSize;
        }

        newWidth = Math.max(minSize, Math.min(cropState.dispW - cropState.startLeft, newWidth));

        cropState.top = newTop;
        cropState.height = newHeight;
        cropState.width = newWidth;
      } 
      else if (cropState.activeHandle === "bl") {
        let newLeft = cropState.startLeft + dx;
        let newWidth = cropState.startWidth - dx;
        let newHeight = cropState.startHeight + dy;

        if (newLeft < 0) {
          newWidth = cropState.startLeft + cropState.startWidth;
          newLeft = 0;
        } else if (newWidth < minSize) {
          newWidth = minSize;
          newLeft = cropState.startLeft + cropState.startWidth - minSize;
        }

        newHeight = Math.max(minSize, Math.min(cropState.dispH - cropState.startTop, newHeight));

        cropState.left = newLeft;
        cropState.width = newWidth;
        cropState.height = newHeight;
      } 
      else if (cropState.activeHandle === "tl") {
        let newLeft = cropState.startLeft + dx;
        let newWidth = cropState.startWidth - dx;
        let newTop = cropState.startTop + dy;
        let newHeight = cropState.startHeight - dy;

        if (newLeft < 0) {
          newWidth = cropState.startLeft + cropState.startWidth;
          newLeft = 0;
        } else if (newWidth < minSize) {
          newWidth = minSize;
          newLeft = cropState.startLeft + cropState.startWidth - minSize;
        }

        if (newTop < 0) {
          newHeight = cropState.startTop + cropState.startHeight;
          newTop = 0;
        } else if (newHeight < minSize) {
          newHeight = minSize;
          newTop = cropState.startTop + cropState.startHeight - minSize;
        }

        cropState.left = newLeft;
        cropState.width = newWidth;
        cropState.top = newTop;
        cropState.height = newHeight;
      }
    }

    updateCropBoxStyle();
  }

  function onDragEnd() {
    cropState.isDragging = false;
    cropState.isResizing = false;
    cropState.activeHandle = null;
  }

  // Hook up event listeners for manual cropping modal
  cropBox.addEventListener("mousedown", onDragStart);
  cropBox.addEventListener("touchstart", onDragStart, { passive: false });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("touchmove", onDragMove, { passive: false });

  window.addEventListener("mouseup", onDragEnd);
  window.addEventListener("touchend", onDragEnd);

  btnCloseModal.addEventListener("click", closeCropModal);
  btnCancelCrop.addEventListener("click", closeCropModal);
  btnSaveCrop.addEventListener("click", () => {
    const ill = appState.illustrations[cropState.idx];
    if (ill) {
      // Convert display pixels back to original image space
      const newCrop = {
        x: Math.round(cropState.left / cropState.scaleX),
        y: Math.round(cropState.top / cropState.scaleY),
        w: Math.round(cropState.width / cropState.scaleX),
        h: Math.round(cropState.height / cropState.scaleY)
      };

      // Clamp values within original image space
      newCrop.x = Math.max(0, Math.min(cropState.origW - 1, newCrop.x));
      newCrop.y = Math.max(0, Math.min(cropState.origH - 1, newCrop.y));
      newCrop.w = Math.max(1, Math.min(cropState.origW - newCrop.x, newCrop.w));
      newCrop.h = Math.max(1, Math.min(cropState.origH - newCrop.y, newCrop.h));

      ill.crop = newCrop;
    }
    closeCropModal();
    renderReviewPanel(); // refresh crop outline visual on review thumbnails
  });

  // 6. Submit final reviewed filenames to backend for crop generation
  btnSaveFinalize.addEventListener("click", async () => {
    btnSaveFinalize.disabled = true;
    btnSaveFinalize.textContent = "Processing sequential crops...";

    const inputs = document.querySelectorAll(".review-name-input");
    const illustrationsMapping = [];
    inputs.forEach(inp => {
      const origFile = inp.dataset.orig;
      const ill = appState.illustrations.find(i => i.originalFile === origFile);
      illustrationsMapping.push({
        originalFile: origFile,
        finalizedName: inp.value.trim(),
        crop: ill ? ill.crop : null
      });
    });

    try {
      const res = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: appState.selectedDate,
          draftContent: appState.draftContent,
          illustrations: illustrationsMapping
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Populate step 4 completed labels
      outputMdName.textContent = `${appState.selectedDate}.md`;
      const imgFolderItem = document.getElementById("success-img-folder-item");
      if (appState.illustrations && appState.illustrations.length > 0) {
        outputImgFolderName.textContent = `${appState.selectedDate} Extracted Images/`;
        if (imgFolderItem) imgFolderItem.classList.remove("hidden");
      } else {
        if (imgFolderItem) imgFolderItem.classList.add("hidden");
      }

      prepareCleanupUI();
      setStepActive(stepSuccess, panelSuccess);
    } catch (err) {
      alert(`Finalize failed: ${err.message}`);
    } finally {
      btnSaveFinalize.disabled = false;
      btnSaveFinalize.textContent = "Finalize Notes & Save Sequential Crops";
    }
  });

  // Go back to config from review
  btnBackConfig.addEventListener("click", () => {
    setStepActive(stepConfig, panelConfig);
  });

  // Reset Pipeline back to config screen
  btnResetPipeline.addEventListener("click", resetToConfig);

  // Open a project folder in System Explorer (output | input | archive)
  const openSystemExplorer = async (target = "output") => {
    try {
      await fetch("/api/open-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target })
      });
    } catch (err) {
      console.error("Explorer command error:", err);
    }
  };
  btnExplorerFinal.addEventListener("click", () => openSystemExplorer("output"));
  btnExplorerHeader.addEventListener("click", () => openSystemExplorer("output"));

  // --- Helper: UI step visual navigation controller ---
  function setStepActive(stepIndicator, targetPanel) {
    // Reset all step labels
    [stepConfig, stepProcess, stepReview, stepSuccess].forEach(ind => {
      ind.classList.remove("active", "completed");
    });
    
    // Set completed states
    if (stepIndicator === stepProcess) {
      stepConfig.classList.add("completed");
    } else if (stepIndicator === stepReview) {
      stepConfig.classList.add("completed");
      stepProcess.classList.add("completed");
    } else if (stepIndicator === stepSuccess) {
      stepConfig.classList.add("completed");
      stepProcess.classList.add("completed");
      stepReview.classList.add("completed");
    }
    
    stepIndicator.classList.add("active");

    // Toggle panels visibility
    [panelConfig, panelProcess, panelReview, panelSuccess].forEach(panel => {
      panel.classList.remove("active");
    });
    targetPanel.classList.add("active");
  }

  // --- Stage 4: screenshot cleanup (archive default / delete to Recycle Bin) ---
  function prepareCleanupUI() {
    const date = appState.selectedDate;
    const count = (appState.groups[date] || []).length;
    if (cleanupDateEl) cleanupDateEl.textContent = date;
    if (cleanupCountEl) cleanupCountEl.textContent = count;
    if (cleanupActions) cleanupActions.classList.remove("hidden");
    if (cleanupProgress) cleanupProgress.classList.add("hidden");
    if (cleanupDone) cleanupDone.classList.add("hidden");
    if (btnArchiveFinish) btnArchiveFinish.disabled = false;
    if (btnDeleteRecycle) btnDeleteRecycle.disabled = false;
  }

  function setupCleanup() {
    if (btnArchiveFinish) {
      btnArchiveFinish.addEventListener("click", () => runCleanup("archive"));
    }
    if (btnDeleteRecycle) {
      btnDeleteRecycle.addEventListener("click", () => {
        const date = appState.selectedDate;
        const count = (appState.groups[date] || []).length;
        if (confirm(`Send ${count} screenshots from ${date} to the Recycle Bin?\n\nThey stay recoverable in the bin, but won't be archived.`)) {
          runCleanup("delete");
        }
      });
    }
    if (btnSkipCleanup) {
      // Leave screenshots in place; go back to config for the next batch
      btnSkipCleanup.addEventListener("click", resetToConfig);
    }
  }

  function runCleanup(mode) {
    const date = appState.selectedDate;
    if (!date) return;

    // Swap the action buttons out for the live heartbeat
    if (cleanupActions) cleanupActions.classList.add("hidden");
    if (cleanupDone) cleanupDone.classList.add("hidden");
    if (cleanupProgress) cleanupProgress.classList.remove("hidden");
    if (cleanupProgressBar) cleanupProgressBar.style.width = "0%";
    if (cleanupProgressLabel) cleanupProgressLabel.textContent = mode === "delete" ? "Sending to Recycle Bin…" : "Archiving screenshots…";
    if (cleanupProgressCount) cleanupProgressCount.textContent = "";

    if (archiveSse) { archiveSse.close(); archiveSse = null; }
    archiveSse = new EventSource(`/api/archive-stream?date=${encodeURIComponent(date)}&mode=${mode}`);

    archiveSse.addEventListener("message", (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "progress") {
        if (data.value !== undefined && cleanupProgressBar) cleanupProgressBar.style.width = `${data.value}%`;
        if (cleanupProgressLabel) cleanupProgressLabel.textContent = data.message;
        if (cleanupProgressCount && data.total !== undefined) cleanupProgressCount.textContent = `${data.processed} / ${data.total}`;
      } else if (data.type === "complete") {
        archiveSse.close(); archiveSse = null;
        if (cleanupProgress) cleanupProgress.classList.add("hidden");
        if (cleanupDone) {
          cleanupDone.classList.remove("hidden");
          cleanupDone.classList.toggle("is-delete", mode === "delete");
          const verb = mode === "delete" ? "Sent to Recycle Bin:" : "Archived";
          const dest = mode === "delete" ? "" : ` → <code>archive/${date}/</code>`;
          cleanupDone.innerHTML = `✓ ${verb} ${data.count} screenshots${dest}. This batch moved to the recently-archived list below on the home screen.`;
        }
        // Refresh in the background so the active list drops this batch
        loadStatus();
      } else if (data.type === "error") {
        archiveSse.close(); archiveSse = null;
        if (cleanupProgress) cleanupProgress.classList.add("hidden");
        if (cleanupActions) cleanupActions.classList.remove("hidden");
        alert(`Cleanup failed: ${data.message}`);
      }
    });

    archiveSse.onerror = () => {
      if (archiveSse) { archiveSse.close(); archiveSse = null; }
      if (cleanupProgress) cleanupProgress.classList.add("hidden");
      if (cleanupActions) cleanupActions.classList.remove("hidden");
    };
  }

  // Reset back to the config step for the next batch
  function resetToConfig() {
    appState.selectedDate = "";
    statWrapper.classList.add("hidden");
    renderEmptyIllustrations();
    setStepActive(stepConfig, panelConfig);
    loadStatus();
  }

  // Ambient twinkling starfield (subtle & decorative; CSS freezes it under reduced-motion)
  function generateStarfield() {
    const field = document.getElementById("starfield");
    if (!field) return;

    // Soft red / green / blue tints — a star favors one while fading, goes white at peak
    const TINTS = ["hsl(0, 85%, 66%)", "hsl(140, 70%, 60%)", "hsl(215, 90%, 66%)"];
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];

    // Move to a fresh spot + re-roll the tint each time the star blinks back into existence
    const placeStar = (star) => {
      star.style.left = `${(Math.random() * 100).toFixed(2)}%`;
      star.style.top = `${(Math.random() * 100).toFixed(2)}%`;
      star.style.setProperty("--tint", pick(TINTS));
    };

    const STAR_COUNT = 110;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < STAR_COUNT; i++) {
      const star = document.createElement("div");

      // Type mix: ~15% tiny 5-point, ~25% single-pixel, rest round
      const r = Math.random();
      let type = "round";
      if (r < 0.15) type = "point";
      else if (r < 0.40) type = "pixel";
      star.className = type === "round" ? "star" : `star ${type}`;

      let size;
      if (type === "point") size = Math.random() * 5 + 4;      // 4–9px (needs room for the points)
      else if (type === "pixel") size = 1;                     // exactly 1px
      else size = Math.random() * 2.4 + 1;                     // 1–3.4px

      star.style.width = `${size.toFixed(2)}px`;
      star.style.height = `${size.toFixed(2)}px`;
      star.style.setProperty("--glow", `${(size * 1.8).toFixed(1)}px`);
      star.style.setProperty("--max-op", (Math.random() * 0.25 + 0.72).toFixed(2)); // 0.72–0.97
      star.style.setProperty("--min-scale", (Math.random() * 0.2 + 0.2).toFixed(2)); // 0.2–0.4
      star.style.setProperty("--max-scale", (Math.random() * 0.5 + 1.0).toFixed(2)); // 1.0–1.5
      star.style.setProperty("--dur", `${(Math.random() * 4 + 2.5).toFixed(1)}s`);   // 2.5–6.5s
      star.style.setProperty("--delay", `${(Math.random() * 7).toFixed(1)}s`);

      placeStar(star);
      // Each cycle ends invisible (opacity 0) — relocate + recolor there for a seamless "new star"
      star.addEventListener("animationiteration", () => placeStar(star));
      frag.appendChild(star);
    }
    field.appendChild(frag);
  }

  // Dev Debug Modal & Stats Handlers
  const tabBtnOverview = document.getElementById("dev-tab-btn-overview");
  const tabBtnPlots = document.getElementById("dev-tab-btn-plots");
  const devTabOverview = document.getElementById("dev-tab-overview");
  const devTabPlots = document.getElementById("dev-tab-plots");

  if (tabBtnOverview && tabBtnPlots) {
    tabBtnOverview.addEventListener("click", () => {
      tabBtnOverview.classList.add("active");
      tabBtnPlots.classList.remove("active");
      if (devTabOverview) devTabOverview.classList.remove("hidden");
      if (devTabPlots) devTabPlots.classList.add("hidden");
    });

    tabBtnPlots.addEventListener("click", () => {
      tabBtnPlots.classList.add("active");
      tabBtnOverview.classList.remove("active");
      if (devTabOverview) devTabOverview.classList.add("hidden");
      if (devTabPlots) devTabPlots.classList.remove("hidden");
      fetchAndRenderDevStats();
    });
  }

  if (btnDevStats) {
    btnDevStats.addEventListener("click", () => {
      if (modalDevStats) modalDevStats.classList.remove("hidden");
      fetchAndRenderDevStats();
    });
  }

  [btnCloseDevStats, btnCloseDevStatsFooter].forEach(btn => {
    if (btn) {
      btn.addEventListener("click", () => {
        if (modalDevStats) modalDevStats.classList.add("hidden");
      });
    }
  });

  if (btnRefreshDevStats) {
    btnRefreshDevStats.addEventListener("click", fetchAndRenderDevStats);
  }

  if (btnClearDevStats) {
    btnClearDevStats.addEventListener("click", async () => {
      if (confirm("Are you sure you want to clear all recorded Gemini API stats?")) {
        try {
          const res = await fetch("/api/clear-gemini-stats", { method: "POST" });
          const data = await res.json();
          if (data.success) {
            fetchAndRenderDevStats();
          }
        } catch (err) {
          alert("Failed to clear stats: " + err.message);
        }
      }
    });
  }

  async function fetchAndRenderDevStats() {
    if (!devLastRunContainer || !devUtcWindowsContainer || !devCallsHistoryContainer) return;
    try {
      devLastRunContainer.innerHTML = `<p class="text-muted">Fetching latest baseline metrics...</p>`;
      devUtcWindowsContainer.innerHTML = `<p class="text-muted">Loading 24hr UTC windows...</p>`;
      devCallsHistoryContainer.innerHTML = `<p class="text-muted">Loading call history...</p>`;

      const res = await fetch("/api/gemini-stats");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const stats = data.stats || {};
      renderDevLastRun(stats.lastRun);
      renderDevUtcWindows(stats.dailyStats);
      renderDevCallsHistory(stats.history);
      renderQuotaMeterAndTelemetry(stats.lastRun, stats.dailyStats);
      renderResponseTimeChart(stats.history, stats.dailyStats);
      renderTokenUsageChart(stats.dailyStats);
      renderDedupReductionChart(stats.lastRun, stats.dailyStats);
    } catch (err) {
      devLastRunContainer.innerHTML = `<p class="text-danger">Failed to load stats: ${err.message}</p>`;
    }
  }

  function renderDevLastRun(lastRun) {
    if (!devLastRunContainer) return;
    if (!lastRun) {
      devLastRunContainer.innerHTML = `<p class="text-muted">No transcribe run recorded yet in this session.</p>`;
      return;
    }
    const timeStr = lastRun.timestamp ? new Date(lastRun.timestamp).toLocaleTimeString() : "N/A";
    const dateStr = lastRun.date || "N/A";
    const stageSec = lastRun.stage2TotalDurationSec !== undefined ? `${lastRun.stage2TotalDurationSec}s` : `${(lastRun.stage2TotalDurationMs / 1000).toFixed(1)}s`;
    const geminiSec = lastRun.geminiDurationSec !== undefined ? `${lastRun.geminiDurationSec}s` : `${(lastRun.geminiDurationMs / 1000).toFixed(1)}s`;
    const calls = lastRun.callsCount || (lastRun.calls ? lastRun.calls.length : 0);
    const tokens = (lastRun.totalTokens || 0).toLocaleString();
    const inTokens = (lastRun.totalInputTokens || 0).toLocaleString();
    const outTokens = (lastRun.totalOutputTokens || 0).toLocaleString();

    // Telemetry additions
    const hitRate = lastRun.ocrStats ? `${lastRun.ocrStats.hitRatePct}%` : '100%';
    const dedupRed = lastRun.dedupStats ? `${lastRun.dedupStats.reductionPct}%` : '0%';
    const totalWords = lastRun.yieldStats ? (lastRun.yieldStats.totalWords || 0).toLocaleString() : 'N/A';

    devLastRunContainer.innerHTML = `
      <div class="dev-metric-grid">
        <div class="dev-metric-box">
          <span class="dev-metric-val text-brand-cyan">${stageSec}</span>
          <span class="dev-metric-lbl">Total Stage 2 Time</span>
        </div>
        <div class="dev-metric-box">
          <span class="dev-metric-val text-brand-purple">${geminiSec}</span>
          <span class="dev-metric-lbl">Gemini Response Time</span>
        </div>
        <div class="dev-metric-box">
          <span class="dev-metric-val">${calls}</span>
          <span class="dev-metric-lbl">API Calls</span>
        </div>
        <div class="dev-metric-box">
          <span class="dev-metric-val">${tokens}</span>
          <span class="dev-metric-lbl">Total Tokens</span>
        </div>
      </div>
      <div class="dev-submeta">
        <span><b>Batch Date:</b> ${dateStr} at ${timeStr}</span> &bull; 
        <span><b>OCR Hit Rate:</b> ${hitRate}</span> &bull; 
        <span><b>Dedup Reduction:</b> ${dedupRed}</span> &bull; 
        <span><b>Words Output:</b> ${totalWords}</span> &bull; 
        <span><b>Prompt Tokens:</b> ${inTokens}</span> &bull; 
        <span><b>Model:</b> <code>gemini-flash-latest</code></span>
      </div>
    `;
  }

  function renderDevUtcWindows(dailyStats) {
    if (!devUtcWindowsContainer) return;
    if (!dailyStats || Object.keys(dailyStats).length === 0) {
      devUtcWindowsContainer.innerHTML = `<p class="text-muted">No 24hr UTC windows recorded yet.</p>`;
      return;
    }

    const sortedDates = Object.keys(dailyStats).sort().reverse();
    devUtcWindowsContainer.innerHTML = "";

    sortedDates.forEach(utcDate => {
      const day = dailyStats[utcDate];
      const totalSec = (day.totalDurationMs / 1000).toFixed(1);
      const avgSec = (day.avgDurationMs / 1000).toFixed(1);
      const tokens = (day.totalTokens || 0).toLocaleString();
      const inTokens = (day.totalInputTokens || 0).toLocaleString();
      const outTokens = (day.totalOutputTokens || 0).toLocaleString();
      const models = Object.keys(day.models || {}).join(", ") || "gemini-flash-latest";

      const card = document.createElement("div");
      card.className = "utc-window-card";
      card.innerHTML = `
        <div class="utc-window-header">
          <span class="utc-window-date">🌐 ${utcDate} (24h UTC Window)</span>
          <span class="utc-window-calls">${day.totalCalls} API Call${day.totalCalls === 1 ? '' : 's'}${(day.totalRequests || day.totalCalls) > day.totalCalls ? ` · ${day.totalRequests} requests` : ''}</span>
        </div>
        <div class="utc-window-metrics">
          <div class="utc-m-item">
            <span class="utc-m-label">Total Response Time</span>
            <span class="utc-m-value text-brand-cyan">${totalSec}s</span>
          </div>
          <div class="utc-m-item">
            <span class="utc-m-label">Avg Call Duration</span>
            <span class="utc-m-value">${avgSec}s</span>
          </div>
          <div class="utc-m-item">
            <span class="utc-m-label">Total Tokens</span>
            <span class="utc-m-value text-brand-purple">${tokens}</span>
          </div>
          <div class="utc-m-item">
            <span class="utc-m-label">Prompt / Out Tokens</span>
            <span class="utc-m-value">${inTokens} / ${outTokens}</span>
          </div>
        </div>
        <div class="utc-window-specs">
          <span><b>Model Specs:</b> <code>${models}</code></span>
        </div>
      `;
      devUtcWindowsContainer.appendChild(card);
    });
  }

  function renderDevCallsHistory(history) {
    if (!devCallsHistoryContainer) return;
    if (!history || history.length === 0) {
      devCallsHistoryContainer.innerHTML = `<p class="text-muted">No API calls in history.</p>`;
      return;
    }

    devCallsHistoryContainer.innerHTML = "";
    history.slice(0, 30).forEach(call => {
      const time = new Date(call.timestamp).toLocaleTimeString();
      const date = new Date(call.timestamp).toLocaleDateString();
      const sec = call.durationSec !== undefined ? call.durationSec : (call.durationMs / 1000).toFixed(1);
      const isError = call.status === "error";

      const item = document.createElement("div");
      item.className = `call-history-item ${isError ? 'call-error' : ''}`;
      item.innerHTML = `
        <div class="chi-row">
          <span class="chi-type ${call.type}">${(call.type || 'general').toUpperCase()}</span>
          <span class="chi-time">${date} ${time}</span>
          <span class="chi-duration ${isError ? 'text-danger' : 'text-brand-cyan'}">${sec}s</span>
        </div>
        <div class="chi-meta">
          <span>Model: <code>${call.model || 'gemini-flash-latest'}</code></span> &bull; 
          <span>Tokens: ${(call.totalTokens || 0).toLocaleString()} (In: ${call.inputTokens || 0}, Out: ${call.outputTokens || 0})</span>
          ${call.itemCount ? ` &bull; <span>Items: ${call.itemCount}</span>` : ''}
          ${isError ? `<div class="chi-err-msg">Error: ${call.error}</div>` : ''}
        </div>
      `;
      devCallsHistoryContainer.appendChild(item);
    });
  }

  function renderQuotaMeterAndTelemetry(lastRun, dailyStats, targetLimit = null) {
    const container = document.getElementById("dev-quota-meter-container");
    if (!container) return;

    const utcToday = new Date().toISOString().split("T")[0];
    const todayData = (dailyStats && dailyStats[utcToday]) || {};
    // REQUESTS, not calls. A call that fought through a 503 sends several, and
    // Google's meter counts each one — reading the call count here is what let
    // a 40%-full day show as 20%. Older days in the file carry no request
    // count, so they fall back to what they do have.
    const callsToday = todayData.totalCalls || 0;
    const requestsToday = todayData.totalRequests !== undefined ? todayData.totalRequests : callsToday;
    const limit = targetLimit || appState.dailyQuotaTarget || 50;
    const pct = Math.min(100, parseFloat(((requestsToday / limit) * 100).toFixed(1)));
    const retried = requestsToday - callsToday;
    const ocrHitPct = lastRun && lastRun.ocrStats ? lastRun.ocrStats.hitRatePct : 100;
    const dedupRed = lastRun && lastRun.dedupStats ? lastRun.dedupStats.reductionPct : 0;
    const words = lastRun && lastRun.yieldStats ? lastRun.yieldStats.totalWords : 0;

    container.innerHTML = `
      <div class="quota-meter-card">
        <div class="qm-header">
          <span class="qm-title">Daily API Pings Today (24h UTC Window)</span>
          <div class="qm-target-selector">
            <label for="select-quota-target" class="qm-target-label">Target Limit:</label>
            <select id="select-quota-target" class="qm-select">
              <option value="20" ${limit === 20 ? 'selected' : ''}>20 pings/day (Strict limit)</option>
              <option value="50" ${limit === 50 ? 'selected' : ''}>50 pings/day (Standard target)</option>
              <option value="200" ${limit === 200 ? 'selected' : ''}>200 pings/day (Heavy usage)</option>
              <option value="1500" ${limit === 1500 ? 'selected' : ''}>1,500 pings/day (Flash Max)</option>
            </select>
          </div>
        </div>
        <div class="qm-count-row">
          <span class="qm-badge-large">${requestsToday} / ${limit.toLocaleString()} pings today (${pct}%)</span>
          ${retried > 0 ? `<span class="qm-badge-large" title="Requests the retry loop sent beyond the first attempt of each call — these count against the quota too.">${callsToday} call${callsToday === 1 ? '' : 's'}, +${retried} retried</span>` : ''}
        </div>
        <div class="progress-bar-bg" style="height: 10px; margin-bottom: 14px;">
          <div class="progress-bar-fill ${pct > 80 ? 'bg-danger' : ''}" style="width: ${Math.max(2, pct)}%;"></div>
        </div>
        <div class="telemetry-pill-row">
          <div class="telemetry-pill">⚡ OCR Cache Hit Rate: <b>${ocrHitPct}%</b></div>
          <div class="telemetry-pill">✂️ Dedup Prompt Reduction: <b>${dedupRed}%</b></div>
          <div class="telemetry-pill">📝 Words Yield: <b>${words.toLocaleString()} words</b></div>
        </div>
      </div>
    `;

    const selectTarget = document.getElementById("select-quota-target");
    if (selectTarget) {
      selectTarget.addEventListener("change", async (e) => {
        const val = Number(e.target.value);
        appState.dailyQuotaTarget = val;
        try {
          await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dailyQuotaTarget: val })
          });
          renderQuotaMeterAndTelemetry(lastRun, dailyStats, val);
        } catch (err) {
          console.error("Error saving quota target:", err);
        }
      });
    }
  }

  // --- SVG Visual Analysis Charts (Tab 2) ---

  // Plot 1: Response Duration Line / Bar Chart
  function renderResponseTimeChart(history, dailyStats) {
    const container = document.getElementById("chart-response-time");
    if (!container) return;

    const items = (history || []).slice(0, 15).reverse();
    if (items.length === 0) {
      container.innerHTML = `<p class="text-muted">No response time history points available yet.</p>`;
      return;
    }

    const maxVal = Math.max(...items.map(i => i.durationSec || 1), 5);
    const svgW = 680;
    const svgH = 140;
    const padding = 30;

    const points = items.map((item, idx) => {
      const x = padding + (idx / Math.max(1, items.length - 1)) * (svgW - padding * 2);
      const val = item.durationSec || 1;
      const y = svgH - padding - (val / maxVal) * (svgH - padding * 2);
      return { x, y, val, type: item.type, time: new Date(item.timestamp).toLocaleTimeString() };
    });

    const polylineStr = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    let svgHtml = `
      <svg viewBox="0 0 ${svgW} ${svgH}" class="dev-svg-chart">
        <line x1="${padding}" y1="${svgH - padding}" x2="${svgW - padding}" y2="${svgH - padding}" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
        <polyline fill="none" stroke="var(--accent-cyan)" stroke-width="2.5" stroke-linecap="round" points="${polylineStr}" />
    `;

    points.forEach(p => {
      svgHtml += `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="var(--primary)" stroke="var(--accent-cyan)" stroke-width="2">
          <title>${p.type.toUpperCase()}: ${p.val}s at ${p.time}</title>
        </circle>
      `;
    });

    svgHtml += `</svg>`;
    container.innerHTML = svgHtml;
  }

  // Plot 2: Daily Token Usage Stacked Bar Chart
  function renderTokenUsageChart(dailyStats) {
    const container = document.getElementById("chart-token-usage");
    if (!container) return;

    const dates = Object.keys(dailyStats || {}).sort().slice(-7);
    if (dates.length === 0) {
      container.innerHTML = `<p class="text-muted">No 24h UTC token data available yet.</p>`;
      return;
    }

    const svgW = 680;
    const svgH = 150;
    const pad = 35;
    const maxTokens = Math.max(...dates.map(d => dailyStats[d].totalTokens || 100), 500);

    const barW = Math.min(45, (svgW - pad * 2) / dates.length - 15);

    let barsHtml = `<svg viewBox="0 0 ${svgW} ${svgH}" class="dev-svg-chart">
      <line x1="${pad}" y1="${svgH - pad}" x2="${svgW - pad}" y2="${svgH - pad}" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
    `;

    dates.forEach((d, idx) => {
      const day = dailyStats[d];
      const inT = day.totalInputTokens || 0;
      const outT = day.totalOutputTokens || 0;
      const tot = day.totalTokens || (inT + outT);

      const x = pad + idx * ((svgW - pad * 2) / dates.length) + 15;
      const totH = (tot / maxTokens) * (svgH - pad * 2);
      const inH = (inT / tot) * totH;
      const outH = totH - inH;

      const yTot = svgH - pad - totH;
      const yOut = yTot + inH;

      barsHtml += `
        <rect x="${x}" y="${yTot}" width="${barW}" height="${inH}" fill="var(--primary)" rx="2">
          <title>${d}: Prompt Tokens: ${inT.toLocaleString()}</title>
        </rect>
        <rect x="${x}" y="${yOut}" width="${barW}" height="${outH}" fill="var(--accent-cyan)" rx="2">
          <title>${d}: Output Tokens: ${outT.toLocaleString()}</title>
        </rect>
        <text x="${x + barW / 2}" y="${svgH - 12}" fill="var(--text-muted)" font-size="10" text-anchor="middle">${d.slice(5)}</text>
      `;
    });

    barsHtml += `</svg>`;
    container.innerHTML = barsHtml;
  }

  // Plot 3: Deduplication Reduction & OCR Yield Bar Chart
  function renderDedupReductionChart(lastRun, dailyStats) {
    const container = document.getElementById("chart-dedup-reduction");
    if (!container) return;

    if (!lastRun || !lastRun.dedupStats) {
      container.innerHTML = `<p class="text-muted">Run a transcription batch to view deduplication reduction telemetry.</p>`;
      return;
    }

    const d = lastRun.dedupStats;
    const rawChars = d.rawTextChars || 0;
    const finalChars = d.finalTextChars || 0;
    const redPct = d.reductionPct || 0;
    const discarded = d.duplicatesDiscarded || 0;

    container.innerHTML = `
      <div class="dedup-comparison-box">
        <div class="dcb-row">
          <span class="dcb-label">Raw OCR Text Characters:</span>
          <span class="dcb-val">${rawChars.toLocaleString()} chars</span>
        </div>
        <div class="dcb-row">
          <span class="dcb-label">Cleaned &amp; Deduplicated Text:</span>
          <span class="dcb-val text-brand-cyan">${finalChars.toLocaleString()} chars</span>
        </div>
        <div class="dcb-bar-wrapper">
          <div class="dcb-bar-fill" style="width: ${Math.min(100, Math.max(5, 100 - redPct))}%;"></div>
        </div>
        <div class="dcb-footer">
          <span>✂️ <b>${redPct}%</b> prompt text size reduction</span> &bull; 
          <span>Discarded <b>${discarded}</b> duplicate screenshot${discarded === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
  }

  function renderBaselineBanner(containerEl, lastRun) {
    if (!containerEl) return;
    if (!lastRun) {
      containerEl.classList.add("hidden");
      return;
    }
    const stageSec = lastRun.stage2TotalDurationSec !== undefined ? lastRun.stage2TotalDurationSec : (lastRun.stage2TotalDurationMs / 1000).toFixed(1);
    const geminiSec = lastRun.geminiDurationSec !== undefined ? lastRun.geminiDurationSec : (lastRun.geminiDurationMs / 1000).toFixed(1);
    const calls = lastRun.callsCount || (lastRun.calls ? lastRun.calls.length : 0);
    const tokens = (lastRun.totalTokens || 0).toLocaleString();
    const redPct = lastRun.dedupStats ? lastRun.dedupStats.reductionPct : 0;
    const hitPct = lastRun.ocrStats ? lastRun.ocrStats.hitRatePct : 100;

    containerEl.className = "baseline-banner";
    containerEl.innerHTML = `
      <div class="bb-icon">⚡</div>
      <div class="bb-content">
        <span class="bb-title">Transcribe Baseline:</span>
        <span class="bb-detail">Stage Total: <b>${stageSec}s</b> (Gemini API: <b>${geminiSec}s</b> &bull; <b>${calls}</b> call${calls === 1 ? '' : 's'} &bull; <b>${tokens}</b> tokens &bull; Dedup Red: <b>${redPct}%</b> &bull; OCR Hits: <b>${hitPct}%</b>)</span>
      </div>
    `;
    containerEl.classList.remove("hidden");
  }

  function setupEventListeners() {
    // Click listeners are added dynamically during card rendering
  }

});
