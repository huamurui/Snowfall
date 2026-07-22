// ---------------------------------------------------------------------------
// Configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

const CONFIG = {
  FLAKES_PER_AREA: 3500,       // viewport px² per snowflake
  MIN_FLAKES: 50,
  MAX_FLAKES: 800,
  MAX_SILLS: 500,
  RESIZE_THROTTLE_MS: 100,
  LANDING_TOLERANCE: 5,        // px above sill top to detect landing
  GRID_CELL_SIZE: 60,          // px per grid cell (both flake & sill grids)
  DRIFT_MIN_MS: 300,
  DRIFT_RANGE_MS: 1700,
  SPEED_BASE: 0.05,
  SPEED_RANDOM: 0.1,
  SPEED_BURST_THRESHOLD: 0.8,
  SPEED_BURST_EXTRA: 0.2,
  MAX_FLAKE_SIZE: 4,
  DRIFT_SPEED_FACTOR: 0.1,
  JITTER_FACTOR: 0.2,
  OSC_AMP_BASE: 0.2,
  OSC_AMP_RANGE: 0.8,
  OSC_FREQ_BASE: 0.003,
  OSC_FREQ_RANGE: 0.007,
};

// ---------------------------------------------------------------------------
// Grid — pre-allocated flat-array spatial grid (zero per-frame GC pressure)
//
// Key design decisions vs. the previous SpatialGrid:
//   1. Numeric index (row * cols + col) instead of template-literal string keys
//      → eliminates thousands of short-lived strings per frame.
//   2. Backing arrays are pre-allocated and never replaced; clear() just sets
//      each bucket's length to 0 → no per-frame object allocation at all.
//   3. queryNeighborhood() writes into a reusable internal buffer instead of
//      allocating a new result array on every call.
// ---------------------------------------------------------------------------

class Grid {
  /** @param {number} cellSize — width & height of each cell in px */
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cols = 0;
    this.rows = 0;
    /** @type {Array<Array<*>>} flat array of bucket arrays */
    this.cells = [];
    /** Reusable buffer for {@link queryNeighborhood} results */
    this._buf = [];
    /** Shared empty array returned for out-of-bounds {@link query} calls */
    this._empty = [];
  }

  /**
   * Ensure the grid covers at least the given pixel dimensions.
   * Only grows the internal array — never shrinks — so repeated resize calls
   * during window dragging don't trigger allocation churn.
   */
  resize(width, height) {
    this.cols = Math.ceil(width / this.cellSize) + 1;
    this.rows = Math.ceil(height / this.cellSize) + 1;
    const needed = this.cols * this.rows;
    while (this.cells.length < needed) {
      this.cells.push([]);
    }
  }

  /** Reset every cell to empty (reuses existing arrays — zero allocation). */
  clear() {
    const len = this.cols * this.rows;
    for (let i = 0; i < len; i++) {
      this.cells[i].length = 0;
    }
  }

  /** Insert an item into the single cell that contains pixel position (x, y). */
  insert(item, x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col >= 0 && col < this.cols && row >= 0 && row < this.rows) {
      this.cells[row * this.cols + col].push(item);
    }
  }

  /**
   * Insert an item into every cell overlapping the pixel rectangle.
   * Used for sills that may span multiple grid cells.
   *
   * @param {*}      item
   * @param {number}  x - left edge
   * @param {number}  y - top edge
   * @param {number}  w - width
   * @param {number}  h - height
   */
  insertRect(item, x, y, w, h) {
    const c0 = Math.max(0, Math.floor(x / this.cellSize));
    const c1 = Math.min(this.cols - 1, Math.floor((x + w) / this.cellSize));
    const r0 = Math.max(0, Math.floor(y / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.floor((y + h) / this.cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        this.cells[r * this.cols + c].push(item);
      }
    }
  }

  /**
   * Return the backing array of the cell at pixel position (x, y).
   * The returned reference is valid until the next mutation of that cell.
   */
  query(x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return this._empty;
    }
    return this.cells[row * this.cols + col];
  }

  /**
   * Collect all items in the 3×3 neighborhood around (x, y) into an internal
   * buffer and return it.  The buffer is reused across calls — the result is
   * only valid until the next call to queryNeighborhood on this instance.
   */
  queryNeighborhood(x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    const buf = this._buf;
    buf.length = 0;

    for (let dr = -1; dr <= 1; dr++) {
      const r = row + dr;
      if (r < 0 || r >= this.rows) continue;
      const rowOffset = r * this.cols;
      for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc;
        if (c < 0 || c >= this.cols) continue;
        const bucket = this.cells[rowOffset + c];
        for (let i = 0; i < bucket.length; i++) {
          buf.push(bucket[i]);
        }
      }
    }

    return buf;
  }
}

