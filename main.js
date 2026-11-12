/*
 * Fluid Sidebar — phone only.
 *
 * Division of labour with Obsidian (phone, Settings → Appearance → "Sliding sidebar"):
 *   - Obsidian still recognises the swipe, decides open vs close on release, owns the
 *     sidebar state (leftSplit/rightSplit.collapsed), and closes on a tap on the card.
 *   - This plugin owns every pixel that moves. While the finger is down we follow the
 *     position Obsidian computes (it writes it inline on the main view); after release we
 *     run our own spring, seeded with the finger's velocity, toward the state Obsidian
 *     chose. Our CSS uses !important so Obsidian's own 200 ms animations are ignored.
 *
 * Numbers measured frame by frame from a screen recording of Claude Duet (iPhone, pt = CSS px).
 *
 * Fail-safe: everything this plugin shows hangs off two body classes (cd-sliding, cd-open).
 * If a self-check finds Obsidian no longer works the way we rely on, or anything throws,
 * fail() removes them and stops — the sidebar is then plain native Obsidian until the next
 * reload. Worst case is "looks native", never a broken layout.
 */
const { Plugin, Notice, moment } = require('obsidian');

const PEEK = 66;        // card strip left visible when open
const PARALLAX = 65;    // sidebar starts this far out and slides in with the card
const INSET = 19;       // card's top/bottom inset when fully open (it shrinks)
const DIM = 0.56;       // black overlay on the card when fully open
const OMEGA = 18;       // spring (rad/s), critically damped; fitted to Duet's release curve
const PROJECT = 0.3;    // s: release decision uses position + velocity × this
const HAPTIC_GAP = 80;  // ms: minimum spacing between two midline ticks in one drag

// The only text this plugin ever shows: the notice when it stands down. Chinese UI gets Chinese.
const ZH = /^zh/i.test((moment && typeof moment.locale === 'function' && moment.locale()) || '');
const TEXT = ZH ? {
  paused: (r) => `Fluid Sidebar 已暂停（${r}），侧边栏已恢复为 Obsidian 原样。重启 Obsidian 会再试一次。`,
  startup: '启动出错', runtime: '运行出错', splitApi: '侧边栏接口变了', rootView: '主视图结构变了',
  drawerDom: '侧边栏结构变了', dragModel: '拖动方式变了',
} : {
  paused: (r) => `Fluid Sidebar paused (${r}). The sidebar is back to the default behaviour. Restart Obsidian to try again.`,
  startup: 'error on startup', runtime: 'error while running', splitApi: 'sidebar API changed', rootView: 'main view layout changed',
  drawerDom: 'sidebar layout changed', dragModel: 'sidebar drag behaviour changed',
};

