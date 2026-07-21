// ---------------------------------------------------------------------------
// Configuration — all tunable constants in one place
// ---------------------------------------------------------------------------

const CONFIG = {
  FLAKES_PER_AREA: 3500,       // viewport px² per snowflake
  MIN_FLAKES: 50,
  MAX_FLAKES: 800,
  MAX_SILLS: 500,
  CANVAS_WIDTH_OFFSET: 30,     // shrink canvas to avoid horizontal scrollbar
  RESIZE_THROTTLE_MS: 100,
  LANDING_TOLERANCE: 5,        // px above sill top to detect landing
  NEIGHBOR_RADIUS: 60,         // px radius for neighbor-aware drift
  DRIFT_MIN_MS: 300,           // min duration to hold a drift direction
  DRIFT_RANGE_MS: 1700,        // additional random duration range
  SPEED_BASE: 0.05,
  SPEED_RANDOM: 0.1,
  SPEED_BURST_THRESHOLD: 0.8,  // probability threshold for speed burst
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
// SpatialGrid — buckets flakes into cells for fast neighbor queries
// ---------------------------------------------------------------------------

class SpatialGrid {
  /**
   * @param {number} cellSize - width/height of each grid cell in px
   */
  constructor(cellSize) {
    this.cellSize = cellSize;
    /** @type {Map<string, Flake[]>} */
    this.cells = new Map();
  }

  /** Clear all cells. Call once per frame before re-inserting flakes. */
  clear() {
    this.cells.clear();
  }

  /** @returns {string} cell key for the given world position */
  _key(x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    return `${col},${row}`;
  }

  /** Insert a flake into the grid. */
  insert(flake) {
    const key = this._key(flake.x, flake.y);
    const bucket = this.cells.get(key);
    if (bucket) {
      bucket.push(flake);
    } else {
      this.cells.set(key, [flake]);
    }
  }

  /**
   * Return all flakes in the same cell and the 8 surrounding cells.
   * @param {number} x
   * @param {number} y
   * @returns {Flake[]}
   */
  getNeighbors(x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    const result = [];

    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const bucket = this.cells.get(`${col + dc},${row + dr}`);
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            result.push(bucket[i]);
          }
        }
      }
    }

    return result;
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
   * Apply lateral drift. Uses neighbor-aware weighting so flakes spread out
   * rather than clumping.
   *
   * @param {number} delta    - elapsed ms since last frame
   * @param {SpatialGrid} grid - spatial grid populated for the current frame
   */
  swing(delta, grid) {
    this.driftDuration -= delta;

    // Pick a new drift direction when the current one expires
    if (this.driftDuration <= 0) {
      this._pickDriftDirection(grid);
      this.driftDuration = CONFIG.DRIFT_MIN_MS + Math.random() * CONFIG.DRIFT_RANGE_MS;
    }

    // Add a small sine-wave oscillation on top of the held direction
    this.driftPhase += delta * this.oscFreq;
    const jitter = Math.sin(this.driftPhase) * this.oscAmplitude;

    this.x += delta * this.speed * CONFIG.DRIFT_SPEED_FACTOR * this.driftDirection
            + jitter * CONFIG.JITTER_FACTOR;
  }

  /**
   * Choose a drift direction (-1 or +1) weighted by neighbor density.
   * Flakes prefer to drift away from the more crowded side.
   *
   * @param {SpatialGrid} grid
   */
  _pickDriftDirection(grid) {
    const neighbors = grid.getNeighbors(this.x, this.y);
    const radius = CONFIG.NEIGHBOR_RADIUS;

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
   * Check whether this flake has landed on any sill.
   * @param {DOMRect[]} sills
   * @returns {boolean}
   */
  landed(sills) {
    for (let i = 0; i < sills.length; i++) {
      const sill = sills[i];
      if (
        this.x > sill.x &&
        this.x < sill.x + sill.width &&
        this.y > sill.y - CONFIG.LANDING_TOLERANCE &&
        this.y < sill.y + sill.height
      ) {
        return true;
      }
    }
    return false;
  }

  /** Mark this flake as melting (for future melt animation). */
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
    this.sills = [];
    this.grid = new SpatialGrid(CONFIG.NEIGHBOR_RADIUS);

    // Compute initial flake count from viewport area
    this.max = Snowfall.computeFlakeCount();

    // Snapshot the bounding boxes of landing targets
    this.sills.push(...doms.map((dom) => dom.getBoundingClientRect()));
    this._initialSillCount = this.sills.length;

    this._createCanvas();
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
    this.canvas.width = window.innerWidth - CONFIG.CANVAS_WIDTH_OFFSET;
    this.canvas.height = document.body.clientHeight;
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
    // Rebuild the spatial grid once per frame
    this.grid.clear();
    for (let i = 0; i < this.flakes.length; i++) {
      this.grid.insert(this.flakes[i]);
    }

    for (let i = 0; i < this.flakes.length; i++) {
      const flake = this.flakes[i];

      flake.fall(delta);
      flake.swing(delta, this.grid);

      if (flake.landed(this.sills)) {
        if (this.sills.length < CONFIG.MAX_SILLS) {
          this.sills.push(new DOMRect(flake.x, flake.y, flake.size, flake.size));
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

  /** Draw accumulated snow sills (only the dynamically-added ones). */
  _drawSills() {
    // Skip the initial DOM-sourced rects; only draw snow that has piled up
    const startIndex = this._initialSillCount ?? 0;

    this.ctx.fillStyle = '#fff';
    for (let i = startIndex; i < this.sills.length; i++) {
      const s = this.sills[i];
      this.ctx.fillRect(s.x, s.y, s.width, s.height);
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

      const delta = now - lastTimestamp;
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

  /** Throttled resize handler that adjusts canvas and flake count. */
  _bindResizeHandler() {
    let throttleTimer;

    window.addEventListener('resize', () => {
      if (throttleTimer !== undefined) return;

      throttleTimer = window.setTimeout(() => {
        throttleTimer = undefined;

        this._resizeCanvas();

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
    });
  }
}

export default Snowfall;
