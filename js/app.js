(function () {
  "use strict";

  const STORAGE_KEY = "bgteam-boutique-v1";
  const $ = (sel) => document.querySelector(sel);

  // ---------- Données ----------
  let db = load();
  let cart = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* stockage indisponible */ }
    return clone(window.SEED_DATA);
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
    catch (e) { toast("Attention : impossible d'enregistrer dans ce navigateur."); }
  }

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function num(n) { return Number(n || 0).toLocaleString("fr-FR"); }
  function money(n) { return num(n) + " " + (db.settings.devise || "FCFA"); }
  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return d + "/" + m + "/" + y;
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function productByCode(code) { return db.products.find((p) => p.code === code); }
  function ccLabel(cc) { return "CC " + String(cc).padStart(2, "0"); }

  // ---------- Calculs (équivalents des formules Excel) ----------
  function isCountedSale(s) { return s.valide === "OUI" && db.settings.ccs.includes(String(s.cc)); }

  function totalEntrees(code) {
    return db.entries.filter((e) => e.code === code && e.statut === "Validée").reduce((a, e) => a + Number(e.qte), 0);
  }
  function totalVentes(code) {
    return db.sales.filter((s) => s.code === code && isCountedSale(s)).reduce((a, s) => a + Number(s.qte), 0);
  }
  function stockActuel(p) { return Number(p.stockInitial) + totalEntrees(p.code) - totalVentes(p.code); }
  function statutStock(p) {
    const s = stockActuel(p);
    if (s <= 0) return "RUPTURE";
    if (s <= Number(p.stockMin)) return "STOCK FAIBLE";
    return "OK";
  }
  function statutBadge(st) {
    const cls = st === "OK" ? "ok" : st === "RUPTURE" ? "danger" : "warn";
    return '<span class="badge ' + cls + '">' + st + "</span>";
  }
  function lineTotal(s) { return Number(s.qte) * Number(s.pu); }
  function nextTicket() { return db.sales.reduce((m, s) => Math.max(m, Number(s.ticket) || 0), 0) + 1; }

  function salesForReport(filterFn) {
    const cc = $("#r-cc").value;
    return db.sales.filter((s) => s.valide === "OUI" && (cc === "ALL" ? db.settings.ccs.includes(String(s.cc)) : String(s.cc) === cc) && filterFn(s));
  }
  function reportHtml(list) {
    const total = list.reduce((a, s) => a + lineTotal(s), 0);
    const tickets = new Set(list.map((s) => s.ticket)).size;
    const qte = list.reduce((a, s) => a + Number(s.qte), 0);
    return '<div><span>Vente totale</span><strong>' + money(total) + "</strong></div>" +
      '<div><span>Tickets</span><strong>' + tickets + "</strong></div>" +
      '<div><span>Quantités</span><strong>' + num(qte) + "</strong></div>" +
      '<div><span>Lignes</span><strong>' + list.length + "</strong></div>";
  }

  // ---------- Navigation ----------
  function show(view) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    render(view);
    window.scrollTo(0, 0);
  }
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) show(b.dataset.view);
  });

  function render(view) {
    $("#brand-name").textContent = db.settings.nom;
    document.title = db.settings.nom + " — Boutique";
    ({
      dashboard: renderDashboard,
      caisse: renderCaisse,
      ventes: renderVentes,
      stock: renderStock,
      entrees: renderEntrees,
      facture: renderFacture,
      parametres: renderParametres
    })[view]();
  }
  function currentView() {
    const v = document.querySelector(".view.active");
    return v ? v.id.replace("view-", "") : "dashboard";
  }

  function productOptions(selected) {
    return db.products.map((p) =>
      '<option value="' + esc(p.code) + '"' + (p.code === selected ? " selected" : "") + ">" +
      esc(p.nom) + " (" + esc(p.code) + ")</option>").join("");
  }
  function ccOptions(withAll, selected) {
    let h = withAll ? '<option value="ALL">Tous (ALL)</option>' : "";
    h += db.settings.ccs.map((c) => '<option value="' + esc(c) + '"' + (c === selected ? " selected" : "") + ">" + ccLabel(c) + "</option>").join("");
    return h;
  }

  // ---------- Accueil ----------
  function renderDashboard() {
    const counted = db.sales.filter(isCountedSale);
    const ca = counted.reduce((a, s) => a + lineTotal(s), 0);
    const qte = counted.reduce((a, s) => a + Number(s.qte), 0);
    const caJour = counted.filter((s) => s.date === today()).reduce((a, s) => a + lineTotal(s), 0);
    const stockTotal = db.products.reduce((a, p) => a + stockActuel(p), 0);
    const ruptures = db.products.filter((p) => statutStock(p) === "RUPTURE");
    const faibles = db.products.filter((p) => statutStock(p) === "STOCK FAIBLE");
    const entrees = db.entries.filter((e) => e.statut === "Validée").reduce((a, e) => a + Number(e.qte), 0);
    const marge = counted.reduce((a, s) => {
      const p = productByCode(s.code);
      return a + (p ? (Number(s.pu) - Number(p.pa)) * Number(s.qte) : 0);
    }, 0);

    $("#kpis").innerHTML = [
      ["Chiffre d'affaires", money(ca)],
      ["Ventes du jour", money(caJour)],
      ["Marge brute estimée", money(marge)],
      ["Quantités vendues", num(qte)],
      ["Stock total", num(stockTotal)],
      ["Entrées validées", num(entrees)],
      ["Produits en rupture", ruptures.length, ruptures.length ? "danger" : ""],
      ["Produits sous seuil", faibles.length, faibles.length ? "warn" : ""]
    ].map(([l, v, c]) => '<div class="kpi ' + (c || "") + '"><div class="label">' + l + '</div><div class="value">' + v + "</div></div>").join("");

    const alerts = ruptures.concat(faibles);
    $("#alerts").innerHTML = alerts.length
      ? alerts.map((p) => '<div class="list-row"><span>' + esc(p.nom) + ' <span class="muted">' + esc(p.code) + "</span></span><span>" + num(stockActuel(p)) + " " + statutBadge(statutStock(p)) + "</span></div>").join("")
      : '<div class="empty">Aucune alerte, tous les stocks sont OK.</div>';

    const byProd = {};
    counted.forEach((s) => {
      byProd[s.code] = byProd[s.code] || { nom: s.nom, qte: 0, ca: 0 };
      byProd[s.code].qte += Number(s.qte);
      byProd[s.code].ca += lineTotal(s);
    });
    const top = Object.values(byProd).sort((a, b) => b.ca - a.ca).slice(0, 8);
    $("#top-products").innerHTML = top.length
      ? top.map((t) => '<div class="list-row"><span>' + esc(t.nom) + ' <span class="muted">× ' + num(t.qte) + "</span></span><strong>" + money(t.ca) + "</strong></div>").join("")
      : '<div class="empty">Aucune vente pour le moment.</div>';
  }

  // ---------- Caisse ----------
  function clientNames() {
    const set = new Set(["CLIENT COMPTOIR"]);
    db.sales.forEach((s) => s.client && set.add(s.client));
    return Array.from(set).sort();
  }
  function renderCaisse() {
    if (!$("#c-date").value) $("#c-date").value = today();
    const ccSel = $("#c-cc").value;
    $("#c-cc").innerHTML = ccOptions(false, ccSel);
    const prodSel = $("#c-product").value;
    $("#c-product").innerHTML = productOptions(prodSel);
    $("#clients-list").innerHTML = clientNames().map((c) => '<option value="' + esc(c) + '">').join("");
    updateProductInfo(!prodSel);
    renderCart();
  }
  function updateProductInfo(resetPrice) {
    const p = productByCode($("#c-product").value);
    if (!p) { $("#c-stock-info").textContent = ""; return; }
    if (resetPrice !== false) $("#c-pu").value = p.pv;
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    const dispo = stockActuel(p) - inCart;
    $("#c-stock-info").innerHTML = "Stock disponible : <b>" + num(dispo) + "</b> " + statutBadge(statutStock(p)) + " · Prix de vente : " + money(p.pv);
  }
  function renderCart() {
    $("#c-ticket-num").textContent = "(N° " + nextTicket() + ")";
    const total = cart.reduce((a, l) => a + l.qte * l.pu, 0);
    $("#c-cart").innerHTML = cart.length
      ? cart.map((l, i) => "<tr><td>" + esc(l.nom) + '</td><td class="num">' + num(l.qte) + '</td><td class="num">' + num(l.pu) + '</td><td class="num">' + num(l.qte * l.pu) + '</td><td><button class="btn small danger" data-rm="' + i + '">✕</button></td></tr>').join("")
      : '<tr><td colspan="5" class="empty">Ajoutez des produits au ticket.</td></tr>';
    $("#c-total").textContent = money(total);
    const remis = Number($("#c-remis").value);
    $("#c-reliquat").value = $("#c-remis").value === "" ? "" : money(Math.max(0, remis - total));
  }
  $("#c-product").addEventListener("change", () => updateProductInfo(true));
  $("#c-remis").addEventListener("input", renderCart);
  $("#c-add").addEventListener("click", () => {
    const p = productByCode($("#c-product").value);
    const qte = Number($("#c-qte").value);
    const pu = Number($("#c-pu").value);
    if (!p) return toast("Choisissez un produit.");
    if (!(qte > 0)) return toast("Quantité invalide.");
    if (!(pu >= 0)) return toast("Prix invalide.");
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    if (stockActuel(p) - inCart < qte && !confirm("Stock insuffisant pour " + p.nom + " (disponible : " + (stockActuel(p) - inCart) + "). Ajouter quand même ?")) return;
    cart.push({ code: p.code, nom: p.nom, qte, pu });
    $("#c-qte").value = 1;
    updateProductInfo(false);
    renderCart();
  });
  $("#c-cart").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm]");
    if (!b) return;
    cart.splice(Number(b.dataset.rm), 1);
    updateProductInfo(false);
    renderCart();
  });
  $("#c-clear").addEventListener("click", () => { cart = []; $("#c-remis").value = ""; updateProductInfo(false); renderCart(); });
  $("#c-validate").addEventListener("click", () => {
    if (!cart.length) return toast("Le ticket est vide.");
    const date = $("#c-date").value || today();
    const client = $("#c-client").value.trim() || "CLIENT COMPTOIR";
    const ticket = nextTicket();
    cart.forEach((l) => {
      db.sales.push({
        id: uid("s"), date, ticket, client, code: l.code, nom: l.nom, qte: l.qte, pu: l.pu,
        cc: $("#c-cc").value, valide: "OUI",
        numClient: $("#c-numclient").value.trim(), adresseClient: $("#c-adresse").value.trim()
      });
    });
    save();
    const remis = $("#c-remis").value;
    cart = [];
    $("#c-remis").value = "";
    $("#c-numclient").value = "";
    $("#c-adresse").value = "";
    $("#c-client").value = "CLIENT COMPTOIR";
    toast("Vente enregistrée — ticket N° " + ticket);
    if (confirm("Vente enregistrée (ticket N° " + ticket + "). Afficher le ticket de caisse ?")) {
      $("#f-remis").value = remis;
      show("facture");
      $("#f-ticket").value = String(ticket);
      renderReceipt();
    } else {
      renderCaisse();
    }
  });

  // ---------- Ventes ----------
  function renderVentes() {
    const ccSel = $("#r-cc").value || "ALL";
    $("#r-cc").innerHTML = ccOptions(true, ccSel);
    $("#r-cc").value = ccSel;
    if (!$("#r-du").value) $("#r-du").value = today();
    if (!$("#r-au").value) $("#r-au").value = today();
    if (!$("#r-mois").value) $("#r-mois").value = today().slice(0, 7);

    const du = $("#r-du").value, au = $("#r-au").value, mois = $("#r-mois").value;
    $("#r-jour").innerHTML = reportHtml(salesForReport((s) => s.date >= du && s.date <= au));
    $("#r-mois-res").innerHTML = reportHtml(salesForReport((s) => s.date.slice(0, 7) === mois));

    const q = $("#v-search").value.trim().toLowerCase();
    const cc = $("#r-cc").value;
    const rows = db.sales
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => cc === "ALL" || String(s.cc) === cc)
      .filter(({ s }) => !q || [s.client, s.nom, s.code, String(s.ticket), s.date].some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.s.date || "").localeCompare(a.s.date || "") || b.s.ticket - a.s.ticket || b.i - a.i);

    $("#v-rows").innerHTML = rows.length ? rows.map(({ s }) =>
      '<tr class="' + (s.valide === "OUI" ? "" : "off") + '">' +
      "<td>" + fmtDate(s.date) + '</td><td class="num">' + s.ticket + "</td><td>" + esc(s.client) + "</td><td>" + esc(s.nom) + "</td><td>" + esc(s.code) +
      '</td><td class="num">' + num(s.qte) + '</td><td class="num">' + num(s.pu) + '</td><td class="num">' + num(lineTotal(s)) + "</td><td>" + ccLabel(s.cc) +
      '</td><td class="keep"><button class="btn small" data-toggle="' + s.id + '">' + (s.valide === "OUI" ? '<span class="badge ok">OUI</span>' : '<span class="badge mute">NON</span>') + "</button>" +
      '</td><td><button class="btn small danger" data-del="' + s.id + '" title="Supprimer">✕</button></td></tr>'
    ).join("") : '<tr><td colspan="11" class="empty">Aucune vente.</td></tr>';
  }
  ["#r-du", "#r-au", "#r-mois", "#r-cc"].forEach((id) => $(id).addEventListener("change", renderVentes));
  $("#v-search").addEventListener("input", renderVentes);
  $("#v-rows").addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    const d = e.target.closest("[data-del]");
    if (t) {
      const s = db.sales.find((x) => x.id === t.dataset.toggle);
      s.valide = s.valide === "OUI" ? "NON" : "OUI";
      save(); renderVentes();
      toast("Vente du ticket " + s.ticket + " : " + s.valide);
    } else if (d) {
      const s = db.sales.find((x) => x.id === d.dataset.del);
      if (!confirm("Supprimer définitivement cette ligne (ticket " + s.ticket + ", " + s.nom + ") ?\nAstuce : passez-la plutôt à NON pour garder l'historique.")) return;
      db.sales = db.sales.filter((x) => x.id !== s.id);
      save(); renderVentes();
    }
  });
  $("#v-export").addEventListener("click", () => {
    const head = ["Date", "Ticket", "Client", "Produit", "Code_Produit", "Quantite", "PU_Vente", "Total_Vente", "Code_CC", "Validation", "N_Client", "Adresse_Client"];
    const lines = db.sales.map((s) => [s.date, s.ticket, s.client, s.nom, s.code, s.qte, s.pu, lineTotal(s), s.cc, s.valide, s.numClient || "", s.adresseClient || ""]);
    const csv = [head].concat(lines).map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
    download("ventes-" + today() + ".csv", "﻿" + csv, "text/csv;charset=utf-8");
  });

  // ---------- Stock ----------
  function renderStock() {
    const q = $("#s-search").value.trim().toLowerCase();
    const list = db.products.filter((p) => !q || (p.nom + " " + p.code + " " + p.categorie).toLowerCase().includes(q));
    const stockTotal = db.products.reduce((a, p) => a + stockActuel(p), 0);
    const valeur = db.products.reduce((a, p) => a + Math.max(0, stockActuel(p)) * Number(p.pa), 0);
    $("#stock-kpis").innerHTML = [
      ["Produits", db.products.length],
      ["Stock total", num(stockTotal)],
      ["Valeur du stock (achat)", money(valeur)],
      ["En rupture", db.products.filter((p) => statutStock(p) === "RUPTURE").length, "danger"],
      ["Sous seuil", db.products.filter((p) => statutStock(p) === "STOCK FAIBLE").length, "warn"]
    ].map(([l, v, c]) => '<div class="kpi ' + (c || "") + '"><div class="label">' + l + '</div><div class="value">' + v + "</div></div>").join("");

    $("#s-rows").innerHTML = list.length ? list.map((p) =>
      "<tr><td>" + esc(p.code) + "</td><td>" + esc(p.nom) + "</td><td>" + esc(p.categorie) + '</td><td class="num">' + num(p.pa) + '</td><td class="num">' + num(p.pv) +
      '</td><td class="num">' + num(p.stockInitial) + '</td><td class="num">' + num(p.stockMin) + '</td><td class="num">' + num(totalEntrees(p.code)) + '</td><td class="num">' + num(totalVentes(p.code)) +
      '</td><td class="num"><b>' + num(stockActuel(p)) + "</b></td><td>" + statutBadge(statutStock(p)) +
      '</td><td><button class="btn small" data-edit="' + esc(p.code) + '">Modifier</button> <button class="btn small danger" data-pdel="' + esc(p.code) + '">✕</button></td></tr>'
    ).join("") : '<tr><td colspan="12" class="empty">Aucun produit.</td></tr>';
  }
  $("#s-search").addEventListener("input", renderStock);

  let editingCode = null;
  function openProduct(p) {
    editingCode = p ? p.code : null;
    const f = $("#product-form");
    $("#pd-title").textContent = p ? "Modifier " + p.nom : "Nouveau produit";
    const n = db.products.length + 1;
    const def = p || { code: "ART-" + String(n).padStart(3, "0"), nom: "", categorie: "Boisson", pa: 0, pv: 0, stockInitial: 0, stockMin: 5 };
    ["code", "nom", "categorie", "pa", "pv", "stockInitial", "stockMin"].forEach((k) => { f.elements[k].value = def[k]; });
    $("#cat-list").innerHTML = Array.from(new Set(db.products.map((x) => x.categorie))).map((c) => '<option value="' + esc(c) + '">').join("");
    $("#product-dialog").returnValue = "";
    $("#product-dialog").showModal();
  }
  $("#s-new").addEventListener("click", () => openProduct(null));
  $("#s-rows").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-pdel]");
    if (ed) openProduct(productByCode(ed.dataset.edit));
    if (del) {
      const code = del.dataset.pdel;
      const used = db.sales.some((s) => s.code === code) || db.entries.some((x) => x.code === code);
      if (used) return alert("Ce produit a des ventes ou des entrées enregistrées : il ne peut pas être supprimé.");
      if (!confirm("Supprimer le produit " + code + " ?")) return;
      db.products = db.products.filter((p) => p.code !== code);
      save(); renderStock();
    }
  });
  $("#product-dialog").addEventListener("close", () => {
    if ($("#product-dialog").returnValue !== "ok") return;
    const f = $("#product-form");
    const p = {
      code: f.elements.code.value.trim(),
      nom: f.elements.nom.value.trim(),
      categorie: f.elements.categorie.value.trim(),
      pa: Number(f.elements.pa.value) || 0,
      pv: Number(f.elements.pv.value) || 0,
      stockInitial: Number(f.elements.stockInitial.value) || 0,
      stockMin: Number(f.elements.stockMin.value) || 0
    };
    if (!p.code || !p.nom) return toast("Code et désignation obligatoires.");
    const clash = db.products.find((x) => x.code === p.code && x.code !== editingCode);
    if (clash) return alert("Le code " + p.code + " existe déjà.");
    if (editingCode) {
      const i = db.products.findIndex((x) => x.code === editingCode);
      if (editingCode !== p.code) {
        db.sales.forEach((s) => { if (s.code === editingCode) s.code = p.code; });
        db.entries.forEach((x) => { if (x.code === editingCode) x.code = p.code; });
      }
      db.products[i] = p;
    } else {
      db.products.push(p);
    }
    save(); renderStock();
    toast("Produit enregistré.");
  });

  // ---------- Entrées ----------
  function renderEntrees() {
    if (!$("#e-date").value) $("#e-date").value = today();
    const sel = $("#e-product").value;
    $("#e-product").innerHTML = productOptions(sel);
    const rows = db.entries.map((x, i) => ({ x, i })).sort((a, b) => (b.x.date || "").localeCompare(a.x.date || "") || b.i - a.i);
    $("#e-rows").innerHTML = rows.length ? rows.map(({ x }) => {
      const p = productByCode(x.code);
      return '<tr class="' + (x.statut === "Validée" ? "" : "off") + '"><td>' + fmtDate(x.date) + "</td><td>" + esc(p ? p.nom : "?") + "</td><td>" + esc(x.code) +
        '</td><td class="num">' + num(x.qte) + '</td><td class="keep"><button class="btn small" data-etoggle="' + x.id + '">' +
        (x.statut === "Validée" ? '<span class="badge ok">Validée</span>' : '<span class="badge mute">Annulée</span>') +
        "</button></td><td>" + esc(x.obs) + '</td><td><button class="btn small danger" data-edel="' + x.id + '">✕</button></td></tr>';
    }).join("") : '<tr><td colspan="7" class="empty">Aucune entrée.</td></tr>';
  }
  $("#e-add").addEventListener("click", () => {
    const qte = Number($("#e-qte").value);
    if (!$("#e-product").value) return toast("Choisissez un produit.");
    if (!(qte > 0)) return toast("Quantité invalide.");
    db.entries.push({ id: uid("e"), date: $("#e-date").value || today(), code: $("#e-product").value, qte, statut: "Validée", obs: $("#e-obs").value.trim() });
    save(); renderEntrees();
    $("#e-qte").value = 1;
    toast("Entrée enregistrée, stock mis à jour.");
  });
  $("#e-rows").addEventListener("click", (e) => {
    const t = e.target.closest("[data-etoggle]");
    const d = e.target.closest("[data-edel]");
    if (t) {
      const x = db.entries.find((y) => y.id === t.dataset.etoggle);
      x.statut = x.statut === "Validée" ? "Annulée" : "Validée";
      save(); renderEntrees();
    } else if (d) {
      if (!confirm("Supprimer définitivement cette entrée ?\nAstuce : passez-la plutôt à Annulée pour garder l'historique.")) return;
      db.entries = db.entries.filter((y) => y.id !== d.dataset.edel);
      save(); renderEntrees();
    }
  });

  // ---------- Facturation ----------
  function ticketList() {
    return Array.from(new Set(db.sales.filter((s) => s.valide === "OUI").map((s) => Number(s.ticket)))).sort((a, b) => b - a);
  }
  function renderFacture() {
    const sel = $("#f-ticket").value;
    const list = ticketList();
    $("#f-ticket").innerHTML = list.length ? list.map((t) => '<option value="' + t + '">' + t + "</option>").join("") : '<option value="">—</option>';
    if (sel && list.includes(Number(sel))) $("#f-ticket").value = sel;
    renderReceipt();
  }
  function renderReceipt() {
    const t = Number($("#f-ticket").value);
    const st = db.settings;
    const lines = db.sales.filter((s) => Number(s.ticket) === t && s.valide === "OUI");
    if (!lines.length) { $("#receipt").innerHTML = '<div class="empty">Aucun ticket validé à afficher.</div>'; return; }
    const first = lines[0];
    const total = lines.reduce((a, s) => a + lineTotal(s), 0);
    const remisRaw = $("#f-remis").value;
    const remis = Number(remisRaw);
    const now = new Date();
    $("#receipt").innerHTML =
      '<div class="center"><h3>' + esc(st.nom) + "</h3><div>" + esc(st.domaine) + "</div><div>Tel: " + esc(st.tel) + "</div><div>Adresse: " + esc(st.adresse) +
      "</div><div>Email: " + esc(st.email) + "</div><div>RCCM/NIF : " + esc(st.rccm) + "</div></div><hr>" +
      '<div class="center big">TICKET DE CAISSE</div><hr>' +
      "<table><tr><td>N° " + t + '</td><td class="r">Date : ' + fmtDate(first.date) + "</td></tr>" +
      "<tr><td>Client : " + esc(first.client) + '</td><td class="r">Heure : ' + now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + "</td></tr>" +
      "<tr><td>" + ccLabel(first.cc) + "</td><td></td></tr>" +
      (first.numClient ? "<tr><td colspan=2>N° client : " + esc(first.numClient) + "</td></tr>" : "") +
      (first.adresseClient ? "<tr><td colspan=2>Adresse : " + esc(first.adresseClient) + "</td></tr>" : "") +
      "</table><hr>" +
      '<table><thead><tr><th>Produit</th><th class="r">Qté</th><th class="r">PU</th><th class="r">Prix</th></tr></thead><tbody>' +
      lines.map((s) => "<tr><td>" + esc(s.nom) + '</td><td class="r">' + num(s.qte) + '</td><td class="r">' + num(s.pu) + '</td><td class="r">' + num(lineTotal(s)) + "</td></tr>").join("") +
      "</tbody></table><hr>" +
      '<table><tr class="big"><td>TOTAL À PAYER</td><td class="r">' + money(total) + "</td></tr>" +
      (remisRaw !== "" ? "<tr><td>Montant remis</td><td class=\"r\">" + money(remis) + "</td></tr><tr><td>Reliquat</td><td class=\"r\">" + money(Math.max(0, remis - total)) + "</td></tr>" : "") +
      "</table><hr>" +
      '<div class="center">Merci pour votre confiance.<br>Ticket : ' + String(t).padStart(6, "0") + " | Merci et à bientôt.</div>";
  }
  $("#f-ticket").addEventListener("change", renderReceipt);
  $("#f-remis").addEventListener("input", renderReceipt);
  $("#f-print").addEventListener("click", () => window.print());

  // ---------- Paramètres ----------
  function renderParametres() {
    document.querySelectorAll("#p-form [data-k]").forEach((i) => { i.value = db.settings[i.dataset.k] || ""; });
    $("#p-ccs").value = db.settings.ccs.join(", ");
  }
  $("#p-save").addEventListener("click", () => {
    document.querySelectorAll("#p-form [data-k]").forEach((i) => { db.settings[i.dataset.k] = i.value.trim(); });
    const ccs = $("#p-ccs").value.split(",").map((s) => s.trim().replace(/^0+(?=\d)/, "")).filter(Boolean);
    if (!ccs.length) return toast("Indiquez au moins un code commercial.");
    db.settings.ccs = Array.from(new Set(ccs));
    save(); render("parametres");
    toast("Paramètres enregistrés.");
  });
  function download(name, content, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  $("#p-export").addEventListener("click", () => {
    download("sauvegarde-" + (db.settings.nom || "boutique") + "-" + today() + ".json", JSON.stringify(db, null, 2), "application/json");
  });
  $("#p-import").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.settings || !Array.isArray(data.products) || !Array.isArray(data.sales) || !Array.isArray(data.entries)) throw new Error("format");
        if (!confirm("Remplacer toutes les données actuelles par cette sauvegarde ?")) return;
        db = data;
        save(); show("dashboard");
        toast("Sauvegarde restaurée.");
      } catch (err) {
        alert("Fichier de sauvegarde invalide.");
      } finally {
        e.target.value = "";
      }
    };
    r.readAsText(file);
  });
  $("#p-reset").addEventListener("click", () => {
    if (!confirm("Effacer toutes les données et revenir aux données d'origine du fichier Excel ?\nPensez à télécharger une sauvegarde avant.")) return;
    db = clone(window.SEED_DATA);
    cart = [];
    save(); show("dashboard");
    toast("Données réinitialisées.");
  });

  // ---------- Démarrage ----------
  save();
  const start = location.hash.slice(1);
  show(document.getElementById("view-" + start) ? start : "dashboard");
})();