module.exports = class FluidSidebarPlugin extends Plugin {
  onload() {
    this.raf = 0;
    this.active = false;
    this.side = null;
    this.d = 0;            // current open distance, px (0 … W)
    this.v = 0;            // px/s
    this.touching = false;
    this.dragging = false;
    this.inlineAtTouch = null;
    this.hist = [];
    this.lastT = 0;
    this.half = null;      // which side of the midline the card was on last frame
    this.armed = false;    // this touch was a horizontal swipe: midline crossings tick
    this.x0 = 0;
    this.y0 = 0;
    this.lastBuzz = 0;
    this.written = new Map(); // element → {property: value} we set inline (restored on close)
    this.haptics = undefined;
    this.failed = null;    // reason string once we've stood down
    this.tick = this.tick.bind(this);
    this.wake = this.wake.bind(this);
    // Per-frame values are CSS variables set on the moving element itself. Registered as
    // non-inherited, changing one restyles only that element, not everything inside it.
    for (const [name, syntax, initialValue] of [
      ['--cd-x', '<length>', '0px'], ['--cd-scale', '<number>', '1'], ['--cd-drawer-x', '<length>', '0px'],
    ]) {
      try { CSS.registerProperty({ name, syntax, inherits: false, initialValue }); } catch (e) { /* already registered, or unsupported: still works, just slower */ }
    }
    document.body.addClass('fluid-sidebar');
    this.app.workspace.onLayoutReady(() => {
      try { this.attach(); } catch (e) { this.fail(TEXT.startup, e); }
    });
  }

  // Stand down: restore native Obsidian and stay out of the way until reload.
  fail(reason, err) {
    if (this.failed) return;
    this.failed = reason;
    console.error(`[Fluid Sidebar] paused: ${reason}`, err || '');
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    try { this.deactivate(); } catch (e) { /* keep going */ }
    document.body.removeClass('cd-sliding');
    new Notice(TEXT.paused(reason), 10000);
  }

  // Things we rely on that aren't public API. Checked each time the drawer comes into play.
  selfCheck() {
    const ws = this.app.workspace;
    for (const s of [ws.leftSplit, ws.rightSplit]) {
      if (!s || typeof s.expand !== 'function' || typeof s.collapse !== 'function' || typeof s.collapsed !== 'boolean') {
        return TEXT.splitApi;
      }
    }
    const root = ws.rootSplit && ws.rootSplit.containerEl;
    if (!root || !root.isConnected) return TEXT.rootView;
    if (root !== this.rootEl) {
      // Layout was reloaded (e.g. workspace switch): follow the new main view.
      this.rootEl = root;
      this.mo.observe(root, { attributes: true, attributeFilter: ['style'] });
    }
    if (!this.drawerEl('left') || !this.drawerEl('right')) return TEXT.drawerDom;
    return null;
  }

  onunload() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.deactivate();
    document.body.removeClass('fluid-sidebar', 'cd-sliding');
  }

  attach() {
    const ws = this.app.workspace;
    this.wsEl = ws.containerEl;
    this.rootEl = ws.rootSplit.containerEl;
    this.refreshEnabled();
    const mo = this.mo = new MutationObserver(this.wake);
    mo.observe(this.wsEl, { childList: true, attributes: true, attributeFilter: ['class'] });
    mo.observe(this.rootEl, { attributes: true, attributeFilter: ['style'] });
    this.register(() => mo.disconnect());
    const opts = { capture: true, passive: true };
    this.registerDomEvent(window, 'touchstart', (e) => {
      this.touching = true;
      this.armed = false;
      const t = e.touches[0];
      if (t) { this.x0 = t.clientX; this.y0 = t.clientY; }
      // The drag begins when Obsidian's inline position moves away from this value.
      this.inlineAtTouch = this.readInline();
      this.wake();
    }, opts);
    // A tap (or a vertical scroll) never ticks; only a sideways swipe does.
    this.registerDomEvent(window, 'touchmove', (e) => {
      const t = e.touches[0];
      if (this.armed || !t) return;
      const dx = Math.abs(t.clientX - this.x0), dy = Math.abs(t.clientY - this.y0);
      if (dx > 10 && dx > dy) this.armed = true;
    }, opts);
    const up = (e) => { this.touching = e.touches.length > 0; this.wake(); };
    this.registerDomEvent(window, 'touchend', up, opts);
    this.registerDomEvent(window, 'touchcancel', up, opts);
    this.registerEvent(this.app.workspace.on('css-change', () => this.refreshEnabled()));
    // Rotation / keyboard: sidebar width and navbar position change; re-place the card.
    this.registerDomEvent(window, 'resize', () => {
      if (this.active) this.placeNavOrigin();
      this.wake();
    });
    this.wake();
  }

  refreshEnabled() {
    document.body.toggleClass('cd-sliding', !this.failed && !!this.app.vault.getConfig('slidingSidebar'));
  }

  enabled() {
    const b = document.body;
    return !this.failed && b.hasClass('is-phone') && !!this.app.vault.getConfig('slidingSidebar');
  }

  split(side) {
    return side === 'left' ? this.app.workspace.leftSplit : this.app.workspace.rightSplit;
  }

  drawerEl(side) {
    return this.wsEl.querySelector(`:scope > .workspace-drawer.mod-${side}`);
  }

  isOpen(side) {
    const s = this.split(side);
    return !!s && !s.collapsed && !s.isPinned;
  }

  wake() {
    if (!this.raf) {
      this.lastT = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  activate(side) {
    const b = document.body;
    this.active = true;
    this.side = side;
    this.d = 0;
    this.v = 0;
    this.hist = [];
    this.half = false;
    b.addClass('cd-open', `cd-side-${side}`);
    // The dim is a plain element inside the card (no layer of its own), opacity set directly.
    this.dimEl = this.rootEl.createDiv({ cls: 'cd-dim' });
    this.placeNavOrigin();
  }

  navEl() {
    return this.app.mobileNavbar && this.app.mobileNavbar.containerEl;
  }

  // Navbar is a separate fixed element: scale it about the same screen point as the card.
  placeNavOrigin() {
    const nav = this.navEl();
    if (!nav || !this.side) return;
    const ox = this.side === 'left' ? 0 : window.innerWidth;
    this.put(nav, 'transform-origin', `${ox - nav.offsetLeft}px ${window.innerHeight / 2 - nav.offsetTop}px`);
  }

  // Set an inline style only when it changes (writing the main view's style wakes our
  // observer), and remember it so deactivate() can take back exactly what we wrote.
  put(el, prop, val) {
    if (!el) return;
    let w = this.written.get(el);
    if (!w) this.written.set(el, (w = {}));
    if (w[prop] === val) return;
    w[prop] = val;
    el.style.setProperty(prop, val);
  }

  deactivate() {
    const b = document.body;
    this.active = false;
    this.side = null;
    this.dragging = false;
    this.armed = false;
    b.removeClass('cd-open', 'cd-side-left', 'cd-side-right');
    for (const [el, w] of this.written) for (const p in w) el.style.removeProperty(p);
    this.written.clear();
    if (this.dimEl) { this.dimEl.remove(); this.dimEl = null; }
  }

  // Obsidian's live drag position, from the inline transform it writes on the main view.
  readInline() {
    const m = /translateX\((-?[\d.]+)px\)/.exec(this.rootEl.style.transform || '');
    return m ? Math.abs(parseFloat(m[1])) : null;
  }

  tick(now) {
    this.raf = 0;
    try {
      this.step(now);
    } catch (e) {
      this.fail(TEXT.runtime, e);
    }
  }

  step(now) {
    // A long frame (Obsidian laying out the sidebar as it appears) must not fast-forward the
    // spring: with a 50 ms step the card leapt ~100 px at once. Cap the step so it only waits.
    // The cap follows the phone's usual frame time (8 ms at 120 Hz, 33 ms when iOS throttles
    // to 30 fps in Low Power Mode), so throttling doesn't slow the animation down.
    const raw = this.lastT ? (now - this.lastT) / 1000 : 1 / 60;
    const cap = Math.max(0.02, Math.min(0.05, 1.5 * (this.frameAvg || 1 / 60)));
    const dt = Math.min(cap, raw);
    if (this.lastT) this.frameAvg = 0.9 * (this.frameAvg || 1 / 60) + 0.1 * Math.min(raw, 0.05);
    this.lastT = now;

    if (!this.enabled()) {
      if (this.active) this.deactivate();
      return;
    }
    if (!this.active) {
      const side = this.isOpen('left') ? 'left' : this.isOpen('right') ? 'right' : null;
      if (!side) return;
      const problem = this.selfCheck();
      if (problem) return this.fail(problem);
      this.activate(side);
    }

    const drawer = this.drawerEl(this.side);
    const W = drawer ? drawer.offsetWidth || window.innerWidth - PEEK : window.innerWidth - PEEK;
    const inline = this.readInline();

    // Obsidian is dragging its sidebar (it writes the position inline on the drawer) but no
    // longer on the main view, where we read it: its drag mechanism changed. Stand down.
    if (this.touching && inline === null && drawer && /translateX/.test(drawer.style.transform || '')) {
      return this.fail(TEXT.dragModel);
    }

    if (this.touching && inline !== null && inline !== this.inlineAtTouch && !this.dragging) {
      this.dragging = true;
    }

    let settled = false;
    let target = this.isOpen(this.side) ? W : 0;

    if (this.touching && !this.dragging && this.inlineAtTouch === null && inline === null) {
      // Finger down, Obsidian hasn't claimed a swipe yet: hold still.
    } else if (this.dragging && this.touching) {
      // Follow the finger 1:1.
      const d = inline !== null ? Math.max(0, Math.min(W, inline)) : this.d;
      this.hist.push([now, d]);
      while (this.hist.length > 2 && now - this.hist[0][0] > 80) this.hist.shift();
      this.d = d;
    } else {
      if (this.dragging) {
        // Just released: carry the finger's velocity into the spring.
        this.dragging = false;
        const h = this.hist;
        if (h.length >= 2) {
          const [t0, d0] = h[0], [t1, d1] = h[h.length - 1];
          this.v = t1 > t0 ? ((d1 - d0) / (t1 - t0)) * 1000 : 0;
        }
        this.hist = [];
        // Decide like Duet: where would the card be ~0.3 s from now at this speed?
        // (Obsidian's own decision keeps a stale velocity when the finger rests before
        // lifting, so a held half-drag would fly open.) Bring Obsidian's state in line.
        const wantOpen = this.d + this.v * PROJECT > W / 2;
        if (wantOpen !== this.isOpen(this.side)) {
          const sp = this.split(this.side);
          if (wantOpen) {
            sp.expand();
            // expand() cuts short Obsidian's close animation, whose end callback just
            // hid the sidebar and removed the backdrop (needed for tap-to-close).
            if (sp.backdropEl && !sp.backdropEl.parentElement) this.wsEl.appendChild(sp.backdropEl);
            sp.containerEl.show();
          } else {
            sp.collapse();
          }
        }
        target = wantOpen ? W : 0;
      }
      // Critically damped spring toward the state Obsidian decided on (exact step, so
      // uneven frame times can't make it overshoot or jitter).
      const x0 = this.d - target;
      const k = this.v + OMEGA * x0;
      const e = Math.exp(-OMEGA * dt);
      this.d = target + (x0 + k * dt) * e;
      this.v = (this.v - OMEGA * k * dt) * e;
      if (this.d < 0) { this.d = 0; this.v = Math.max(0, this.v); }
      if (this.d > W) { this.d = W; this.v = Math.min(0, this.v); }
      if (Math.abs(this.d - target) < 0.3 && Math.abs(this.v) < 8) {
        this.d = target;
        this.v = 0;
        settled = true;
      }
    }

    this.tame();

    // Like Duet: one tick each time the card, as drawn, passes half way — under the finger
    // or carried by the spring after a flick. Only after a sideways swipe, never a tap.
    this.crossTo(this.d > W / 2, now);
    if (settled && !this.touching) this.armed = false;

    this.apply(this.d / W, W);

    if (settled && target === 0 && !this.touching) {
      // Obsidian clears the drag position it wrote on the main view only when its own close
      // animation ends, which can be after our spring has settled. Standing down before that
      // shows its stale position for a moment: the card jumps a few px right, then back.
      // So hold the card at 0 until Obsidian has let go (at most 600 ms, then stand down anyway).
      if (this.readInline() !== null && (this.holdSince = this.holdSince || now) && now - this.holdSince < 600) {
        this.raf = requestAnimationFrame(this.tick);
        return;
      }
      this.holdSince = 0;
      this.deactivate();
      return;
    }
    this.holdSince = 0;
    if (settled && !this.touching) return; // sleep until a touch or a state change
    this.raf = requestAnimationFrame(this.tick);
  }

  // When the finger lifts (or on expand()/collapse()), Obsidian slides the sidebar, main view
  // and navbar with Web Animations. Our !important styles win on desktop, but on iPhone those
  // animations run on the compositor and show through: the sidebar visibly jumps. Keep each
  // animation (Obsidian's finish callbacks still fire on time) but empty its keyframes.
  tame() {
    const els = [this.rootEl, this.navEl(), this.drawerEl('left'), this.drawerEl('right')];
    for (const el of els) {
      if (!el || typeof el.getAnimations !== 'function') continue;
      for (const a of el.getAnimations()) {
        if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) continue;
        if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) continue;
        const fx = a.effect;
        if (!fx || typeof fx.getKeyframes !== 'function' || typeof fx.setKeyframes !== 'function') continue;
        if (fx.getKeyframes().some((k) => 'transform' in k)) fx.setKeyframes([]);
      }
    }
  }

  crossTo(half, now) {
    if (this.armed && this.half !== null && half !== this.half && now - this.lastBuzz >= HAPTIC_GAP) {
      this.lastBuzz = now;
      this.haptic();
    }
    this.half = half;
  }

  // iPhone/Android haptics through the Capacitor module Obsidian ships. Not awaited, so
  // bridge latency never holds up a frame. Absent on desktop: then it does nothing.
  haptic() {
    if (this.haptics === undefined) {
      this.haptics = null;
      try {
        const C = window.Capacitor;
        this.haptics = (C && ((C.Plugins && C.Plugins.Haptics) ||
          (typeof C.registerPlugin === 'function' && C.registerPlugin('Haptics')))) || null;
      } catch (e) { /* no haptics */ }
    }
    if (!this.haptics) return;
    try {
      const r = this.haptics.impact({ style: 'MEDIUM' });
      if (r && r.catch) r.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // Per frame we write variables only onto the few elements that move. (On <body> they made
  // the whole app — editor, Notebook Navigator — restyle every frame.) Rendering is otherwise
  // exactly as in 0.2.4: no extra layers or will-change, which on iOS made the card blink
  // out for a few frames when Obsidian finished its own open animation.
  apply(p, W) {
    const sign = this.side === 'left' ? 1 : -1;
    const shrink = 1 - Math.pow(1 - p, 3);
    const x = `${(sign * p * W).toFixed(2)}px`;
    const sc = (1 - shrink * ((2 * INSET) / window.innerHeight)).toFixed(4);
    const dim = (DIM * Math.pow(p, 0.85)).toFixed(3);
    const root = this.rootEl, nav = this.navEl();
    this.put(root, '--cd-x', x);
    this.put(root, '--cd-scale', sc);
    this.put(root, 'box-shadow', `0 0 54px rgba(0, 0, 0, ${(0.42 * Math.min(1, p * 2)).toFixed(3)})`);
    this.put(this.dimEl, 'opacity', dim);
    this.put(nav, '--cd-x', x);
    this.put(nav, '--cd-scale', sc);
    this.put(nav, '--cd-nav-dim', dim); // plain (inherited) variable: the navbar is tiny
    this.put(this.drawerEl(this.side), '--cd-drawer-x', `${(-sign * PARALLAX * (1 - p)).toFixed(2)}px`);
  }
};