// ---------------------------------------------------------------------------
// Flake — a single snowflake particle
// ---------------------------------------------------------------------------

class Flake {
  /**
   * @param {number} x - initial x position
   * @param {number} y - initial y position
   */
  constructor(x, y) {
    this.x = 0;
    this.y = 0;
    this.speed = 0;
    this.size = 0;
    this.driftDirection = 0;
    this.driftDuration = 0;
    this.driftPhase = 0;
    this.oscAmplitude = 0;
    this.oscFreq = 0;
    this.melting = false;

    this.reset(x, y);
  }

  /** Randomize fall speed, with occasional faster bursts. */
  _randomizeSpeed() {
    this.speed = CONFIG.SPEED_BASE + Math.random() * CONFIG.SPEED_RANDOM;
    if (Math.random() > CONFIG.SPEED_BURST_THRESHOLD) {
      this.speed += Math.random() * CONFIG.SPEED_BURST_EXTRA;
    }
  }

  /** Randomize flake size (1–MAX_FLAKE_SIZE px). */
  _randomizeSize() {
    this.size = Math.max(1, Math.floor(Math.random() * CONFIG.MAX_FLAKE_SIZE));
  }

  /** Move the flake downward by `delta` ms worth of falling. */
  fall(delta) {
    this.y += delta * this.speed;
  }

  /**
   * Apply lateral drift with neighbor-aware weighting so flakes spread out
   * rather than clumping.
   *
   * @param {number} delta     - elapsed ms since last frame
   * @param {Grid}   flakeGrid - spatial grid populated for the current frame
   */
  swing(delta, flakeGrid) {
    this.driftDuration -= delta;

    if (this.driftDuration <= 0) {
      this._pickDriftDirection(flakeGrid);
      this.driftDuration = CONFIG.DRIFT_MIN_MS + Math.random() * CONFIG.DRIFT_RANGE_MS;
    }

    this.driftPhase += delta * this.oscFreq;
    const jitter = Math.sin(this.driftPhase) * this.oscAmplitude;

    this.x += delta * this.speed * CONFIG.DRIFT_SPEED_FACTOR * this.driftDirection
            + jitter * CONFIG.JITTER_FACTOR;
  }

  /**
   * Choose a drift direction (-1 or +1) weighted by neighbor density.
   * Flakes prefer to drift away from the more crowded side.
   *
   * @param {Grid} flakeGrid
   */
  _pickDriftDirection(flakeGrid) {
    const neighbors = flakeGrid.queryNeighborhood(this.x, this.y);
    const radius = CONFIG.GRID_CELL_SIZE;

    let leftScore = 0;
    let rightScore = 0;

    for (let i = 0; i < neighbors.length; i++) {
      const f = neighbors[i];
      if (f === this) continue;

      const dx = f.x - this.x;
      const dy = Math.abs(f.y - this.y);

      if (Math.abs(dx) <= radius && dy <= radius) {
        const weight = 1 / (Math.abs(dx) + 1);
        if (dx < 0) {
          leftScore += weight;
        } else {
          rightScore += weight;
        }
      }
    }

    const leftWeight = 1 / (leftScore + 1);
    const rightWeight = 1 / (rightScore + 1);
    const probLeft = leftWeight / (leftWeight + rightWeight);

    this.driftDirection = Math.random() < probLeft ? -1 : 1;
  }

  /**
   * Check whether this flake has landed on any nearby sill.
   * Uses the sill grid so only a handful of candidates are tested per call,
   * instead of the full sills array.
   *
   * @param {Grid} sillGrid
   * @returns {boolean}
   */
  landed(sillGrid) {
    const candidates = sillGrid.query(this.x, this.y);
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i];
      if (
        this.x > s.x &&
        this.x < s.x + s.w &&
        this.y > s.y - CONFIG.LANDING_TOLERANCE &&
        this.y < s.y + s.h
      ) {
        return true;
      }
    }
    return false;
  }

  /** @todo Implement melt animation rendering in _drawFrame. */
  melt() {
    this.melting = true;
  }

  /**
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @returns {boolean} true if the flake is within the visible canvas area
   */
  isVisible(canvasWidth, canvasHeight) {
    return this.x > 0 && this.y > 0 && this.x < canvasWidth && this.y < canvasHeight;
  }

  /**
   * Reset to a new position and re-randomize all physics properties.
   * @param {number} x
   * @param {number} y
   */
  reset(x, y) {
    this.x = x;
    this.y = y;
    this.melting = false;
    this._randomizeSpeed();
    this._randomizeSize();
    this.driftDirection = Math.random() > 0.5 ? 1 : -1;
    this.driftDuration = CONFIG.DRIFT_MIN_MS + Math.random() * CONFIG.DRIFT_RANGE_MS;
    this.driftPhase = Math.random() * Math.PI * 2;
    this.oscAmplitude = CONFIG.OSC_AMP_BASE + Math.random() * CONFIG.OSC_AMP_RANGE;
    this.oscFreq = CONFIG.OSC_FREQ_BASE + Math.random() * CONFIG.OSC_FREQ_RANGE;
  }
}

