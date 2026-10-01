# Snowfall.js

Snowfall.js is a little script that draws falling snow on top of a page, using a `<canvas>` and JavaScript.

## Usage

Load the ES module and create an instance after the page body and landing targets exist:

```html
<div class="snow-target">Snow can settle here.</div>

<script type="module">
  import Snowfall from './snowfall.js';

  const snowfall = new Snowfall([...document.querySelectorAll('.snow-target')]);
</script>
```

The argument is an array of elements for snow to land on. Use `new Snowfall()` for falling snow without landing targets.

Serve the project over HTTP to run the included demo:

```sh
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

## Lifecycle and layout

- `snowfall.refresh()` immediately remeasures the page and landing targets.
- `snowfall.removeAnimation()` stops the animation while retaining the overlay and its resources.
- `snowfall.destroy()` stops the animation and removes the overlay, listeners, and observers. Repeated calls are safe.

Layout measurements refresh automatically on window resize, relevant DOM changes, observed element size changes, and scrolling, including for sticky or fixed landing targets. Call `refresh()` as needed during CSS transforms or animations that require continuous tracking. Changes to landing target geometry clear accumulated snow so old piles do not float in place; unchanged measurements and ordinary page scrolling preserve it.

The canvas covers the viewport and uses document coordinates for the snow simulation. Positioned page bodies are supported, and Snowfall does not change the page's overflow styles.

Inspired by [Gargron/Snowfall](https://github.com/Gargron/Snowfall).
