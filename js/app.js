(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const cfg = window.APP_CONFIG || {};
  const ADMIN_VIEWS = ["dashboard", "stats", "parametres", "rh"];

  let sb = null;
  let me = null;
  let db = emptyDb();
  let cart = [];
  let currentView = null;
  let lastReload = 0;
  const dash = { periode: "jour", ref: today(), cc: "ALL", boutique: "ALL" };

  function emptyDb() {
    return { settings: { nom: "BGTeam", devise: "FCFA", ccList: [] }, products: [], entries: [], sales: [], users: [], courses: [], boutiques: [], conges: [], fiches: [], charges: [] };
  }
  const isAdmin = () => !!me && me.role === "admin";

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function num(n) { return Number(n || 0).toLocaleString("fr-FR"); }
  function money(n) { return num(n) + " " + (db.settings.devise || "FCFA"); }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12); }
  function today() { return iso(new Date()); }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function addMonths(s, n) { const d = parse(s); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); }
  function mondayOf(s) { const d = parse(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); }
  function lastDayOfMonth(s) { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12)); }
  function fmtDate(s) {
    if (!s) return "—";
    const [y, m, d] = s.split("-");
    return d + "/" + m + "/" + y;
  }
  function fmtLong(s) { return parse(s).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
  function fmtMonth(s) { return parse(s.slice(0, 7) + "-01").toLocaleDateString("fr-FR", { month: "long", year: "numeric" }); }
  function cap(s) { return s.replace(/^./, (c) => c.toUpperCase()); }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 3200);
  }
  function productByCode(code) { return db.products.find((p) => p.code === code); }
  function download(name, content, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function toCsv(rows) {
    return rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
  }

  // ---------- Accès Supabase ----------
  function errMsg(e) {
    const m = (e && (e.message || e.error_description)) || String(e);
    if (/Invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
    if (/already registered|already exists/i.test(m)) return "Un compte existe déjà avec cet e-mail.";
    if (/row-level security|permission denied|42501/i.test(m) || (e && e.code === "42501")) return "Action non autorisée pour votre compte.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Pas de connexion Internet. Réessayez.";
    if (/duplicate key/i.test(m)) return "Ce code existe déjà.";
    if (/violates foreign key/i.test(m)) return "Impossible : cet élément est utilisé ailleurs (ventes, entrées…).";
    if (/Password should be/i.test(m)) return "Mot de passe trop court (8 caractères minimum).";
    return m;
  }
  function chk(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : undefined;
  }
  async function fetchAll(table, order) {
    const size = 1000;
    let all = [], from = 0;
    for (;;) {
      let q = sb.from(table).select("*").range(from, from + size - 1);
      if (order) q = q.order(order, { ascending: true });
      const data = chk(await q);
      all = all.concat(data);
      if (data.length < size) break;
      from += size;
    }
    return all;
  }
  async function reload() {
    const [settingsRes, products, costs, ccs, entries, sales, users, courses, boutiques, conges, fiches, charges] = await Promise.all([
      sb.from("settings").select("*").eq("id", 1).maybeSingle(),
      fetchAll("products", "code"),
      isAdmin() ? fetchAll("product_costs", "code") : Promise.resolve([]),
      fetchAll("ccs", "code"),
      fetchAll("entries", "created_at"),
      fetchAll("sales", "created_at"),
      isAdmin() ? fetchAll("profiles", "created_at") : Promise.resolve([]),
      fetchAll("courses", "created_at"),
      fetchAll("boutiques", "code"),
      fetchAll("conges", "debut"),
      isAdmin() ? fetchAll("rh_fiches", "cc") : Promise.resolve([]),
      isAdmin() ? fetchAll("charges", "date") : Promise.resolve([])
    ]);
    const st = chk(settingsRes) || {};
    const pa = {}, cmp = {};
    costs.forEach((c) => { pa[c.code] = Number(c.pa); cmp[c.code] = c.cmp == null ? Number(c.pa) : Number(c.cmp); });
    db = {
      settings: {
        nom: st.nom || "BGTeam", domaine: st.domaine || "", tel: st.tel || "", adresse: st.adresse || "",
        email: st.email || "", rccm: st.rccm || "", devise: st.devise || "FCFA",
        ccList: ccs.map((c) => ({ code: String(c.code), actif: c.actif, agents: Array.isArray(c.agents) ? c.agents : [], boutique: c.boutique || "", repos: Array.isArray(c.repos) ? c.repos.map(Number) : [] }))
          .sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code))
      },
      products: products.map((p) => ({
        code: p.code, nom: p.nom, categorie: p.categorie, pa: pa[p.code] || 0, cmp: cmp[p.code] || 0, pv: Number(p.pv),
        valide: p.valide !== false, creePar: p.cree_par || "", creeParCc: p.cree_par_cc || "", creeLe: p.cree_le || "",
        stockInitial: Number(p.stock_initial), stockMin: Number(p.stock_min)
      })),
      entries: entries.map((x) => ({
        id: x.id, date: x.date || "", code: x.code, qte: Number(x.qte), statut: x.statut, obs: x.obs,
        cc: x.cc ? String(x.cc) : "", saisiPar: x.saisi_par || "", createdBy: x.created_by, createdAt: x.created_at,
        courseId: x.course_id || null, boutique: x.boutique || "", prixTotal: x.prix_total == null ? null : Number(x.prix_total),
        fraisPart: x.frais_part == null ? 0 : Number(x.frais_part), coutUnitaire: x.cout_unitaire == null ? null : Number(x.cout_unitaire)
      })),
      courses: courses.map((c) => ({
        id: c.id, date: c.date || "", cc: c.cc ? String(c.cc) : "", saisiPar: c.saisi_par || "", createdBy: c.created_by, createdAt: c.created_at,
        retrait: Number(c.frais_retrait) || 0, transport: Number(c.frais_transport) || 0, autres: Number(c.autres_frais) || 0,
        autresLib: c.autres_libelle || "", obs: c.obs || "", statut: c.statut,
        marche: c.marche || "", tel: c.fournisseur_tel || "", recuPath: c.recu_path || "", boutique: c.boutique || ""
      })),
      sales: sales.map((s) => ({
        id: s.id, date: s.date, ticket: Number(s.ticket), client: s.client, code: s.code, nom: s.nom, qte: Number(s.qte), pu: Number(s.pu),
        cc: String(s.cc), vendeur: s.vendeur || "", valide: s.valide, numClient: s.num_client || "", adresseClient: s.adresse_client || "",
        cout: s.cout_unitaire == null ? null : Number(s.cout_unitaire), createdAt: s.created_at, boutique: s.boutique || ""
      })),
      users,
      conges: conges.map((g) => ({ id: g.id, cc: String(g.cc), debut: g.debut, fin: g.fin, motif: g.motif || "" })),
      fiches,
      charges: charges.map((c) => ({ id: c.id, date: c.date, boutique: c.boutique || "", categorie: c.categorie, libelle: c.libelle || "", montant: Number(c.montant) })),
      boutiques: boutiques.map((b) => ({ code: b.code, nom: b.nom, actif: b.actif !== false }))
        .sort((a, b) => Number(a.code.replace(/\D/g, "")) - Number(b.code.replace(/\D/g, "")) || a.code.localeCompare(b.code))
    };
    lastReload = Date.now();
  }
  // Exécute une écriture, recharge les données et réaffiche l'écran courant.
  async function act(fn, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      const out = await fn();
      await reload();
      if (currentView) render(currentView);
      if (okMsg) toast(okMsg);
      return { ok: true, data: out };
    } catch (e) {
      console.error(e);
      toast(errMsg(e));
      return { ok: false };
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Écrans & authentification ----------
  function screen(name) {
    ["loading", "auth", "pending", "app"].forEach((n) => {
      const el = document.getElementById(n === "app" ? "app" : n + "-screen");
      el.classList.toggle("hidden", n !== name);
    });
  }
  function authMsg(msg, ok) {
    const el = $("#auth-msg");
    el.textContent = msg || "";
    el.classList.toggle("ok", !!ok);
  }
  $("#auth-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#auth-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("#login-form").classList.toggle("hidden", b.dataset.tab !== "login");
    $("#signup-form").classList.toggle("hidden", b.dataset.tab !== "signup");
    authMsg("");
  });
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    btn.disabled = true; authMsg("");
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    btn.disabled = false;
    if (error) return authMsg(errMsg(error));
    f.password.value = "";
    enter();
  });
  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button");
    btn.disabled = true; authMsg("");
    const { data, error } = await sb.auth.signUp({
      email: f.email.value.trim(), password: f.password.value,
      options: { data: { nom: f.nom.value.trim() } }
    });
    btn.disabled = false;
    if (error) return authMsg(errMsg(error));
    f.password.value = "";
    if (data.session) enter();
    else authMsg("Compte créé. Vérifiez votre boîte e-mail pour confirmer l'adresse, puis connectez-vous.", true);
  });
  document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
    stopRealtime();
    await sb.auth.signOut();
    me = null; db = emptyDb(); cart = []; currentView = null;
    screen("auth");
  }));
  $("#pending-retry").addEventListener("click", () => enter());

  async function enter() {
    screen("loading");
    $("#loading-msg").textContent = "Chargement…";
    try {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return screen("auth");
      const prof = chk(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
      if (!prof || !prof.actif) {
        $("#pending-email").textContent = user.email;
        return screen("pending");
      }
      me = prof;
      document.body.classList.toggle("role-admin", isAdmin());
      document.body.classList.toggle("role-vendeur", !isAdmin());
      $("#user-name").textContent = (me.nom || me.email) + " · " + (isAdmin() ? "Admin" : "Vendeur");
      await reload();
      screen("app");
      const start = location.hash.slice(1);
      show(canView(start) ? start : isAdmin() ? "dashboard" : "caisse");
      startRealtime();
    } catch (e) {
      console.error(e);
      $("#loading-msg").innerHTML = esc(errMsg(e)) + '<br><br><button class="btn" onclick="location.reload()">Réessayer</button>';
    }
  }

  async function softRefresh() {
    if (!me || document.querySelector("dialog[open]") || Date.now() - lastReload < 20000) return;
    try { await reload(); if (currentView) render(currentView); } catch (e) { /* hors ligne : on réessaiera */ }
  }
  // Temps réel : une vente, une entrée ou une course enregistrée ailleurs met à jour cet écran.
  let rtChannel = null, rtTimer = null, rtLive = false;
  const RT_VIEWS = ["ventes", "dashboard", "stock", "stats", "facture", "rh", "compte"];
  function startRealtime() {
    if (rtChannel || !sb) return;
    const onChange = () => {
      clearTimeout(rtTimer);
      rtTimer = setTimeout(async () => {
        if (!me || document.querySelector("dialog[open]")) return;
        try {
          await reload();
          if (RT_VIEWS.includes(currentView)) render(currentView);
          else if (currentView === "entrees") renderEntryHistory();
        } catch (e) { /* hors ligne */ }
      }, 700);
    };
    rtChannel = sb.channel("bgteam-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "courses" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "ccs" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "boutiques" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "conges" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "charges" }, onChange)
      .subscribe((status) => { rtLive = status === "SUBSCRIBED"; if (currentView === "ventes") renderSalesHistory(); });
  }
  function stopRealtime() {
    if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; rtLive = false; }
  }
  window.addEventListener("focus", softRefresh);
  setInterval(() => { if (document.visibilityState === "visible") softRefresh(); }, 120000);
  $("#btn-refresh").addEventListener("click", async () => {
    try { await reload(); render(currentView); toast("Données actualisées."); } catch (e) { toast(errMsg(e)); }
  });

  // Mot de passe
  $("#btn-pwd").addEventListener("click", () => {
    $("#pwd-form").reset();
    $("#pwd-dialog").showModal();
  });
  $("#pwd-form").addEventListener("submit", async (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    e.preventDefault();
    if (f.p1.value.length < 8) return toast("8 caractères minimum.");
    if (f.p1.value !== f.p2.value) return toast("Les deux mots de passe sont différents.");
    const { error } = await sb.auth.updateUser({ password: f.p1.value });
    if (error) return toast(errMsg(error));
    $("#pwd-dialog").close();
    toast("Mot de passe modifié.");
  });

  // ---------- Codes commerciaux & vendeurs ----------
  function ccByCode(code) { return db.settings.ccList.find((c) => c.code === String(code)); }
  function ccLabel(code) { return "CC " + String(code).padStart(2, "0"); }
  function currentAgent(cc) {
    if (!cc) return "";
    const open = cc.agents.filter((a) => !a.fin);
    return open.length ? open[open.length - 1].nom : "";
  }
  function agentAt(cc, date) {
    if (!cc || !cc.agents.length) return "";
    const a = cc.agents.filter((x) => (!x.debut || x.debut <= date) && (!x.fin || x.fin >= date)).pop();
    return a ? a.nom : "";
  }
  function vendeurOf(s) { return s.vendeur || agentAt(ccByCode(s.cc), s.date) || ""; }
  function ccName(code) {
    const cc = ccByCode(code);
    const nom = currentAgent(cc);
    return ccLabel(code) + (nom ? " — " + nom : "") + (cc && !cc.actif ? " (inactif)" : "");
  }
  function ccOptions(withAll, selected, activeOnly) {
    let h = withAll ? '<option value="ALL">Tous les CC</option>' : "";
    h += db.settings.ccList
      .filter((c) => !activeOnly || c.actif)
      .map((c) => '<option value="' + esc(c.code) + '"' + (c.code === selected ? " selected" : "") + ">" + esc(ccName(c.code)) + "</option>").join("");
    return h;
  }
  function fillCcSelect(sel, withAll, activeOnly) {
    const cur = sel.value;
    sel.innerHTML = ccOptions(withAll, cur, activeOnly);
    if (cur && Array.from(sel.options).some((o) => o.value === cur)) sel.value = cur;
  }

  // ---------- Calculs ----------
  function isCountedSale(s) { return s.valide === "OUI"; }
  // Stock commun (bq absent ou "ALL") ou stock d'une boutique (bq = code boutique).
  // Le stock initial (repris de l'Excel) appartient à la boutique d'origine.
  const INITIAL_BOUTIQUE = "B1";
  const inBq = (bq, code) => !bq || bq === "ALL" || code === bq;
  function totalEntrees(code, bq) {
    return db.entries.filter((e) => e.code === code && e.statut === "Validée" && inBq(bq, e.boutique)).reduce((a, e) => a + Number(e.qte), 0);
  }
  function totalVentes(code, bq) {
    return db.sales.filter((s) => s.code === code && isCountedSale(s) && inBq(bq, saleBoutique(s))).reduce((a, s) => a + Number(s.qte), 0);
  }
  function stockInitialOf(p, bq) { return !bq || bq === "ALL" || bq === INITIAL_BOUTIQUE ? Number(p.stockInitial) : 0; }
  function stockActuel(p, bq) { return stockInitialOf(p, bq) + totalEntrees(p.code, bq) - totalVentes(p.code, bq); }
  function statutStock(p, bq) {
    const s = stockActuel(p, bq);
    if (s <= 0) return "RUPTURE";
    if (s <= Number(p.stockMin)) return "STOCK FAIBLE";
    return "OK";
  }
  function statutBadge(st) {
    const cls = st === "OK" ? "ok" : st === "RUPTURE" ? "danger" : "warn";
    return '<span class="badge ' + cls + '">' + st + "</span>";
  }
  function lineTotal(s) { return Number(s.qte) * Number(s.pu); }
  function summarize(list) {
    const ca = list.reduce((a, s) => a + lineTotal(s), 0);
    const qte = list.reduce((a, s) => a + Number(s.qte), 0);
    const tickets = new Set(list.map((s) => s.ticket)).size;
    // Marge avec le coût de revient figé sur chaque vente (CMP au moment de la vente).
    const marge = list.reduce((a, s) => {
      const p = productByCode(s.code);
      const cout = s.cout != null ? s.cout : p ? p.cmp : 0;
      return a + (Number(s.pu) - cout) * Number(s.qte);
    }, 0);
    return { ca, qte, tickets, marge, lignes: list.length };
  }
  function kpiHtml(items) {
    return items.map(([l, v, c]) => '<div class="kpi ' + (c || "") + '"><div class="label">' + l + '</div><div class="value">' + v + "</div></div>").join("");
  }

  // ---------- Navigation ----------
  function canView(view) { return !!document.getElementById("view-" + view) && (isAdmin() || !ADMIN_VIEWS.includes(view)); }
  function show(view) {
    if (!canView(view)) view = isAdmin() ? "dashboard" : "caisse";
    currentView = view;
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
      dashboard: renderDashboard, caisse: renderCaisse, ventes: renderVentes, stats: renderStats,
      stock: renderStock, entrees: renderEntrees, facture: renderFacture, parametres: renderParametres, rh: renderRh, compte: renderCompte
    })[view]();
  }
  function productOptions(selected) {
    return db.products.map((p) =>
      '<option value="' + esc(p.code) + '"' + (p.code === selected ? " selected" : "") + ">" +
      (p.valide ? "" : "⚠ ") + esc(p.nom) + " (" + esc(p.code) + ")" + (p.valide ? "" : " — à valider") + "</option>").join("");
  }
  function pendingBadge(p) { return p && !p.valide ? ' <span class="badge pending" title="Produit créé par ' + esc(p.creePar || "un CC") + ', en attente de validation par l\'administrateur">À valider</span>' : ""; }

  // ---------- Accueil ----------
  function periodRange(p, ref) {
    if (p === "jour") return [ref, ref];
    if (p === "semaine") { const m = mondayOf(ref); return [m, addDays(m, 6)]; }
    if (p === "mois") { const f = ref.slice(0, 7) + "-01"; return [f, lastDayOfMonth(f)]; }
    if (p === "annee") return [ref.slice(0, 4) + "-01-01", ref.slice(0, 4) + "-12-31"];
    return ["0000-01-01", "9999-12-31"];
  }
  function periodLabel(p, ref) {
    const [du, au] = periodRange(p, ref);
    if (p === "jour") return (ref === today() ? "Aujourd'hui — " : "") + fmtLong(ref);
    if (p === "semaine") return "Semaine du " + fmtDate(du) + " au " + fmtDate(au);
    if (p === "mois") return cap(fmtMonth(ref));
    if (p === "annee") return "Année " + ref.slice(0, 4);
    return "Tout l'historique";
  }
  // ---------- Tableau de bord (pilotage) ----------
  const CH = { blue: "#2a78d6", orange: "#eb6834", grid: "#e1e0d9", axis: "#c3c2b7", muted: "#898781", ink: "#0b0b0b" };
  const charts = {};
  function prevRange(p, ref) {
    if (p === "jour") return periodRange(p, addDays(ref, -1));
    if (p === "semaine") return periodRange(p, addDays(ref, -7));
    if (p === "mois") return periodRange(p, addMonths(ref, -1));
    return periodRange(p, (Number(ref.slice(0, 4)) - 1) + "-01-01");
  }
  function costOf(s) { if (s.cout != null) return s.cout; const p = productByCode(s.code); return p ? p.cmp : 0; }
  function salesIn(du, au, bq) { return db.sales.filter((s) => isCountedSale(s) && s.date >= du && s.date <= au && (bq === "ALL" || saleBoutique(s) === bq)); }
  function chargesIn(du, au, bq) { return db.charges.filter((c) => c.date >= du && c.date <= au && (bq === "ALL" || c.boutique === bq)); }
  function metrics(du, au, bq) {
    const ls = salesIn(du, au, bq);
    const ca = ls.reduce((a, s) => a + lineTotal(s), 0);
    const cogs = ls.reduce((a, s) => a + costOf(s) * Number(s.qte), 0);
    const charges = chargesIn(du, au, bq).reduce((a, c) => a + c.montant, 0);
    const tickets = new Set(ls.map((s) => s.ticket)).size;
    return { ls, ca, cogs, marge: ca - cogs, charges, net: ca - cogs - charges, tickets, qte: ls.reduce((a, s) => a + Number(s.qte), 0), panier: tickets ? ca / tickets : 0 };
  }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
  function deltaHtml(cur, prev, upIsGood) {
    if (!prev) return '<div class="delta">— pas de comparaison</div>';
    const d = Math.round(((cur - prev) / Math.abs(prev)) * 100);
    if (!d) return '<div class="delta">= stable vs période préc.</div>';
    const good = upIsGood ? d > 0 : d < 0;
    return '<div class="delta ' + (good ? "up" : "down") + '">' + (d > 0 ? "▲ +" : "▼ ") + d + " % vs période préc.</div>";
  }
  function heroTile(label, value, delta, cls) {
    return '<div class="kpi ' + (cls || "") + '"><div class="label">' + label + '</div><div class="value">' + value + "</div>" + (delta || "") + "</div>";
  }
  // Produits "suivis" dans une boutique : stock initial ou au moins un mouvement
  function handledIn(p, bq) {
    if (bq === "ALL") return true;
    return stockInitialOf(p, bq) > 0 || db.entries.some((e) => e.code === p.code && e.boutique === bq) || db.sales.some((s) => s.code === p.code && saleBoutique(s) === bq);
  }
  function stockStats(bq) {
    const prods = db.products.filter((p) => handledIn(p, bq));
    const rupt = prods.filter((p) => statutStock(p, bq) === "RUPTURE");
    const faible = prods.filter((p) => statutStock(p, bq) === "STOCK FAIBLE");
    return {
      rupt, faible,
      unites: prods.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)), 0),
      valeur: prods.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.cmp), 0)
    };
  }
  // Axe temporel du graphique selon la période
  function trendBuckets(p, ref) {
    if (p === "annee") {
      const y = ref.slice(0, 4);
      return Array.from({ length: 12 }, (_, i) => { const m = y + "-" + String(i + 1).padStart(2, "0"); return { label: cap(parse(m + "-01").toLocaleDateString("fr-FR", { month: "short" })), du: m + "-01", au: lastDayOfMonth(m + "-01") }; });
    }
    let du, au;
    if (p === "jour") { au = ref; du = addDays(ref, -13); } else [du, au] = periodRange(p, ref);
    const out = [];
    for (let d = du; d <= au; d = addDays(d, 1)) out.push({ label: fmtDate(d).slice(0, 5), du: d, au: d });
    return out;
  }
  const fmtAxis = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " M" : Math.abs(v) >= 1e3 ? (v / 1e3).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " k" : num(v));
  function baseOptions(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: {
        legend: { labels: { color: "#52514e", boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { family: "system-ui, -apple-system, Segoe UI, sans-serif" } } },
        tooltip: { callbacks: { label: (c) => (c.dataset.label ? c.dataset.label + " : " : "") + money(Math.round(c.parsed.y != null && c.chart.options.indexAxis !== "y" ? c.parsed.y : c.parsed.x)) } }
      },
      scales: {
        x: { grid: { color: CH.grid, drawTicks: false }, border: { color: CH.axis }, ticks: { color: CH.muted, padding: 6 } },
        y: { grid: { color: CH.grid, drawTicks: false }, border: { color: CH.axis }, ticks: { color: CH.muted, padding: 6 } }
      }
    }, extra || {});
  }
  function drawChart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const el = document.getElementById(id);
    if (!window.Chart) { el.parentElement.innerHTML = '<p class="muted">Graphique indisponible (connexion requise).</p>'; return; }
    charts[id] = new Chart(el, config);
  }

  function renderDashboard() {
    if (!dash.boutique) dash.boutique = "ALL";
    const bsel = $("#d-boutique");
    bsel.innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    bsel.value = db.boutiques.some((b) => b.code === dash.boutique) ? dash.boutique : "ALL";
    dash.boutique = bsel.value;
    const bq = dash.boutique;
    $("#d-ref").value = dash.ref;
    document.querySelectorAll("#d-periode button").forEach((b) => b.classList.toggle("active", b.dataset.p === dash.periode));
    const [du, au] = periodRange(dash.periode, dash.ref);
    const [pdu, pau] = prevRange(dash.periode, dash.ref);
    const m = metrics(du, au, bq), pm = metrics(pdu, pau, bq);
    const scope = bq === "ALL" ? "Toutes les boutiques" : boutiqueName(bq);
    $("#d-label").textContent = periodLabel(dash.periode, dash.ref) + " · " + scope;
    $("#tb-live").innerHTML = (rtLive ? '<span class="live-dot"></span>En direct · ' : "") + "mis à jour à " + new Date(lastReload || Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

    // 1. Indicateurs clés
    $("#kpis").innerHTML =
      heroTile("Chiffre d'affaires", money(Math.round(m.ca)), deltaHtml(m.ca, pm.ca, true)) +
      heroTile("Coût d'achat des ventes", money(Math.round(m.cogs)), deltaHtml(m.cogs, pm.cogs, false)) +
      heroTile("Marge brute · " + pct(m.marge, m.ca) + " %", money(Math.round(m.marge)), deltaHtml(m.marge, pm.marge, true)) +
      heroTile("Charges" + (bq === "ALL" ? " (toutes)" : ""), money(Math.round(m.charges)), deltaHtml(m.charges, pm.charges, false)) +
      heroTile((m.net >= 0 ? "✅ Bénéfice net" : "⛔ Perte nette") + " · " + pct(m.net, m.ca) + " %", money(Math.round(m.net)), deltaHtml(m.net, pm.net, true), m.net >= 0 ? "hero-good" : "hero-bad") +
      heroTile("Tickets", num(m.tickets), deltaHtml(m.tickets, pm.tickets, true)) +
      heroTile("Panier moyen", money(Math.round(m.panier)), deltaHtml(m.panier, pm.panier, true));

    // 2. Résultat par boutique (toutes, pour comparer)
    const rows = db.boutiques.map((b) => ({ b, m: metrics(du, au, b.code), pm: metrics(pdu, pau, b.code), st: stockStats(b.code) }));
    const general = db.charges.filter((c) => !c.boutique && c.date >= du && c.date <= au).reduce((a, c) => a + c.montant, 0);
    const all = metrics(du, au, "ALL");
    const td = (v, cls) => '<td class="num ' + (cls || "") + '">' + money(Math.round(v)) + "</td>";
    $("#tb-bq-period").textContent = "(" + periodLabel(dash.periode, dash.ref) + ")";
    $("#tb-bq-table").innerHTML = '<thead><tr><th>Boutique</th><th class="num">Chiffre d\'affaires</th><th class="num">Coût d\'achat</th><th class="num">Marge brute</th><th class="num">Charges</th><th class="num">Bénéfice net</th><th class="num">Marge nette</th><th class="num">Tickets</th><th>Évolution du CA</th><th class="num">Ruptures</th></tr></thead><tbody>' +
      rows.map(({ b, m: x, pm: px, st }) => '<tr class="clickable' + (bq === b.code ? " selected" : "") + '" data-tb-bq="' + esc(b.code) + '"><td><b>' + esc(b.nom) + "</b>" + (b.actif ? "" : ' <span class="badge mute">inactive</span>') + "</td>" +
        td(x.ca) + td(x.cogs) + td(x.marge) + td(x.charges) + td(x.net, x.net < 0 ? "neg" : "pos") + '<td class="num">' + pct(x.net, x.ca) + " %</td>" + '<td class="num">' + num(x.tickets) + "</td><td>" +
        deltaHtml(x.ca, px.ca, true).replace('class="delta', 'class="kpi-inline delta') + '</td><td class="num ' + (st.rupt.length ? "neg" : "") + '">' + st.rupt.length + "</td></tr>").join("") +
      '<tr><td><i>Charges générales (non affectées)</i></td><td></td><td></td><td></td>' + td(general) + td(-general, general ? "neg" : "") + "<td></td><td></td><td></td><td></td></tr>" +
      '<tr class="total"><td>BÉNÉFICE GLOBAL</td>' + td(all.ca) + td(all.cogs) + td(all.marge) + td(all.charges) + td(all.net, all.net < 0 ? "neg" : "pos") + '<td class="num">' + pct(all.net, all.ca) + " %</td>" +
      '<td class="num">' + num(all.tickets) + "</td><td></td><td></td></tr></tbody>";

    // 3. Alertes de pilotage
    const alerts = [];
    const add = (lvl, ico, title, txt) => alerts.push({ lvl, html: '<div class="alert-item ' + lvl + '"><span class="ico">' + ico + "</span><div><b>" + title + "</b>" + txt + "</div></div>" });
    rows.forEach(({ b, m: x, pm: px, st }) => {
      if (!b.actif) return;
      if (x.ca > 0 && x.net < 0) add("critical", "⛔", esc(b.nom) + " est en perte", "Perte nette de " + money(Math.round(-x.net)) + " sur la période (charges " + money(Math.round(x.charges)) + ").");
      if (st.rupt.length) add("critical", "⛔", esc(b.nom) + " : " + st.rupt.length + " produit(s) en rupture", st.rupt.slice(0, 6).map((p) => esc(p.nom)).join(", ") + (st.rupt.length > 6 ? "…" : ""));
      if (st.faible.length) add("warning", "⚠", esc(b.nom) + " : " + st.faible.length + " produit(s) sous le seuil", st.faible.slice(0, 6).map((p) => esc(p.nom) + " (" + num(stockActuel(p, b.code)) + ")").join(", "));
      if (px.ca > 0 && x.ca < px.ca * 0.8) add("warning", "📉", esc(b.nom) + " : chiffre d'affaires en baisse", "−" + Math.round((1 - x.ca / px.ca) * 100) + " % par rapport à la période précédente (" + money(Math.round(px.ca)) + " → " + money(Math.round(x.ca)) + ").");
      if (du <= today() && au >= today() && !db.sales.some((s) => isCountedSale(s) && s.date === today() && saleBoutique(s) === b.code) && db.settings.ccList.some((c) => c.actif && c.boutique === b.code))
        add("warning", "🕒", esc(b.nom) + " : aucune vente aujourd'hui", "Vérifiez que la boutique est ouverte et que la caisse est utilisée.");
    });
    const perte = {};
    m.ls.filter((s) => Number(s.pu) < costOf(s)).forEach((s) => { perte[s.nom] = (perte[s.nom] || 0) + (costOf(s) - Number(s.pu)) * Number(s.qte); });
    if (Object.keys(perte).length) add("critical", "⛔", "Produits vendus à perte", Object.keys(perte).map((k) => esc(k) + " (−" + money(Math.round(perte[k])) + ")").join(", ") + " : revoyez le prix de vente.");
    const nonAff = db.settings.ccList.filter((c) => c.actif && !c.boutique);
    if (nonAff.length) add("warning", "⚠", nonAff.length + " CC actif(s) sans boutique", nonAff.map((c) => esc(ccName(c.code))).join(", ") + " : leurs ventes ne sont rattachées à aucune boutique (RH).");
    const aValider = db.products.filter((p) => !p.valide);
    if (aValider.length) add("warning", "📝", aValider.length + " produit(s) à valider", aValider.map((p) => esc(p.nom)).join(", ") + " (rubrique Stock).");
    alerts.sort((a, b) => (a.lvl === b.lvl ? 0 : a.lvl === "critical" ? -1 : 1));
    $("#tb-alert-count").textContent = alerts.length ? "(" + alerts.length + ")" : "";
    $("#tb-alerts").innerHTML = '<div class="alert-list">' + (alerts.length ? alerts.map((a) => a.html).join("") : '<div class="alert-item good"><span class="ico">✅</span><div><b>Rien à signaler</b>Pas de perte, de rupture ni de baisse marquée sur la période.</div></div>') + "</div>";

    // 4. Courbe : chiffre d'affaires et marge brute
    const buckets = trendBuckets(dash.periode, dash.ref);
    const series = buckets.map((k) => metrics(k.du, k.au, bq));
    const future = buckets.map((k) => k.du > today()); // pas de point pour les jours à venir
    $("#tb-trend-title").textContent = "Évolution du chiffre d'affaires et de la marge brute" + (dash.periode === "annee" ? " (par mois)" : " (par jour)");
    drawChart("ch-trend", {
      type: "line",
      data: { labels: buckets.map((k) => k.label), datasets: [
        { label: "Chiffre d'affaires", data: series.map((x, i) => (future[i] ? null : Math.round(x.ca))), borderColor: CH.blue, backgroundColor: CH.blue, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, cubicInterpolationMode: "monotone" },
        { label: "Marge brute", data: series.map((x, i) => (future[i] ? null : Math.round(x.marge))), borderColor: CH.orange, backgroundColor: CH.orange, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, cubicInterpolationMode: "monotone" }
      ] },
      options: baseOptions({ interaction: { mode: "index", intersect: false }, scales: { x: { grid: { display: false }, border: { color: CH.axis }, ticks: { color: CH.muted, maxRotation: 0, autoSkipPadding: 12 } }, y: { beginAtZero: true, grace: "10%", grid: { color: CH.grid, drawTicks: false }, border: { display: false }, ticks: { color: CH.muted, padding: 6, callback: fmtAxis } } } })
    });
    $("#tb-trend-table").innerHTML = '<thead><tr><th>Période</th><th class="num">Chiffre d\'affaires</th><th class="num">Marge brute</th><th class="num">Bénéfice net</th></tr></thead><tbody>' +
      buckets.map((k, i) => "<tr><td>" + esc(k.label) + "</td>" + td(series[i].ca) + td(series[i].marge) + td(series[i].net, series[i].net < 0 ? "neg" : "") + "</tr>").join("") + "</tbody>";

    // 5. Barres : bénéfice net par boutique
    drawChart("ch-boutiques", {
      type: "bar",
      data: { labels: rows.map((r) => r.b.nom), datasets: [{ label: "Bénéfice net", data: rows.map((r) => Math.round(r.m.net)), backgroundColor: CH.blue, borderRadius: 4, borderSkipped: "start", maxBarThickness: 22 }] },
      options: baseOptions({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "Bénéfice net : " + money(c.parsed.x) } } },
        scales: { x: { grid: { color: CH.grid, drawTicks: false }, border: { display: false }, ticks: { color: CH.muted, callback: fmtAxis } }, y: { grid: { display: false }, border: { color: CH.axis }, ticks: { color: "#52514e" } } } })
    });

    // 6. Top 10 produits par marge brute
    const byProd = {};
    m.ls.forEach((s) => { const k = s.code; byProd[k] = byProd[k] || { nom: s.nom, qte: 0, ca: 0, marge: 0 }; byProd[k].qte += Number(s.qte); byProd[k].ca += lineTotal(s); byProd[k].marge += lineTotal(s) - costOf(s) * Number(s.qte); });
    const top = Object.values(byProd).sort((a, b) => b.marge - a.marge).slice(0, 10);
    drawChart("ch-produits", {
      type: "bar",
      data: { labels: top.map((t) => t.nom), datasets: [{ label: "Marge brute", data: top.map((t) => Math.round(t.marge)), backgroundColor: CH.blue, borderRadius: 4, borderSkipped: "start", maxBarThickness: 18 }] },
      options: baseOptions({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "Marge brute : " + money(c.parsed.x) } } },
        scales: { x: { grid: { color: CH.grid, drawTicks: false }, border: { display: false }, ticks: { color: CH.muted, callback: fmtAxis } }, y: { grid: { display: false }, border: { color: CH.axis }, ticks: { color: "#52514e" } } } })
    });
    $("#tb-prod-table").innerHTML = top.length ? '<thead><tr><th>Produit</th><th class="num">Qté</th><th class="num">Chiffre d\'affaires</th><th class="num">Marge brute</th><th class="num">Taux</th></tr></thead><tbody>' +
      top.map((t) => "<tr><td>" + esc(t.nom) + '</td><td class="num">' + num(t.qte) + "</td>" + td(t.ca) + td(t.marge, t.marge < 0 ? "neg" : "") + '<td class="num">' + pct(t.marge, t.ca) + " %</td></tr>").join("") + "</tbody>"
      : '<tbody><tr><td class="empty">Aucune vente sur la période.</td></tr></tbody>';

    // 7. Charges de la période
    const chg = chargesIn(du, au, bq).sort((a, b) => b.date.localeCompare(a.date));
    const byCat = {};
    chg.forEach((c) => { byCat[c.categorie] = (byCat[c.categorie] || 0) + c.montant; });
    const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    drawChart("ch-charges", {
      type: "bar",
      data: { labels: cats, datasets: [{ label: "Charges", data: cats.map((k) => byCat[k]), backgroundColor: CH.blue, borderRadius: 4, borderSkipped: "start", maxBarThickness: 18 }] },
      options: baseOptions({ indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "Charges : " + money(c.parsed.x) } } },
        scales: { x: { grid: { color: CH.grid, drawTicks: false }, border: { display: false }, ticks: { color: CH.muted, callback: fmtAxis } }, y: { grid: { display: false }, border: { color: CH.axis }, ticks: { color: "#52514e" } } } })
    });
    $("#tb-charges-table").innerHTML = chg.length ? '<thead><tr><th>Date</th><th>Boutique</th><th>Catégorie</th><th>Libellé</th><th class="num">Montant</th><th></th></tr></thead><tbody>' +
      chg.map((c) => "<tr><td>" + fmtDate(c.date) + "</td><td>" + (c.boutique ? esc(boutiqueName(c.boutique)) : "<i>Générale</i>") + "</td><td>" + esc(c.categorie) + "</td><td>" + esc(c.libelle) + "</td>" + td(c.montant) +
        '<td><button class="btn small danger" data-chg-del="' + c.id + '">✕</button></td></tr>').join("") +
      '<tr class="total"><td colspan="4">Total des charges</td>' + td(chg.reduce((a, c) => a + c.montant, 0)) + "<td></td></tr></tbody>"
      : '<tbody><tr><td class="empty">Aucune charge enregistrée sur la période. Ajoutez loyer, salaires, électricité… pour obtenir le bénéfice net réel.</td></tr></tbody>';

    // 8. Ventes par CC (période + boutique)
    const ccRows = db.settings.ccList.map((c) => { const ls = m.ls.filter((s) => s.cc === c.code); return { c, ls, ca: ls.reduce((a, s) => a + lineTotal(s), 0), marge: ls.reduce((a, s) => a + lineTotal(s) - costOf(s) * Number(s.qte), 0) }; })
      .filter((x) => x.ls.length).sort((a, b) => b.ca - a.ca);
    $("#d-cc-rows").innerHTML = ccRows.length ? ccRows.map((x) => "<tr><td>" + esc(ccName(x.c.code)) + "</td><td>" + esc(boutiqueName(x.c.boutique)) + '</td><td class="num">' + num(new Set(x.ls.map((s) => s.ticket)).size) +
      "</td>" + td(x.ca) + td(x.marge) + '<td class="num">' + pct(x.ca, m.ca) + " %</td></tr>").join("") : '<tr><td colspan="6" class="empty">Aucune vente sur la période.</td></tr>';

    // 9. Stock par boutique (situation actuelle)
    const stRows = db.boutiques.map((b) => ({ nom: b.nom, st: stockStats(b.code) })).concat([{ nom: "STOCK COMMUN", st: stockStats("ALL"), total: true }]);
    $("#tb-stock-table").innerHTML = '<thead><tr><th>Boutique</th><th class="num">Unités en stock</th><th class="num">Valeur (coût d\'achat)</th><th class="num">Ruptures</th><th class="num">Sous seuil</th></tr></thead><tbody>' +
      stRows.map((r) => '<tr class="' + (r.total ? "total" : "") + '"><td>' + esc(r.nom) + '</td><td class="num">' + num(r.st.unites) + "</td>" + td(r.st.valeur) +
        '<td class="num ' + (r.st.rupt.length ? "neg" : "") + '">' + (r.st.rupt.length ? "⛔ " : "") + r.st.rupt.length + '</td><td class="num">' + (r.st.faible.length ? "⚠ " : "") + r.st.faible.length + "</td></tr>").join("") + "</tbody>";
  }
  $("#d-periode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    dash.periode = b.dataset.p;
    renderDashboard();
  });
  function shiftRef(dir) {
    if (dash.periode === "jour") dash.ref = addDays(dash.ref, dir);
    else if (dash.periode === "semaine") dash.ref = addDays(dash.ref, 7 * dir);
    else if (dash.periode === "mois") dash.ref = addMonths(dash.ref, dir);
    else if (dash.periode === "annee") dash.ref = (Number(dash.ref.slice(0, 4)) + dir) + "-01-01";
    renderDashboard();
  }
  $("#d-prev").addEventListener("click", () => shiftRef(-1));
  $("#d-next").addEventListener("click", () => shiftRef(1));
  $("#d-today").addEventListener("click", () => { dash.ref = today(); renderDashboard(); });
  $("#d-ref").addEventListener("change", () => { if ($("#d-ref").value) { dash.ref = $("#d-ref").value; renderDashboard(); } });
  $("#d-boutique").addEventListener("change", () => { dash.boutique = $("#d-boutique").value; renderDashboard(); });
  $("#tb-bq-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-tb-bq]");
    if (!tr) return;
    dash.boutique = dash.boutique === tr.dataset.tbBq ? "ALL" : tr.dataset.tbBq;
    renderDashboard();
  });
  document.addEventListener("click", (e) => {
    const l = e.target.closest("[data-view-link]");
    if (l) show(l.dataset.viewLink);
  });
  // Charges
  $("#ch-new").addEventListener("click", () => {
    const f = $("#charge-form");
    f.reset();
    f.elements.date.value = today();
    f.elements.boutique.innerHTML = '<option value="">Générale (toutes boutiques)</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    f.elements.boutique.value = dash.boutique && dash.boutique !== "ALL" ? dash.boutique : "";
    $("#charge-dialog").showModal();
  });
  $("#charge-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const row = { date: f.elements.date.value || today(), boutique: f.elements.boutique.value || null, categorie: f.elements.categorie.value, libelle: f.elements.libelle.value.trim(), montant: Number(f.elements.montant.value) };
    if (!(row.montant > 0)) { e.preventDefault(); return toast("Indiquez un montant valide."); }
    act(async () => chk(await sb.from("charges").insert(row)), "Charge enregistrée : " + money(row.montant));
  });
  $("#tb-charges-table").addEventListener("click", (e) => {
    const d = e.target.closest("[data-chg-del]");
    if (!d) return;
    if (!confirm("Supprimer cette charge ?")) return;
    act(async () => chk(await sb.from("charges").delete().eq("id", d.dataset.chgDel)), "Charge supprimée.", d);
  });


  // ---------- Statistiques ----------
  function groupKey(group, date) {
    if (group === "jour") return date;
    if (group === "semaine") return mondayOf(date);
    if (group === "mois") return date.slice(0, 7);
    return date.slice(0, 4);
  }
  function groupLabel(group, key) {
    if (group === "jour") return fmtLong(key);
    if (group === "semaine") return "Semaine du " + fmtDate(key) + " au " + fmtDate(addDays(key, 6));
    if (group === "mois") return cap(fmtMonth(key));
    return key;
  }
  function setStatsRange(kind) {
    const t = today();
    if (kind === "mois") { $("#st-du").value = t.slice(0, 7) + "-01"; $("#st-au").value = lastDayOfMonth(t); }
    else if (kind === "annee") { $("#st-du").value = t.slice(0, 4) + "-01-01"; $("#st-au").value = t.slice(0, 4) + "-12-31"; }
    else {
      const dates = db.sales.map((s) => s.date).filter(Boolean).sort();
      $("#st-du").value = dates[0] || t;
      $("#st-au").value = dates.length && dates[dates.length - 1] > t ? dates[dates.length - 1] : t;
    }
  }
  function statsData() {
    const group = $("#st-group").value, cols = $("#st-cols").value, cc = $("#st-cc").value, metric = $("#st-metric").value;
    const du = $("#st-du").value || "0000-01-01", au = $("#st-au").value || "9999-12-31";
    const list = db.sales.filter((s) => isCountedSale(s) && s.date >= du && s.date <= au && (cc === "ALL" || s.cc === cc));
    const colKey = (s) => (cols === "cc" ? s.cc : vendeurOf(s) || "(sans nom) " + ccLabel(s.cc));
    const colKeys = Array.from(new Set(list.map(colKey)));
    if (cols === "cc") colKeys.sort((a, b) => Number(a) - Number(b));
    else colKeys.sort((a, b) => a.localeCompare(b));
    const colTitle = (k) => (cols === "cc" ? ccName(k) : k);
    const rowKeys = Array.from(new Set(list.map((s) => groupKey(group, s.date)))).sort().reverse();
    const value = (ls) => { const r = summarize(ls); return metric === "ca" ? r.ca : metric === "qte" ? r.qte : r.tickets; };
    const fmt = (v) => (metric === "ca" ? money(v) : num(v));
    const rows = rowKeys.map((rk) => {
      const inRow = list.filter((s) => groupKey(group, s.date) === rk);
      return { label: groupLabel(group, rk), cells: colKeys.map((ck) => value(inRow.filter((s) => colKey(s) === ck))), total: value(inRow) };
    });
    const totals = colKeys.map((ck) => value(list.filter((s) => colKey(s) === ck)));
    return { list, colKeys, colTitle, rows, totals, total: value(list), fmt };
  }
  function renderStats() {
    fillCcSelect($("#st-cc"), true, false);
    if (!$("#st-du").value || !$("#st-au").value) setStatsRange("annee");
    const d = statsData();
    const r = summarize(d.list);
    $("#st-kpis").innerHTML = kpiHtml([
      ["Chiffre d'affaires", money(r.ca)],
      ["Tickets", num(r.tickets)],
      ["Quantités vendues", num(r.qte)],
      ["Panier moyen", money(r.tickets ? Math.round(r.ca / r.tickets) : 0)],
      ["Marge brute estimée", money(r.marge)]
    ]);
    if (!d.rows.length) { $("#st-table").innerHTML = '<tbody><tr><td class="empty">Aucune vente validée sur cette période.</td></tr></tbody>'; return; }
    const multi = d.colKeys.length > 1;
    const head = "<thead><tr><th>Période</th>" + d.colKeys.map((k) => '<th class="num">' + esc(d.colTitle(k)) + "</th>").join("") + (multi ? '<th class="num">Total</th>' : "") + "</tr></thead>";
    const body = "<tbody>" + d.rows.map((row) =>
      "<tr><td>" + esc(row.label) + "</td>" + row.cells.map((v) => '<td class="num">' + (v ? d.fmt(v) : '<span class="muted">—</span>') + "</td>").join("") +
      (multi ? '<td class="num"><b>' + d.fmt(row.total) + "</b></td>" : "") + "</tr>").join("") +
      '<tr class="total"><td>Total</td>' + d.totals.map((v) => '<td class="num">' + d.fmt(v) + "</td>").join("") + (multi ? '<td class="num">' + d.fmt(d.total) + "</td>" : "") + "</tr></tbody>";
    $("#st-table").innerHTML = head + body;
  }
  ["#st-group", "#st-du", "#st-au", "#st-cc", "#st-cols", "#st-metric"].forEach((id) => $(id).addEventListener("change", renderStats));
  document.querySelectorAll("[data-st-range]").forEach((b) => b.addEventListener("click", () => { setStatsRange(b.dataset.stRange); renderStats(); }));
  $("#st-export").addEventListener("click", () => {
    const d = statsData();
    const metricName = $("#st-metric").selectedOptions[0].textContent;
    const head = ["Période"].concat(d.colKeys.map(d.colTitle), ["Total"]);
    const lines = d.rows.map((r) => [r.label].concat(r.cells, [r.total]));
    lines.push(["Total"].concat(d.totals, [d.total]));
    download("statistiques-" + metricName.replace(/\W+/g, "-") + "-" + today() + ".csv", "﻿" + toCsv([head].concat(lines)), "text/csv;charset=utf-8");
  });

  // ---------- Caisse ----------
  function clientNames() {
    const set = new Set(["CLIENT COMPTOIR"]);
    db.sales.forEach((s) => s.client && set.add(s.client));
    return Array.from(set).sort();
  }
  function lockedCc() {
    // Un vendeur lié à un CC actif encaisse toujours sous son propre code.
    if (isAdmin() || !me.cc) return null;
    const cc = ccByCode(me.cc);
    return cc && cc.actif ? cc.code : null;
  }
  function renderCaisse() {
    if (!$("#c-date").value) $("#c-date").value = today();
    $("#c-date").readOnly = !isAdmin();
    if (!isAdmin()) $("#c-date").value = today();
    fillCcSelect($("#c-cc"), false, true);
    const lock = lockedCc();
    if (lock) $("#c-cc").value = lock;
    $("#c-cc").disabled = !!lock;
    $("#c-pu").readOnly = !isAdmin();
    const prodSel = $("#c-product").value;
    $("#c-product").innerHTML = productOptions(prodSel);
    $("#clients-list").innerHTML = clientNames().map((c) => '<option value="' + esc(c) + '">').join("");
    updateProductInfo(!prodSel || !isAdmin());
    renderCart();
  }
  function updateProductInfo(resetPrice) {
    const p = productByCode($("#c-product").value);
    if (!p) { $("#c-stock-info").textContent = ""; return; }
    if (resetPrice !== false) $("#c-pu").value = p.pv;
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    const bq = caisseBoutique();
    const dispo = stockActuel(p, bq) - inCart;
    $("#c-stock-info").innerHTML = "Stock disponible" + (bq ? " (" + esc(boutiqueName(bq)) + ")" : "") + " : <b>" + num(dispo) + "</b> " +
      statutBadge(statutStock(p, bq)) + " · Prix de vente : " + money(p.pv);
  }
  // Boutique de la caisse = boutique du CC qui encaisse (stock commun si le CC n'a pas de boutique)
  function caisseBoutique() { return ccBoutique(lockedCc() || $("#c-cc").value) || ""; }
  $("#c-cc").addEventListener("change", () => updateProductInfo(false));
  function renderCart() {
    $("#c-ticket-num").textContent = cart.length ? "(" + cart.length + " article" + (cart.length > 1 ? "s" : "") + ")" : "";
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
    const pu = isAdmin() ? Number($("#c-pu").value) : (p ? p.pv : 0);
    if (!p) return toast("Choisissez un produit.");
    if (!(qte > 0)) return toast("Quantité invalide.");
    if (!(pu >= 0)) return toast("Prix invalide.");
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    const bq = caisseBoutique();
    if (stockActuel(p, bq) - inCart < qte && !confirm("Stock insuffisant pour " + p.nom + (bq ? " dans " + boutiqueName(bq) : "") + " (disponible : " + (stockActuel(p, bq) - inCart) + "). Ajouter quand même ?")) return;
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
  $("#c-validate").addEventListener("click", async (ev) => {
    if (!cart.length) return toast("Le ticket est vide.");
    const cc = lockedCc() || $("#c-cc").value;
    if (!cc) return toast("Aucun code commercial actif : l'administrateur doit en créer un.");
    const date = isAdmin() ? ($("#c-date").value || today()) : today();
    const ccObj = ccByCode(cc);
    const vendeur = agentAt(ccObj, date) || currentAgent(ccObj) || (isAdmin() ? "" : me.nom);
    const remis = $("#c-remis").value;
    const res = await act(async () => chk(await sb.rpc("create_sale", {
      p_date: date, p_client: $("#c-client").value.trim() || "CLIENT COMPTOIR", p_cc: cc, p_vendeur: vendeur,
      p_num_client: $("#c-numclient").value.trim(), p_adresse: $("#c-adresse").value.trim(),
      p_lines: cart.map((l) => ({ code: l.code, qte: l.qte, pu: l.pu }))
    })), null, ev.currentTarget);
    if (!res.ok) return;
    const ticket = res.data;
    cart = [];
    $("#c-remis").value = "";
    $("#c-numclient").value = "";
    $("#c-adresse").value = "";
    $("#c-client").value = "CLIENT COMPTOIR";
    renderCart();
    toast("Vente enregistrée — ticket N° " + ticket);
    if (confirm("Vente enregistrée (ticket N° " + ticket + "). Afficher le ticket de caisse ?")) {
      $("#f-remis").value = remis;
      show("facture");
      $("#f-ticket").value = String(ticket);
      renderReceipt();
    }
  });

  // ---------- Ventes ----------
  // Boutiques
  function boutiqueByCode(code) { return db.boutiques.find((b) => b.code === code); }
  function boutiqueName(code) { const b = boutiqueByCode(code); return b ? b.nom : code ? code : "Non affecté"; }
  function ccBoutique(code) { const c = ccByCode(code); return c ? c.boutique || "" : ""; }
  function saleBoutique(s) { return s.boutique || ccBoutique(s.cc); }

  function reportHtml(list) {
    const r = summarize(list);
    return '<div><span>Vente totale</span><strong>' + money(r.ca) + "</strong></div>" +
      '<div><span>Quantités</span><strong>' + num(r.qte) + "</strong></div>";
  }
  function heureOf(s) {
    return s.createdAt ? new Date(s.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
  }
  function vAlert(html, kind) {
    $("#v-alert").innerHTML = html ? '<div class="v-alert ' + (kind || "info") + '">' + html + "</div>" : "";
  }
  function fillVentesFilters() {
    const bcur = $("#v-boutique").value || "ALL";
    $("#v-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' +
      db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + (b.actif ? "" : " (inactive)") + "</option>").join("");
    $("#v-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
    fillVentesCc();
  }
  // La liste des CC ne montre que les CC de la boutique choisie.
  function fillVentesCc() {
    const b = $("#v-boutique").value;
    const cur = $("#r-cc").value || "ALL";
    const list = db.settings.ccList.filter((c) => b === "ALL" || c.boutique === b);
    $("#r-cc").innerHTML = '<option value="ALL">Tous les CC' + (b === "ALL" ? "" : " de la boutique") + "</option>" +
      list.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("");
    $("#r-cc").value = list.some((c) => c.code === cur) ? cur : "ALL";
  }
  // Boutique choisie : la liste des CC ne garde que ceux de cette boutique
  // (un CC d'une autre boutique est simplement désélectionné).
  $("#v-boutique").addEventListener("change", () => {
    vAlert("");
    fillVentesCc();
    renderVentes();
  });
  // CC choisi en premier : sa boutique s'affiche directement dans le filtre Boutique.
  $("#r-cc").addEventListener("change", () => {
    const cc = $("#r-cc").value;
    vAlert("");
    if (cc !== "ALL" && $("#v-boutique").value === "ALL") {
      const b = ccBoutique(cc);
      if (b) {
        $("#v-boutique").value = b;
        fillVentesCc();
        $("#r-cc").value = cc;
      } else {
        vAlert("⚠ <b>" + esc(ccName(cc)) + "</b> n'est affecté à aucune boutique (à régler dans RH).", "danger");
      }
    }
    renderVentes();
  });

  function renderVentes() {
    if (!$("#v-date").value) $("#v-date").value = today();
    if (!$("#r-semaine").value) $("#r-semaine").value = today();
    if (!$("#r-mois").value) $("#r-mois").value = today().slice(0, 7);
    fillVentesFilters();

    // Rapports hebdomadaire et mensuel : seulement quand un CC est choisi
    const cc = $("#r-cc").value;
    $("#v-cc-reports").classList.toggle("hidden", cc === "ALL");
    if (cc !== "ALL") {
      const lundi = mondayOf($("#r-semaine").value), dimanche = addDays(lundi, 6), mois = $("#r-mois").value;
      const mine = db.sales.filter((s) => isCountedSale(s) && s.cc === cc);
      $("#r-cc-name1").textContent = "— " + ccName(cc);
      $("#r-cc-name2").textContent = "— " + ccName(cc);
      $("#r-semaine-label").textContent = "Du lundi " + fmtDate(lundi) + " au dimanche " + fmtDate(dimanche);
      $("#r-semaine-res").innerHTML = reportHtml(mine.filter((s) => s.date >= lundi && s.date <= dimanche));
      $("#r-mois-res").innerHTML = reportHtml(mine.filter((s) => (s.date || "").slice(0, 7) === mois));
    }
    renderDayPerf();
    renderSalesHistory();
  }
  // Meilleur vendeur (vert) et CC à encourager (rouge) de la journée,
  // parmi les CC ayant au moins une vente ce jour-là (dans la boutique choisie).
  function renderDayPerf() {
    const jour = $("#v-date").value, b = $("#v-boutique").value;
    const byCc = {};
    db.sales.filter((s) => isCountedSale(s) && s.date === jour && (b === "ALL" || saleBoutique(s) === b))
      .forEach((s) => { byCc[s.cc] = (byCc[s.cc] || 0) + lineTotal(s); });
    const ranked = Object.keys(byCc).map((code) => ({ code, ca: byCc[code] })).sort((x, y) => y.ca - x.ca);
    const scope = b === "ALL" ? "toutes boutiques" : boutiqueName(b);
    if (!ranked.length) { $("#v-perf").innerHTML = '<div class="perf-card muted">Aucune vente ce jour-là (' + esc(scope) + ").</div>"; return; }
    const best = ranked[0];
    let h = '<div class="perf-card best"><small>🏆 Meilleur vendeur du jour · ' + esc(scope) + "</small><b>" + esc(ccName(best.code)) + "</b><span>" + money(best.ca) +
      (b === "ALL" && ccBoutique(best.code) ? " · " + esc(boutiqueName(ccBoutique(best.code))) : "") + "</span></div>";
    if (ranked.length > 1) {
      const worst = ranked[ranked.length - 1];
      h += '<div class="perf-card worst"><small>⚠ CC à encourager · ' + esc(scope) + "</small><b>" + esc(ccName(worst.code)) + "</b><span>" + money(worst.ca) +
        " · " + Math.round((worst.ca / best.ca) * 100) + " % du meilleur — il lui manque <b>" + money(best.ca - worst.ca) + "</b></span></div>";
    } else {
      h += '<div class="perf-card muted">Un seul CC a vendu ce jour-là : pas encore de comparaison.</div>';
    }
    $("#v-perf").innerHTML = h;
  }
  // Historique des ventes du jour (au fur et à mesure), filtré par boutique et CC
  function renderSalesHistory() {
    const jour = $("#v-date").value || today();
    const cc = $("#r-cc").value, b = $("#v-boutique").value;
    const q = $("#v-search").value.trim().toLowerCase();
    $("#v-hist-title").textContent = (jour === today() ? "Ventes d'aujourd'hui" : "Ventes du " + fmtLong(jour)) +
      " — " + (b === "ALL" ? "toutes les boutiques" : boutiqueName(b)) + (cc === "ALL" ? "" : " — " + ccName(cc));
    const rows = db.sales
      .filter((s) => s.date === jour && (b === "ALL" || saleBoutique(s) === b) && (cc === "ALL" || s.cc === cc))
      .filter((s) => !q || [s.nom, s.code, String(s.ticket), vendeurOf(s)].some((v) => String(v || "").toLowerCase().includes(q)))
      .sort((x, y) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")) || y.ticket - x.ticket);

    const admin = isAdmin();
    const badge = (s) => (s.valide === "OUI" ? '<span class="badge ok">OUI</span>' : '<span class="badge mute">NON</span>');
    $("#v-rows").innerHTML = rows.length ? rows.map((s) =>
      '<tr class="' + (s.valide === "OUI" ? "" : "off") + '">' +
      "<td>" + fmtDate(s.date) + "</td><td>" + heureOf(s) + "</td><td>" + esc(s.nom) + pendingBadge(productByCode(s.code)) +
      '</td><td class="num">' + num(s.qte) + '</td><td class="num"><b>' + money(lineTotal(s)) + "</b></td><td>" + ccLabel(s.cc) +
      (vendeurOf(s) ? '<span class="sub">' + esc(vendeurOf(s)) + "</span>" : "") +
      "</td><td>" + esc(boutiqueName(saleBoutique(s))) + '</td><td class="num">' + s.ticket +
      '</td><td class="keep">' + (admin ? '<button class="btn small" data-toggle="' + s.id + '">' + badge(s) + "</button>" : badge(s)) +
      "</td><td>" + (admin ? '<button class="btn small danger" data-del="' + s.id + '" title="Supprimer">✕</button>' : "") + "</td></tr>"
    ).join("") : '<tr><td colspan="10" class="empty">Aucune vente pour cette date avec ces filtres.</td></tr>';

    const valides = rows.filter(isCountedSale);
    const tot = summarize(valides);
    $("#v-foot").innerHTML = '<tr><td colspan="3">TOTAL ' + (cc === "ALL" ? (b === "ALL" ? "DES VENTES" : "— " + esc(boutiqueName(b))) : "— " + esc(ccName(cc))) +
      " · " + num(tot.tickets) + " ticket" + (tot.tickets > 1 ? "s" : "") + '</td><td class="num">' + num(tot.qte) +
      '</td><td class="num">' + money(tot.ca) + '</td><td colspan="5">' + (rows.length !== valides.length ? "(ventes NON exclues)" : "") + "</td></tr>";
    $("#v-refresh-info").innerHTML = (rtLive ? '<span class="live-dot"></span>En direct · ' : "") + "mis à jour à " +
      new Date(lastReload || Date.now()).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  ["#v-date", "#r-semaine", "#r-mois"].forEach((id) => $(id).addEventListener("change", renderVentes));
  $("#v-search").addEventListener("input", renderSalesHistory);
  $("#v-today").addEventListener("click", () => { $("#v-date").value = today(); renderVentes(); });
  // Filet de sécurité si le temps réel est coupé : actualisation toutes les 30 s
  setInterval(async () => {
    if (currentView !== "ventes" || document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
    try { await reload(); renderVentes(); } catch (e) { /* hors ligne : prochain essai dans 30 s */ }
  }, 30000);
  $("#v-rows").addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle]");
    const d = e.target.closest("[data-del]");
    if (t) {
      const s = db.sales.find((x) => x.id === t.dataset.toggle);
      const valide = s.valide === "OUI" ? "NON" : "OUI";
      act(async () => chk(await sb.from("sales").update({ valide }).eq("id", s.id)), "Ticket " + s.ticket + " : " + valide, t);
    } else if (d) {
      const s = db.sales.find((x) => x.id === d.dataset.del);
      if (!confirm("Supprimer définitivement cette ligne (ticket " + s.ticket + ", " + s.nom + ") ?\nAstuce : passez-la plutôt à NON pour garder l'historique.")) return;
      act(async () => chk(await sb.from("sales").delete().eq("id", s.id)), "Ligne supprimée.", d);
    }
  });
  $("#v-export").addEventListener("click", () => {
    if (!isAdmin()) return toast("Export réservé à l'administrateur.");
    const head = ["Date", "Heure", "Ticket", "Boutique", "Client", "Produit", "Code_Produit", "Quantite", "PU_Vente", "Total_Vente", "Code_CC", "Vendeur", "Validation", "N_Client", "Adresse_Client"];
    const lines = db.sales.map((s) => [s.date, heureOf(s), s.ticket, boutiqueName(saleBoutique(s)), s.client, s.nom, s.code, s.qte, s.pu, lineTotal(s), s.cc, vendeurOf(s), s.valide, s.numClient || "", s.adresseClient || ""]);
    download("ventes-" + today() + ".csv", "﻿" + toCsv([head].concat(lines)), "text/csv;charset=utf-8");
  });

  // ---------- Stock ----------
  function renderStock() {
    const admin = isAdmin();
    const q = $("#s-search").value.trim().toLowerCase();
    // Filtre boutique : stock commun ou stock d'une seule boutique
    const bcur = $("#s-boutique").value || "ALL";
    $("#s-boutique").innerHTML = '<option value="ALL">Stock commun (toutes les boutiques)</option>' +
      db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    $("#s-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
    const bq = $("#s-boutique").value;
    $("#s-title").textContent = bq === "ALL" ? "Stock commun — toutes les boutiques" : "Stock — " + boutiqueName(bq);
    const list = db.products.filter((p) => !q || (p.nom + " " + p.code + " " + p.categorie).toLowerCase().includes(q));
    const stockTotal = db.products.reduce((a, p) => a + stockActuel(p, bq), 0);
    const valeur = db.products.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.cmp), 0);
    const k = [["Produits", db.products.length], ["Stock total", num(stockTotal)]];
    if (admin) k.push(["Valeur du stock (achat)", money(valeur)]);
    k.push(["En rupture", db.products.filter((p) => statutStock(p, bq) === "RUPTURE").length, "danger"]);
    k.push(["Sous seuil", db.products.filter((p) => statutStock(p, bq) === "STOCK FAIBLE").length, "warn"]);
    const nPending = db.products.filter((p) => !p.valide).length;
    if (nPending) k.push(["À valider", nPending, "warn"]);
    $("#stock-kpis").innerHTML = kpiHtml(k);

    // Produits à valider en premier
    const sorted = list.slice().sort((a, b) => (a.valide === b.valide ? 0 : a.valide ? 1 : -1));
    $("#s-rows").innerHTML = sorted.length ? sorted.map((p) =>
      '<tr class="' + (p.valide ? "" : "pending") + '"><td>' + esc(p.code) + "</td><td>" + esc(p.nom) + pendingBadge(p) +
      (p.valide ? "" : '<span class="sub">Créé par ' + esc(p.creePar || "—") + (p.creeParCc ? " (" + ccLabel(p.creeParCc) + ")" : "") +
        (p.creeLe ? " le " + fmtDate(String(p.creeLe).slice(0, 10)) : "") + "</span>") +
      "</td><td>" + esc(p.categorie) + '</td><td class="num admin-only">' + num(Math.round(p.cmp)) + '</td><td class="num admin-only">' +
      (lastPurchase(p.code) ? num(Math.round(lastPurchase(p.code).pu)) : '<span class="muted">—</span>') + '</td><td class="num">' + num(p.pv) +
      '</td><td class="num">' + num(stockInitialOf(p, bq)) + '</td><td class="num">' + num(p.stockMin) + '</td><td class="num">' + num(totalEntrees(p.code, bq)) + '</td><td class="num">' + num(totalVentes(p.code, bq)) +
      '</td><td class="num"><b>' + num(stockActuel(p, bq)) + "</b></td><td>" + statutBadge(statutStock(p, bq)) + "</td><td>" +
      (admin && !p.valide ? '<button class="btn small success" data-pvalid="' + esc(p.code) + '">✓ Valider</button> ' : "") +
      (admin ? '<button class="btn small" data-prices="' + esc(p.code) + '">Prix</button> <button class="btn small" data-edit="' + esc(p.code) + '">Modifier</button> <button class="btn small danger" data-pdel="' + esc(p.code) + '">✕</button>' : "") +
      "</td></tr>"
    ).join("") : '<tr><td colspan="13" class="empty">Aucun produit.</td></tr>';
  }
  $("#s-search").addEventListener("input", renderStock);
  $("#s-boutique").addEventListener("change", renderStock);

  // Achats avec prix (lignes de course validées) d'un produit, du plus récent au plus ancien.
  function purchases(code) {
    return db.entries
      .filter((x) => x.code === code && x.statut === "Validée" && x.prixTotal != null && x.qte > 0)
      .map((x) => ({ x, pu: x.prixTotal / x.qte }))
      .sort((a, b) => (b.x.date || "").localeCompare(a.x.date || "") || String(b.x.createdAt || "").localeCompare(String(a.x.createdAt || "")));
  }
  function lastPurchase(code) { return purchases(code)[0] || null; }
  function openPrices(p) {
    const list = purchases(p.code);
    $("#ph-title").textContent = "Prix d'achat — " + p.nom;
    $("#ph-info").textContent = "Coût moyen actuel : " + money(Math.round(p.cmp)) + " · Prix de vente : " + money(p.pv) +
      " · Marge unitaire actuelle : " + money(Math.round(p.pv - p.cmp));
    $("#ph-table").innerHTML = list.length
      ? '<thead><tr><th>Date</th><th class="num">Quantité</th><th class="num">Prix total</th><th class="num">Prix unitaire</th><th class="num">Coût de revient</th><th>CC</th><th>Saisi par</th></tr></thead><tbody>' +
        list.map(({ x, pu }) => "<tr><td>" + fmtDate(x.date) + '</td><td class="num">' + num(x.qte) + '</td><td class="num">' + num(x.prixTotal) +
          '</td><td class="num">' + num(Math.round(pu)) + '</td><td class="num">' + num(Math.round(x.coutUnitaire || pu)) + "</td><td>" +
          (x.cc ? ccLabel(x.cc) : "Admin") + "</td><td>" + esc(x.saisiPar || "—") + "</td></tr>").join("") + "</tbody>"
      : '<tbody><tr><td class="empty">Aucun achat avec prix enregistré pour ce produit.</td></tr></tbody>';
    $("#price-dialog").showModal();
  }

  let editingCode = null;
  function openProduct(p) {
    editingCode = p ? p.code : null;
    const f = $("#product-form");
    $("#pd-title").textContent = p ? "Modifier " + p.nom : "Nouveau produit";
    const nums = db.products.map((x) => Number((x.code.match(/(\d+)$/) || [])[1]) || 0);
    const n = (nums.length ? Math.max.apply(null, nums) : 0) + 1;
    const def = p || { code: "ART-" + String(n).padStart(3, "0"), nom: "", categorie: "Boisson", pa: 0, pv: 0, stockInitial: 0, stockMin: 5 };
    ["code", "nom", "categorie", "pa", "pv", "stockInitial", "stockMin"].forEach((k) => { f.elements[k].value = def[k]; });
    $("#cat-list").innerHTML = Array.from(new Set(db.products.map((x) => x.categorie))).map((c) => '<option value="' + esc(c) + '">').join("");
    $("#product-dialog").showModal();
  }
  $("#s-new").addEventListener("click", () => openProduct(null));
  $("#s-rows").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-pdel]");
    const pr = e.target.closest("[data-prices]");
    const pv = e.target.closest("[data-pvalid]");
    if (pv) {
      const p = productByCode(pv.dataset.pvalid);
      if (!confirm("Valider le produit « " + p.nom + " » ?\nCatégorie : " + p.categorie + "\nPrix de vente : " + money(p.pv) + "\n\nVérifiez ces informations (bouton Modifier) avant de valider.")) return;
      return act(async () => chk(await sb.from("products").update({ valide: true }).eq("code", p.code)), "Produit validé : " + p.nom, pv);
    }
    if (pr) return openPrices(productByCode(pr.dataset.prices));
    if (ed) openProduct(productByCode(ed.dataset.edit));
    if (del) {
      const code = del.dataset.pdel;
      const used = db.sales.some((s) => s.code === code) || db.entries.some((x) => x.code === code);
      if (used) return alert("Ce produit a des ventes ou des entrées enregistrées : il ne peut pas être supprimé.");
      if (!confirm("Supprimer le produit " + code + " ?")) return;
      act(async () => chk(await sb.from("products").delete().eq("code", code)), "Produit supprimé.", del);
    }
  });
  $("#product-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const p = {
      code: f.elements.code.value.trim(),
      nom: f.elements.nom.value.trim(),
      categorie: f.elements.categorie.value.trim(),
      pa: Number(f.elements.pa.value) || 0,
      pv: Number(f.elements.pv.value) || 0,
      stock_initial: Number(f.elements.stockInitial.value) || 0,
      stock_min: Number(f.elements.stockMin.value) || 0
    };
    if (!p.code || !p.nom) { e.preventDefault(); return toast("Code et désignation obligatoires."); }
    if (db.products.some((x) => x.code === p.code && x.code !== editingCode)) { e.preventDefault(); return toast("Le code " + p.code + " existe déjà."); }
    const row = { code: p.code, nom: p.nom, categorie: p.categorie, pv: p.pv, stock_initial: p.stock_initial, stock_min: p.stock_min };
    const old = editingCode;
    act(async () => {
      if (old) chk(await sb.from("products").update(row).eq("code", old));
      else chk(await sb.from("products").insert(row));
      chk(await sb.from("product_costs").upsert({ code: p.code, pa: p.pa }));
    }, "Produit enregistré.");
  });

  // ---------- Entrées ----------
  const EDIT_WINDOW_MS = 2 * 3600 * 1000; // délai de modification pour un vendeur (vérifié aussi par la base)
  const openDays = new Set();
  let entriesFirstRender = true;

  function canEditEntry(x) {
    if (isAdmin()) return true;
    return x.createdBy === me.id && x.createdAt && Date.now() - new Date(x.createdAt).getTime() < EDIT_WINDOW_MS;
  }
  function remainingTime(x) {
    const min = Math.max(0, Math.ceil((EDIT_WINDOW_MS - (Date.now() - new Date(x.createdAt).getTime())) / 60000));
    return min >= 60 ? Math.floor(min / 60) + " h " + String(min % 60).padStart(2, "0") : min + " min";
  }
  // ----- Course (achat au marché) : saisie -----
  let courseLines = [];
  let editingCourseId = null;
  let coPhotoBlob = null;        // nouvelle photo (compressée) à envoyer
  let coPhotoPath = "";          // photo déjà enregistrée (modification)
  let coPhotoRemoved = false;    // photo existante retirée
  const openCourses = new Set();
  const photoUrls = {};          // cache des liens signés { path: { url, exp } }

  function newCourseLine() { return { code: "", qte: "", total: "" }; }
  function setPhotoPreview(url, label) {
    $("#co-photo-preview").innerHTML = url
      ? '<img src="' + esc(url) + '" alt="Reçu" data-zoom="' + esc(url) + '"><span>' + esc(label || "") + '</span><button class="btn small danger" id="co-photo-rm">Retirer la photo</button>'
      : "<span>" + (isAdmin() ? "Aucune photo (facultatif pour l'admin)." : "Aucune photo — <b>obligatoire</b>.") + " Sur téléphone, le bouton ouvre l'appareil photo.</span>";
    $("#co-photo-req").classList.toggle("hidden", isAdmin());
  }
  function resetCourseForm() {
    editingCourseId = null;
    courseLines = [newCourseLine()];
    ["#co-retrait", "#co-transport", "#co-autres"].forEach((id) => { $(id).value = 0; });
    ["#co-autres-lib", "#co-marche", "#co-tel"].forEach((id) => { $(id).value = ""; });
    $("#co-date").value = today();
    $("#co-title").textContent = "Nouvelle course (achat au marché)";
    $("#co-cancel-edit").classList.add("hidden");
    $("#co-save").textContent = "Enregistrer la course";
    coPhotoBlob = null; coPhotoPath = ""; coPhotoRemoved = false;
    $("#co-photo").value = "";
    setPhotoPreview(null);
  }
  // Calcule prix unitaire, part des frais, coût de revient et marge de chaque ligne (même règle que la base).
  function computeCourse(lines, retrait, transport, autres) {
    const valid = lines.filter((l) => l.code && Number(l.qte) > 0 && l.total !== "" && Number(l.total) >= 0);
    const sousTotal = valid.reduce((a, l) => a + Number(l.total), 0);
    const frais = (Number(retrait) || 0) + (Number(transport) || 0) + (Number(autres) || 0);
    const n = valid.length;
    let margeTotale = 0;
    const rows = lines.map((l) => {
      if (!valid.includes(l)) return { ok: false };
      const p = productByCode(l.code);
      const qte = Number(l.qte), total = Number(l.total);
      const part = sousTotal > 0 ? (frais * total) / sousTotal : frais / n;
      const pu = total / qte;
      const cr = (total + part) / qte;
      const pv = p ? Number(p.pv) : 0;
      const mu = pv - cr;
      margeTotale += mu * qte;
      return { ok: true, pu, part, cr, pv, mu, mt: mu * qte, pct: pv > 0 ? (mu / pv) * 100 : 0 };
    });
    return {
      rows, sousTotal, frais, totalCourse: sousTotal + frais, margeTotale,
      ventePotentielle: valid.reduce((a, l) => a + Number(l.qte) * ((productByCode(l.code) || {}).pv || 0), 0)
    };
  }
  function money0(n) { return money(Math.round(n)); }
  function margeHtml(v, pct) {
    return '<span class="' + (v >= 0 ? "pos" : "neg") + '">' + money0(v) + (pct != null ? " (" + Math.round(pct) + " %)" : "") + "</span>";
  }
  // Cadre récapitulatif (utilisé dans le formulaire et dans l'historique).
  function summaryBox(s) {
    const frais = s.retrait + s.transport + s.autres;
    return '<div class="sum-row"><span>Sous-total des achats</span><b>' + money0(s.sousTotal) + "</b></div>" +
      '<div class="sum-row"><span>Frais de retrait mobile money</span><span>' + money0(s.retrait) + "</span></div>" +
      '<div class="sum-row"><span>Transport aller-retour</span><span>' + money0(s.transport) + "</span></div>" +
      '<div class="sum-row"><span>' + esc(s.autresLib || "Autres frais") + "</span><span>" + money0(s.autres) + "</span></div>" +
      '<div class="sum-row"><span>Total des frais</span><span>' + money0(frais) + "</span></div>" +
      '<div class="sum-row big"><span>TOTAL DE LA COURSE</span><span>' + money0(s.sousTotal + frais) + "</span></div>" +
      '<div class="sum-row"><span>Valeur de vente du stock acheté</span><span>' + money0(s.vente) + "</span></div>" +
      '<div class="sum-row"><span>Marge potentielle totale</span><b>' + margeHtml(s.marge, s.vente > 0 ? (s.marge / s.vente) * 100 : null) + "</b></div>";
  }
  function renderCourseForm() {
    const admin = isAdmin();
    $("#co-date").readOnly = !admin;
    if (!$("#co-date").value) $("#co-date").value = today();
    if (!admin && !editingCourseId) $("#co-date").value = today();
    const ecc = $("#co-cc");
    const ebq = $("#co-boutique");
    if (admin) {
      const cur = ecc.value;
      ecc.innerHTML = '<option value="">— Aucun (admin) —</option>' + ccOptions(false, cur, false);
      ecc.value = Array.from(ecc.options).some((o) => o.value === cur) ? cur : "";
      ecc.disabled = false;
      const bcur = ebq.value;
      ebq.innerHTML = '<option value="">— Celle du CC choisi —</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      ebq.value = db.boutiques.some((b) => b.code === bcur) ? bcur : "";
      ebq.disabled = false;
    } else {
      ecc.innerHTML = me.cc ? '<option value="' + esc(me.cc) + '">' + esc(ccName(me.cc)) + "</option>" : '<option value="">— Aucun CC lié —</option>';
      ecc.disabled = true;
      const mine = ccBoutique(me.cc);
      ebq.innerHTML = '<option value="' + esc(mine) + '">' + esc(mine ? boutiqueName(mine) : "— Aucune boutique —") + "</option>";
      ebq.disabled = true;
    }
    // Suggestions : marchés et numéros déjà utilisés
    const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort();
    $("#marches-list").innerHTML = uniq(db.courses.map((c) => c.marche)).map((m) => '<option value="' + esc(m) + '">').join("");
    $("#tels-list").innerHTML = uniq(db.courses.map((c) => c.tel)).map((t) => '<option value="' + esc(t) + '">').join("");
    if (!$("#co-photo-preview").innerHTML) setPhotoPreview(null);

    if (!courseLines.length) courseLines = [newCourseLine()];
    $("#co-lines").innerHTML = courseLines.map((l, i) =>
      '<tr data-idx="' + i + '" class="' + (l.code && productByCode(l.code) && !productByCode(l.code).valide ? "pending" : "") + '"><td><select data-f="code"><option value="">— Choisir —</option>' +
      productOptions(l.code) + '<option value="__new__">➕ Nouveau produit…</option></select>' + pendingBadge(productByCode(l.code)) + "</td>" +
      '<td class="num"><input type="number" min="1" data-f="qte" value="' + esc(l.qte) + '"></td>' +
      '<td class="num"><input type="number" min="0" data-f="total" value="' + esc(l.total) + '"></td>' +
      '<td class="num" data-c="pu"></td><td class="num" data-c="pv"></td><td class="num" data-c="mu"></td>' +
      '<td><button class="btn small danger" data-rmline="' + i + '" title="Retirer">✕</button></td></tr>'
    ).join("");
    updateCourseCalc();
  }
  function updateCourseCalc() {
    const c = computeCourse(courseLines, $("#co-retrait").value, $("#co-transport").value, $("#co-autres").value);
    c.rows.forEach((r, i) => {
      const tr = document.querySelector('#co-lines tr[data-idx="' + i + '"]');
      if (!tr) return;
      const set = (k, v) => { tr.querySelector('[data-c="' + k + '"]').innerHTML = v; };
      if (!r.ok) { ["pu", "pv", "mu"].forEach((k) => set(k, '<span class="muted">—</span>')); return; }
      set("pu", money0(r.pu));
      set("pv", money0(r.pv));
      set("mu", margeHtml(r.mu, r.pct));
    });
    $("#co-summary").innerHTML = summaryBox({
      sousTotal: c.sousTotal, retrait: Number($("#co-retrait").value) || 0, transport: Number($("#co-transport").value) || 0,
      autres: Number($("#co-autres").value) || 0, autresLib: $("#co-autres-lib").value.trim(), vente: c.ventePotentielle, marge: c.margeTotale
    });
  }
  $("#co-lines").addEventListener("input", (e) => {
    const el = e.target.closest("[data-f]");
    if (!el || el.dataset.f === "code") return;
    courseLines[Number(el.closest("tr").dataset.idx)][el.dataset.f] = el.value;
    updateCourseCalc();
  });
  $("#co-lines").addEventListener("change", (e) => {
    const el = e.target.closest('[data-f="code"]');
    if (!el) return;
    const idx = Number(el.closest("tr").dataset.idx);
    if (el.value === "__new__") {
      el.value = courseLines[idx].code || "";
      return openNewProduct(idx);
    }
    courseLines[idx].code = el.value;
    renderCourseForm();
  });

  // Création d'un produit manquant depuis une course (à valider par l'admin si créé par un CC)
  let newProdLine = null;
  function openNewProduct(idx) {
    newProdLine = idx;
    const f = $("#newprod-form");
    f.reset();
    const cats = Array.from(new Set(db.products.map((p) => p.categorie).filter(Boolean))).sort();
    f.elements.categorie.innerHTML = '<option value="">— Choisir —</option>' + cats.map((c) => '<option value="' + esc(c) + '">' + esc(c) + "</option>").join("");
    $("#np-help").style.display = isAdmin() ? "none" : "";
    $("#newprod-dialog").showModal();
    f.elements.nom.focus();
  }
  $("#newprod-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const nom = f.elements.nom.value.trim(), categorie = f.elements.categorie.value, pv = Number(f.elements.pv.value);
    if (nom.length < 2) { e.preventDefault(); return toast("Indiquez la désignation."); }
    if (!categorie) { e.preventDefault(); return toast("Choisissez la catégorie."); }
    if (!(pv > 0)) { e.preventDefault(); return toast("Indiquez le prix de vente."); }
    const idx = newProdLine;
    act(async () => chk(await sb.rpc("create_product", { p_nom: nom, p_categorie: categorie, p_pv: pv })),
      isAdmin() ? "Produit créé." : "Produit créé — en attente de validation par l'administrateur.").then((r) => {
      if (!r.ok || idx == null || !courseLines[idx]) return;
      courseLines[idx].code = r.data;
      renderCourseForm();
    });
  });
  $("#co-lines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rmline]");
    if (!b) return;
    courseLines.splice(Number(b.dataset.rmline), 1);
    renderCourseForm();
  });
  $("#co-add-line").addEventListener("click", () => {
    courseLines.push(newCourseLine());
    renderCourseForm();
    const last = document.querySelector("#co-lines tr:last-child select");
    if (last) last.focus();
  });
  ["#co-retrait", "#co-transport", "#co-autres", "#co-autres-lib"].forEach((id) => $(id).addEventListener("input", updateCourseCalc));
  $("#co-cancel-edit").addEventListener("click", () => { resetCourseForm(); renderCourseForm(); });

  // Photo du reçu : réduite à 1600 px et compressée en JPEG avant l'envoi (connexion lente).
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob((b) => (b ? resolve(b) : reject(new Error("Photo illisible"))), "image/jpeg", 0.72);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Photo illisible")); };
      img.src = url;
    });
  }
  $("#co-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      coPhotoBlob = await compressImage(file);
      coPhotoRemoved = false;
      setPhotoPreview(URL.createObjectURL(coPhotoBlob), "Photo prête (" + Math.round(coPhotoBlob.size / 1024) + " Ko)");
    } catch (err) {
      toast("Impossible de lire cette photo.");
    }
  });
  $("#co-photo-preview").addEventListener("click", (e) => {
    if (e.target.closest("#co-photo-rm")) {
      coPhotoBlob = null;
      if (coPhotoPath) coPhotoRemoved = true;
      $("#co-photo").value = "";
      setPhotoPreview(null);
      return;
    }
    const z = e.target.closest("[data-zoom]");
    if (z) showPhoto(z.dataset.zoom, "Reçu");
  });
  async function signedPhotoUrl(path) {
    const hit = photoUrls[path];
    if (hit && hit.exp > Date.now()) return hit.url;
    const data = chk(await sb.storage.from("recus").createSignedUrl(path, 3600));
    photoUrls[path] = { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 };
    return data.signedUrl;
  }
  function showPhoto(url, title) {
    $("#pdlg-title").textContent = title || "Reçu";
    $("#pdlg-img").src = url;
    $("#pdlg-open").href = url;
    $("#photo-dialog").showModal();
  }
  function uuid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  $("#co-save").addEventListener("click", (ev) => {
    const filled = courseLines.filter((l) => l.code || l.qte !== "" || l.total !== "");
    const marche = $("#co-marche").value.trim();
    const tel = $("#co-tel").value.trim();
    if (!marche) { $("#co-marche").focus(); return toast("Indiquez le marché de la course."); }
    if (tel.replace(/\D/g, "").length < 8) { $("#co-tel").focus(); return toast("Indiquez le téléphone du fournisseur (8 chiffres minimum)."); }
    if (!filled.length) return toast("Ajoutez au moins un produit.");
    const hasPhoto = !!coPhotoBlob || (!!coPhotoPath && !coPhotoRemoved);
    if (!isAdmin() && !hasPhoto) return toast("La photo du reçu est obligatoire : touchez « 📷 Photo du reçu ».");
    for (const l of filled) {
      if (!l.code) return toast("Choisissez le produit de chaque ligne.");
      if (!(Number(l.qte) > 0)) return toast("Quantité invalide pour " + (productByCode(l.code) || {}).nom + ".");
      if (l.total === "" || !(Number(l.total) >= 0)) return toast("Indiquez le prix total payé pour " + (productByCode(l.code) || {}).nom + ".");
    }
    const date = isAdmin() ? ($("#co-date").value || today()) : today();
    const wasEditing = !!editingCourseId;
    const btn = ev.currentTarget;
    act(async () => {
      let recuPath = null; // null = garder la photo existante
      if (coPhotoBlob) {
        btn.textContent = "Envoi de la photo…";
        const path = "courses/" + date.slice(0, 7) + "/" + uuid() + ".jpg";
        chk(await sb.storage.from("recus").upload(path, coPhotoBlob, { contentType: "image/jpeg", upsert: false }));
        recuPath = path;
      } else if (coPhotoRemoved) {
        recuPath = "";
      }
      btn.textContent = "Enregistrement…";
      return chk(await sb.rpc("save_course", {
        p_id: editingCourseId, p_date: date, p_cc: isAdmin() ? $("#co-cc").value : null,
        p_frais_retrait: Number($("#co-retrait").value) || 0, p_frais_transport: Number($("#co-transport").value) || 0,
        p_autres_frais: Number($("#co-autres").value) || 0, p_autres_libelle: $("#co-autres-lib").value.trim(),
        p_obs: "",
        p_lines: filled.map((l) => ({ code: l.code, qte: Number(l.qte), prix_total: Number(l.total) })),
        p_marche: marche, p_fournisseur_tel: tel, p_recu_path: recuPath, p_boutique: isAdmin() ? $("#co-boutique").value : null
      }));
    }, wasEditing ? "Course modifiée." : "Course enregistrée, stock mis à jour.", btn).then((r) => {
      btn.textContent = editingCourseId ? "Enregistrer les modifications" : "Enregistrer la course";
      if (!r.ok) return;
      openDays.add(date);
      if (r.data) openCourses.add(r.data);
      resetCourseForm();
      renderCourseForm();
      renderEntryHistory();
    });
  });
  function openCourseEdit(c) {
    editingCourseId = c.id;
    courseLines = db.entries.filter((x) => x.courseId === c.id).map((x) => ({ code: x.code, qte: String(x.qte), total: String(x.prixTotal == null ? "" : x.prixTotal) }));
    $("#co-retrait").value = c.retrait;
    $("#co-transport").value = c.transport;
    $("#co-autres").value = c.autres;
    $("#co-autres-lib").value = c.autresLib;
    $("#co-marche").value = c.marche;
    $("#co-tel").value = c.tel;
    $("#co-date").value = c.date || today();
    coPhotoBlob = null; coPhotoRemoved = false; coPhotoPath = c.recuPath || "";
    $("#co-photo").value = "";
    setPhotoPreview(null);
    if (coPhotoPath) signedPhotoUrl(coPhotoPath).then((u) => setPhotoPreview(u, "Photo enregistrée — prenez-en une autre pour la remplacer")).catch(() => {});
    renderCourseForm();
    if (isAdmin()) { $("#co-cc").value = c.cc || ""; $("#co-boutique").value = c.boutique || ""; }
    $("#co-title").textContent = "Modification de la course du " + fmtDate(c.date) + " (" + (c.saisiPar || "—") + ")";
    $("#co-cancel-edit").classList.remove("hidden");
    $("#co-save").textContent = "Enregistrer les modifications";
    $("#course-card").scrollIntoView({ behavior: "smooth" });
  }

  function renderEntrees() {
    if (!courseLines.length && !editingCourseId) resetCourseForm();
    renderCourseForm();
    const fcur = $("#eh-cc").value || "ALL";
    $("#eh-cc").innerHTML = '<option value="ALL">Tous les CC</option>' +
      db.settings.ccList.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("") +
      '<option value="NONE">Sans CC (admin)</option>';
    $("#eh-cc").value = Array.from($("#eh-cc").options).some((o) => o.value === fcur) ? fcur : "ALL";
    renderEntryHistory();
  }

  // ----- Historique : jours → courses (cliquer pour le détail) + entrées simples -----
  function canEditCourse(c) {
    if (isAdmin()) return true;
    return c.createdBy === me.id && c.createdAt && Date.now() - new Date(c.createdAt).getTime() < EDIT_WINDOW_MS;
  }
  function courseLinesOf(c) { return db.entries.filter((x) => x.courseId === c.id); }
  function courseTotal(c) { return courseLinesOf(c).reduce((a, x) => a + (x.prixTotal || 0), 0) + c.retrait + c.transport + c.autres; }
  function renderEntryHistory() {
    const fcc = $("#eh-cc").value;
    const q = "";
    const ccOk = (cc) => (fcc === "ALL" ? true : fcc === "NONE" ? !cc : cc === fcc);
    const matches = (code, extra) => {
      if (!q) return true;
      const p = productByCode(code);
      return ((p ? p.nom : "") + " " + code + " " + (extra || "")).toLowerCase().includes(q);
    };
    const courses = db.courses.filter((c) => ccOk(c.cc) &&
      (!q || courseLinesOf(c).some((x) => matches(x.code, [c.saisiPar, c.obs, c.marche, c.tel].join(" ")))));
    const simples = db.entries.filter((x) => !x.courseId && ccOk(x.cc) && matches(x.code, (x.saisiPar || "") + " " + (x.obs || "")));

    const sel = $("#eh-date");
    const curDate = sel.value;
    const dates = Array.from(new Set(courses.map((c) => c.date || "").concat(simples.map((x) => x.date || "")))).sort().reverse();
    sel.innerHTML = '<option value="">Toutes les dates</option>' +
      dates.map((d) => '<option value="' + esc(d) + '">' + (d ? cap(fmtLong(d)) : "Sans date") + "</option>").join("");
    sel.value = dates.includes(curDate) ? curDate : "";
    const fdate = sel.value;
    if (fdate) openDays.add(fdate);
    const keys = fdate ? [fdate] : dates;
    if (entriesFirstRender && keys.length) { openDays.add(keys[0]); entriesFirstRender = false; }
    if (!keys.length) { $("#e-days").innerHTML = '<tr><td colspan="7" class="empty">Aucune entrée de stock.</td></tr>'; return; }

    $("#e-days").innerHTML = keys.map((d) => {
      const dc = courses.filter((c) => (c.date || "") === d).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const ds = simples.filter((x) => (x.date || "") === d).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const validLines = dc.filter((c) => c.statut === "Validée").flatMap(courseLinesOf).concat(ds.filter((x) => x.statut === "Validée"));
      const montant = dc.filter((c) => c.statut === "Validée").reduce((a, c) => a + courseTotal(c), 0);
      const ccs = Array.from(new Set(dc.map((c) => c.cc).concat(ds.map((x) => x.cc)).map((cc) => (cc ? ccLabel(cc) : "Admin")))).join(", ");
      const who = Array.from(new Set(dc.map((c) => c.saisiPar).concat(ds.map((x) => x.saisiPar)).filter(Boolean))).join(", ") || "—";
      const open = openDays.has(d);
      let h = '<tr class="clickable' + (open ? " selected" : "") + '" data-day="' + esc(d) + '"><td class="caret">' + (open ? "▾" : "▸") + "</td><td><b>" +
        (d ? cap(fmtLong(d)) : "Sans date") + "</b>" + (dc.length ? ' <span class="muted">· ' + dc.length + " course" + (dc.length > 1 ? "s" : "") + "</span>" : "") +
        '</td><td class="num">' + new Set(validLines.map((x) => x.code)).size + '</td><td class="num">' + num(validLines.reduce((a, x) => a + Number(x.qte), 0)) +
        '</td><td class="num">' + (montant ? money0(montant) : '<span class="muted">—</span>') + "</td><td>" + esc(ccs) + "</td><td>" + esc(who) + "</td></tr>";
      if (open) {
        h += '<tr class="detail"><td colspan="7">' +
          (dc.length ? '<p class="hint">Cliquez sur une course pour voir son détail, son résumé et la photo du reçu.</p>' : "") +
          dc.map(courseReceipt).join("") +
          (ds.length ? '<h3 class="sub-title">Entrées sans détail de prix</h3>' + entryDetail(ds) : "") + "</td></tr>";
      }
      return h;
    }).join("");
    loadVisiblePhotos();
  }
  function courseReceipt(c) {
    const admin = isAdmin();
    const lines = courseLinesOf(c);
    const sousTotal = lines.reduce((a, x) => a + (x.prixTotal || 0), 0);
    let margeTot = 0, venteTot = 0;
    const rows = lines.map((x) => {
      const p = productByCode(x.code);
      const pv = p ? Number(p.pv) : 0;
      const pu = x.prixTotal != null ? x.prixTotal / x.qte : 0;
      const cr = x.coutUnitaire != null ? x.coutUnitaire : pu;
      const mu = pv - cr;
      margeTot += mu * x.qte;
      venteTot += pv * x.qte;
      return '<tr class="' + (p && !p.valide ? "pending" : "") + '"><td>' + esc(p ? p.nom : x.code) + pendingBadge(p) + '</td><td class="num">' + num(x.qte) + '</td><td class="num">' + money0(x.prixTotal || 0) +
        '</td><td class="num">' + money0(pu) + '</td><td class="num">' + money0(x.fraisPart || 0) +
        '</td><td class="num">' + money0(pv) + '</td><td class="num">' + margeHtml(mu, pv > 0 ? (mu / pv) * 100 : null) + '</td><td class="num">' + margeHtml(mu * x.qte) + "</td></tr>";
    }).join("");
    const heure = c.createdAt ? new Date(c.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
    const badge = c.statut === "Validée" ? '<span class="badge ok">Validée</span>' : '<span class="badge mute">Annulée</span>';
    const open = openCourses.has(c.id);
    let actions;
    if (canEditCourse(c)) {
      actions = '<button class="btn small" data-cedit="' + c.id + '">Modifier</button> ' +
        '<button class="btn small" data-ctoggle="' + c.id + '">' + (c.statut === "Validée" ? "Annuler" : "Rétablir") + "</button> " +
        (admin ? '<button class="btn small danger" data-cdel="' + c.id + '">✕</button>' : '<span class="sub">modifiable encore ' + remainingTime(c) + "</span>");
    } else {
      actions = '<span class="muted">🔒 Verrouillée</span>';
    }
    const head = '<div class="course-head clickable" data-course="' + c.id + '"><span class="chev">' + (open ? "▾" : "▸") + "</span><b>Course de " + heure + "</b>" +
      (c.marche ? "<span>📍 " + esc(c.marche) + "</span>" : "") + "<span>" + (c.cc ? esc(ccName(c.cc)) : "Admin") + "</span>" +
      "<span>🏬 " + esc(boutiqueName(c.boutique)) + "</span><span>Saisie par " + esc(c.saisiPar || "—") + "</span>" + badge +
      "<span>Total : <b>" + money0(sousTotal + c.retrait + c.transport + c.autres) + "</b></span>" +
      "<span>Marge : " + margeHtml(margeTot) + "</span>" + (c.recuPath ? "<span title=\"Photo du reçu jointe\">📷</span>" : "") +
      '<span class="actions">' + actions + "</span></div>";
    if (!open) return '<div class="course-receipt' + (c.statut === "Validée" ? "" : " off") + '">' + head + "</div>";
    return '<div class="course-receipt' + (c.statut === "Validée" ? "" : " off") + '">' + head +
      '<div class="course-head">' + (c.marche ? "<span>Marché : <b>" + esc(c.marche) + "</b></span>" : "") +
      (c.tel ? '<span>Fournisseur : <a href="tel:' + esc(c.tel.replace(/[^\d+]/g, "")) + '">' + esc(c.tel) + "</a></span>" : "") +
      (c.obs ? '<span class="muted">' + esc(c.obs) + "</span>" : "") + "</div>" +
      '<div class="course-detail"><div class="table-wrap"><table class="table"><thead><tr><th>Produit</th><th class="num">Qté</th><th class="num">Prix total payé</th><th class="num">Prix unitaire</th>' +
      '<th class="num">Part des frais</th><th class="num">Prix de vente</th><th class="num">Marge unitaire</th><th class="num">Marge totale</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" +
      '<div class="course-summary">' + summaryBox({ sousTotal, retrait: c.retrait, transport: c.transport, autres: c.autres, autresLib: c.autresLib, vente: venteTot, marge: margeTot }) + "</div></div>" +
      (c.recuPath ? '<div class="receipt-photo"><div class="sub-title">Photo du reçu</div><img alt="Photo du reçu" data-photo-path="' + esc(c.recuPath) + '"></div>' : "") +
      "</div>";
  }
  // Charge les photos des courses ouvertes (liens temporaires sécurisés).
  function loadVisiblePhotos() {
    document.querySelectorAll("#e-days img[data-photo-path]").forEach((img) => {
      signedPhotoUrl(img.dataset.photoPath).then((u) => { img.src = u; img.dataset.zoom = u; }).catch(() => { img.alt = "Photo indisponible"; });
    });
  }
  ["#eh-cc", "#eh-date"].forEach((id) => $(id).addEventListener("change", renderEntryHistory));
  function entryDetail(ls) {
    const admin = isAdmin();
    return '<table class="table inner"><thead><tr><th>Heure</th><th>Article</th><th>Code</th><th class="num">Quantité</th><th>Statut</th><th>CC</th><th>Saisi par</th><th>Observation</th><th></th></tr></thead><tbody>' +
      ls.map((x) => {
        const p = productByCode(x.code);
        const heure = x.createdAt ? new Date(x.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
        const badge = x.statut === "Validée" ? '<span class="badge ok">Validée</span>' : '<span class="badge mute">Annulée</span>';
        let actions;
        if (canEditEntry(x)) {
          actions = '<button class="btn small" data-eedit="' + x.id + '">Modifier</button> ' +
            '<button class="btn small" data-etoggle="' + x.id + '">' + (x.statut === "Validée" ? "Annuler" : "Rétablir") + "</button> " +
            (admin ? '<button class="btn small danger" data-edel="' + x.id + '">✕</button>' : '<span class="sub">modifiable encore ' + remainingTime(x) + "</span>");
        } else {
          actions = '<span class="muted">🔒 Verrouillée</span>';
        }
        return '<tr class="' + (x.statut === "Validée" ? "" : "off") + '"><td>' + heure + "</td><td>" + esc(p ? p.nom : "?") + "</td><td>" + esc(x.code) +
          '</td><td class="num">' + num(x.qte) + '</td><td class="keep">' + badge + "</td><td>" + (x.cc ? esc(ccName(x.cc)) : "Admin") + "</td><td>" +
          esc(x.saisiPar || "—") + "</td><td>" + esc(x.obs) + '</td><td class="keep">' + actions + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  // Mise à jour d'une entrée : la base refuse silencieusement si le délai est dépassé, on le détecte.
  async function updateEntry(id, patch) {
    const rows = chk(await sb.from("entries").update(patch).eq("id", id).select("id"));
    if (!rows || !rows.length) throw new Error("Délai de 2 heures dépassé : seul l'administrateur peut modifier cette entrée.");
  }
  let editingEntry = null;
  function openEntry(x) {
    editingEntry = x;
    const f = $("#entry-form");
    f.elements.code.innerHTML = productOptions(x.code);
    f.elements.qte.value = x.qte;
    f.elements.date.value = x.date || today();
    f.elements.obs.value = x.obs || "";
    $("#ed-date-wrap").style.display = isAdmin() ? "" : "none";
    $("#ed-help").textContent = isAdmin()
      ? "Saisie par " + (x.saisiPar || "—") + (x.cc ? " (" + ccLabel(x.cc) + ")" : "") + "."
      : "Vous pouvez encore modifier cette entrée pendant " + remainingTime(x) + ".";
    $("#entry-dialog").showModal();
  }
  $("#entry-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const qte = Number(f.elements.qte.value);
    if (!(qte > 0)) { e.preventDefault(); return toast("Quantité invalide."); }
    const patch = { code: f.elements.code.value, qte, obs: f.elements.obs.value.trim() };
    if (isAdmin()) patch.date = f.elements.date.value || editingEntry.date || null;
    const id = editingEntry.id;
    act(() => updateEntry(id, patch), "Entrée modifiée.");
  });
  $("#e-days").addEventListener("click", (e) => {
    const ce = e.target.closest("[data-cedit]");
    const ct = e.target.closest("[data-ctoggle]");
    const cd = e.target.closest("[data-cdel]");
    if (ce) return openCourseEdit(db.courses.find((c) => c.id === ce.dataset.cedit));
    if (ct) {
      const c = db.courses.find((x) => x.id === ct.dataset.ctoggle);
      const statut = c.statut === "Validée" ? "Annulée" : "Validée";
      return act(async () => chk(await sb.rpc("set_course_statut", { p_id: c.id, p_statut: statut })), "Course : " + statut, ct);
    }
    if (cd) {
      if (!confirm("Supprimer définitivement cette course et tous ses produits ?\nAstuce : utilisez plutôt « Annuler » pour garder l'historique.")) return;
      return act(async () => {
        const rows = chk(await sb.from("courses").delete().eq("id", cd.dataset.cdel).select("id"));
        if (!rows || !rows.length) throw new Error("Suppression refusée.");
      }, "Course supprimée.", cd);
    }
    const zoom = e.target.closest("img[data-zoom]");
    if (zoom) return showPhoto(zoom.dataset.zoom, "Photo du reçu");
    const ch = e.target.closest("[data-course]");
    if (ch && !e.target.closest("button, a")) {
      const id = ch.dataset.course;
      if (openCourses.has(id)) openCourses.delete(id); else openCourses.add(id);
      return renderEntryHistory();
    }
    const ed = e.target.closest("[data-eedit]");
    const t = e.target.closest("[data-etoggle]");
    const d = e.target.closest("[data-edel]");
    if (ed) return openEntry(db.entries.find((y) => y.id === ed.dataset.eedit));
    if (t) {
      const x = db.entries.find((y) => y.id === t.dataset.etoggle);
      const statut = x.statut === "Validée" ? "Annulée" : "Validée";
      return act(() => updateEntry(x.id, { statut }), "Entrée : " + statut, t);
    }
    if (d) {
      if (!confirm("Supprimer définitivement cette entrée ?\nAstuce : utilisez plutôt « Annuler » pour garder l'historique.")) return;
      return act(async () => chk(await sb.from("entries").delete().eq("id", d.dataset.edel)), "Entrée supprimée.", d);
    }
    const row = e.target.closest("tr[data-day]");
    if (row) {
      const day = row.dataset.day;
      if (openDays.has(day)) openDays.delete(day); else openDays.add(day);
      renderEntryHistory();
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
    const vendeur = vendeurOf(first);
    $("#receipt").innerHTML =
      '<div class="center"><h3>' + esc(st.nom) + "</h3><div>" + esc(st.domaine) + "</div><div>Tel: " + esc(st.tel) + "</div><div>Adresse: " + esc(st.adresse) +
      "</div><div>Email: " + esc(st.email) + "</div><div>RCCM/NIF : " + esc(st.rccm) + "</div></div><hr>" +
      '<div class="center big">TICKET DE CAISSE</div><hr>' +
      "<table><tr><td>N° " + t + '</td><td class="r">Date : ' + fmtDate(first.date) + "</td></tr>" +
      "<tr><td>Client : " + esc(first.client) + '</td><td class="r">Heure : ' + now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + "</td></tr>" +
      "<tr><td colspan=2>" + ccLabel(first.cc) + (vendeur ? " — Vendeur : " + esc(vendeur) : "") + "</td></tr>" +
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
    renderUsers();
  }

  // ---------- RH : boutiques et affectation des CC ----------
  function renderRh() {
    renderRhFilters();
    // Ne pas effacer une saisie en cours dans la fiche (mise à jour temps réel)
    const typing = document.activeElement && $("#rh-fiche").contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (!typing) renderFiche();
    renderPlanning();
    $("#bq-rows").innerHTML = db.boutiques.length ? db.boutiques.map((b) => {
      const ccs = db.settings.ccList.filter((c) => c.boutique === b.code);
      return "<tr><td><b>" + esc(b.code) + '</b></td><td><input class="inline-input" data-bq-nom="' + esc(b.code) + '" value="' + esc(b.nom) + '"></td><td>' +
        (b.actif ? '<span class="badge ok">Active</span>' : '<span class="badge mute">Inactive</span>') + '</td><td class="wrap">' +
        (ccs.length ? ccs.map((c) => esc(ccName(c.code))).join("<br>") : '<span class="muted">Aucun CC</span>') + "</td><td>" +
        '<button class="btn small" data-bq-actif="' + esc(b.code) + '">' + (b.actif ? "Désactiver" : "Activer") + "</button> " +
        (b.code === INITIAL_BOUTIQUE ? '<span class="sub">Boutique d\'origine (stock initial)</span>' : '<button class="btn small danger" data-bq-del="' + esc(b.code) + '">🗑 Supprimer</button>') +
        "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Aucune boutique.</td></tr>';
    renderCcTable();
  }
  // ---------- RH : repos, congés, fiche CC, planning ----------
  const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const JOURS_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  function isoDow(d) { const x = parse(d).getDay(); return x === 0 ? 7 : x; } // 1 = lundi … 7 = dimanche
  function reposLabel(c) { return (c && c.repos && c.repos.length) ? c.repos.slice().sort().map((j) => JOURS[j - 1]).join(", ") : ""; }
  function congesOf(cc) { return db.conges.filter((g) => g.cc === cc).sort((a, b) => b.debut.localeCompare(a.debut)); }
  function congeOn(cc, date) { return db.conges.find((g) => g.cc === cc && g.debut <= date && g.fin >= date) || null; }
  function nbJours(g) { return Math.round((parse(g.fin) - parse(g.debut)) / 86400000) + 1; }
  function ccStatusOn(code, date) {
    const g = congeOn(code, date);
    if (g) return { k: "conge", label: "En congé jusqu'au " + fmtDate(g.fin), g };
    const c = ccByCode(code);
    if (c && c.repos.includes(isoDow(date))) return { k: "repos", label: "Jour de repos" };
    return { k: "service", label: "En service" };
  }
  function statusBadge(st) { return '<span class="badge ' + st.k + '">' + esc(st.label) + "</span>"; }
  function nextRepos(c, from) {
    if (!c || !c.repos.length) return "";
    for (let i = 0; i < 8; i++) { const d = addDays(from, i); if (c.repos.includes(isoDow(d))) return d; }
    return "";
  }
  function anciennete(dateEmb) {
    if (!dateEmb) return "";
    const m = Math.max(0, Math.floor((parse(today()) - parse(dateEmb)) / (86400000 * 30.44)));
    return m >= 12 ? Math.floor(m / 12) + " an" + (m >= 24 ? "s" : "") + (m % 12 ? " " + (m % 12) + " mois" : "") : m + " mois";
  }
  function joursActivite(cc, mois) { return new Set(db.sales.filter((s) => s.cc === cc && isCountedSale(s) && (s.date || "").slice(0, 7) === mois).map((s) => s.date)).size; }
  function agentDebut(c) { const a = c && c.agents.filter((x) => !x.fin).pop(); return a ? a.debut : ""; }

  function renderRhFilters() {
    const bcur = $("#rh-boutique").value || "ALL";
    $("#rh-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("") +
      '<option value="NONE">CC non affectés</option>';
    $("#rh-boutique").value = Array.from($("#rh-boutique").options).some((o) => o.value === bcur) ? bcur : "ALL";
    const b = $("#rh-boutique").value;
    const ccur = $("#rh-cc").value || "ALL";
    const list = db.settings.ccList.filter((c) => b === "ALL" || (b === "NONE" ? !c.boutique : c.boutique === b));
    $("#rh-cc").innerHTML = '<option value="ALL">— Choisir un CC —</option>' + list.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("");
    $("#rh-cc").value = list.some((c) => c.code === ccur) ? ccur : "ALL";
    if (!$("#rh-week").value) $("#rh-week").value = today();
  }
  $("#rh-boutique").addEventListener("change", () => { renderRhFilters(); renderFiche(); renderPlanning(); });
  $("#rh-cc").addEventListener("change", () => {
    const cc = $("#rh-cc").value;
    if (cc !== "ALL" && $("#rh-boutique").value === "ALL" && ccBoutique(cc)) { $("#rh-boutique").value = ccBoutique(cc); renderRhFilters(); $("#rh-cc").value = cc; }
    renderFiche(); renderPlanning();
  });
  $("#rh-week").addEventListener("change", renderPlanning);

  // Fiche RH complète d'un CC (admin)
  function renderFiche() {
    const code = $("#rh-cc").value;
    if (!code || code === "ALL") { $("#rh-fiche").innerHTML = '<div class="card"><p class="hint" style="margin:0">Choisissez une boutique puis un CC pour afficher sa fiche RH (repos, congés, contacts, notes).</p></div>'; return; }
    const c = ccByCode(code);
    const f = db.fiches.find((x) => x.cc === code) || {};
    const st = ccStatusOn(code, today());
    const user = db.users.find((u) => u.cc === code);
    const conges = congesOf(code);
    const t = today(), mois = t.slice(0, 7);
    const enCours = conges.filter((g) => g.debut <= t && g.fin >= t);
    const aVenir = conges.filter((g) => g.debut > t);
    const passes = conges.filter((g) => g.fin < t);
    const joursAn = conges.filter((g) => g.debut.slice(0, 4) === t.slice(0, 4)).reduce((a, g) => a + nbJours(g), 0);
    const congeRow = (g) => '<div class="info-row"><span>' + fmtDate(g.debut) + " → " + fmtDate(g.fin) + " · " + nbJours(g) + " j" + (g.motif ? " · " + esc(g.motif) : "") +
      '</span><span style="white-space:nowrap">' + (g.fin >= t ? '<button class="btn small" data-cg-ext="' + g.id + '" title="Prolonger d\'une semaine">+1 semaine</button> <button class="btn small" data-cg-edit="' + g.id + '">Modifier</button> ' : "") +
      '<button class="btn small danger" data-cg-del="' + g.id + '">✕</button></span></div>';
    const hist = c.agents.length ? c.agents.map((a) => esc(a.nom) + " : " + (a.debut ? fmtDate(a.debut) : "…") + " → " + (a.fin ? fmtDate(a.fin) : "aujourd'hui")).join("<br>") : "Aucun vendeur affecté";
    $("#rh-fiche").innerHTML = '<div class="card">' +
      '<div class="fiche-head"><h2>' + esc(ccName(code)) + "</h2>" + statusBadge(st) +
      "<span>🏬 " + esc(boutiqueName(c.boutique)) + "</span>" + (c.actif ? "" : '<span class="badge mute">CC inactif</span>') + "</div>" +
      '<div class="fiche-grid">' +
      // Identité & contacts (admin uniquement)
      "<div><h3>Identité & contacts <span class=\"muted\">(admin)</span></h3>" +
      '<div class="form">' +
      '<label>Téléphone<input id="rf-tel" type="tel" value="' + esc(f.telephone || "") + '" placeholder="Ex. : 90 12 34 56"></label>' +
      '<label>Contact d\'urgence<input id="rf-urg" value="' + esc(f.contact_urgence || "") + '" placeholder="Nom et téléphone"></label>' +
      '<label>Date d\'embauche<input id="rf-emb" type="date" value="' + esc(f.date_embauche || "") + '"></label>' +
      "<label>Ancienneté<input readonly value=\"" + esc(anciennete(f.date_embauche) || "—") + '"></label>' +
      '<label class="full">Notes RH (confidentielles)<textarea id="rf-notes" rows="3" placeholder="Remarques, avertissements, objectifs…">' + esc(f.notes || "") + "</textarea></label>" +
      "</div>" +
      '<div class="info-row"><span>Compte de connexion</span><span>' + (user ? esc(user.email) + (user.actif ? "" : " (en attente)") : "Aucun compte lié") + "</span></div>" +
      '<div class="info-row"><span>Vendeur actuel depuis</span><span>' + (agentDebut(c) ? fmtDate(agentDebut(c)) : "—") + "</span></div>" +
      '<div class="info-row"><span>Jours d\'activité ce mois</span><span>' + joursActivite(code, mois) + " jour(s) avec au moins une vente</span></div>" +
      '<div class="actions" style="margin-top:10px"><button class="btn primary" id="rf-save">Enregistrer la fiche</button></div></div>' +
      // Repos & congés
      "<div><h3>Jours de repos hebdomadaires</h3>" +
      '<div class="repos-days">' + JOURS_LONG.map((j, i) => '<label><input type="checkbox" data-repos="' + (i + 1) + '"' + (c.repos.includes(i + 1) ? " checked" : "") + "> " + j + "</label>").join("") + "</div>" +
      '<p class="hint" style="margin:6px 0 14px">' + (c.repos.length ? "Prochain repos : " + fmtLong(nextRepos(c, t)) : "Aucun jour de repos défini.") + "</p>" +
      '<div class="toolbar" style="margin-bottom:4px"><h3 style="margin:0;margin-right:auto">Congés</h3><button class="btn small primary" id="cg-new">+ Congé (1 semaine)</button></div>' +
      '<p class="hint" style="margin:0 0 6px">' + joursAn + " jour(s) de congé en " + t.slice(0, 4) + ".</p>" +
      (enCours.length ? "<b>En cours</b>" + enCours.map(congeRow).join("") : "") +
      (aVenir.length ? "<b>À venir</b>" + aVenir.map(congeRow).join("") : "") +
      (passes.length ? '<details><summary class="muted">Congés passés (' + passes.length + ")</summary>" + passes.map(congeRow).join("") + "</details>" : "") +
      (!conges.length ? '<p class="muted">Aucun congé enregistré.</p>' : "") + "</div>" +
      // Historique
      '<div><h3>Historique des vendeurs du CC</h3><p class="hist" style="margin:0">' + hist + "</p></div>" +
      "</div></div>";
  }
  // Enregistrer la fiche
  $("#rh-fiche").addEventListener("click", (e) => {
    const code = $("#rh-cc").value;
    if (e.target.closest("#rf-save")) {
      const row = { cc: code, telephone: $("#rf-tel").value.trim(), contact_urgence: $("#rf-urg").value.trim(), date_embauche: $("#rf-emb").value || null, notes: $("#rf-notes").value.trim(), updated_at: new Date().toISOString() };
      return act(async () => chk(await sb.from("rh_fiches").upsert(row)), "Fiche RH enregistrée.", e.target);
    }
    if (e.target.closest("#cg-new")) return openConge(null, code);
    const ext = e.target.closest("[data-cg-ext]");
    if (ext) {
      const g = db.conges.find((x) => x.id === ext.dataset.cgExt);
      return act(async () => chk(await sb.from("conges").update({ fin: addDays(g.fin, 7) }).eq("id", g.id)), "Congé prolongé jusqu'au " + fmtDate(addDays(g.fin, 7)) + ".", ext);
    }
    const ed = e.target.closest("[data-cg-edit]");
    if (ed) return openConge(db.conges.find((x) => x.id === ed.dataset.cgEdit), code);
    const del = e.target.closest("[data-cg-del]");
    if (del) {
      if (!confirm("Supprimer ce congé ?")) return;
      return act(async () => chk(await sb.from("conges").delete().eq("id", del.dataset.cgDel)), "Congé supprimé.", del);
    }
  });
  // Jours de repos (enregistrés dès qu'on coche / décoche)
  $("#rh-fiche").addEventListener("change", (e) => {
    if (!e.target.closest("[data-repos]")) return;
    const code = $("#rh-cc").value;
    const repos = Array.from(document.querySelectorAll("#rh-fiche [data-repos]:checked")).map((x) => Number(x.dataset.repos));
    act(async () => chk(await sb.from("ccs").update({ repos }).eq("code", code)), "Jours de repos : " + (repos.length ? repos.map((j) => JOURS_LONG[j - 1]).join(", ") : "aucun") + ".");
  });

  // Congé : 1 semaine par défaut, prolongeable
  let editingConge = null, congeCc = null;
  function updateCongeDays() {
    const f = $("#conge-form");
    const d = f.elements.debut.value, fi = f.elements.fin.value;
    $("#cg-days").textContent = d && fi && fi >= d ? nbJours({ debut: d, fin: fi }) + " jour(s) de congé, reprise le " + fmtLong(addDays(fi, 1)) + "." : "";
  }
  function openConge(g, cc) {
    editingConge = g; congeCc = cc;
    const f = $("#conge-form");
    f.reset();
    $("#cg-title").textContent = (g ? "Modifier le congé — " : "Nouveau congé — ") + ccName(cc);
    f.elements.debut.value = g ? g.debut : today();
    f.elements.fin.value = g ? g.fin : addDays(today(), 6);
    f.elements.motif.value = g ? g.motif : "";
    updateCongeDays();
    $("#conge-dialog").showModal();
  }
  $("#conge-form").addEventListener("input", updateCongeDays);
  $("#conge-form").addEventListener("click", (e) => {
    const w = e.target.closest("[data-cg-weeks]");
    if (!w) return;
    const f = $("#conge-form");
    if (!f.elements.debut.value) f.elements.debut.value = today();
    f.elements.fin.value = addDays(f.elements.debut.value, 7 * Number(w.dataset.cgWeeks) - 1);
    updateCongeDays();
  });
  $("#conge-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const row = { cc: congeCc, debut: f.elements.debut.value, fin: f.elements.fin.value, motif: f.elements.motif.value.trim() };
    if (!row.debut || !row.fin || row.fin < row.debut) { e.preventDefault(); return toast("Dates de congé invalides."); }
    const overlap = db.conges.find((g) => g.cc === congeCc && (!editingConge || g.id !== editingConge.id) && g.debut <= row.fin && g.fin >= row.debut);
    if (overlap) { e.preventDefault(); return toast("Ce congé chevauche celui du " + fmtDate(overlap.debut) + " au " + fmtDate(overlap.fin) + "."); }
    const id = editingConge ? editingConge.id : null;
    act(async () => chk(id ? await sb.from("conges").update(row).eq("id", id) : await sb.from("conges").insert(row)), "Congé enregistré.");
  });

  // Planning de la semaine (boutique choisie)
  function renderPlanning() {
    const b = $("#rh-boutique").value;
    const lundi = mondayOf($("#rh-week").value || today());
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(lundi, i));
    const list = db.settings.ccList.filter((c) => c.actif && (b === "ALL" || (b === "NONE" ? !c.boutique : c.boutique === b)));
    $("#rh-planning-title").textContent = "Planning de la semaine du " + fmtDate(lundi) + " au " + fmtDate(days[6]) + " — " + (b === "ALL" ? "toutes les boutiques" : b === "NONE" ? "CC non affectés" : boutiqueName(b));
    const t = today();
    $("#rh-planning").innerHTML = "<thead><tr><th>CC</th>" + (b === "ALL" ? "<th>Boutique</th>" : "") +
      days.map((d, i) => '<th class="' + (d === t ? "today" : "") + '">' + JOURS[i] + "<br><small>" + fmtDate(d).slice(0, 5) + "</small></th>").join("") + "<th>En service</th></tr></thead><tbody>" +
      (list.length ? list.map((c) => {
        const st = days.map((d) => ccStatusOn(c.code, d));
        return '<tr class="clickable" data-plan-cc="' + esc(c.code) + '"><td>' + esc(ccName(c.code)) + "</td>" + (b === "ALL" ? "<td>" + esc(boutiqueName(c.boutique)) + "</td>" : "") +
          st.map((s, i) => '<td class="' + (s.k === "conge" ? "c" : s.k === "repos" ? "r" : "s") + (days[i] === t ? " today" : "") + '">' + (s.k === "conge" ? "C" : s.k === "repos" ? "R" : "✓") + "</td>").join("") +
          "<td>" + st.filter((s) => s.k === "service").length + " / 7</td></tr>";
      }).join("") : '<tr><td colspan="10" class="empty">Aucun CC actif.</td></tr>') + "</tbody>";
  }
  $("#rh-planning").addEventListener("click", (e) => {
    const tr = e.target.closest("[data-plan-cc]");
    if (!tr) return;
    const cc = tr.dataset.planCc;
    if (ccBoutique(cc) && $("#rh-boutique").value === "ALL") $("#rh-boutique").value = ccBoutique(cc);
    renderRhFilters();
    $("#rh-cc").value = cc;
    renderFiche();
    $("#rh-fiche").scrollIntoView({ behavior: "smooth" });
  });

  // ---------- Mon compte (chaque utilisateur) ----------
  function renderCompte() {
    const t = today(), mois = t.slice(0, 7);
    const code = me.cc;
    const c = code ? ccByCode(code) : null;
    let h = '<div class="compte-grid">';
    h += '<div class="card"><h2>Mon profil</h2>' +
      '<div class="info-row"><span>Nom</span><span>' + esc(me.nom || "—") + "</span></div>" +
      '<div class="info-row"><span>E-mail</span><span>' + esc(me.email || "—") + "</span></div>" +
      '<div class="info-row"><span>Rôle</span><span>' + (isAdmin() ? "Administrateur" : "Vendeur") + "</span></div>" +
      (c ? '<div class="info-row"><span>Code commercial</span><span>' + esc(ccName(code)) + "</span></div>" +
        '<div class="info-row"><span>Boutique</span><span>🏬 ' + esc(boutiqueName(c.boutique)) + "</span></div>" +
        '<div class="info-row"><span>Affecté depuis</span><span>' + (agentDebut(c) ? fmtDate(agentDebut(c)) : "—") + "</span></div>"
        : '<p class="hint">Aucun code commercial lié à votre compte.</p>') + "</div>";
    if (c) {
      const st = ccStatusOn(code, t);
      const mine = congesOf(code);
      const avenir = mine.filter((g) => g.fin >= t).sort((a, b) => a.debut.localeCompare(b.debut));
      const lundi = mondayOf(t);
      h += '<div class="card"><h2>Aujourd\'hui ' + statusBadge(st) + "</h2>" +
        '<div class="info-row"><span>Mes jours de repos</span><span>' + (reposLabel(c) || "Non définis") + "</span></div>" +
        '<div class="info-row"><span>Prochain jour de repos</span><span>' + (nextRepos(c, t) ? cap(fmtLong(nextRepos(c, t))) : "—") + "</span></div>" +
        '<div class="info-row"><span>Ma semaine</span><span>' + [0, 1, 2, 3, 4, 5, 6].map((i) => {
          const d = addDays(lundi, i), s = ccStatusOn(code, d);
          return '<span class="badge ' + s.k + '" title="' + esc(s.label) + '" style="margin-left:2px' + (d === t ? ";outline:2px solid var(--primary)" : "") + '">' + JOURS[i] + "</span>";
        }).join("") + "</span></div>" +
        "<h3 style=\"margin:14px 0 6px\">Mes congés</h3>" +
        (avenir.length ? avenir.map((g) => '<div class="info-row"><span>' + fmtDate(g.debut) + " → " + fmtDate(g.fin) + (g.motif ? " · " + esc(g.motif) : "") + "</span><span>" + nbJours(g) + " j" + (g.debut <= t ? " (en cours)" : "") + "</span></div>").join("")
          : '<p class="muted" style="margin:0">Aucun congé en cours ou à venir.</p>') +
        (mine.length > avenir.length ? '<p class="hint" style="margin:6px 0 0">' + (mine.length - avenir.length) + " congé(s) passé(s).</p>" : "") + "</div>";
      const my = db.sales.filter((s) => s.cc === code && isCountedSale(s));
      const jour = summarize(my.filter((s) => s.date === t)), m = summarize(my.filter((s) => (s.date || "").slice(0, 7) === mois));
      h += '<div class="card"><h2>Mes ventes</h2><div class="report">' +
        "<div><span>Aujourd'hui</span><strong>" + money(jour.ca) + "</strong></div><div><span>Tickets aujourd'hui</span><strong>" + num(jour.tickets) + "</strong></div>" +
        "<div><span>Ce mois</span><strong>" + money(m.ca) + "</strong></div><div><span>Jours d'activité ce mois</span><strong>" + joursActivite(code, mois) + "</strong></div></div></div>";
    }
    $("#compte-body").innerHTML = h + "</div>";
  }

  // Création / suppression de boutique : confirmation par le mot de passe de l'admin (vérifié par la base).
  let cpAction = null;
  function openConfirmPwd(action) {
    cpAction = action;
    const f = $("#cpwd-form");
    f.reset();
    $("#cp-msg").textContent = "";
    $("#cp-name-wrap").style.display = action.type === "create" ? "" : "none";
    $("#cp-ok").className = "btn " + (action.type === "delete" ? "danger" : "primary");
    if (action.type === "create") {
      const n = db.boutiques.reduce((m, b) => Math.max(m, Number(b.code.replace(/\D/g, "")) || 0), 0) + 1;
      $("#cp-title").textContent = "Nouvelle boutique";
      $("#cp-body").innerHTML = '<p class="hint">' + (db.boutiques.length >= 10 ? "⚠ Vous avez déjà " + db.boutiques.length + " boutiques. " : "") +
        "Le code <b>B" + n + "</b> lui sera attribué. Confirmez avec votre mot de passe.</p>";
      f.elements.nom.value = "Boutique " + n;
      $("#cp-ok").textContent = "Créer la boutique";
    } else {
      const b = boutiqueByCode(action.code);
      const ventes = db.sales.filter((s) => s.boutique === b.code);
      const courses = db.courses.filter((c) => c.boutique === b.code);
      const entrees = db.entries.filter((x) => !x.courseId && x.boutique === b.code);
      const ccs = db.settings.ccList.filter((c) => c.boutique === b.code);
      const ca = ventes.filter(isCountedSale).reduce((a, s) => a + lineTotal(s), 0);
      $("#cp-title").textContent = "Supprimer « " + b.nom + " »";
      $("#cp-body").innerHTML = '<div class="v-alert danger"><b>Suppression définitive</b>, sans retour possible :<ul style="margin:6px 0 0 18px;padding:0">' +
        "<li><b>" + num(ventes.length) + "</b> ligne(s) de vente (" + money(ca) + ")</li>" +
        "<li><b>" + num(courses.length) + "</b> course(s) avec leurs produits et " + courses.filter((c) => c.recuPath).length + " photo(s) de reçus</li>" +
        "<li><b>" + num(entrees.length) + "</b> entrée(s) de stock</li>" +
        "<li><b>" + num(ccs.length) + "</b> CC désaffecté(s) (ils restent dans RH, à réaffecter)</li></ul></div>" +
        '<p class="hint">Pensez à télécharger une sauvegarde (Paramètres) avant. Confirmez avec votre mot de passe.</p>';
      $("#cp-ok").textContent = "Supprimer définitivement";
    }
    $("#cpwd-dialog").showModal();
    (action.type === "create" ? f.elements.nom : f.elements.pwd).focus();
  }
  $("#cpwd-form").addEventListener("submit", async (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    e.preventDefault(); // la fenêtre reste ouverte tant que l'opération n'a pas réussi
    const f = e.target, pwd = f.elements.pwd.value, btn = $("#cp-ok");
    if (!pwd) { $("#cp-msg").textContent = "Saisissez votre mot de passe."; return; }
    $("#cp-msg").textContent = "";
    btn.disabled = true;
    try {
      if (cpAction.type === "create") {
        const nom = f.elements.nom.value.trim();
        if (!nom) { $("#cp-msg").textContent = "Indiquez le nom de la boutique."; return; }
        chk(await sb.rpc("create_boutique", { p_nom: nom, p_password: pwd }));
        $("#cpwd-dialog").close();
        await act(async () => {}, "Boutique créée : " + nom);
      } else {
        const res = chk(await sb.rpc("delete_boutique", { p_code: cpAction.code, p_password: pwd }));
        $("#cpwd-dialog").close();
        const photos = (res && res.photos) || [];
        if (photos.length) { try { await sb.storage.from("recus").remove(photos); } catch (err) { /* photos orphelines sans gravité */ } }
        await act(async () => {}, "Boutique supprimée : " + num(res.ventes) + " vente(s), " + num(res.courses) + " course(s), " + num(res.entrees) + " entrée(s) effacées.");
      }
    } catch (err) {
      $("#cp-msg").textContent = errMsg(err);
    } finally {
      btn.disabled = false;
    }
  });
  $("#bq-new").addEventListener("click", () => openConfirmPwd({ type: "create" }));
  $("#bq-rows").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-bq-nom]");
    if (!inp) return;
    const nom = inp.value.trim();
    if (!nom) { inp.value = boutiqueName(inp.dataset.bqNom); return toast("Le nom ne peut pas être vide."); }
    act(async () => chk(await sb.from("boutiques").update({ nom }).eq("code", inp.dataset.bqNom)), "Boutique renommée.");
  });
  $("#bq-rows").addEventListener("click", (e) => {
    const del = e.target.closest("[data-bq-del]");
    if (del) return openConfirmPwd({ type: "delete", code: del.dataset.bqDel });
    const b = e.target.closest("[data-bq-actif]");
    if (!b) return;
    const bq = boutiqueByCode(b.dataset.bqActif);
    act(async () => chk(await sb.from("boutiques").update({ actif: !bq.actif }).eq("code", bq.code)), bq.nom + (bq.actif ? " désactivée." : " activée."), b);
  });
  $("#p-save").addEventListener("click", (ev) => {
    const row = { id: 1 };
    document.querySelectorAll("#p-form [data-k]").forEach((i) => { row[i.dataset.k] = i.value.trim(); });
    act(async () => chk(await sb.from("settings").upsert(row)), "Paramètres enregistrés.", ev.currentTarget);
  });

  // Utilisateurs
  function renderUsers() {
    const ccOpts = (sel) => '<option value="">—</option>' + db.settings.ccList.map((c) => '<option value="' + esc(c.code) + '"' + (c.code === sel ? " selected" : "") + ">" + esc(ccName(c.code)) + "</option>").join("");
    $("#u-rows").innerHTML = db.users.length ? db.users.map((u) => {
      const self = u.id === me.id;
      return '<tr data-uid="' + u.id + '"><td><input class="inline-input" data-uf="nom" value="' + esc(u.nom) + '"></td><td>' + esc(u.email) + "</td>" +
        '<td><select class="inline-select" data-uf="role"' + (self ? " disabled" : "") + '><option value="vendeur"' + (u.role === "vendeur" ? " selected" : "") + '>Vendeur</option><option value="admin"' + (u.role === "admin" ? " selected" : "") + ">Admin</option></select></td>" +
        '<td><select class="inline-select" data-uf="cc">' + ccOpts(u.cc || "") + "</select></td><td>" +
        (u.actif ? '<span class="badge ok">Actif</span>' : '<span class="badge warn">En attente</span>') + '</td><td class="wrap">' +
        (self ? '<span class="muted">(vous)</span>' : (u.actif
          ? '<button class="btn small" data-uactif="0">Suspendre</button>'
          : '<button class="btn small success" data-uactif="1">Valider</button>')) +
        "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Aucun utilisateur.</td></tr>';
  }
  function updateUser(id, patch, msg, btn) {
    return act(async () => chk(await sb.from("profiles").update(patch).eq("id", id)), msg, btn);
  }
  $("#u-rows").addEventListener("change", (e) => {
    const el = e.target.closest("[data-uf]");
    if (!el) return;
    const id = el.closest("tr").dataset.uid;
    const patch = {};
    patch[el.dataset.uf] = el.value.trim() || (el.dataset.uf === "cc" ? null : "");
    updateUser(id, patch, "Utilisateur mis à jour.").then((r) => {
      // Un CC sans nom prend automatiquement le nom du vendeur qu'on lui lie.
      if (!r.ok || el.dataset.uf !== "cc" || !patch.cc) return;
      const cc = ccByCode(patch.cc);
      const u = db.users.find((x) => x.id === id);
      const nom = u && (u.nom || "").trim();
      if (cc && nom && !currentAgent(cc)) setCcName(cc.code, nom, ccLabel(cc.code) + " lié à " + nom + ".");
    });
  });
  $("#u-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-uactif]");
    if (!b) return;
    const id = b.closest("tr").dataset.uid;
    const actif = b.dataset.uactif === "1";
    if (!actif && !confirm("Suspendre ce compte ? La personne ne pourra plus se connecter à l'application.")) return;
    updateUser(id, { actif }, actif ? "Compte validé." : "Compte suspendu.", b);
  });

  // Codes commerciaux
  function renderCcTable() {
    $("#cc-rows").innerHTML = db.settings.ccList.length ? db.settings.ccList.map((c) => {
      const hist = c.agents.length
        ? c.agents.map((a) => esc(a.nom) + " : " + (a.debut ? fmtDate(a.debut) : "…") + " → " + (a.fin ? fmtDate(a.fin) : "aujourd'hui")).join("<br>")
        : "Aucun vendeur affecté";
      const hasSales = db.sales.some((s) => s.cc === c.code);
      return "<tr><td><b>" + ccLabel(c.code) + "</b></td><td>" +
        '<input class="inline-input" data-cc-nom="' + esc(c.code) + '" value="' + esc(currentAgent(c)) + '" placeholder="Nom du CC" title="Nom affiché à côté du CC (Entrée pour valider)">' + "</td><td>" +
        '<select class="inline-select" data-cc-bq="' + esc(c.code) + '"><option value="">— Non affecté —</option>' +
        db.boutiques.map((b) => '<option value="' + esc(b.code) + '"' + (b.code === c.boutique ? " selected" : "") + ">" + esc(b.nom) + "</option>").join("") +
        "</select></td><td>" +
        (c.actif ? '<span class="badge ok">Actif</span>' : '<span class="badge mute">Inactif</span>') +
        "</td><td>" + (reposLabel(c) || '<span class="muted">—</span>') + '</td><td class="hist">' + hist + '</td><td class="wrap">' +
        '<button class="btn small" data-cc-assign="' + esc(c.code) + '">' + (currentAgent(c) ? "Changer de vendeur" : "Affecter un vendeur") + "</button> " +
        (c.actif
          ? '<button class="btn small" data-cc-depart="' + esc(c.code) + '">Départ / désactiver</button> '
          : '<button class="btn small" data-cc-reactiver="' + esc(c.code) + '">Réactiver</button> ') +
        (hasSales ? "" : '<button class="btn small danger" data-cc-del="' + esc(c.code) + '">✕</button>') +
        "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Aucun code commercial.</td></tr>';
  }

  let ccMode = null, ccTarget = null;
  function openCc(mode, code) {
    ccMode = mode; ccTarget = code || null;
    const f = $("#cc-form");
    const cc = ccByCode(code);
    f.elements.code.value = mode === "new" ? String(db.settings.ccList.reduce((m, c) => Math.max(m, Number(c.code) || 0), 0) + 1) : code;
    f.elements.nom.value = "";
    f.elements.date.value = today();
    $("#cc-code-wrap").style.display = mode === "new" ? "" : "none";
    $("#cc-nom-wrap").style.display = mode === "depart" ? "none" : "";
    $("#cc-title").textContent = mode === "new" ? "Nouveau code commercial" : mode === "assign" ? "Vendeur du " + ccLabel(code) : "Départ — " + ccName(code);
    $("#cc-help").textContent = mode === "new"
      ? "Le vendeur sera rattaché à ce CC à partir de la date indiquée."
      : mode === "assign"
        ? (currentAgent(cc) ? "Le vendeur actuel (" + currentAgent(cc) + ") sera clôturé la veille de cette date. Ses ventes restent à son nom." : "Le vendeur sera rattaché à ce CC à partir de cette date.")
        : "Date de départ du vendeur. Le CC devient inactif (il n'apparaît plus en caisse) mais toutes ses ventes restent dans les statistiques.";
    $("#cc-dialog").showModal();
  }
  function closeOpenAgents(agents, finDate) {
    agents.forEach((a) => { if (!a.fin) a.fin = a.debut && a.debut > finDate ? a.debut : finDate; });
  }
  // Inscrit le nom du vendeur sur les ventes de ce CC qui n'en ont pas, selon les dates d'affectation.
  async function freezeVendeurs(code, agents) {
    const cc = { code, agents };
    const groups = {};
    db.sales.filter((s) => s.cc === code && !s.vendeur).forEach((s) => {
      const v = agentAt(cc, s.date);
      if (v) (groups[v] = groups[v] || []).push(s.id);
    });
    for (const v of Object.keys(groups)) {
      for (let i = 0; i < groups[v].length; i += 200) {
        chk(await sb.from("sales").update({ vendeur: v }).in("id", groups[v].slice(i, i + 200)));
      }
    }
  }
  // Nomme un CC : renomme le vendeur actuel, ou en crée un à partir d'aujourd'hui.
  // Les ventes passées gardent le nom qu'elles avaient.
  function setCcName(code, nom, msg) {
    const cc = ccByCode(code);
    if (!cc) return Promise.resolve({ ok: false });
    const before = JSON.parse(JSON.stringify(cc.agents));
    const after = JSON.parse(JSON.stringify(cc.agents));
    const open = after.filter((a) => !a.fin).pop();
    if (open) open.nom = nom;
    else after.push({ nom, debut: today(), fin: "" });
    return act(async () => {
      await freezeVendeurs(cc.code, before);
      chk(await sb.from("ccs").update({ agents: after }).eq("code", cc.code));
    }, msg || ccLabel(cc.code) + " — " + nom);
  }
  $("#cc-rows").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-cc-bq]");
    if (sel) {
      const code = sel.dataset.ccBq, bq = sel.value;
      return act(async () => chk(await sb.rpc("assign_cc_boutique", { p_cc: code, p_boutique: bq })),
        ccLabel(code) + (bq ? " affecté à " + boutiqueName(bq) + "." : " retiré de sa boutique."));
    }
    const inp = e.target.closest("[data-cc-nom]");
    if (!inp) return;
    const nom = inp.value.trim();
    if (!nom) { inp.value = currentAgent(ccByCode(inp.dataset.ccNom)); return toast("Le nom ne peut pas être vide."); }
    if (nom === currentAgent(ccByCode(inp.dataset.ccNom))) return;
    setCcName(inp.dataset.ccNom, nom);
  });
  $("#cc-new").addEventListener("click", () => openCc("new"));
  $("#cc-rows").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.ccAssign) openCc("assign", b.dataset.ccAssign);
    else if (b.dataset.ccDepart) openCc("depart", b.dataset.ccDepart);
    else if (b.dataset.ccReactiver) {
      const code = b.dataset.ccReactiver;
      act(async () => chk(await sb.from("ccs").update({ actif: true }).eq("code", code)), ccLabel(code) + " réactivé. Pensez à lui affecter un vendeur.", b);
    } else if (b.dataset.ccDel) {
      const code = b.dataset.ccDel;
      if (!confirm("Supprimer " + ccLabel(code) + " ? (aucune vente associée)")) return;
      act(async () => chk(await sb.from("ccs").delete().eq("code", code)), ccLabel(code) + " supprimé.", b);
    }
  });
  $("#cc-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target;
    const nom = f.elements.nom.value.trim();
    const date = f.elements.date.value || today();
    const stay = (msg) => { e.preventDefault(); toast(msg); };
    if (ccMode === "new") {
      const code = f.elements.code.value.trim().replace(/^0+(?=\d)/, "");
      if (!code) return stay("Indiquez un code.");
      if (ccByCode(code)) return stay(ccLabel(code) + " existe déjà : utilisez « Changer de vendeur ».");
      const agents = nom ? [{ nom, debut: date, fin: "" }] : [];
      act(async () => chk(await sb.from("ccs").insert({ code, actif: true, agents })), ccLabel(code) + " créé.");
    } else if (ccMode === "assign") {
      if (!nom) return stay("Indiquez le nom du vendeur.");
      const cc = ccByCode(ccTarget);
      const before = JSON.parse(JSON.stringify(cc.agents));
      const after = JSON.parse(JSON.stringify(cc.agents));
      closeOpenAgents(after, addDays(date, -1));
      after.push({ nom, debut: date, fin: "" });
      act(async () => {
        await freezeVendeurs(cc.code, before);
        chk(await sb.from("ccs").update({ agents: after, actif: true }).eq("code", cc.code));
        await freezeVendeurs(cc.code, after);
      }, nom + " affecté(e) au " + ccLabel(cc.code) + ".");
    } else if (ccMode === "depart") {
      const cc = ccByCode(ccTarget);
      const before = JSON.parse(JSON.stringify(cc.agents));
      const after = JSON.parse(JSON.stringify(cc.agents));
      closeOpenAgents(after, date);
      act(async () => {
        await freezeVendeurs(cc.code, before);
        chk(await sb.from("ccs").update({ agents: after, actif: false }).eq("code", cc.code));
      }, ccLabel(cc.code) + " désactivé. Ses ventes sont conservées.");
    }
  });

  // Sauvegarde / import
  $("#p-export").addEventListener("click", () => {
    const data = { version: 3, exportedAt: new Date().toISOString(), settings: db.settings, products: db.products, entries: db.entries, sales: db.sales, courses: db.courses };
    download("sauvegarde-" + (db.settings.nom || "boutique") + "-" + today() + ".json", JSON.stringify(data, null, 2), "application/json");
  });
  $("#p-import").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      let data;
      try {
        data = JSON.parse(String(r.result).replace(/^﻿/, ""));
        if (!data.settings || !Array.isArray(data.products) || !Array.isArray(data.sales) || !Array.isArray(data.entries)) throw new Error("format");
      } catch (err) {
        e.target.value = "";
        return alert("Fichier de sauvegarde invalide.");
      }
      e.target.value = "";
      const msg = "Importer : " + data.products.length + " produits, " + data.entries.length + " entrées, " + data.sales.length + " lignes de vente.\n\n" +
        "Les produits et CC existants sont mis à jour ; les ventes et entrées sont AJOUTÉES." +
        (db.sales.length ? "\n\nATTENTION : la base contient déjà " + db.sales.length + " lignes de vente. Importer deux fois le même fichier crée des doublons." : "") +
        "\n\nContinuer ?";
      if (!confirm(msg)) return;
      await importBackup(data);
    };
    r.readAsText(file);
  });
  async function insertBatches(table, rows) {
    for (let i = 0; i < rows.length; i += 500) chk(await sb.from(table).insert(rows.slice(i, i + 500)));
  }
  async function importBackup(data) {
    const st = data.settings || {};
    let ccList = Array.isArray(st.ccList) ? st.ccList
      : (Array.isArray(st.ccs) ? st.ccs : ["1", "2", "3"]).map((c) => ({ code: String(c), actif: true, agents: [] }));
    data.sales.forEach((s) => {
      if (!ccList.some((c) => String(c.code) === String(s.cc))) ccList.push({ code: String(s.cc), actif: false, agents: [] });
    });
    toast("Import en cours…");
    await act(async () => {
      chk(await sb.from("settings").upsert({
        id: 1, nom: st.nom || db.settings.nom, domaine: st.domaine || "", tel: st.tel || "", adresse: st.adresse || "",
        email: st.email || "", rccm: st.rccm || "", devise: st.devise || "FCFA"
      }));
      chk(await sb.from("products").upsert(data.products.map((p) => ({
        code: p.code, nom: p.nom, categorie: p.categorie || "", pv: Number(p.pv) || 0,
        stock_initial: Number(p.stockInitial) || 0, stock_min: Number(p.stockMin) || 0
      }))));
      chk(await sb.from("product_costs").upsert(data.products.map((p) => ({ code: p.code, pa: Number(p.pa) || 0 }))));
      chk(await sb.from("ccs").upsert(ccList.map((c) => ({ code: String(c.code), actif: c.actif !== false, agents: Array.isArray(c.agents) ? c.agents : [] }))));
      await insertBatches("entries", data.entries.map((x) => ({
        date: x.date || null, code: x.code, qte: Number(x.qte), statut: x.statut === "Annulée" ? "Annulée" : "Validée", obs: x.obs || ""
      })));
      await insertBatches("sales", data.sales.map((s) => ({
        ticket: Number(s.ticket), date: s.date, client: s.client || "CLIENT COMPTOIR", code: s.code, nom: s.nom || "",
        qte: Number(s.qte), pu: Number(s.pu), cc: String(s.cc), vendeur: s.vendeur || "", valide: s.valide === "NON" ? "NON" : "OUI",
        num_client: s.numClient || "", adresse_client: s.adresseClient || ""
      })));
      chk(await sb.rpc("sync_ticket_seq"));
    }, "Import terminé.");
  }

  // ---------- Démarrage ----------
  (async function boot() {
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
      $("#loading-msg").textContent = "Application non configurée : renseignez js/config.js (Supabase).";
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return screen("auth");
    enter();
  })();
})();