// ---------------------------------------------------------------------------
// Snowfall — orchestrator: canvas, animation loop, resize handling
// ---------------------------------------------------------------------------

class Snowfall {
  /**
   * @param {HTMLElement[]} doms - elements that flakes can land on
   */
  constructor(doms) {
    if (!window.HTMLCanvasElement) {
      console.warn('Snowfall: aborting — browser does not support <canvas>.');
      return;
    }

    this.flakes = [];
    /** @type {Array<{x:number, y:number, w:number, h:number}>} */
    this.sills = [];

    // Two grids with different lifecycles:
    //   flakeGrid — cleared & rebuilt every frame for neighbor drift queries
    //   sillGrid  — built incrementally; only fully rebuilt on resize
    this.flakeGrid = new Grid(CONFIG.GRID_CELL_SIZE);
    this.sillGrid = new Grid(CONFIG.GRID_CELL_SIZE);

    this.max = Snowfall.computeFlakeCount();

    // Keep DOM references so we can re-query positions on resize
    this._doms = doms;

    // Convert DOM bounding rects to document-absolute coordinates.
    // getBoundingClientRect() is viewport-relative, so we add scroll offset
    // to match the canvas which uses position:absolute (document-relative).
    for (let i = 0; i < doms.length; i++) {
      const r = doms[i].getBoundingClientRect();
      this.sills.push({
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
        w: r.width,
        h: r.height,
      });
    }
    this._initialSillCount = this.sills.length;

    this._createCanvas();

    // Size both grids to match the canvas and register initial sills
    this.flakeGrid.resize(this.canvas.width, this.canvas.height);
    this._rebuildSillGrid();

    this._generateFlakes();
    this._startAnimationLoop();
    this._bindResizeHandler();
  }

  // ---- Static helpers -----------------------------------------------------

  /** Compute the ideal number of flakes for the current viewport size. */
  static computeFlakeCount() {
    const area = window.innerWidth * document.body.clientHeight;
    return Math.max(CONFIG.MIN_FLAKES, Math.min(CONFIG.MAX_FLAKES, Math.round(area / CONFIG.FLAKES_PER_AREA)));
  }

  // ---- Canvas setup -------------------------------------------------------

  /** Create and attach the full-page overlay canvas. */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    this._resizeCanvas();
    this.ctx = this.canvas.getContext('2d');

    // Prevent the canvas itself from triggering a horizontal scrollbar
    document.documentElement.style.overflowX = 'hidden';

