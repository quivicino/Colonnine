/*
 * Colonnine – logica pura (nessun accesso a DOM o rete).
 * Funziona sia nel browser (window.DL) sia in Node (module.exports) per i test.
 */
(function (root) {
  "use strict";

  const R_TERRA = 6371000;

  function distanza(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRA * Math.asin(Math.sqrt(a));
  }

  function formattaDistanza(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  // Minuti in auto, stima prudente in città (circa 30 km/h)
  function minutiInAuto(m) {
    return Math.max(1, Math.round(m / 500));
  }

  // ---------- Potenza ----------
  // Filtro in alto: tutte, lenta (corrente alternata), veloce (continua), ultraveloce (150 kW e oltre)
  const POTENZE = {
    tutte: { nome: "Tutte", breve: "tutte le potenze" },
    ac: { nome: "Lenta AC", breve: "ricarica lenta (AC)" },
    dc: { nome: "Veloce DC", breve: "ricarica veloce (DC)" },
    hpc: { nome: "Ultra 150+", breve: "ricarica ultraveloce (da 150 kW)" }
  };
  const ULTRA_KW = 150;

  // Ogni gruppo in s.e: [kW, "AC"/"DC", connettore, posti, posti guasti, prezzo €/kWh o null, fonte "P"/"O",
  //                      € di attivazione, €/minuto] (gli ultimi due solo se comunicati)
  function passaPotenza(g, filtro) {
    if (filtro === "ac") return g[1] === "AC";
    if (filtro === "dc") return g[1] === "DC";
    if (filtro === "hpc") return g[1] === "DC" && g[0] >= ULTRA_KW;
    return true;
  }

  // Prezzo in centesimi al kWh, senza decimali (0,519 → "52")
  function formattaCent(p) {
    return p == null ? "–" : String(Math.round(p * 100));
  }
  function formattaEuro(e, decimali) {
    return e.toFixed(decimali ?? 2).replace(".", ",");
  }
  function formattaKw(kw) {
    if (!kw) return "? kW";
    return (Number.isInteger(kw) ? String(kw) : kw.toFixed(1).replace(".", ",")) + " kW";
  }

  /**
   * Colonnine entro il raggio che hanno almeno un posto della potenza scelta, con distanza,
   * posti, potenza massima e prezzo più basso tra i posti della potenza scelta.
   * Fascia di prezzo rispetto alle altre colonnine in zona:
   *   "economico" il terzo più basso, "caro" il terzo più alto, "medio" il resto, "nd" senza prezzo.
   */
  function preparaColonnine(lista, lat, lon, raggio, filtro) {
    const out = [];
    for (const s of lista || []) {
      const dist = distanza(lat, lon, s.la, s.lo);
      if (dist > raggio) continue;
      const c = riassumi(s, filtro, dist);
      if (c) out.push(c);
    }
    classifica(out);
    return out;
  }

  // Posti, potenza massima e prezzo più basso della colonnina per la potenza scelta (null se non ne ha)
  function riassumi(s, filtro, dist) {
    const gruppi = (s.e || []).filter((g) => passaPotenza(g, filtro));
    if (!gruppi.length) return null;
    let posti = 0, guasti = 0, kw = 0, prezzo = null, fonte = null, attivazione = null, minuto = null;
    for (const g of gruppi) {
      posti += g[3];
      guasti += g[4];
      kw = Math.max(kw, g[0] || 0);
      if (g[5] != null && (prezzo == null || g[5] < prezzo)) { prezzo = g[5]; fonte = g[6]; attivazione = g[7] ?? null; minuto = g[8] ?? null; }
    }
    return { ...s, id: "c/" + s.i, distanza: dist, gruppi, posti, guasti, kw, prezzo, fontePrezzo: fonte, attivazione, minuto, fascia: "nd" };
  }

  // Giorni passati da una data ISO (null se manca)
  function giorniDa(data, oggi) {
    if (!data) return null;
    const t = Date.parse(data);
    if (isNaN(t)) return null;
    return Math.floor(((oggi || Date.now()) - t) / 86400000);
  }
  // Prezzo più vecchio di "giorni" (default 10): va sempre in fondo alle classifiche
  function inFondo(d, giorni, oggi) {
    const g = giorniDa(d.dataPrezzo, oggi);
    return g != null && g > (giorni == null ? 10 : giorni);
  }

  function classifica(lista, giorni) {
    for (const d of lista) d.fascia = "nd";
    // Le fasce si calcolano sui prezzi recenti; quelli vecchi non spostano le soglie
    const tutti = lista.filter((d) => d.prezzo != null);
    const recenti = tutti.filter((d) => !inFondo(d, giorni));
    const con = (recenti.length ? recenti : tutti).slice().sort((a, b) => a.prezzo - b.prezzo);
    const n = con.length;
    if (!n) return lista;
    const min = con[0].prezzo, max = con[n - 1].prezzo;
    // Soglie a un terzo e due terzi della classifica; a parità di prezzo stessa fascia
    const soglia1 = con[Math.floor((n - 1) / 3)].prezzo;
    const soglia2 = con[Math.ceil(2 * (n - 1) / 3)].prezzo;
    for (const d of tutti) {
      if (max - min < 0.005) d.fascia = d.prezzo <= min + 0.005 ? "economico" : "caro"; // tutti uguali (al centesimo)
      else if (d.prezzo <= soglia1) d.fascia = "economico";
      else if (d.prezzo >= soglia2 && d.prezzo > soglia1) d.fascia = "caro";
      else d.fascia = "medio";
    }
    return lista;
  }

  function statistiche(lista) {
    const prezzi = lista.filter((d) => d.prezzo != null).map((d) => d.prezzo);
    return {
      min: prezzi.length ? Math.min(...prezzi) : null,
      media: prezzi.length ? prezzi.reduce((s, p) => s + p, 0) / prezzi.length : null,
      nPrezzi: prezzi.length,
      n: lista.length,
      posti: lista.reduce((s, d) => s + d.posti, 0)
    };
  }

  // Tessere (file del sito) che coprono il cerchio di ricerca
  function tessereNelRaggio(lat, lon, raggio, passo) {
    const dLat = raggio / 111320, dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    const nomi = [];
    for (let i = Math.floor((lat - dLat) / passo); i <= Math.floor((lat + dLat) / passo); i++) {
      for (let j = Math.floor((lon - dLon) / passo); j <= Math.floor((lon + dLon) / passo); j++) {
        nomi.push(`t_${i}_${j}.json`);
      }
    }
    return nomi;
  }

  function titolo(s) {
    return (s.o || "").trim() || "Colonnina";
  }
  function capitalizza(s) {
    s = String(s || "").trim();
    if (s && s === s.toUpperCase()) {
      const minuscole = /^(di|de|del|dei|degli|della|delle|dello|da|dal|dalla|al|alla|e|ed|in|sul|sulla|per)$/;
      return s.toLowerCase().replace(/(^|[\s'’.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase())
        .replace(/(\s)([A-ZÀ-Ù][a-zà-ù]*)(?=\s)/g, (m, sp, w) => minuscole.test(w.toLowerCase()) ? sp + w.toLowerCase() : m);
    }
    return s;
  }
  function indirizzo(s) {
    return [capitalizza(s.a || ""), capitalizza(s.c || "")].filter((x) => x.trim()).join(", ");
  }
  function testoPosti(n) {
    return n === 1 ? "1 posto" : n + " posti";
  }

  // ---------- Percorso ----------
  // Il percorso è una linea di punti [lat, lon]. Per trovare in fretta le colonnine vicini alla strada
  // ogni tratto viene messo in una griglia di celle da 0,02 gradi (circa 2 km).
  const CELLA = 0.02;
  function indicizzaPercorso(punti) {
    const cum = [0];
    for (let i = 1; i < punti.length; i++) {
      cum.push(cum[i - 1] + distanza(punti[i - 1][0], punti[i - 1][1], punti[i][0], punti[i][1]));
    }
    const griglia = new Map();
    for (let i = 0; i < punti.length - 1; i++) {
      const [a0, b0] = punti[i], [a1, b1] = punti[i + 1];
      for (let r = Math.floor(Math.min(a0, a1) / CELLA); r <= Math.floor(Math.max(a0, a1) / CELLA); r++) {
        for (let c = Math.floor(Math.min(b0, b1) / CELLA); c <= Math.floor(Math.max(b0, b1) / CELLA); c++) {
          const k = r + "_" + c;
          if (!griglia.has(k)) griglia.set(k, []);
          griglia.get(k).push(i);
        }
      }
    }
    return { punti, cum, griglia, lunghezza: cum[cum.length - 1] || 0 };
  }

  // Distanza del punto dalla strada e a che punto del percorso si trova (metri dalla partenza).
  // null se è più lontano di "max" metri.
  function vicinoAlPercorso(perc, lat, lon, max) {
    const kLat = 111320, kLon = 111320 * Math.cos(lat * Math.PI / 180);
    const dLat = max / kLat, dLon = max / kLon;
    const visti = new Set();
    let best = null;
    for (let r = Math.floor((lat - dLat) / CELLA); r <= Math.floor((lat + dLat) / CELLA); r++) {
      for (let c = Math.floor((lon - dLon) / CELLA); c <= Math.floor((lon + dLon) / CELLA); c++) {
        for (const i of perc.griglia.get(r + "_" + c) || []) {
          if (visti.has(i)) continue;
          visti.add(i);
          const [a0, b0] = perc.punti[i], [a1, b1] = perc.punti[i + 1];
          // coordinate piane in metri attorno alla colonnina
          const x0 = (b0 - lon) * kLon, y0 = (a0 - lat) * kLat;
          const x1 = (b1 - lon) * kLon, y1 = (a1 - lat) * kLat;
          const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
          let t = l2 ? -(x0 * dx + y0 * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(x0 + t * dx, y0 + t * dy);
          if (d <= max && (!best || d < best.dist)) {
            best = { dist: d, lungo: perc.cum[i] + t * (perc.cum[i + 1] - perc.cum[i]) };
          }
        }
      }
    }
    return best;
  }

  // Tessere del sito che coprono la striscia larga "fascia" metri attorno al percorso
  function tesserePercorso(punti, fascia, passo) {
    // Un controllo ogni ~1 km lungo la strada, allargato di 1 km: copre anche lo spazio tra due controlli
    const nomi = new Set();
    const aggiungi = (lat, lon) => tessereNelRaggio(lat, lon, fascia + 1000, passo).forEach((t) => nomi.add(t));
    if (punti.length) aggiungi(punti[0][0], punti[0][1]);
    let resto = 0;   // metri fatti dall'ultimo controllo
    for (let i = 1; i < punti.length; i++) {
      const [a0, b0] = punti[i - 1], [a1, b1] = punti[i];
      const l = distanza(a0, b0, a1, b1);
      let s = 1000 - resto;
      while (s <= l) {
        const t = s / l;
        aggiungi(a0 + t * (a1 - a0), b0 + t * (b1 - b0));
        s += 1000;
      }
      resto = l - (s - 1000);
    }
    if (punti.length > 1) aggiungi(punti[punti.length - 1][0], punti[punti.length - 1][1]);
    return [...nomi];
  }

  // Colonnine entro "fascia" metri dalla strada con la potenza scelta. "distanza" = quanto sono lontane
  // dalla strada, "km" = a che chilometro del percorso si trovano.
  function preparaPercorso(lista, perc, fascia, filtro) {
    const out = [];
    const viste = new Set();
    for (const s of lista || []) {
      if (viste.has(s.i)) continue;
      const v = vicinoAlPercorso(perc, s.la, s.lo, fascia);
      if (!v) continue;
      const c = riassumi(s, filtro, v.dist);
      if (!c) continue;
      viste.add(s.i);
      c.km = v.lungo / 1000;
      out.push(c);
    }
    classifica(out);
    return out;
  }

  function formattaDurata(sec) {
    const min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return min + " min";
    const h = Math.floor(min / 60), m = min % 60;
    return h + " h" + (m ? " " + m + " min" : "");
  }

  const API = {
    distanza, formattaDistanza, minutiInAuto, POTENZE, ULTRA_KW, passaPotenza, formattaCent, formattaEuro, formattaKw,
    preparaColonnine, classifica, giorniDa, inFondo, statistiche, tessereNelRaggio, titolo, capitalizza, indirizzo, testoPosti,
    indicizzaPercorso, vicinoAlPercorso, tesserePercorso, preparaPercorso, formattaDurata
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.DL = API;
})(typeof window !== "undefined" ? window : globalThis);
