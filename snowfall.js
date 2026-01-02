function Snowfall (doms) {
  if (!window.HTMLCanvasElement) {
    console.warn('Snowfall.js is aborting due to the browser not supporting <canvas>');
    return;
  }

  this.max = 300; // number of flakes
  this.sillsMax = 500; // number of sills
  this.flakes = [];
  this.sills = [];
  this.rects = doms.map(dom => dom.getBoundingClientRect())
  this.sills.push(...this.rects)


  this.createCanvas();
  // this.drawSills();
  this.generateFlakes();
  this.registerAnimation();
  this.bindDOMEvents();
};

Snowfall.prototype.createCanvas = function () {
  this.canvas = document.createElement('canvas');
  this.canvas.width = window.innerWidth - 30;
  this.canvas.height = window.document.body.clientHeight
  this.context = this.canvas.getContext('2d');

  this.canvas.setAttribute('style', 'position: absolute; top: 0; left: 0; z-index: 99999; pointer-events: none');
  document.body.appendChild(this.canvas);
};

Snowfall.prototype.bindDOMEvents = function () {
  var throttle, that;

  that = this;

  window.addEventListener('resize', function () {
    if (typeof throttle === "undefined") {
      throttle = window.setTimeout(function () {
        throttle = undefined;
        that.canvas.width = window.innerWidth - 30;
        that.canvas.height = window.document.body.clientHeight
      }, 100);
    }
  }, false);
};

Snowfall.prototype.drawSills = function () {
  for (let i = this.rects.length; i < this.sills.length; i++) {
    // this "2" is a magic number, it's the index of the first sill
    // ok , it's a magic number not that magic, it's the length of initial sills which we get from doms
    this.context.fillStyle = 'fff';
    this.context.fillRect(this.sills[i].left, this.sills[i].top, this.sills[i].width, this.sills[i].height)

  }
}

Snowfall.prototype.generateFlakes = function () {
  var i;

  for (i = 0; i < this.max; i += 1) {
    // 即使初始化...高度也应该自动从零开始
    this.flakes.push(new Flake(Math.floor(Math.random() * this.canvas.width), 0, this));
  }
};
// 这个delta是时间差...
Snowfall.prototype.updateFlakes = function (delta) {
  var i, len;
  let islanded = false;
  for (i = 0, len = this.flakes.length; i < len; i += 1) {
    this.flakes[i].falling(delta);
    this.flakes[i].swing(delta);

    // 你真是个tmd...小可爱，把i 写成1，怪不得没效果，有效果肯定是有特别鬼畜的，还就只有一个。

    islanded = this.flakes[i].landed(this.sills)
    if (islanded) {
      if (this.sills.length < this.sillsMax) {
        this.sills.push(new DOMRect(this.flakes[i].x, this.flakes[i].y, this.flakes[i].size, this.flakes[i].size))
      }
      this.flakes[i].reset(Math.floor(Math.random() * this.canvas.width), 0);

    }
    // this.flakes[i].landed()

    if (!this.flakes[i].isVisible(this.canvas.width, this.canvas.height)) {
      this.flakes[i].reset(Math.floor(Math.random() * this.canvas.width), 0);
    }
  }
};

Snowfall.prototype.drawFrame = function () {
  var i, len, flake;

  this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  // 如果每次都要清除的话...那我的Sills就没了...虽然有点离谱，但是重画一次也可以。
  this.context.fillStyle = '#fff';
  this.drawSills();
  // 目前难以接受的一个是什么...？那就是，原dom也被遮盖了...这个是不是可以通过z-index来解决呢？或者就，拆分两个数组，一个是雪花，一个是障碍物，然后分别绘制？
  for (i = 0, len = this.flakes.length; i < len; i += 1) {
    flake = this.flakes[i];
    this.context.fillRect(flake.x, flake.y, flake.size, flake.size);
  }
};

Snowfall.prototype.registerAnimation = function () {
  var last_run, frame, that;
  that = this;

  // 这个函数...有意思，传入的值竟然要自己去喂给自己...好吧就是递归，但是这个递归不会返回，会一直咬自己。
  frame = function (now) {
    if (typeof last_run === 'undefined') {
      last_run = now;
    }

    that.updateFlakes(now - last_run);
    that.drawFrame();

    last_run = now;
    that.animation = window.requestAnimationFrame(frame);
  };
  // 这是一个专门的动画API哎..
  this.animation = window.requestAnimationFrame(frame);
};

Snowfall.prototype.removeAnimation = function () {
  if (typeof this.animation === "undefined") {
    return;
  }

  window.cancelAnimationFrame(this.animation);
};

function Flake(x, y, parent) {
  this.parent = parent;
  this.reset(x, y);
};

Flake.prototype.setSpeed = function () {
  this.speed = 0.05 + Math.random() * 0.1;
  if (Math.random() > 0.8) {
    this.speed += Math.random() * 0.2;
  }  
};

Flake.prototype.setSize = function () {
  this.size = Math.max(1, Math.floor(Math.random() * 4));
};

Flake.prototype.falling = function (delta) {
  this.y += delta * this.speed;
};
Flake.prototype.swing = function (delta) {
  // hold a chosen horizontal direction for a short randomized duration
  this.driftDuration -= delta;

  if (this.driftDuration <= 0) {
    if (this.parent && Array.isArray(this.parent.flakes)) {
      let leftScore = 0;
      let rightScore = 0;
      const radius = 60;

      for (let i = 0; i < this.parent.flakes.length; i++) {
        const f = this.parent.flakes[i];
        if (f === this) continue;
        const dx = f.x - this.x;
        const dy = Math.abs(f.y - this.y);
        if (Math.abs(dx) <= radius && dy <= radius) {
          const w = 1 / (Math.abs(dx) + 1);
          if (dx < 0) leftScore += w; else rightScore += w;
        }
      }

      const leftWeight = 1 / (leftScore + 1);
      const rightWeight = 1 / (rightScore + 1);
      const probLeft = leftWeight / (leftWeight + rightWeight);

      this.driftDirection = Math.random() < probLeft ? -1 : 1;
    } else {
      this.driftDirection = Math.random() > 0.5 ? 1 : -1;
    }

    this.driftDuration = 300 + Math.random() * 1700;
  }

  this.x += delta * this.speed * 0.2 * this.driftDirection;
}

Flake.prototype.landed = function (sills) {
  let landed = false;
  for (let i = 0; i < sills.length; i++) {
    let sill = sills[i];
    if (
      this.x > sill.x &&
      this.x < sill.x + sill.width &&
      this.y > (sill.y - 5) &&
      this.y < sill.y + sill.height
    ) {
      landed = true;
      return landed;

      // break;
      // 你个哈皮，人家写了个break，你就忘了return
    }
  }
}

Flake.prototype.melt = function () {
  this.melt = false
}

Flake.prototype.isVisible = function (bx, by) {
  return (this.x > 0 && this.y > 0 && this.x < bx && this.y < by);
};

Flake.prototype.reset = function (x, y) {
  this.x = x;
  this.y = y;
  this.setSpeed();
  this.setSize();
  this.driftDirection = Math.random() > 0.5 ? 1 : -1;
  this.driftDuration = 300 + Math.random() * 1700;
}

export default Snowfall