    Object.assign(this.canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      zIndex: '99999',
      pointerEvents: 'none',
    });

    document.body.appendChild(this.canvas);
  }

  /** Sync canvas dimensions to the current viewport. */
  _resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = document.body.clientHeight;
  }

  // ---- Sill grid management -----------------------------------------------

  /**
   * Register a single sill into the sill grid.
   * The registration rectangle is expanded upward by LANDING_TOLERANCE so that
   * a flake approaching from above will find the sill in its own grid cell.
   */
  _registerSill(sill) {
    this.sillGrid.insertRect(
      sill,
      sill.x,
      sill.y - CONFIG.LANDING_TOLERANCE,
      sill.w,
      sill.h + CONFIG.LANDING_TOLERANCE,
    );
  }

  /**
   * Rebuild the sill grid from scratch.
   * Called on resize (canvas dimensions change → grid dimensions change →
   * numeric indices are invalidated, so all sills must be re-registered).
   * Only ~500 sills max, and resize is throttled, so this is cheap.
   */
  _rebuildSillGrid() {
    this.sillGrid.resize(this.canvas.width, this.canvas.height);
    this.sillGrid.clear();
    for (let i = 0; i < this.sills.length; i++) {
      this._registerSill(this.sills[i]);
    }
  }

  /**
   * Re-query bounding rects for the original DOM landing targets.
   * Called on resize because element positions shift with the layout.
   */
  _refreshDomSills() {
    for (let i = 0; i < this._doms.length; i++) {
      const r = this._doms[i].getBoundingClientRect();
      const sill = this.sills[i];
      sill.x = r.x + window.scrollX;
      sill.y = r.y + window.scrollY;
      sill.w = r.width;
      sill.h = r.height;
    }
  }

  // ---- Flake lifecycle ----------------------------------------------------

  /** Populate the flake array for the first time. */
  _generateFlakes() {
    for (let i = 0; i < this.max; i++) {
      this.flakes.push(new Flake(this._randomX(), 0));
    }
  }

  /** @returns {number} a random x within the canvas width */
  _randomX() {
    return Math.floor(Math.random() * this.canvas.width);
  }

  /** Update every flake's position for one frame. */
  _updateFlakes(delta) {
    // Rebuild flake grid every frame (zero-alloc thanks to pre-allocated cells)
    this.flakeGrid.clear();
    for (let i = 0; i < this.flakes.length; i++) {
      const f = this.flakes[i];
      this.flakeGrid.insert(f, f.x, f.y);
    }

    for (let i = 0; i < this.flakes.length; i++) {
      const flake = this.flakes[i];

      flake.fall(delta);
      flake.swing(delta, this.flakeGrid);

      if (flake.landed(this.sillGrid)) {
        if (this.sills.length < CONFIG.MAX_SILLS) {
          const sill = { x: flake.x, y: flake.y, w: flake.size, h: flake.size };
          this.sills.push(sill);
          this._registerSill(sill);   // incremental insert, no rebuild
        }
        flake.reset(this._randomX(), 0);
        continue;
      }

      if (!flake.isVisible(this.canvas.width, this.canvas.height)) {
        flake.reset(this._randomX(), 0);
      }
    }
  }

  // ---- Rendering ----------------------------------------------------------

  /** Draw accumulated snow (only the dynamically-added sills, not the DOM ones). */
  _drawSills() {
    this.ctx.fillStyle = '#fff';
    for (let i = this._initialSillCount; i < this.sills.length; i++) {
      const s = this.sills[i];
      this.ctx.fillRect(s.x, s.y, s.w, s.h);
    }
  }

  /** Clear and redraw the entire frame. */
  _drawFrame() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.fillStyle = '#fff';
    this._drawSills();

    for (let i = 0; i < this.flakes.length; i++) {
      const flake = this.flakes[i];
      this.ctx.fillRect(flake.x, flake.y, flake.size, flake.size);
    }
  }

  // ---- Animation loop -----------------------------------------------------

  /** Start the requestAnimationFrame loop. */
  _startAnimationLoop() {
    let lastTimestamp;

    const frame = (now) => {
      if (lastTimestamp === undefined) {
        lastTimestamp = now;
      }

      // Clamp to 100ms so returning from a background tab doesn't
      // cause a massive time-jump that teleports all flakes off-screen.
      const delta = Math.min(now - lastTimestamp, 100);
      this._updateFlakes(delta);
      this._drawFrame();

      lastTimestamp = now;
      this._animationId = window.requestAnimationFrame(frame);
    };

    this._animationId = window.requestAnimationFrame(frame);
  }

  /** Stop the animation loop. */
  removeAnimation() {
    if (this._animationId !== undefined) {
      window.cancelAnimationFrame(this._animationId);
      this._animationId = undefined;
    }
  }

  // ---- Event handling -----------------------------------------------------

  /** Throttled resize handler that adjusts canvas, grids, and flake count. */
  _bindResizeHandler() {
    let throttleTimer;

    this._resizeHandler = () => {
      if (throttleTimer !== undefined) return;

      throttleTimer = window.setTimeout(() => {
        throttleTimer = undefined;

        this._resizeCanvas();
        this._refreshDomSills();

        // Clear accumulated snow — DOM elements don't scale proportionally
        // on resize, so pixel-positioned snow sills would float in wrong
        // places. Keeping only the DOM sills and letting snow re-accumulate
        // naturally is the cleanest approach.
        this.sills.length = this._initialSillCount;

        this.flakeGrid.resize(this.canvas.width, this.canvas.height);
        this._rebuildSillGrid();

        const newMax = Snowfall.computeFlakeCount();

        if (newMax > this.max) {
          for (let i = this.max; i < newMax; i++) {
            this.flakes.push(
              new Flake(this._randomX(), Math.floor(Math.random() * this.canvas.height)),
            );
          }
        } else if (newMax < this.max) {
          this.flakes.length = newMax;
        }

        this.max = newMax;
      }, CONFIG.RESIZE_THROTTLE_MS);
    };

    window.addEventListener('resize', this._resizeHandler);
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Tear down completely: stop animation, detach events, remove canvas from DOM.
   * Call this when the component is unmounted in an SPA to prevent memory leaks.
   */
  destroy() {
    this.removeAnimation();
    window.removeEventListener('resize', this._resizeHandler);
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.flakes.length = 0;
    this.sills.length = 0;
    this._doms = null;
  }
}

export default Snowfall;
