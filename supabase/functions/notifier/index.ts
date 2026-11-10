// Fonction Supabase « notifier » : envoie des notifications sur les téléphones (Web Push).
//   { action: "anniversaires" } : appelée chaque matin par la base (en-tête x-cron-secret)
//   { action: "test", cc: "2" }  : notification de test envoyée par l'admin (connecté)
// Secrets : VAPID_PUBLIC, VAPID_PRIVATE, CRON_SECRET (+ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY fournis par Supabase)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails("mailto:sylvanomensah@gmail.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Abo = { id: string; endpoint: string; p256dh: string; auth: string; cc: string | null };

// Envoie un message à une liste d'abonnements ; supprime ceux qui n'existent plus (410/404)
async function envoyer(abos: Abo[], msg: { title: string; body: string; tag: string }) {
  let ok = 0, ko = 0;
  for (const a of abos) {
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, JSON.stringify({ ...msg, url: "./" }), { TTL: 86400 });
      ok++;
    } catch (e) {
      ko++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_abonnements").delete().eq("id", a.id);
    }
  }
  return { ok, ko };
}

const nomCC = (agents: unknown, code: string) => {
  const list = Array.isArray(agents) ? agents : [];
  const nom = list.length ? (list[list.length - 1] as { nom?: string }).nom || "" : "";
  return "CC " + String(code).padStart(2, "0") + (nom ? " — " + nom : "");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: { action?: string; cc?: string } = {};
  try { body = await req.json(); } catch { /* vide */ }

  // ---- Anniversaires du jour (appel automatique du matin) ----
  if (body.action === "anniversaires") {
    if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ erreur: "non autorisé" }, 401);
    const jour = new Date().toISOString().slice(5, 10); // MM-JJ (heure de Lomé = UTC)
    const { data: fiches } = await admin.from("rh_fiches").select("cc, sexe, date_naissance").not("date_naissance", "is", null);
    const { data: ccs } = await admin.from("ccs").select("code, agents, actif");
    const fetes = (fiches || []).filter((f) => String(f.date_naissance).slice(5, 10) === jour)
      .map((f) => ({ ...f, c: (ccs || []).find((c) => String(c.code) === String(f.cc)) }))
      .filter((f) => f.c && f.c.actif);
    if (!fetes.length) return json({ anniversaires: 0 });
    const { data: abos } = await admin.from("push_abonnements").select("id, endpoint, p256dh, auth, cc");
    let total = 0;
    for (const f of fetes) {
      const nom = nomCC(f.c!.agents, String(f.cc));
      const prenom = nom.split(" — ")[1] || nom;
      const elle = f.sexe === "F";
      const perso = (abos || []).filter((a) => String(a.cc) === String(f.cc));
      const autres = (abos || []).filter((a) => String(a.cc) !== String(f.cc));
      const r1 = await envoyer(perso as Abo[], { title: "🎉 Joyeux anniversaire " + prenom + " !", body: "Toute l'équipe BGTeam te souhaite une excellente journée et une très belle année pleine de réussite" + (elle ? ", chère collègue." : ", cher collègue."), tag: "anniv-moi" });
      const r2 = await envoyer(autres as Abo[], { title: "🎂 Anniversaire aujourd'hui", body: "C'est l'anniversaire de " + nom + " ! Pensez à " + (elle ? "la" : f.sexe === "M" ? "le" : "lui") + " féliciter.", tag: "anniv-" + f.cc });
      total += r1.ok + r2.ok;
    }
    return json({ anniversaires: fetes.length, envoyees: total });
  }

  // ---- Notification de test envoyée par l'admin à un CC ----
  if (body.action === "test") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ erreur: "non connecté" }, 401);
    const { data: prof } = await admin.from("profiles").select("role, actif").eq("id", u.user.id).maybeSingle();
    if (!prof || !prof.actif || prof.role !== "admin") return json({ erreur: "réservé à l'administrateur" }, 403);
    const { data: abos } = await admin.from("push_abonnements").select("id, endpoint, p256dh, auth, cc").eq("cc", String(body.cc || ""));
    if (!abos || !abos.length) return json({ envoyees: 0, message: "Ce CC n'a pas encore activé les notifications sur son téléphone." });
    const r = await envoyer(abos as Abo[], { title: "🔔 Test BGTeam", body: "Les notifications fonctionnent sur ce téléphone. 👍", tag: "test" });
    return json({ envoyees: r.ok, echecs: r.ko });
  }

  return json({ erreur: "action inconnue" }, 400);
});
