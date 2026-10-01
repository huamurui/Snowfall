// ---------------------------------------------------------------------------
// Configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

const CONFIG = {
  FLAKES_PER_AREA: 3500,       // viewport px² per snowflake
  MIN_FLAKES: 50,
  MAX_FLAKES: 800,
  MAX_SILLS: 500,
  RESIZE_THROTTLE_MS: 100,
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
  JITTER_REFERENCE_FRAME_MS: 1000 / 60, // retain the original 60 FPS sway
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
    /** Reusable buffer shared by rectangle and neighborhood queries */
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
   * Collect candidates from every cell overlapping the rectangle.
   * A multi-cell item may appear more than once. The returned buffer is valid
   * until the next rectangle or neighborhood query on this grid.
   */
  queryRect(x, y, w, h) {
    const c0 = Math.max(0, Math.floor(x / this.cellSize));
    const c1 = Math.min(this.cols - 1, Math.floor((x + w) / this.cellSize));
    const r0 = Math.max(0, Math.floor(y / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.floor((y + h) / this.cellSize));
    const buf = this._buf;
    buf.length = 0;

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const bucket = this.cells[r * this.cols + c];
        for (let i = 0; i < bucket.length; i++) {
          buf.push(bucket[i]);
        }
      }
    }

    return buf;
  }

  /**
   * Collect all items in the 3×3 neighborhood around (x, y) into an internal
   * buffer and return it. The result is only valid until the next rectangle
   * or neighborhood query on this grid.
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

    const previousPhase = this.driftPhase;
    this.driftPhase += delta * this.oscFreq;
    // Integrate the oscillating velocity so sway does not depend on frame rate.
    const jitter = (Math.cos(previousPhase) - Math.cos(this.driftPhase))
                 * this.oscAmplitude / this.oscFreq;

    this.x += delta * this.speed * CONFIG.DRIFT_SPEED_FACTOR * this.driftDirection
            + jitter * CONFIG.JITTER_FACTOR / CONFIG.JITTER_REFERENCE_FRAME_MS;
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
   * Find the first sill crossed by the flake's bottom edge during this frame.
   * Check horizontal overlap at the crossing time, then snap to that surface.
   *
   * @param {Grid} sillGrid
   * @param {number} previousX
   * @param {number} previousY
   * @returns {{x:number, y:number, w:number, h:number}|null} the supporting sill
   */
  landed(sillGrid, previousX, previousY) {
    const dx = this.x - previousX;
    const dy = this.y - previousY;
    if (dy <= 0) return null;

    const previousBottom = previousY + this.size;
    const candidates = sillGrid.queryRect(
      Math.min(previousX, this.x),
      previousBottom,
      Math.abs(dx) + this.size,
      dy,
    );
    let hit = null;
    let hitTime = Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i];
      if (s.w <= 0 || s.h <= 0) continue;
      const time = (s.y - previousBottom) / dy;
      if (time < 0 || time > 1 || time >= hitTime) continue;

      const x = previousX + dx * time;
      if (x < s.x + s.w && x + this.size > s.x) {
        hit = s;
        hitTime = time;
      }
    }

    if (hit) {
      this.x = previousX + dx * hitTime;
      this.y = hit.y - this.size;
    }
    return hit;
  }

  /** @todo Implement melt animation rendering in _drawFrame. */
  melt() {
    this.melting = true;
  }

  /**
   * @param {number} worldWidth
   * @param {number} worldHeight
   * @returns {boolean} true if the flake is within the simulated document
   */
  isVisible(worldWidth, worldHeight) {
    return this.x >= 0 && this.y >= 0 && this.x < worldWidth && this.y < worldHeight;
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

// Ignore overlay mutations, including canvases owned by other instances.
const OVERLAY_CANVASES = new WeakSet();

class Snowfall {
  /** @param {HTMLElement[]} doms - elements that flakes can land on */
  constructor(doms = []) {
    this.flakes = [];
    /** @type {Array<{x:number, y:number, w:number, h:number}>} */
    this.sills = [];
    this._doms = Array.from(doms);
    this._destroyed = false;
    this._refreshTimer = undefined;
    this.flakeGrid = new Grid(CONFIG.GRID_CELL_SIZE);
    this.sillGrid = new Grid(CONFIG.GRID_CELL_SIZE);

    if (!window.HTMLCanvasElement) {
      this.destroy();
      console.warn('Snowfall: browser does not support <canvas>.');
      return;
    }

    for (let i = 0; i < this._doms.length; i++) {
      this.sills.push({ x: 0, y: 0, w: 0, h: 0 });
    }
    this._initialSillCount = this.sills.length;
    this._createCanvas();
    if (!this.ctx) {
      this.destroy();
      console.warn('Snowfall: could not create a 2D canvas context.');
      return;
    }

    this._resizeCanvas();
    this._refreshDomSills();
    this.flakeGrid.resize(this._width, this._height);
    this._rebuildSillGrid();
    this.max = Snowfall.computeFlakeCount(this._width, this._height);
    this._generateFlakes();
    this._bindLayoutHandlers();
    this._startAnimationLoop();
  }

  // ---- Static helpers -----------------------------------------------------

  /** Compute flake density in document CSS pixels, independently of the bitmap. */
  static computeFlakeCount(
    width = document.documentElement.scrollWidth,
    height = Math.max(window.innerHeight, document.documentElement.scrollHeight),
  ) {
    const area = width * height;
    return Math.max(CONFIG.MIN_FLAKES, Math.min(CONFIG.MAX_FLAKES, Math.round(area / CONFIG.FLAKES_PER_AREA)));
  }

  // ---- Canvas setup -------------------------------------------------------

  /** A viewport-sized overlay does not change page overflow or body layout. */
  _createCanvas() {
    this.canvas = document.createElement('canvas');
    OVERLAY_CANVASES.add(this.canvas);
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      display: 'block',
      margin: '0',
      padding: '0',
      border: '0',
      maxWidth: 'none',
      maxHeight: 'none',
      zIndex: '99999',
      pointerEvents: 'none',
    });
    this.ctx = this.canvas.getContext('2d');
    // A positioned or transformed body must not become the containing block.
    document.documentElement.appendChild(this.canvas);
  }

  /** Measure document bounds separately from the viewport's rendering surface. */
  _resizeCanvas() {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = root.clientWidth;
    const viewportHeight = window.innerHeight;
    // Update CSS bounds before measuring page overflow after a viewport shrink.
    const cssWidth = `${viewportWidth}px`;
    const cssHeight = `${viewportHeight}px`;
    if (this.canvas.style.width !== cssWidth) this.canvas.style.width = cssWidth;
    if (this.canvas.style.height !== cssHeight) this.canvas.style.height = cssHeight;
    const width = Math.max(viewportWidth, root.scrollWidth, body.scrollWidth);
    const height = Math.max(viewportHeight, root.scrollHeight, body.scrollHeight);
    const changed = width !== this._width || height !== this._height;
    this._width = width;
    this._height = height;
    this._pixelRatio = window.devicePixelRatio || 1;

    const bitmapWidth = Math.round(viewportWidth * this._pixelRatio);
    const bitmapHeight = Math.round(viewportHeight * this._pixelRatio);
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    return changed;
  }

  // ---- Sill grid management -----------------------------------------------

  /** Only the top edge can support a falling flake. */
  _registerSill(sill) {
    if (sill.w > 0 && sill.h > 0) {
      this.sillGrid.insertRect(sill, sill.x, sill.y, sill.w, 0);
    }
  }

  /**
   * Rebuild the sill grid from scratch.
   * Re-register sills when document dimensions or target geometry change,
   * since a new grid width invalidates the old numeric cell indices.
   */
  _rebuildSillGrid() {
    this.sillGrid.resize(this._width, this._height);
    this.sillGrid.clear();
    for (let i = 0; i < this.sills.length; i++) {
      this._registerSill(this.sills[i]);
    }
  }

  /** Update document-coordinate targets; report actual geometry changes. */
  _refreshDomSills() {
    let changed = false;
    for (let i = 0; i < this._doms.length; i++) {
      const dom = this._doms[i];
      const r = dom.getBoundingClientRect();
      const sill = this.sills[i];
      const active = dom.isConnected && r.width > 0 && r.height > 0;
      const x = active ? r.left + window.scrollX : 0;
      const y = active ? r.top + window.scrollY : 0;
      const w = active ? r.width : 0;
      const h = active ? r.height : 0;
      if (sill.x !== x || sill.y !== y || sill.w !== w || sill.h !== h) {
        changed = true;
        Object.assign(sill, { x, y, w, h });
      }
    }
    return changed;
  }

  /** Re-measure layout immediately, including changes made through CSS APIs. */
  refresh() {
    if (this._destroyed) return;
    if (this._refreshTimer !== undefined) {
      window.clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    const resized = this._resizeCanvas();
    const targetsMoved = this._refreshDomSills();
    if (targetsMoved) {
      // Snow attached to the previous layout must not remain floating in place.
      this.sills.length = this._initialSillCount;
    }
    if (resized) this.flakeGrid.resize(this._width, this._height);
    if (resized || targetsMoved) this._rebuildSillGrid();

    const newMax = Snowfall.computeFlakeCount(this._width, this._height);
    while (this.flakes.length < newMax) {
      this.flakes.push(new Flake(this._randomX(), Math.random() * this._height));
    }
    this.flakes.length = newMax;
    this.max = newMax;
    this._drawFrame();
  }

  // ---- Flake lifecycle ----------------------------------------------------

  /** Populate the flake array for the first time. */
  _generateFlakes() {
    for (let i = 0; i < this.max; i++) {
      this.flakes.push(new Flake(this._randomX(), 0));
    }
  }

  /** @returns {number} a random x within the simulated document */
  _randomX() {
    return Math.floor(Math.random() * this._width);
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

      const previousX = flake.x;
      const previousY = flake.y;
      flake.fall(delta);
      flake.swing(delta, this.flakeGrid);

      if (flake.landed(this.sillGrid, previousX, previousY)) {
        if (this.sills.length < CONFIG.MAX_SILLS) {
          const sill = { x: flake.x, y: flake.y, w: flake.size, h: flake.size };
          this.sills.push(sill);
          this._registerSill(sill);   // incremental insert, no rebuild
        }
        flake.reset(this._randomX(), 0);
        continue;
      }

      if (!flake.isVisible(this._width, this._height)) {
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
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const ratio = this._pixelRatio;
    this.ctx.setTransform(ratio, 0, 0, ratio, -window.scrollX * ratio, -window.scrollY * ratio);

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
      if (this._destroyed) return;
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

  /** Coalesce all layout notifications into one cancellable refresh. */
  _bindLayoutHandlers() {
    this._layoutHandler = () => {
      if (this._destroyed || this._refreshTimer !== undefined) return;
      this._refreshTimer = window.setTimeout(() => {
        this._refreshTimer = undefined;
        this.refresh();
      }, CONFIG.RESIZE_THROTTLE_MS);
    };
    window.addEventListener('resize', this._layoutHandler);
    // Capture scrolls from nested containers as well as fixed/sticky targets.
    window.addEventListener('scroll', this._layoutHandler, true);
    document.addEventListener('load', this._layoutHandler, true);
    document.fonts?.addEventListener('loadingdone', this._layoutHandler);

    if (window.ResizeObserver) {
      this._resizeObserver = new window.ResizeObserver(this._layoutHandler);
      this._resizeObserver.observe(document.documentElement);
      this._resizeObserver.observe(document.body);
      for (const dom of this._doms) this._resizeObserver.observe(dom);
    }
    if (window.MutationObserver) {
      this._mutationObserver = new window.MutationObserver((records) => {
        const affectsLayout = records.some((record) => {
          if (OVERLAY_CANVASES.has(record.target)) return false;
          if (record.type !== 'childList') return true;
          return [...record.addedNodes, ...record.removedNodes]
            .some((node) => !OVERLAY_CANVASES.has(node));
        });
        if (affectsLayout) this._layoutHandler();
      });
      this._mutationObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Tear down completely: stop animation, detach events, remove canvas from DOM.
   * Call this when the component is unmounted in an SPA to prevent memory leaks.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.removeAnimation();
    if (this._refreshTimer !== undefined) {
      window.clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    window.removeEventListener('resize', this._layoutHandler);
    window.removeEventListener('scroll', this._layoutHandler, true);
    document.removeEventListener('load', this._layoutHandler, true);
    document.fonts?.removeEventListener('loadingdone', this._layoutHandler);
    this._resizeObserver?.disconnect();
    this._mutationObserver?.disconnect();
    this.canvas?.remove();
    this.flakes.length = 0;
    this.sills.length = 0;
    this.flakeGrid.clear();
    this.sillGrid.clear();
    this._doms = null;
  }
}

export default Snowfall;
