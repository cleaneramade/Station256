/* After Ctrl+R (reloadWindow in app.js), the new page takes over from the old one with no seam.
   This runs before anything is drawn, so the very first picture already has the window where it
   was, the same size, with its loading screen in. window-motion.js then leaves out the opening
   motion, and the loading screen doesn't come in a second time. app.js reads the same note. */
(function again() {
  let note = null;
  try {
    note = JSON.parse(sessionStorage.getItem('house-ctrl-r') || 'null');
  } catch {
    note = null;
  }
  const sides = ['left', 'top', 'width', 'height'];
  const fine = (value) => typeof value === 'string' && value.length < 40 && /^-?[0-9.e+-]+%$/.test(value);
  if (!note || typeof note !== 'object' || !note.box || !sides.every((side) => fine(note.box[side]))) return;
  const root = document.documentElement;
  sides.forEach((side) => root.style.setProperty(`--again-${side}`, note.box[side]));
  // The ring turns with the clock, so it carries on from where the old page had it.
  root.style.setProperty('--spin-phase', `-${Date.now() % 1200}ms`);
  root.classList.add('again', 'ready');
  if (note.maximized === true) root.classList.add('maximized');
}());
