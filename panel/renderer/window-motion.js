/* The app's window lives inside a fixed, see-through Linux surface that never resizes.
   A real resize through the Linux display link always flickers, so all motion happens in the page.

   Maximize and restore use FLIP, the way desktop compositors do: lay out once at the final size,
   then glide with a transform, so nothing has to be laid out again during the motion. Positions are
   percentages of the surface, so a change of zoom can't move or resize the window. */
(function stationWindow() {
  const root = document.documentElement;
  const app = document.querySelector('.app');
  const MIN = { w: 560, h: 360 }; // in the app's own units, so it grows with zoom
  const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'; // a long, even slowdown
  const GLIDE_MS = 340;
  const ZOOM_MS = 140;

  let zoom = 1;
  let rect = { x: 100, y: 60, w: 1000, h: 640 }; // the window's normal size, in screen pixels
  let maximized = false;
  let snapRestore = null; // size to go back to after being snapped to half the screen
  let neighbors = {}; // which of this window's edges has a Windows app right beside it
  let seams = [];
  let resizing = false; // a seam can't be rebuilt while it's being held
  let minimized = false;
  let minimizeFade = null;
  let run = null;
  let started = false;
  let lastDragEnd = 0;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const surface = () => ({ x: 0, y: 0, w: window.outerWidth, h: window.outerHeight });
  const currentBox = () => (maximized ? surface() : rect);
  const percent = (value, whole) => `${(value / whole) * 100}%`;
  const minWidth = () => Math.min(surface().w, Math.ceil(MIN.w * zoom));
  const minHeight = () => Math.min(surface().h, Math.ceil(MIN.h * zoom));

  // Grows a box that's too small for the current zoom. Whichever way it grew, it stays on screen.
  function fitted(box) {
    const area = surface();
    const next = { ...box };
    if (box.w < minWidth()) {
      next.w = minWidth();
      next.x = Math.max(0, Math.min(box.x, area.w - next.w));
    }
    if (box.h < minHeight()) {
      next.h = minHeight();
      next.y = Math.max(0, Math.min(box.y, area.h - next.h));
    }
    return next;
  }

  function setIcon(el, name) {
    el.dataset.i = name;
    el.style.maskImage = `url("icons/${name}.svg")`;
  }

  function apply(box) {
    const area = surface();
    app.style.left = percent(box.x, area.w);
    app.style.top = percent(box.y, area.h);
    app.style.width = percent(box.w, area.w);
    app.style.height = percent(box.h, area.h);
  }

  // Tells the main process where the window is, and keeps dialogs centered on it.
  function report() {
    const box = currentBox();
    const area = surface();
    const dialog = document.getElementById('dialog');
    if (dialog) {
      dialog.style.setProperty('--center-x', percent(box.x + box.w / 2, area.w));
      dialog.style.setProperty('--center-y', percent(box.y + box.h / 2, area.h));
    }
    // What gets remembered is its normal size, not a snapped spot, as with any Windows app.
    window.house.call('windowRect', box, snapRestore ? { ...rect, ...snapRestore } : rect, maximized);
    const dragging = root.classList.contains('dragging');
    window.house.call('snapWatch', maximized || dragging ? null : box);
    if (maximized || dragging) {
      neighbors = {};
      clearSeams();
    } else {
      layoutSeams();
    }
  }

  function setMaximized(value) {
    maximized = value;
    root.classList.toggle('maximized', value);
    const button = document.getElementById('win-max');
    setIcon(document.getElementById('win-max-icon'), value ? 'square_multiple' : 'maximize');
    button.title = value ? 'Restore' : 'Maximize';
  }

  // Applies at most once per frame.
  let pending = null;
  function schedule(box) {
    if (pending === null) {
      requestAnimationFrame(() => {
        const next = pending;
        pending = null;
        if (next) apply(next);
      });
    }
    pending = box;
  }

  function moveWindow(box, ms = GLIDE_MS) {
    pending = null; // a drag frame still waiting must not undo this move
    const from = app.getBoundingClientRect(); // includes a glide in progress, so interrupting is smooth
    if (run) run.cancel();
    apply(box);
    root.classList.add('gliding');
    const to = { x: box.x / zoom, y: box.y / zoom, w: box.w / zoom, h: box.h / zoom };
    const glide = app.animate([
      { transform: `translate(${from.left - to.x}px, ${from.top - to.y}px) scale(${from.width / to.w}, ${from.height / to.h})` },
      { transform: 'none' },
    ], { duration: ms, easing: EASE });
    run = glide;
    glide.finished.then(() => {
      if (run !== glide) return;
      run = null;
      root.classList.remove('gliding');
      report();
    }, () => {});
  }

  function toggleMaximize() {
    snapRestore = null;
    setMaximized(!maximized);
    moveWindow(currentBox());
  }

  function minimize() {
    const fade = app.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'translate(6%, 12%) scale(0.88)', opacity: 0 }],
      { duration: 150, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    );
    minimizeFade = fade;
    fade.finished.then(() => {
      minimized = true;
      window.house.call('windowMinimize');
      // Stays faded until it comes back. The timer means it can never stay invisible.
      setTimeout(() => {
        if (minimizeFade === fade) {
          fade.cancel();
          minimizeFade = null;
        }
      }, 5000);
    }, () => {});
  }

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    // The page may need to check first, such as when terminals are still running.
    const ask = window.houseFrame.beforeClose;
    if (ask && !await ask().catch(() => true)) {
      closing = false;
      return;
    }
    // No close animation: main hides the window at once. A shrinking one looks choppy over WSLg.
    window.house.call('windowClose');
  }

  window.house.on('window:close-request', close);

  // A window made from a tab only fades in: the tab's picture has already grown into its shape
  // right there (app.js), so moving as well would show two windows for a moment.
  const fromTab = new URLSearchParams(window.location.search).has('tab');
  function reveal() {
    // After Ctrl+R it's on screen already, just as it was (again.js), so it doesn't open again.
    const again = root.classList.contains('again');
    root.classList.add('ready');
    if (again) return;
    app.animate(
      fromTab
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ transform: 'translate(2%, 2%) scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: fromTab ? 160 : 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }

  window.addEventListener('focus', () => {
    if (!minimized) return;
    minimized = false;
    if (minimizeFade) {
      minimizeFade.cancel();
      minimizeFade = null;
    }
    app.animate(
      [{ transform: 'translate(4%, 8%) scale(0.92)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  });

  /* While a mouse button is held and moving, a nearly invisible layer keeps the pointer on this
     surface, even if it moves past the window's edge onto something behind it. */
  const capture = (on) => root.classList.toggle('capturing', on);

  // Follows one press until it ends, however it ends, so nothing can get stuck on.
  function track(el, event, { begin, move, end }) {
    el.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let done = false;
    const finish = (last, cancelled) => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      capture(false);
      if (end) end(last, moved, cancelled);
    };
    function onUp(up) { finish(up, false); }
    function onCancel(cancel) { finish(cancel, true); }
    function onMove(current) {
      if (current.buttons === 0) {
        finish(current, true);
        return;
      }
      if (!moved) {
        if (Math.abs(current.clientX - startX) + Math.abs(current.clientY - startY) < 4) return;
        moved = true;
        capture(true);
        if (begin) begin(current);
      }
      if (move) move(current);
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('blur', onCancel);
    // If the thing being dragged is removed mid-drag, only the window still hears the release.
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /* Top bar: drag to move, double-click to maximize or restore. */
  const strip = document.querySelector('.tabstrip');
  // A window's only tab moves the window too, as a lone tab does in Chrome. With more than one,
  // dragging a tab moves the tab instead (see the page's tabs).
  const loneTab = (target) => Boolean(target.closest('.tab')) && strip.querySelectorAll('.tab').length === 1;
  const isBarArea = (target) => !target.closest('button, .window-controls, input') && (!target.closest('.tab') || loneTab(target));

  function clamped(next) {
    const area = surface();
    return {
      ...next,
      x: Math.round(Math.min(Math.max(next.x, 100 - next.w), area.w - 100)),
      y: Math.round(Math.min(Math.max(next.y, 0), area.h - 40)),
    };
  }

  /* Snap layouts. Windows can't show its own panel for this window, because to Windows this is one
     fixed full-screen surface. So this follows Windows 11's, measured from it on this PC: the same
     layouts, a sliver peeking at the top while you drag, opening when the pointer reaches the top,
     a suggested pair first, and previews at the screen's edges and corners. Sizes in the styles are
     in screen pixels, so they don't change with the app's zoom. Each zone is
     [left, top, width, height] as fractions of the screen. */
  const HALVES = [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]];
  const QUARTERS = [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
  const SNAP_LAYOUTS = [
    HALVES,
    [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1]],
    [[0, 0, 0.5, 1], QUARTERS[1], QUARTERS[3]],
    QUARTERS,
  ];
  const TILE = { w: 122, h: 79, gap: 6 };
  const OPEN_WITHIN = 15; // how near the top the pointer must get, before the panel opens
  const STAYS_OPEN_WITHIN = 200; // once open, how far back down it can come
  const SIDE_REACH = 260; // how far past the panel's sides the pointer can be
  const CORNER = 150; // how far along a screen edge counts as its corner
  let snapBar = null;
  let snapPreview = null;
  let snapTarget = null;
  let assist = null;
  let flyoutTimer = null;

  function zoneBox([left, top, width, height]) {
    const area = surface();
    const x = Math.round(left * area.w);
    const y = Math.round(top * area.h);
    return { x, y, w: Math.round((left + width) * area.w) - x, h: Math.round((top + height) * area.h) - y };
  }

  // Layouts too small for the window at this zoom are left out, as Windows does.
  const fits = (zones) => zones.map(zoneBox).every((box) => box.w >= minWidth() && box.h >= minHeight());

  function setSnapAccent(color) {
    if (color) root.style.setProperty('--snap-accent', color);
  }

  // A tile's position inside its group, with the gap between neighbours.
  function placeCell(cell, [left, top, width, height]) {
    const half = TILE.gap / 2;
    const x0 = left * TILE.w + (left > 0 ? half : 0);
    const y0 = top * TILE.h + (top > 0 ? half : 0);
    const x1 = (left + width) * TILE.w - (left + width < 1 ? half : 0);
    const y1 = (top + height) * TILE.h - (top + height < 1 ? half : 0);
    cell.style.left = `${x0}px`;
    cell.style.top = `${y0}px`;
    cell.style.width = `${x1 - x0}px`;
    cell.style.height = `${y1 - y0}px`;
  }

  function buildSnapBar(partner) {
    if (snapBar) snapBar.remove();
    snapBar = document.createElement('div');
    snapBar.className = 'snap-bar';
    snapBar.style.zoom = 1 / zoom;
    const addGroup = (zones, target, className) => {
      const group = document.createElement('div');
      group.className = `snap-group ${className}`;
      zones.forEach((zone, index) => {
        const cell = document.createElement('div');
        cell.className = 'snap-cell';
        cell.target = target(zone);
        placeCell(cell, zone);
        if (partner && className === 'snap-suggest' && index === 1) {
          cell.classList.add('partner');
          if (partner.Icon) {
            const image = document.createElement('img');
            image.src = `data:image/png;base64,${partner.Icon}`;
            image.alt = '';
            cell.append(image);
          }
        }
        group.append(cell);
      });
      snapBar.append(group);
    };
    // First comes a suggested pair: this window on the left, your last used app on the right.
    if (partner && fits(HALVES)) addGroup(HALVES, () => ({ zone: HALVES[0], zones: HALVES, partner, partnerZone: HALVES[1] }), 'snap-suggest');
    SNAP_LAYOUTS.filter(fits).forEach((zones) => addGroup(zones, (zone) => ({ zone, zones }), ''));
    if (!snapBar.children.length) {
      snapBar.remove();
      snapBar = null;
      return false;
    }
    if (!snapPreview) {
      snapPreview = document.createElement('div');
      snapPreview.className = 'snap-preview';
      snapPreview.hidden = true;
      document.body.append(snapPreview);
    }
    document.body.append(snapBar);
    return true;
  }

  let previewTimer = null;
  let pointerNow = { x: 0, y: 0 };

  function showPreview(box) {
    if (!snapPreview) return;
    clearTimeout(previewTimer);
    if (!box) {
      snapPreview.classList.remove('shown');
      previewTimer = setTimeout(() => { snapPreview.hidden = true; }, 150);
      return;
    }
    if (snapPreview.hidden || !snapPreview.classList.contains('shown')) {
      snapPreview.classList.add('still');
      snapPreview.hidden = false;
      snapPreview.style.left = `${pointerNow.x / zoom - 40}px`;
      snapPreview.style.top = `${pointerNow.y / zoom - 40}px`;
      snapPreview.style.width = '80px';
      snapPreview.style.height = '80px';
      void snapPreview.offsetWidth; // the starting point has to land before it can grow from it
      snapPreview.classList.remove('still');
      snapPreview.classList.add('shown');
    }
    snapPreview.style.left = `${box.x / zoom}px`;
    snapPreview.style.top = `${box.y / zoom}px`;
    snapPreview.style.width = `${box.w / zoom}px`;
    snapPreview.style.height = `${box.h / zoom}px`;
  }

  function closeSnapBar() {
    clearTimeout(flyoutTimer);
    if (snapBar) snapBar.remove();
    snapBar = null;
    showPreview(null);
    snapTarget = null;
  }

  function highlight(cell) {
    if (!snapBar) return;
    const suggested = cell && cell.parentElement.classList.contains('snap-suggest');
    for (const other of snapBar.querySelectorAll('.snap-cell')) {
      other.classList.toggle('on', other === cell || Boolean(suggested && other.parentElement === cell.parentElement));
    }
  }

  function cellAt(clientX, clientY) {
    if (!snapBar) return null;
    const reach = (TILE.gap / 2) / zoom; // the gaps between tiles count too, as in Windows
    for (const cell of snapBar.querySelectorAll('.snap-cell')) {
      const box = cell.getBoundingClientRect();
      if (clientX >= box.left - reach && clientX < box.right + reach && clientY >= box.top - reach && clientY < box.bottom + reach) return cell;
    }
    return null;
  }

  // A window dragged onto a screen edge or corner.
  function edgeTarget(x, y) {
    const area = surface();
    const onLeft = x <= 1;
    const onRight = x >= area.w - 2;
    if (onLeft || onRight) {
      if (y <= CORNER) return { zone: QUARTERS[onLeft ? 0 : 1], zones: QUARTERS };
      if (y >= area.h - CORNER) return { zone: QUARTERS[onLeft ? 2 : 3], zones: QUARTERS };
      return { zone: HALVES[onLeft ? 0 : 1], zones: HALVES };
    }
    return y <= 1 ? { maximize: true } : null;
  }

  function startDragSnap() {
    if (!buildSnapBar(null)) return;
    snapBar.classList.add('peek');
    // The suggestion needs to know your other windows. It joins the panel as soon as that's known.
    window.house.call('windowsList', false).then((reply) => {
      setSnapAccent(reply.Accent);
      const [partner] = reply.Windows;
      if (!partner || !snapBar || !root.classList.contains('dragging') || snapBar.classList.contains('open')) return;
      if (buildSnapBar(partner)) snapBar.classList.add('peek');
    }).catch(() => {});
  }

  function followDragSnap(clientX, clientY) {
    const x = clientX * zoom;
    const y = clientY * zoom;
    pointerNow = { x, y };
    const area = surface();
    let cell = null;
    if (snapBar) {
      const width = snapBar.getBoundingClientRect().width * zoom;
      const nearSides = Math.abs(x - area.w / 2) <= width / 2 + SIDE_REACH;
      const isOpen = snapBar.classList.contains('open');
      const open = nearSides && y <= (isOpen ? STAYS_OPEN_WITHIN : OPEN_WITHIN);
      snapBar.classList.toggle('open', open);
      snapBar.classList.toggle('peek', !open);
      if (open) cell = cellAt(clientX, clientY);
      highlight(cell);
    }
    snapTarget = cell ? cell.target : edgeTarget(x, y);
    if (!snapTarget) showPreview(null);
    else showPreview(snapTarget.maximize ? surface() : zoneBox(snapTarget.zone));
  }

  // Puts this window where a layout, edge or corner says, then offers your apps for what's left empty.
  function placeIn(target) {
    if (target.maximize) {
      setMaximized(true);
      moveWindow(surface());
      return;
    }
    if (!snapRestore) snapRestore = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    setMaximized(false);
    rect = fitted(zoneBox(target.zone));
    moveWindow(rect);
    if (target.partner) {
      window.house.call('windowsPlace', target.partner.Id, zoneBox(target.partnerZone));
      return; // a suggested pair fills the whole screen, so there's nothing left to offer
    }
    offerWindows(target.zones, target.zone);
  }

  /* The panel that opens when you rest on the maximize button, as in Windows 11. */
  const maximizeButton = document.getElementById('win-max');

  function showFlyout() {
    if (root.classList.contains('dragging') || !buildSnapBar(null)) return;
    snapBar.classList.add('flyout');
    const button = maximizeButton.getBoundingClientRect();
    const width = snapBar.getBoundingClientRect().width * zoom;
    const left = Math.max(8, Math.min(button.right * zoom - width, surface().w - width - 8));
    snapBar.style.left = `${left}px`;
    snapBar.style.top = `${button.bottom * zoom + 8}px`;
    snapBar.addEventListener('pointerenter', () => clearTimeout(flyoutTimer));
    snapBar.addEventListener('pointerleave', closeFlyoutSoon);
    snapBar.addEventListener('pointermove', (event) => {
      const cell = cellAt(event.clientX, event.clientY);
      highlight(cell);
      showPreview(cell ? zoneBox(cell.target.zone) : null);
    });
    snapBar.addEventListener('click', (event) => {
      const cell = cellAt(event.clientX, event.clientY);
      if (!cell) return;
      const { target } = cell;
      closeSnapBar();
      placeIn(target);
    });
  }

  function closeFlyoutSoon() {
    clearTimeout(flyoutTimer);
    flyoutTimer = setTimeout(() => {
      if (snapBar && snapBar.classList.contains('flyout')) closeSnapBar();
    }, 250);
  }

  maximizeButton.addEventListener('pointerenter', () => {
    clearTimeout(flyoutTimer);
    if (snapBar && snapBar.classList.contains('flyout')) return;
    flyoutTimer = setTimeout(showFlyout, 450);
  });
  maximizeButton.addEventListener('pointerleave', closeFlyoutSoon);
  maximizeButton.addEventListener('click', () => {
    clearTimeout(flyoutTimer);
    if (snapBar && snapBar.classList.contains('flyout')) closeSnapBar();
  });

  /* The other half of snapping: once this window takes a spot, the empty spots offer your open
     Windows apps, the way Windows does. The Windows helper supplies them and moves the one you pick.
     Without the helper, there's simply no offer. */
  function closeAssist() {
    if (assist) assist.remove();
    assist = null;
  }

  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  // An app already filling a spot: lined up with at least three of its sides, covering most of it,
  // and staying out of this window's own spot. So a neighbor whose shared seam was moved counts, but
  // a maximized app that just happens to be behind doesn't.
  function fills(item, zone, mine) {
    const spot = zoneBox(zone);
    const box = { x: item.X, y: item.Y, w: item.W, h: item.H };
    const gaps = [box.x - spot.x, box.y - spot.y, box.x + box.w - spot.x - spot.w, box.y + box.h - spot.y - spot.h];
    return gaps.filter((gap) => Math.abs(gap) <= 12).length >= 3
      && overlap(box, spot) >= (spot.w * spot.h) / 2
      && overlap(box, mine) <= (mine.w * mine.h) / 10;
  }

  // Offers apps only for spots that are really empty, and never an app that already has a spot.
  function offerFor(spots, windows, mine) {
    const taken = spots.filter((zone) => windows.some((item) => fills(item, zone, mine)));
    const empty = spots.filter((zone) => !taken.includes(zone));
    const free = windows.filter((item) => !taken.some((zone) => fills(item, zone, mine)));
    if (empty.length && free.length) showAssist(empty, free);
  }

  async function offerWindows(zones, mine) {
    closeAssist();
    const others = zones.filter((zone) => zone !== mine);
    if (!others.length) return;
    const reply = await window.house.call('windowsList', true).catch(() => ({ Windows: [] }));
    setSnapAccent(reply.Accent);
    offerFor(others, reply.Windows, zoneBox(mine));
  }

  function showAssist(empty, windows) {
    closeAssist();
    const [zone, ...rest] = empty;
    if (!zone || !windows.length) return;
    const box = zoneBox(zone);
    assist = document.createElement('div');
    assist.className = 'snap-assist';
    assist.style.left = `${box.x / zoom}px`;
    assist.style.top = `${box.y / zoom}px`;
    assist.style.width = `${box.w / zoom}px`;
    assist.style.height = `${box.h / zoom}px`;
    const list = document.createElement('div');
    list.className = 'snap-assist-list';
    list.style.zoom = 1 / zoom;
    windows.forEach((item) => {
      const tile = document.createElement('button');
      tile.className = 'snap-assist-tile';
      tile.type = 'button';
      const head = document.createElement('span');
      head.className = 'snap-assist-head';
      if (item.Icon) {
        const icon = document.createElement('img');
        icon.src = `data:image/png;base64,${item.Icon}`;
        icon.alt = '';
        head.append(icon);
      }
      const name = document.createElement('span');
      name.className = 'snap-assist-name';
      name.textContent = item.Title;
      head.append(name);
      const picture = document.createElement('span');
      picture.className = 'snap-assist-picture';
      if (item.Thumb || item.Icon) {
        const image = document.createElement('img');
        image.src = item.Thumb ? `data:image/jpeg;base64,${item.Thumb}` : `data:image/png;base64,${item.Icon}`;
        image.alt = '';
        if (!item.Thumb) image.className = 'only-icon';
        picture.append(image);
      }
      tile.append(head, picture);
      tile.addEventListener('click', () => {
        // The last pick gets focus, as in Windows. Before that, focus has to stay here for the offer.
        window.house.call('windowsPlace', item.Id, box, rest.length === 0);
        showAssist(rest, windows.filter((other) => other !== item));
      });
      list.append(tile);
    });
    assist.append(list);
    document.body.append(assist);
  }

  // Clicking away or pressing Esc turns the offer down, as in Windows.
  window.addEventListener('pointerdown', (event) => {
    if (assist && !event.target.closest('.snap-assist-tile')) closeAssist();
  }, true);
  window.addEventListener('blur', () => {
    closeAssist();
    if (snapBar && snapBar.classList.contains('flyout')) closeSnapBar();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAssist();
  });

  /* Win + an arrow key, following what Windows 11 does to a real window, as measured on this PC. */
  const SPOTS = {
    L: [HALVES, 0], R: [HALVES, 1], TL: [QUARTERS, 0], TR: [QUARTERS, 1], BL: [QUARTERS, 2], BR: [QUARTERS, 3],
  };
  const KEY_MOVES = {
    normal: { L: 'L', R: 'R', U: 'max', D: 'min' },
    max: { U: 'normal', D: 'normal', L: 'normal', R: 'normal' },
    L: { U: 'TL', D: 'BL', R: 'normal', L: 'R' },
    R: { U: 'TR', D: 'BR', L: 'normal', R: 'L' },
    TL: { U: 'max', D: 'L', R: 'TR', L: 'TR' },
    TR: { U: 'max', D: 'R', L: 'TL', R: 'TL' },
    BL: { U: 'L', D: 'min', R: 'BR', L: 'BR' },
    BR: { U: 'R', D: 'min', L: 'BL', R: 'BL' },
  };
  const sameBox = (a, b, slack = 4) => ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) <= slack);

  function spotNow() {
    if (maximized) return 'max';
    const name = Object.keys(SPOTS).find((spot) => sameBox(rect, zoneBox(SPOTS[spot][0][SPOTS[spot][1]]), 2));
    return name || 'normal';
  }

  function backToNormal() {
    closeAssist();
    setMaximized(false);
    if (snapRestore) rect = fitted({ ...rect, ...snapRestore });
    snapRestore = null;
    moveWindow(rect);
  }

  function applySnapKey(key) {
    const next = KEY_MOVES[spotNow()][key];
    if (next === 'min') minimize();
    else if (next === 'normal') backToNormal();
    else if (next === 'max') placeIn({ maximize: true });
    else {
      const [zones, index] = SPOTS[next];
      placeIn({ zone: zones[index], zones });
    }
  }

  // Windows' tray closes once this window is picked, since Windows can't see past it. So in a layout
  // with spots still empty, this carries on offering your apps for them.
  async function carryOnFromWindowsTray(box) {
    const matches = (zone) => sameBox(zoneBox(zone), box);
    const layouts = SNAP_LAYOUTS.filter((zones) => zones.some(matches));
    if (!layouts.length) return;
    const reply = await window.house.call('windowsList', true).catch(() => ({ Windows: [] }));
    setSnapAccent(reply.Accent);
    for (const zones of layouts) {
      const others = zones.filter((zone) => !matches(zone));
      if (others.some((zone) => reply.Windows.some((item) => fills(item, zone, box)))) {
        offerFor(others, reply.Windows, box);
        return;
      }
    }
  }

  // Windows itself put this app somewhere, such as you picking it for one side of a snap.
  function placedByWindows(place) {
    closeAssist();
    if (!snapRestore) snapRestore = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    setMaximized(false);
    rect = fitted(place);
    moveWindow(rect);
    carryOnFromWindowsTray(place);
  }

  /* The seam between this window and whatever is beside it. Grabbing it from either side resizes
     both, live, the way two snapped windows share an edge in Windows. */
  const SEAM_REACH = 6; // screen pixels each side of the line, about what Windows gives its own
  const SEAM_INSET = 8; // the ends stay free for the corner handles
  const LETTERS = { left: 'w', right: 'e', top: 'n', bottom: 's' };
  let seamLimits = {};
  let pendingSeams = null;

  function layoutSeams() {
    seams.forEach(({ el, edge }) => {
      const across = edge === 'left' || edge === 'right';
      const line = { left: rect.x, right: rect.x + rect.w, top: rect.y, bottom: rect.y + rect.h }[edge];
      el.style.left = `${(across ? line - SEAM_REACH : rect.x + SEAM_INSET) / zoom}px`;
      el.style.top = `${(across ? rect.y + SEAM_INSET : line - SEAM_REACH) / zoom}px`;
      el.style.width = `${(across ? SEAM_REACH * 2 : rect.w - SEAM_INSET * 2) / zoom}px`;
      el.style.height = `${(across ? rect.h - SEAM_INSET * 2 : SEAM_REACH * 2) / zoom}px`;
    });
  }

  function clearSeams() {
    seams.forEach(({ el }) => el.remove());
    seams = [];
  }

  function showSeams() {
    clearSeams();
    if (maximized) return;
    Object.keys(LETTERS).filter((edge) => neighbors[edge]).forEach((edge) => {
      const el = document.createElement('div');
      el.className = `snap-seam ${edge === 'left' || edge === 'right' ? 'across' : 'down'}`;
      el.addEventListener('mousedown', (event) => event.preventDefault());
      el.addEventListener('pointerdown', (event) => beginResize(el, event, LETTERS[edge]));
      document.body.append(el);
      seams.push({ el, edge });
    });
    layoutSeams();
  }

  // Sends where the dragged edges are, at most once a frame.
  function shareEdges(sides) {
    const edges = {};
    if (sides.includes('e') && neighbors.right) edges.right = rect.x + rect.w;
    if (sides.includes('w') && neighbors.left) edges.left = rect.x;
    if (sides.includes('s') && neighbors.bottom) edges.bottom = rect.y + rect.h;
    if (sides.includes('n') && neighbors.top) edges.top = rect.y;
    if (!Object.keys(edges).length) return;
    const first = !pendingSeams;
    pendingSeams = edges;
    if (first) requestAnimationFrame(sendSeams);
  }

  function sendSeams() {
    const send = pendingSeams || {};
    pendingSeams = null;
    Object.keys(send).forEach((edge) => window.house.call('snapSeam', edge, send[edge]));
  }

  // Keeps an edge from passing where something beside it can't shrink past.
  function keepWithinLimits(box) {
    const next = { ...box };
    if (seamLimits.right !== undefined && next.x + next.w > seamLimits.right) next.w = seamLimits.right - next.x;
    if (seamLimits.bottom !== undefined && next.y + next.h > seamLimits.bottom) next.h = seamLimits.bottom - next.y;
    if (seamLimits.left !== undefined && next.x < seamLimits.left) {
      next.w = next.x + next.w - seamLimits.left;
      next.x = seamLimits.left;
    }
    if (seamLimits.top !== undefined && next.y < seamLimits.top) {
      next.h = next.y + next.h - seamLimits.top;
      next.y = seamLimits.top;
    }
    return next;
  }

  // The neighbor's own edge is being dragged in Windows. This window's edge follows it.
  let followSave = null;
  function followNeighbor(edge, at) {
    const next = { ...rect };
    if (edge === 'right') next.w = Math.max(minWidth(), at - next.x);
    if (edge === 'bottom') next.h = Math.max(minHeight(), at - next.y);
    if (edge === 'left') {
      next.w = Math.max(minWidth(), next.x + next.w - at);
      next.x = rect.x + rect.w - next.w;
    }
    if (edge === 'top') {
      next.h = Math.max(minHeight(), next.y + next.h - at);
      next.y = rect.y + rect.h - next.h;
    }
    rect = next;
    schedule(rect);
    layoutSeams();
    clearTimeout(followSave);
    followSave = setTimeout(report, 250);
  }

  window.house.on('window:link', (message) => {
    if (message.type === 'key') {
      closeAssist();
      applySnapKey(message.key);
    } else if (message.type === 'place') {
      placedByWindows(message);
    } else if (message.type === 'neighbors') {
      neighbors = message;
      if (!root.classList.contains('dragging') && !resizing) showSeams();
    } else if (message.type === 'neighbor-moved') {
      followNeighbor(message.edge, message.at);
    } else if (message.type === 'seam-limit') {
      seamLimits[message.edge] = message.at;
    } else if (message.type === 'connected') {
      report(); // the helper has just (re)joined, so it needs to know where this window is
    }
  });

  // Using the window's frame shouldn't take typing focus away from a terminal.
  strip.addEventListener('mousedown', (event) => {
    if (isBarArea(event.target) || event.target.closest('.window-controls')) event.preventDefault();
  });

  let dockingNow = false;
  strip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isBarArea(event.target)) return;
    // Carried by its only tab, the window can join another window's tabs (the page decides where).
    const joining = loneTab(event.target) ? window.houseFrame.barDrag || null : null;
    const pressX = event.clientX * zoom;
    const pressY = event.clientY * zoom;
    let offsetX = 0;
    let offsetY = 0;

    track(strip, event, {
      begin() {
        closeAssist();
        clearTimeout(flyoutTimer);
        closeSnapBar();
        clearSeams();
        neighbors = {};
        window.house.call('snapWatch', null);
        root.classList.add('dragging');
        const from = app.getBoundingClientRect();
        offsetX = pressX - from.left * zoom;
        offsetY = pressY - from.top * zoom;
        if (maximized || snapRestore) {
          // Pulled away from maximized or snapped: back to normal size, under the cursor.
          const size = fitted({ x: 0, y: 0, ...(snapRestore || rect) });
          offsetX = size.w * (offsetX / (from.width * zoom));
          rect = clamped({ x: pressX - offsetX, y: pressY - offsetY, w: size.w, h: size.h });
          snapRestore = null;
          setMaximized(false);
          moveWindow(rect, 240);
        }
        startDragSnap();
      },
      move(current) {
        rect = clamped({ ...rect, x: current.clientX * zoom - offsetX, y: current.clientY * zoom - offsetY });
        schedule(rect);
        // Over a place that takes this window in (another window's tabs), snapping steps aside and
        // the window fades away, leaving its tab's picture under the pointer (app.js).
        const docking = Boolean(joining?.move(current));
        if (docking !== dockingNow) {
          dockingNow = docking;
          root.classList.toggle('docking', docking);
          if (docking) {
            closeSnapBar();
            showPreview(null);
            snapTarget = null;
          }
        }
        if (!docking) followDragSnap(current.clientX, current.clientY);
      },
      end(last, moved, cancelled) {
        const docked = dockingNow && moved && !cancelled;
        dockingNow = false;
        if (docked) {
          root.classList.remove('dragging');
          closeSnapBar();
          lastDragEnd = Date.now();
          // It stays faded while its tab joins the other window. If it didn't join after all, it
          // comes back where it ended up.
          Promise.resolve(joining.end(last)).then((joined) => {
            if (joined) return;
            root.classList.remove('docking');
            report();
          });
          return;
        }
        joining?.move(null);
        root.classList.remove('docking');
        if (moved && !cancelled) followDragSnap(last.clientX, last.clientY);
        const target = cancelled ? null : snapTarget;
        root.classList.remove('dragging');
        closeSnapBar();
        if (!moved) return;
        lastDragEnd = Date.now();
        if (target) placeIn(target);
        else report();
      },
    });
  });

  // Not on a tab, even a lone one, as in Chrome.
  strip.addEventListener('dblclick', (event) => {
    if (isBarArea(event.target) && !event.target.closest('.tab') && Date.now() - lastDragEnd > 400) toggleMaximize();
  });

  /* Edges and corners: drag to resize. This one reflows on purpose, so the content follows. A snapped
     window remembers its normal size through this, as in Windows. */
  function beginResize(el, event, sides) {
    if (event.button !== 0 || maximized) return;
    const start = { ...rect };
    const startX = event.clientX * zoom;
    const startY = event.clientY * zoom;
    seamLimits = {};
    closeAssist();
    resizing = true;
    track(el, event, {
      move(current) {
        const dx = current.clientX * zoom - startX;
        const dy = current.clientY * zoom - startY;
        const next = { ...start };
        if (sides.includes('e')) next.w = Math.round(Math.max(minWidth(), start.w + dx));
        if (sides.includes('s')) next.h = Math.round(Math.max(minHeight(), start.h + dy));
        if (sides.includes('w')) {
          next.w = Math.round(Math.max(minWidth(), start.w - dx));
          next.x = start.x + start.w - next.w;
        }
        if (sides.includes('n')) {
          next.h = Math.round(Math.max(minHeight(), start.h - dy));
          next.y = Math.max(0, start.y + start.h - next.h);
        }
        rect = keepWithinLimits(next);
        schedule(rect);
        layoutSeams();
        shareEdges(sides);
      },
      end() {
        resizing = false;
        sendSeams();
        report();
        showSeams();
      },
    });
  }

  function addHandle(sides) {
    const handle = document.createElement('div');
    handle.className = `rz rz-${sides}`;
    app.append(handle);
    handle.addEventListener('mousedown', (event) => event.preventDefault());
    handle.addEventListener('pointerdown', (event) => beginResize(handle, event, sides));
  }
  ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(addHandle);

  document.getElementById('win-min').addEventListener('click', minimize);
  document.getElementById('win-max').addEventListener('click', toggleMaximize);
  document.getElementById('win-close').addEventListener('click', close);

  /* Zoom: the new size applies at once, then the content eases into it. The change and the start
     of the easing happen in the same step, so no frame can show the new size without it. */
  window.house.on('zoom:changed', (value) => {
    if (!started || value === zoom) return;
    const showing = zoom * (Number(getComputedStyle(app).zoom) || 1);
    window.house.setZoomFactor(value);
    zoom = value;
    // Zooming in can leave the window too small for its contents, so it grows along with the zoom.
    const next = fitted(rect);
    const grew = next.w !== rect.w || next.h !== rect.h;
    rect = next;
    if (grew && !maximized) moveWindow(rect);
    app.animate([{ zoom: showing / value }, { zoom: 1 }], { duration: ZOOM_MS, easing: 'ease-out' });
    report();
  });

  // The screen itself changed size. The window is brought back on it if needed.
  window.addEventListener('resize', () => {
    if (!started) return;
    rect = fitted(clamped(rect));
    apply(currentBox());
  });

  window.house.call('windowInit').then((init) => {
    zoom = init.zoom;
    rect = fitted(clamped({ ...init.rect, w: Math.min(init.rect.w, surface().w), h: Math.min(init.rect.h, surface().h) }));
    setMaximized(Boolean(init.maximized));
    apply(currentBox());
    started = true;
    reveal();
    report();
    resolveReady();
  });

  window.houseFrame = {
    ready,
    track,
    close, // the same as the window's X: the page is asked first
    contains(clientX, clientY) {
      const box = currentBox();
      const x = clientX * zoom;
      const y = clientY * zoom;
      return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
    },
  };
}());
