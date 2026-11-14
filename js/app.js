(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const cfg = window.APP_CONFIG || {};

  // Garde-fou de version : la page et le programme doivent venir de la même mise en ligne.
  // Sinon (ancien programme ressorti du cache hors ligne), on vide le cache et on recharge une fois.
  const APP_VERSION = "__APP_VERSION__";
  (function checkVersion() {
    const meta = document.querySelector('meta[name="app-version"]');
    const pageV = meta ? meta.content : APP_VERSION;
    if (pageV === APP_VERSION || pageV.indexOf("__") === 0) return;
    let tried = false;
    try { tried = sessionStorage.getItem("vfix") === pageV; sessionStorage.setItem("vfix", pageV); } catch (e) {}
    if (tried) return;
    const purge = window.caches ? caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))) : Promise.resolve();
    purge.catch(() => {}).then(() => location.reload());
    throw new Error("Mise à jour de l'application…");
  })();
  const ADMIN_VIEWS = ["dashboard", "stats", "parametres", "rh"];

  let sb = null;
  let me = null;
  let db = emptyDb();
  let cart = [];
  let currentView = null;
  let lastReload = 0;
  const dash = { periode: "jour", ref: today(), cc: "ALL", boutique: "ALL" };
  let dashComPage = false; // admin : page « Commissions du crédit télécom » du tableau de bord

  function emptyDb() {
    return { settings: { nom: "BGTeam", devise: "FCFA", ccList: [] }, products: [], entries: [], sales: [], users: [], courses: [], boutiques: [], conges: [], fiches: [], charges: [], remontees: [], bobines: [], stocksInit: [], retraits: [], anniv: [], crAchats: [], crVers: [], crSoldes: [], crVentes: [], crAjust: [], crDemandes: [], crContacts: [], fgCourses: [], fgVentes: [], fgRetraits: [], fgSorties: [], fgDotations: [], fgLignes: [], fgAjust: [] };
  }
  const isAdmin = () => !!me && me.role === "admin";

  // ---------- Utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Séparateur des milliers bien visible (14 875) : l’espace fine du français est remplacée par une espace normale insécable
  function num(n) { return Number(n || 0).toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, "\u00a0"); }
  function money(n) { return num(n) + "\u00a0" + (db.settings.devise || "FCFA"); }
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
    if (/remontees_tx_unique/i.test(m)) return "Ce reçu (n° de transaction) a déjà été utilisé pour une autre remontée.";
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
    const [settingsRes, products, costs, ccs, entries, sales, users, courses, boutiques, conges, fiches, charges, remontees, bobines, stocksInit, retraits, crAchats, crVers, crSoldes, crVentes] = await Promise.all([
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
      fetchAll("rh_fiches", "cc"), // la base ne renvoie les fiches qu'à l'admin et aux CC « RH »
      // Charges, remontées et bobines : la base ne renvoie que ce que l'utilisateur a le droit de voir.
      fetchAll("charges", "date"),
      fetchAll("remontees", "created_at"),
      fetchAll("bobines_mvts", "created_at"),
      fetchAll("stocks_initiaux", "code"),
      isAdmin() ? fetchAll("retraits", "date") : Promise.resolve([]),
      fetchAll("credit_achats", "created_at"),
      fetchAll("credit_versements", "created_at"),
      fetchAll("credit_soldes", "date"),
      fetchAll("credit_ventes", "date")
    ]);
    const crAjust = await fetchAll("credit_ajustements", "created_at");
    // Demandes de versement des commissions (gestionnaire des commissions) ; table absente = aucune demande
    const crDemandes = await fetchAll("credit_demandes", "created_at").catch(() => []);
    // Contacts des CC « Contrôle Crédit » (téléphone de la fiche RH) : la base ne répond qu'à l'admin et au gestionnaire des commissions
    const crContacts = await sb.rpc("contacts_credit").then((r) => (r.error ? [] : r.data || []), () => []);
    // Frigo : courses et ventes visibles par la boutique ; détail des courses (prix d'achat) et retraits : admin
    const [fgCourses, fgDetails, fgVentes, fgRetraits, fgDotations] = await Promise.all([
      fetchAll("frigo_courses", "created_at"),
      isAdmin() ? fetchAll("frigo_courses_details", "course_id") : Promise.resolve([]),
      fetchAll("frigo_ventes", "date"),
      isAdmin() ? fetchAll("frigo_retraits", "created_at") : Promise.resolve([]),
      fetchAll("frigo_dotations", "created_at")
    ]);
    // Ventes en caisse des produits du frigo (calculées par la base : prix d'achat de la dernière course)
    let fgSorties = [];
    try { fgSorties = chk(await sb.rpc("frigo_sorties")) || []; } catch (e) { fgSorties = []; }
    // Stock frigo : lignes des courses (quantités ; prix d'achat pour l'admin)
    // Corrections du stock frigo faites par l'admin (écart d'inventaire)
    let fgAjust = [];
    try { fgAjust = await fetchAll("frigo_ajustements", "created_at"); } catch (e) { fgAjust = []; }
    let fgLignes = [];
    try { fgLignes = chk(await sb.rpc("frigo_stock_lignes")) || []; } catch (e) { fgLignes = []; }
    const st = chk(settingsRes) || {};
    // Anniversaires du jour (sans date ni âge) : pour les notifications
    let anniv = [];
    try { anniv = chk(await sb.rpc("anniversaires_du_jour")) || []; } catch (e) { anniv = []; }
    const pa = {}, cmp = {};
    costs.forEach((c) => { pa[c.code] = Number(c.pa); cmp[c.code] = c.cmp == null ? Number(c.pa) : Number(c.cmp); });
    db = {
      settings: {
        nom: st.nom || "BGTeam", domaine: st.domaine || "", tel: st.tel || "", adresse: st.adresse || "",
        email: st.email || "", rccm: st.rccm || "", devise: st.devise || "FCFA", numero_depot: st.numero_depot || "",
        tauxYas: st.taux_yas == null ? 5 : Number(st.taux_yas), tauxMoov: st.taux_moov == null ? 5 : Number(st.taux_moov),
        creditSeuil: st.credit_seuil == null ? 5000 : Number(st.credit_seuil),
        frigoSeuil: st.frigo_seuil == null ? 5000 : Number(st.frigo_seuil),
        ordreBlocs: st.ordre_blocs && typeof st.ordre_blocs === "object" ? st.ordre_blocs : {},
        ccList: ccs.map((c) => ({ code: String(c.code), actif: c.actif, agents: Array.isArray(c.agents) ? c.agents : [], boutique: c.boutique || "", entrees: !!c.entrees, voirStock: !!c.voir_stock, bobines: ["gestion", "saisie"].includes(c.bobines) ? c.bobines : "boutique", recoitEspeces: !!c.recoit_especes, gereRh: !!c.gere_rh, credit: !!c.credit, frigoDotation: !!c.frigo_dotation, gereCom: !!c.gere_commissions, colGereCom: "gere_commissions" in c, repos: Array.isArray(c.repos) ? c.repos.map(Number) : [] }))
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
      charges: charges.map((c) => ({ id: c.id, date: c.date, boutique: c.boutique || "", categorie: c.categorie, libelle: c.libelle || "", montant: Number(c.montant), saisiPar: c.saisi_par || "", createdBy: c.created_by, createdAt: c.created_at })),
      remontees: remontees.map((r) => ({ id: r.id, boutique: r.boutique, cc: r.cc ? String(r.cc) : "", semaine: r.semaine, montant: Number(r.montant), mode: r.mode, note: r.note || "",
        statut: r.statut, recuPar: r.recu_par || "", recuLe: r.recu_le, saisiPar: r.saisi_par || "", createdBy: r.created_by, createdAt: r.created_at,
        partRoulement: Number(r.part_roulement) || 0, partBenefice: Number(r.part_benefice) || 0, recuPath: r.recu_path || "",
        txId: r.tx_id || "", recuInfos: r.recu_infos || {}, alerte: r.alerte || "",
        ccReceveur: r.cc_receveur ? String(r.cc_receveur) : "", confirmeLe: r.reception_confirmee_le, confirmePar: r.reception_confirmee_par || "" })),
      retraits: retraits.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, montant: Number(x.montant), note: x.note || "", saisiPar: x.saisi_par || "" })),
      crAchats: crAchats.map((x) => ({ id: x.id, boutique: x.boutique, cc: x.cc ? String(x.cc) : "", date: x.date, op: x.operateur, montant: Number(x.montant), commission: Number(x.commission),
        reference: x.reference || "", saisiPar: x.saisi_par || "", createdBy: x.created_by, createdAt: x.created_at })),
      crVers: crVers.map((x) => ({ id: x.id, boutique: x.boutique, cc: x.cc ? String(x.cc) : "", mois: x.mois, montant: Number(x.montant), mode: x.mode, note: x.note || "",
        statut: x.statut, recuPar: x.recu_par || "", saisiPar: x.saisi_par || "", createdBy: x.created_by, createdAt: x.created_at })),
      crSoldes: crSoldes.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, op: x.operateur, solde: Number(x.solde), saisiPar: x.saisi_par || "", at: x.updated_at || x.created_at || "" })),
      fgCourses: fgCourses.map((x) => {
        const d = fgDetails.find((y) => y.course_id === x.id);
        return { id: x.id, boutique: x.boutique, date: x.date, valeur: Number(x.valeur_vente), cout: x.montant_course != null ? Number(x.montant_course) : d ? Number(d.total_course) : 0,
          saisiPar: x.saisi_par || "", createdAt: x.created_at,
          detail: d ? { lignes: Array.isArray(d.lignes) ? d.lignes : [], achats: Number(d.total_achats), deplacement: Number(d.frais_deplacement), sachet: Number(d.frais_sachet),
            autres: Number(d.frais_autres), autresLib: d.frais_autres_lib || "", total: Number(d.total_course) } : null };
      }),
      fgDotations: fgDotations.map((x) => ({ id: x.id, boutique: x.boutique, montant: Number(x.montant), statut: x.statut, courseId: x.course_id, saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      fgSorties: fgSorties.map((x) => ({ id: x.sale_id, boutique: x.boutique, date: x.date, createdAt: x.created_at, ticket: x.ticket, code: x.code, nom: x.nom || x.code,
        qte: Number(x.qte), pu: Number(x.pu), montant: Number(x.qte) * Number(x.pu), consomme: Number(x.consomme) })),
      fgLignes: fgLignes.map((x) => ({ courseId: x.course_id, boutique: x.boutique, date: x.date, createdAt: x.created_at, code: x.code || "", nom: x.nom || x.code || "",
        qte: Number(x.qte) || 0, achat: x.achat == null ? null : Number(x.achat), transfert: !!x.transfert })),
      fgVentes: fgVentes.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, montant: Number(x.montant), cc: x.cc ? String(x.cc) : "", saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      fgAjust: (fgAjust || []).map((x) => ({ id: x.id, boutique: x.boutique, code: x.code, qte: Number(x.qte) || 0, coutUnit: x.cout_unit == null ? null : Number(x.cout_unit), date: x.date, note: x.note || "", saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      fgRetraits: fgRetraits.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, montant: Number(x.montant), note: x.note || "", saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      crContacts: (crContacts || []).map((x) => ({ cc: String(x.cc), boutique: x.boutique || "", tel: x.telephone || "" })),
      crDemandes: (crDemandes || []).map((x) => ({ id: x.id, createdAt: x.created_at, demandeur: x.demandeur || "" })),
      crAjust: crAjust.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, op: x.operateur, montant: Number(x.montant), note: x.note || "", saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      crVentes: crVentes.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, op: x.operateur, montant: Number(x.montant), cc: x.cc ? String(x.cc) : "", saisiPar: x.saisi_par || "", createdAt: x.created_at })),
      anniv: anniv.map((a) => ({ cc: String(a.cc), nom: a.nom || "", sexe: a.sexe || "" })),
      stocksInit: stocksInit.map((s) => ({ code: s.code, boutique: s.boutique, qte: Number(s.qte) || 0 })),
      bobines: bobines.map((x) => ({ id: x.id, boutique: x.boutique, date: x.date, type: x.type, qte: Number(x.qte), note: x.note || "", cc: x.cc ? String(x.cc) : "", saisiPar: x.saisi_par || "", createdBy: x.created_by, createdAt: x.created_at })),
      boutiques: boutiques.map((b) => ({ code: b.code, nom: b.nom, actif: b.actif !== false,
        dotYas: b.dotation_yas == null ? 20000 : Number(b.dotation_yas), dotMoov: b.dotation_moov == null ? 10000 : Number(b.dotation_moov) }))
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
    ["loading", "auth", "pending", "mustpwd", "app"].forEach((n) => {
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
      const hadSession = !!(await sb.auth.getSession()).data.session;
      const { data: { user }, error: uerr } = await sb.auth.getUser();
      // Erreur réseau : on ne déconnecte pas, on laisse réessayer.
      if (!user && uerr && /fetch|network/i.test(uerr.message || "")) throw uerr;
      const refused = async () => {
        await sb.auth.signOut({ scope: "local" });
        screen("auth");
        authMsg("Votre demande d'accès a été refusée. Vous pouvez faire une nouvelle demande avec « Créer un compte ».");
      };
      if (!user) return hadSession ? refused() : screen("auth");
      const prof = chk(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
      if (!prof) return refused();
      if (!prof.actif) {
        $("#pending-email").textContent = user.email;
        return screen("pending");
      }
      // Mot de passe temporaire : il faut d'abord en choisir un
      if (prof.must_change_pwd) {
        $("#mustpwd-form").reset(); $("#mustpwd-msg").textContent = "";
        return screen("mustpwd");
      }
      me = prof;
      document.body.classList.toggle("role-admin", isAdmin());
      document.body.classList.toggle("role-vendeur", !isAdmin());
      $("#user-name").textContent = (me.nom || me.email) + " · " + (isAdmin() ? "Admin" : "Vendeur");
      // Numéro de version visible : permet de vérifier que la dernière mise en ligne est chargée
      if (APP_VERSION.indexOf("__") !== 0) $("#user-name").insertAdjacentHTML("beforeend", '<small class="app-ver" style="display:block;opacity:.6;font-weight:400;font-size:11px">Version ' + APP_VERSION + "</small>");
      await reload();
      screen("app");
      // Après actualisation : on revient sur le même menu (adresse #menu, sinon dernier menu mémorisé)
      let start = location.hash.slice(1);
      if (!canView(start)) { try { start = localStorage.getItem("menu-" + me.id) || ""; } catch (e) { start = ""; } }
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
  const RT_VIEWS = ["ventes", "dashboard", "stats", "facture", "rh", "compte", "fonds", "credit", "frigo", "bobines"];
  function startRealtime() {
    if (rtChannel || !sb) return;
    const onChange = () => {
      clearTimeout(rtTimer);
      rtTimer = setTimeout(async () => {
        if (!me || document.querySelector("dialog[open]")) return;
        try {
          await reload();
          // pas de rafraîchissement pendant une saisie (ex. ligne de course du frigo)
          const saisie = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
          if (RT_VIEWS.includes(currentView) && !saisie) render(currentView);
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
      .on("postgres_changes", { event: "*", schema: "public", table: "remontees" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "bobines_mvts" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "stocks_initiaux" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "retraits" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_achats" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_versements" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_soldes" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_ventes" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_ajustements" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "credit_demandes" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "frigo_courses" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "frigo_ventes" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "frigo_retraits" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "frigo_dotations" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "frigo_ajustements" }, onChange)
      .subscribe((status) => { rtLive = status === "SUBSCRIBED"; if (currentView === "ventes") renderSalesHistory(); });
  }
  function stopRealtime() {
    if (rtChannel) { sb.removeChannel(rtChannel); rtChannel = null; rtLive = false; }
  }
  window.addEventListener("focus", softRefresh);
  // Mise à jour automatique : si une nouvelle version est en ligne, on vide le cache et on recharge
  // (sauf pendant une saisie ou une fenêtre ouverte, pour ne rien faire perdre).
  async function checkUpdate(force) {
    if (APP_VERSION.indexOf("__") === 0 || !navigator.onLine) return false;
    try {
      const res = await fetch(location.pathname + "?maj=" + Date.now(), { cache: "no-store" });
      const html = await res.text();
      const m = html.match(/name="app-version" content="(\d+)"/);
      if (!m || m[1] === APP_VERSION) return false;
      // une liste déroulante sélectionnée ne bloque plus la mise à jour ; une saisie en cours, oui (sauf « Actualiser »)
      const occupe = document.querySelector("dialog[open]") || (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.value) || cart.length;
      if (occupe && force !== true) return false; // on réessaiera plus tard
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
      location.reload();
      return true;
    } catch (e) { return false; /* hors ligne : prochain essai */ }
  }
  window.addEventListener("focus", () => checkUpdate());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
  setInterval(() => checkUpdate(), 2 * 60 * 1000);
  setInterval(() => { try { if (me) renderAppAlert(); } catch (e) {} }, 60 * 1000);
  setInterval(() => { if (document.visibilityState === "visible") softRefresh(); }, 120000);
  // « Actualiser » : charge d'abord la nouvelle version de l'application s'il y en a une, sinon recharge les données
  $("#btn-refresh").addEventListener("click", async () => {
    if (await checkUpdate(true)) return;
    try { await reload(); render(currentView); toast("Données actualisées (version " + APP_VERSION + ")."); } catch (e) { toast(errMsg(e)); }
  });

  // Changement obligatoire après un mot de passe temporaire
  $("#mustpwd-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button"), msg = $("#mustpwd-msg");
    msg.classList.remove("ok");
    if (f.p1.value.length < 8) return (msg.textContent = "8 caractères minimum.");
    if (f.p1.value !== f.p2.value) return (msg.textContent = "Les deux mots de passe sont différents.");
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: f.p1.value });
    if (error) { btn.disabled = false; return (msg.textContent = /different from the old|same/i.test(error.message) ? "Choisissez un mot de passe différent du mot de passe temporaire." : errMsg(error)); }
    const r = await sb.rpc("password_changed");
    btn.disabled = false;
    if (r.error) return (msg.textContent = errMsg(r.error));
    toast("Mot de passe enregistré. Bienvenue !");
    enter();
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
  // Les ventes en caisse des produits du frigo sortent du STOCK FRIGO, pas du stock principal.
  let fgIdsSrc = null, fgIds = new Set(), fgCouts = new Map();
  function majFg() {
    if (fgIdsSrc === db.fgSorties) return;
    fgIdsSrc = db.fgSorties;
    fgIds = new Set((db.fgSorties || []).map((x) => x.id));
    // coût d'achat UNITAIRE d'une vente du frigo = prix d'achat de la ligne de course (consommé ÷ quantité)
    fgCouts = new Map((db.fgSorties || []).filter((x) => x.qte > 0 && x.consomme != null).map((x) => [x.id, x.consomme / x.qte]));
  }
  function venteFrigo(s) { majFg(); return fgIds.has(s.id); }
  /** Prix d'achat unitaire d'une vente de produit du frigo (course du frigo), ou null si ce n'est pas une vente du frigo */
  function coutFrigo(s) { majFg(); return fgCouts.has(s.id) ? fgCouts.get(s.id) : null; }
  function totalVentes(code, bq) {
    return db.sales.filter((s) => s.code === code && isCountedSale(s) && inBq(bq, saleBoutique(s)) && !venteFrigo(s)).reduce((a, s) => a + Number(s.qte), 0);
  }
  // Stock initial par boutique (table stocks_initiaux) ; « ALL » = somme des boutiques existantes.
  function stockInitialOf(p, bq) {
    if (!bq || bq === "ALL") return db.stocksInit.filter((s) => s.code === p.code && db.boutiques.some((b) => b.code === s.boutique)).reduce((a, s) => a + s.qte, 0);
    const r = db.stocksInit.find((s) => s.code === p.code && s.boutique === bq);
    return r ? r.qte : 0;
  }
  // Stock transféré du stock principal vers le frigo de la boutique (course de transfert)
  function totalTransfert(code, bq) { return (db.fgLignes || []).filter((l) => l.transfert && l.code === code && inBq(bq, l.boutique)).reduce((a, l) => a + l.qte, 0); }
  // L'ancien stock principal est retiré (14/11/2026) : toutes les boutiques utilisent le STOCK FRIGO
  function stockActuel(p, bq) {
    if (bq && bq !== "ALL") return stockFrigoOf(p.code, bq);
    return db.boutiques.reduce((a, b) => a + stockFrigoOf(p.code, b.code), 0);
  }
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
  // Téléphone : les tableaux s'affichent en cartes (voir style.css, classe .mob).
  // Chaque cellule reçoit le nom de sa colonne (data-label) à partir de l'en-tête du tableau.
  // « 12/11/2026 », « jeudi 12/11/2026 » ou « 12/11 14:05 » → « Aujourd'hui, 13 nov. » / « Hier, 12 nov. » / « mercredi, 11 nov. »
  const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  function titreDateMixx(txt) {
    const m = String(txt).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (!m) return txt;
    const auj = parse(today()), an = m[3] ? Number(m[3]) : auj.getFullYear();
    const d = new Date(an, Number(m[2]) - 1, Number(m[1]), 12); // midi, comme parse()
    const ecart = Math.round((auj - d) / 86400000);
    const jour = ecart === 0 ? "Aujourd'hui" : ecart === 1 ? "Hier" : d.toLocaleDateString("fr-FR", { weekday: "long" });
    return jour + ", " + d.getDate() + " " + MOIS_COURTS[d.getMonth()] + (an !== auj.getFullYear() ? " " + an : "");
  }
  function etiqueterTableaux() {
    document.querySelectorAll("table.table").forEach((t) => {
      if (t.matches(".planning, .course-lines, .no-cards")) return;
      const tete = t.querySelector(":scope > thead > tr:last-child");
      if (!tete) return;
      const noms = [];
      [...tete.children].forEach((th) => { for (let k = 0; k < (th.colSpan || 1); k++) noms.push(th.textContent.replace(/\s+/g, " ").trim()); });
      // Téléphone : présentation « liste » façon historique Mixx (titre + montant à droite, détails en dessous, dates en en-tête)
      t.classList.add("mobl");
      const estDate = (n) => /^(date|jour|déclarée? le|semaine)$/i.test(n);
      const colDate = estDate(noms[0] || "") ? 0 : -1, parSemaine = /^semaine$/i.test(noms[0] || "");
      const colHeure = noms.findIndex((n) => /^heure$/i.test(n));
      const PRIO = [/^montant/i, /^total/i, /reste/i, /chiffre|^ca\b/i, /stock actuel/i, /commission/i, /^vendu|^ventes?\b/i, /quantit|^qté/i, /prix de vente/i, /restant/i];
      let dateAvant = null;
      t.querySelectorAll(":scope > tbody > tr, :scope > tfoot > tr").forEach((tr) => {
        let i = 0;
        const cells = [...tr.children], infos = [];
        cells.forEach((td) => {
          const lib = (td.colSpan || 1) > 1 ? "" : noms[i] || "";
          if (td.getAttribute("data-label") !== lib) td.setAttribute("data-label", lib);
          infos.push({ td, lib, idx: i });
          i += td.colSpan || 1;
          td.classList.remove("r-titre", "r-montant", "r-date", "r-act");
        });
        if (cells.length === 1 && (cells[0].colSpan || 1) > 1) return; // ligne « vide » / détail
        const pleines = infos.filter((x) => x.td.textContent.trim() || x.td.querySelector("input, select, img, svg"));
        // date en en-tête de groupe (comme « mercredi, 11 nov. »)
        let heure = "";
        if (colDate === 0 && infos[0] && tr.parentElement.tagName === "TBODY") {
          const brut = infos[0].td.textContent.trim(); infos[0].td.classList.add("r-date");
          const hm = brut.match(/(\d{1,2}):(\d{2})/); if (hm) heure = hm[0];
          const d = parSemaine ? "Semaine du " + brut.replace(/^du\s*/i, "") : titreDateMixx(brut);
          if (d !== dateAvant) { tr.setAttribute("data-date-head", d); dateAvant = d; } else tr.removeAttribute("data-date-head");
        }
        // colonne « Heure » : affichée sous le montant, à droite (comme Mixx)
        const ih = infos.find((x) => x.idx === colHeure);
        if (ih) { heure = ih.td.textContent.trim(); ih.td.classList.add("r-date"); }
        const sansSaisie = (x) => !x.td.querySelector("input, select, button");
        const candTitre = (x) => !x.td.classList.contains("r-date") && sansSaisie(x) && !x.td.classList.contains("num");
        const titre = pleines.find((x) => candTitre(x) && /désignation|produit|^nom|article|^cc$|vendeur|client/i.test(x.lib)) || pleines.find(candTitre);
        let montant = null;
        for (const re of PRIO) { montant = pleines.find((x) => x !== titre && re.test(x.lib) && sansSaisie(x)); if (montant) break; }
        if (!montant) montant = pleines.slice().reverse().find((x) => x !== titre && x.td.classList.contains("num") && sansSaisie(x));
        if (titre) titre.td.classList.add("r-titre");
        if (montant) montant.td.classList.add("r-montant");
        cells.forEach((td) => { if (td.dataset.heure && (td !== (montant && montant.td) || !heure)) td.removeAttribute("data-heure"); });
        if (montant && heure && heure !== "—") montant.td.setAttribute("data-heure", heure);
        infos.forEach((x) => { if (!x.lib && x.td.querySelector("button, a.btn") && x !== titre) x.td.classList.add("r-act"); });
      });
    });
  }
  // Cadres déplaçables (▲ ▼) dans les pages Crédit télécom et Frigo : SEUL L'ADMIN les déplace ; l'ordre est enregistré
  // dans la base (settings.ordre_blocs) et s'applique à tous les CC (au chargement / à l'actualisation).
  const BLOC_CONTENEURS = ["#cr-main", "#fg-main"];
  const blocsDe = (c) => [...c.children].filter((e) => e.matches(".card, .op-cards, .frigo-cards, details"));
  BLOC_CONTENEURS.forEach((sel) => { const c = document.querySelector(sel); if (c) blocsDe(c).forEach((b, i) => { b.dataset.bloc = b.id || c.id + "-" + i; b.classList.add("bloc-mobile"); }); });
  const ordresBlocs = () => (db.settings && db.settings.ordreBlocs) || {};
  const blocsAppliques = {}; // dernier ordre appliqué par page (réappliqué si l'admin le change)
  function appliquerOrdreBlocs(view) {
    const sel = view === "credit" ? "#cr-main" : view === "frigo" ? "#fg-main" : "";
    const c = sel && document.querySelector(sel); if (!c || !me) return;
    const ordre = Array.isArray(ordresBlocs()[c.id]) ? ordresBlocs()[c.id] : [];
    const sig = JSON.stringify(ordre); if (blocsAppliques[c.id] === sig) return;
    blocsAppliques[c.id] = sig;
    if (!ordre.length) return;
    const blocs = blocsDe(c), rang = (b) => { const i = ordre.indexOf(b.dataset.bloc); return i < 0 ? 1000 + blocs.indexOf(b) : i; };
    // Réordonne les cadres À LEUR PLACE (les éléments non déplaçables, ex. « Nouvelle recharge / Commission », restent où ils sont)
    const reperes = blocs.map((b) => { const m = document.createComment(""); c.insertBefore(m, b); return m; });
    blocs.slice().sort((a, b) => rang(a) - rang(b)).forEach((b, i) => c.insertBefore(b, reperes[i]));
    reperes.forEach((m) => m.remove());
  }
  function poignéesBlocs() {
    BLOC_CONTENEURS.forEach((sel) => {
      const c = document.querySelector(sel); if (!c) return;
      blocsDe(c).forEach((b) => {
        if (!isAdmin()) { const m = b.querySelector(":scope > .bloc-move"); if (m) m.remove(); return; } // flèches pour l'admin seulement
        if (!b.querySelector(":scope > .bloc-move")) {
          const m = document.createElement("div");
          m.className = "bloc-move";
          m.innerHTML = '<button type="button" data-bloc-mv="-1" title="Monter ce cadre">▲</button><button type="button" data-bloc-mv="1" title="Descendre ce cadre">▼</button>';
          b.appendChild(m);
        }
        b.classList.toggle("bloc-vide", b.children.length <= 1);
      });
    });
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-bloc-mv]"); if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const b = btn.closest(".bloc-mobile"), c = b.parentElement, dir = Number(btn.dataset.blocMv);
    const visibles = blocsDe(c).filter((x) => x === b || (x.offsetHeight > 20 && !x.classList.contains("bloc-vide")));
    const i = visibles.indexOf(b), cible = visibles[i + dir];
    if (!cible) return toast(dir < 0 ? "Ce cadre est déjà tout en haut." : "Ce cadre est déjà tout en bas.");
    if (!isAdmin()) return;
    c.insertBefore(b, dir < 0 ? cible : cible.nextSibling);
    enregistrerOrdre(c.id, blocsDe(c).map((x) => x.dataset.bloc));
    b.classList.remove("bloc-flash"); void b.offsetWidth; b.classList.add("bloc-flash");
    b.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, true);
  // Enregistre un ordre (cadres d'une page ou cartes boutiques) dans la base : il s'applique à tous les CC
  async function enregistrerOrdre(cle, ordre) {
    const tout = { ...ordresBlocs(), [cle]: ordre };
    db.settings.ordreBlocs = tout; blocsAppliques[cle] = JSON.stringify(ordre);
    const { error } = await sb.from("settings").update({ ordre_blocs: tout }).eq("id", 1);
    if (error) toast("Ordre non enregistré pour les CC : " + errMsg(error));
    else toast("Nouvel ordre enregistré : il s'applique à tous les CC après actualisation.");
  }
  // Lignes / cartes cliquables : choisissent la boutique dans le filtre de la page (si l'utilisateur y a accès)
  document.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input, select, [data-bloc-mv]")) return;
    const r = e.target.closest("[data-go-filtre]"); if (!r) return;
    const sel = document.querySelector(r.dataset.goFiltre), v = r.dataset.goBq;
    if (!sel || sel.disabled || ![...sel.options].some((o) => o.value === v)) return;
    sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  let etiqTimer = null;
  new MutationObserver(() => { if (etiqTimer) return; etiqTimer = requestAnimationFrame(() => { etiqTimer = null; etiqueterTableaux(); poignéesBlocs(); }); })
    .observe(document.body, { childList: true, subtree: true });
  function kpiHtml(items) {
    return items.map(([l, v, c, attrs]) => '<div class="kpi ' + (c || "") + '"' + (attrs ? " " + attrs : "") + '><div class="label">' + l + '</div><div class="value">' + v + "</div></div>").join("");
  }

  // ---------- Navigation ----------
  // Entrées de stock : admin, ou CC autorisé par l'admin (colonne ccs.entrees, contrôlée aussi côté serveur).
  function canEntrees() {
    if (isAdmin()) return true;
    const c = me && me.cc ? ccByCode(me.cc) : null;
    return !!(c && c.actif && c.entrees);
  }
  // CC autorisé par l'admin à gérer les fiches RH (onglet Fiche CC uniquement)
  function isRhCc() { if (isAdmin()) return false; const c = me && me.cc ? ccByCode(me.cc) : null; return !!(c && c.actif && c.gereRh); }
  // Menus retirés (remplacés par Frigo → Nouvelle course et Frigo → Stock frigo). Le code est gardé : remettre ici pour les réactiver.
  const MENUS_RETIRES = ["stock", "entrees"];
  function canView(view) {
    if (MENUS_RETIRES.includes(view)) return false;
    if (view === "rh" && isRhCc()) return true;
    if (view === "dashboard" && canGererCom()) return true; // gestionnaire des commissions : tableau de bord réduit aux commissions
    if (!document.getElementById("view-" + view) || (!isAdmin() && ADMIN_VIEWS.includes(view))) return false;
    if (view === "fonds") return canFonds();
    if (view === "bobines") return bobinesDroit() !== "non";
    if (view === "credit") return canCreditSaisie() || isGlobal() || !!myBoutiqueCode(); // tous les CC voient le crédit de leur boutique
    if (view === "frigo") return canFrigo();
    return true;
  }
  function show(view) {
    if (!canView(view)) view = isAdmin() ? "dashboard" : "caisse";
    dashComPage = false; // le menu ramène au tableau de bord principal
    currentView = view;
    // Mémorise le menu ouvert (adresse + navigateur) pour le retrouver après une actualisation
    try { if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view); } catch (e) {}
    try { if (me) localStorage.setItem("menu-" + me.id, view); } catch (e) {}
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    // Titre de la barre mobile = rubrique ouverte
    const nb = document.querySelector('#nav button[data-view="' + view + '"]');
    $("#m-title").textContent = nb ? nb.textContent.trim() : view === "stats" ? "Statistiques" : "BGTeam";
    document.body.classList.remove("nav-open");
    render(view);
    window.scrollTo(0, 0);
  }
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) show(b.dataset.view);
  });
  // Menu en tiroir sur téléphone
  $("#nav-toggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $("#nav-overlay").addEventListener("click", () => document.body.classList.remove("nav-open"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.body.classList.remove("nav-open"); });
  let jourAffiche = today();
  function render(view) {
    try { appliquerOrdreBlocs(view); } catch (e) { /* jamais bloquant */ }
    // Application restée ouverte après minuit : on remet les dates du jour (caisse, tableau de bord)
    if (today() !== jourAffiche) {
      if (dash.ref === jourAffiche) dash.ref = today();
      if ($("#c-date").value === jourAffiche) $("#c-date").value = today();
      jourAffiche = today();
    }
    // CC non autorisé : pas de formulaire de saisie, seulement l'historique des courses.
    document.body.classList.toggle("no-entrees", !canEntrees());
    document.body.classList.toggle("no-fonds", !canFonds());
    document.body.classList.toggle("no-bobines", bobinesDroit() === "non");
    document.body.classList.toggle("no-rh", !isAdmin() && !isRhCc());
    document.body.classList.toggle("no-credit", !canCreditSaisie() && !isGlobal() && !myBoutiqueCode());
    document.body.classList.toggle("no-credit-saisie", !canCreditSaisie());
    document.body.classList.toggle("no-cloture", !canCloture());
    document.body.classList.toggle("no-frigo", !canFrigo());
    document.body.classList.toggle("no-frigo-vente", !canFrigoVente());
    document.body.classList.toggle("no-frigo-dot", !canFrigoDotation());
    document.body.classList.toggle("no-frigo-course", !canFrigoCourse());
    document.body.classList.toggle("rh-limite", isRhCc());
    document.body.classList.toggle("no-dash", !canView("dashboard"));
    $("#view-dashboard").classList.toggle("com-only", !isAdmin() || dashComPage);
    if (!canView(view)) return show(view); // droit retiré en direct : on quitte la page
    try { renderAppAlert(); } catch (e) { /* jamais bloquant */ }
    $("#brand-name").textContent = db.settings.nom;
    document.title = db.settings.nom + " — Boutique";
    ({
      dashboard: renderDashboard, caisse: renderCaisse, ventes: renderVentes, stats: renderStats,
      stock: renderStock, entrees: renderEntrees, fonds: renderFonds, bobines: renderBobines, credit: renderCredit, frigo: renderFrigo, facture: renderFacture, parametres: renderParametres, rh: renderRh, compte: renderCompte
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
  // Coût d'achat unitaire d'une vente : produit du frigo → prix d'achat de la course du frigo ; sinon coût du stock principal
  function costOf(s) { const f = coutFrigo(s); if (f != null) return f; if (s.cout != null) return s.cout; const p = productByCode(s.code); return p ? p.cmp : 0; }
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
    // produits du frigo de la boutique (au moins une course ou correction)
    if (!bq || bq === "ALL") return db.boutiques.some((b) => estFrigo(p.code, b.code));
    return estFrigo(p.code, bq);
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

  // Admin : page « Commissions du crédit télécom » ouverte depuis le tableau de bord (bouton sous « Statistiques détaillées »)
  function setDashComPage(on) { dashComPage = on; render("dashboard"); window.scrollTo(0, 0); }
  $("#tb-com-ouvrir").addEventListener("click", () => setDashComPage(true));
  $("#tb-com-retour").addEventListener("click", () => setDashComPage(false));
  // Mois dont la commission n'est pas encore versée (les versements soldent d'abord les mois les plus anciens)
  function moisCommissionDus(bq) {
    const parMois = {};
    db.crAchats.filter((x) => x.boutique === bq).forEach((x) => { const m = String(x.date).slice(0, 7); parMois[m] = (parMois[m] || 0) + x.commission; });
    let paye = sumBy(db.crVers.filter((v) => v.boutique === bq), (v) => v.montant);
    return Object.keys(parMois).sort().filter((m) => { const reste = parMois[m] - paye; paye = Math.max(0, paye - parMois[m]); return reste > 0.5; });
  }
  // « du mois d'octobre 2026 » / « des mois d'octobre 2026 et de novembre 2026 »
  function libelleMois(liste) {
    const de = (m) => { const t = fmtMonth(m + "-01"); return (/^[aeiouyhâéè]/i.test(t) ? "d'" : "de ") + t; };
    if (!liste.length) return "";
    if (liste.length === 1) return " du mois " + de(liste[0]);
    return " des mois " + liste.slice(0, -1).map(de).join(", ") + " et " + de(liste[liste.length - 1]);
  }
  // Message WhatsApp au CC : « Bonjour Monsieur / Madame NOM, merci de verser la commission … du mois de … : X FCFA. »
  // « Monsieur NOM » / « Madame NOM » selon la fiche RH (sans civilité si le sexe n'est pas renseigné)
  function civiliteNom(cc) {
    const f = (db.fiches || []).find((x) => String(x.cc) === String(cc)) || {};
    return (f.sexe === "M" ? "Monsieur " : f.sexe === "F" ? "Madame " : "") + (currentAgent(ccByCode(cc)) || ccName(cc));
  }
  // Relance du contrôle du soir (crédit restant lu sur les puces non déclaré aujourd'hui)
  function messageControle(cc, bq) {
    const h = new Date().getHours() >= 17 ? "Bonsoir " : "Bonjour ";
    return h + civiliteNom(cc) + ", le contrôle du crédit restant (YAS et MOOV) de " + boutiqueName(bq) + " n'est pas encore déclaré aujourd'hui (" + fmtDate(today()) + ")" +
      (hierManquant(bq) ? ", ni celui d'hier" : "") + ". Merci de lire le crédit restant sur les puces et de le déclarer sur l'application BGTEAM.";
  }
  // Relances WhatsApp : « controle » (contrôle du soir) ou « commission » (commission des mois passés, le 1er et le 2)
  let relanceMode = null, relanceEnvoyees = { controle: new Set(), commission: new Set() }, relanceJour = "";
  function messageCommission(cc, bq, reste, moisPassesSeulement) {
    const f = (db.fiches || []).find((x) => String(x.cc) === String(cc)) || {};
    const civ = f.sexe === "M" ? "Monsieur " : f.sexe === "F" ? "Madame " : "";
    const nom = currentAgent(ccByCode(cc)) || ccName(cc);
    if (!(reste > 0)) return "Bonjour " + civ + nom + ",";
    return "Bonjour " + civ + nom + ", merci de verser la commission du crédit télécom de " + boutiqueName(bq) + libelleMois(moisCommissionDus(bq).filter((m) => !moisPassesSeulement || m < today().slice(0, 7))) + " : " + money0(reste) + ". Sur l'application BGTEAM";
  }
  // Petit logo WhatsApp (SVG) pour le bouton rond
  const ICONE_WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.1c-.24.68-1.42 1.3-1.95 1.34-.5.05-.97.23-3.27-.68-2.77-1.09-4.52-3.92-4.66-4.1-.13-.18-1.11-1.48-1.11-2.82 0-1.34.7-2 .95-2.27.25-.27.54-.34.72-.34h.52c.17 0 .39-.06.6.46.23.54.77 1.88.84 2.02.07.13.11.29.02.47-.09.18-.13.29-.27.45-.13.16-.28.35-.4.47-.13.13-.27.28-.12.55.16.27.7 1.15 1.5 1.86 1.03.92 1.9 1.2 2.17 1.34.27.13.43.11.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.23.61-.14.25.09 1.58.75 1.85.88.27.14.45.2.52.32.07.11.07.66-.17 1.33Z"/></svg>';
  // Lien WhatsApp (wa.me) : numéro togolais à 8 chiffres complété par l'indicatif 228 ; message pré-rempli
  function lienWhatsApp(tel, message) {
    let n = String(tel || "").replace(/\D/g, "");
    if (n.startsWith("00")) n = n.slice(2);
    if (n.length === 8) n = "228" + n;
    return "https://wa.me/" + n + (message ? "?text=" + encodeURIComponent(message) : "");
  }
  // La demande de versement des commissions se fait le 1er et le 2 de chaque mois
  function jourDemande() { return Number(today().slice(8, 10)) <= 2; }
  // Cadre « Commissions du crédit télécom » du tableau de bord (gestionnaire des commissions et admin)
  function renderDashCom() {
    const card = $("#dash-com");
    card.classList.toggle("hidden", !canGererCom());
    if (!canGererCom()) return;
    const bqs = boutiquesCredit(), sel = $("#dc-boutique"), cur = sel.value || "ALL";
    sel.innerHTML = '<option value="ALL">Toutes les boutiques</option>' + bqs.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    sel.value = cur === "ALL" || bqs.some((b) => b.code === cur) ? cur : "ALL";
    const scope = sel.value === "ALL" ? bqs : bqs.filter((b) => b.code === sel.value), codes = scope.map((b) => b.code);
    const mois = today().slice(0, 7);
    const infos = scope.map((b) => ({ b, c: commissionInfo(b.code), m: sumBy(db.crAchats.filter((x) => x.boutique === b.code && String(x.date).slice(0, 7) === mois), (x) => x.commission) }));
    const s = (f) => infos.reduce((a, x) => a + f(x), 0);
    const reste = s((x) => x.c.aDeclarer), attente = s((x) => x.c.attente);
    $("#dc-kpis").innerHTML = kpiHtml([
      [sel.value === "ALL" ? "Commissions — toutes les boutiques" : "Commissions — " + esc(scope[0] ? scope[0].nom : ""), money0(s((x) => x.c.total)), "", 'title="Total des commissions gagnées sur les recharges"'],
      ["Commission du mois", money0(s((x) => x.m))],
      ["Reçue (confirmée)", money0(s((x) => x.c.recu)), "hero-good"],
      ["Déclarée, à confirmer", money0(attente), attente > 0 ? "warn" : ""],
      ["Reste à verser", money0(reste), reste > 0 ? "danger" : "hero-good"]
    ]);
    // Demande de versement
    const dem = demandeActive(), aRelancer = scope.filter((b) => comARelancer(b.code) > 0);
    $("#dc-demande").innerHTML = "<p>" + (dem ? "📣 Demande de versement envoyée le <b>" + new Date(dem.createdAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + "</b> par " + esc(dem.demandeur || "—") +
        " — les CC peuvent verser tout de suite. " : "🔔 Rappel automatique le <b>1er et le 2</b> de chaque mois pour les commissions des mois passés. ") +
      (aRelancer.length ? "<b>" + aRelancer.length + "</b> boutique" + (aRelancer.length > 1 ? "s" : "") + " reçoi" + (aRelancer.length > 1 ? "vent" : "t") + " la notification jusqu'au versement : " + aRelancer.map((b) => esc(b.nom)).join(", ") + "."
        : "Aucune boutique à relancer pour l'instant.") + "</p>" +
      (jourDemande() ? '<button class="btn primary" id="dc-demander"' + (reste > 0 ? "" : " disabled") + ">📣 Demander le versement des commissions</button>"
        : '<button class="btn" disabled title="La demande se fait le 1er et le 2 de chaque mois">📣 Demande possible le 1er et le 2 du mois (prochaine : ' + fmtDate(premierDuMois(addDays(premierDuMois(today()), 32))) + ")</button>");
    // Contacts : CC « Contrôle Crédit » de chaque boutique, avec leur téléphone (lien pour appeler)
    // Source : fiches RH (admin et CC autorisés RH, comme EDWIGE) ; sinon la fonction contacts_credit de la base si elle existe
    const telDe = (cc) => { const f = (db.fiches || []).find((x) => String(x.cc) === String(cc)); return f ? f.telephone || "" : ""; };
    const sourceContacts = db.crContacts.length ? db.crContacts
      : db.settings.ccList.filter((c) => c.actif && c.credit).map((c) => ({ cc: c.code, boutique: c.boutique, tel: telDe(c.code) }));
    const contacts = sourceContacts.filter((x) => sel.value === "ALL" || x.boutique === sel.value)
      .sort((a, b) => boutiqueName(a.boutique).localeCompare(boutiqueName(b.boutique)) || ccName(a.cc).localeCompare(ccName(b.cc)));
    $("#dc-contacts").innerHTML = contacts.length ? contacts.map((x) => {
      const reste = x.boutique ? commissionInfo(x.boutique).aDeclarer : 0, tel = String(x.tel || "").trim();
      return "<tr><td>" + esc(x.boutique ? boutiqueName(x.boutique) : "Non affecté") + "</td><td><b>" + esc(ccName(x.cc)) + "</b></td><td>" +
        (tel ? '<span class="tel-actions"><a class="btn small" href="tel:' + esc(tel.replace(/[^\d+]/g, "")) + '">📞 ' + esc(tel) + "</a>" +
          ' <a class="btn small btn-wa" target="_blank" rel="noopener" href="' + esc(lienWhatsApp(tel, messageCommission(x.cc, x.boutique, reste))) + '" title="Écrire sur WhatsApp" aria-label="Écrire sur WhatsApp">' + ICONE_WA + "</a></span>"
          : '<span class="muted">Numéro non renseigné (fiche RH)</span>') +
        '</td><td class="num">' + (reste > 0 ? '<b class="neg">' + money0(reste) + "</b>" : '<span class="pos">0</span>') + "</td></tr>";
    }).join("") : '<tr><td colspan="4" class="empty">Aucun CC coché « Contrôle Crédit »' + (sel.value === "ALL" ? "" : " dans cette boutique") + ".</td></tr>";
    // 📲 Relances WhatsApp des CC « Contrôle Crédit »
    if (relanceJour !== today()) { relanceJour = today(); relanceEnvoyees = { controle: new Set(), commission: new Set() }; }
    const enCredit = (x) => x.boutique && boutiquesCredit().some((b) => b.code === x.boutique);
    const listes = {
      // contrôle du crédit restant (lu sur la puce) pas encore déclaré aujourd'hui
      controle: contacts.filter((x) => enCredit(x) && !venteFaite(x.boutique, today())),
      // commission des mois passés pas encore versée (relance du 1er et du 2 du mois)
      commission: contacts.filter((x) => enCredit(x) && commissionInfo(x.boutique).duAncien > 0),
    };
    const ouvertCom = jourDemande();
    $("#dc-relance-btn").innerHTML =
      '<button class="btn small ' + (listes.controle.length ? "primary" : "") + '" data-relance-ouvrir="controle"' + (listes.controle.length ? "" : " disabled") + ">📲 Relancer le contrôle du soir" + (listes.controle.length ? " (" + listes.controle.length + ")" : " : tout est fait ✓") + "</button> " +
      '<button class="btn small ' + (ouvertCom && listes.commission.length ? "primary" : "") + '" data-relance-ouvrir="commission"' + (ouvertCom && listes.commission.length ? "" : " disabled") +
        (ouvertCom ? "" : ' title="La relance de la commission se fait le 1er et le 2 de chaque mois"') + ">💸 Relancer la commission du mois passé" +
        (!ouvertCom ? " (le 1er et le 2)" : listes.commission.length ? " (" + listes.commission.length + ")" : " : tout est versé ✓") + "</button>";
    if (relanceMode === "commission" && !ouvertCom) relanceMode = null;
    const liste = relanceMode ? listes[relanceMode] : [], envoyees = relanceMode ? relanceEnvoyees[relanceMode] : new Set();
    const zone = $("#dc-relance");
    zone.classList.toggle("hidden", !relanceMode || !liste.length);
    if (relanceMode && liste.length) {
      const restants = liste.filter((x) => !envoyees.has(x.cc));
      const intro = relanceMode === "controle"
        ? "<b>" + liste.length + " CC</b> n'ont pas encore déclaré le crédit restant lu sur la puce aujourd'hui."
        : "<b>" + liste.length + " CC</b> n'ont pas encore versé la commission des mois passés.";
      zone.innerHTML = '<div class="dc-relance-tete"><p>' + intro + " Appuyez sur le bouton vert de chaque CC : WhatsApp s'ouvre avec le message déjà écrit, il suffit d'appuyer sur Envoyer.</p>" +
        (restants.length ? '<button class="btn small success" id="dc-relance-suivant">💬 Ouvrir le suivant (' + restants.length + " restant" + (restants.length > 1 ? "s" : "") + ")</button>" : '<span class="badge ok">✓ Tous relancés</span>') + "</div>" +
        liste.map((x) => {
          const tel = String(x.tel || "").trim(), env = envoyees.has(x.cc);
          const detail = relanceMode === "controle" ? (hierManquant(x.boutique) ? "⚠ hier aussi manquant" : "contrôle : pas encore") : "commission due : " + money0(commissionInfo(x.boutique).duAncien);
          const msg = relanceMode === "controle" ? messageControle(x.cc, x.boutique) : messageCommission(x.cc, x.boutique, commissionInfo(x.boutique).duAncien, true);
          return '<div class="dc-relance-ligne' + (env ? " envoye" : "") + '"><div><b>' + esc(ccName(x.cc)) + "</b><small>" + esc(boutiqueName(x.boutique)) + " · " + detail + "</small></div>" +
            (tel ? '<a class="btn small btn-wa" target="_blank" rel="noopener" data-relance-cc="' + esc(x.cc) + '" href="' + esc(lienWhatsApp(tel, msg)) + '" title="Relancer sur WhatsApp">' + ICONE_WA + "</a>"
              : '<span class="muted">pas de numéro (fiche RH)</span>') + (env ? '<span class="badge ok">✓ envoyé</span>' : "") + "</div>";
        }).join("");
    }
    $("#dc-rows").innerHTML = infos.length ? infos.map(({ b, c, m }) => {
      const etat = c.aDeclarer <= 0 && c.attente <= 0 ? '<span class="badge ok">✓ À jour</span>' : c.aDeclarer <= 0 ? '<span class="badge warn">⏳ À confirmer</span>'
        : comARelancer(b.code) > 0 ? '<span class="badge danger">🔔 Relancé</span>' : '<span class="badge">À verser</span>';
      return '<tr class="cliquable" data-go-filtre="#dc-boutique" data-go-bq="' + esc(b.code) + '" title="Voir seulement ' + esc(b.nom) + '"><td><b>' + esc(b.nom) + '</b></td><td class="num">' + money0(m) + '</td><td class="num">' + money0(c.total) + '</td><td class="num">' + money0(c.recu) + '</td><td class="num">' + money0(c.attente) +
        '</td><td class="num">' + (c.aDeclarer > 0 ? '<b class="neg">' + money0(c.aDeclarer) + "</b>" : '<span class="pos">0</span>') + "</td><td>" + etat + "</td></tr>";
    }).join("") : '<tr><td colspan="7" class="empty">Aucune boutique.</td></tr>';
    const vers = db.crVers.filter((v) => codes.includes(v.boutique)).sort((a, b) => (a.statut === "Reçue") - (b.statut === "Reçue") || String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60);
    $("#dc-vers").innerHTML = vers.length ? vers.map((v) => "<tr><td>" + (v.createdAt ? new Date(v.createdAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—") + "</td><td>" + esc(boutiqueName(v.boutique)) +
      "</td><td>" + esc(v.cc ? ccName(v.cc) : "Admin") + '</td><td class="num"><b>' + money0(v.montant) + "</b></td><td>" + esc(v.mode || "") + "</td><td>" +
      (v.statut === "Reçue" ? '<span class="badge ok">✓ Reçue</span> <small class="muted">' + esc(v.recuPar || "") + "</small>"
        : '<button class="btn small success" data-dc-recu="' + v.id + '">✓ J\'ai reçu ' + money0(v.montant) + "</button>") + "</td></tr>").join("")
      : '<tr><td colspan="6" class="empty">Aucun versement déclaré.</td></tr>';
  }
  $("#dc-boutique").addEventListener("change", () => renderDashCom());
  // Relance WhatsApp : ouvrir / fermer la liste, marquer « envoyé », ouvrir le CC suivant
  $("#dash-com").addEventListener("click", (e) => {
    const ouv = e.target.closest("[data-relance-ouvrir]");
    if (ouv) { relanceMode = relanceMode === ouv.dataset.relanceOuvrir ? null : ouv.dataset.relanceOuvrir; return renderDashCom(); }
    const wa = e.target.closest("[data-relance-cc]");
    if (wa && relanceMode) { relanceEnvoyees[relanceMode].add(wa.dataset.relanceCc); setTimeout(renderDashCom, 300); return; }
    if (e.target.closest("#dc-relance-suivant") && relanceMode) {
      const lien = [...document.querySelectorAll("#dc-relance [data-relance-cc]")].find((a) => !relanceEnvoyees[relanceMode].has(a.dataset.relanceCc));
      if (lien) { relanceEnvoyees[relanceMode].add(lien.dataset.relanceCc); window.open(lien.href, "_blank", "noopener"); renderDashCom(); }
    }
  });
  $("#dash-com").addEventListener("click", (e) => {
    if (e.target.closest("#dc-demander")) {
      if (!jourDemande()) return toast("La demande de versement se fait uniquement le 1er et le 2 de chaque mois.");
      const n = boutiquesCredit().filter((b) => commissionInfo(b.code).aDeclarer > 0).length;
      if (!confirm("Demander le versement des commissions du crédit télécom ?\n\nLes CC de " + n + " boutique(s) qui n'ont pas encore versé recevront la notification dans l'application jusqu'à ce qu'ils versent. Le versement leur est ouvert tout de suite.")) return;
      return act(async () => chk(await sb.from("credit_demandes").insert({ demandeur: me.nom || me.email || "" })), "Demande envoyée : les CC concernés sont notifiés.", e.target);
    }
    const r = e.target.closest("[data-dc-recu]");
    if (r) {
      const v = db.crVers.find((x) => x.id === r.dataset.dcRecu);
      if (!v || !confirm("Confirmer avoir reçu " + money0(v.montant) + " de " + (v.cc ? ccName(v.cc) : "l'admin") + " (" + boutiqueName(v.boutique) + ") sur votre portable ?")) return;
      act(async () => chk(await sb.rpc("set_versement_recu", { p_id: v.id, p_recu: true })), "Réception confirmée : " + money0(v.montant) + ".", r);
    }
  });

  function renderDashboard() {
    renderDashCom();
    if (!isAdmin()) return; // gestionnaire des commissions : seulement le cadre des commissions
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
    // Rappel de sauvegarde (au moins une fois par semaine, depuis cet appareil)
    let lastBk = ""; try { lastBk = localStorage.getItem("lastBackup") || ""; } catch (e) {}
    const joursBk = lastBk ? Math.round((parse(today()) - parse(lastBk)) / 86400000) : null;
    if (joursBk === null || joursBk >= 7) add("warning", "💾", "Pensez à sauvegarder vos données", (joursBk === null ? "Aucune sauvegarde téléchargée depuis cet appareil." : "Dernière sauvegarde il y a " + joursBk + " jours.") + " Paramètres → Télécharger une sauvegarde.");
    // Crédit télécom : commissions des mois passés non reversées + recharges non déclarées (anti-fraude)
    const crNonVerse = db.boutiques.map((b) => ({ b, c: commissionInfo(b.code) })).filter((x) => x.c.duAncien > 0);
    if (crNonVerse.length) add("warning", "📱", "Commissions de crédit des mois passés non reversées", crNonVerse.map((x) => esc(x.b.nom) + " (" + money0(x.c.duAncien) + ")").join(", ") + " (rubrique Crédit télécom).");
    const crAnom = anomaliesCredit(db.boutiques.map((b) => b.code), addDays(today(), -30));
    if (crAnom.length) add("critical", "📱", "Écart au contrôle du crédit", crAnom.slice(0, 5).map((a) => esc(boutiqueName(a.bq)) + " " + a.op + " le " + fmtDate(a.date) + " (" + ecartTxt(a) + ")").join(", ") + " (rubrique Crédit télécom).");
    const crSansClot = boutiquesCredit().filter((b) => hierManquant(b.code));
    if (crSansClot.length) add("warning", "🌙", "Contrôle du crédit restant d'hier non fait", crSansClot.map((b) => esc(b.nom)).join(", ") + " — recharges bloquées pour ces boutiques (rubrique Crédit télécom).");
    const fgSeuil = boutiquesFrigo().filter((b) => frigoInfo(b.code, today().slice(0, 7)).seuilAtteint && !dotOuverte(b.code));
    if (fgSeuil.length) add("warning", "🧊", "Frigo à réapprovisionner", fgSeuil.map((b) => esc(b.nom) + " (reste " + money0(frigoInfo(b.code, today().slice(0, 7)).restant) + ")").join(", ") + " — crédit restant ≤ " + money0(db.settings.frigoSeuil) + " : nouvelle course de " + money0(DOTATION_STANDARD) + " à doter (rubrique Frigo).");
    const crAValider = db.crVers.filter((v) => v.statut !== "Reçue");
    if (crAValider.length) add("warning", "📱", crAValider.length + " versement(s) de commission à valider", "Total " + money0(crAValider.reduce((a, v) => a + v.montant, 0)) + " (rubrique Crédit télécom).");
    // Bobines et remontées de fonds
    const bbRupt = db.boutiques.filter((b) => b.actif && bobinesOf(b.code).reste <= 0 && db.bobines.some((x) => x.boutique === b.code));
    if (bbRupt.length) add("critical", "🧻", "Bobines en rupture", bbRupt.map((b) => esc(b.nom)).join(", ") + " (rubrique Bobines).");
    const bbFaible = db.boutiques.filter((b) => { const r = bobinesOf(b.code).reste; return b.actif && r > 0 && r <= BOBINE_SEUIL; });
    if (bbFaible.length) add("warning", "🧻", "Bobines bientôt épuisées", bbFaible.map((b) => esc(b.nom) + " (" + bobinesOf(b.code).reste + ")").join(", ") + ".");
    const semPrec = addDays(mondayOf(today()), -7);
    const nonRem = db.boutiques.filter((b) => b.actif && ventesDeclarees(b.code, semPrec, weekEnd(semPrec)) > 0 && !remonteesOf(b.code, semPrec).length);
    if (nonRem.length) add("warning", "💰", "Fonds de la semaine du " + fmtDate(semPrec) + " non remontés", nonRem.map((b) => esc(b.nom) + " (" + money0(ventesDeclarees(b.code, semPrec, weekEnd(semPrec))) + ")").join(", ") + ".");
    const aConf = db.remontees.filter((r) => r.statut !== "Reçue");
    if (aConf.length) add("warning", "💰", aConf.length + " remontée(s) de fonds à valider", "Total " + money0(sumMontant(aConf)) + " (rubrique Fonds & dépenses).");
    if (aValider.length) add("warning", "📝", aValider.length + " produit(s) à valider", aValider.map((p) => esc(p.nom)).join(", ") + " (Frigo → Stock frigo, bouton ✓ Valider).");
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
    // « Faire le contrôle » : ouvre Crédit télécom → Opérations et amène au cadre du contrôle, avec une indication
    if (e.target.closest("[data-cs-go]")) {
      crTab = "ops"; try { localStorage.setItem("onglet-credit", crTab); } catch (er) {}
      show("credit");
      setTimeout(() => {
        const card = $("#cs-card"); if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        let ind = $("#cs-ici");
        if (!ind) { ind = document.createElement("div"); ind.id = "cs-ici"; card.insertBefore(ind, card.querySelector("#cs-form")); }
        ind.innerHTML = "👇 <b>C'est ici</b> : notez le crédit restant lu sur la puce YAS et sur la puce MOOV, puis cliquez sur « Enregistrer le contrôle ».";
        card.classList.remove("cs-pointe"); void card.offsetWidth; card.classList.add("cs-pointe");
        const champ = $("#cs-yas"); if (champ && !champ.disabled) setTimeout(() => champ.focus({ preventScroll: true }), 600);
      }, 80);
      return;
    }
    const go = e.target.closest("[data-fg-stock-go]");
    if (go) {
      // Ouvre Frigo → Stock frigo sur tous les produits, puis amène à la ligne du produit à valider
      fgTab = "stock"; fsVue = "tous"; $("#fs-search").value = "";
      try { localStorage.setItem("onglet-frigo", fgTab); } catch (er) {}
      show("frigo");
      const btn = document.querySelector('#fs-rows [data-fs-valid="' + CSS.escape(go.dataset.fgStockGo) + '"]') || document.querySelector("#fs-rows [data-fs-valid]");
      const tr = btn && btn.closest("tr");
      if (tr) setTimeout(() => {
        tr.scrollIntoView({ behavior: "smooth", block: "center" });
        tr.classList.remove("ligne-flash"); void tr.offsetWidth; tr.classList.add("ligne-flash");
      }, 80);
    }
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
    const set = new Set(["PASSAGER"]);
    db.sales.forEach((s) => s.client && s.client !== "CLIENT COMPTOIR" && set.add(s.client));
    return Array.from(set).sort();
  }
  function lockedCc() {
    // Un vendeur lié à un CC actif encaisse toujours sous son propre code.
    if (isAdmin() || !me.cc) return null;
    const cc = ccByCode(me.cc);
    return cc && cc.actif ? cc.code : null;
  }
  // Message du jour pour le CC : salutation, ventes du jour comparées à hier, série de jours avec ventes, petit conseil
  const CONSEILS = [
    "Un sourire et un « bonjour » font revenir les clients 😊",
    "Proposez une boisson fraîche avec chaque achat 🧊",
    "Vérifiez le crédit restant avant le soir 📱",
    "Chaque vente compte : notez-les toutes dans la caisse ✍️",
    "Un client satisfait en amène deux autres 🤝",
    "Rangez le frigo : un produit visible se vend mieux 👀",
    "Gardez de la monnaie pour rendre vite ⚡"
  ];
  // « Pépite du jour » : une blague, un compliment, une astuce santé, une astuce beauté (femme) ou bien-être (homme)
  const PEPITES = {
    blague: [
      "Pourquoi les poissons détestent l'ordinateur ? Parce qu'ils ont peur du net ! 🐟",
      "Le comble pour un vendeur de frigo ? Recevoir un accueil glacial ! 🧊",
      "Que dit une imprimante dans l'eau ? « J'ai papier ! » 🖨️",
      "Pourquoi le livre de maths est triste ? Parce qu'il a trop de problèmes 📘",
      "Quel est le sport préféré des téléphones ? Le recharge-ball 📱",
      "Le comble pour un caissier ? Ne pas avoir le sens de la monnaie ! 💰",
      "Pourquoi les canards sont toujours à l'heure ? Parce qu'ils sont dans l'étang 🦆",
      "Que fait une fraise sur un cheval ? Tagada, tagada ! 🍓",
      "Pourquoi l'épouvantail a reçu un prix ? Parce qu'il était exceptionnel dans son champ 🌾",
      "Comment appelle-t-on un chat tombé dans un pot de peinture le jour de Noël ? Un chat-peint de Noël 🎄"
    ],
    compliment: [
      "Votre travail fait vivre la boutique. Merci pour votre sérieux 🙏",
      "Les clients reviennent grâce à votre accueil. Bravo ! 🌟",
      "Chaque vente que vous notez rend BGTeam plus fort 💪",
      "Votre régularité est une vraie force. Continuez comme ça ! 🏆",
      "Vous êtes un pilier de l'équipe BGTeam 🧱",
      "Votre bonne humeur est contagieuse 😄",
      "Merci pour votre honnêteté : c'est la plus belle des qualités 💎"
    ],
    sante: [
      "Buvez au moins 6 à 8 verres d'eau aujourd'hui 💧",
      "Levez-vous et marchez 5 minutes toutes les heures 🚶",
      "Un fruit vaut mieux qu'un biscuit pour le goûter 🍌",
      "Respirez profondément 3 fois quand vous êtes stressé 🌬️",
      "Dormir 7 à 8 heures, c'est le meilleur médicament 😴",
      "Protégez-vous du soleil aux heures chaudes ☀️",
      "Lavez-vous souvent les mains : c'est la première protection 🧼"
    ],
    beaute: [
      "Un peu d'huile de karité le soir garde la peau douce ✨",
      "Buvez de l'eau : c'est le secret d'un teint lumineux 💧",
      "Un masque au miel 10 minutes adoucit la peau 🍯",
      "Protégez vos cheveux du soleil avec un foulard 🧣",
      "Démaquillez-vous toujours avant de dormir 🌙",
      "Un sourire reste le plus beau des maquillages 😊",
      "L'aloe vera apaise la peau après une journée au soleil 🌿"
    ],
    bienetre: [
      "Une tenue propre et repassée inspire confiance aux clients 👔",
      "Un peu de sport le matin donne de l'énergie toute la journée 🏃",
      "Gardez une barbe ou une coupe soignée : ça fait la différence ✂️",
      "Le beurre de karité protège aussi les mains et les lèvres 🤲",
      "Prenez 10 minutes pour vous ce soir : musique, marche, famille 🎶"
    ]
  };
  let monSexe = null; // sexe du CC connecté (fiche RH), lu une fois
  async function chargerMonSexe() {
    if (monSexe !== null || !me || !me.cc) return;
    const f = (db.fiches || []).find((x) => String(x.cc) === String(me.cc));
    if (f) { monSexe = f.sexe || ""; return; }
    try { const r = await sb.rpc("mon_sexe"); monSexe = r.error ? "" : r.data || ""; } catch (e) { monSexe = ""; }
    if (currentView === "caisse") renderHelloCc();
  }
  // Tirage au hasard une fois par chargement de la page : une nouvelle pépite à chaque actualisation
  // (elle reste la même pendant la navigation, pour ne pas changer à chaque vente)
  const PEPITE_ALEA = Math.floor(Math.random() * 1e6);
  function pepiteDuJour(code) {
    void code;
    const graine = PEPITE_ALEA;
    const cats = ["blague", "compliment", "sante", monSexe === "F" ? "beaute" : monSexe === "M" ? "bienetre" : "sante", "blague"];
    const cat = cats[graine % cats.length], liste = PEPITES[cat];
    const titre = { blague: "😄 Blague du jour", compliment: "🌟 Pour vous", sante: "🩺 Astuce santé", beaute: "💄 Astuce beauté", bienetre: "💪 Astuce bien-être" }[cat];
    return titre + " : " + liste[Math.floor(graine / cats.length) % liste.length];
  }
  function renderHelloCc() {
    const el = $("#c-hello");
    const admin = isAdmin(), code = me && me.cc ? String(me.cc) : admin ? "ADMIN" : "";
    if (!code) { el.classList.add("hidden"); $("#c-pepite").classList.add("hidden"); return; }
    const t = today(), hier = addDays(t, -1);
    // Admin : ventes de toutes les boutiques ; CC : ses propres ventes
    const mes = db.sales.filter((s) => (admin || String(s.cc) === code) && isCountedSale(s));
    const jour = summarize(mes.filter((s) => s.date === t)), veille = summarize(mes.filter((s) => s.date === hier));
    // série : nombre de jours d'affilée (jusqu'à aujourd'hui ou hier) avec au moins une vente
    const jours = new Set(mes.map((s) => s.date));
    let serie = 0, d = jours.has(t) ? t : hier;
    while (jours.has(d)) { serie++; d = addDays(d, -1); }
    const h = new Date().getHours(), salut = h < 12 ? "Bonjour" : h < 18 ? "Bon après-midi" : "Bonsoir";
    const nom = admin ? (me.nom || "Admin") : currentAgent(ccByCode(code)) || ccName(code);
    const ecart = jour.ca - veille.ca;
    const objectif = veille.ca > 0 ? (ecart >= 0 ? "🔥 Vous dépassez hier de " + money0(ecart) + " !" : "🎯 Encore " + money0(-ecart) + " pour égaler hier") : "🚀 Belle journée de ventes !";
    const conseil = CONSEILS[Math.floor(Date.parse(t) / 86400000) % CONSEILS.length];
    chargerMonSexe();
    // la pépite du jour (blague, compliment, astuce santé / beauté / bien-être) remplace l'ancienne ligne objectif + conseil
    void objectif; void conseil;
    // pépite affichée en gras à côté du titre « Caisse — nouvelle vente »
    $("#c-pepite").textContent = pepiteDuJour(code);
    $("#c-pepite").classList.remove("hidden");
    el.innerHTML = '<div class="hc-txt"><b>' + salut + " " + esc(nom) + " 👋</b></div>" +
      '<div class="hc-stats"><div class="hc-stat"><span>' + (admin ? "Toutes boutiques" : "Aujourd'hui") + "</span><b>" + money0(jour.ca) + "</b></div>" +
      '<div class="hc-stat"><span>Tickets</span><b>' + num(jour.tickets) + "</b></div>" +
      '<div class="hc-stat"><span>Série</span><b>' + (serie ? "🔥 " + serie + " j" : "—") + "</b></div></div>";
    el.classList.remove("hidden");
  }
  function renderCaisse() {
    try { renderHelloCc(); } catch (e) { /* jamais bloquant */ }
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
    if (document.activeElement !== $("#c-search")) $("#c-search").value = cProduitLabel(productByCode($("#c-product").value));
    $("#clients-list").innerHTML = clientNames().map((c) => '<option value="' + esc(c) + '">').join("");
    updateProductInfo(!prodSel || !isAdmin());
    renderCart();
  }
  // Caisse : pour un produit du frigo de la boutique (présent dans une de ses courses), on compte le STOCK FRIGO
  // (achats des courses − ventes en caisse) ; sinon le stock du menu Stock.
  function estFrigo(code, bq) { return !!bq && ((db.fgLignes || []).some((l) => l.boutique === bq && l.code === code) || (db.fgAjust || []).some((a) => a.boutique === bq && a.code === code)); }
  // Correction du stock frigo par l'admin (somme des écarts saisis)
  function ajustFrigoOf(code, bq) { return sumBy((db.fgAjust || []).filter((a) => a.boutique === bq && a.code === code), (a) => a.qte); }
  // Valeur au coût d'achat des corrections de stock du frigo jusqu'au jour d (perte = négatif, surplus = positif)
  function ajustValeurAu(bq, d) { return sumBy((db.fgAjust || []).filter((a) => a.boutique === bq && a.date <= d), (a) => a.qte * (a.coutUnit || 0)); }
  // Dernier prix d'achat unitaire d'un produit dans les courses du frigo d'une boutique (admin)
  function dernierAchatFrigo(code, bq) {
    const l = (db.fgLignes || []).filter((x) => x.boutique === bq && x.code === code && x.achat != null).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (l) return l.achat;
    const p = productByCode(code); return p ? Number(p.cmp) || 0 : 0;
  }
  function stockFrigoOf(code, bq) {
    return sumBy((db.fgLignes || []).filter((l) => l.boutique === bq && l.code === code), (l) => l.qte) - sumBy((db.fgSorties || []).filter((x) => x.boutique === bq && x.code === code), (x) => x.qte) + ajustFrigoOf(code, bq);
  }
  // Le menu Stock est retiré : en Caisse, une boutique ne vend que ce qui est dans son STOCK FRIGO (courses − ventes ± corrections).
  // Sans course du frigo pour ce produit, le stock est 0 → vente bloquée (rupture).
  function stockCaisse(p, bq) { return bq ? stockFrigoOf(p.code, bq) : stockActuel(p, bq); }
  function statutCaisse(p, bq) { const s = stockCaisse(p, bq); return s <= 0 ? "RUPTURE" : s <= Number(p.stockMin) ? "STOCK FAIBLE" : "OK"; }
  function updateProductInfo(resetPrice) {
    const p = productByCode($("#c-product").value);
    if (!p) { $("#c-stock-info").textContent = ""; $("#c-add").disabled = false; return; }
    if (resetPrice !== false) $("#c-pu").value = p.pv;
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    const bq = caisseBoutique();
    const dispo = stockCaisse(p, bq) - inCart, frigo = !!bq;
    const bloqueValid = !p.valide && !isAdmin(); // produit créé par un CC : vendable seulement après validation de l'admin
    $("#c-add").disabled = dispo <= 0 || bloqueValid; // rupture ou produit non validé : bouton « Ajouter au panier » bloqué
    $("#c-stock-info").innerHTML = (bloqueValid ? '<b class="neg">⛔ Produit pas encore validé par l\'administrateur : vente impossible pour l\'instant.</b><br>' : "") +
      (frigo ? "🧊 Stock frigo disponible" : "Stock disponible") + (bq ? " (" + esc(boutiqueName(bq)) + ")" : "") + " : <b>" + num(dispo) + "</b> " +
      statutBadge(statutCaisse(p, bq)) + " · Prix de vente : " + money(p.pv);
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
  // Recherche du produit dans la caisse (nom ou code, sans tenir compte des accents)
  let cSugIdx = -1;
  const sansAcc = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function cProduitLabel(p) { return p ? p.nom + " (" + p.code + ")" : ""; }
  function cSuggest() {
    const q = sansAcc($("#c-search").value.trim()), bq = caisseBoutique(), cur = productByCode($("#c-product").value);
    const mots = q && cur && q === sansAcc(cProduitLabel(cur)) ? [] : q.split(/\s+/).filter(Boolean); // champ = produit choisi : tout afficher
    const list = db.products.filter((p) => mots.every((m) => sansAcc(p.nom + " " + p.code + " " + (p.categorie || "")).includes(m)))
      .sort((a, b) => (stockCaisse(b, bq) > 0) - (stockCaisse(a, bq) > 0) || a.nom.localeCompare(b.nom)).slice(0, 40);
    cSugIdx = list.length ? 0 : -1;
    $("#c-sug").innerHTML = list.length ? list.map((p, i) => {
      const st = stockCaisse(p, bq);
      return '<div class="fc-opt' + (i === 0 ? " act" : "") + '" data-c-pick="' + esc(p.code) + '"><b>' + esc(p.nom) + "</b><small>" + esc(p.code) + " · " + money(p.pv) +
        " · " + (st > 0 ? "stock " + num(st) : '<span class="neg">rupture</span>') + (p.valide ? "" : " · ⚠ à valider") + "</small></div>";
    }).join("") : '<div class="fc-vide">Aucun produit ne correspond.</div>';
    $("#c-sug").classList.remove("hidden");
  }
  function cChoisir(code) {
    $("#c-product").value = code;
    $("#c-search").value = cProduitLabel(productByCode(code));
    $("#c-sug").classList.add("hidden");
    updateProductInfo(true);
    $("#c-qte").focus(); $("#c-qte").select();
  }
  $("#c-search").addEventListener("input", cSuggest);
  $("#c-search").addEventListener("focus", () => { $("#c-search").select(); cSuggest(); });
  $("#c-search").addEventListener("keydown", (e) => {
    const opts = [...$("#c-sug").querySelectorAll("[data-c-pick]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!opts.length) return;
      cSugIdx = (cSugIdx + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle("act", i === cSugIdx)); opts[cSugIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); if (opts[cSugIdx]) cChoisir(opts[cSugIdx].dataset.cPick); }
    else if (e.key === "Escape") $("#c-sug").classList.add("hidden");
  });
  $("#c-sug").addEventListener("mousedown", (e) => { const o = e.target.closest("[data-c-pick]"); if (o) { e.preventDefault(); cChoisir(o.dataset.cPick); } });
  $("#c-search").addEventListener("blur", () => setTimeout(() => {
    $("#c-sug").classList.add("hidden");
    $("#c-search").value = cProduitLabel(productByCode($("#c-product").value)); // on réaffiche le produit choisi
  }, 150));
  $("#c-remis").addEventListener("input", renderCart);
  $("#c-add").addEventListener("click", () => {
    const p = productByCode($("#c-product").value);
    const qte = Number($("#c-qte").value);
    const pu = isAdmin() ? Number($("#c-pu").value) : (p ? p.pv : 0);
    if (!p) return toast("Choisissez un produit.");
    if (!p.valide && !isAdmin()) return toast("⛔ " + p.nom + " n'est pas encore validé par l'administrateur : vente impossible pour l'instant.");
    if (!(qte > 0)) return toast("Quantité invalide.");
    if (!(pu >= 0)) return toast("Prix invalide.");
    const inCart = cart.filter((l) => l.code === p.code).reduce((a, l) => a + l.qte, 0);
    const bq = caisseBoutique();
    // Stock insuffisant (rupture) : le produit n'est pas ajouté au panier
    const dispoAj = stockCaisse(p, bq) - inCart;
    if (dispoAj < qte) return toast(dispoAj <= 0 ? "⛔ " + p.nom + " est en rupture" + (bq ? " à " + boutiqueName(bq) : "") + " : impossible de l'ajouter au panier."
      : "⛔ Stock insuffisant pour " + p.nom + " : seulement " + num(dispoAj) + " disponible" + (dispoAj > 1 ? "s" : "") + ".");
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
    const btn = ev.currentTarget;
    // Confirmation : la vente n'est enregistrée que si on répond Oui
    const totalV = cart.reduce((a, l) => a + l.qte * l.pu, 0), nbA = cart.reduce((a, l) => a + l.qte, 0);
    const dlg = $("#crconf-dialog");
    $("#crconf-titre").textContent = "Valider la vente ?";
    $("#crconf-oui").textContent = "Oui, valider";
    $("#crconf-logo").innerHTML = "";
    $("#crconf-montant").textContent = money(totalV);
    $("#crconf-text").innerHTML = "<b>" + nbA + " article" + (nbA > 1 ? "s" : "") + "</b> : " + cart.map((l) => esc(l.nom) + " ×" + num(l.qte)).join(", ") +
      "<br>Client : <b>" + esc($("#c-client").value.trim() || "PASSAGER") + "</b> · " + ccLabel(cc) +
      (remis !== "" ? "<br>Montant remis : " + money(Number(remis)) + " · Rendu : <b>" + money(Math.max(0, Number(remis) - totalV)) + "</b>" : "") +
      "<br>Confirmez-vous cette vente ?";
    dlg.returnValue = "";
    const ok = await new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue === "oui"); dlg.showModal(); });
    if (!ok) return toast("Vente non validée : rien n'a été enregistré.");
    const res = await act(async () => chk(await sb.rpc("create_sale", {
      p_date: date, p_client: $("#c-client").value.trim() || "PASSAGER", p_cc: cc, p_vendeur: vendeur,
      p_num_client: $("#c-numclient").value.trim(), p_adresse: $("#c-adresse").value.trim(),
      p_lines: cart.map((l) => ({ code: l.code, qte: l.qte, pu: l.pu }))
    })), null, btn);
    if (!res.ok) return;
    const ticket = res.data;
    cart = [];
    $("#c-remis").value = "";
    $("#c-numclient").value = "";
    $("#c-adresse").value = "";
    $("#c-client").value = "PASSAGER";
    renderCart();
    toast("Vente enregistrée — ticket N° " + ticket);
    // Reçu en miniature sous la caisse : impression seulement si on clique sur « Imprimer le reçu »
    $("#f-remis").value = remis;
    renderFacture();
    $("#f-ticket").value = String(ticket);
    afficherRecuCaisse(ticket);
    $("#c-last").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // Imprimer le reçu de la dernière vente (le ticket est déjà préparé dans Facturation, que l'impression utilise)
  // Reçu affiché en miniature dans la Caisse (dernière vente ou ticket recherché)
  let recuCaisse = null;
  function afficherRecuCaisse(t) {
    renderFacture();
    if (!ticketList().includes(Number(t))) return false;
    recuCaisse = Number(t);
    $("#f-ticket").value = String(t);
    renderReceipt();
    $("#c-last-titre").textContent = "Reçu du ticket N° " + t;
    $("#c-last-receipt").innerHTML = $("#receipt").innerHTML;
    $("#c-last-zone").classList.remove("hidden");
    $("#c-last-vide").classList.add("hidden");
    return true;
  }
  function chercherRecu() {
    const v = $("#c-last-search").value.trim().replace(/\D/g, "");
    if (!v) return;
    $("#f-remis").value = "";
    if (afficherRecuCaisse(Number(v))) $("#c-last-search").value = "";
    else toast("Aucun ticket validé N° " + v + ".");
  }
  // Suggestions : les derniers tickets (numéro · date · client · total)
  $("#c-last-search").addEventListener("focus", () => {
    const tickets = ticketList().slice().sort((a, b) => b - a).slice(0, 50);
    $("#c-last-tickets").innerHTML = tickets.map((t) => {
      const l = db.sales.filter((s) => Number(s.ticket) === t && s.valide === "OUI"), f = l[0] || {};
      const cl = !f.client || f.client === "CLIENT COMPTOIR" ? "PASSAGER" : f.client;
      return '<option value="' + t + '">' + esc(fmtDate(f.date || "") + " · " + cl + " · " + money(l.reduce((a, s) => a + lineTotal(s), 0))) + "</option>";
    }).join("");
  });
  $("#c-last-search").addEventListener("change", chercherRecu);
  $("#c-last-print").addEventListener("click", () => {
    if (recuCaisse) { renderFacture(); $("#f-ticket").value = String(recuCaisse); renderReceipt(); }
    window.print();
  });
  $("#c-last-close").addEventListener("click", () => { recuCaisse = null; $("#c-last-zone").classList.add("hidden"); $("#c-last-vide").classList.remove("hidden"); $("#c-last-titre").textContent = "Reçus"; });

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
    // Bénéfice d'une ligne = (prix de vente − prix d'achat) × quantité ; inconnu si aucun prix d'achat
    const beneOf = (s) => {
      // produit du frigo : prix d'achat de la course du frigo (admin et gestionnaires du frigo) ; sinon coût du stock principal
      const cf = admin || fgGlobal() ? coutFrigo(s) : null;
      const c = cf != null ? cf : s.cout != null ? s.cout : admin ? (Number((productByCode(s.code) || {}).cmp) || null) : null;
      return c == null || c <= 0 ? null : Math.round(lineTotal(s) - Number(s.qte) * c);
    };
    const beneHtml = (v) => (v == null ? '<span class="muted" title="Prix d\'achat inconnu">—</span>' : '<b class="delta ' + (v < 0 ? "down" : "up") + '">' + (v > 0 ? "+" : "") + money(v) + "</b>");
    $("#v-rows").innerHTML = rows.length ? rows.map((s) =>
      '<tr class="' + (s.valide === "OUI" ? "" : "off") + '">' +
      "<td>" + fmtDate(s.date) + "</td><td>" + heureOf(s) + "</td><td>" + esc(s.nom) + pendingBadge(productByCode(s.code)) +
      '</td><td class="num">' + num(s.qte) + '</td><td class="num"><b>' + money(lineTotal(s)) + '</b></td><td class="num">' + beneHtml(beneOf(s)) + "</td><td>" + ccLabel(s.cc) +
      (vendeurOf(s) ? '<span class="sub">' + esc(vendeurOf(s)) + "</span>" : "") +
      "</td><td>" + esc(boutiqueName(saleBoutique(s))) + '</td><td class="num">' + s.ticket +
      '</td><td class="keep">' + (admin ? '<button class="btn small" data-toggle="' + s.id + '">' + badge(s) + "</button>" : badge(s)) +
      "</td><td>" + (admin ? '<button class="btn small danger" data-del="' + s.id + '" title="Supprimer">✕</button>' : "") + "</td></tr>"
    ).join("") : '<tr><td colspan="11" class="empty">Aucune vente pour cette date avec ces filtres.</td></tr>';

    const valides = rows.filter(isCountedSale);
    const tot = summarize(valides);
    const totBene = valides.reduce((a, s) => a + (beneOf(s) || 0), 0);
    $("#v-foot").innerHTML = '<tr><td colspan="3">TOTAL ' + (cc === "ALL" ? (b === "ALL" ? "DES VENTES" : "— " + esc(boutiqueName(b))) : "— " + esc(ccName(cc))) +
      " · " + num(tot.tickets) + " ticket" + (tot.tickets > 1 ? "s" : "") + '</td><td class="num">' + num(tot.qte) +
      '</td><td class="num">' + money(tot.ca) + '</td><td class="num">' + beneHtml(valides.length ? totBene : null) + '</td><td colspan="5">' + (rows.length !== valides.length ? "(ventes NON exclues)" : "") + "</td></tr>";
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
  let stockFiltreInit = false, stockVue = "stock";
  function beneStockHtml(v, devise) {
    v = Math.round(v);
    return '<b class="delta ' + (v < 0 ? "down" : v > 0 ? "up" : "") + '">' + (v > 0 ? "+" : "") + (devise ? money(v) : num(v)) + "</b>";
  }
  $("#stock-kpis").addEventListener("click", (e) => {
    const t = e.target.closest("[data-sv]");
    if (!t) return;
    // Recliquer sur la case active revient aux produits en stock
    stockVue = stockVue === t.dataset.sv && t.dataset.sv !== "stock" ? "stock" : t.dataset.sv;
    renderStock();
  });
  function renderStock() {
    const admin = isAdmin();
    const q = $("#s-search").value.trim().toLowerCase();
    // Filtre boutique : stock commun ou stock d'une seule boutique
    const bcur = $("#s-boutique").value || "ALL";
    // Par défaut un CC ne voit que le stock de sa boutique ; l'admin peut l'autoriser à voir toutes les boutiques (RH).
    const myCc = !admin && me.cc ? ccByCode(me.cc) : null;
    const tout = admin || !!(myCc && myCc.voirStock);
    const myBq = myCc && db.boutiques.some((b) => b.code === myCc.boutique) ? myCc.boutique : "";
    if (!tout && !myBq) {
      $("#s-boutique").innerHTML = '<option value="">Aucune boutique</option>';
      $("#s-title").textContent = "Stock";
      $("#stock-kpis").innerHTML = "";
      $("#s-rows").innerHTML = '<tr><td colspan="16" class="empty">Vous n\'êtes affecté à aucune boutique. Demandez à l\'administrateur.</td></tr>';
      $("#s-foot").innerHTML = "";
      return;
    }
    const bqs = tout ? db.boutiques : db.boutiques.filter((b) => b.code === myBq);
    $("#s-boutique").innerHTML = (tout ? '<option value="ALL">Stock commun (toutes les boutiques)</option>' : "") +
      bqs.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    $("#s-boutique").value = bqs.some((b) => b.code === bcur) ? bcur : tout ? "ALL" : myBq;
    $("#s-boutique").disabled = !tout;
    // Un CC voit d'abord le stock de sa boutique.
    if (!admin && !stockFiltreInit && myBq) { stockFiltreInit = true; $("#s-boutique").value = myBq; }
    const bq = $("#s-boutique").value;
    $("#s-title").textContent = bq === "ALL" ? "Stock commun — toutes les boutiques" : "Stock — " + boutiqueName(bq);
    // Vue : produits en stock (par défaut), en rupture, sous seuil ou tous — choisie en cliquant sur les cases.
    const enVue = {
      stock: (p) => stockActuel(p, bq) > 0 || !p.valide,
      rupture: (p) => statutStock(p, bq) === "RUPTURE",
      seuil: (p) => statutStock(p, bq) === "STOCK FAIBLE",
      tous: () => true
    };
    const vueLib = { stock: "produits en stock", rupture: "produits en rupture", seuil: "produits sous le seuil", tous: "tous les produits" };
    $("#s-title").textContent += " · " + vueLib[stockVue];
    const list = db.products.filter((p) => enVue[stockVue](p) && (!q || (p.nom + " " + p.code + " " + p.categorie).toLowerCase().includes(q)));
    const stockTotal = db.products.reduce((a, p) => a + stockActuel(p, bq), 0);
    const valeur = db.products.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.cmp), 0);
    const tile = (v) => 'data-sv="' + v + '" title="Cliquer pour afficher les ' + vueLib[v] + '" style="cursor:pointer' + (stockVue === v ? ";outline:2px solid var(--primary)" : "") + '"';
    const k = [["Produits", db.products.length, "", tile("tous")], ["En stock", db.products.filter(enVue.stock).length, "", tile("stock")], ["Stock total", num(stockTotal)]];
    const valeurVente = db.products.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.pv), 0);
    if (admin) k.push(["Coût du stock (achat)", money(Math.round(valeur))]);
    k.push(["Coût du stock (vente)", money(valeurVente)]);
    // Bénéfice contenu dans le stock = coût de vente − coût d'achat
    if (admin) k.push(["Bénéfice du stock", money(Math.round(valeurVente - valeur)), valeurVente - valeur < 0 ? "danger" : "hero-good"]);
    k.push(["En rupture", db.products.filter(enVue.rupture).length, "danger", tile("rupture")]);
    k.push(["Sous seuil", db.products.filter(enVue.seuil).length, "warn", tile("seuil")]);
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
      (lastPurchase(p.code) ? num(Math.round(lastPurchase(p.code).pu)) : '<span class="muted">—</span>') + '</td><td class="num admin-only">' + num(p.pv) +
      // Bénéfice sur 1 unité = prix de vente − coût moyen d'achat
      '</td><td class="num admin-only">' + (Number(p.cmp) > 0
        ? '<b class="delta ' + (p.pv - p.cmp < 0 ? "down" : "up") + '">' + (p.pv - p.cmp > 0 ? "+" : "") + num(Math.round(p.pv - p.cmp)) + "</b>"
        : '<span class="muted" title="Prix d\'achat inconnu">—</span>') +
      '</td><td class="num admin-only">' + (bq !== "ALL"
        ? '<input type="number" min="0" class="inline-input si-input" data-si="' + esc(p.code) + '" value="' + stockInitialOf(p, bq) + '" title="Stock initial à ' + esc(boutiqueName(bq)) + ' (Entrée pour valider)">'
        : num(stockInitialOf(p, bq))) + '</td><td class="num admin-only">' + num(totalEntrees(p.code, bq)) + '</td><td class="num admin-only">' + num(totalVentes(p.code, bq)) +
      (totalTransfert(p.code, bq) ? '<span class="sub" title="Quantité transférée au stock frigo">− ' + num(totalTransfert(p.code, bq)) + " au frigo</span>" : "") +
      '</td><td class="num"><b>' + num(stockActuel(p, bq)) + '</b></td><td class="num admin-only">' + num(Math.round(Math.max(0, stockActuel(p, bq)) * Number(p.cmp))) +
      // Bénéfice du stock de ce produit = prix de vente − prix d'achat
      '</td><td class="num admin-only">' + (Number(p.cmp) > 0 ? beneStockHtml(Math.max(0, stockActuel(p, bq)) * (Number(p.pv) - Number(p.cmp))) : '<span class="muted">—</span>') +
      '</td><td class="num">' + num(Math.max(0, stockActuel(p, bq)) * Number(p.pv)) +
      "</td><td>" + statutBadge(statutStock(p, bq)) + '</td><td class="admin-only">' +
      (admin && !p.valide ? '<button class="btn small success" data-pvalid="' + esc(p.code) + '">✓ Valider</button> ' : "") +
      (admin ? '<button class="btn small" data-prices="' + esc(p.code) + '">Prix</button> <button class="btn small" data-edit="' + esc(p.code) + '">Modifier</button> <button class="btn small danger" data-pdel="' + esc(p.code) + '">✕</button>' : "") +
      "</td></tr>"
    ).join("") : '<tr><td colspan="16" class="empty">Aucun produit dans cette vue (' + vueLib[stockVue] + ").</td></tr>";
    // Totaux des produits affichés (tient compte de la recherche)
    const totStock = sorted.reduce((a, p) => a + stockActuel(p, bq), 0);
    const totVente = sorted.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.pv), 0);
    const totAchat = sorted.reduce((a, p) => a + Math.max(0, stockActuel(p, bq)) * Number(p.cmp), 0);
    $("#s-foot").innerHTML = sorted.length ? '<tr class="total-row"><td colspan="3"><b>TOTAL' + (q ? " (recherche)" : "") + "</b></td>" +
      '<td class="admin-only" colspan="7"></td><td class="num"><b>' + num(totStock) + '</b></td><td class="num admin-only"><b>' + money(Math.round(totAchat)) + '</b></td><td class="num admin-only">' + beneStockHtml(totVente - totAchat, true) + '</td><td class="num"><b>' + money(totVente) +
      '</b></td><td></td><td class="admin-only"></td></tr>' : "";
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
    ["code", "nom", "categorie", "pa", "pv", "stockMin"].forEach((k) => { f.elements[k].value = def[k]; });
    // Stock initial : celui de la boutique choisie dans le filtre du Stock
    const bq = $("#s-boutique").value;
    const parBq = bq && bq !== "ALL";
    $("#pd-si-wrap").style.display = parBq ? "" : "none";
    $("#pd-si-label").textContent = parBq ? "Stock initial — " + boutiqueName(bq) : "";
    f.elements.stockInitial.value = parBq && p ? stockInitialOf(p, bq) : 0;
    $("#pd-si-hint").textContent = parBq ? "" : "Pour saisir le stock initial, choisissez d'abord une boutique dans le filtre du Stock.";
    $("#cat-list").innerHTML = Array.from(new Set(db.products.map((x) => x.categorie))).map((c) => '<option value="' + esc(c) + '">').join("");
    $("#product-dialog").showModal();
  }
  $("#s-new").addEventListener("click", () => openProduct(null));
  // Saisie du stock initial d'une boutique directement dans le tableau (admin)
  function saveStockInitial(code, bq, qte, btn) {
    return act(async () => chk(await sb.from("stocks_initiaux").upsert({ code, boutique: bq, qte, updated_at: new Date().toISOString() })),
      "Stock initial de " + (productByCode(code) || {}).nom + " à " + boutiqueName(bq) + " : " + num(qte) + ".", btn);
  }
  $("#s-rows").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-si]");
    if (!inp) return;
    const bq = $("#s-boutique").value, qte = Number(inp.value);
    if (bq === "ALL" || !(qte >= 0)) { inp.value = stockInitialOf(productByCode(inp.dataset.si), bq); return toast("Indiquez un stock initial valide (0 ou plus)."); }
    saveStockInitial(inp.dataset.si, bq, qte);
  });
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
      stock_min: Number(f.elements.stockMin.value) || 0
    };
    if (!p.code || !p.nom) { e.preventDefault(); return toast("Code et désignation obligatoires."); }
    if (db.products.some((x) => x.code === p.code && x.code !== editingCode)) { e.preventDefault(); return toast("Le code " + p.code + " existe déjà."); }
    // products.stock_initial (total) est calculé par la base : on ne l'écrit plus ici
    const row = { code: p.code, nom: p.nom, categorie: p.categorie, pv: p.pv, stock_min: p.stock_min };
    const old = editingCode;
    const bq = $("#s-boutique").value;
    const si = Number(f.elements.stockInitial.value);
    act(async () => {
      if (old) chk(await sb.from("products").update(row).eq("code", old));
      else chk(await sb.from("products").insert(row));
      chk(await sb.from("product_costs").upsert({ code: p.code, pa: p.pa }));
      if (bq && bq !== "ALL" && si >= 0) chk(await sb.from("stocks_initiaux").upsert({ code: p.code, boutique: bq, qte: si, updated_at: new Date().toISOString() }));
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
    if (canEntrees()) {
      if (!courseLines.length && !editingCourseId) resetCourseForm();
      renderCourseForm();
    }
    renderEhFilters();
    renderEntryHistory();
  }
  // Filtres de l'historique : boutique → seuls ses CC ; CC choisi d'abord → sa boutique est sélectionnée.
  function renderEhFilters() {
    const bcur = $("#eh-boutique").value || "ALL";
    $("#eh-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' +
      db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
    $("#eh-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
    const bq = $("#eh-boutique").value;
    const fcur = $("#eh-cc").value || "ALL";
    // Boutique choisie : seuls ses CC autorisés à faire les courses.
    const list = db.settings.ccList.filter((c) => bq === "ALL" || (c.boutique === bq && c.entrees));
    $("#eh-cc").innerHTML = '<option value="ALL">Tous les CC</option>' +
      list.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("") +
      '<option value="NONE">Sans CC (admin)</option>';
    $("#eh-cc").value = Array.from($("#eh-cc").options).some((o) => o.value === fcur) ? fcur : "ALL";
  }
  $("#eh-boutique").addEventListener("change", () => { renderEhFilters(); renderEntryHistory(); });

  // ----- Historique : jours → courses (cliquer pour le détail) + entrées simples -----
  function canEditCourse(c) {
    if (isAdmin()) return true;
    return canEntrees() && c.createdBy === me.id && c.createdAt && Date.now() - new Date(c.createdAt).getTime() < EDIT_WINDOW_MS;
  }
  function courseLinesOf(c) { return db.entries.filter((x) => x.courseId === c.id); }
  function courseTotal(c) { return courseLinesOf(c).reduce((a, x) => a + (x.prixTotal || 0), 0) + c.retrait + c.transport + c.autres; }
  function renderEntryHistory() {
    const fcc = $("#eh-cc").value, fbq = $("#eh-boutique").value || "ALL";
    const q = "";
    const ccOk = (cc, bq) => (fbq === "ALL" || bq === fbq) && (fcc === "ALL" ? true : fcc === "NONE" ? !cc : cc === fcc);
    const matches = (code, extra) => {
      if (!q) return true;
      const p = productByCode(code);
      return ((p ? p.nom : "") + " " + code + " " + (extra || "")).toLowerCase().includes(q);
    };
    const courses = db.courses.filter((c) => ccOk(c.cc, c.boutique) &&
      (!q || courseLinesOf(c).some((x) => matches(x.code, [c.saisiPar, c.obs, c.marche, c.tel].join(" ")))));
    const simples = db.entries.filter((x) => !x.courseId && ccOk(x.cc, x.boutique) && matches(x.code, (x.saisiPar || "") + " " + (x.obs || "")));

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
  $("#eh-cc").addEventListener("change", () => {
    const cc = $("#eh-cc").value;
    if (cc !== "ALL" && cc !== "NONE" && $("#eh-boutique").value === "ALL" && ccBoutique(cc)) { $("#eh-boutique").value = ccBoutique(cc); renderEhFilters(); $("#eh-cc").value = cc; }
    renderEntryHistory();
  });
  $("#eh-date").addEventListener("change", renderEntryHistory);
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
    // Modèle standard des tickets de caisse des magasins en France :
    // en-tête magasin (nom, adresse, tél., identifiant légal) · date/heure, n° ticket, caisse, vendeur · colonnes Désignation/Qté/P.U./Montant
    // · nombre d'articles · TOTAL TTC · règlement et rendu · remerciements · référence
    const quand = first.createdAt ? new Date(first.createdAt) : null;
    const heure = quand ? quand.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    const bq = saleBoutique(first) || "";
    const ref = "TK" + first.date.slice(5, 7) + first.date.slice(0, 4) + (bq ? "-" + bq : "") + "-" + t;
    const vendeur = vendeurOf(first);
    const nbArticles = lines.reduce((a, s) => a + Number(s.qte), 0);
    const ligne2 = (g, d, cls) => "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + g + '</td><td class="r">' + d + "</td></tr>";
    $("#receipt").innerHTML =
      '<div class="center"><div class="r-nom">' + esc(String(st.nom || "").toUpperCase()) + "</div>" +
      (bq ? "<div>" + esc(boutiqueName(bq)) + "</div>" : "") +
      (st.adresse ? "<div>" + esc(st.adresse) + "</div>" : "") +
      (st.tel ? "<div>Tél : " + esc(st.tel) + "</div>" : "") +
      (st.rccm ? '<div class="r-petit">RCCM/NIF : ' + esc(st.rccm) + "</div>" : "") + "</div><hr>" +
      "<table>" + ligne2("Le " + fmtDate(first.date), heure ? "à " + heure : "") +
      ligne2("Ticket N° " + String(t).padStart(6, "0"), "Caisse : " + esc(String(first.cc || "—"))) +
      (vendeur ? ligne2("Vendeur : " + esc(vendeur), "") : "") +
      ligne2("Client : " + esc(!first.client || first.client === "CLIENT COMPTOIR" ? "PASSAGER" : first.client), "") + "</table><hr>" +
      '<table class="r-lignes"><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">P.U.</th><th class="r">Montant</th></tr></thead><tbody>' +
      lines.map((s) => "<tr><td>" + esc(String(s.nom).toUpperCase()) + '</td><td class="r">' + num(s.qte) + '</td><td class="r">' + num(s.pu) + '</td><td class="r">' + num(lineTotal(s)) + "</td></tr>").join("") +
      "</tbody></table><hr>" +
      "<table>" + ligne2(nbArticles + " article" + (nbArticles > 1 ? "s" : ""), "") +
      ligne2("TOTAL TTC", num(total) + " FCFA", "big") +
      (remisRaw !== "" ? ligne2("Espèces", num(remis) + " FCFA") + ligne2("Rendu", num(Math.max(0, remis - total)) + " FCFA") : "") +
      "</table><hr>" +
      '<div class="center r-merci">Merci de votre visite<br>À bientôt !<br><br>Conservez ce ticket<br>' + esc(ref) + "</div>";
  }
  // Changer de ticket : on efface le montant remis de la vente précédente (sinon « Espèces / Rendu » faux)
  $("#f-ticket").addEventListener("change", () => { $("#f-remis").value = ""; renderReceipt(); });
  $("#f-remis").addEventListener("input", renderReceipt);
  $("#f-print").addEventListener("click", () => window.print());

  // ---------- Fonds & dépenses ----------
  // Droits : CC « toutes boutiques » (voir_stock) = global ; CC entrées = remonte les fonds de sa boutique.
  function myCcRow() { return !isAdmin() && me && me.cc ? ccByCode(me.cc) : null; }
  function isGlobal() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && c.voirStock); }
  function canFonds() { return isGlobal() || canEntrees(); }
  function bobinesDroit() { if (isAdmin()) return "gestion"; const c = myCcRow(); return c && c.actif ? c.bobines : "non"; }
  function myBoutiqueCode() { const c = myCcRow(); return c && db.boutiques.some((b) => b.code === c.boutique) ? c.boutique : ""; }
  function weekEnd(monday) { return addDays(monday, 6); }
  function ventesDeclarees(bq, du, au) {
    return db.sales.filter((s) => isCountedSale(s) && saleBoutique(s) === bq && s.date >= du && s.date <= au).reduce((a, s) => a + lineTotal(s), 0);
  }
  function remonteesOf(bq, semaine) { return db.remontees.filter((r) => r.boutique === bq && (!semaine || r.semaine === semaine)); }
  // Frigo : depuis le 12/11/2026, la remontée du lundi = ventes de la semaine (prix d'achat + bénéfice).
  // Avant, elle ne contenait que le bénéfice.
  const REM_TOTAL_DEPUIS = "2026-11-12T17:00";
  // Reste à remonter d'une semaine (ventes déclarées − déjà remonté)
  // Versement des fonds : uniquement le lundi pour les CC (l'admin peut enregistrer à tout moment)
  function remonteeVerrouillee() { return !isAdmin() && new Date().getDay() !== 1; }
  function prochainLundi() { return addDays(mondayOf(today()), 7); }
  function resteRemSemaine(bq, w) { return Math.round((ventesDeclarees(bq, w, weekEnd(w)) - sumMontant(remonteesOf(bq, w))) * 100) / 100; }
  // Semaine proposée : la plus ancienne qui doit encore de l'argent, sinon la semaine en cours
  let rmSemBq = null;
  function semaineARemonter(bq, weeks) {
    if (!bq) return weeks[0];
    for (let i = weeks.length - 1; i >= 0; i--) if (resteRemSemaine(bq, weeks[i]) > 0.5) return weeks[i];
    return weeks[0];
  }
  function fgSemaine(bq, w) {
    const ls = db.fgSorties.filter((x) => x.boutique === bq && x.date >= w && x.date <= weekEnd(w));
    const achat = Math.round(sumBy(ls, (x) => x.consomme) * 100) / 100, ca = Math.round(sumBy(ls, (x) => x.montant) * 100) / 100;
    // ventes = toutes les ventes de la boutique (frigo + stock principal) ; ca = ventes du frigo seulement
    return { ventes: ventesDeclarees(bq, w, weekEnd(w)), ca, achat };
  }
  const r2_ = (n) => Math.round(n * 100) / 100;
  // Part « frigo » d'une remontée : une boutique qui vend aussi des produits du stock principal remonte
  // toutes ses ventes ; seule la part des ventes du frigo concerne le reversement du frigo.
  function remFrigoPart(r) {
    if (String(r.createdAt || "") < REM_TOTAL_DEPUIS) return r.montant; // ancienne remontée = bénéfice du frigo
    const s = fgSemaine(r.boutique, r.semaine);
    if (s.ventes <= 0) return r.montant;
    return r2_(Math.min(r.montant, r.montant * Math.min(1, s.ca / s.ventes)));
  }
  // Part « bénéfice » d'une remontée d'une boutique avec frigo (jamais plus que le bénéfice de la semaine)
  function remBenefPart(r) {
    if (String(r.createdAt || "") < REM_TOTAL_DEPUIS) return r.montant;
    const s = fgSemaine(r.boutique, r.semaine), benef = Math.max(0, s.ca - s.achat);
    return s.ca > 0 ? r2_(Math.min(benef, remFrigoPart(r) * benef / s.ca)) : 0;
  }
  // Validation des remontées : admin, ou CC gestionnaire du frigo (ccs.frigo_dotation) pour les boutiques avec frigo
  function canValiderRem(bq) { return isAdmin() || (canFrigoDotation() && db.fgCourses.some((c) => c.boutique === bq)); }
  function sumMontant(list) { return list.reduce((a, r) => a + r.montant, 0); }
  function ecartHtml(v) { return '<span class="delta ' + (v < -0.5 ? "down" : v > 0.5 ? "up" : "") + '">' + (v > 0.5 ? "+" : "") + money0(v) + "</span>"; }
  function fondsScope() {
    const global = isGlobal();
    const bqs = global ? db.boutiques : db.boutiques.filter((b) => b.code === myBoutiqueCode());
    const f = $("#fd-boutique").value || "ALL";
    return global && f !== "ALL" ? bqs.filter((b) => b.code === f) : bqs;
  }
  function renderFonds() {
    const global = isGlobal(), admin = isAdmin();
    document.body.classList.toggle("no-global", !global);
    // Filtres
    const bcur = $("#fd-boutique").value || "ALL";
    if (global) {
      $("#fd-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      $("#fd-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
      $("#fd-boutique").disabled = false;
    } else {
      const mb = myBoutiqueCode();
      $("#fd-boutique").innerHTML = mb ? '<option value="' + esc(mb) + '">' + esc(boutiqueName(mb)) + "</option>" : '<option value="">Aucune boutique</option>';
      $("#fd-boutique").disabled = true;
    }
    if (!$("#fd-mois").value) $("#fd-mois").value = today().slice(0, 7);
    const mois = $("#fd-mois").value, du = mois + "-01", au = lastDayOfMonth(du);
    const scope = fondsScope(), codes = scope.map((b) => b.code);
    const t = today();

    // Formulaire de remontée (CC entrées de sa boutique ; l'admin choisit une boutique dans le filtre)
    const remBq = admin ? ($("#fd-boutique").value !== "ALL" ? $("#fd-boutique").value : "") : (canEntrees() ? myBoutiqueCode() : "");
    $("#fd-remonter").classList.toggle("hidden", !canEntrees());
    const scur = $("#rm-semaine").value;
    const lundi = mondayOf(t), weeks = [];
    // CC : on ne remonte que des semaines terminées (pas la semaine en cours) ; l'admin peut tout enregistrer
    for (let i = admin ? 0 : 1; i < 9; i++) weeks.push(addDays(lundi, -7 * i));
    $("#rm-semaine").innerHTML = weeks.map((w, i) => '<option value="' + w + '">' + (w === lundi ? "Semaine en cours — " : "") + "du " + fmtDate(w) + " au " + fmtDate(weekEnd(w)) + "</option>").join("");
    $("#rm-semaine").value = weeks.includes(scur) && rmSemBq === remBq ? scur : semaineARemonter(remBq, weeks);
    rmSemBq = remBq;
    if (canEntrees()) {
      const w = $("#rm-semaine").value;
      if (!remBq) {
        $("#rm-info").innerHTML = '<p class="hint" style="margin:0">' + (admin ? "Choisissez une boutique dans le filtre en haut pour enregistrer une remontée." : "Vous n'êtes affecté à aucune boutique. Demandez à l'administrateur.") + "</p>";
      } else {
        majRmInfo(true);
      }
      $("#rm-save").disabled = !remBq || remonteeVerrouillee();
      if (remBq && remonteeVerrouillee()) $("#rm-info").innerHTML += '<p class="hint neg" style="margin:8px 0 0">🔒 <b>Les remontées se font uniquement le lundi.</b> Prochain versement : <b>lundi ' + fmtDate(prochainLundi()) +
        "</b> (ventes de la semaine du " + fmtDate(mondayOf(t)) + " au " + fmtDate(weekEnd(mondayOf(t))) + ", en complément de ce qui est déjà versé).</p>";
      syncRmNote(); // liste des CC qui peuvent recevoir les espèces
    }

    // Rapprochement par semaine (lundis du mois)
    const mondays = [];
    for (let d = mondayOf(du); d <= au; d = addDays(d, 7)) if (d >= du) mondays.push(d);
    const rows = [];
    mondays.slice().reverse().forEach((w) => scope.forEach((b) => {
      const v = ventesDeclarees(b.code, w, weekEnd(w)), rl = remonteesOf(b.code, w), r = sumMontant(rl);
      if (!v && !rl.length) return;
      let st;
      if (weekEnd(w) >= t) st = '<span class="badge mute">Semaine en cours</span>';
      else if (!rl.length) st = '<span class="badge danger">⏳ Non remontée</span>';
      else if (Math.abs(r - v) < 1) st = '<span class="badge ok">✅ Conforme</span>';
      else if (r < v) st = '<span class="badge danger">⚠ Manque ' + money0(v - r) + "</span>";
      else st = '<span class="badge warn">Excédent ' + money0(r - v) + "</span>";
      if (rl.length && rl.every((x) => x.statut === "Reçue")) st += ' <span class="badge ok">✓ Vérifiée</span>';
      else if (rl.some((x) => x.statut !== "Reçue")) st += ' <span class="badge warn">⏳ À vérifier par l\'admin</span>';
      rows.push({ w, b, v, r, st });
    }));
    $("#fd-match").innerHTML = rows.length ? rows.map((x) => "<tr><td>Du " + fmtDate(x.w) + " au " + fmtDate(weekEnd(x.w)) + "</td><td>" + esc(x.b.nom) +
      '</td><td class="num">' + money0(x.v) + '</td><td class="num">' + money0(x.r) + '</td><td class="num">' + (weekEnd(x.w) >= t && !x.r ? "—" : ecartHtml(x.r - x.v)) + "</td><td>" + x.st + "</td></tr>").join("")
      : '<tr><td colspan="6" class="empty">Aucune vente ni remontée sur ce mois.</td></tr>';
    // Total du mois, semaine en cours comprise : un montant remonté sur une autre semaine est quand même compensé
    const totV = rows.reduce((a, x) => a + x.v, 0), totR = rows.reduce((a, x) => a + x.r, 0), totE = totR - totV;
    $("#fd-match-foot").innerHTML = rows.length ? "<tr><td colspan=2>TOTAL DU MOIS</td><td class=\"num\">" + money0(totV) + '</td><td class="num">' + money0(totR) +
      '</td><td class="num">' + ecartHtml(totE) + "</td><td>" +
      (totE < -0.5 ? '<span class="badge danger">⚠ Manque ' + money0(-totE) + "</span>" : totE > 0.5 ? '<span class="badge warn">Excédent ' + money0(totE) + "</span>" : '<span class="badge ok">✅ Conforme</span>') + "</td></tr>" : "";

    // Remontées du mois
    const rems = db.remontees.filter((r) => codes.includes(r.boutique) && r.semaine >= du && r.semaine <= au) // une semaine appartient au mois de son lundi (comme le rapprochement)
      .sort((a, b) => b.semaine.localeCompare(a.semaine) || String(b.createdAt).localeCompare(String(a.createdAt)));
    $("#fd-rem").innerHTML = rems.length ? rems.map((r) => {
      const canDel = admin || (r.createdBy === me.id && r.statut === "Déclarée" && Date.now() - new Date(r.createdAt).getTime() < EDIT_WINDOW_MS);
      return "<tr><td>" + fmtDate(r.semaine) + " → " + fmtDate(weekEnd(r.semaine)) + "</td><td>" + esc(boutiqueName(r.boutique)) + "</td><td>" + (r.cc ? esc(ccName(r.cc)) : "Admin") +
        '</td><td class="num"><b>' + money0(r.montant) + "</b></td><td>" + esc(r.mode) + (r.note ? '<span class="sub">' + esc(r.note) + "</span>" : "") +
        (r.ccReceveur ? '<span class="sub">💵 Remis à ' + esc(ccName(r.ccReceveur)) + "</span>" +
          (r.confirmeLe ? '<span class="sub" style="color:var(--success)">✓ Réception confirmée le ' + new Date(r.confirmeLe).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + "</span>"
            : '<span class="sub neg">⏳ Réception pas encore confirmée</span>') : "") +
        (r.txId ? '<span class="sub">N° ' + esc(r.txId) + (r.recuInfos && r.recuInfos.expediteur ? " · de ****" + esc(r.recuInfos.expediteur) : "") + "</span>" : "") +
        (r.alerte && admin ? '<span class="sub neg">⚠ ' + esc(r.alerte) + "</span>" : "") +
        (r.recuPath ? '<button class="btn small" data-rm-photo="' + esc(r.recuPath) + '" style="margin-top:4px">📷 Voir le reçu</button>' : r.mode !== "Espèces" ? '<span class="sub">Sans reçu</span>' : "") + "</td><td>" +
        new Date(r.createdAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + '<span class="sub">' + esc(r.saisiPar) + "</span></td><td>" +
        (r.statut === "Reçue"
          ? '<span class="badge ok">✓ Vérifiée et validée</span><span class="sub">par ' + esc(r.recuPar) + (r.recuLe ? " le " + new Date(r.recuLe).toLocaleDateString("fr-FR") : "") + "</span>"
          : '<span class="badge warn">⏳ En attente de vérification</span>') + "</td><td>" +
        (canValiderRem(r.boutique) ? '<button class="btn small' + (r.statut === "Reçue" ? "" : " success") + '" data-rm-recu="' + r.id + '" data-v="' + (r.statut === "Reçue" ? "0" : "1") + '">' + (r.statut === "Reçue" ? "Annuler la validation" : "✓ Argent reçu : valider") + "</button> " : "") +
        (admin ? '<button class="btn small" data-rm-sem="' + r.id + '" title="Changer la semaine de cette remontée">📅 Semaine</button> ' : "") +
        (canDel ? '<button class="btn small danger" data-rm-del="' + r.id + '">✕</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="8" class="empty">Aucune remontée sur ce mois.</td></tr>';

    // KPI
    const vMois = scope.reduce((a, b) => a + ventesDeclarees(b.code, du, au), 0);
    const rMois = sumMontant(rems);
    const k = [["Ventes déclarées (mois)", money0(vMois)], ["Fonds remontés (mois)", money0(rMois)]];
    // Reste à remonter (toutes les ventes − tous les fonds remontés) pour les boutiques affichées
    const reste = scope.reduce((a, b) => a + resteARemonter(b.code).total, 0);
    k.push(["Reste à remonter", money0(reste), reste > 0 ? "danger" : "hero-good"]);
    // Fonds déclarés par le CC mais pas encore vérifiés sur le compte par l'admin
    const attente = db.remontees.filter((r) => codes.includes(r.boutique) && r.statut !== "Reçue");
    k.push(["En attente de vérification", money0(sumMontant(attente)) + (attente.length ? '<span class="sub">' + attente.length + " remontée(s) à vérifier</span>" : ""), attente.length ? "warn" : ""]);
    k.push(["Fonds vérifiés (mois)", money0(sumMontant(rems.filter((r) => r.statut === "Reçue")))]);
    const nonRem = rows.filter((x) => weekEnd(x.w) < t && !x.r).length;
    if (nonRem) k.push(["Semaines non remontées", nonRem, "danger"]);

    if (global) {
      const fBq = $("#fd-boutique").value;
      const deps = db.charges.filter((c) => c.date >= du && c.date <= au && (fBq === "ALL" || c.boutique === fBq)).sort((a, b) => b.date.localeCompare(a.date));
      $("#fd-dep").innerHTML = deps.length ? deps.map((c) => {
        const canDel = admin || (c.createdBy === me.id && Date.now() - new Date(c.createdAt).getTime() < EDIT_WINDOW_MS);
        return "<tr><td>" + fmtDate(c.date) + "</td><td>" + (c.boutique ? esc(boutiqueName(c.boutique)) : '<span class="muted">Générale</span>') + "</td><td>" + esc(c.categorie) + "</td><td>" + esc(c.libelle) +
          '</td><td class="num"><b>' + money0(c.montant) + "</b></td><td>" + esc(c.saisiPar || "Admin") + "</td><td>" + (canDel ? '<button class="btn small danger" data-dp-del="' + c.id + '">✕</button>' : "") + "</td></tr>";
      }).join("") : '<tr><td colspan="7" class="empty">Aucune dépense sur ce mois.</td></tr>';
      const dcur = $("#dp-boutique").value;
      $("#dp-boutique").innerHTML = db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      $("#dp-boutique").value = db.boutiques.some((b) => b.code === dcur) ? dcur : fBq !== "ALL" ? fBq : (db.boutiques[0] || {}).code || "";
      if (!$("#dp-date").value) $("#dp-date").value = t;

      k.push(["Dépenses (mois)", money0(sumMontant(deps))]);
    }
    // Soldes, retraits et journal : administrateur
    if (admin) {
      const sol = scope.map((b) => ({ b, ...soldesOf(b.code) }));
      const T = (f) => sol.reduce((a, x) => a + x[f], 0);
      // Deux cases à côté de Boutique / Mois : solde de roulement (bleu) et solde bénéfice (vert)
      const lib = $("#fd-boutique").value === "ALL" ? "toutes les boutiques" : boutiqueName($("#fd-boutique").value);
      $("#fd-mini").innerHTML =
        '<div class="mini roul"><span>Solde de roulement</span><b>' + money2(T("roulement")) + "</b><small>" + (sol.length === 1 && sol[0].frigo ? "crédit de course restant (Frigo)" : "valeur d'achat du stock") + " · " + esc(lib) + "</small></div>" +
        '<div class="mini bene' + (T("benefice") < 0 ? " neg" : "") + '"><span>Solde bénéfice</span><b>' + money2(T("benefice")) + "</b><small>" + (sol.length === 1 && sol[0].frigo ? "bénéfice des ventes retirable (Frigo)" : "marge des ventes − dépenses − retraits") + "</small></div>";
      // Formulaire de retrait
      const rcur = $("#rt-boutique").value;
      $("#rt-boutique").innerHTML = db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      // Le retrait suit la boutique choisie dans le filtre
      $("#rt-boutique").value = $("#fd-boutique").value !== "ALL" ? $("#fd-boutique").value : db.boutiques.some((b) => b.code === rcur) ? rcur : (db.boutiques[0] || {}).code || "";
      if (!$("#rt-date").value) $("#rt-date").value = t;
      const sb0 = soldesOf($("#rt-boutique").value);
      $("#rt-info").textContent = "Solde bénéfice disponible : " + money2(sb0.benefice) + ".";
      // Journal du mois
      const ecart2 = (v) => '<span class="' + (v >= 0 ? "pos" : "neg") + '">' + (v > 0 ? "+" : "") + money2(v) + "</span>";
      $("#fd-journal-title").textContent = "Journal des mouvements — " + fmtMonth(du);
      const mv = journalOf(codes).filter((m) => m.date >= du && m.date <= au).sort((a, b) => b.date.localeCompare(a.date));
      $("#fd-journal").innerHTML = mv.length ? mv.map((m) => "<tr><td>" + fmtDate(m.date) + "</td><td>" + esc(boutiqueName(m.boutique)) + "</td><td>" + m.label +
        '</td><td class="num">' + (m.ca ? money0(m.ca) : '<span class="muted">—</span>') + '</td><td class="num">' + (m.bene ? ecart2(m.bene) : '<span class="muted">—</span>') + "</td><td>" +
        (m.retraitId ? '<button class="btn small danger" data-rt-del="' + m.retraitId + '">✕</button>' : "") + "</td></tr>").join("")
        : '<tr><td colspan="6" class="empty">Aucun mouvement sur ce mois.</td></tr>';
      $("#fd-journal-foot").innerHTML = mv.length ? '<tr><td colspan="3">TOTAL DU MOIS</td><td class="num">' + money0(mv.reduce((a, m) => a + m.ca, 0)) + '</td><td class="num">' + ecart2(mv.reduce((a, m) => a + m.bene, 0)) + "</td><td></td></tr>" : "";
    }
    $("#fd-kpis").innerHTML = kpiHtml(k);
  }
  // Coût d'achat d'une ligne de vente : coût moyen enregistré sur la vente, sinon coût moyen actuel du produit
  function coutVente(s) {
    const f = coutFrigo(s); if (f != null) return f;
    if (s.cout != null) return s.cout;
    const p = productByCode(s.code);
    return p ? Number(p.cmp) || 0 : 0;
  }
  // Mouvements du solde bénéfice : marge des ventes (par jour), dépenses et retraits
  // Cadre « Remonter les fonds » : boutique avec frigo = on remonte le BÉNÉFICE (proposé par défaut) ;
  // sinon les ventes déclarées de la semaine. « Reste à remonter » suit le montant saisi.
  function majRmInfo(proposer) {
    const admin = isAdmin(), remBq = admin ? ($("#fd-boutique").value !== "ALL" ? $("#fd-boutique").value : "") : (canEntrees() ? myBoutiqueCode() : "");
    if (!remBq) return;
    const w = $("#rm-semaine").value, r = sumMontant(remonteesOf(remBq, w)), frigo = db.fgCourses.some((c) => c.boutique === remBq);
    const fs = fgSemaine(remBq, w);
    const base = Math.max(0, fs.ventes - r);
    const el = $("#rm-montant");
    if (proposer && document.activeElement !== el && !rmOcr) el.value = base > 0 ? Math.round(base * 100) / 100 : "";
    const saisi = Number(el.value) || 0, reste = Math.max(0, Math.round((base - saisi) * 100) / 100);
    $("#rm-info").innerHTML = '<div class="info-row"><span>Boutique</span><span><b>' + esc(boutiqueName(remBq)) + "</b></span></div>" +
      '<div class="info-row"><span>Ventes de la semaine du ' + fmtDate(w) + "</span><span><b>" + money2(fs.ventes) + "</b></span></div>" +
      (frigo
        ? '<div class="info-row"><span>&nbsp;&nbsp;dont montant de l\'achat (frigo)</span><span>' + money2(fs.achat) + "</span></div>" +
          '<div class="info-row"><span>&nbsp;&nbsp;dont bénéfice réalisé</span><span>' + money2(Math.max(0, fs.ventes - fs.achat)) + "</span></div>"
        : "") +
      '<div class="info-row"><span>Déjà remonté pour cette semaine</span><span>' + money2(r) + "</span></div>" +
      '<div class="info-row"><span>Reste à remonter</span><span><b' + (reste > 0 ? ' class="neg"' : ' class="pos"') + ">" + money2(reste) + "</b></span></div>";
  }
  function journalOf(codes) {
    const out = [];
    codes.forEach((bq) => {
      // Boutique avec frigo : bénéfice des ventes du frigo (prix de vente − prix d'achat de la course), remontées et retraits du frigo
      if (db.fgCourses.some((c) => c.boutique === bq)) {
        const jf = {};
        db.fgSorties.filter((x) => x.boutique === bq).forEach((x) => { const j = jf[x.date] || (jf[x.date] = { ca: 0, bene: 0 }); j.ca += x.montant; j.bene += x.montant - x.consomme; });
        Object.keys(jf).forEach((d) => out.push({ date: d, boutique: bq, ca: jf[d].ca, bene: Math.round(jf[d].bene * 100) / 100, label: "🧊 Bénéfice des ventes du frigo du jour" }));
        db.remontees.filter((r) => r.boutique === bq).forEach((r) => out.push({ date: String(r.createdAt || r.semaine).slice(0, 10), boutique: bq, ca: 0, bene: -remBenefPart(r),
          label: "⬆ Remontée du " + fmtDate(String(r.createdAt || r.semaine).slice(0, 10)) + " : " + money2(r.montant) + " (" + esc(r.mode || "") + ") — part bénéfice" }));
        db.fgRetraits.filter((x) => x.boutique === bq).forEach((x) => out.push({ date: x.date, boutique: bq, ca: 0, bene: -x.montant, label: "🏧 Retrait (Frigo)" + (x.note ? " — " + esc(x.note) : "") }));
        return;
      }
      const jours = {};
      db.sales.filter((s) => isCountedSale(s) && saleBoutique(s) === bq).forEach((s) => {
        const j = jours[s.date] || (jours[s.date] = { ca: 0, marge: 0 });
        j.ca += lineTotal(s);
        j.marge += lineTotal(s) - Number(s.qte) * coutVente(s);
      });
      Object.keys(jours).forEach((d) => out.push({ date: d, boutique: bq, ca: jours[d].ca, bene: Math.round(jours[d].marge), label: "🛍 Marge des ventes du jour" }));
      db.charges.filter((c) => c.boutique === bq).forEach((c) => out.push({
        date: c.date, boutique: bq, ca: 0, bene: -c.montant, label: "🧾 Dépense — " + esc(c.categorie) + (c.libelle ? " : " + esc(c.libelle) : "")
      }));
      db.retraits.filter((x) => x.boutique === bq).forEach((x) => out.push({
        date: x.date, boutique: bq, ca: 0, bene: -x.montant, retraitId: x.id, label: "🏧 Retrait" + (x.note ? " — " + esc(x.note) : "")
      }));
    });
    return out;
  }
  // Solde de roulement = valeur d'achat du stock disponible ; solde bénéfice = marge − dépenses − retraits
  function soldesOf(bq) {
    // Boutique avec frigo : roulement = crédit de course restant, bénéfice = bénéfice des ventes retirable (menu Frigo)
    if (db.fgCourses.some((c) => c.boutique === bq)) {
      const f = frigoInfo(bq, today().slice(0, 7)), r2 = (n) => Math.round(n * 100) / 100;
      return { frigo: true, roulement: r2(Math.max(0, f.restant)), articles: 0, marge: r2(f.benefVentes), depenses: 0, retraits: r2(f.retire), benefice: r2(f.aRetirer),
        aValider: sumMontant(db.remontees.filter((r) => r.boutique === bq && r.statut !== "Reçue")) };
    }
    let roulement = 0, articles = 0;
    db.products.forEach((p) => { const st = Math.max(0, stockActuel(p, bq)); articles += st; roulement += st * (Number(p.cmp) || 0); });
    const marge = db.sales.filter((s) => isCountedSale(s) && saleBoutique(s) === bq).reduce((a, s) => a + lineTotal(s) - Number(s.qte) * coutVente(s), 0);
    const depenses = sumMontant(db.charges.filter((c) => c.boutique === bq));
    const retraits = sumMontant(db.retraits.filter((x) => x.boutique === bq));
    return {
      roulement: Math.round(roulement), articles, marge: Math.round(marge), depenses, retraits,
      benefice: Math.round(marge - depenses - retraits),
      aValider: sumMontant(db.remontees.filter((r) => r.boutique === bq && r.statut !== "Reçue"))
    };
  }
  // Fonds restant à remonter = toutes les ventes déclarées − tous les fonds remontés (semaine en cours comprise)
  function resteARemonter(bq) {
    const ventes = db.sales.filter((s) => isCountedSale(s) && saleBoutique(s) === bq);
    if (!ventes.length) return { total: 0, semaines: [] };
    const totalVentes = ventes.reduce((a, s) => a + lineTotal(s), 0);
    const totalRemonte = sumMontant(db.remontees.filter((r) => r.boutique === bq));
    const total = Math.max(0, Math.round(totalVentes - totalRemonte));
    // Détail par semaine (pour la notification) : semaines où il manque de l'argent
    const lundiCourant = mondayOf(today()), semaines = [];
    for (let w = mondayOf(ventes.map((s) => s.date).sort()[0]); w <= lundiCourant; w = addDays(w, 7)) {
      const manque = ventesDeclarees(bq, w, weekEnd(w)) - sumMontant(remonteesOf(bq, w));
      if (manque > 0.5) semaines.push({ w, manque: Math.round(manque) });
    }
    return { total, semaines: total ? semaines : [] };
  }
  // Notification permanente en haut de l'application pour le CC qui doit remonter des fonds
  // Remontées en espèces remises à mon CC et pas encore confirmées
  // Service « Reçoit les espèces » supprimé le 13/11/2026 : plus de CC receveur à notifier
  function especesAConfirmer() { return []; }
  // Fermer les annonces d'anniversaire pour la journée
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-anniv-ok]")) return;
    try { localStorage.setItem("anniv-ferme", today()); } catch (err) {}
    renderAppAlert();
  });
  function renderAppAlert() {
    const el = $("#app-alert");
    const bq = !isAdmin() && canEntrees() ? myBoutiqueCode() : "";
    const r = bq ? resteARemonter(bq) : { total: 0 };
    const recus = especesAConfirmer();
    let h = "";
    // 🎂 Anniversaires du jour : message personnel pour le CC fêté, annonce pour tous les autres
    let fermes = ""; try { fermes = localStorage.getItem("anniv-ferme") || ""; } catch (e) {}
    if (fermes !== today()) {
      (db.anniv || []).forEach((a) => {
        const prenom = a.nom || ccName(a.cc), elle = a.sexe === "F";
        if (me && !isAdmin() && String(me.cc) === a.cc) {
          h += '<div class="alert-line anniv"><span class="fete">🎉🎂</span><span><b>Joyeux anniversaire ' + esc(prenom) + " ! 🥳</b><br>Toute l'équipe " + esc(db.settings.nom || "BGTeam") +
            " te souhaite une excellente journée et une très belle année" + (elle ? " pleine de réussite, chère collègue." : " pleine de réussite, cher collègue.") + " 🎈🎁🎊</span>" +
            '<span class="fete">🎈🎁</span><button class="btn small" data-anniv-ok>Merci 🙏</button></div>';
        } else {
          h += '<div class="alert-line anniv"><span class="fete">🎂🎉</span><span>Aujourd\'hui, c\'est l\'anniversaire de <b>' + esc(ccName(a.cc)) + "</b>" + (a.sexe ? (elle ? " 👩" : " 👨") : "") +
            " ! 🥳 Pensez à " + (a.sexe ? (elle ? "la" : "le") : "lui") + " féliciter. 🎈🎁</span>" +
            '<span class="fete">🎊</span><button class="btn small" data-anniv-ok>OK</button></div>';
        }
      });
    }
    if (recus.length) {
      h += '<div class="alert-line ok">💵 <span><b>Vous avez reçu en espèces ' + money0(sumMontant(recus)) + "</b> — " +
        recus.map((x) => money0(x.montant) + " de " + esc(x.cc ? ccName(x.cc) : "l'admin") + " (" + esc(boutiqueName(x.boutique)) + ")").join(" · ") +
        '</span> <button class="btn small success" data-view-link="compte">Voir et confirmer</button></div>';
    }
    // 🌙 Clôture du soir du crédit : rappel à tous les CC de la boutique (dès 17 h, ou si celle d'hier manque)
    if (me && !isAdmin() && canCloture() && boutiquesCredit().some((b) => b.code === myBoutiqueCode())) {
      const bqc = myBoutiqueCode(), manqueHier = hierManquant(bqc), manqueSoir = !venteFaite(bqc, today()) && new Date().getHours() >= 15;
      // Notification dès 15 h ; bouton « Faire le contrôle » à partir de 20 h (ou tout de suite si le contrôle d'hier manque)
      const boutonCs = manqueHier || new Date().getHours() >= 20;
      if (manqueHier || manqueSoir) h += '<div class="alert-line">🌙 <span><b>' + (manqueHier ? "Contrôle du crédit restant d'hier non fait" : "Contrôle du crédit restant de ce soir à faire") +
        "</b> — " + (manqueHier ? "les nouvelles recharges sont bloquées tant qu'il n'est pas déclaré." : "lisez le crédit restant YAS et MOOV sur les puces et notez-le.") + "</span>" +
        (boutonCs ? '<button class="btn small" data-cs-go>Faire le contrôle</button>' : "") + "</div>";
    }
    // 🧊 Seuil de réapprovisionnement atteint : alerte au gestionnaire du frigo (l'admin l'a dans le tableau de bord)
    if (me && !isAdmin() && canFrigoDotation()) {
      const bas = boutiquesFrigo().filter((b) => frigoInfo(b.code, today().slice(0, 7)).seuilAtteint && !dotOuverte(b.code));
      if (bas.length) h += '<div class="alert-line">🧊 <span><b>Frigo à réapprovisionner</b> — ' + bas.map((b) => esc(b.nom) + " (reste " + money0(Math.max(0, frigoInfo(b.code, today().slice(0, 7)).restant)) + ")").join(", ") +
        " : nouvelle course de " + money0(DOTATION_STANDARD) + " à doter.</span>" + '<button class="btn small" data-view-link="frigo">Doter</button></div>';
    }
    // 💰 Dotation du frigo en attente de course (CC de la boutique)
    if (me && !isAdmin() && myBoutiqueCode()) {
      const dfr = dotOuverte(myBoutiqueCode());
      if (dfr) h += '<div class="alert-line">💰 <span><b>Dotation du frigo : ' + money2(dfr.montant) + "</b> — faites la course du frigo pour exactement ce montant.</span>" +
        '<button class="btn small" data-view-link="frigo">Faire la course</button></div>';
    }
    // Commission de crédit des mois passés pas encore reversée (CC autorisé aux achats de crédit)
    // Relance : à partir du 1er du mois (mois passés) ou dès que le gestionnaire demande le versement ; s'arrête quand c'est déclaré
    if (me && !isAdmin() && canCreditSaisie() && myBoutiqueCode()) {
      const du = comARelancer(myBoutiqueCode()), dem = demandeActive();
      const gest = db.settings.ccList.filter((x) => x.actif && x.gereCom).map((x) => ccName(x.code)).join(" ou ");
      if (du > 0) h += '<div class="alert-line">📱 <span><b>Commission de crédit à reverser : ' + money0(du) + "</b>" +
        (dem ? " — demandée par " + esc(dem.demandeur || "le gestionnaire") + " le " + fmtDate(String(dem.createdAt).slice(0, 10)) : " (mois passés)") +
        (gest ? ". Transférez-la sur le portable de <b>" + esc(gest) + "</b>, puis déclarez le versement." : ".") + "</span>" +
        '<button class="btn small" data-view-link="credit">Verser la commission</button></div>';
    }
    // Gestionnaire des commissions : versements déclarés à confirmer
    if (me && !isAdmin() && canGererCom()) {
      const att = db.crVers.filter((v) => v.statut !== "Reçue");
      if (att.length) h += '<div class="alert-line">💸 <span><b>' + att.length + " versement" + (att.length > 1 ? "s" : "") + " de commission à confirmer</b> — " + money0(sumBy(att, (v) => v.montant)) +
        " déclarés. Confirmez dès que l'argent est arrivé sur votre portable.</span>" + '<button class="btn small" data-view-link="dashboard">Confirmer</button></div>';
    }
    // 📝 Produits créés par un CC, en attente de validation : notification à l'admin dès la connexion
    if (me && isAdmin()) {
      const av = db.products.filter((p) => !p.valide);
      if (av.length) h += '<div class="alert-line">📝 <span><b>' + av.length + " produit" + (av.length > 1 ? "s" : "") + " à valider</b> — " +
        av.slice(0, 8).map((p) => esc(p.nom) + (p.creePar ? " (créé par " + esc(p.creePar) + ")" : "")).join(", ") + (av.length > 8 ? "…" : "") +
        ". Vérifiez le nom et le prix, puis cliquez sur ✓ Valider.</span>" + '<button class="btn small success" data-fg-stock-go="' + esc(av[0].code) + '">Voir et valider</button></div>';
    }
    if (r.total) {
      h += '<div class="alert-line">⚠ <span><b>Fonds à remonter : ' + money0(r.total) + "</b> — " +
        r.semaines.map((x) => "semaine du " + fmtDate(x.w) + " : " + money0(x.manque)).join(" · ") +
        '</span> <button class="btn small" data-view-link="fonds">Remonter les fonds</button></div>';
    }
    el.innerHTML = h;
    el.classList.toggle("hidden", !h);
  }
  $("#rt-boutique").addEventListener("change", () => { $("#rt-info").textContent = "Solde bénéfice disponible : " + money0(soldesOf($("#rt-boutique").value).benefice) + "."; });
  $("#rt-save").addEventListener("click", (e) => {
    const bq = $("#rt-boutique").value, montant = Number($("#rt-montant").value);
    if (!bq) return toast("Choisissez la boutique.");
    if (!(montant > 0)) return toast("Indiquez le montant du retrait.");
    const dispo = soldesOf(bq).benefice;
    if (montant > dispo && !confirm("Le solde bénéfice de " + boutiqueName(bq) + " n'est que de " + money0(dispo) + ". Retirer quand même " + money0(montant) + " ?")) return;
    const row = { boutique: bq, date: $("#rt-date").value || today(), montant, note: $("#rt-note").value.trim(), saisi_par: me.nom || me.email || "" };
    act(async () => {
      chk(await sb.from("retraits").insert(row));
      $("#rt-montant").value = ""; $("#rt-note").value = "";
    }, "Retrait enregistré : " + money(montant) + " (" + boutiqueName(bq) + ").", e.target);
  });
  $("#fd-journal").addEventListener("click", (e) => {
    const d = e.target.closest("[data-rt-del]");
    if (d && confirm("Supprimer ce retrait ?")) act(async () => chk(await sb.from("retraits").delete().eq("id", d.dataset.rtDel)), "Retrait supprimé.", d);
  });
  $("#fd-boutique").addEventListener("change", renderFonds);
  $("#fd-mois").addEventListener("change", renderFonds);
  $("#rm-semaine").addEventListener("change", renderFonds);
  $("#rm-montant").addEventListener("input", () => majRmInfo(false));
  // Mobile money / virement : photo du reçu de dépôt obligatoire (+ référence facultative)
  let rmPhotoBlob = null, rmOcr = null, rmOcrEnCours = false;
  // ---- Lecture automatique du reçu (OCR, Tesseract.js chargé seulement quand on en a besoin) ----
  let tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { tesseractPromise = null; reject(new Error("Lecture automatique indisponible (connexion)")); };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }
  // Extrait du texte d'un reçu Mixx : n° de transaction, montant, expéditeur, destinataire
  // Formats acceptés : reçu Mixx (« Transfert d'argent ») et SMS d'envoi (« Envoi de 6 300 FCFA au 72117777(BLESSING)… Ref: 19464910566 »)
  function lireRecu(texte) {
    const t = String(texte || "").replace(/[|]/g, " ");
    // Référence : « Ref: 19464910566 » en priorité, sinon une suite de 10 à 14 chiffres
    const tx = (t.match(/R[ée]f\.?\s*[:\-]?\s*(\d{8,14})/i) || t.match(/\b(\d{10,14})\b/) || [])[1] || "";
    // Montant envoyé : on ignore les montants de « Frais » et de « solde »
    const cands = Array.from(t.matchAll(/(\d[\d .,]{0,12}\d|\d)\s*F\s?cfa/gi)).map((m) => {
      const avant = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
      return { n: Number(m[1].replace(/[^\d]/g, "")), avant };
    }).filter((c) => c.n > 0 && !/solde|frais/.test(c.avant));
    const prio = cands.filter((c) => /envoi|montant|transfert|re[çc]u/.test(c.avant));
    const pool = prio.length ? prio : cands;
    const montant = pool.length ? Math.max.apply(null, pool.map((c) => c.n)) : null;
    // Numéros masqués lus par zones (les étoiles sont souvent mal reconnues) :
    // expéditeur entre « Envoyé par » et « Reçu par », destinataire entre « Reçu par » et « Compte/Montant »
    const zone = (debut, fin) => { const m = t.match(new RegExp(debut + "([\\s\\S]*?)(?:" + fin + "|$)", "i")); return m ? m[1] : ""; };
    const quatre = (z) => { const m = z.match(/(\d{4})(?!\d)/g); return m ? m[m.length - 1] : ""; };
    const expediteur = quatre(zone("Envoy[ée]\\s*par", "Re[cçg]u\\s*par"));
    // Destinataire : zone « Reçu par » du reçu, ou « au 72117777 » du SMS
    const destinataire = quatre(zone("Re[cçg]u\\s*par", "Compte|Montant")) || ((t.match(/\bau\s*(\d{8})/i) || [])[1] || "").slice(-4);
    return { tx, montant, expediteur, destinataire, lu: !!(tx && montant) };
  }
  async function analyserRecu(blob) {
    rmOcr = null; rmOcrEnCours = true; syncRmNote();
    try {
      const T = await loadTesseract();
      const res = await Promise.race([
        T.recognize(blob, "eng"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), 60000))
      ]);
      rmOcr = lireRecu(res && res.data ? res.data.text : "");
      if (rmOcr.montant) { $("#rm-montant").value = rmOcr.montant; majRmInfo(false); }
    } catch (err) {
      rmOcr = { lu: false, erreur: errMsg(err) };
    }
    rmOcrEnCours = false; syncRmNote();
  }
  // N° de transaction déjà utilisé par une autre remontée ? (chiffres comparés, 6 au minimum)
  function refDejaUtilisee(tx, exceptId) {
    const n = String(tx || "").replace(/\D/g, "");
    if (n.length < 6) return null;
    return db.remontees.find((r) => r.id !== exceptId && (r.txId === n || String(r.note || "").replace(/\D/g, "") === n)) || null;
  }
  function syncRmNote() {
    const ref = $("#rm-mode").value !== "Espèces";
    // Espèces : remises directement (plus de « CC qui reçoit », service supprimé) ; Mobile money : on joint le reçu
    $("#rm-receveur-wrap").classList.add("hidden");
    $("#rm-photo-zone").classList.toggle("hidden", !ref);
    let lecture = "";
    if (rmPhotoBlob && rmOcrEnCours) lecture = '<span class="ocr-info">🔎 Lecture automatique du reçu…</span>';
    else if (rmPhotoBlob && rmOcr && rmOcr.lu) {
      const num = (db.settings.numero_depot || "").replace(/\D/g, "");
      const destOk = !num || !rmOcr.destinataire || num.slice(-4) === rmOcr.destinataire;
      lecture = '<span class="ocr-info ok">✅ Lu sur le reçu : ' + (rmOcr.tx ? "n° <b>" + esc(rmOcr.tx) + "</b> · " : "") + (rmOcr.montant ? "<b>" + money0(rmOcr.montant) + "</b>" : "montant non lu") +
        (rmOcr.expediteur ? " · de ****" + esc(rmOcr.expediteur) : "") + (rmOcr.destinataire ? " · vers ****" + esc(rmOcr.destinataire) : "") + "</span>" +
        (destOk ? "" : '<span class="ocr-info bad">⛔ Ce dépôt n\'a pas été fait sur le numéro de la boutique (****' + esc(num.slice(-4)) + ").</span>");
    } else if (rmPhotoBlob && rmOcr && rmOcr.erreur) lecture = '<span class="ocr-info warn">⚠ Lecture automatique indisponible (' + esc(rmOcr.erreur) + "). Vous pouvez envoyer : l'admin vérifiera le reçu.</span>";
    else if (rmPhotoBlob && rmOcr) lecture = '<span class="ocr-info bad">⛔ ' + (rmOcr.tx ? "" : "Référence (Ref) illisible. ") + (rmOcr.montant ? "" : "Montant illisible. ") +
      "Touchez « 📷 Reçu du dépôt » pour reprendre la photo et recadrer sur le message.</span>";
    $("#rm-photo-preview").innerHTML = rmPhotoBlob
      ? '<img src="' + URL.createObjectURL(rmPhotoBlob) + '" alt="Reçu du dépôt"><div class="ocr-col">' + lecture + '<button type="button" class="btn small danger" id="rm-photo-rm">Retirer</button></div>'
      : "<span>Ajoutez la <b>capture d'écran du reçu</b> de dépôt mobile money. L'application la lit automatiquement. <b>Obligatoire.</b></span>";
  }
  $("#rm-mode").addEventListener("change", syncRmNote);
  // ---- Recadrage (Cropper.js chargé à la demande) ----
  let cropperLib = null, cropper = null, cropFile = null;
  function loadCropper() {
    if (window.Cropper) return Promise.resolve(window.Cropper);
    if (!cropperLib) cropperLib = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.css";
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.js";
      s.onload = () => resolve(window.Cropper);
      s.onerror = () => { cropperLib = null; reject(new Error("Recadrage indisponible")); };
      document.head.appendChild(s);
    });
    return cropperLib;
  }
  async function utiliserImage(blob) {
    try { rmPhotoBlob = await compressImage(blob); } catch (err) { rmPhotoBlob = null; toast("Photo illisible, réessayez."); }
    syncRmNote();
    if (rmPhotoBlob) analyserRecu(rmPhotoBlob);
  }
  $("#rm-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    cropFile = file;
    try {
      const C = await loadCropper();
      const img = $("#crop-img");
      if (cropper) { cropper.destroy(); cropper = null; }
      img.onload = () => { cropper = new C(img, { viewMode: 1, autoCropArea: 1, background: false, zoomable: false, movable: false, rotatable: false }); };
      $("#crop-dialog").showModal();
      img.src = URL.createObjectURL(file);
    } catch (err) {
      utiliserImage(file); // pas de recadrage possible (connexion) : on garde l'image entière
    }
  });
  $("#crop-full").addEventListener("click", () => { $("#crop-dialog").close(); if (cropFile) utiliserImage(cropFile); });
  $("#crop-ok").addEventListener("click", () => {
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({ maxWidth: 2000, maxHeight: 2000, fillColor: "#fff" });
    $("#crop-dialog").close();
    canvas.toBlob((b) => utiliserImage(b || cropFile), "image/jpeg", 0.9);
  });
  $("#crop-dialog").addEventListener("close", () => { if (cropper) { cropper.destroy(); cropper = null; } });
  $("#rm-photo-preview").addEventListener("click", (e) => {
    if (e.target.closest("#rm-photo-rm")) { rmPhotoBlob = null; rmOcr = null; syncRmNote(); }
  });
  syncRmNote();
  $("#rm-save").addEventListener("click", (e) => {
    const admin = isAdmin();
    const bq = admin ? $("#fd-boutique").value : myBoutiqueCode();
    const montant = Number($("#rm-montant").value);
    if (!bq || bq === "ALL") return toast("Choisissez une boutique.");
    if (!(montant > 0)) return toast("Indiquez le montant remis.");
    if (remonteeVerrouillee()) return toast("🔒 Les remontées se font uniquement le lundi (prochain : lundi " + fmtDate(prochainLundi()) + ").");
    if (!admin && $("#rm-semaine").value >= mondayOf(today())) return toast("La semaine en cours se remonte le lundi suivant.");
    // Mobile money / virement : la photo du reçu de dépôt est obligatoire (vérification par l'admin)
    const avecRecu = $("#rm-mode").value !== "Espèces";
    const receveur = ""; // service « Reçoit les espèces » supprimé
    if (avecRecu && !rmPhotoBlob) return toast("Ajoutez la capture d'écran du reçu de dépôt.");
    if (avecRecu && rmOcrEnCours) return toast("Lecture du reçu en cours, patientez quelques secondes…");
    // Deux vérifications obligatoires : la référence ET le montant doivent être lus sur la photo
    // (sauf si la lecture automatique n'a pas pu se charger : l'admin vérifiera, avec une alerte)
    if (avecRecu && rmOcr && !rmOcr.lu && !rmOcr.erreur) return toast("Référence ou montant illisible : recadrez la photo sur le message (montant envoyé et Ref).");
    // Contrôles automatiques à partir du reçu lu
    const ocr = avecRecu && rmOcr && rmOcr.lu ? rmOcr : null;
    if (ocr) {
      if (ocr.montant && ocr.montant !== montant) return toast("Le reçu indique " + money0(ocr.montant) + " mais vous déclarez " + money0(montant) + ". Corrigez le montant.");
      const num = (db.settings.numero_depot || "").replace(/\D/g, "");
      if (num && ocr.destinataire && num.slice(-4) !== ocr.destinataire) return toast("Ce reçu n'est pas un dépôt sur le numéro de la boutique (****" + num.slice(-4) + ").");
      const dup = refDejaUtilisee(ocr.tx);
      if (dup) return toast("Ce reçu (n° " + ocr.tx + ") a déjà servi pour une remontée du " + fmtDate(dup.semaine) + " (" + money0(dup.montant) + ").");
    }
    const w = $("#rm-semaine").value;
    // Contrôle : ventes de la semaine (pour le frigo : montant de l'achat + bénéfice) − déjà remonté
    const du = resteRemSemaine(bq, w);
    const manque = Math.round((du - montant) * 100) / 100;
    // Rien (ou moins que le montant) à remonter pour cette semaine : mauvaise semaine choisie ?
    if (montant - Math.max(0, du) > 0.5) {
      const lundiC = mondayOf(today()), autres = [];
      for (let i = 0; i < 9; i++) { const x = addDays(lundiC, -7 * i); if (x !== w && resteRemSemaine(bq, x) > 0.5) autres.push(x); }
      const conseil = autres.length ? "\n\nSemaine(s) qui doivent encore de l'argent : " + autres.map((x) => "du " + fmtDate(x) + " (" + money2(resteRemSemaine(bq, x)) + ")").join(", ") + "." : "";
      if (du <= 0.5 && !admin) return alert("⛔ Rien à remonter pour la semaine du " + fmtDate(w) + " au " + fmtDate(weekEnd(w)) + ".\nVentes de cette semaine : " + money2(ventesDeclarees(bq, w, weekEnd(w))) + " · déjà remonté : " + money2(sumMontant(remonteesOf(bq, w))) + "." + conseil + "\n\nChoisissez la bonne semaine dans la liste « Semaine ».");
      if (!confirm("⚠ Montant supérieur à ce qui reste à remonter pour la semaine du " + fmtDate(w) + "\n\nReste à remonter : " + money2(Math.max(0, du)) + "\nMontant saisi : " + money2(montant) + "\nExcédent : " + money2(montant - Math.max(0, du)) + conseil + "\n\nEst-ce bien la bonne semaine ? Confirmer quand même ?")) return;
    }
    if (manque > 0 && !confirm("⚠ Montant inférieur aux ventes déclarées\n\nVentes de la semaine du " + fmtDate(w) + " (reste dû) : " + money2(du) +
      "\nMontant que vous remontez : " + money2(montant) + "\nReste à remonter : " + money2(manque) + "\n\nLe reste devra être remonté. Confirmer quand même ?")) return;
    const row = { boutique: bq, cc: admin ? null : me.cc, semaine: w, montant, mode: $("#rm-mode").value, note: "", saisi_par: me.nom || me.email || "" };
    if (receveur) row.cc_receveur = receveur;
    if (ocr) {
      row.tx_id = ocr.tx || null;
      row.recu_infos = { montant: ocr.montant, expediteur: ocr.expediteur, destinataire: ocr.destinataire, tx: ocr.tx };
    }
    const btn = e.target;
    act(async () => {
      if (avecRecu) {
        btn.textContent = "Envoi du reçu…";
        const path = "remontees/" + w.slice(0, 7) + "/" + uuid() + ".jpg";
        chk(await sb.storage.from("recus").upload(path, rmPhotoBlob, { contentType: "image/jpeg", upsert: false }));
        row.recu_path = path;
      }
      chk(await sb.from("remontees").insert(row));
      $("#rm-montant").value = ""; rmPhotoBlob = null; rmOcr = null; syncRmNote();
    }, (manque > 0 ? "Remontée enregistrée. ⚠ Il reste " + money2(manque) + " à remonter." : "Remontée déclarée : " + money2(montant) + ".") +
      (receveur ? " " + ccName(receveur) + " doit confirmer la réception de l'argent." : " L'admin la validera après avoir vérifié la réception de l'argent."), btn).then(() => { btn.textContent = "Déclarer la remontée"; });
  });
  $("#fd-rem").addEventListener("click", (e) => {
    const ph = e.target.closest("[data-rm-photo]");
    if (ph) return signedPhotoUrl(ph.dataset.rmPhoto).then((u) => showPhoto(u, "Reçu du dépôt"), () => toast("Photo indisponible."));
    // Admin : rattacher la remontée à une autre semaine (ex. le CC a choisi la mauvaise semaine)
    const sm = e.target.closest("[data-rm-sem]");
    if (sm && isAdmin()) {
      const rm = db.remontees.find((x) => x.id === sm.dataset.rmSem); if (!rm) return;
      const lundiC = mondayOf(today()), ws = [];
      for (let i = 0; i < 9; i++) ws.push(addDays(lundiC, -7 * i));
      const txt = prompt("Remontée de " + money2(rm.montant) + " (" + boutiqueName(rm.boutique) + "), actuellement rattachée à la semaine du " + fmtDate(rm.semaine) + ".\n\nTapez le numéro de la bonne semaine :\n" +
        ws.map((x, i) => (i + 1) + ". du " + fmtDate(x) + " au " + fmtDate(weekEnd(x)) + " — ventes " + money2(ventesDeclarees(rm.boutique, x, weekEnd(x))) + ", reste à remonter " + money2(Math.max(0, resteRemSemaine(rm.boutique, x)))).join("\n"), "1");
      if (txt === null) return;
      const nw = ws[Number(txt) - 1];
      if (!nw) return toast("Numéro de semaine invalide.");
      if (nw === rm.semaine) return;
      return act(async () => chk(await sb.from("remontees").update({ semaine: nw }).eq("id", rm.id)), "Remontée rattachée à la semaine du " + fmtDate(nw) + ".", sm);
    }
    const r = e.target.closest("[data-rm-recu]");
    // Avant de valider : l'admin confirme avoir vérifié que l'argent est bien arrivé sur son compte
    if (r && r.dataset.v === "1") {
      const rm = db.remontees.find((x) => x.id === r.dataset.rmRecu);
      if (rm && !confirm("Vérification avant validation\n\nMontant : " + money0(rm.montant) + "\nMode : " + rm.mode + (rm.note ? "\nRéférence / note : " + rm.note : "") +
        (rm.mode !== "Espèces" ? "\nReçu du dépôt : " + (rm.recuPath ? "joint (bouton 📷 Voir le reçu)" : "AUCUN") : "") +
        (rm.txId ? "\nN° de transaction lu sur le reçu : " + rm.txId : "") +
        (rm.alerte ? "\n\n⚠ " + rm.alerte : "") +
        (refDejaUtilisee(rm.txId || rm.note, rm.id) ? "\n\n⚠ ATTENTION : ce n° de transaction est déjà utilisé par une autre remontée !" : "") +
        (rm.mode !== "Espèces" ? "\n\nVérifiez dans votre historique Mixx que ce n° de transaction et ce montant sont bien arrivés." : "") +
        (rm.ccReceveur ? "\n\nEspèces remises à : " + ccName(rm.ccReceveur) + "\n" + (rm.confirmeLe ? "✓ Réception confirmée par " + (rm.confirmePar || ccName(rm.ccReceveur)) + " le " + new Date(rm.confirmeLe).toLocaleString("fr-FR") : "⚠ Le CC n'a PAS encore confirmé avoir reçu l'argent.") : "") +
        "\nBoutique : " + boutiqueName(rm.boutique) + (rm.cc ? " — " + ccName(rm.cc) : "") +
        "\n\nAvez-vous vérifié que ce montant est bien arrivé sur votre compte (ou reçu en espèces) ?")) return;
    }
    if (r) return act(async () => chk(await sb.rpc("set_remontee_recue", { p_id: r.dataset.rmRecu, p_recue: r.dataset.v === "1" })), r.dataset.v === "1" ? "Remontée validée." : "Validation annulée.", r);
    const d = e.target.closest("[data-rm-del]");
    if (d && confirm("Supprimer cette remontée ?")) act(async () => chk(await sb.from("remontees").delete().eq("id", d.dataset.rmDel)), "Remontée supprimée.", d);
  });
  $("#dp-save").addEventListener("click", (e) => {
    const montant = Number($("#dp-montant").value);
    if (!$("#dp-boutique").value) return toast("Choisissez la boutique.");
    if (!(montant > 0)) return toast("Indiquez le montant de la dépense.");
    const row = { date: $("#dp-date").value || today(), boutique: $("#dp-boutique").value, categorie: $("#dp-cat").value, libelle: $("#dp-lib").value.trim(), montant, saisi_par: me.nom || me.email || "" };
    act(async () => {
      chk(await sb.from("charges").insert(row));
      $("#dp-montant").value = ""; $("#dp-lib").value = "";
    }, "Dépense enregistrée : " + money(montant) + " (" + boutiqueName(row.boutique) + ").", e.target);
  });
  $("#fd-dep").addEventListener("click", (e) => {
    const d = e.target.closest("[data-dp-del]");
    if (d && confirm("Supprimer cette dépense ?")) act(async () => chk(await sb.from("charges").delete().eq("id", d.dataset.dpDel)), "Dépense supprimée.", d);
  });

  // ---------- Bobines ----------
  const BOBINE_SEUIL = 2;
  const BOBINE_DELAI_MS = 30 * 60 * 1000;
  function bobinesOf(bq) {
    const m = db.bobines.filter((x) => x.boutique === bq);
    const recues = m.filter((x) => x.type === "Approvisionnement").reduce((a, x) => a + x.qte, 0);
    const utilisees = m.filter((x) => x.type === "Utilisation").reduce((a, x) => a + x.qte, 0);
    const appro = m.filter((x) => x.type === "Approvisionnement").map((x) => x.date).sort().pop() || "";
    // Moyenne d'utilisation : depuis la première utilisation déclarée jusqu'à aujourd'hui
    const debut = m.filter((x) => x.type === "Utilisation").map((x) => x.date).sort()[0] || "";
    const jours = debut ? Math.max(1, Math.round((parse(today()) - parse(debut)) / 86400000) + 1) : 0;
    const parJour = jours ? utilisees / jours : 0;
    return { recues, utilisees, reste: recues - utilisees, appro, parJour, jours };
  }
  function moyHtml(v) { return v ? v.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : '<span class="muted">—</span>'; }
  function autonomieHtml(x) {
    if (x.reste <= 0) return '<span class="badge danger">Épuisé</span>';
    if (!x.parJour) return '<span class="muted">—</span>';
    const j = Math.floor(x.reste / x.parJour);
    if (j < 1) return '<span class="badge danger">Moins d\'1 jour</span>';
    return '<span class="' + (j <= 3 ? "badge warn" : "") + '">≈ ' + j + " jour" + (j > 1 ? "s" : "") + "</span>";
  }
  function bobineStatut(reste) {
    return reste <= 0 ? '<span class="badge danger">RUPTURE</span>' : reste <= BOBINE_SEUIL ? '<span class="badge warn">STOCK FAIBLE</span>' : '<span class="badge ok">OK</span>';
  }
  function bobinesScope() { return bobinesDroit() === "gestion" ? db.boutiques : db.boutiques.filter((b) => b.code === myBoutiqueCode()); }
  function renderBobines() {
    const droit = bobinesDroit(), scope = bobinesScope(), t = today();
    document.body.classList.toggle("no-bobines-gestion", droit !== "gestion");
    const mois = t.slice(0, 7);
    // Filtre boutique (à côté du titre) : il faut choisir une boutique pour voir ses cases.
    const fcur = $("#bb-filtre").value;
    $("#bb-filtre").innerHTML = scope.length > 1
      ? '<option value="">— Choisir une boutique —</option>' + scope.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("")
      : scope.length ? '<option value="' + esc(scope[0].code) + '">' + esc(scope[0].nom) + "</option>" : '<option value="">Aucune boutique</option>';
    $("#bb-filtre").value = scope.some((b) => b.code === fcur) ? fcur : scope.length === 1 ? scope[0].code : "";
    $("#bb-filtre").disabled = scope.length < 2;
    const f = $("#bb-filtre").value;
    if (!f) {
      $("#bb-kpis").innerHTML = "";
      $("#bb-hint").textContent = scope.length ? "Sélectionnez une boutique dans le filtre pour afficher ses bobines." : (droit !== "gestion" ? "Vous n'êtes affecté à aucune boutique. Demandez à l'administrateur." : "Aucune boutique.");
    } else {
      const x = bobinesOf(f);
      const stCls = x.reste <= 0 ? "danger" : x.reste <= BOBINE_SEUIL ? "warn" : "";
      // Une seule case « Utilisation moyenne » : le chiffre s'affiche après avoir choisi jour / semaine / mois.
      const per = { jour: [1, "par jour"], semaine: [7, "par semaine"], mois: [30, "par mois"] };
      const moySel = '<select id="bb-moy-per" class="inline-select" style="margin-left:6px">' +
        '<option value="">— Choisir —</option>' + Object.keys(per).map((k) => '<option value="' + k + '"' + (bobMoyPer === k ? " selected" : "") + ">Moyenne " + per[k][1] + "</option>").join("") + "</select>";
      $("#bb-kpis").innerHTML = kpiHtml([
        ["Utilisation moyenne" + moySel, bobMoyPer ? '<span style="color:#2a78d6">' + moyHtml(x.parJour * per[bobMoyPer][0]) + '</span><span class="sub" style="color:#2a78d6">bobine(s) ' + per[bobMoyPer][1] + "</span>" : '<span class="muted">—</span>', "info"],
        ["Bobines restantes", num(x.reste), stCls],
        ["Statut", bobineStatut(x.reste)],
        ["Autonomie estimée", autonomieHtml(x)],
        ["Dernier approvisionnement", x.appro ? fmtDate(x.appro) : '<span class="muted">Jamais</span>'],
        (() => {
          // Case « Utilisées » : aujourd'hui, cette semaine (depuis lundi) ou ce mois
          const pers = { jour: ["Utilisées ce jour", t], semaine: ["Utilisées cette semaine", mondayOf(t)], mois: ["Utilisées ce mois", mois + "-01"] };
          const sel = '<select id="bb-util-per" class="inline-select" style="margin-left:6px">' +
            Object.keys(pers).map((k) => '<option value="' + k + '"' + (bobUtilPer === k ? " selected" : "") + ">" + pers[k][0] + "</option>").join("") + "</select>";
          const du = pers[bobUtilPer][1];
          const n = db.bobines.filter((m) => m.type === "Utilisation" && m.boutique === f && m.date >= du && m.date <= t).reduce((a, m) => a + m.qte, 0);
          return ["Utilisées" + sel, num(n)];
        })()
      ]);
      $("#bb-hint").textContent = "Moyennes calculées depuis la première utilisation déclarée (semaine = 7 jours, mois = 30 jours). Autonomie = bobines restantes ÷ moyenne par jour. Stock faible : 2 bobines ou moins.";
    }
    // Saisie des bobines utilisées : admin (toutes les boutiques) et CC « saisie » (sa boutique) uniquement.
    // Les CC « Toutes + approvisionnement » consultent et approvisionnent, mais ne saisissent pas l'utilisation.
    const peutSaisir = (isAdmin() || droit === "saisie") && scope.length > 0;
    document.body.classList.toggle("no-bobines-saisie", !peutSaisir);
    if (peutSaisir) {
      const ucur = $("#bu-boutique").value;
      $("#bu-boutique").innerHTML = scope.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      $("#bu-boutique").value = f || (scope.some((b) => b.code === ucur) ? ucur : scope[0].code);
      $("#bu-boutique").disabled = scope.length < 2;
      if (!$("#bu-date").value) $("#bu-date").value = t;
    }
    if (droit === "gestion") {
      const cur = $("#bb-boutique").value;
      $("#bb-boutique").innerHTML = db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      if (f) $("#bb-boutique").value = f;
      else if (db.boutiques.some((b) => b.code === cur)) $("#bb-boutique").value = cur;
      if (!$("#bb-date").value) $("#bb-date").value = t;
    }
    $("#bb-hist-title").textContent = "Historique" + (f ? " — " + boutiqueName(f) : " — toutes les boutiques");
    const hist = db.bobines.filter((x) => scope.some((b) => b.code === x.boutique) && (!f || x.boutique === f))
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    $("#bb-hist").innerHTML = hist.length ? hist.map((x) => {
      // Bobines : le CC peut annuler sa saisie pendant 30 minutes ; ensuite seul l'admin le peut.
      const resteMs = BOBINE_DELAI_MS - (Date.now() - new Date(x.createdAt).getTime());
      const canDel = isAdmin() || (x.createdBy === me.id && resteMs > 0);
      const delBtn = canDel ? '<button class="btn small danger" data-bb-del="' + x.id + '">✕</button>' + (isAdmin() ? "" : '<span class="sub">encore ' + Math.ceil(resteMs / 60000) + " min</span>") : "";
      return "<tr><td>" + fmtDate(x.date) + "</td><td>" + esc(boutiqueName(x.boutique)) + "</td><td>" +
        (x.type === "Approvisionnement" ? '<span class="badge ok">+ Approvisionnement</span>' : '<span class="badge mute">− Bobine utilisée</span>') +
        '</td><td class="num">' + (x.type === "Approvisionnement" ? "+" : "−") + num(x.qte) + "</td><td>" + esc(x.note) + "</td><td>" + esc(x.saisiPar || "—") + (x.cc ? '<span class="sub">' + esc(ccName(x.cc)) + "</span>" : "") +
        "</td><td>" + delBtn + "</td></tr>";
    }).join("") : '<tr><td colspan="7" class="empty">Aucun mouvement de bobines.</td></tr>';
  }
  $("#bb-filtre").addEventListener("change", renderBobines);
  let bobMoyPer = "", bobUtilPer = "mois";
  $("#bb-kpis").addEventListener("change", (e) => {
    if (e.target.id === "bb-moy-per") bobMoyPer = e.target.value;
    else if (e.target.id === "bb-util-per") bobUtilPer = e.target.value;
    else return;
    renderBobines();
  });
  $("#bu-save").addEventListener("click", (e) => {
    const bq = $("#bu-boutique").value, qte = Number($("#bu-qte").value), date = $("#bu-date").value || today();
    if (!bq) return toast("Choisissez la boutique.");
    if (!(qte > 0) || !Number.isInteger(qte)) return toast("Indiquez le nombre de bobines utilisées.");
    if (date > today()) return toast("La date ne peut pas être dans le futur.");
    const reste = bobinesOf(bq).reste;
    if (qte > reste && !confirm("Il ne reste que " + reste + " bobine(s) enregistrée(s) à " + boutiqueName(bq) + ". Enregistrer quand même " + qte + " bobine(s) utilisée(s) ?")) return;
    act(async () => {
      chk(await sb.from("bobines_mvts").insert({ boutique: bq, date, type: "Utilisation", qte, note: $("#bu-note").value.trim(), cc: me.cc || null, saisi_par: me.nom || me.email || "" }));
      $("#bu-qte").value = ""; $("#bu-note").value = "";
    }, qte + " bobine(s) utilisée(s) le " + fmtDate(date) + " (" + boutiqueName(bq) + ").", e.target);
  });
  $("#bb-save").addEventListener("click", (e) => {
    const qte = Number($("#bb-qte").value);
    if (!$("#bb-boutique").value) return toast("Choisissez la boutique.");
    if (!(qte > 0) || !Number.isInteger(qte)) return toast("Indiquez un nombre de bobines valide.");
    const row = { boutique: $("#bb-boutique").value, date: $("#bb-date").value || today(), type: "Approvisionnement", qte, note: $("#bb-note").value.trim(), cc: me.cc || null, saisi_par: me.nom || me.email || "" };
    act(async () => {
      chk(await sb.from("bobines_mvts").insert(row));
      $("#bb-qte").value = ""; $("#bb-note").value = "";
    }, qte + " bobine(s) ajoutée(s) à " + boutiqueName(row.boutique) + ".", e.target);
  });
  $("#bb-hist").addEventListener("click", (e) => {
    const d = e.target.closest("[data-bb-del]");
    if (d && confirm("Supprimer ce mouvement ?")) act(async () => chk(await sb.from("bobines_mvts").delete().eq("id", d.dataset.bbDel)), "Mouvement supprimé.", d);
  });

  // ---------- Crédit télécom (YAS / MOOV) ----------
  // Saisie : admin, ou CC autorisé (ccs.credit) pour sa boutique. Consultation : tous les CC de la boutique.
  function canCreditSaisie() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && c.credit); }
  // Contrôle du crédit restant : seulement les CC cochés « Contrôle Crédit » (ccs.credit) dans RH → Autorisations
  function canCloture() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && c.credit && myBoutiqueCode()); }
  // Déclaration des ventes du frigo : tout CC actif de la boutique (inchangé)
  function canFrigoVente() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && myBoutiqueCode()); }
  // Boutiques qui vendent du crédit (activité déjà enregistrée)
  function boutiquesCredit() { const s = new Set(db.crAchats.map((x) => x.boutique).concat(db.crSoldes.map((x) => x.boutique), db.crVentes.map((x) => x.boutique))); return db.boutiques.filter((b) => s.has(b.code)); }
  // Contrôle du crédit restant fait chaque soir par les CC (règle « hier d'abord » active à partir du 11/11/2026)
  const VENTES_DEBUT = "2026-11-11";
  const venteFaite = (bq, d) => db.crSoldes.some((x) => x.boutique === bq && x.date === d); // contrôle fait ce jour-là
  const venteLe = (bq, op, d) => soldeLe(bq, op, d);
  function hierManquant(bq) {
    const h = addDays(today(), -1);
    const active = db.crSoldes.some((x) => x.boutique === bq && x.date < today()) || db.crAchats.some((x) => x.boutique === bq && x.date < today());
    return !!bq && h >= VENTES_DEBUT && active && !venteFaite(bq, h);
  }
  const SEUIL_RECHARGE = () => db.settings.creditSeuil || 5000;
  function jourLong(d) { return parse(d).toLocaleDateString("fr-FR", { weekday: "long" }) + " " + fmtDate(d); }
  let crOp = "YAS", crTab = (() => { try { return localStorage.getItem("onglet-credit") || "ops"; } catch (e) { return "ops"; } })(), crFiltreInit = false;
  const OPS = ["YAS", "MOOV"];
  const logoOp = (op, sm) => '<img class="logo-op ' + op.toLowerCase() + (sm ? " sm" : "") + '" src="icons/' + op.toLowerCase() + '.png" alt="' + op + '">';
  function premierDuMois(d) { return d.slice(0, 7) + "-01"; }
  function tauxOp(op) { return op === "YAS" ? db.settings.tauxYas : db.settings.tauxMoov; }
  function montantDefaut(op, bq) { const b = boutiqueByCode(bq); return op === "YAS" ? (b ? b.dotYas : 20000) : (b ? b.dotMoov : 10000); }
  // Totaux d'une boutique pour un mois (utilisé aussi par les alertes)
  function creditMois(bq, mois) {
    const a = db.crAchats.filter((x) => x.boutique === bq && x.date.slice(0, 7) === mois);
    const s = (l, f) => l.reduce((t, x) => t + f(x), 0);
    const yas = a.filter((x) => x.op === "YAS"), moov = a.filter((x) => x.op === "MOOV");
    return { nbYas: yas.length, nbMoov: moov.length, achatsYas: s(yas, (x) => x.montant), achatsMoov: s(moov, (x) => x.montant),
      comYas: s(yas, (x) => x.commission), comMoov: s(moov, (x) => x.commission), commission: s(a, (x) => x.commission) };
  }
  // Commission à reverser (toutes périodes) : baisse seulement quand l'admin valide le versement
  function commissionInfo(bq) {
    const s = (l, f) => l.reduce((t, x) => t + f(x), 0);
    const com = db.crAchats.filter((x) => x.boutique === bq), vers = db.crVers.filter((x) => x.boutique === bq);
    const total = s(com, (x) => x.commission), recu = s(vers.filter((v) => v.statut === "Reçue"), (v) => v.montant), attente = s(vers.filter((v) => v.statut !== "Reçue"), (v) => v.montant);
    const avantMois = s(com.filter((x) => x.date < premierDuMois(today())), (x) => x.commission);
    return { total, recu, attente, du: Math.max(0, total - recu), aDeclarer: Math.max(0, total - recu - attente), duAncien: Math.max(0, avantMois - recu - attente) };
  }
  // Clôtures du soir
  function soldeLe(bq, op, d) { const r = db.crSoldes.find((x) => x.boutique === bq && x.op === op && x.date === d); return r ? r.solde : null; }
  // Dernier contrôle = le dernier SAISI (c'est la lecture la plus récente de la puce, même s'il est daté d'hier)
  // Ordre des contrôles : par JOUR d'abord (une correction par l'admin d'un ancien jour ne devient pas « le dernier »), puis par heure de saisie
  const ordreCtrl = (a, b) => a.date.localeCompare(b.date) || String(a.at || a.date).localeCompare(String(b.at || b.date));
  function dernierSolde(bq, op) { return db.crSoldes.filter((x) => x.boutique === bq && x.op === op && x.date <= today()).sort((a, b) => ordreCtrl(b, a))[0] || null; }
  // Une recharge / un ajustement est-il postérieur à un contrôle ? (comparé à l'heure de saisie du contrôle)
  const apresCloture = (x, r) => (r.at && x.createdAt ? new Date(x.createdAt) > new Date(r.at) : x.date > r.date);
  // Ventes de crédit calculées : contrôle précédent + recharges (avec commission) + ajustements − contrôle du jour
  function ventesCredit(bqs) {
    const out = {};
    bqs.forEach((bq) => OPS.forEach((op) => {
      const l = db.crSoldes.filter((x) => x.boutique === bq && x.op === op).sort(ordreCtrl);
      for (let i = 1; i < l.length; i++) {
        const v = l[i - 1].solde + acheteEntre(bq, op, l[i - 1], l[i]) - l[i].solde, k = l[i].date + "|" + bq;
        out[k] = out[k] || { date: l[i].date, bq, YAS: null, MOOV: null };
        out[k][op] = (out[k][op] || 0) + v;
      }
    }));
    return Object.values(out).sort((a, b) => b.date.localeCompare(a.date) || boutiqueName(a.bq).localeCompare(boutiqueName(b.bq)));
  }
  function ventesRows(codes, mois) {
    const l = ventesCredit(codes).filter((x) => x.date.slice(0, 7) === mois);
    const cell = (v) => v == null ? '<span class="muted">—</span>' : v < -1 ? '<b class="neg">' + money0(v) + " ⚠</b>" : money0(v);
    return l.length ? l.map((x) => "<tr><td>" + esc(jourLong(x.date)) + "</td><td>" + esc(boutiqueName(x.bq)) + '</td><td class="num">' + cell(x.YAS) + '</td><td class="num">' + cell(x.MOOV) +
      '</td><td class="num"><b>' + money0((x.YAS || 0) + (x.MOOV || 0)) + "</b></td></tr>").join("")
      : '<tr><td colspan="5" class="empty">Pas encore de vente calculée : il faut au moins deux contrôles successifs.</td></tr>';
  }
  // Une recharge ajoute son montant + la commission sur la puce (ex. : 20 000 + 5 % = 21 000)
  const somme = (l) => l.reduce((a, x) => a + x.montant + (Number(x.commission) || 0), 0);
  function acheteEntre(bq, op, prev, cur) { return somme(db.crAchats.concat(db.crAjust).filter((x) => x.boutique === bq && x.op === op && apresCloture(x, prev) && !apresCloture(x, cur))); }
  // Crédit restant = dernier contrôle (lu sur la puce) + recharges (avec commission) + ajustements admin faits depuis
  function creditRestant(bq, op) {
    const r = dernierSolde(bq, op);
    const rech = db.crAchats.filter((x) => x.boutique === bq && x.op === op && (!r || apresCloture(x, r)));
    const aj = db.crAjust.filter((x) => x.boutique === bq && x.op === op && (!r || apresCloture(x, r)));
    const total = (r ? r.solde : 0) + somme(rech) + somme(aj);
    return { r, base: r ? r.solde : null, ajout: somme(rech), ajust: somme(aj), vendu: 0, nb: rech.length, total, connu: !!r || rech.length > 0 || aj.length > 0 };
  }
  // Anti-fraude : le crédit lu au contrôle ne peut pas dépasser (contrôle précédent + recharges déclarées)
  function anomaliesCredit(bqs, depuis) {
    const out = [];
    bqs.forEach((bq) => OPS.forEach((op) => {
      const l = db.crSoldes.filter((x) => x.boutique === bq && x.op === op).sort(ordreCtrl);
      for (let i = 1; i < l.length; i++) {
        if (l[i].date < depuis) continue;
        const attendu = l[i - 1].solde + acheteEntre(bq, op, l[i - 1], l[i]);
        if (l[i].solde - attendu > 1) out.push({ bq, op, date: l[i].date, ecart: l[i].solde - attendu });
      }
    }));
    return out;
  }
  const ecartTxt = (a) => "+" + money0(a.ecart) + " (recharge non déclarée ?)";
  function quandSolde(r) {
    if (!r) return "aucun contrôle";
    const j = Math.round((parse(today()) - parse(r.date)) / 86400000);
    return j === 0 ? "contrôle de ce soir" : j === 1 ? "contrôle d'hier soir" : "contrôle du " + fmtDate(r.date);
  }
  function creditScope() {
    if (isGlobal()) { const f = $("#cr-boutique").value; return f && f !== "ALL" ? db.boutiques.filter((b) => b.code === f) : db.boutiques; }
    return db.boutiques.filter((b) => b.code === myBoutiqueCode());
  }
  function creditSaisieBq() { return isAdmin() ? ($("#cr-boutique").value !== "ALL" ? $("#cr-boutique").value : "") : myBoutiqueCode(); }

  // Ordre des cadres « boutique » du Crédit télécom : l'admin les déplace par glisser-déposer (échange de places)
  function crOrdre() { const o = ordresBlocs()["credit-cartes"]; return Array.isArray(o) ? o : []; }
  let crDrag = null;
  $("#cr-resume").addEventListener("dragstart", (e) => {
    const c = e.target.closest(".crr-move"); if (!c) return;
    crDrag = c.dataset.crrBq; c.classList.add("crr-drag");
    e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", crDrag); } catch (er) {}
  });
  $("#cr-resume").addEventListener("dragend", () => { crDrag = null; document.querySelectorAll(".crr-drag,.crr-over").forEach((x) => x.classList.remove("crr-drag", "crr-over")); });
  $("#cr-resume").addEventListener("dragover", (e) => {
    const c = e.target.closest(".crr-move"); if (!c || !crDrag) return;
    e.preventDefault();
    document.querySelectorAll(".crr-over").forEach((x) => x !== c && x.classList.remove("crr-over"));
    if (c.dataset.crrBq !== crDrag) c.classList.add("crr-over");
  });
  $("#cr-resume").addEventListener("drop", (e) => {
    const c = e.target.closest(".crr-move"); if (!c || !crDrag) return;
    e.preventDefault();
    const cible = c.dataset.crrBq; if (cible === crDrag) return;
    const codes = [...$("#cr-resume").querySelectorAll("[data-crr-bq]")].map((x) => x.dataset.crrBq);
    const i = codes.indexOf(crDrag), j = codes.indexOf(cible);
    [codes[i], codes[j]] = [codes[j], codes[i]];
    const reste = crOrdre().filter((x) => !codes.includes(x));
    enregistrerOrdre("credit-cartes", codes.concat(reste));
    crDrag = null;
    renderCredit();
    toast("Cadres échangés : " + boutiqueName(codes[j]) + " ⇄ " + boutiqueName(codes[i]) + ".");
  });

  function renderCredit() {
    const glob = isGlobal(), admin = isAdmin(), t = today();
    const bcur = $("#cr-boutique").value || "ALL";
    if (glob) {
      $("#cr-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      $("#cr-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
      $("#cr-boutique").disabled = false;
    } else {
      const mb = myBoutiqueCode();
      $("#cr-boutique").innerHTML = mb ? '<option value="' + esc(mb) + '">' + esc(boutiqueName(mb)) + "</option>" : '<option value="">Aucune boutique</option>';
      $("#cr-boutique").disabled = true;
    }
    if (!$("#cr-mois").value) $("#cr-mois").value = t.slice(0, 7);
    // CC « toutes boutiques » (non admin) : sa boutique en entier ; pour les AUTRES boutiques, seulement
    // le crédit restant et la commission à reverser (pas de recharges, contrôles, ventes ni historique)
    const myBq = myBoutiqueCode();
    if (glob && !admin && myBq && !crFiltreInit) { crFiltreInit = true; $("#cr-boutique").value = myBq; }
    const restreint = glob && !admin && !(myBq && $("#cr-boutique").value === myBq);
    $("#view-credit").classList.toggle("cr-restreint", restreint);
    if (restreint) crTab = "ops";
    // Écran principal : toujours le mois en cours ; le Récap permet de choisir un autre mois
    const mois = t.slice(0, 7), scope = creditScope(), codes = scope.map((b) => b.code);
    $("#cr-titre").textContent = "Opérations de " + fmtMonth(mois + "-01");
    document.querySelectorAll("#cr-tabs [data-cr-tab]").forEach((b) => b.classList.toggle("active", b.dataset.crTab === crTab));
    $("#cr-main").classList.toggle("hidden", crTab !== "ops");
    $("#cr-recap").classList.toggle("hidden", crTab !== "recap");
    if (crTab === "recap") renderRecapCredit(scope);

    // Alertes anti-fraude (admin / toutes boutiques) : recharges non déclarées des 30 derniers jours
    const anom = glob ? anomaliesCredit(codes, addDays(t, -30)) : [];
    $("#cr-alertes").innerHTML = anom.length ? '<div class="v-alert danger"><b>⚠ Écart au contrôle du crédit</b> — le crédit lu sur la puce ne correspond pas au crédit attendu (recharges − ventes déclarées) :<ul style="margin:6px 0 0 18px;padding:0">' +
      anom.slice(0, 8).map((a) => "<li>" + esc(boutiqueName(a.bq)) + " · " + a.op + " · " + fmtDate(a.date) + " : <b>" + ecartTxt(a) + "</b></li>").join("") + "</ul></div>" : "";

    // Une boutique : une carte par réseau ; plusieurs : tableau
    const une = scope.length === 1 && !restreint;
    $("#cr-table-card").classList.toggle("hidden", une || !scope.length);
    if (une) {
      const bq = scope[0].code, m = creditMois(bq, mois);
      $("#cr-cards").innerHTML = OPS.map((op) => {
        const cr = creditRestant(bq, op), nb = op === "YAS" ? m.nbYas : m.nbMoov, com = op === "YAS" ? m.comYas : m.comMoov;
        const detail = (hierManquant(bq) ? '<span class="neg">contrôle d\'hier non fait</span>' : cr.r ? quandSolde(cr.r) + " : " + money0(cr.base) : (cr.ajust || cr.nb ? "pas encore de contrôle" : "aucun contrôle")) +
          (cr.ajust ? (cr.ajust > 0 ? " + " : " − ") + money0(Math.abs(cr.ajust)) + " d'ajustement" : "") +
          (cr.nb ? " + " + money0(cr.ajout) + " rechargés (commission comprise)" : "");
        // Vente d'hier (calculée : contrôle d'avant-hier + recharges − contrôle d'hier), affichée à droite du logo
        // Vente du jour si le contrôle de ce soir est fait, sinon vente d'hier
        const hierD = addDays(t, -1), vc = ventesCredit([bq]);
        const vj = vc.find((x) => x.date === t && x[op] != null), vh = vc.find((x) => x.date === hierD && x[op] != null);
        const vx = vj || vh, dx = vj ? t : hierD, libV = vj ? "Vente du jour" : "Vente d'hier";
        const venteTxt = "";
        const venteBox = '<div class="op-vente"><span>📈 ' + libV + "</span><b" + (vx && vx[op] < -1 ? ' class="neg"' : "") + ">" + (vx ? money0(vx[op]) : "—") + "</b><small>" +
          (vx ? esc(jourLong(dx)) : "pas encore calculée (il faut deux contrôles successifs)") + "</small></div>";
        return '<div class="op-card ' + op.toLowerCase() + '"><div class="op-head">' + logoOp(op) + venteBox + "</div>" +
          '<div class="op-main"><span>Crédit restant</span><b>' + (cr.connu ? money0(cr.total) : "—") + "</b><small>" + detail + venteTxt + "</small></div>" +
          '<div class="op-stats"><div><b>' + nb + "</b><span>recharge" + (nb > 1 ? "s" : "") + " ce mois</span></div>" +
          "<div><b>" + money0(com) + "</b><span>commission du mois</span></div></div></div>";
      }).join("");
    } else {
      $("#cr-cards").innerHTML = "";
      // Vue résumée : une carte par boutique (logo + crédit restant de chaque opérateur, commission à reverser)
      // Tous les profils : grille de 3 colonnes ; « recharges du mois » et « contrôle du jour » sauf en vue restreinte
      const ordre = crOrdre(), rang = (c) => { const i = ordre.indexOf(c); return i < 0 ? 999 : i; };
      $("#cr-resume").innerHTML = scope.slice().sort((a, b) => rang(a.code) - rang(b.code)).map((b) => {
        const ci = commissionInfo(b.code), m = creditMois(b.code, mois);
        const etat = venteFaite(b.code, t) ? '<span class="badge ok">✓ contrôle fait</span>' : hierManquant(b.code) ? '<span class="badge warn">⚠ hier manquant</span>' : '<span class="badge">contrôle : pas encore</span>';
        return '<div class="crr-card cliquable' + (isAdmin() ? " crr-move" : "") + '" data-crr-bq="' + esc(b.code) + '" data-go-filtre="#cr-boutique" data-go-bq="' + esc(b.code) + '"' + (isAdmin() ? ' draggable="true" title="Glissez ce cadre sur un autre pour échanger leurs places"' : "") + '><div class="crr-nom">' + esc(b.nom) + (restreint ? "" : " " + etat) + "</div>" +
          OPS.map((op) => { const cr = creditRestant(b.code, op), nb = op === "YAS" ? m.nbYas : m.nbMoov;
            return '<div class="crr-op ' + op.toLowerCase() + '">' + logoOp(op) + '<div><span>Crédit restant</span><b>' + (cr.connu ? money0(cr.total) : "—") + "</b>" +
              (restreint ? "" : "<small>" + nb + " recharge" + (nb > 1 ? "s" : "") + " ce mois</small>") + "</div></div>"; }).join("") +
          '<div class="crr-com' + (ci.du > 0 ? " due" : "") + '"><span>💰 Commission à reverser</span><b>' + money0(ci.du || 0) + "</b></div></div>";
      }).join("");
      $("#cr-table").innerHTML = scope.map((b) => {
        const cy = creditRestant(b.code, "YAS"), cm = creditRestant(b.code, "MOOV"), m = creditMois(b.code, mois), ci = commissionInfo(b.code);
        const etat = venteFaite(b.code, t) ? '<span class="badge ok">✓ fait</span>' : hierManquant(b.code) ? '<span class="badge warn">⚠ hier manquant</span>' : '<span class="badge">pas encore</span>';
        return '<tr class="cliquable" data-go-filtre="#cr-boutique" data-go-bq="' + esc(b.code) + '" title="Ouvrir ' + esc(b.nom) + '"><td><b>' + esc(b.nom) + '</b></td><td class="num">' + (cy.connu ? money0(cy.total) : "—") + '</td><td class="num">' + (cm.connu ? money0(cm.total) : "—") +
          '</td><td class="num cr-det">' + logoOp("YAS", true) + " " + m.nbYas + " &nbsp; " + logoOp("MOOV", true) + " " + m.nbMoov +
          '</td><td class="num">' + (ci.du > 0 ? "<b>" + money0(ci.du) + "</b>" : '<span class="pos">0</span>') + '</td><td class="cr-det">' + etat + "</td></tr>";
      }).join("");
    }

    // Commission à reverser
    const ci = codes.reduce((a, c) => { const x = commissionInfo(c); Object.keys(x).forEach((k) => { a[k] = (a[k] || 0) + x[k]; }); return a; }, {});
    const mAll = codes.reduce((a, c) => { const x = creditMois(c, mois); a.y += x.comYas; a.m += x.comMoov; return a; }, { y: 0, m: 0 });
    $("#cv-solde").innerHTML = '<div class="com-big ' + (ci.du > 0 ? "due" : "ok") + '"><span>Solde à reverser</span><b>' + money0(ci.du || 0) + "</b></div>" +
      (ci.attente ? '<div class="info-row"><span>dont versé, en attente de validation</span><span>' + money0(ci.attente) + "</span></div>" : "") +
      '<div class="info-row"><span>' + logoOp("YAS", true) + " commission de " + esc(fmtMonth(mois + "-01")) + "</span><b>" + money0(mAll.y) + "</b></div>" +
      '<div class="info-row"><span>' + logoOp("MOOV", true) + " commission de " + esc(fmtMonth(mois + "-01")) + "</span><b>" + money0(mAll.m) + "</b></div>";
    // CC : statut de ses versements (⏳ en attente → ✓ validé par EDWIGE ou l'admin)
    if (!isAdmin() && me && me.cc) {
      const mes = db.crVers.filter((v) => v.cc === String(me.cc)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
      if (mes.length) $("#cv-solde").innerHTML += '<h3 class="sub-title" style="margin:12px 0 4px">Mes versements</h3>' + mes.map((v) =>
        '<div class="info-row"><span>' + (v.createdAt ? new Date(v.createdAt).toLocaleDateString("fr-FR") : "—") + " · <b>" + money0(v.montant) + "</b> (" + esc(v.mode || "") + ")</span><span>" +
        (v.statut === "Reçue" ? '<span class="badge ok">✓ Validé' + (v.recuPar ? " par " + esc(v.recuPar) : "") + "</span>" : '<span class="badge warn">⏳ En attente de validation</span>') + "</span></div>").join("");
    }
    const sbq = creditSaisieBq(), ouvert = versementOuvert();
    const reste = resteAVerser(sbq);
    if (document.activeElement !== $("#cv-montant")) $("#cv-montant").value = reste > 0 ? reste : "";
    $("#cv-save").disabled = !sbq || reste <= 0 || !ouvert;
    $("#cv-form").classList.toggle("hidden", !ouvert);
    $("#cv-ferme").classList.toggle("hidden", ouvert || !canCreditSaisie());
    $("#cv-ferme").innerHTML = ouvert ? "" : "🔒 Le reversement de la commission se fait uniquement <b>le 1er et le 2 de chaque mois</b> (commission du mois écoulé). Prochaine ouverture : <b>" + fmtDate(premierDuMois(addDays(premierDuMois(t), 32))) + "</b>.";

    // Recharge : montant proposé automatiquement (dotation du réseau)
    document.querySelectorAll("#cr-op [data-op]").forEach((b) => b.classList.toggle("active", b.dataset.op === crOp));
    if (document.activeElement !== $("#cr-montant") && !$("#cr-montant").dataset.touche) $("#cr-montant").value = montantDefaut(crOp, sbq);
    majPreviewCredit(sbq);

    // Contrôle du crédit restant (lu sur la puce) : chaque soir ; l'oubli d'hier d'abord ; une seule fois par jour
    // L'admin peut choisir le jour (ex. : contrôle d'hier, ou crédit restant de départ d'une boutique)
    if (admin && !$("#cs-date").value) $("#cs-date").value = venteCible(sbq);
    $("#cs-date").max = t;
    if (admin && sbq) {
      const d = venteJourChoisi(sbq), faitD = venteFaite(sbq, d);
      $("#cs-titre").innerHTML = (faitD ? "✅" : "🔍") + " Contrôle du crédit restant " + (d === t ? "ce " : "le ") + esc(jourLong(d)) + ' <span class="badge">admin</span>';
      $("#cs-form").classList.remove("hidden");
      $("#cs-save").disabled = false;
      $("#cs-save").textContent = (faitD ? "Corriger le contrôle du " : "Enregistrer le contrôle du ") + fmtDate(d);
      $("#cs-card").classList.toggle("a-faire", false); $("#cs-card").classList.toggle("fait", faitD);
      $("#cs-info").innerHTML = (faitD ? "Déjà fait pour ce jour : " + OPS.map((op) => logoOp(op, true) + " <b>" + money0(venteLe(sbq, op, d) || 0) + "</b>").join(" &nbsp; ") + " — vous pouvez le corriger. "
        : "Indiquez le crédit restant lu sur chaque puce. ") + "Pour une boutique qui démarre, saisissez ici son crédit restant avant la première recharge.";
    }
    const cj = venteCible(sbq), oubli = cj !== t, faitAuj = !!sbq && venteFaite(sbq, t);
    if (!(admin && sbq)) {
    $("#cs-save").textContent = "Enregistrer le contrôle";
    $("#cs-titre").innerHTML = !sbq ? "🔍 Contrôle du crédit restant" : faitAuj ? "✅ Contrôle du crédit restant ce " + esc(jourLong(t)) : "🔍 Contrôle du crédit restant " + (oubli ? "hier, " : "ce ") + esc(jourLong(cj)) + (oubli ? ' <span class="badge warn">oubli à rattraper</span>' : "");
    $("#cs-form").classList.toggle("hidden", !sbq || faitAuj);
    if (faitAuj) { $("#cs-yas").value = ""; $("#cs-moov").value = ""; }
    $("#cs-save").disabled = !sbq;
    $("#cs-card").classList.toggle("a-faire", !!sbq && (oubli || !faitAuj && new Date().getHours() >= 15));
    $("#cs-card").classList.toggle("fait", faitAuj);
    if (faitAuj) { const ici = $("#cs-ici"); if (ici) ici.remove(); }
    $("#cs-info").innerHTML = !sbq ? (isAdmin() ? "Choisissez une boutique dans le filtre pour enregistrer son contrôle." : "")
      : faitAuj ? "Contrôle fait : " + OPS.map((op) => logoOp(op, true) + " <b>" + money0(venteLe(sbq, op, t) || 0) + "</b>").join(" &nbsp; ") + ". Pour une correction, voyez l'administrateur."
      : oubli ? '<b class="neg">Le contrôle d\'hier n\'a pas été fait.</b> Faites-le d\'abord : sans cela, le contrôle d\'aujourd\'hui et les nouvelles recharges sont bloqués.'
      : "⏰ <b>À faire chaque soir</b> : lisez le crédit restant sur chaque puce YAS et MOOV et notez-le ici.";
    }

    // Historique du mois
    const achats = db.crAchats.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    $("#cr-rows").innerHTML = achats.length ? achats.map((x) => "<tr><td>" + fmtDate(x.date) + "</td><td>" + heureDe(x.createdAt) + "</td><td>" + esc(boutiqueName(x.boutique)) + "</td><td>" + logoOp(x.op, true) +
      '</td><td class="num">' + money0(x.montant) + '</td><td class="num pos">+' + money0(x.commission) + "</td><td>" + esc(x.saisiPar || "—") +
      "</td><td>" + (admin ? '<button class="btn small danger" data-cr-del="' + x.id + '">✕</button>' : "") + "</td></tr>").join("")
      : '<tr><td colspan="8" class="empty">Aucune recharge ce mois-ci.</td></tr>';
    $("#cvt-rows").innerHTML = controlesRows(codes, mois, admin);
    $("#cvc-rows").innerHTML = ventesRows(codes, mois);
    const ajs = db.crAjust.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    $("#aj-rows").innerHTML = ajs.length ? ajs.map((x) => "<tr><td>" + fmtDate(x.date) + "</td><td>" + heureDe(x.createdAt) + "</td><td>" + esc(boutiqueName(x.boutique)) + "</td><td>" + logoOp(x.op, true) + '</td><td class="num"><b class="' + (x.montant >= 0 ? "pos" : "neg") + '">' +
      (x.montant > 0 ? "+" : "−") + money0(Math.abs(x.montant)) + "</b></td><td>" + esc(x.note || "—") + "</td><td>" + esc(x.saisiPar || "—") + "</td><td>" +
      (admin ? '<button class="btn small danger" data-aj-del="' + x.id + '">✕</button>' : "") + "</td></tr>").join("") : '<tr><td colspan="8" class="empty">Aucun ajustement ce mois-ci.</td></tr>';
    if (admin) {
      $("#aj-save").disabled = !sbq;
      $("#aj-info").innerHTML = sbq ? "Crédit restant actuel de <b>" + esc(boutiqueName(sbq)) + "</b> : " + OPS.map((op) => logoOp(op, true) + " <b>" + money0(creditRestant(sbq, op).total) + "</b>").join(" &nbsp; ") +
        ". Le montant saisi s'ajoute au crédit restant (signe − pour retirer). Il ne compte ni comme recharge ni comme commission." : "Choisissez une boutique dans le filtre pour ajuster son crédit.";
    }
    const versTous = db.crVers.filter((v) => codes.includes(v.boutique));
    const totRecu = versTous.filter((v) => v.statut === "Reçue").reduce((a, v) => a + v.montant, 0), totAtt = versTous.filter((v) => v.statut !== "Reçue").reduce((a, v) => a + v.montant, 0);
    $("#cv-total").innerHTML = '<span>✅ Total déjà reversé (validé par l\'admin) : <b class="pos">' + money0(totRecu) + "</b></span>" + (totAtt ? '<span>⏳ En attente de validation : <b>' + money0(totAtt) + "</b></span>" : "");
    const vers = versTous.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
    $("#cv-rows").innerHTML = vers.length ? vers.map((v) => {
      const canDel = admin || (v.createdBy === me.id && v.statut === "Déclarée" && Date.now() - new Date(v.createdAt).getTime() < EDIT_WINDOW_MS);
      return "<tr><td>" + new Date(v.createdAt).toLocaleDateString("fr-FR") + "</td><td>" + heureDe(v.createdAt) + "</td><td>" + esc(boutiqueName(v.boutique)) + "</td><td>" + (v.cc ? esc(ccName(v.cc)) : "Admin") +
        '</td><td class="num"><b>' + money0(v.montant) + "</b></td><td>" + esc(v.mode) + "</td><td>" +
        (v.statut === "Reçue" ? '<span class="badge ok">✓ Reçu par l\'admin</span>' : '<span class="badge warn">⏳ En attente</span>') + "</td><td>" +
        (admin ? '<button class="btn small' + (v.statut === "Reçue" ? "" : " success") + '" data-cv-recu="' + v.id + '" data-v="' + (v.statut === "Reçue" ? "0" : "1") + '">' + (v.statut === "Reçue" ? "Annuler" : "✓ Argent reçu") + "</button> " : "") +
        (canDel ? '<button class="btn small danger" data-cv-del="' + v.id + '">✕</button>' : "") + "</td></tr>";
    }).join("") : '<tr><td colspan="8" class="empty">Aucun versement.</td></tr>';

    // Réglages (admin)
    if (admin) {
      $("#cr-bilan").innerHTML = db.boutiques.map((b) => "<tr><td><b>" + esc(b.nom) + "</b></td>" +
        '<td><input type="number" class="inline-input dot-input" data-dot-yas="' + esc(b.code) + '" value="' + b.dotYas + '"></td>' +
        '<td><input type="number" class="inline-input dot-input" data-dot-moov="' + esc(b.code) + '" value="' + b.dotMoov + '"></td>' +
        '<td class="num">' + delaiHtml(delaiRecharge(b.code, "YAS")) + '</td><td class="num">' + delaiHtml(delaiRecharge(b.code, "MOOV")) + "</td></tr>").join("");
      if (document.activeElement !== $("#cr-set-yas")) $("#cr-set-yas").value = db.settings.tauxYas;
      if (document.activeElement !== $("#cr-set-moov")) $("#cr-set-moov").value = db.settings.tauxMoov;
    }
  }
  // Contrôles du crédit restant d'un mois (une ligne par jour et par boutique)
  function controlesRows(codes, mois, admin) {
    const g = {};
    db.crSoldes.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois).forEach((x) => {
      const k = x.date + "|" + x.boutique; g[k] = g[k] || { date: x.date, bq: x.boutique, par: x.saisiPar, at: "" }; g[k][x.op] = x.solde;
      if (x.at && String(x.at) > g[k].at) g[k].at = String(x.at); // heure de la saisie (la plus récente)
    });
    const l = Object.values(g).sort((a, b) => b.date.localeCompare(a.date) || boutiqueName(a.bq).localeCompare(boutiqueName(b.bq)));
    return l.length ? l.map((j) => "<tr><td>" + esc(jourLong(j.date)) + "</td><td>" + heureDe(j.at) + "</td><td>" + esc(boutiqueName(j.bq)) + '</td><td class="num">' + (j.YAS != null ? money0(j.YAS) : "—") +
      '</td><td class="num">' + (j.MOOV != null ? money0(j.MOOV) : "—") + "</td><td>" + esc(j.par || "—") + "</td><td>" +
      (admin ? '<button class="btn small danger" data-cvt-del="1" data-bq="' + esc(j.bq) + '" data-d="' + j.date + '">✕</button>' : "") + "</td></tr>").join("")
      : '<tr><td colspan="7" class="empty">Aucun contrôle ce mois-ci.</td></tr>';
  }
  // Heure de saisie (hh:mm) d'un horodatage ; « — » si inconnue
  function heureDe(ts) { return ts ? new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—"; }
  // Jour à déclarer : hier s'il manque (oubli), sinon aujourd'hui
  function venteCible(bq) { return hierManquant(bq) ? addDays(today(), -1) : today(); }
  // Jour choisi : l'admin peut prendre n'importe quel jour passé ; un CC suit la règle (hier d'abord)
  function venteJourChoisi(bq) { return isAdmin() && $("#cs-date").value ? $("#cs-date").value : venteCible(bq); }
  // Récap d'un mois : crédits achetés YAS / MOOV, commission générée, historiques
  function renderRecapCredit(scope) {
    const mois = $("#cr-mois").value || today().slice(0, 7), codes = scope.map((b) => b.code), s = (l, f) => l.reduce((a, x) => a + f(x), 0);
    const nomMois = fmtMonth(mois + "-01");
    $("#rc-titre").textContent = "Récap des opérations — " + nomMois;
    $("#rc-sous").textContent = (scope.length === 1 ? scope[0].nom : scope.length === db.boutiques.length ? "Toutes les boutiques" : scope.length + " boutiques") + " · édité le " + fmtDate(today());
    const ach = db.crAchats.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois);
    const yas = ach.filter((x) => x.op === "YAS"), moov = ach.filter((x) => x.op === "MOOV");
    const vers = db.crVers.filter((v) => codes.includes(v.boutique) && String(v.createdAt || v.mois).slice(0, 7) === mois);
    const versRecu = s(vers.filter((v) => v.statut === "Reçue"), (v) => v.montant);
    const k = (label, val, sub, cls) => '<div class="kpi ' + (cls || "") + '"><div class="label">' + label + '</div><div class="value">' + val + (sub ? "<small>" + sub + "</small>" : "") + "</div></div>";
    $("#rc-kpis").innerHTML =
      k(logoOp("YAS", true) + "Crédit YAS acheté", money0(s(yas, (x) => x.montant)), yas.length + " recharge" + (yas.length > 1 ? "s" : "")) +
      k(logoOp("MOOV", true) + "Crédit MOOV acheté", money0(s(moov, (x) => x.montant)), moov.length + " recharge" + (moov.length > 1 ? "s" : "")) +
      k("Total crédit acheté", money0(s(ach, (x) => x.montant)), ach.length + " recharge" + (ach.length > 1 ? "s" : "") + " au total") +
      (() => { const vm = ventesCredit(codes).filter((x) => x.date.slice(0, 7) === mois), sy = vm.reduce((a, x) => a + (x.YAS || 0), 0), sm = vm.reduce((a, x) => a + (x.MOOV || 0), 0);
        return k("📈 Crédit vendu (calculé)", money0(sy + sm), "YAS " + money0(sy) + " · MOOV " + money0(sm)); })() +
      k("Commission générée", money0(s(ach, (x) => x.commission)), "YAS " + money0(s(yas, (x) => x.commission)) + " · MOOV " + money0(s(moov, (x) => x.commission)), "hero") +
      k("Commission reversée (validée)", money0(versRecu), vers.length ? vers.length + " versement" + (vers.length > 1 ? "s" : "") + " déclaré" + (vers.length > 1 ? "s" : "") + " ce mois" : "aucun versement ce mois");
    // Par boutique (si plusieurs)
    $("#rc-bq-card").classList.toggle("hidden", scope.length < 2);
    if (scope.length > 1) {
      $("#rc-bq").innerHTML = scope.map((b) => {
        const a = ach.filter((x) => x.boutique === b.code), y = a.filter((x) => x.op === "YAS"), m = a.filter((x) => x.op === "MOOV");
        return "<tr><td><b>" + esc(b.nom) + '</b></td><td class="num">' + y.length + '</td><td class="num">' + money0(s(y, (x) => x.montant)) + '</td><td class="num">' + m.length +
          '</td><td class="num">' + money0(s(m, (x) => x.montant)) + '</td><td class="num pos"><b>' + money0(s(a, (x) => x.commission)) + "</b></td></tr>";
      }).join("") + '<tr class="total-row"><td><b>Total</b></td><td class="num"><b>' + yas.length + '</b></td><td class="num"><b>' + money0(s(yas, (x) => x.montant)) + '</b></td><td class="num"><b>' + moov.length +
        '</b></td><td class="num"><b>' + money0(s(moov, (x) => x.montant)) + '</b></td><td class="num pos"><b>' + money0(s(ach, (x) => x.commission)) + "</b></td></tr>";
    }
    const heure = (d) => d ? new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
    $("#rc-rech").innerHTML = ach.length ? ach.slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt))).map((x) =>
      "<tr><td>" + fmtDate(x.date) + "</td><td>" + heure(x.createdAt) + "</td><td>" + esc(boutiqueName(x.boutique)) + "</td><td>" + logoOp(x.op, true) + '</td><td class="num">' + money0(x.montant) +
      '</td><td class="num pos">+' + money0(x.commission) + "</td><td>" + esc(x.saisiPar || "—") + "</td></tr>").join("")
      : '<tr><td colspan="7" class="empty">Aucune recharge en ' + esc(nomMois) + ".</td></tr>";
    // Contrôles du crédit restant chaque jour (une ligne par jour et par boutique)
    $("#rc-clot").innerHTML = controlesRows(codes, mois, false).replace(/<td><\/td><\/tr>/g, "</tr>");
    $("#rc-ventes").innerHTML = ventesRows(codes, mois);
    $("#rc-vers").innerHTML = vers.length ? vers.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((v) =>
      "<tr><td>" + new Date(v.createdAt).toLocaleDateString("fr-FR") + "</td><td>" + heureDe(v.createdAt) + "</td><td>" + esc(boutiqueName(v.boutique)) + "</td><td>" + (v.cc ? esc(ccName(v.cc)) : "Admin") +
      '</td><td class="num"><b>' + money0(v.montant) + "</b></td><td>" + esc(v.mode) + "</td><td>" +
      (v.statut === "Reçue" ? '<span class="badge ok">✓ Reçu</span>' : '<span class="badge warn">⏳ En attente</span>') + "</td></tr>").join("")
      : '<tr><td colspan="7" class="empty">Aucun versement en ' + esc(nomMois) + ".</td></tr>";
  }
  // Reversement de commission : ouvert le 1er et le 2 du mois, ou à tout moment pour un CC autorisé par l'admin
  // Gestionnaire des commissions (ex. EDWIGE) : tableau de bord des commissions, demande de versement, confirmation de réception
  function canGererCom() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && c.gereCom); }
  // Demande de versement lancée ce mois-ci par le gestionnaire : ouvre le reversement à tout moment du mois
  function demandeActive() { const m = today().slice(0, 7); return db.crDemandes.filter((d) => String(d.createdAt).slice(0, 7) === m).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null; }
  // Commission que la boutique doit encore verser (notification) : automatiquement à partir du 1er pour les mois passés,
  // et tout ce qui reste quand une demande est active. Déjà déclarée = plus de notification.
  function comARelancer(bq) { const c = commissionInfo(bq); return c.duAncien > 0 ? c.duAncien + (demandeActive() ? Math.max(0, c.aDeclarer - c.duAncien) : 0) : demandeActive() ? c.aDeclarer : 0; }
  // Reversement ouvert le 1er et le 2 du mois, ou sur demande du gestionnaire des commissions
  function versementOuvert() { return Number(today().slice(8, 10)) <= 2 || !!demandeActive(); }
  // Montant proposé : commission des mois écoulés pour un CC (tout ce qui reste si une demande est active), tout ce qui reste pour l'admin
  function resteAVerser(bq) { if (!bq) return 0; const c = commissionInfo(bq); return isAdmin() || demandeActive() ? c.aDeclarer : c.duAncien; }
  function majPreviewCredit(bq) {
    const m = Number($("#cr-montant").value) || 0;
    $("#cr-preview").innerHTML = !bq ? (isAdmin() ? "Choisissez une boutique dans le filtre pour enregistrer une recharge." : "Vous n'êtes affecté à aucune boutique.")
      : "Commission " + crOp + " : <b class=\"pos\">+" + money0(Math.round(m * tauxOp(crOp) / 100)) + "</b> (" + num(tauxOp(crOp)) + " %)";
    $("#cr-save").disabled = !bq;
    if (!bq) return;
    const cr = creditRestant(bq, crOp), apres = cr.total + m + Math.round(m * tauxOp(crOp) / 100);
    if (m > 0) $("#cr-preview").innerHTML += " · crédit restant après la recharge : <b>" + money0(apres) + "</b>";
    const bloc = rechargeBloquee(bq, crOp);
    if (bloc && !isAdmin()) { $("#cr-preview").innerHTML = '<b class="neg">🔒 Recharge bloquée</b> : ' + bloc; $("#cr-save").disabled = true; }
    else if (bloc) $("#cr-preview").innerHTML += '<br><span class="neg">⚠ Pour un CC, la recharge serait bloquée : ' + bloc + "</span>";
  }
  // Raison du blocage d'une recharge (null si possible) : contrôle d'hier manquant, ou il reste encore ≥ 5 000 sur la puce
  function rechargeBloquee(bq, op) {
    if (hierManquant(bq)) return "faites d'abord le contrôle du crédit restant d'hier (carte « Contrôle du crédit restant » ci-dessus).";
    const cr = creditRestant(bq, op);
    if (cr.total >= SEUIL_RECHARGE()) return "il reste encore <b>" + money0(cr.total) + "</b> de crédit " + op + " sur la puce. La recharge est possible quand il reste moins de " + money0(SEUIL_RECHARGE()) + ".";
    return null;
  }
  // Nombre moyen de jours entre deux recharges (90 derniers jours)
  function delaiRecharge(bq, op) {
    const depuis = addDays(today(), -90), ecarts = [];
    const jours = Array.from(new Set(db.crAchats.filter((x) => x.boutique === bq && x.op === op && x.date >= depuis).map((x) => x.date))).sort();
    for (let i = 1; i < jours.length; i++) ecarts.push(Math.round((parse(jours[i]) - parse(jours[i - 1])) / 86400000));
    return ecarts.length ? ecarts.reduce((a, n) => a + n, 0) / ecarts.length : null;
  }
  function delaiHtml(j) { return j == null ? '<span class="muted">—</span>' : "<b>" + j.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + "</b> j"; }

  ["#cr-boutique", "#cr-mois"].forEach((id) => $(id).addEventListener("change", () => { $("#cr-montant").dataset.touche = ""; renderCredit(); }));
  $("#cr-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cr-tab]"); if (!b) return;
    crTab = b.dataset.crTab; try { localStorage.setItem("onglet-credit", crTab); } catch (e) {} renderCredit(); window.scrollTo({ top: 0 });
  });
  $("#rc-print").addEventListener("click", () => {
    document.body.classList.add("print-recap");
    window.addEventListener("afterprint", () => document.body.classList.remove("print-recap"), { once: true });
    window.print();
  });
  $("#cr-op").addEventListener("click", (e) => {
    const b = e.target.closest("[data-op]"); if (!b) return;
    crOp = b.dataset.op;
    document.querySelectorAll("#cr-op [data-op]").forEach((x) => x.classList.toggle("active", x === b));
    $("#cr-montant").value = montantDefaut(crOp, creditSaisieBq()); $("#cr-montant").dataset.touche = "";
    majPreviewCredit(creditSaisieBq());
  });
  $("#cr-montant").addEventListener("input", () => { $("#cr-montant").dataset.touche = "1"; majPreviewCredit(creditSaisieBq()); });
  $("#cr-save").addEventListener("click", (e) => {
    const bq = creditSaisieBq(), montant = Number($("#cr-montant").value), op = crOp, btn = e.target;
    if (!bq) return toast("Choisissez une boutique.");
    if (!(montant > 0)) return toast("Indiquez le montant de la recharge.");
    const bloc = rechargeBloquee(bq, op);
    if (bloc && !isAdmin()) return toast("Recharge bloquée : " + bloc.replace(/<[^>]+>/g, ""));
    // Avertissement : la recharge n'est enregistrée (et n'apparaît dans l'historique) que si le CC répond Oui
    const dlg = $("#crconf-dialog");
    $("#crconf-titre").textContent = "Confirmer la recharge";
    $("#crconf-oui").textContent = "Oui, recharger";
    $("#crconf-logo").innerHTML = logoOp(op);
    $("#crconf-montant").textContent = money0(montant);
    const com = Math.round(montant * tauxOp(op) / 100), crAv = creditRestant(bq, op).total;
    $("#crconf-text").innerHTML = "Vous êtes sur le point d'enregistrer une recharge <b>" + op + "</b> de <b>" + money0(montant) + "</b> pour <b>" + esc(boutiqueName(bq)) +
      "</b>.<br>Crédit sur la puce : " + money0(crAv) + " + " + money0(montant) + " + commission " + money0(com) + " = <b>" + money0(crAv + montant + com) + "</b>.<br>Voulez-vous vraiment faire cette recharge ?";
    dlg.returnValue = "";
    dlg.onclose = () => {
      if (dlg.returnValue !== "oui") return toast("Recharge annulée : rien n'a été enregistré.");
      const ref = "AUTO-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
      const row = { boutique: bq, cc: isAdmin() ? null : me.cc, date: today(), operateur: op, montant, reference: ref, saisi_par: me.nom || me.email || "" };
      act(async () => {
        chk(await sb.from("credit_achats").insert(row));
        $("#cr-montant").dataset.touche = "";
      }, "Recharge " + op + " de " + money0(montant) + " enregistrée : commission +" + money0(Math.round(montant * tauxOp(op) / 100)) + ".", btn);
    };
    dlg.showModal();
  });
  $("#cv-save").addEventListener("click", (e) => {
    const bq = creditSaisieBq(), montant = Number($("#cv-montant").value);
    if (!canCreditSaisie()) return toast("Vous n'êtes pas autorisé à reverser la commission (case « Contrôle Crédit » dans RH → Autorisations).");
    if (!bq) return toast("Choisissez une boutique.");
    if (!(montant > 0)) return toast("Indiquez le montant versé.");
    if (!versementOuvert()) return toast("Le reversement se fait uniquement le 1er et le 2 de chaque mois.");
    const reste = resteAVerser(bq);
    if (montant > reste) return toast("Le versement dépasse la commission à reverser (" + money0(reste) + ").");
    const row = { boutique: bq, cc: isAdmin() ? null : me.cc, mois: premierDuMois(today()), montant, mode: $("#cv-mode").value, note: "", saisi_par: me.nom || me.email || "" };
    act(async () => chk(await sb.from("credit_versements").insert(row)), "Versement de " + money0(montant) + " déclaré. Le solde diminuera quand l'admin confirmera la réception.", e.target);
  });
  // Contrôle du crédit restant lu sur la puce (hier d'abord si oublié), confirmé par « Oui »
  $("#cs-save").addEventListener("click", (e) => {
    const admin = isAdmin(), bq = creditSaisieBq(), d = venteJourChoisi(bq), btn = e.target, y = $("#cs-yas").value.trim(), m = $("#cs-moov").value.trim();
    if (!canCloture()) return toast("Vous n'êtes pas autorisé au contrôle du crédit (case « Contrôle Crédit » dans RH → Autorisations).");
    if (d > today()) return toast("Impossible d'enregistrer un contrôle pour un jour à venir.");
    if (!bq) return toast("Choisissez une boutique.");
    if (!admin && venteFaite(bq, d)) return toast("Le contrôle de ce jour est déjà fait.");
    if (y === "" || m === "") return toast("Indiquez le crédit restant YAS et MOOV lu sur les puces (0 si vide).");
    const v = { YAS: Number(y), MOOV: Number(m) };
    if (!(v.YAS >= 0 && v.MOOV >= 0)) return toast("Montant invalide.");
    // Écart avec le crédit attendu (contrôle précédent + recharges) : signalé, pas bloquant
    const ecarts = d === today() ? OPS.map((op) => { const cr = creditRestant(bq, op); return cr.connu && v[op] - cr.total > 1 ? op + " : +" + money0(v[op] - cr.total) + " de plus que prévu" : ""; }).filter(Boolean) : [];
    const dlg = $("#crconf-dialog"), oubli = d !== today();
    $("#crconf-titre").textContent = "Confirmer le contrôle " + (oubli ? "du " + fmtDate(d) : "de ce soir");
    $("#crconf-oui").textContent = "Oui, j'enregistre";
    $("#crconf-logo").innerHTML = OPS.map((op) => '<div class="crconf-ligne">' + logoOp(op) + "<b>" + money0(v[op]) + "</b></div>").join("");
    $("#crconf-montant").textContent = "";
    $("#crconf-text").innerHTML = "Crédit restant lu sur les puces <b>" + (oubli ? "le " : "ce ") + esc(jourLong(d)) + "</b> pour <b>" + esc(boutiqueName(bq)) + "</b>." +
      (ecarts.length ? '<br><b class="neg">⚠ ' + ecarts.join(" · ") + "</b> (recharge non déclarée ?)" : "") +
      "<br>Ce chiffre devient le crédit restant affiché" + (admin ? "" : " et ne pourra plus être modifié (sauf par l'administrateur)") + ".<br>Confirmez-vous ?";
    dlg.returnValue = "";
    dlg.onclose = () => {
      if (dlg.returnValue !== "oui") return toast("Contrôle annulé : rien n'a été enregistré.");
      const rows = OPS.map((op) => ({ boutique: bq, date: d, operateur: op, solde: v[op], cc: me.cc || null, saisi_par: me.nom || me.email || "", updated_at: new Date().toISOString() }));
      act(async () => {
        chk(admin ? await sb.from("credit_soldes").upsert(rows, { onConflict: "boutique,date,operateur" }) : await sb.from("credit_soldes").insert(rows));
        $("#cs-yas").value = ""; $("#cs-moov").value = "";
      }, "Contrôle " + (oubli ? "du " + fmtDate(d) : "de ce soir") + " enregistré." + (oubli && !admin ? " Vous pouvez maintenant faire celui d'aujourd'hui." : ""), btn);
    };
    dlg.showModal();
  });
  // Historique : liste déroulante pour choisir la rubrique affichée (mémorisée sur l'appareil)
  function majHistFiltre() {
    const v = $("#hist-filtre").value;
    document.querySelectorAll("#view-credit .hist-sec").forEach((s) => s.classList.toggle("hidden", v !== "tout" && s.dataset.hist !== v));
    try { localStorage.setItem("hist-credit", v); } catch (e) {}
  }
  try { const v = localStorage.getItem("hist-credit"); if (v) $("#hist-filtre").value = v; } catch (e) {}
  majHistFiltre();
  $("#hist-filtre").addEventListener("change", majHistFiltre);
  // Ajustement du crédit (admin)
  $("#aj-save").addEventListener("click", (e) => {
    const bq = creditSaisieBq(), y = Number($("#aj-yas").value) || 0, m = Number($("#aj-moov").value) || 0, note = $("#aj-note").value.trim();
    if (!bq) return toast("Choisissez une boutique dans le filtre.");
    if (!y && !m) return toast("Indiquez un ajustement YAS et/ou MOOV.");
    const rows = [];
    if (y) rows.push({ boutique: bq, operateur: "YAS", montant: y, note, saisi_par: me.nom || me.email || "" });
    if (m) rows.push({ boutique: bq, operateur: "MOOV", montant: m, note, saisi_par: me.nom || me.email || "" });
    const txt = rows.map((r) => r.operateur + " " + (r.montant > 0 ? "+" : "−") + money0(Math.abs(r.montant)) + " → " + money0(creditRestant(bq, r.operateur).total + r.montant)).join("\n");
    if (!confirm("Ajuster le crédit de " + boutiqueName(bq) + " ?\n\n" + txt)) return;
    act(async () => { chk(await sb.from("credit_ajustements").insert(rows)); $("#aj-yas").value = ""; $("#aj-moov").value = ""; $("#aj-note").value = ""; },
      "Ajustement enregistré : " + txt.replace(/\n/g, " · ") + ".", e.target);
  });
  $("#aj-rows").addEventListener("click", (e) => {
    const d = e.target.closest("[data-aj-del]");
    if (d && confirm("Supprimer cet ajustement ? Le crédit restant sera recalculé.")) act(async () => chk(await sb.from("credit_ajustements").delete().eq("id", d.dataset.ajDel)), "Ajustement supprimé.", d);
  });
  $("#cs-date").addEventListener("change", () => { $("#cs-yas").value = ""; $("#cs-moov").value = ""; renderCredit(); });
  $("#cvt-rows").addEventListener("click", (e) => {
    const d = e.target.closest("[data-cvt-del]");
    if (d && confirm("Supprimer ce contrôle ? Le CC pourra le refaire.")) act(async () => chk(await sb.from("credit_soldes").delete().eq("boutique", d.dataset.bq).eq("date", d.dataset.d)), "Contrôle supprimé.", d);
  });
  $("#cr-rows").addEventListener("click", (e) => {
    const d = e.target.closest("[data-cr-del]");
    if (d && confirm("Supprimer cette recharge ? (la commission correspondante sera retirée)")) act(async () => chk(await sb.from("credit_achats").delete().eq("id", d.dataset.crDel)), "Recharge supprimée.", d);
  });
  $("#cv-rows").addEventListener("click", (e) => {
    const r = e.target.closest("[data-cv-recu]");
    if (r) {
      if (r.dataset.v === "1" && !confirm("Confirmez-vous avoir bien reçu cet argent ? Le solde à reverser va diminuer.")) return;
      return act(async () => chk(await sb.rpc("set_versement_recu", { p_id: r.dataset.cvRecu, p_recu: r.dataset.v === "1" })), r.dataset.v === "1" ? "Réception confirmée : le solde à reverser diminue." : "Validation annulée.", r);
    }
    const d = e.target.closest("[data-cv-del]");
    if (d && confirm("Supprimer ce versement ?")) act(async () => chk(await sb.from("credit_versements").delete().eq("id", d.dataset.cvDel)), "Versement supprimé.", d);
  });
  $("#cr-bilan").addEventListener("change", (e) => {
    const y = e.target.closest("[data-dot-yas]"), m = e.target.closest("[data-dot-moov]");
    const el = y || m; if (!el) return;
    const v = Number(el.value); if (!(v >= 0)) return toast("Montant invalide.");
    act(async () => chk(await sb.from("boutiques").update(y ? { dotation_yas: v } : { dotation_moov: v }).eq("code", y ? y.dataset.dotYas : m.dataset.dotMoov)), "Dotation " + (y ? "YAS" : "MOOV") + " enregistrée : " + money0(v) + ".");
  });
  $("#cr-set-save").addEventListener("click", (e) => {
    const ty = Number($("#cr-set-yas").value), tm = Number($("#cr-set-moov").value);
    if (!(ty >= 0 && ty <= 100 && tm >= 0 && tm <= 100)) return toast("Taux invalide (0 à 100 %).");
    act(async () => chk(await sb.from("settings").update({ taux_yas: ty, taux_moov: tm }).eq("id", 1)), "Taux de commission enregistrés : YAS " + ty + " %, MOOV " + tm + " %.", e.target);
  });

  // ---------- Frigo (boissons) ----------
  // L'admin fait une course : sa valeur de vente devient le « crédit vente » du frigo de la boutique.
  // Les CC déclarent chaque soir la vente du frigo (l'oubli d'hier d'abord), déduite du crédit vente restant.
  // Quand le restant atteint le seuil (5 000 par défaut), une nouvelle course est possible.
  let fsVue = "tous", fgTab = (() => { try { return localStorage.getItem("onglet-frigo") || "ops"; } catch (e) { return "ops"; } })(), fcLignes = [{ code: "", qte: "", total: "" }];
  const FRIGO_DEBUT = "2026-11-10";
  // Montants du frigo au centime près (prix unitaires = total ÷ quantité)
  const money2 = (n) => money(Math.round(Number(n || 0) * 100) / 100);
  const sumBy = (l, f) => l.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  function canFrigoDotation() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && c.frigoDotation); }
  function canFrigoCourse() { if (isAdmin()) return true; const c = myCcRow(); return !!(c && c.actif && myBoutiqueCode()); }
  const fgGlobal = () => isGlobal() || canFrigoDotation();
  function canFrigo() { return isAdmin() || fgGlobal() || !!myBoutiqueCode(); }
  function frigoScope() {
    if (fgGlobal()) { const f = $("#fg-boutique").value; return f && f !== "ALL" ? db.boutiques.filter((b) => b.code === f) : db.boutiques; }
    return db.boutiques.filter((b) => b.code === myBoutiqueCode());
  }
  // Boutique pour la dotation (admin / CC désigné : celle du filtre)
  function dotBq() { if (!canFrigoDotation()) return ""; const f = $("#fg-boutique").value; return f && f !== "ALL" ? f : ""; }
  const dotOuverte = (bq) => db.fgDotations.find((d) => d.boutique === bq && d.statut === "Ouverte") || null;
  function frigoBq() { return isAdmin() ? ($("#fg-boutique").value !== "ALL" ? $("#fg-boutique").value : "") : myBoutiqueCode(); }
  const fgVenteLe = (bq, d) => db.fgVentes.find((v) => v.boutique === bq && v.date === d) || null;
  function fgHierManquant(bq) { const h = addDays(today(), -1); return !!bq && h >= FRIGO_DEBUT && db.fgCourses.some((c) => c.boutique === bq && c.date <= h) && !fgVenteLe(bq, h); }
  function fgCible(bq) { return fgHierManquant(bq) ? addDays(today(), -1) : today(); }
  function frigoInfo(bq, mois) {
    const courses = db.fgCourses.filter((c) => c.boutique === bq).sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
    // Sorties = ventes en caisse des produits du frigo ; chacune consomme son prix d'achat (frais compris) du crédit
    const sorties = db.fgSorties.filter((x) => x.boutique === bq);
    const credit = sumBy(courses, (c) => c.cout), consomme = sumBy(sorties, (x) => x.consomme), ajustVal = ajustValeurAu(bq, "9999-12-31"), restant = credit - consomme + ajustVal;
    const ca = sumBy(sorties, (x) => x.montant); // argent encaissé (prix de vente)
    const derniere = courses[0] || null;
    const retire = sumBy(db.fgRetraits.filter((r) => r.boutique === bq), (r) => r.montant);
    const remonte = sumBy(db.remontees.filter((r) => r.boutique === bq && r.statut === "Reçue"), remBenefPart); // part bénéfice remontée et confirmée (Fonds & dépenses)
    const sMois = sorties.filter((x) => x.date.slice(0, 7) === mois), venduMois = sumBy(sMois, (x) => x.montant), articlesMois = sumBy(sMois, (x) => x.qte);
    const sJour = sorties.filter((x) => x.date === today());
    // Estimation des ventes et bénéfice estimé du mois : d'après les produits des courses du mois (prix de vente × quantité)
    const cMois = courses.filter((c) => c.date.slice(0, 7) === mois), estimationMois = sumBy(cMois, (c) => c.valeur), benefMois = sumBy(cMois, (c) => c.valeur - c.cout);
    // base de la barre : restant + consommé depuis la dernière course
    const base = derniere ? restant + sumBy(sorties.filter((x) => String(x.createdAt) >= String(derniere.createdAt)), (x) => x.consomme) : 0;
    return { courses, sorties, credit, consomme, ajustVal, restant, ca, derniere, retire, benefVentes: ca - consomme, remonte, aRetirer: ca - consomme - retire - remonte, venduMois, articlesMois,
      venteJour: sumBy(sJour, (x) => x.montant), consJour: sumBy(sJour, (x) => x.consomme), articlesJour: sumBy(sJour, (x) => x.qte),
      estimationMois, benefMois, taux: estimationMois > 0 ? benefMois / estimationMois : null, base, seuilAtteint: !courses.length || restant <= db.settings.frigoSeuil };
  }
  // Boutiques qui ont un frigo (au moins une course)
  function boutiquesFrigo() { const s = new Set(db.fgCourses.map((c) => c.boutique)); return db.boutiques.filter((b) => s.has(b.code)); }

  function renderFrigo() {
    const glob = fgGlobal(), admin = isAdmin(), t = today(), mois = t.slice(0, 7);
    const bcur = $("#fg-boutique").value || "ALL";
    if (glob) {
      $("#fg-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("");
      $("#fg-boutique").value = db.boutiques.some((b) => b.code === bcur) ? bcur : "ALL";
      $("#fg-boutique").disabled = false;
    } else {
      const mb = myBoutiqueCode();
      $("#fg-boutique").innerHTML = mb ? '<option value="' + esc(mb) + '">' + esc(boutiqueName(mb)) + "</option>" : '<option value="">Aucune boutique</option>';
      $("#fg-boutique").disabled = true;
    }
    if (!$("#fg-mois").value) $("#fg-mois").value = mois;
    $("#fg-titre").textContent = "Frigo — " + fmtMonth(mois + "-01");
    document.querySelectorAll("#fg-tabs [data-fg-tab]").forEach((b) => b.classList.toggle("active", b.dataset.fgTab === fgTab));
    $("#fg-main").classList.toggle("hidden", fgTab !== "ops");
    $("#fg-recap").classList.toggle("hidden", fgTab !== "recap");
    $("#fg-stock").classList.toggle("hidden", fgTab !== "stock");
    const scope = frigoScope();
    if (fgTab === "recap") return renderRecapFrigo(scope);
    if (fgTab === "stock") return renderStockFrigo(scope);

    // Cartes (une boutique) ou tableau (plusieurs)
    const une = scope.length === 1;
    $("#fg-table-card").classList.toggle("hidden", une || !scope.length);
    $("#fg-cards").classList.toggle("fg-2col", une);
    if (une) {
      const bq = scope[0].code, f = frigoInfo(bq, mois);
      const pct = f.base > 0 ? Math.max(0, Math.min(100, Math.round((f.restant / f.base) * 100))) : 0;
      // Tableau de bord financier (2 colonnes) : semaine en cours (lundi → dimanche), reversée le lundi suivant
      const lundiC = mondayOf(t), lundiRev = addDays(lundiC, 7), sw = reversementSemaine(bq, lundiC);
      const reste = Math.max(0, Math.round((sw.solde + sw.reliquatAvant) * 100) / 100), enRetard = sw.reliquatAvant > 0.5;
      // 1re ligne : stock restant au coût d'achat | chiffre d'affaires du mois
      let h = '<div class="fg-card' + (f.courses.length && f.seuilAtteint ? " orange" : "") + '"><span>Stock restant au coût d\'achat</span><b>' + (f.courses.length ? money2(Math.max(0, f.restant)) : "—") + "</b>" +
        (f.courses.length ? '<div class="fg-bar' + (f.seuilAtteint ? " bas" : "") + '"><i style="width:' + pct + '%"></i></div><small>' +
          (f.seuilAtteint ? "🛒 <b>Seuil de " + money0(db.settings.frigoSeuil) + " atteint</b> : nouvelle course de <b>" + money0(DOTATION_STANDARD) + "</b> à faire"
            : "achats enregistrés " + money2(f.credit) + " − coût d'achat sorti " + money2(f.consomme) + (Math.abs(f.ajustVal) > 0.005 ? (f.ajustVal < 0 ? " − " : " + ") + "corrections de stock " + money2(Math.abs(f.ajustVal)) : "") + " · dernière course du " + fmtDate(f.derniere.date) + " : " + money2(f.derniere.cout)) + "</small>"
          : "<small>Aucune course enregistrée pour ce frigo</small>") + "</div>";
      // Estimation des ventes du stock disponible = Σ (quantité restante × prix de vente de la fiche produit), articles épuisés exclus
      const codesFg = [...new Set((db.fgLignes || []).filter((l) => l.boutique === bq && l.code).map((l) => l.code))];
      const estimStock = codesFg.reduce((a, c) => { const p = db.products.find((y) => y.code === c), q = stockFrigoOf(c, bq); return a + (p && q > 0 ? q * Number(p.pv || 0) : 0); }, 0);
      // Bénéfice attendu du stock disponible = estimation des ventes − stock restant au coût d'achat
      const benefAttendu = Math.round((estimStock - Math.max(0, f.restant)) * 100) / 100;
      h += '<div class="fg-card vert"><div class="fg-duo"><div><span>Estimation des ventes du stock disponible</span><b>' + money2(estimStock) + "</b></div>" +
        '<div><span>Bénéfice attendu du stock disponible</span><b class="' + (benefAttendu < 0 ? "rouge-txt" : "vert-txt") + '">' + money2(benefAttendu) + "</b></div></div>" +
        "<small>Valeur potentielle de vente de tous les articles actuellement disponibles · bénéfice attendu = estimation − stock restant au coût d'achat (" + money2(Math.max(0, f.restant)) + ")</small></div>";
      // 2e ligne : coût d'achat vendu | bénéfice réalisé (semaine en cours)
      h += '<div class="fg-card"><span>Coût d\'achat vendu de la semaine</span><b>' + money2(sw.cout) + "</b><small>stock au début " + money2(Math.max(0, sw.restantDebut)) + " + achats de la semaine " + money2(sw.dotations) +
        " − stock restant " + money2(Math.max(0, sw.restantFin)) + (sw.raz > 0.005 ? " · dont remise à zéro du frigo " + money2(sw.raz) + " (non comptée comme vendue)" : "") + (Math.abs(sw.pertes) > 0.005 ? " · dont " + (sw.pertes > 0 ? "pertes de stock " : "surplus de stock −") + money2(Math.abs(sw.pertes)) + " (corrections de l'admin)" : "") + "</small></div>";
      h += '<div class="fg-card vert"><span>Bénéfice réalisé de la semaine</span><b class="vert-txt">' + money2(sw.benef) + "</b><small>somme des marges des ventes du " + fmtDate(lundiC) + " au " + fmtDate(t) + " (prix de vente − coût d'achat)</small></div>";
      // 3e ligne : total à reverser lundi (pleine largeur)
      h += '<div class="fg-card fg-total fg-plein"><span>Total des recettes à reverser lundi ' + fmtDate(lundiRev) + "</span><b>" + money2(sw.total) + "</b><small>coût d'achat vendu de la semaine " + money2(sw.cout) +
        " + bénéfice réalisé de la semaine " + money2(sw.benef) + "</small></div>";
      // 4e ligne : déjà reversé | reste à reverser (orange = en attente, rouge = en retard)
      h += '<div class="fg-card"><span>Montant déjà reversé</span><b>' + money2(sw.recu) + "</b><small>versements confirmés pour la semaine du " + fmtDate(lundiC) +
        (sw.attente > 0 ? " · ⏳ " + money2(sw.attente) + " déclarés, en attente de confirmation" : "") + "</small></div>";
      h += '<div class="fg-card ' + (enRetard ? "rouge" : reste > 0.5 ? "orange" : "vert") + '"><span>Reste à reverser</span><b class="' + (enRetard ? "rouge-txt" : reste > 0.5 ? "orange-txt" : "vert-txt") + '">' + money2(reste) + "</b><small>" +
        (enRetard ? "⚠ dont <b>" + money2(sw.reliquatAvant) + "</b> de reliquat des semaines précédentes (en retard) · " : "") + "prochain reversement : <b>lundi " + fmtDate(lundiRev) + "</b></small></div>";
      $("#fg-cards").innerHTML = h;
    } else {
      $("#fg-cards").innerHTML = "";
      $("#fg-table-head").innerHTML = "<tr><th>Boutique</th><th class=\"num\">Crédit vente restant</th><th class=\"num\">Estimation des ventes du mois</th><th class=\"num\">Vendu en caisse ce mois</th><th class=\"num\">Vendu aujourd'hui</th>" +
        (admin ? '<th class="num">Bénéfice estimé du mois</th><th class="num">Bénéfice (retirable)</th>' : "") + "</tr>";
      const avec = scope.filter((b) => db.fgCourses.some((c) => c.boutique === b.code));
      $("#fg-table").innerHTML = avec.length ? avec.map((b) => {
        const f = frigoInfo(b.code, mois);
        const etat = '<span class="num">' + money2(f.venteJour) + "</span>";
        return '<tr class="cliquable" data-go-filtre="#fg-boutique" data-go-bq="' + esc(b.code) + '" title="Ouvrir le frigo de ' + esc(b.nom) + '"><td><b>' + esc(b.nom) + '</b></td><td class="num">' + (f.seuilAtteint ? '<b class="neg">' + money2(Math.max(0, f.restant)) + "</b> 🛒" : money2(Math.max(0, f.restant))) + '</td><td class="num">' + money2(f.estimationMois) + '</td><td class="num">' + money2(f.venduMois) + "</td><td>" + etat + "</td>" +
          (admin ? '<td class="num">' + money2(f.benefMois) + '</td><td class="num">' + money2(f.aRetirer) + "</td>" : "") + "</tr>";
      }).join("") : '<tr><td colspan="6" class="empty">Aucun frigo approvisionné : choisissez une boutique dans le filtre pour enregistrer sa première course.</td></tr>';
    }

    renderReversement(scope);

    // Ventes du frigo du jour : faites en CAISSE, déduites automatiquement du crédit vente restant
    const sbq = frigoBq(), fi = sbq ? frigoInfo(sbq, mois) : null, sansCourse = !!sbq && !fi.courses.length;
    $("#fv-titre").innerHTML = "🧾 Ventes du frigo en caisse — " + (sbq ? esc(boutiqueName(sbq)) + " · " : "") + esc(jourLong(t));
    $("#fv-card").classList.toggle("fait", !!sbq && !!fi.articlesJour);
    const sj = sbq ? fi.sorties.filter((x) => x.date === t).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [];
    $("#fv-info").innerHTML = !sbq ? (admin ? "Choisissez une boutique dans le filtre." : "Vous n'êtes affecté à aucune boutique.")
      : sansCourse ? "Le frigo n'a pas encore de course. Après la première course, chaque vente en <b>Caisse</b> d'un produit du frigo sera déduite automatiquement du crédit vente restant."
      : (sj.length ? "<b>" + num(fi.articlesJour) + " article" + (fi.articlesJour > 1 ? "s" : "") + "</b> vendu" + (fi.articlesJour > 1 ? "s" : "") + " aujourd'hui pour <b>" + money2(fi.venteJour) + "</b> — " +
          "crédit vente diminué de <b>" + money2(fi.consJour) + "</b> (prix d'achat). Reste <b>" + money2(Math.max(0, fi.restant)) + "</b>." +
          '<div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Heure</th><th>Ticket</th><th>Produit</th><th class="num">Qté</th><th class="num">Montant</th>' + (admin ? '<th class="num">Déduit du crédit</th>' : "") + "</tr></thead><tbody>" +
          sj.map((x) => "<tr><td>" + new Date(x.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + "</td><td>" + x.ticket + "</td><td>" + esc(x.nom) + '</td><td class="num">' + num(x.qte) +
            '</td><td class="num">' + money2(x.montant) + "</td>" + (admin ? '<td class="num">−' + money2(x.consomme) + "</td>" : "") + "</tr>").join("") + "</tbody></table></div>"
        : "Aucune vente de produit du frigo aujourd'hui. Les ventes faites en <b>Caisse</b> des produits du frigo sont déduites automatiquement du crédit vente restant (au prix d'achat).");

    // Dotation de crédit (admin ou CC désigné) : possible quand le seuil est atteint (ou première course)
    if (canFrigoDotation()) {
      const db_ = dotBq(), fd = db_ ? frigoInfo(db_, mois) : null, dot = db_ ? dotOuverte(db_) : null;
      $("#fd-ouverte").innerHTML = !db_ ? "Choisissez une boutique dans le filtre pour fixer sa dotation."
        : dot ? "💰 Dotation en attente de course pour <b>" + esc(boutiqueName(db_)) + "</b> : <b>" + money2(dot.montant) + "</b> (fixée par " + esc(dot.saisiPar || "—") + " le " + fmtDate(dot.createdAt.slice(0, 10)) + ")." +
            ' <button class="btn small danger" data-fd-annul="' + dot.id + '">Annuler la dotation</button>'
        : !fd.seuilAtteint && !admin ? "🔒 Dotation possible quand le crédit vente restant atteint <b>" + money2(db.settings.frigoSeuil) + "</b> (actuellement <b>" + money2(Math.max(0, fd.restant)) + "</b>)."
        : (!fd.courses.length ? "🧊 Premier approvisionnement du frigo" : fd.seuilAtteint ? "✅ Seuil atteint (restant " + money2(Math.max(0, fd.restant)) + ")" : "👑 Dotation administrateur à tout moment (crédit vente restant actuel " + money2(Math.max(0, fd.restant)) + ")") +
          " : fixez la dotation de crédit de <b>" + esc(boutiqueName(db_)) + "</b>. La course devra être exactement égale à ce montant.";
      $("#fd-form").classList.toggle("hidden", !db_ || !!dot || (!fd.seuilAtteint && !admin));
      // Dotation standard : 20 000 FCFA proposés par défaut (modifiable)
      if (db_ && !dot && document.activeElement !== $("#fd-montant") && !$("#fd-montant").value) $("#fd-montant").value = DOTATION_STANDARD;
    }
    // Course (admin ou CC de la boutique) : seulement avec une dotation ouverte, et égale à cette dotation
    if (canFrigoCourse()) {
      const dot = sbq ? dotOuverte(sbq) : null;
      $("#fc-zone").classList.toggle("hidden", !dot);
      $("#fc-etat").innerHTML = !sbq ? (admin ? "Choisissez une boutique dans le filtre pour enregistrer une course." : "Vous n'êtes affecté à aucune boutique.")
        : dot ? "💰 Dotation de crédit pour <b>" + esc(boutiqueName(sbq)) + "</b> : <b>" + money2(dot.montant) + "</b>. Votre course doit être <b>exactement égale</b> à ce montant."
        : "🔒 Pas de dotation de crédit pour ce frigo : l'administrateur (ou le CC désigné) doit d'abord fixer la dotation" + (!admin && fi && fi.courses.length && !fi.seuilAtteint ?" — elle sera possible quand le crédit vente restant atteindra " + money2(db.settings.frigoSeuil) + "." : ".");
      $("#fc-date").readOnly = !admin;
      if (!$("#fc-date").value || !admin) $("#fc-date").value = t;
      renderFcLignes();
    }
    if (admin) {
      // Retrait
      $("#fx-info").innerHTML = sbq ? "Bénéfice des ventes retirable pour " + esc(boutiqueName(sbq)) + " : <b>" + money2(fi.aRetirer) + "</b>." : "Choisissez une boutique dans le filtre.";
      $("#fx-save").disabled = !sbq;
      if (document.activeElement !== $("#fg-seuil")) $("#fg-seuil").value = db.settings.frigoSeuil;
    }

    // Historique du mois en cours
    const codes = scope.map((b) => b.code);
    $("#fh-ventes-head").innerHTML = fgJoursHead(admin);
    $("#fh-ventes").innerHTML = fgJoursRows(codes, mois, admin);
    const courses = db.fgCourses.filter((c) => codes.includes(c.boutique) && c.date.slice(0, 7) === mois).sort((a, b) => b.date.localeCompare(a.date));
    $("#fh-courses").innerHTML = courses.length ? courses.map((c) => courseFrigoHtml(c, admin)).join("") : '<p class="empty">Aucune course ce mois-ci.</p>';
    if (admin) {
      const rt = db.fgRetraits.filter((r) => codes.includes(r.boutique) && r.date.slice(0, 7) === mois).sort((a, b) => b.date.localeCompare(a.date));
      $("#fh-retraits").innerHTML = rt.length ? rt.map((r) => "<tr><td>" + fmtDate(r.date) + "</td><td>" + esc(boutiqueName(r.boutique)) + '</td><td class="num"><b>' + money2(r.montant) + "</b></td><td>" + esc(r.note || "—") +
        "</td><td>" + esc(r.saisiPar || "—") + '</td><td><button class="btn small danger" data-fx-del="' + r.id + '">✕</button></td></tr>').join("") : '<tr><td colspan="6" class="empty">Aucun retrait ce mois-ci.</td></tr>';
    }
  }
  // Ventes du frigo en caisse, regroupées par jour et par boutique
  function fgJoursHead(admin) { return "<tr><th>Jour</th><th>Boutique</th><th class=\"num\">Articles</th><th class=\"num\">Vendu (prix de vente)</th>" + (admin ? '<th class="num">Déduit du crédit (prix d\'achat)</th>' : "") + "</tr>"; }
  function fgJoursRows(codes, mois, admin) {
    const g = {};
    db.fgSorties.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois).forEach((x) => {
      const k = x.date + "|" + x.boutique; g[k] = g[k] || { date: x.date, bq: x.boutique, qte: 0, montant: 0, consomme: 0 };
      g[k].qte += x.qte; g[k].montant += x.montant; g[k].consomme += x.consomme;
    });
    const l = Object.values(g).sort((a, b) => b.date.localeCompare(a.date) || boutiqueName(a.bq).localeCompare(boutiqueName(b.bq)));
    return l.length ? l.map((j) => "<tr><td>" + esc(jourLong(j.date)) + "</td><td>" + esc(boutiqueName(j.bq)) + '</td><td class="num">' + num(j.qte) + '</td><td class="num"><b>' + money2(j.montant) + "</b></td>" +
      (admin ? '<td class="num">−' + money2(j.consomme) + "</td>" : "") + "</tr>").join("") : '<tr><td colspan="5" class="empty">Aucune vente de produit du frigo en ' + esc(fmtMonth(mois + "-01")) + ".</td></tr>";
  }
  // Une course (historique) : l'admin voit le détail (prix d'achat, frais, bénéfice)
  function courseFrigoHtml(c, admin) {
    const d = c.detail;
    const tete = "<b>" + fmtDate(c.date) + "</b> · " + esc(boutiqueName(c.boutique)) + " · crédit vente (total de la course) <b>" + money2(c.cout) + "</b> · estimation des ventes " + money2(c.valeur) +
      (admin ? ' · bénéfice estimé <b class="pos">' + money2(c.valeur - c.cout) + "</b>" : "") + ' <span class="muted">par ' + esc(c.saisiPar || "—") + "</span>";
    if (!admin || !d) return '<div class="fh-course">' + tete + "</div>";
    // Bénéfice par produit = total vente − total achat − part des frais (répartis au prorata du total achat) : la somme = bénéfice estimé
    const frais = (d.deplacement || 0) + (d.sachet || 0) + (d.autres || 0), achats = sumBy(d.lignes, (l) => l.qte * l.achat);
    const lg = d.lignes.map((l) => { const ta = l.qte * l.achat, tv = l.qte * l.vente, pf = achats > 0 ? frais * ta / achats : 0; return { l, ta, tv, pf, bene: tv - ta - pf }; });
    return '<details class="fh-course"><summary>' + tete + ' <button class="btn small danger" data-fc-del="' + c.id + '">✕</button></summary>' +
      '<div class="table-wrap" style="margin-top:8px"><table class="table"><thead><tr><th>Produit</th><th class="num">Qté</th><th class="num">Prix d\'achat</th><th class="num">Prix de vente</th><th class="num">Total achat</th><th class="num">Total vente</th>' +
      '<th class="num" title="Frais de la course répartis au prorata du total achat">Part des frais</th><th class="num" title="Total vente − total achat − part des frais">Bénéfice</th></tr></thead><tbody>' +
      lg.map((x) => "<tr><td>" + esc(x.l.nom) + '</td><td class="num">' + num(x.l.qte) + '</td><td class="num">' + money2(x.l.achat) + '</td><td class="num">' + money2(x.l.vente) +
        '</td><td class="num">' + money2(x.ta) + '</td><td class="num">' + money2(x.tv) + '</td><td class="num">' + money2(x.pf) + '</td><td class="num"><b class="' + (x.bene < 0 ? "neg" : "pos") + '">' + money2(x.bene) + "</b></td></tr>").join("") +
      '</tbody><tfoot><tr class="total-row"><td><b>TOTAL</b></td><td class="num"><b>' + num(sumBy(lg, (x) => x.l.qte)) + '</b></td><td></td><td></td><td class="num"><b>' + money2(sumBy(lg, (x) => x.ta)) +
      '</b></td><td class="num"><b>' + money2(sumBy(lg, (x) => x.tv)) + '</b></td><td class="num"><b>' + money2(sumBy(lg, (x) => x.pf)) + '</b></td><td class="num"><b class="pos">' + money2(sumBy(lg, (x) => x.bene)) + "</b></td></tr></tfoot></table></div>" +
      '<div class="course-summary" style="margin-top:8px">' + fcSummary({ achats: d.achats, deplacement: d.deplacement, sachet: d.sachet, autres: d.autres, autresLib: d.autresLib, vente: c.valeur }) + "</div></details>";
  }
  function fcSummary(s) {
    const frais = s.deplacement + s.sachet + s.autres, total = s.achats + frais, marge = s.vente - total;
    return '<div class="sum-row"><span>Sous-total des achats</span><b>' + money2(s.achats) + "</b></div>" +
      '<div class="sum-row"><span>Frais de retrait mobile money</span><span>' + money2(s.sachet) + "</span></div>" +
      '<div class="sum-row"><span>Transport aller-retour</span><span>' + money2(s.deplacement) + "</span></div>" +
      '<div class="sum-row"><span>' + esc(s.autresLib || "Autres frais") + "</span><span>" + money2(s.autres) + "</span></div>" +
      '<div class="sum-row"><span>Total des frais</span><span>' + money2(frais) + "</span></div>" +
      '<div class="sum-row big"><span>TOTAL DE LA COURSE = CRÉDIT VENTE</span><span>' + money2(total) + "</span></div>" +
      '<div class="sum-row"><span>Estimation des ventes (prix de vente × quantité)</span><b>' + money2(s.vente) + "</b></div>" +
      '<div class="sum-row"><span>Bénéfice estimé</span><b>' + margeHtml(marge, s.vente > 0 ? (marge / s.vente) * 100 : null) + "</b></div>";
  }
  // Lignes de course : même principe que « recopiez le reçu du marché » (Entrées de stock) :
  // produit choisi dans le catalogue, quantité, prix total payé → prix d'achat unitaire, prix de vente du catalogue, marge unitaire
  function renderFcLignes() {
    $("#fc-lines").innerHTML = fcLignes.map((l, i) => '<tr data-i="' + i + '"><td><div class="fc-pick"><input type="text" data-pick autocomplete="off" placeholder="🔍 Rechercher un produit…" value="' + esc(fcLabel(l.code)) + '">' +
      '<div class="fc-sug hidden"></div></div></td>' +
      '<td class="num"><input type="number" min="1" data-k="qte" value="' + esc(l.qte) + '"></td>' +
      '<td class="num"><input type="number" min="0" data-k="total" value="' + esc(l.total) + '"></td>' +
      '<td class="num" data-c="pu"></td><td class="num" data-c="pv"></td><td class="num" data-c="mu"></td>' +
      '<td><button class="btn small danger" data-fc-rm="' + i + '" title="Retirer">✕</button></td></tr>').join("");
    majFcCalc();
  }
  function fcTotaux() {
    const lignes = fcLignes.filter((l) => l.code || Number(l.qte) || Number(l.total));
    const ok = lignes.filter((l) => l.code && Number(l.qte) > 0 && l.total !== "" && Number(l.total) >= 0);
    const deplacement = Number($("#fc-deplacement").value) || 0, sachet = Number($("#fc-sachet").value) || 0, autres = Number($("#fc-autres").value) || 0;
    const achats = sumBy(ok, (l) => Number(l.total)), frais = deplacement + sachet + autres;
    const calc = (l) => {
      if (!ok.includes(l)) return null;
      const p = productByCode(l.code) || {}, qte = Number(l.qte), pu = Number(l.total) / qte, pv = Number(p.pv) || 0;
      const part = achats > 0 ? (frais * Number(l.total) / achats) / qte : 0; // frais répartis au prorata du prix d'achat
      return { nom: p.nom || l.code, code: l.code, qte, pu, pv, mu: pv - pu - part };
    };
    return { lignes, ok, calc, achats, vente: sumBy(ok, (l) => Number(l.qte) * (Number((productByCode(l.code) || {}).pv) || 0)), deplacement, sachet, autres, autresLib: $("#fc-autres-lib").value.trim() };
  }
  function majFcCalc() {
    const s = fcTotaux();
    fcLignes.forEach((l, i) => {
      const tr = document.querySelector('#fc-lines tr[data-i="' + i + '"]'); if (!tr) return;
      const r = s.calc(l), set = (k, v) => { tr.querySelector('[data-c="' + k + '"]').innerHTML = v; };
      if (!r) return ["pu", "pv", "mu"].forEach((k) => set(k, '<span class="muted">—</span>'));
      set("pu", money2(r.pu)); set("pv", r.pv > 0 ? money2(r.pv) : '<span class="neg">prix de vente manquant</span>'); set("mu", margeHtml(r.mu, r.pv > 0 ? (r.mu / r.pv) * 100 : null));
    });
    $("#fc-summary").innerHTML = fcSummary(s);
    // Comparaison avec la dotation : la course doit être exactement égale à la dotation
    const dot = dotOuverte(frigoBq()), total = s.achats + s.deplacement + s.sachet + s.autres;
    if (!dot) { $("#fc-dot").innerHTML = ""; $("#fc-save").disabled = true; return; }
    const reste = Math.round((dot.montant - total) * 100) / 100, egal = Math.abs(reste) <= 0.5;
    $("#fc-dot").className = "fc-dot " + (egal ? "ok" : "ko");
    $("#fc-dot").innerHTML = '<div class="sum-row"><span>Dotation de crédit</span><b>' + money2(dot.montant) + "</b></div>" +
      '<div class="sum-row"><span>Total de la course</span><b>' + money2(total) + "</b></div>" +
      (egal ? '<div class="sum-row big"><span>✅ Course égale à la dotation</span><span>Prête à valider</span></div>'
        : reste > 0 ? '<div class="sum-row big"><span>⚠ Crédit non utilisé</span><span>' + money2(reste) + "</span></div><small>La course doit utiliser toute la dotation pour pouvoir être validée.</small>"
        : '<div class="sum-row big"><span>⛔ Dépassement de la dotation</span><span>' + money2(-reste) + "</span></div><small>La course ne peut pas dépasser la dotation.</small>");
    $("#fc-save").disabled = !egal;
  }
  const majFcSummary = majFcCalc;
  $("#fc-lines").addEventListener("input", (e) => {
    const el = e.target.closest("[data-k]"); if (!el || el.dataset.k === "code") return;
    fcLignes[Number(el.closest("tr").dataset.i)][el.dataset.k] = el.value;
    majFcCalc();
  });
  // Recherche de produit (au lieu d'une liste « — Choisir — ») : on tape une partie du nom ou du code
  function fcLabel(code) { const p = code ? productByCode(code) : null; return p ? p.nom + " (" + p.code + ")" : ""; }
  const sansAccent = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function fcSuggest(inp) {
    const box = inp.parentElement.querySelector(".fc-sug"), idx = Number(inp.closest("tr").dataset.i);
    const cur = fcLignes[idx] && fcLignes[idx].code, txt = inp.value.trim();
    const q = txt === fcLabel(cur) ? "" : sansAccent(txt);
    const mots = q.split(/\s+/).filter(Boolean);
    const list = db.products.filter((p) => { const t = sansAccent(p.nom + " " + p.code + " " + (p.categorie || "")); return mots.every((m) => t.includes(m)); })
      .sort((a, b) => { const sa = sansAccent(a.nom).startsWith(q) ? 0 : 1, sb_ = sansAccent(b.nom).startsWith(q) ? 0 : 1; return sa - sb_ || a.nom.localeCompare(b.nom); });
    box.innerHTML = list.map((p, k) => '<div class="fc-opt' + (k === 0 && q ? " act" : "") + '" data-code="' + esc(p.code) + '">' + (p.valide ? "" : "⚠ ") + esc(p.nom) +
        ' <small>' + esc(p.code) + (p.valide ? "" : " — à valider") + " · " + money(p.pv) + "</small></div>").join("") +
      (list.length ? "" : '<div class="fc-vide">Aucun produit trouvé</div>') +
      '<div class="fc-opt fc-new' + (!list.length ? " act" : "") + '" data-code="__new__">➕ Nouveau produit' + (txt && q ? " « " + esc(txt.toUpperCase()) + " »" : "…") + "</div>";
    box.classList.remove("hidden");
  }
  function fcChoisir(inp, code) {
    const tr = inp.closest("tr"), idx = Number(tr.dataset.i), txt = inp.value.trim();
    inp.parentElement.querySelector(".fc-sug").classList.add("hidden");
    if (code === "__new__") { inp.value = fcLabel(fcLignes[idx].code); inp.blur(); return ouvrirFgNouveauProduit(idx, txt && txt !== fcLabel(fcLignes[idx].code) ? txt : ""); }
    fcLignes[idx].code = code;
    inp.value = fcLabel(code);
    majFcCalc();
    const q = tr.querySelector('[data-k="qte"]'); if (q && !q.value) q.focus();
  }
  $("#fc-lines").addEventListener("focusin", (e) => { const inp = e.target.closest("[data-pick]"); if (!inp) return; inp.select(); fcSuggest(inp); });
  $("#fc-lines").addEventListener("input", (e) => { const inp = e.target.closest("[data-pick]"); if (inp) fcSuggest(inp); });
  $("#fc-lines").addEventListener("mousedown", (e) => {
    const o = e.target.closest(".fc-opt"); if (!o) return;
    e.preventDefault(); // garder le focus jusqu'au choix
    fcChoisir(o.closest(".fc-pick").querySelector("[data-pick]"), o.dataset.code);
  });
  $("#fc-lines").addEventListener("keydown", (e) => {
    const inp = e.target.closest("[data-pick]"); if (!inp) return;
    const box = inp.parentElement.querySelector(".fc-sug"), opts = Array.from(box.querySelectorAll(".fc-opt"));
    if (box.classList.contains("hidden") || !opts.length) return;
    let k = opts.findIndex((o) => o.classList.contains("act"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); k = e.key === "ArrowDown" ? Math.min(opts.length - 1, k + 1) : Math.max(0, k - 1);
      opts.forEach((o, j) => o.classList.toggle("act", j === k)); opts[k].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); if (k >= 0) fcChoisir(inp, opts[k].dataset.code); }
    else if (e.key === "Escape") { box.classList.add("hidden"); }
  });
  $("#fc-lines").addEventListener("focusout", (e) => {
    const inp = e.target.closest("[data-pick]"); if (!inp) return;
    setTimeout(() => {
      // case remplacée par un nouvel affichage (ex. : après création d'un produit) : ne rien effacer
      if (document.activeElement === inp || !inp.isConnected) return;
      inp.parentElement.querySelector(".fc-sug").classList.add("hidden");
      const idx = Number(inp.closest("tr").dataset.i);
      if (!inp.value.trim()) { fcLignes[idx].code = ""; majFcCalc(); } else inp.value = fcLabel(fcLignes[idx].code); // texte non choisi : on remet le produit de la ligne
    }, 150);
  });
  // Nouveau produit depuis la course du frigo : désignation, quantité, prix total payé, PU vente → calcul automatique
  let fgnpLigne = null;
  function prochainCodeArticle() {
    const n = db.products.reduce((m, p) => { const x = /^ART-(\d+)$/.exec(p.code); return x ? Math.max(m, Number(x[1])) : m; }, 0) + 1;
    return "ART-" + String(n).padStart(3, "0");
  }
  function majFgnpCalc() {
    const f = $("#fgnp-form"), q = Number(f.elements.qte.value) || 0, tot = Number(f.elements.total.value) || 0, pv = Number(f.elements.pv.value) || 0;
    const pu = q > 0 ? tot / q : 0, mu = pv - pu;
    $("#fgnp-calc").innerHTML = '<div class="sum-row"><span>Prix d\'achat unitaire</span><b>' + (q > 0 && f.elements.total.value !== "" ? money2(pu) : "—") + "</b></div>" +
      '<div class="sum-row"><span>Prix de vente</span><b>' + (pv > 0 ? money2(pv) : "—") + "</b></div>" +
      '<div class="sum-row"><span>Marge unitaire</span><b>' + (q > 0 && pv > 0 ? margeHtml(mu, (mu / pv) * 100) : "—") + "</b></div>" +
      (q > 0 && pv > 0 ? '<div class="sum-row"><span>Bénéfice estimé sur la quantité</span><b>' + margeHtml(mu * q, null) + "</b></div>" : "");
  }
  function ouvrirFgNouveauProduit(idx, nom) {
    fgnpLigne = idx;
    const f = $("#fgnp-form"), l = fcLignes[idx] || {};
    f.reset();
    if (nom) f.elements.nom.value = nom.toUpperCase();
    f.elements.code.value = prochainCodeArticle();
    f.elements.categorie.value = "Boisson";
    $("#fgnp-cats").innerHTML = Array.from(new Set(db.products.map((p) => p.categorie).filter(Boolean))).sort().map((c) => '<option value="' + esc(c) + '">').join("");
    if (l.qte) f.elements.qte.value = l.qte;
    if (l.total) f.elements.total.value = l.total;
    majFgnpCalc();
    $("#fgnp-dialog").showModal();
    (nom ? (l.qte ? f.elements.pv : f.elements.qte) : f.elements.nom).focus();
  }
  $("#fgnp-form").addEventListener("input", majFgnpCalc);
  $("#fgnp-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    const f = e.target, nom = f.elements.nom.value.trim(), cat = f.elements.categorie.value.trim();
    const qte = Number(f.elements.qte.value), total = f.elements.total.value, pv = Number(f.elements.pv.value);
    if (nom.length < 2) { e.preventDefault(); return toast("Indiquez la désignation."); }
    if (!cat) { e.preventDefault(); return toast("Indiquez la catégorie."); }
    if (!(qte > 0) || total === "" || !(Number(total) >= 0)) { e.preventDefault(); return toast("Indiquez la quantité et le prix total payé."); }
    if (!(pv > 0)) { e.preventDefault(); return toast("Indiquez le prix de vente."); }
    const idx = fgnpLigne;
    const placer = (code) => {
      const i = idx != null && fcLignes[idx] ? idx : (fcLignes.push({ code: "", qte: "", total: "" }), fcLignes.length - 1);
      fcLignes[i] = { code, qte: String(qte), total: String(total) };
      renderFcLignes();
    };
    // Produit déjà au catalogue (même désignation) : on l'utilise directement
    const deja = db.products.find((p) => String(p.nom).trim().toUpperCase() === nom.toUpperCase());
    if (deja) { placer(deja.code); return toast("« " + deja.nom + " » existe déjà (" + deja.code + ") : il a été ajouté à la course."); }
    act(async () => chk(await sb.rpc("create_product", { p_nom: nom, p_categorie: cat, p_pv: pv })),
      isAdmin() ? "Produit « " + nom.toUpperCase() + " » créé et ajouté à la course." : "Produit créé (à valider par l'administrateur) et ajouté à la course.").then((r) => {
      if (!r || !r.ok || !r.data) return;
      placer(r.data);
      // la liste des produits peut se recharger juste après (temps réel) : on s'assure que la ligne reste remplie
      setTimeout(() => { const i = fcLignes.findIndex((l) => l.code === r.data); if (i >= 0) renderFcLignes(); }, 1500);
    });
  });
  $("#fc-lines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fc-rm]"); if (!b) return;
    fcLignes.splice(Number(b.dataset.fcRm), 1);
    if (!fcLignes.length) fcLignes.push({ code: "", qte: "", total: "" });
    renderFcLignes();
  });
  $("#fc-add").addEventListener("click", () => { fcLignes.push({ code: "", qte: "", total: "" }); renderFcLignes(); const ins = document.querySelectorAll("#fc-lines [data-pick]"); ins[ins.length - 1].focus(); });
  ["#fc-deplacement", "#fc-sachet", "#fc-autres", "#fc-autres-lib"].forEach((id) => $(id).addEventListener("input", majFcSummary));
  $("#fc-save").addEventListener("click", (e) => {
    const bq = frigoBq(), s = fcTotaux();
    if (!bq) return toast("Choisissez une boutique dans le filtre.");
    const dot = dotOuverte(bq);
    if (!dot) return toast("Aucune dotation de crédit pour ce frigo : l'admin (ou le CC désigné) doit d'abord la fixer.");
    if (!s.lignes.length) return toast("Ajoutez au moins un produit.");
    const tot0 = s.achats + s.deplacement + s.sachet + s.autres;
    if (Math.abs(dot.montant - tot0) > 0.5) return toast("La course (" + money2(tot0) + ") doit être égale à la dotation (" + money2(dot.montant) + "). Crédit non utilisé : " + money2(dot.montant - tot0) + ".");
    const bad = s.lignes.find((l) => !s.ok.includes(l)), sansPv = s.ok.map(s.calc).find((r) => !(r.pv > 0));
    if (bad) return toast("Complétez chaque ligne : produit, quantité et prix total payé.");
    if (sansPv) return toast("« " + sansPv.nom + " » n'a pas de prix de vente : définissez-le d'abord dans Stock.");
    const total = s.achats + s.deplacement + s.sachet + s.autres;
    if (!confirm("Enregistrer la course du frigo de " + boutiqueName(bq) + " ?\n\nTotal de la course (crédit vente ajouté) : " + money2(total) + "\nEstimation des ventes : " + money2(s.vente) + "\nBénéfice estimé : " + money2(s.vente - total))) return;
    const lignes = s.ok.map(s.calc).map((r) => ({ nom: r.nom, code: r.code, qte: r.qte, achat: r.pu, vente: r.pv }));
    act(async () => {
      chk(await sb.rpc("frigo_ajouter_course", { p_boutique: bq, p_date: $("#fc-date").value || today(), p_lignes: lignes, p_deplacement: s.deplacement, p_sachet: s.sachet, p_autres: s.autres, p_autres_lib: s.autresLib }));
      fcLignes = [{ code: "", qte: "", total: "" }];
      ["#fc-deplacement", "#fc-sachet", "#fc-autres"].forEach((id) => { $(id).value = 0; }); $("#fc-autres-lib").value = "";
    }, "Course enregistrée : " + money2(total) + " ajoutés au crédit vente du frigo (ventes estimées " + money2(s.vente) + ").", e.target);
  });
  // Dotation de crédit du frigo
  $("#fd-save").addEventListener("click", (e) => {
    const bq = dotBq(), montant = Number($("#fd-montant").value);
    if (!bq) return toast("Choisissez une boutique dans le filtre.");
    if (!(montant > 0)) return toast("Indiquez le montant de la dotation.");
    if (!confirm("Fixer la dotation de crédit du frigo de " + boutiqueName(bq) + " à " + money2(montant) + " ?\nLa prochaine course devra être exactement de ce montant.")) return;
    act(async () => { chk(await sb.rpc("frigo_doter", { p_boutique: bq, p_montant: montant })); $("#fd-montant").value = ""; },
      "Dotation de " + money2(montant) + " fixée pour " + boutiqueName(bq) + " : la course peut être faite.", e.target);
  });
  $("#fd-ouverte").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fd-annul]");
    if (b && confirm("Annuler cette dotation ? La course ne pourra plus être faite tant qu'une nouvelle dotation n'est pas fixée.")) act(async () => chk(await sb.rpc("frigo_annuler_dotation", { p_id: b.dataset.fdAnnul })), "Dotation annulée.", b);
  });
  $("#fx-save").addEventListener("click", (e) => {
    const bq = frigoBq(), montant = Number($("#fx-montant").value);
    if (!bq) return toast("Choisissez une boutique dans le filtre.");
    if (!(montant > 0)) return toast("Indiquez le montant du retrait.");
    const dispo = frigoInfo(bq, today().slice(0, 7)).aRetirer;
    if (montant > dispo && !confirm("Le bénéfice des ventes retirable n'est que de " + money2(dispo) + ". Retirer quand même " + money2(montant) + " ?")) return;
    act(async () => {
      chk(await sb.from("frigo_retraits").insert({ boutique: bq, date: today(), montant, note: $("#fx-note").value.trim(), saisi_par: me.nom || me.email || "" }));
      $("#fx-montant").value = ""; $("#fx-note").value = "";
    }, "Retrait de " + money2(montant) + " enregistré.", e.target);
  });
  $("#fg-seuil-save").addEventListener("click", (e) => {
    const v = Number($("#fg-seuil").value);
    if (!(v >= 0)) return toast("Seuil invalide.");
    act(async () => chk(await sb.from("settings").update({ frigo_seuil: v }).eq("id", 1)), "Seuil enregistré : nouvelle course possible à partir de " + money2(v) + " restants.", e.target);
  });
  $("#view-frigo").addEventListener("click", (e) => {
    const v = e.target.closest("[data-fv-del]"), c = e.target.closest("[data-fc-del]"), r = e.target.closest("[data-fx-del]");
    if (v && confirm("Supprimer cette vente déclarée ? Le CC pourra la refaire.")) act(async () => chk(await sb.from("frigo_ventes").delete().eq("id", v.dataset.fvDel)), "Vente supprimée.", v);
    if (c) { e.preventDefault(); if (confirm("Supprimer cette course ? Son crédit vente sera retiré du frigo.")) act(async () => chk(await sb.from("frigo_courses").delete().eq("id", c.dataset.fcDel)), "Course supprimée.", c); }
    if (r && confirm("Supprimer ce retrait ?")) act(async () => chk(await sb.from("frigo_retraits").delete().eq("id", r.dataset.fxDel)), "Retrait supprimé.", r);
  });
  ["#fg-boutique", "#fg-mois"].forEach((id) => $(id).addEventListener("change", renderFrigo));
  $("#fg-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-fg-tab]"); if (!b) return; fgTab = b.dataset.fgTab; try { localStorage.setItem("onglet-frigo", fgTab); } catch (e) {} renderFrigo(); window.scrollTo({ top: 0 }); });
  $("#fr-print").addEventListener("click", () => {
    document.body.classList.add("print-recap");
    window.addEventListener("afterprint", () => document.body.classList.remove("print-recap"), { once: true });
    window.print();
  });
  // Stock frigo (format du menu Stock) : entrées = quantités des courses du frigo, sorties = ventes en caisse de ces produits
  const DOTATION_STANDARD = 20000;
  // Reversement à BGTeam (boutiques avec frigo) : à reverser = coût d'achat vendu + bénéfice = CA encaissé
  function canVoirReversement() { return isAdmin() || canFrigoDotation() || canEntrees(); }
  // Crédit restant d'une boutique à la fin du jour d (dotations/courses jusqu'à d − coût d'achat vendu jusqu'à d)
  function fgRestantAu(bq, d) {
    return sumBy(db.fgCourses.filter((c) => c.boutique === bq && c.date <= d), (c) => c.cout) - sumBy(db.fgSorties.filter((x) => x.boutique === bq && x.date <= d), (x) => x.consomme) + ajustValeurAu(bq, d);
  }
  // Montants effectivement reçus par BGTeam : reversements VALIDÉS (+ retraits admin du frigo) ; ⏳ = déclarés pas encore validés
  function fgRecu(bq, filtreRem, filtreDate) {
    const rems = db.remontees.filter((r) => r.boutique === bq && filtreRem(r));
    // seule la part « frigo » de chaque remontée compte (une boutique peut aussi remonter des ventes du stock principal)
    return { recu: sumBy(rems.filter((r) => r.statut === "Reçue"), remFrigoPart) + sumBy(db.fgRetraits.filter((x) => x.boutique === bq && filtreDate(x.date)), (x) => x.montant),
      attente: sumBy(rems.filter((r) => r.statut !== "Reçue"), remFrigoPart) };
  }
  // Calcul de la semaine w (lundi → dimanche) : uniquement les mouvements de la semaine
  function reversementSemaine(bq, w) {
    const r2 = (n) => Math.round(n * 100) / 100, fin = weekEnd(w), finCalc = fin > today() ? today() : fin;
    const dotations = sumBy(db.fgCourses.filter((c) => c.boutique === bq && c.date >= w && c.date <= fin), (c) => c.cout);
    const restantDebut = fgRestantAu(bq, addDays(w, -1)), restantFin = fgRestantAu(bq, finCalc);
    const ls = db.fgSorties.filter((x) => x.boutique === bq && x.date >= w && x.date <= fin);
    // 1. Coût d'achat vendu = dotations − crédit restant (sur la semaine : restant début + dotations de la semaine − restant fin)
    const razV = r2(sumBy((db.fgAjust || []).filter((a) => a.boutique === bq && estRaz(a) && a.date >= w && a.date <= fin), (a) => a.qte * (a.coutUnit || 0)));
    const cout = r2(restantDebut + dotations - restantFin + razV); // + razV : la valeur remise à zéro ne compte pas comme vendue
    // 2. Bénéfice généré = somme des marges réelles des produits vendus
    const benef = r2(sumBy(ls, (x) => x.montant - x.consomme));
    // dont pertes de stock constatées par l'admin (corrections de la semaine) : comptées dans le coût d'achat à reverser
    const pertes = r2(-(ajustValeurAu(bq, fin) - ajustValeurAu(bq, addDays(w, -1)) - razV));
    // 3. Total à reverser = coût d'achat vendu + bénéfice généré
    const total = r2(cout + benef);
    // 4. Solde = total − montants effectivement reçus pour cette semaine
    const rc = fgRecu(bq, (r) => r.semaine === w, (d) => d >= w && d <= fin);
    // Reliquat des semaines précédentes (non payé avant cette semaine)
    const avant = sumBy(db.fgSorties.filter((x) => x.boutique === bq && x.date < w), (x) => x.montant);
    const rcAvant = fgRecu(bq, (r) => r.semaine < w, (d) => d < w);
    return { dotations: r2(dotations), pertes, raz: -razV, restantDebut: r2(restantDebut), restantFin: r2(restantFin), cout, benef, total, ca: r2(sumBy(ls, (x) => x.montant)),
      recu: r2(rc.recu), attente: r2(rc.attente), solde: r2(total - rc.recu), reliquatAvant: r2(Math.max(0, avant - rcAvant.recu)) };
  }
  function renderReversement(scope) {
    const avec = scope.filter((b) => db.fgCourses.some((c) => c.boutique === b.code));
    const voir = canVoirReversement() && avec.length > 0;
    $("#fr-card").classList.toggle("hidden", !voir);
    if (!voir) return;
    const une = avec.length === 1;
    $("#frv-titre").textContent = "💼 Reversement à BGTeam — " + (une ? avec[0].nom : "toutes les boutiques");
    // Choix de la semaine (par défaut la semaine écoulée : c'est la fiche du lundi)
    const codes = avec.map((b) => b.code);
    const dates = db.fgCourses.filter((c) => codes.includes(c.boutique)).map((c) => c.date).sort();
    const lundi = mondayOf(today()), premier = dates.length ? mondayOf(dates[0]) : lundi;
    const semaines = []; for (let x = lundi; x >= premier; x = addDays(x, -7)) semaines.push(x);
    const sel = $("#fr-semaine"), cur = sel.value;
    sel.innerHTML = semaines.map((x) => '<option value="' + x + '">' + (x === lundi ? "Semaine en cours — " : x === addDays(lundi, -7) ? "Semaine écoulée — " : "") + "du " + fmtDate(x) + " au " + fmtDate(weekEnd(x)) + "</option>").join("");
    sel.value = semaines.includes(cur) ? cur : (semaines.includes(addDays(lundi, -7)) ? addDays(lundi, -7) : lundi);
    const w = sel.value, fin = weekEnd(w);
    const infos = avec.map((b) => ({ b, i: reversementSemaine(b.code, w) }));
    const s = (k) => infos.reduce((a, x) => a + x.i[k], 0);
    const solde = s("solde"), attente = s("attente");
    $("#frv-kpis").innerHTML = kpiHtml([
      ["Crédit restant (stock au coût d'achat)", money2(Math.max(0, s("restantFin"))), s("restantFin") <= db.settings.frigoSeuil ? "warn" : "", 'title="À la fin de la semaine' + (fin > today() ? " (aujourd'hui)" : "") + '"'],
      ["Chiffre d'affaires de la semaine", money2(s("ca"))],
      ["Coût d'achat vendu", money2(s("cout")), "", 'title="Crédit restant au début (' + money2(s("restantDebut")) + ") + dotations de la semaine (" + money2(s("dotations")) + ") − crédit restant à la fin (" + money2(s("restantFin")) + ')"'],
      ["Bénéfice généré", money2(s("benef")), "hero-good"],
      ["Total à reverser", money2(s("total")), "", 'title="Coût d\'achat vendu + bénéfice généré"'],
      ["Montant reçu", money2(s("recu")) + (attente > 0 ? ' <small class="muted">⏳ ' + money2(attente) + "</small>" : ""), "", 'title="Reversements validés pour cette semaine' + (attente > 0 ? " — " + money2(attente) + " déclarés en attente de validation" : "") + '"'],
      ["Solde de la semaine", money2(Math.max(0, solde)), solde > 0.5 ? "danger" : "hero-good"],
      ["Reliquat semaines précédentes", money2(s("reliquatAvant")), s("reliquatAvant") > 0.5 ? "danger" : ""]
    ]);
    $("#fr-calc").innerHTML = "Semaine du <b>" + fmtDate(w) + "</b> au <b>" + fmtDate(fin) + "</b> : coût d'achat vendu = crédit restant au début <b>" + money2(s("restantDebut")) + "</b> + dotations de la semaine <b>" + money2(s("dotations")) +
      "</b> − crédit restant à la fin <b>" + money2(s("restantFin")) + "</b> = <b>" + money2(s("cout")) + "</b> · total à reverser = " + money2(s("cout")) + " + bénéfice " + money2(s("benef")) + " = <b>" + money2(s("total")) + "</b>.";
    $("#fr-multi-wrap").classList.toggle("hidden", une);
    $("#fr-multi").innerHTML = une ? "" : infos.map(({ b, i }) => "<tr><td><b>" + esc(b.nom) + '</b></td><td class="num">' + money2(i.dotations) + '</td><td class="num">' + money2(Math.max(0, i.restantFin)) + '</td><td class="num">' + money2(i.cout) +
      '</td><td class="num">' + money2(i.benef) + '</td><td class="num"><b>' + money2(i.total) + '</b></td><td class="num">' + money2(i.recu) + (i.attente > 0 ? ' <small class="muted">⏳ ' + money2(i.attente) + "</small>" : "") + '</td><td class="num">' +
      (i.solde > 0.5 ? '<b class="neg">' + money2(i.solde) + "</b>" : '<span class="pos">0</span>') + '</td><td class="num">' + (i.reliquatAvant > 0.5 ? '<b class="neg">' + money2(i.reliquatAvant) + "</b>" : "0") + "</td></tr>").join("");

    // Fiche du lundi : par boutique et par collaborateur (mouvements de la semaine uniquement)
    $("#fr-fiche-titre").textContent = "🗓 Fiche de reversement — semaine du " + fmtDate(w) + " au " + fmtDate(fin) + " — par boutique et par collaborateur";
    const venteCc = new Map(db.sales.map((x) => [x.id, x.cc]));
    const r2 = (n) => Math.round(n * 100) / 100;
    const lignes = [];
    infos.forEach(({ b, i }) => {
      const parCc = {};
      const get = (cc) => parCc[cc] || (parCc[cc] = { cout: 0, ca: 0, recu: 0, attente: 0 });
      db.fgSorties.filter((x) => x.boutique === b.code && x.date >= w && x.date <= fin).forEach((x) => { const g = get(venteCc.get(x.id) || "?"); g.cout += x.consomme; g.ca += x.montant; });
      remonteesOf(b.code, w).forEach((r) => { const g = get(r.cc || "ADMIN"), m = remFrigoPart(r); if (r.statut === "Reçue") g.recu += m; else g.attente += m; });
      const retW = sumBy(db.fgRetraits.filter((x) => x.boutique === b.code && x.date >= w && x.date <= fin), (x) => x.montant);
      if (retW) get("ADMIN").recu += retW;
      const ccs = Object.keys(parCc);
      if (!ccs.length) return;
      ccs.sort().forEach((cc) => {
        const g = parCc[cc];
        lignes.push("<tr><td>" + esc(b.nom) + "</td><td>" + esc(cc === "ADMIN" ? "Administrateur" : cc === "?" ? "—" : ccName(cc)) + '</td><td class="num">' + money2(r2(g.cout)) + '</td><td class="num">' + money2(r2(g.ca - g.cout)) +
          '</td><td class="num">' + money2(r2(g.ca)) + '</td><td class="num">' + money2(r2(g.recu)) + (g.attente > 0 ? ' <small class="muted">(⏳ ' + money2(r2(g.attente)) + ")</small>" : "") + '</td><td class="num">' + money2(r2(g.ca - g.recu)) + "</td><td></td></tr>");
      });
      const reliquat = i.solde;
      const etat = w === lundi ? '<span class="badge">Semaine en cours</span>'
        : reliquat > 0.5 && i.attente >= reliquat - 0.5 ? '<span class="badge warn">⏳ À valider</span>'
        : reliquat > 0.5 ? '<span class="badge danger">Reliquat ' + money2(reliquat) + "</span>"
        : i.total > 0 || i.recu > 0 ? '<span class="badge ok">✓ Soldé</span>' : "";
      lignes.push('<tr class="total-row"><td colspan="2"><b>Total ' + esc(b.nom) + '</b></td><td class="num"><b>' + money2(i.cout) + '</b></td><td class="num"><b>' + money2(i.benef) +
        '</b></td><td class="num"><b>' + money2(i.total) + '</b></td><td class="num"><b>' + money2(i.recu) + '</b></td><td class="num"><b' + (reliquat > 0.5 ? ' class="neg"' : "") + ">" + money2(Math.max(0, reliquat)) + "</b></td><td>" + etat + "</td></tr>");
    });
    $("#fr-fiches").innerHTML = lignes.join("") || '<tr><td colspan="8" class="empty">Aucune vente ni reversement pour cette semaine.</td></tr>';
  }
  $("#fr-semaine").addEventListener("change", () => renderFrigo());

  // Transfert de l'ancien stock principal vers le frigo (admin) : course marquée « à confirmer » tant que la boutique n'a pas recompté
  const TAG_PROVISOIRE = "(transfert du stock — à confirmer)";
  const transfertProvisoire = (bq) => db.fgCourses.find((c) => c.boutique === bq && c.saisiPar.includes(TAG_PROVISOIRE)) || null;
  const stockPrincipalRestant = (bq) => db.products.map((p) => ({ p, q: r2_(stockActuel(p, bq)) })).filter((x) => x.q > 0);
  function renderTransfertInfo(scope) {
    const admin = isAdmin(), une = scope.length === 1, bq = une ? scope[0].code : "";
    $("#fs-raz").classList.toggle("hidden", !(admin && une && db.fgCourses.some((c) => c.boutique === bq)));
    const tp = une ? transfertProvisoire(bq) : null;
    $("#fs-transfert-info").innerHTML = tp ? '<div class="alert-line" style="margin:0 0 12px">⚠ <span><b>Stock provisoire</b> — transfert de l’ancien stock principal du ' + fmtDate(tp.date) +
      " à confirmer avec la boutique. " + (admin ? "Corrigez le Stock actuel des produits après le comptage (ces corrections modifient le transfert, sans perte pour la boutique), puis confirmez." : "Les quantités seront confirmées par l’administrateur.") + "</span>" +
      (admin ? '<button class="btn small success" data-fs-tr-ok="' + tp.id + '">✓ Confirmer le transfert</button>' : "") + "</div>" : "";
  }
  // Remise à zéro du frigo d'une boutique (admin) : stock de chaque produit à 0 et stock restant au coût d'achat à 0,
  // SANS compter de perte pour la boutique (on repart d'une nouvelle course)
  const estRaz = (a) => /^RAZ/.test(a.note || "");
  $("#fs-raz").addEventListener("click", async (e) => {
    const scope = frigoScope(); if (!isAdmin() || scope.length !== 1) return toast("Choisissez une boutique.");
    const bq = scope[0].code, nomBq = boutiqueName(bq);
    const codesFg = [...new Set([...(db.fgLignes || []).filter((l) => l.boutique === bq && l.code).map((l) => l.code), ...(db.fgAjust || []).filter((a) => a.boutique === bq && a.code && a.code !== "_RAZ").map((a) => a.code)])];
    const rows = codesFg.map((code) => ({ code, q: r2_(stockFrigoOf(code, bq)) })).filter((x) => x.q !== 0)
      .map((x) => ({ boutique: bq, code: x.code, qte: -x.q, cout_unit: dernierAchatFrigo(x.code, bq) }));
    const restant = r2_(frigoInfo(bq, today().slice(0, 7)).restant);
    let val = r2_(rows.reduce((a, r) => a + r.qte * r.cout_unit, 0));
    const diff = r2_(-restant - val); // écart d'arrondi / frais : ligne d'argent seule pour arriver à 0 exactement
    if (Math.abs(diff) > 0.004) rows.push({ boutique: bq, code: "_RAZ", qte: 1, cout_unit: diff });
    if (!rows.length) return toast("Le frigo de " + nomBq + " est déjà à zéro.");
    // Confirmation dans une fenêtre de l'application : récapitulatif, puis nom de la boutique à taper
    const nbProd = rows.filter((r) => r.code !== "_RAZ").length;
    $("#raz-recap").innerHTML = "<p>Boutique : <b>" + esc(nomBq) + "</b></p><ul>" +
      "<li>Stock de chaque produit → <b>0</b> (" + nbProd + " produit" + (nbProd > 1 ? "s" : "") + ")</li>" +
      "<li>Stock restant au coût d'achat → <b>0</b> (au lieu de " + money2(restant) + ")</li>" +
      "<li>Ce n'est <b>pas une perte</b> pour la boutique : rien à reverser en plus</li>" +
      "<li>L'historique des ventes et des versements est gardé</li></ul><p class=\"hint\">Vous repartez ensuite d'une nouvelle course.</p>";
    $("#raz-nom").textContent = nomBq;
    const dlg = $("#raz-dialog"), champ = $("#raz-saisie"), oui = $("#raz-oui");
    champ.value = ""; oui.disabled = true;
    champ.oninput = () => { oui.disabled = champ.value.trim().toUpperCase() !== nomBq.trim().toUpperCase(); };
    dlg.returnValue = "";
    const ok = await new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue === "oui"); dlg.showModal(); setTimeout(() => champ.focus(), 50); });
    if (!ok || champ.value.trim().toUpperCase() !== nomBq.trim().toUpperCase()) return toast("Remise à zéro annulée.");
    const nom = me.nom || me.email || "";
    act(async () => chk(await sb.from("frigo_ajustements").insert(rows.map((r) => Object.assign(r, { date: today(), note: "RAZ — Remise à zéro du frigo", saisi_par: nom })))),
      "Frigo de " + nomBq + " remis à zéro : faites maintenant la nouvelle course.", e.target);
  });
  $("#fs-transfert") && $("#fs-transfert").addEventListener("click", (e) => {
    const scope = frigoScope(); if (!isAdmin() || scope.length !== 1) return toast("Choisissez une boutique.");
    const bq = scope[0].code, reste = stockPrincipalRestant(bq);
    if (!reste.length) return toast("Plus rien dans le stock principal de " + boutiqueName(bq) + ".");
    const lignes = reste.map((x) => ({ code: x.p.code, nom: x.p.nom, qte: x.q, achat: r2_(Number(x.p.cmp) || 0), vente: Number(x.p.pv) || 0, transfert: true }));
    const achats = r2_(lignes.reduce((a, l) => a + l.qte * l.achat, 0)), vente = r2_(lignes.reduce((a, l) => a + l.qte * l.vente, 0));
    if (!confirm("Transférer l'ancien stock principal de " + boutiqueName(bq) + " vers son frigo ?\n\n" +
      lignes.slice(0, 25).map((l) => "• " + l.nom + " : " + num(l.qte)).join("\n") + (lignes.length > 25 ? "\n… (" + lignes.length + " produits)" : "") +
      "\n\nValeur d'achat : " + money2(achats) + " · valeur de vente : " + money2(vente) +
      "\n\nCes quantités sont PROVISOIRES : corrigez-les après le comptage avec la boutique, puis confirmez le transfert.")) return;
    act(async () => {
      const c = chk(await sb.from("frigo_courses").insert({ boutique: bq, date: today(), valeur_vente: vente, montant_course: achats, saisi_par: (me.nom || me.email || "Admin") + " " + TAG_PROVISOIRE }).select("id").single());
      const r = await sb.from("frigo_courses_details").insert({ course_id: c.id, lignes, total_achats: achats, frais_deplacement: 0, frais_sachet: 0, frais_autres: 0, frais_autres_lib: "", total_course: achats });
      if (r.error) { await sb.from("frigo_courses").delete().eq("id", c.id); chk(r); }
    }, "Stock principal transféré dans le frigo de " + boutiqueName(bq) + " (provisoire, à confirmer).", e.target);
  });
  $("#fs-transfert-info").addEventListener("click", (e) => {
    const b = e.target.closest("[data-fs-tr-ok]"); if (!b || !isAdmin()) return;
    const tp = db.fgCourses.find((c) => c.id === b.dataset.fsTrOk); if (!tp) return;
    if (!confirm("Confirmer le transfert du " + fmtDate(tp.date) + " (" + boutiqueName(tp.boutique) + ") ?\n\nLes quantités ont été recomptées avec la boutique. Après confirmation, toute correction de stock comptera comme une perte ou un surplus.")) return;
    act(async () => chk(await sb.from("frigo_courses").update({ saisi_par: tp.saisiPar.replace(TAG_PROVISOIRE, "(transfert du stock)").trim() }).eq("id", tp.id)), "Transfert confirmé.", b);
  });
  // Correction d'un produit d'un transfert provisoire : on modifie la quantité transférée (et les totaux), pas de perte
  async function corrigerTransfert(tp, code, ecart) {
    const d = chk(await sb.from("frigo_courses_details").select("*").eq("course_id", tp.id).single());
    const lignes = (d.lignes || []).map((l) => Object.assign({}, l));
    const l = lignes.find((x) => x.code === code);
    if (!l) throw new Error("Produit absent du transfert");
    const nq = r2_(Number(l.qte) + ecart);
    if (nq < 0) throw new Error("Quantité transférée négative");
    l.qte = nq;
    const achats = r2_(lignes.reduce((a, x) => a + Number(x.qte) * Number(x.achat || 0), 0)), vente = r2_(lignes.reduce((a, x) => a + Number(x.qte) * Number(x.vente || 0), 0));
    chk(await sb.from("frigo_courses_details").update({ lignes, total_achats: achats, total_course: achats }).eq("course_id", tp.id));
    chk(await sb.from("frigo_courses").update({ montant_course: achats, valeur_vente: vente }).eq("id", tp.id));
  }
  function renderStockFrigo(scope) {
    renderTransfertInfo(scope);
    const admin = isAdmin(), codes = scope.map((b) => b.code), q = $("#fs-search").value.trim().toLowerCase();
    $("#fs-title").textContent = "Stock frigo — " + (scope.length === 1 ? scope[0].nom : scope.length ? "toutes les boutiques" : "aucune boutique");
    const lignes = db.fgLignes.filter((l) => codes.includes(l.boutique) && l.code);
    const sorties = db.fgSorties.filter((x) => codes.includes(x.boutique));
    const parCode = new Map();
    lignes.forEach((l) => {
      const r = parCode.get(l.code) || { code: l.code, nom: l.nom, entrees: 0, sorties: 0, achat: null, achatAt: "" };
      r.entrees += l.qte;
      if (l.achat != null && String(l.createdAt) >= r.achatAt) { r.achat = l.achat; r.achatAt = String(l.createdAt); }
      parCode.set(l.code, r);
    });
    sorties.forEach((x) => { const r = parCode.get(x.code); if (r) r.sorties += x.qte; });
    // Tous les produits du catalogue apparaissent (stock 0 tant qu'aucune course ne les contient)
    db.products.forEach((p) => { if (!parCode.has(p.code)) parCode.set(p.code, { code: p.code, nom: p.nom, entrees: 0, sorties: 0, achat: null, achatAt: "" }); });
    const rows = Array.from(parCode.values()).map((r) => {
      const p = db.products.find((y) => y.code === r.code);
      r.ajust = sumBy((db.fgAjust || []).filter((a) => codes.includes(a.boutique) && a.code === r.code), (a) => a.qte);
      const stock = r.entrees - r.sorties + r.ajust, pv = p ? Number(p.pv) : 0, s = Math.max(0, stock);
      const statut = stock <= 0 ? "RUPTURE" : p && Number(p.stockMin) > 0 && stock <= Number(p.stockMin) ? "STOCK FAIBLE" : "OK";
      return Object.assign(r, { nom: p ? p.nom : r.nom, categorie: p ? p.categorie : "", pv, stock, statut,
        valAchat: r.achat != null ? s * r.achat : 0, valVente: s * pv });
    }).sort((a, b) => (a.stock > 0) === (b.stock > 0) ? a.nom.localeCompare(b.nom) : a.stock > 0 ? -1 : 1);
    // Vue choisie en cliquant sur les cases : tous les produits, en stock, en rupture, sous le seuil
    const enVue = { tous: () => true, stock: (r) => r.stock > 0, rupture: (r) => r.statut === "RUPTURE", seuil: (r) => r.statut === "STOCK FAIBLE" };
    const vueLib = { tous: "tous les produits", stock: "produits en stock", rupture: "produits en rupture", seuil: "produits sous le seuil" };
    $("#fs-title").textContent += " · " + vueLib[fsVue];
    const list = rows.filter((r) => enVue[fsVue](r) && (!q || (r.nom + " " + r.code + " " + r.categorie).toLowerCase().includes(q)));
    const tot = (l, f) => l.reduce((a, r) => a + f(r), 0);
    const tile = (v) => 'data-fsv="' + v + '" title="Cliquer pour afficher les ' + vueLib[v] + '" style="cursor:pointer' + (fsVue === v ? ";outline:2px solid var(--primary)" : "") + '"';
    const k = [["Produits", rows.length, "", tile("tous")], ["En stock", rows.filter(enVue.stock).length, "", tile("stock")], ["Stock total", num(tot(rows, (r) => r.stock))]];
    if (admin) k.push(["Coût du stock (achat)", money2(tot(rows, (r) => r.valAchat))]);
    k.push(["Coût du stock (vente)", money2(tot(rows, (r) => r.valVente))]);
    if (admin) { const b = tot(rows, (r) => r.valVente - r.valAchat); k.push(["Bénéfice du stock", money2(b), b < 0 ? "danger" : "hero-good"]); }
    k.push(["En rupture", rows.filter(enVue.rupture).length, "danger", tile("rupture")]);
    k.push(["Sous seuil", rows.filter(enVue.seuil).length, "warn", tile("seuil")]);
    $("#fs-kpis").innerHTML = kpiHtml(k);
    $("#fs-rows").innerHTML = list.length ? list.map((r) =>
      "<tr><td>" + esc(r.code) + "</td><td>" + esc(r.nom) +
      (admin && db.products.some((p) => p.code === r.code) ? ' <button class="btn-bic" data-fs-nom="' + esc(r.code) + '" title="Modifier le nom du produit">✏️</button>' : "") +
      (admin && (productByCode(r.code) || {}).valide === false ? ' <button class="btn small success" data-fs-valid="' + esc(r.code) + '" title="Produit créé par un CC : à valider">✓ Valider</button>' : "") +
      "</td><td>" + esc(r.categorie) +
      '</td><td class="num admin-only">' + (r.achat != null ? money2(r.achat) : '<span class="muted">—</span>') + '</td><td class="num">' +
      (admin && db.products.some((p) => p.code === r.code)
        ? '<input type="number" min="0" step="any" class="inline-input si-input" data-fs-pv="' + esc(r.code) + '" value="' + r.pv + '" title="Prix de vente de ' + esc(r.nom) + ' (Entrée pour valider)">'
        : num(r.pv)) +
      '</td><td class="num admin-only">' + (r.achat != null ? '<b class="delta ' + (r.pv - r.achat < 0 ? "down" : "up") + '">' + (r.pv - r.achat > 0 ? "+" : "") + money2(r.pv - r.achat) + "</b>" : '<span class="muted">—</span>') +
      '</td><td class="num">' + num(r.entrees) + '</td><td class="num">' + num(r.sorties) + '</td><td class="num">' +
      (admin && scope.length === 1
        ? '<input type="number" min="0" step="any" class="inline-input si-input" data-fs-stock="' + esc(r.code) + '" value="' + r2_(r.stock) + '" title="Corriger le stock actuel de ' + esc(r.nom) + ' à ' + esc(scope[0].nom) + ' (Entrée pour valider)">'
        : "<b>" + num(r.stock) + "</b>") +
      (r.ajust ? '<span class="sub" title="Corrections de stock faites par l’administrateur">corrigé ' + (r.ajust > 0 ? "+" : "") + num(r.ajust) + "</span>" : "") +
      '</td><td class="num admin-only">' + money2(r.valAchat) + '</td><td class="num admin-only">' + (r.achat != null ? beneStockHtml(r.valVente - r.valAchat) : '<span class="muted">—</span>') +
      '</td><td class="num">' + money2(r.valVente) + "</td><td>" + statutBadge(r.statut) + "</td></tr>").join("")
      : '<tr><td colspan="13" class="empty">' + (q ? "Aucun produit ne correspond à la recherche." : "Aucun produit dans cette vue (" + vueLib[fsVue] + ").") + "</td></tr>";
    $("#fs-foot").innerHTML = list.length ? '<tr class="total-row"><td colspan="3"><b>TOTAL' + (q ? " (recherche)" : "") + '</b></td><td class="admin-only"></td><td></td><td class="admin-only"></td><td class="num"><b>' + num(tot(list, (r) => r.entrees)) +
      '</b></td><td class="num"><b>' + num(tot(list, (r) => r.sorties)) + '</b></td><td class="num"><b>' + num(tot(list, (r) => r.stock)) + '</b></td><td class="num admin-only"><b>' + money2(tot(list, (r) => r.valAchat)) +
      '</b></td><td class="num admin-only">' + beneStockHtml(tot(list, (r) => r.valVente - r.valAchat), true) + '</td><td class="num"><b>' + money2(tot(list, (r) => r.valVente)) + "</b></td><td></td></tr>" : "";
  }
  $("#fs-search").addEventListener("input", () => renderStockFrigo(frigoScope()));
  $("#fs-kpis").addEventListener("click", (e) => { const t = e.target.closest("[data-fsv]"); if (!t) return; fsVue = t.dataset.fsv; renderStockFrigo(frigoScope()); });
  // Modifier le nom d'un produit (admin) : petit crayon à côté de la désignation
  $("#fs-rows").addEventListener("click", (e) => {
    // Validation des produits créés par un CC (l'ancien bouton était dans le menu Stock, retiré)
    const va = e.target.closest("[data-fs-valid]");
    if (va && isAdmin()) {
      const p = productByCode(va.dataset.fsValid); if (!p) return;
      if (!confirm("Valider le produit « " + p.nom + " » ?\nCatégorie : " + p.categorie + "\nPrix de vente : " + money(p.pv) + "\n\nVérifiez le nom (✏️) et le prix de vente avant de valider.")) return;
      return act(async () => chk(await sb.from("products").update({ valide: true }).eq("code", p.code)), "Produit validé : " + p.nom, va);
    }
    const b = e.target.closest("[data-fs-nom]"); if (!b || !isAdmin()) return;
    const p = productByCode(b.dataset.fsNom); if (!p) return;
    const v = prompt("Nouveau nom du produit " + p.code + " :", p.nom); if (v == null) return;
    const nom = v.trim().toUpperCase();
    if (nom.length < 2) return toast("Indiquez un nom d'au moins 2 caractères.");
    if (nom === p.nom) return;
    const deja = db.products.find((x) => x.code !== p.code && String(x.nom).trim().toUpperCase() === nom);
    if (deja) return toast("Ce nom est déjà utilisé par " + deja.code + ".");
    act(async () => chk(await sb.from("products").update({ nom }).eq("code", p.code)), "Produit " + p.code + " renommé : " + nom + ".", b);
  });
  // Corriger le stock actuel d'un produit du frigo (admin, une boutique choisie) : enregistre l'écart, pris en compte partout
  // (Caisse : stock disponible et rupture, valeur et bénéfice du stock, estimation du stock disponible du tableau de bord)
  $("#fs-rows").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-fs-stock]"); if (!inp || !isAdmin()) return;
    const scope = frigoScope(); if (scope.length !== 1) return toast("Choisissez d'abord une boutique.");
    const bq = scope[0].code, code = inp.dataset.fsStock, p = productByCode(code), nom = p ? p.nom : code;
    const actuel = r2_(stockFrigoOf(code, bq)), v = Number(inp.value);
    if (!(inp.value !== "" && v >= 0)) { inp.value = actuel; return toast("Indiquez un stock valide (0 ou plus)."); }
    const ecart = r2_(v - actuel);
    if (!ecart) return;
    const tp = transfertProvisoire(bq), dansTp = tp && tp.detail && tp.detail.lignes.some((l) => l.code === code);
    if (dansTp) {
      if (!confirm("Transfert provisoire : la quantité transférée de « " + nom + " » sera corrigée de " + (ecart > 0 ? "+" : "") + num(ecart) + " (stock " + num(actuel) + " → " + num(v) + ").\n\nCe n'est pas une perte pour la boutique. Confirmer ?")) { inp.value = actuel; return; }
      return act(() => corrigerTransfert(tp, code, ecart), "Transfert corrigé : " + nom + " → " + num(v) + ".", inp);
    }
    if (!confirm("Corriger le stock frigo de « " + nom + " » à " + boutiqueName(bq) + " : " + num(actuel) + " → " + num(v) + " (" + (ecart > 0 ? "+" : "") + num(ecart) + ").\n\nValeur au coût d'achat : " + (ecart > 0 ? "+" : "−") + money2(Math.abs(ecart) * dernierAchatFrigo(code, bq)) + " (" + money2(dernierAchatFrigo(code, bq)) + " l'unité)." + (ecart < 0 ? " Une perte est comptée dans le coût d'achat à reverser de la semaine." : "") + "\n\nLe nouveau stock s'applique partout (Caisse, valeur du stock, tableau de bord, reversement). Confirmer ?")) { inp.value = actuel; return; }
    act(async () => chk(await sb.from("frigo_ajustements").insert({ boutique: bq, code, qte: ecart, cout_unit: dernierAchatFrigo(code, bq), date: today(), note: "Stock corrigé de " + actuel + " à " + v, saisi_par: me.nom || me.email || "" })),
      "Stock frigo de " + nom + " corrigé : " + num(v) + ".", inp);
  });
  // Modifier le prix de vente d'un produit du frigo (admin) : c'est le prix du catalogue, utilisé aussi par la Caisse
  $("#fs-rows").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-fs-pv]"); if (!inp || !isAdmin()) return;
    const p = productByCode(inp.dataset.fsPv), pv = Number(inp.value);
    if (!p) return;
    if (!(inp.value !== "" && pv >= 0)) { inp.value = p.pv; return toast("Indiquez un prix de vente valide (0 ou plus)."); }
    if (pv === Number(p.pv)) return;
    if (!confirm("Nouveau prix de vente de « " + p.nom + " » : " + money(pv) + " (au lieu de " + money(p.pv) + ").\n\nCe prix s'applique aussi en Caisse pour les prochaines ventes. Confirmer ?")) { inp.value = p.pv; return; }
    act(async () => chk(await sb.from("products").update({ pv }).eq("code", p.code)), "Prix de vente de " + p.nom + " : " + money(pv) + ".", inp);
  });
  // Récap mensuel du frigo
  function renderRecapFrigo(scope) {
    const admin = isAdmin(), mois = $("#fg-mois").value || today().slice(0, 7), nomMois = fmtMonth(mois + "-01"), codes = scope.map((b) => b.code);
    $("#fr-titre").textContent = "Récap du frigo — " + nomMois;
    $("#fr-sous").textContent = (scope.length === 1 ? scope[0].nom : scope.length === db.boutiques.length ? "Toutes les boutiques" : scope.length + " boutiques") + " · édité le " + fmtDate(today());
    const ventes = db.fgSorties.filter((x) => codes.includes(x.boutique) && x.date.slice(0, 7) === mois);
    const courses = db.fgCourses.filter((c) => codes.includes(c.boutique) && c.date.slice(0, 7) === mois);
    const retraits = db.fgRetraits.filter((r) => codes.includes(r.boutique) && r.date.slice(0, 7) === mois);
    const k = (label, val, sub, cls) => '<div class="kpi ' + (cls || "") + '"><div class="label">' + label + '</div><div class="value">' + val + (sub ? "<small>" + sub + "</small>" : "") + "</div></div>";
    $("#fr-kpis").innerHTML = k("Courses (crédit vente)", money2(sumBy(courses, (c) => c.cout)), courses.length + " course" + (courses.length > 1 ? "s" : "") + " · achats + frais") +
      k("Estimation des ventes", money2(sumBy(courses, (c) => c.valeur)), "prix de vente × quantité achetée") +
      k("Vendu en caisse", money2(sumBy(ventes, (x) => x.montant)), num(sumBy(ventes, (x) => x.qte)) + " article(s)" + (admin ? " · crédit consommé " + money2(sumBy(ventes, (x) => x.consomme)) : "")) +
      (admin ? k("Bénéfice estimé", money2(sumBy(courses, (c) => c.valeur - c.cout)), "somme des marges des produits achetés", "hero") +
        k("Retraits", money2(sumBy(retraits, (r) => r.montant)), retraits.length + " retrait" + (retraits.length > 1 ? "s" : "")) : "");
    $("#fr-bq-card").classList.toggle("hidden", scope.length < 2);
    if (scope.length > 1) {
      $("#fr-bq-head").innerHTML = "<tr><th>Boutique</th><th class=\"num\">Vendu en caisse</th><th class=\"num\">Estimation des ventes</th><th class=\"num\">Crédit vente restant</th>" + (admin ? '<th class="num">Bénéfice estimé</th><th class="num">Retraits</th>' : "") + "</tr>";
      $("#fr-bq").innerHTML = scope.filter((b) => db.fgCourses.some((c) => c.boutique === b.code)).map((b) => {
        const f = frigoInfo(b.code, mois);
        return "<tr><td><b>" + esc(b.nom) + '</b></td><td class="num">' + money2(f.venduMois) + '</td><td class="num">' + money2(f.estimationMois) + '</td><td class="num">' + money2(Math.max(0, f.restant)) + "</td>" +
          (admin ? '<td class="num pos">' + money2(f.benefMois) + '</td><td class="num">' + money2(sumBy(retraits.filter((r) => r.boutique === b.code), (r) => r.montant)) + "</td>" : "") + "</tr>";
      }).join("") || '<tr><td colspan="6" class="empty">Aucun frigo approvisionné.</td></tr>';
    }
    $("#fr-ventes-head").innerHTML = fgJoursHead(admin);
    $("#fr-ventes").innerHTML = fgJoursRows(codes, mois, admin);
    $("#fr-courses-head").innerHTML = "<tr><th>Date</th><th>Boutique</th><th class=\"num\">Total de la course (crédit vente)</th><th class=\"num\">Estimation des ventes</th>" + (admin ? '<th class="num">Bénéfice estimé</th>' : "") + "<th>Saisi par</th></tr>";
    $("#fr-courses").innerHTML = courses.length ? courses.slice().sort((a, b) => b.date.localeCompare(a.date)).map((c) => "<tr><td>" + fmtDate(c.date) + "</td><td>" + esc(boutiqueName(c.boutique)) + '</td><td class="num"><b>' + money2(c.cout) + '</b></td><td class="num">' + money2(c.valeur) + "</td>" +
      (admin ? '<td class="num pos">' + money2(c.valeur - c.cout) + "</td>" : "") + "<td>" + esc(c.saisiPar || "—") + "</td></tr>").join("")
      : '<tr><td colspan="6" class="empty">Aucune course en ' + esc(nomMois) + ".</td></tr>";
    if (admin) $("#fr-retraits").innerHTML = retraits.length ? retraits.slice().sort((a, b) => b.date.localeCompare(a.date)).map((r) => "<tr><td>" + fmtDate(r.date) + "</td><td>" + esc(boutiqueName(r.boutique)) +
      '</td><td class="num"><b>' + money2(r.montant) + "</b></td><td>" + esc(r.note || "—") + "</td><td>" + esc(r.saisiPar || "—") + "</td></tr>").join("") : '<tr><td colspan="5" class="empty">Aucun retrait en ' + esc(nomMois) + ".</td></tr>";
  }

  // ---------- Paramètres ----------
  function renderParametres() {
    document.querySelectorAll("#p-form [data-k]").forEach((i) => { i.value = db.settings[i.dataset.k] || ""; });
    renderUsers();
  }

  // ---------- RH : boutiques et affectation des CC ----------
  function renderRh() {
    setRhTab(rhTab);
    renderPerms();
    renderRhFilters();
    // Ne pas effacer une saisie en cours dans la fiche (mise à jour temps réel)
    const typing = document.activeElement && $("#rh-fiche").contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (!typing) renderFiche();
    renderPlanning();
    // Boutiques en cartes : nom modifiable, CC affectés en pastilles, actions
    $("#bq-rows").innerHTML = db.boutiques.length ? db.boutiques.map((b) => {
      const ccs = db.settings.ccList.filter((c) => c.boutique === b.code && c.actif);
      const enService = ccs.filter((c) => ccStatusOn(c.code, today()).k === "service").length;
      // Une ligne par boutique (liste compacte)
      return '<tr class="' + (b.actif ? "" : "off-row") + '"><td><input class="inline-input bq-name" data-bq-nom="' + esc(b.code) + '" value="' + esc(b.nom) + '" title="Tapez le nom puis Entrée"></td>' +
        '<td class="muted">' + esc(b.code) + '</td><td class="wrap"><div class="chips">' +
        (ccs.length ? ccs.map((c) => '<button class="chip" data-open-fiche="' + esc(c.code) + '" title="Ouvrir la fiche">' + avatarHtml(c.code, "xs") + esc(ccName(c.code)) + "</button>").join("") : '<span class="muted">Aucun CC</span>') +
        '</div></td><td class="num"><b>' + enService + "</b> / " + ccs.length + "</td><td>" +
        (b.actif ? '<span class="badge ok">Active</span>' : '<span class="badge mute">Inactive</span>') + '</td><td style="white-space:nowrap">' +
        '<button class="btn small" data-bq-actif="' + esc(b.code) + '">' + (b.actif ? "Désactiver" : "Activer") + "</button> " +
        '<button class="btn small danger" data-bq-del="' + esc(b.code) + '" title="Supprimer la boutique">🗑</button></td></tr>';
    }).join("") : '<tr><td colspan="6" class="empty">Aucune boutique.</td></tr>';
    renderCcTable();
    renderRhKpis();
  }
  // Pastille avec initiales, couleur stable par CC
  const AV_COLORS = ["#2a78d6", "#eb6834", "#17804a", "#8b5cf6", "#d63384", "#0f9aa8", "#b26b00", "#4f5bd5"];
  function avatarHtml(code, size) {
    const nom = currentAgent(ccByCode(code)) || "";
    const ini = nom ? nom.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() : String(code).padStart(2, "0");
    return '<span class="avatar ' + (size || "") + '" style="background:' + AV_COLORS[(Number(code) || 0) % AV_COLORS.length] + '">' + esc(ini) + "</span>";
  }
  // Chiffres clés RH du jour
  function renderRhKpis() {
    const t = today(), act = db.settings.ccList.filter((c) => c.actif);
    const st = act.map((c) => ccStatusOn(c.code, t).k);
    const attente = db.users.filter((u) => !u.actif).length;
    $("#rh-kpis").innerHTML = kpiHtml([
      ["CC actifs", act.length],
      ["En service aujourd'hui", st.filter((k) => k === "service").length, "hero-good"],
      ["De repos", st.filter((k) => k === "repos").length],
      ["En congé", st.filter((k) => k === "conge").length, "warn"],
      ["Sans boutique", act.filter((c) => !c.boutique).length, act.some((c) => !c.boutique) ? "danger" : ""]
    ].concat(isAdmin() ? [["Comptes en attente", attente, attente ? "warn" : ""]] : [])); // les comptes : admin uniquement
  }
  $("#bq-rows").addEventListener("click", (e) => { const c = e.target.closest("[data-open-fiche]"); if (c) openFiche(c.dataset.openFiche); });
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
  // Âge et prochain anniversaire à partir de la date de naissance
  function ageDe(naiss) {
    const n = parse(naiss), t = parse(today());
    let a = t.getFullYear() - n.getFullYear();
    if (t.getMonth() < n.getMonth() || (t.getMonth() === n.getMonth() && t.getDate() < n.getDate())) a--;
    return a;
  }
  function prochainAnniv(naiss) {
    const t = today(), an = Number(t.slice(0, 4));
    let d = an + naiss.slice(4);
    if (naiss.slice(5) === "02-29" && new Date(an, 1, 29).getMonth() !== 1) d = an + "-02-28";
    if (d < t) d = (an + 1) + naiss.slice(4);
    const j = Math.round((parse(d) - parse(t)) / 86400000);
    return j === 0 ? "🎂 Aujourd'hui !" : fmtDate(d) + " (dans " + j + " jour" + (j > 1 ? "s" : "") + ")";
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
    $("#rh-boutique").innerHTML = '<option value="ALL">— Choisir une boutique —</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("") +
      '<option value="NONE">CC non affectés</option>';
    $("#rh-boutique").value = Array.from($("#rh-boutique").options).some((o) => o.value === bcur) ? bcur : "ALL";
    const b = $("#rh-boutique").value;
    const ccur = $("#rh-cc").value || "ALL";
    const list = db.settings.ccList.filter((c) => b === "ALL" || (b === "NONE" ? !c.boutique : c.boutique === b));
    $("#rh-cc").innerHTML = '<option value="ALL">— Choisir un CC —</option>' + list.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("");
    $("#rh-cc").value = list.some((c) => c.code === ccur) ? ccur : "ALL";
  }
  $("#rh-boutique").addEventListener("change", () => { renderRhFilters(); renderFiche(); renderPlanning(); });
  $("#rh-cc").addEventListener("change", () => {
    const cc = $("#rh-cc").value;
    if (cc !== "ALL" && $("#rh-boutique").value === "ALL" && ccBoutique(cc)) { $("#rh-boutique").value = ccBoutique(cc); renderRhFilters(); $("#rh-cc").value = cc; }
    renderFiche(); renderPlanning();
  });

  // Fiche RH complète d'un CC (admin)
  function renderFiche() {
    const bq = $("#rh-boutique").value;
    let code = $("#rh-cc").value;
    // Il faut d'abord choisir une boutique, puis cliquer sur un de ses CC
    if (!bq || bq === "ALL") {
      $("#rh-cc-chips").innerHTML = "";
      $("#rh-fiche").innerHTML = '<div class="card"><p class="hint" style="margin:0">🏬 Sélectionnez une <b>boutique</b> dans le filtre ci-dessus pour afficher ses CC et leurs fiches.</p></div>';
      return;
    }
    const ccsBq = db.settings.ccList.filter((c) => (bq === "NONE" ? !c.boutique : c.boutique === bq)).sort((a, b) => (a.actif === b.actif ? 0 : a.actif ? -1 : 1));
    if (code && code !== "ALL" && !ccsBq.some((c) => c.code === code)) code = "ALL";
    $("#rh-cc-chips").innerHTML = '<div class="card"><h2 style="margin-bottom:10px">CC de ' + esc(bq === "NONE" ? "aucune boutique" : boutiqueName(bq)) + "</h2>" +
      '<div class="chips">' + (ccsBq.length ? ccsBq.map((c) => '<button class="chip' + (c.code === code ? " chip-on" : "") + (c.actif ? "" : " chip-off") + '" data-fiche-cc="' + esc(c.code) + '">' +
        avatarHtml(c.code, "xs") + esc(ccName(c.code)) + "</button>").join("") : '<span class="muted">Aucun CC dans cette boutique.</span>') + "</div></div>";
    if (!code || code === "ALL") { $("#rh-fiche").innerHTML = '<div class="card"><p class="hint" style="margin:0">Cliquez sur un CC ci-dessus pour afficher sa fiche (repos, congés, contacts, notes).</p></div>'; return; }
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
      '<div class="fiche-head">' + avatarHtml(code, "lg") + "<h2>" + esc(ccName(code)) + (f.sexe === "F" ? " 👩" : f.sexe === "M" ? " 👨" : "") + "</h2>" + statusBadge(st) +
      (f.date_naissance && prochainAnniv(f.date_naissance).indexOf("Aujourd") >= 0 ? '<span class="badge" style="background:#fde7f3;color:#8a3b62">🎂 Anniversaire aujourd\'hui</span>' : "") +
      "<span>🏬 " + esc(boutiqueName(c.boutique)) + "</span>" + (c.actif ? "" : '<span class="badge mute">CC inactif</span>') + "</div>" +
      '<div class="fiche-grid">' +
      // Identité & contacts (admin uniquement)
      "<div><h3>Identité & contacts <span class=\"muted\">(confidentiel)</span></h3>" +
      '<div class="form">' +
      '<label>Sexe<select id="rf-sexe"><option value="">—</option><option value="F"' + (f.sexe === "F" ? " selected" : "") + '>Féminin</option><option value="M"' + (f.sexe === "M" ? " selected" : "") + ">Masculin</option></select></label>" +
      '<label>Date de naissance<input id="rf-naiss" type="date" value="' + esc(f.date_naissance || "") + '"></label>' +
      "<label>Âge<input readonly value=\"" + esc(f.date_naissance ? ageDe(f.date_naissance) + " ans" : "—") + '"></label>' +
      "<label>Prochain anniversaire<input readonly value=\"" + esc(f.date_naissance ? prochainAnniv(f.date_naissance) : "—") + '"></label>' +
      '<label>Téléphone<input id="rf-tel" type="tel" value="' + esc(f.telephone || "") + '" placeholder="Ex. : 90 12 34 56"></label>' +
      '<label>Contact d\'urgence<input id="rf-urg" value="' + esc(f.contact_urgence || "") + '" placeholder="Nom et téléphone"></label>' +
      '<label>Date d\'embauche<input id="rf-emb" type="date" value="' + esc(f.date_embauche || "") + '"></label>' +
      "<label>Ancienneté<input readonly value=\"" + esc(anciennete(f.date_embauche) || "—") + '"></label>' +
      '<label class="full">Notes RH (confidentielles)<textarea id="rf-notes" rows="3" placeholder="Remarques, avertissements, objectifs…">' + esc(f.notes || "") + "</textarea></label>" +
      "</div>" +
      (isAdmin() ? '<div class="info-row"><span>Compte de connexion</span><span>' + (user ? esc(user.email) + (user.actif ? "" : " (en attente)") : "Aucun compte lié") + "</span></div>" : "") +
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
      // Autorisations (admin uniquement)
      (isAdmin() ? "<div><h3>Autorisations</h3>" + permsHtml(c) + "</div>" : "") +
      // Historique
      '<div><h3>Historique des vendeurs du CC</h3><p class="hist" style="margin:0">' + hist + "</p></div>" +
      "</div></div>";
  }
  // Enregistrer la fiche
  $("#rh-fiche").addEventListener("click", (e) => {
    const code = $("#rh-cc").value;
    if (e.target.closest("#rf-save")) {
      const row = { cc: code, telephone: $("#rf-tel").value.trim(), contact_urgence: $("#rf-urg").value.trim(), date_embauche: $("#rf-emb").value || null, notes: $("#rf-notes").value.trim(),
        sexe: $("#rf-sexe").value, date_naissance: $("#rf-naiss").value || null, updated_at: new Date().toISOString() };
      if (row.date_naissance && row.date_naissance > today()) return toast("La date de naissance ne peut pas être dans le futur.");
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
    act(async () => chk(await sb.rpc("set_repos", { p_cc: code, p_repos: repos })), "Jours de repos : " + (repos.length ? repos.map((j) => JOURS_LONG[j - 1]).join(", ") : "aucun") + ".");
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

  // Présences d'un jour choisi (hier, aujourd'hui, demain…) selon la boutique et le CC filtrés
  let rhJour = "";
  function renderPlanning() {
    const b = $("#rh-boutique").value;
    // Il faut d'abord choisir une boutique
    if (!b || b === "ALL") {
      $("#rh-today").innerHTML = '<div class="card"><p class="hint" style="margin:0">🏬 Sélectionnez une <b>boutique</b> dans le filtre ci-dessus pour voir les CC au travail, de repos ou en congé.</p></div>';
      return;
    }
    const ccF = "";
    const list = db.settings.ccList.filter((c) => c.actif && (b === "NONE" ? !c.boutique : c.boutique === b));
    if (!rhJour) rhJour = today();
    const auj = rhJour, groupes = { service: [], repos: [], conge: [] };
    const ecart = Math.round((parse(auj) - parse(today())) / 86400000);
    const quand = ecart === 0 ? "Aujourd'hui" : ecart === -1 ? "Hier" : ecart === 1 ? "Demain" : "";
    list.forEach((c) => { const st = ccStatusOn(c.code, auj); groupes[st.k].push({ c, st }); });
    const col = (k, titre) => '<div class="today-col ' + k + '"><h3>' + titre + ' <span class="badge ' + k + '">' + groupes[k].length + "</span></h3>" +
      '<div class="chips">' + (groupes[k].length ? groupes[k].map((x) => '<button class="chip" data-plan-cc="' + esc(x.c.code) + '" title="' + esc(x.st.label) + '">' + avatarHtml(x.c.code, "xs") + esc(ccName(x.c.code)) +
        (b === "ALL" ? ' <small class="muted">· ' + esc(boutiqueName(x.c.boutique)) + "</small>" : "") + "</button>").join("") : '<span class="muted">Personne</span>') + "</div></div>";
    $("#rh-today").innerHTML = '<div class="card">' +
      '<div class="jour-nav"><button class="btn small" data-jour="-1">◀ Hier</button><input type="date" id="rh-jour" value="' + auj + '">' +
      '<button class="btn small" data-jour="1">Demain ▶</button>' + (ecart !== 0 ? '<button class="btn small primary" data-jour="0">Aujourd\'hui</button>' : "") + "</div>" +
      "<h2>" + (quand ? quand + ", " : "") + esc(fmtLong(auj)) + " — " + esc(b === "ALL" ? "toutes les boutiques" : b === "NONE" ? "CC non affectés" : boutiqueName(b)) +
      (ccF && ccF !== "ALL" ? " — " + esc(ccName(ccF)) : "") + "</h2>" +
      '<div class="today-grid">' + col("service", "✓ Au travail") + col("repos", "🛌 De repos") + col("conge", "🏖 En congé") + "</div>" +
      '<p class="hint" style="margin:12px 0 0">Cliquez sur un CC pour ouvrir sa fiche (repos, congés).</p></div>';
  }
  $("#rh-cc-chips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-fiche-cc]");
    if (!c) return;
    $("#rh-cc").value = c.dataset.ficheCc;
    renderFiche();
  });
  $("#rh-today").addEventListener("click", (e) => {
    const j = e.target.closest("[data-jour]");
    if (j) { rhJour = j.dataset.jour === "0" ? today() : addDays(rhJour || today(), Number(j.dataset.jour)); return renderPlanning(); }
    const c = e.target.closest("[data-plan-cc]");
    if (c) openFiche(c.dataset.planCc);
  });
  $("#rh-today").addEventListener("change", (e) => {
    if (e.target.id === "rh-jour" && e.target.value) { rhJour = e.target.value; renderPlanning(); }
  });

  // ---------- Mon compte (chaque utilisateur) ----------
  let mvJourOuvert = false;
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
        '<div class="info-row"><span>Affecté depuis</span><span>' + (agentDebut(c) ? fmtDate(agentDebut(c)) : "—") + "</span></div>" +
        '<div class="info-row"><span>Courses Frigo</span><span>' + (canEntrees() ? "✅ Autorisé" : "Non autorisé (géré par l'administrateur)") + "</span></div>" +
        '<div class="info-row"><span>Stock visible</span><span>' + (isAdmin() || c.voirStock ? "Toutes les boutiques" : "Ma boutique uniquement") + "</span></div>"
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
      const lj = my.filter((s) => s.date === t).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.ticket - a.ticket);
      h += '<div class="card"><h2>Mes ventes</h2><div class="report">' +
        '<div class="mv-click' + (mvJourOuvert ? " active" : "") + '" data-mv-jour title="Voir la liste des ventes du jour"><span>Aujourd\'hui ' + (mvJourOuvert ? "▲" : "▼") + "</span><strong>" + money(jour.ca) + "</strong></div><div><span>Tickets aujourd'hui</span><strong>" + num(jour.tickets) + "</strong></div>" +
        "<div><span>Ce mois</span><strong>" + money(m.ca) + "</strong></div><div><span>Jours d'activité ce mois</span><strong>" + joursActivite(code, mois) + "</strong></div></div></div>";
      if (mvJourOuvert) {
        h += '<div class="card" id="mv-jour-liste" style="grid-column:1/-1"><h2>🧾 Mes ventes du jour — ' + fmtDate(t) + "</h2>" +
          (lj.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Heure</th><th>Ticket</th><th>Client</th><th>Article</th><th class="num">Qté</th><th class="num">P.U.</th><th class="num">Montant</th></tr></thead><tbody>' +
            lj.map((s) => "<tr><td>" + (s.createdAt ? new Date(s.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—") + "</td><td>N° " + s.ticket + "</td><td>" +
              esc(!s.client || s.client === "CLIENT COMPTOIR" ? "PASSAGER" : s.client) + "</td><td>" + esc(s.nom || s.code) + '</td><td class="num">' + num(s.qte) + '</td><td class="num">' + money0(s.pu) + '</td><td class="num"><b>' + money0(lineTotal(s)) + "</b></td></tr>").join("") +
            '</tbody><tfoot><tr><th colspan="4">TOTAL (' + num(jour.tickets) + " ticket" + (jour.tickets > 1 ? "s" : "") + ')</th><th class="num">' + num(lj.reduce((a, s) => a + s.qte, 0)) + '</th><th></th><th class="num">' + money0(jour.ca) + "</th></tr></tfoot></table></div>"
            : '<p class="muted" style="margin:0">Aucune vente aujourd\'hui.</p>') + "</div>";
      }
    }
    // (cadre « Fonds reçus en espèces » supprimé avec le service « Reçoit les espèces »)
    $("#compte-body").innerHTML = h + "</div>";
  }
  $("#compte-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-mv-jour]")) {
      mvJourOuvert = !mvJourOuvert;
      renderCompte();
      if (mvJourOuvert) { const l = $("#mv-jour-liste"); if (l) l.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
      return;
    }
  });

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
        "<li><b>" + num(db.charges.filter((c) => c.boutique === b.code).length) + "</b> charge(s) de la boutique</li>" +
        "<li><b>" + num(ccs.length) + "</b> CC désaffecté(s) (ils restent dans RH, à réaffecter)</li>" +
        (b.code === INITIAL_BOUTIQUE ? "<li>Le <b>stock initial</b> repris de l'Excel est remis à <b>0</b> (le catalogue et les prix sont conservés)</li>" : "") +
        "</ul></div>" +
        (db.boutiques.length < 2 ? '<p class="v-alert danger">Créez d\'abord une autre boutique : il doit toujours en rester au moins une.</p>' : "") +
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
        (u.actif ? '<span class="badge ok">Actif</span>' : '<span class="badge warn">En attente</span>') +
        (u.must_change_pwd ? '<span class="sub">🔑 Mot de passe temporaire</span>' : "") + '</td><td class="wrap">' +
        (self ? '<span class="muted">(vous)</span>' : '<button class="btn small" data-ureset="1" title="Donner un mot de passe temporaire">🔑 Réinitialiser</button> ' + (u.actif
          ? '<button class="btn small" data-uactif="0">Suspendre</button>'
          : '<button class="btn small success" data-uactif="1">Valider</button>' + (u.role === "admin" ? "" : ' <button class="btn small danger" data-urefuse="1">Refuser</button>'))) +
        "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">Aucun utilisateur.</td></tr>';
  }
  // Mot de passe temporaire : 4 chiffres + 4 lettres majuscules, ex. « 4827KQMP »
  // (sans les lettres I et O, pour ne pas les confondre avec 1 et 0)
  function tempPassword() {
    const L = "ABCDEFGHJKLMNPQRSTUVWXYZ", r = new Uint32Array(8);
    crypto.getRandomValues(r);
    const chiffres = Array.from(r.slice(0, 4), (x) => String(x % 10)).join("");
    const lettres = Array.from(r.slice(4), (x) => L[x % L.length]).join("");
    return chiffres + lettres;
  }
  // Affiche le mot de passe temporaire à transmettre (copie, WhatsApp)
  function showTempPwd(titre, nom, email, pwd) {
    const url = location.origin + location.pathname;
    const msg = "Bonjour " + (nom || "") + ",\nVoici vos accès à l'application " + (db.settings.nom || "BGTeam") + " :\n" + url +
      "\nIdentifiant : " + email + "\nMot de passe temporaire : " + pwd + "\nÀ la première connexion, vous choisirez votre propre mot de passe.";
    $("#tp-title").textContent = titre;
    $("#tp-text").textContent = "Communiquez ce mot de passe temporaire à " + (nom || email) + " (" + email + "). Il ne sera plus affiché ensuite.";
    $("#tp-pwd").textContent = pwd;
    $("#tp-wa").href = "https://wa.me/?text=" + encodeURIComponent(msg);
    $("#tp-copy").onclick = () => {
      (navigator.clipboard ? navigator.clipboard.writeText(msg) : Promise.reject()).then(() => toast("Message copié."), () => prompt("Copiez ce message :", msg));
    };
    $("#temppwd-dialog").showModal();
  }
  // Création d'un utilisateur par l'admin
  $("#u-new").addEventListener("click", () => {
    const f = $("#newuser-form");
    f.reset();
    f.elements.cc.innerHTML = '<option value="">— Aucun —</option>' + db.settings.ccList.filter((c) => c.actif).map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("");
    f.elements.pwd.value = tempPassword();
    $("#newuser-dialog").showModal();
  });
  $("#nu-gen").addEventListener("click", () => { $("#newuser-form").elements.pwd.value = tempPassword(); });
  $("#newuser-form").addEventListener("submit", async (e) => {
    if (!e.submitter || e.submitter.value !== "ok") return;
    e.preventDefault();
    const f = e.target, btn = e.submitter;
    const v = { nom: f.elements.nom.value.trim(), email: f.elements.email.value.trim().toLowerCase(), role: f.elements.role.value, cc: f.elements.cc.value, pwd: f.elements.pwd.value.trim() };
    if (!v.nom || !v.email) return toast("Nom et e-mail obligatoires.");
    if (v.pwd.length < 8) return toast("Le mot de passe temporaire doit faire au moins 8 caractères.");
    const r = await act(async () => chk(await sb.rpc("admin_create_user", { p_email: v.email, p_nom: v.nom, p_password: v.pwd, p_role: v.role, p_cc: v.cc })), "Compte créé : " + v.email, btn);
    if (!r.ok) return;
    $("#newuser-dialog").close();
    // Un CC sans nom prend le nom de la personne
    const cc = v.cc && ccByCode(v.cc);
    if (cc && !currentAgent(cc)) setCcName(cc.code, v.nom, ccLabel(cc.code) + " lié à " + v.nom + ".");
    showTempPwd("Compte créé", v.nom, v.email, v.pwd);
  });
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
    const rs = e.target.closest("[data-ureset]");
    if (rs) {
      const u = db.users.find((x) => x.id === rs.closest("tr").dataset.uid);
      if (!u || !confirm("Réinitialiser le mot de passe de " + (u.nom || u.email) + " (" + u.email + ") ?\n\nUn mot de passe temporaire va être créé. La personne sera déconnectée et devra choisir un nouveau mot de passe à sa prochaine connexion.")) return;
      const pwd = tempPassword();
      return act(async () => chk(await sb.rpc("admin_reset_password", { p_id: u.id, p_password: pwd })), "Mot de passe réinitialisé : " + u.email, rs)
        .then((r) => { if (r.ok) showTempPwd("Mot de passe réinitialisé", u.nom, u.email, pwd); });
    }
    const rf = e.target.closest("[data-urefuse]");
    if (rf) {
      const u = db.users.find((x) => x.id === rf.closest("tr").dataset.uid);
      if (!u || !confirm("Refuser la demande de " + (u.nom || u.email) + " (" + u.email + ") ?\n\nLe compte sera supprimé : la personne devra faire une nouvelle demande pour accéder à l'application.")) return;
      return act(async () => chk(await sb.rpc("refuse_user", { p_id: u.id })), "Demande refusée : " + u.email + ".", rf);
    }
    const b = e.target.closest("[data-uactif]");
    if (!b) return;
    const id = b.closest("tr").dataset.uid;
    const actif = b.dataset.uactif === "1";
    if (!actif && !confirm("Suspendre ce compte ? La personne ne pourra plus se connecter à l'application.")) return;
    updateUser(id, { actif }, actif ? "Compte validé." : "Compte suspendu.", b);
  });

  // Codes commerciaux
  // Recherche d'un CC : code (« 2 », « 02 », « CC 02 »), nom du CC, vendeurs passés, boutique
  function ccMatch(c, q) {
    if (!q) return true;
    q = q.toLowerCase().trim();
    const num = q.replace(/^cc\s*/, "").replace(/^0+/, "");
    if (num && /^\d+$/.test(num) && String(Number(c.code)) === num) return true;
    return (ccLabel(c.code) + " " + ccName(c.code) + " " + c.agents.map((a) => a.nom).join(" ") + " " + boutiqueName(c.boutique)).toLowerCase().includes(q);
  }
  // Bloc d'autorisations d'un CC (utilisé dans l'onglet Autorisations et dans la fiche)
  function permsHtml(c) {
    return '<div class="perm-list">' +
      '<label class="perm"><span><b>🛒 Courses Frigo</b><small>Saisit les courses et remonte les fonds de sa boutique</small></span>' +
      '<input type="checkbox" class="switch" data-cc-entrees="' + esc(c.code) + '"' + (c.entrees ? " checked" : "") + "></label>" +
      '<label class="perm"><span><b>🌍 Toutes boutiques</b><small>Voit le stock, les fonds et les dépenses de toutes les boutiques</small></span>' +
      '<input type="checkbox" class="switch" data-cc-voirstock="' + esc(c.code) + '"' + (c.voirStock ? " checked" : "") + "></label>" +
      '<label class="perm"><span><b>📱 Achats de crédit</b><small>Enregistre les achats de crédit YAS / MOOV de sa boutique et verse la commission</small></span>' +
      '<input type="checkbox" class="switch" data-cc-credit="' + esc(c.code) + '"' + (c.credit ? " checked" : "") + "></label>" +
      '<label class="perm"><span><b>🧊 Dotation du frigo</b><small>Fixe la dotation de crédit du frigo des boutiques (la course du CC devra être égale à cette dotation)</small></span>' +
      '<input type="checkbox" class="switch" data-cc-frigodot="' + esc(c.code) + '"' + (c.frigoDotation ? " checked" : "") + "></label>" +
      '<label class="perm"><span><b>💼 Commissions</b><small>Tableau de bord des commissions du crédit télécom : demande le versement et confirme la réception</small></span>' +
      '<input type="checkbox" class="switch" data-cc-gerecom="' + esc(c.code) + '"' + (c.gereCom ? " checked" : "") + "></label>" +
      '<label class="perm"><span><b>🗂 Gère les fiches RH</b><small>Voit l\'onglet Fiche CC du menu RH : fiches, jours de repos et congés de tous les CC</small></span>' +
      '<input type="checkbox" class="switch" data-cc-rh="' + esc(c.code) + '"' + (c.gereRh ? " checked" : "") + "></label>" +
      '<label class="perm col"><span><b>🧻 Bobines</b><small>Accès au menu Bobines</small></span>' +
      '<select class="inline-select" data-cc-bobines="' + esc(c.code) + '">' +
      [["boutique", "Consultation (sa boutique)"], ["saisie", "Saisie utilisation (sa boutique)"], ["gestion", "Toutes + approvisionnement (sans saisie)"]].map(([v, l]) => '<option value="' + v + '"' + (c.bobines === v ? " selected" : "") + ">" + l + "</option>").join("") +
      "</select></label></div>";
  }
  // Titres : chaque titre coche un ensemble d'autorisations (« Reverser à tout moment » reste au cas par cas)
  const TITRES = [
    { id: "commercial", nom: "Commercial", p: { entrees: false, voirStock: false, credit: false, frigoDotation: false, gereRh: false, recoitEspeces: false, bobines: "boutique" } },
    { id: "caissier", nom: "Commercial caissier", p: { entrees: false, voirStock: false, credit: false, frigoDotation: false, gereRh: false, recoitEspeces: false, bobines: "saisie" } },
    { id: "manager-agent", nom: "Manager agent", p: { entrees: false, voirStock: false, credit: true, frigoDotation: false, gereRh: false, recoitEspeces: false, bobines: "boutique" } },
    { id: "manager", nom: "Manager", p: { entrees: true, voirStock: false, credit: true, frigoDotation: false, gereRh: false, recoitEspeces: false, bobines: "saisie" } },
    { id: "secretaire", nom: "Secrétaire", p: { entrees: true, voirStock: true, credit: true, frigoDotation: false, gereRh: true, recoitEspeces: false, bobines: "gestion" } },
    { id: "secretaire-dir", nom: "Secrétaire de direction", p: { entrees: false, voirStock: true, credit: true, frigoDotation: true, gereRh: true, recoitEspeces: false, bobines: "gestion" } },
    { id: "superviseur", nom: "Superviseur", p: { entrees: true, voirStock: true, credit: true, frigoDotation: true, gereRh: true, recoitEspeces: true, bobines: "gestion" } }
  ];
  const COLS_TITRE = { entrees: "entrees", voirStock: "voir_stock", credit: "credit", frigoDotation: "frigo_dotation", gereRh: "gere_rh", recoitEspeces: "recoit_especes", bobines: "bobines" };
  function titreDe(c) { const t = TITRES.find((x) => Object.keys(x.p).every((k) => (k === "bobines" ? c.bobines : !!c[k]) === x.p[k])); return t ? t.id : ""; }
  function renderPerms() {
    // Par défaut : ATILAMONOU
    const defBq = (db.boutiques.find((x) => /^ATILAMONOU/i.test(x.nom)) || {}).code || "ALL";
    const bcur = $("#rp-boutique").value || defBq;
    $("#rp-boutique").innerHTML = '<option value="ALL">Toutes les boutiques</option>' + db.boutiques.map((b) => '<option value="' + esc(b.code) + '">' + esc(b.nom) + "</option>").join("") + '<option value="NONE">CC non affectés</option>';
    $("#rp-boutique").value = Array.from($("#rp-boutique").options).some((o) => o.value === bcur) ? bcur : "ALL";
    const b = $("#rp-boutique").value, f = $("#rp-filtre").value;
    const dansBq = (c) => (f === "inactifs" ? !c.actif : c.actif) && (b === "ALL" || (b === "NONE" ? !c.boutique : c.boutique === b));
    // Filtre CC : les CC de la boutique choisie
    const ccCur = $("#rp-cc").value, ccsBq = db.settings.ccList.filter(dansBq);
    $("#rp-cc").innerHTML = '<option value="">Tous les CC' + (b !== "ALL" && b !== "NONE" ? " de " + esc(boutiqueName(b)) : "") + " (" + ccsBq.length + ")</option>" +
      ccsBq.map((c) => '<option value="' + esc(c.code) + '">' + esc(ccName(c.code)) + "</option>").join("");
    $("#rp-cc").value = ccsBq.some((c) => c.code === ccCur) ? ccCur : "";
    const cc = $("#rp-cc").value;
    const list = ccsBq.filter((c) => (!cc || c.code === cc) &&
      (!f || f === "inactifs" || (f === "entrees" && c.entrees) || (f === "global" && c.voirStock) || (f === "rh" && c.gereRh) || (f === "credit" && c.credit) || (f === "frigodot" && c.frigoDotation) || (f === "gerecom" && c.gereCom) ||
        (f === c.bobines)));
    $("#rp-count").textContent = list.length + " CC affiché(s). Cochez ou décochez : chaque changement est enregistré immédiatement.";
    const caseP = (c, attr, on) => '<td class="c"><input type="checkbox" class="pt-check" data-' + attr + '="' + esc(c.code) + '"' + (on ? " checked" : "") + "></td>";
    $("#rh-perms").innerHTML = list.length ? list.map((c) => {
      return "<tr" + (c.actif ? "" : ' class="pending"') + '><td class="pt-cc">' + avatarHtml(c.code) + "<div><b>" + esc(ccName(c.code)) + "</b><small>" + esc(c.boutique ? boutiqueName(c.boutique) : "Non affecté") + "</small></div></td>" +
        caseP(c, "cc-entrees", c.entrees) + caseP(c, "cc-voirstock", c.voirStock) + caseP(c, "cc-credit", c.credit) +
        caseP(c, "cc-frigodot", c.frigoDotation) + caseP(c, "cc-gerecom", c.gereCom) + caseP(c, "cc-rh", c.gereRh) +
        '<td><select class="inline-select" data-cc-bobines="' + esc(c.code) + '">' +
          [["boutique", "Consultation"], ["saisie", "Saisie utilisation"], ["gestion", "Toutes + appro."]].map(([v, l]) => '<option value="' + v + '"' + (c.bobines === v ? " selected" : "") + ">" + l + "</option>").join("") + "</select></td>" +
        '<td><button class="btn small" data-open-fiche="' + esc(c.code) + '">Fiche</button></td></tr>';
    }).join("") : '<tr><td colspan="9" class="empty">Aucun CC ne correspond aux filtres.</td></tr>';
  }
  ["#rp-boutique", "#rp-cc", "#rp-filtre"].forEach((id) => $(id).addEventListener("change", renderPerms));
  // Choisir un titre : applique d'un coup ses autorisations
  $("#rh-perms").addEventListener("change", (e) => {
    const s = e.target.closest("[data-cc-titre]"); if (!s) return;
    const t = TITRES.find((x) => x.id === s.value); if (!t) return;
    const code = s.dataset.ccTitre, row = {};
    Object.keys(t.p).forEach((k) => { row[COLS_TITRE[k]] = t.p[k]; });
    act(async () => chk(await sb.from("ccs").update(row).eq("code", code)), ccName(code) + " : titre « " + t.nom + " » appliqué.", s);
  });
  $("#cc-search").addEventListener("input", renderCcTable);

  // Onglets de la rubrique RH (le dernier onglet ouvert est mémorisé)
  let rhTab = "perms";
  try { rhTab = localStorage.getItem("rhTab") || "perms"; } catch (e) {}
  function setRhTab(t) {
    // CC « RH » : seulement Fiche CC et Planning
    if (isRhCc() && !["fiche", "planning"].includes(t)) t = "fiche";
    $("#rh-filters").classList.toggle("hidden", !["fiche", "planning"].includes(t));
    // Le choix du CC se fait en cliquant sur ses pastilles : le filtre « Code commercial » est masqué
    $("#rh-cc").closest("label").classList.add("hidden");
    rhTab = t;
    try { localStorage.setItem("rhTab", t); } catch (e) {}
    document.querySelectorAll("#rh-tabs [data-rh-tab]").forEach((b) => b.classList.toggle("active", b.dataset.rhTab === t));
    document.querySelectorAll("#view-rh .rh-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === t));
  }
  $("#rh-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-rh-tab]"); if (b) setRhTab(b.dataset.rhTab); });
  function openFiche(cc) {
    $("#rh-boutique").value = ccBoutique(cc) || "NONE"; // CC non affecté : filtre « non affectés »
    renderRhFilters();
    $("#rh-cc").value = cc;
    renderFiche(); renderPlanning();
    setRhTab("fiche");
    window.scrollTo(0, 0);
  }
  $("#rh-perms").addEventListener("click", (e) => { const b = e.target.closest("[data-open-fiche]"); if (b) openFiche(b.dataset.openFiche); });

  function renderCcTable() {
    const q = $("#cc-search").value;
    const ccs = db.settings.ccList.filter((c) => ccMatch(c, q));
    // CC en cartes : actifs d'abord
    const sorted = ccs.slice().sort((a, b) => (a.actif === b.actif ? 0 : a.actif ? -1 : 1));
    $("#cc-rows").innerHTML = sorted.length ? sorted.map((c) => {
      const hist = c.agents.length
        ? c.agents.map((a) => "<li><b>" + esc(a.nom) + "</b> " + (a.debut ? fmtDate(a.debut) : "…") + " → " + (a.fin ? fmtDate(a.fin) : "aujourd'hui") + "</li>").join("")
        : "<li>Aucun vendeur affecté</li>";
      const hasSales = db.sales.some((s) => s.cc === c.code);
      const st = c.actif ? ccStatusOn(c.code, today()) : { k: "mute", label: "Inactif" };
      return '<div class="cc-card' + (c.actif ? "" : " off") + '">' +
        '<div class="cc-head">' + avatarHtml(c.code) + '<div class="cc-id"><span class="cc-code">' + ccLabel(c.code) + "</span>" +
        '<input class="inline-input" data-cc-nom="' + esc(c.code) + '" value="' + esc(currentAgent(c)) + '" placeholder="Nom du CC" title="Nom affiché à côté du CC (Entrée pour valider)"></div>' +
        statusBadge(st) + "</div>" +
        '<div class="cc-row"><span>🏬 Boutique</span><select class="inline-select" data-cc-bq="' + esc(c.code) + '"><option value="">— Non affecté —</option>' +
        db.boutiques.map((b) => '<option value="' + esc(b.code) + '"' + (b.code === c.boutique ? " selected" : "") + ">" + esc(b.nom) + "</option>").join("") + "</select></div>" +
        '<div class="cc-row"><span>🛌 Repos</span><b>' + (reposLabel(c) || '<span class="muted">Non défini</span>') + "</b></div>" +
        '<details class="cc-hist"><summary>Historique des vendeurs (' + c.agents.length + ")</summary><ul>" + hist + "</ul></details>" +
        '<div class="cc-actions">' +
        '<button class="btn small" data-open-fiche="' + esc(c.code) + '">Fiche</button>' +
        '<button class="btn small" data-cc-assign="' + esc(c.code) + '">' + (currentAgent(c) ? "Changer de vendeur" : "Affecter un vendeur") + "</button>" +
        (c.actif
          ? '<button class="btn small" data-cc-depart="' + esc(c.code) + '">Départ</button>'
          : '<button class="btn small" data-cc-reactiver="' + esc(c.code) + '">Réactiver</button>') +
        (hasSales ? "" : '<button class="btn small danger" data-cc-del="' + esc(c.code) + '" title="Supprimer (aucune vente)">✕</button>') +
        "</div></div>";
    }).join("") : '<p class="empty">' + (q ? "Aucun CC ne correspond à la recherche." : "Aucun code commercial.") + "</p>";
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
  // Changement d'une autorisation (onglet Autorisations, fiche CC)
  function onPermChange(e) {
    const crd = e.target.closest("[data-cc-credit]");
    if (crd) {
      const code = crd.dataset.ccCredit, on = crd.checked;
      return act(async () => chk(await sb.from("ccs").update({ credit: on }).eq("code", code)),
        ccName(code) + (on ? " peut enregistrer les achats de crédit de sa boutique." : " n'enregistre plus les achats de crédit."));
    }
    const fdt = e.target.closest("[data-cc-frigodot]");
    if (fdt) {
      const code = fdt.dataset.ccFrigodot, on = fdt.checked;
      return act(async () => chk(await sb.from("ccs").update({ frigo_dotation: on }).eq("code", code)),
        ccName(code) + (on ? " peut fixer la dotation de crédit du frigo." : " ne fixe plus la dotation du frigo."));
    }
    const gco = e.target.closest("[data-cc-gerecom]");
    if (gco) {
      const code = gco.dataset.ccGerecom, on = gco.checked;
      return act(async () => chk(await sb.from("ccs").update({ gere_commissions: on }).eq("code", code)),
        ccName(code) + (on ? " gère les commissions du crédit télécom (tableau de bord, demande de versement, confirmation)." : " ne gère plus les commissions."));
    }
    const grh = e.target.closest("[data-cc-rh]");
    if (grh) {
      const code = grh.dataset.ccRh, on = grh.checked;
      return act(async () => chk(await sb.from("ccs").update({ gere_rh: on }).eq("code", code)),
        ccName(code) + (on ? " peut maintenant remplir les fiches RH des CC." : " ne gère plus les fiches RH."));
    }
    const bbs = e.target.closest("[data-cc-bobines]");
    if (bbs) {
      const code = bbs.dataset.ccBobines, v = bbs.value;
      return act(async () => chk(await sb.from("ccs").update({ bobines: v }).eq("code", code)),
        ccName(code) + " — Bobines : " + (v === "boutique" ? "consultation de sa boutique." : v === "saisie" ? "saisie des bobines utilisées de sa boutique." : "toutes les boutiques + approvisionnement."));
    }
    const vs = e.target.closest("[data-cc-voirstock]");
    if (vs) {
      const code = vs.dataset.ccVoirstock, on = vs.checked;
      return act(async () => chk(await sb.from("ccs").update({ voir_stock: on }).eq("code", code)),
        ccName(code) + (on ? " peut voir le stock de toutes les boutiques." : " ne voit plus que le stock de sa boutique."));
    }
    const ent = e.target.closest("[data-cc-entrees]");
    if (ent) {
      const code = ent.dataset.ccEntrees, on = ent.checked;
      return act(async () => chk(await sb.from("ccs").update({ entrees: on }).eq("code", code)),
        ccName(code) + (on ? " peut maintenant faire les entrées de stock (" + boutiqueName(ccBoutique(code)) + ")." : " ne peut plus faire d'entrées de stock."));
    }
    return false;
  }
  // Si l'enregistrement échoue (réseau, droits), la case reprend son ancien état
  function onPermChangeSur(e) {
    const p = onPermChange(e);
    if (p && p.then && e.target.type === "checkbox") p.then((r) => { if (r && !r.ok) e.target.checked = !e.target.checked; });
  }
  $("#rh-perms").addEventListener("change", onPermChangeSur);
  $("#rh-fiche").addEventListener("change", onPermChangeSur);
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
    if (b.dataset.openFiche) openFiche(b.dataset.openFiche);
    else if (b.dataset.ccAssign) openCc("assign", b.dataset.ccAssign);
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
    // Sauvegarde complète : toutes les données visibles par l'admin
    const data = {
      version: 4, exportedAt: new Date().toISOString(), settings: db.settings, products: db.products, entries: db.entries, sales: db.sales, courses: db.courses,
      boutiques: db.boutiques, charges: db.charges, remontees: db.remontees, bobines: db.bobines, conges: db.conges, fiches: db.fiches,
      creditAchats: db.crAchats, creditVersements: db.crVers, creditSoldes: db.crSoldes, creditVentes: db.crVentes, creditAjustements: db.crAjust, creditDemandes: db.crDemandes,
      retraits: db.retraits, stocksInitiaux: db.stocksInit,
      frigoCourses: db.fgCourses, frigoLignes: db.fgLignes, frigoSorties: db.fgSorties, frigoDotations: db.fgDotations, frigoRetraits: db.fgRetraits, frigoAjustements: db.fgAjust, frigoVentes: db.fgVentes,
      utilisateurs: db.users.map((u) => ({ nom: u.nom, email: u.email, role: u.role, cc: u.cc, actif: u.actif }))
    };
    download("sauvegarde-" + (db.settings.nom || "boutique") + "-" + today() + ".json", JSON.stringify(data, null, 2), "application/json");
    try { localStorage.setItem("lastBackup", today()); } catch (e) {}
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
