/* Fuzzy search over name / brand / keywords / category (Indonesian + English synonyms) */
window.BSB = window.BSB || {};
(function (B) {
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  B.norm = norm;

  // extra synonyms per category (Indonesian everyday words)
  var CAT_SYN = {
    'food-beverage': 'makan makanan minum minuman kuliner resto restoran restaurant food drink cafe kafe kopi coffee jajan snack lapar',
    'fashion': 'fashion baju pakaian busana sepatu tas aksesoris jam perhiasan clothes shoes bag',
    'beauty-health': 'kecantikan kosmetik skincare salon spa klinik kesehatan apotek obat beauty health',
    'electronics': 'elektronik gadget hp handphone ponsel laptop komputer kamera phone',
    'kids-family': 'anak anak2 mainan bayi keluarga kids toys playground family',
    'entertainment': 'hiburan bioskop film nonton karaoke main game permainan movie cinema',
    'department-store': 'supermarket swalayan belanja bulanan department store hypermarket grocery',
    'services': 'hotel travel tiket layanan jasa service'
  };

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i]; var best = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  function Search(D) {
    this.items = D.tenants.map(function (t) {
      var cat = D.catById[t.category] || {};
      var nameN = norm(t.name), brandN = norm(t.brand || t.name);
      var kw = norm((t.keywords || []).join(' ') + ' ' + (CAT_SYN[t.category] || '') + ' ' + (cat.name || ''));
      return { t: t, name: nameN, brand: brandN, nameWords: (nameN + ' ' + brandN).split(' '),
        nameJoined: nameN.replace(/ /g, ''), kwWords: kw.split(' ') };
    });
  }

  Search.prototype.query = function (q) {
    var tokens = norm(q).split(' ').filter(Boolean);
    if (!tokens.length) return [];
    var joined = tokens.join('');
    var out = [];
    this.items.forEach(function (it) {
      var total = 0;
      // whole-string matches on name (handles "hm" -> "h and m", "mrdiy")
      if (it.nameJoined.indexOf(joined) === 0) total += 120;
      else if (joined.length >= 2 && it.nameJoined.indexOf(joined) > 0) total += 60;
      for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i], s = 0;
        for (var w = 0; w < it.nameWords.length; w++) {
          var nw = it.nameWords[w];
          if (nw === tk) s = Math.max(s, 100);
          else if (nw.indexOf(tk) === 0) s = Math.max(s, 80);
          else if (tk.length >= 3 && nw.indexOf(tk) > 0) s = Math.max(s, 45);
          else if (tk.length >= 4 && lev(tk, nw.slice(0, tk.length + 1), tk.length >= 7 ? 2 : 1) <= (tk.length >= 7 ? 2 : 1)) s = Math.max(s, 35);
        }
        for (w = 0; w < it.kwWords.length && s < 50; w++) {
          var kw = it.kwWords[w];
          if (kw === tk) s = Math.max(s, 50);
          else if (tk.length >= 3 && kw.indexOf(tk) === 0) s = Math.max(s, 40);
          else if (tk.length >= 5 && lev(tk, kw, 1) <= 1) s = Math.max(s, 25);
        }
        if (!s && total < 60) return; // every token must match something
        total += s;
      }
      out.push({ t: it.t, score: total });
    });
    out.sort(function (a, b) { return b.score - a.score || a.t.name.localeCompare(b.t.name); });
    return out.map(function (o) { return o.t; });
  };

  B.Search = Search;
})(window.BSB);
