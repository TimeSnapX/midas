// Crypto Market Scouter "Install app" support (same pattern as Shift Clock/Mythbound; classic script, loaded in <head> so beforeinstallprompt is never missed).
// - Chrome/Edge/Android: captures beforeinstallprompt and shows an in-app "Install app" button that opens the
//   native install dialog.
// - Elsewhere (or if Chrome hasn't offered the prompt yet): the button shows a manual hint instead.
// - Hidden when already running as an installed app. Touches nothing in localStorage.
(function () {
  var deferred = null;
  var HINT = 'Chrome menu \u22EE > Install app (or Add to Home screen)';
  function standalone() {
    return (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches ||
      matchMedia('(display-mode: minimal-ui)').matches)) || navigator.standalone === true;
  }
  function btns() { return document.querySelectorAll('.install-btn'); }
  function refresh() {
    var hide = standalone();
    btns().forEach(function (b) { b.classList.toggle('hidden', hide); b.classList.toggle('ready', !!deferred); });
  }
  function hint(text) {
    var el = document.getElementById('install-hint');
    if (!el) return;
    el.querySelector('.ih-text').textContent = text;
    el.classList.remove('hidden');
  }
  function install(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (deferred) {
      var ev = deferred; deferred = null;
      ev.prompt();
      (ev.userChoice || Promise.resolve({})).then(function (c) {
        if (!c || c.outcome !== 'accepted') hint('Not installed. You can install any time: ' + HINT);
        refresh();
      }).catch(refresh);
    } else {
      var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      hint(ios ? 'Safari: tap Share \u2192 Add to Home Screen' : HINT);
    }
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; refresh(); });
  window.addEventListener('appinstalled', function () {
    deferred = null; refresh();
    hint('Midas is installed \u2014 open it from your home screen.');
  });
  function wire() {
    btns().forEach(function (b) { b.addEventListener('click', install); });
    var el = document.getElementById('install-hint');
    if (el) el.querySelector('.ih-close').addEventListener('click', function () { el.classList.add('hidden'); });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.MidasInstall = { install: install, available: function () { return !!deferred; } };
})();
