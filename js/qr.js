/* QR -> inline SVG string (uses vendored qrcode-generator, works offline) */
window.BSB = window.BSB || {};
(function (B) {
  B.qrSvg = function (text, opts) {
    opts = opts || {};
    if (typeof qrcode !== 'function') return '';
    var q = qrcode(0, opts.ecc || 'M');
    q.addData(text); q.make();
    var n = q.getModuleCount(), m = opts.margin == null ? 2 : opts.margin, size = n + m * 2, d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (q.isDark(r, c)) {
          var s = c; while (c + 1 < n && q.isDark(r, c + 1)) c++;
          d += 'M' + (s + m) + ' ' + (r + m) + 'h' + (c - s + 1) + 'v1h-' + (c - s + 1) + 'z';
        }
      }
    }
    return '<svg class="qr" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + (opts.bg || '#fff') + '"/><path d="' + d + '" fill="' + (opts.fg || '#1d1a17') + '"/></svg>';
  };
})(window.BSB);
