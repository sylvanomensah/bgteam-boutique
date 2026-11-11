-- =====================================================================
-- BGTeam Boutique — schéma Supabase
-- Comptes : le premier compte créé devient admin (actif) ; les suivants
-- sont des vendeurs "en attente" jusqu'à validation par un admin.
-- =====================================================================

-- ---------- Profils utilisateurs ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nom text not null default '',
  role text not null default 'vendeur' check (role in ('admin', 'vendeur')),
  cc text,
  actif boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and actif);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and actif and role = 'admin');
$$;

-- Configuration privée (aucun accès depuis l'application) : e-mail de l'owner.
--   insert into public.app_config (key, value) values ('owner_email', 'votre@email.com');
create table if not exists public.app_config (
  key text primary key,
  value text not null
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

-- Le compte créé avec l'e-mail de l'owner devient administrateur actif ;
-- tous les autres sont des vendeurs en attente de validation.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare is_owner boolean;
begin
  select exists (
    select 1 from public.app_config
    where key = 'owner_email' and lower(value) = lower(new.email)
  ) into is_owner;
  insert into public.profiles (id, email, nom, role, actif)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'nom', ''),
    case when is_owner then 'admin' else 'vendeur' end,
    is_owner
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Paramètres du commerce ----------
create table if not exists public.settings (
  id integer primary key default 1 check (id = 1),
  nom text not null default '',
  domaine text not null default '',
  tel text not null default '',
  adresse text not null default '',
  email text not null default '',
  rccm text not null default '',
  devise text not null default 'FCFA'
);

-- ---------- Catalogue ----------
create table if not exists public.products (
  code text primary key,
  nom text not null,
  categorie text not null default '',
  pv numeric not null default 0 check (pv >= 0),
  stock_initial numeric not null default 0,
  stock_min numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Prix d'achat : table séparée, visible uniquement par les admins.
create table if not exists public.product_costs (
  code text primary key references public.products(code) on update cascade on delete cascade,
  pa numeric not null default 0 check (pa >= 0)
);

-- ---------- Codes commerciaux ----------
create table if not exists public.ccs (
  code text primary key,
  actif boolean not null default true,
  agents jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Boutiques (jusqu'à 10) et affectation des CC ----------
create table if not exists public.boutiques (
  code text primary key,
  nom text not null,
  actif boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.ccs add column if not exists boutique text references public.boutiques(code) on update cascade on delete set null;
-- Autorisation « Entrées de stock » donnée par l'admin à certains CC (par boutique).
alter table public.ccs add column if not exists entrees boolean not null default false;
-- Autorisation de voir le stock de toutes les boutiques (par défaut : seulement la sienne).
alter table public.ccs add column if not exists voir_stock boolean not null default false;

-- Vrai si l'utilisateur est admin, ou vendeur actif dont le CC est autorisé aux entrées de stock.
create or replace function public.can_entrees() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p join public.ccs c on c.code = p.cc
    where p.id = auth.uid() and p.actif and c.actif and c.entrees);
$$;

-- ---------- Courses (achats au marché) ----------
-- Une course = un reçu : plusieurs produits achetés + les frais (retrait, transport, autres).
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  cc text references public.ccs(code) on update cascade,
  saisi_par text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  frais_retrait numeric not null default 0 check (frais_retrait >= 0),
  frais_transport numeric not null default 0 check (frais_transport >= 0),
  autres_frais numeric not null default 0 check (autres_frais >= 0),
  autres_libelle text not null default '',
  obs text not null default '',
  statut text not null default 'Validée' check (statut in ('Validée', 'Annulée'))
);
create index if not exists courses_date_idx on public.courses (date);

-- ---------- Entrées de stock ----------
create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  date date,
  code text not null references public.products(code) on update cascade,
  qte numeric not null check (qte > 0),
  statut text not null default 'Validée' check (statut in ('Validée', 'Annulée')),
  obs text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.entries add column if not exists cc text references public.ccs(code) on update cascade;
alter table public.entries add column if not exists saisi_par text not null default '';
create index if not exists entries_date_idx on public.entries (date);
-- Lignes de course : prix total payé, part des frais et coût de revient unitaire.
alter table public.entries add column if not exists course_id uuid references public.courses(id) on delete cascade;
alter table public.entries add column if not exists prix_total numeric check (prix_total >= 0);
alter table public.entries add column if not exists frais_part numeric;
alter table public.entries add column if not exists cout_unitaire numeric;
create index if not exists entries_course_idx on public.entries (course_id);

-- Renseigne automatiquement l'auteur, son CC et l'heure de saisie ;
-- empêche un vendeur de changer ces informations ou d'antidater une entrée.
-- Les lignes de course sont écrites par save_course(), qui fixe elle-même ces valeurs.
create or replace function public.entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare prof public.profiles%rowtype;
begin
  select * into prof from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' and new.course_id is not null then
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.saisi_par := coalesce(nullif(prof.nom, ''), prof.email, '');
    if not public.is_admin() then
      new.cc := prof.cc;
      new.date := current_date;
      new.statut := 'Validée';
      new.boutique := (select boutique from public.ccs where code = prof.cc);
    elsif new.boutique is null then
      new.boutique := (select boutique from public.ccs where code = new.cc);
    end if;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.saisi_par := old.saisi_par;
    if not public.is_admin() then
      new.cc := old.cc;
      new.date := old.date;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists entries_before_write on public.entries;
create trigger entries_before_write before insert or update on public.entries
  for each row execute function public.entries_before_write();

-- Coût moyen pondéré (CMP) courant de chaque produit (admin uniquement, voir product_costs).
alter table public.product_costs add column if not exists cmp numeric;

-- ---------- Ventes ----------
create sequence if not exists public.ticket_seq;

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  ticket integer not null,
  date date not null,
  client text not null default 'CLIENT COMPTOIR',
  code text not null references public.products(code) on update cascade,
  nom text not null default '',
  qte numeric not null check (qte > 0),
  pu numeric not null check (pu >= 0),
  cc text not null references public.ccs(code) on update cascade,
  vendeur text not null default '',
  valide text not null default 'OUI' check (valide in ('OUI', 'NON')),
  num_client text not null default '',
  adresse_client text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sales_date_idx on public.sales (date);
create index if not exists sales_ticket_idx on public.sales (ticket);
create index if not exists sales_cc_idx on public.sales (cc);
-- Boutique où la vente a été faite (figée à la vente, même si le CC change de boutique ensuite)
alter table public.sales add column if not exists boutique text references public.boutiques(code) on update cascade on delete set null;
create index if not exists sales_boutique_idx on public.sales (boutique, date);

-- Création d'un ticket complet (numéro attribué par la base, sans doublon).
-- Les vendeurs ne peuvent pas changer le prix : le prix catalogue est imposé.
create or replace function public.create_sale(
  p_date date, p_client text, p_cc text, p_vendeur text,
  p_num_client text, p_adresse text, p_lines jsonb
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  t integer;
  l jsonb;
  admin boolean := public.is_admin();
  prod public.products%rowtype;
begin
  if not public.is_member() then raise exception 'Compte non autorisé'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Ticket vide'; end if;
  if not exists (select 1 from public.ccs where code = p_cc and actif) then raise exception 'Code commercial inactif ou inconnu'; end if;
  t := nextval('public.ticket_seq');
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into prod from public.products where code = l ->> 'code';
    if not found then raise exception 'Produit inconnu : %', l ->> 'code'; end if;
    insert into public.sales (ticket, date, client, code, nom, qte, pu, cc, vendeur, valide, num_client, adresse_client, created_by, boutique)
    values (
      t, case when admin then coalesce(p_date, current_date) else current_date end,
      coalesce(nullif(trim(p_client), ''), 'CLIENT COMPTOIR'),
      prod.code, prod.nom, (l ->> 'qte')::numeric,
      case when admin then (l ->> 'pu')::numeric else prod.pv end,
      p_cc, coalesce(p_vendeur, ''), 'OUI', coalesce(p_num_client, ''), coalesce(p_adresse, ''), auth.uid(),
      (select boutique from public.ccs where code = p_cc)
    );
  end loop;
  return t;
end $$;

-- Recale le compteur de tickets après un import (admin uniquement).
create or replace function public.sync_ticket_seq() returns integer
language plpgsql security definer set search_path = public as $$
declare m integer;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select coalesce(max(ticket), 0) into m from public.sales;
  perform setval('public.ticket_seq', m + 1, false);
  return m + 1;
end $$;

revoke all on function public.create_sale(date, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.create_sale(date, text, text, text, text, text, jsonb) to authenticated;
revoke all on function public.sync_ticket_seq() from public, anon;
grant execute on function public.sync_ticket_seq() to authenticated;

-- =====================================================================
-- Coût moyen pondéré (CMP) et coût de chaque vente
-- =====================================================================
-- Coût de revient unitaire figé sur chaque ligne de vente (pour des marges justes dans le temps).
alter table public.sales add column if not exists cout_unitaire numeric;

-- Rejoue l'historique d'un produit (stock initial, entrées validées, ventes) dans l'ordre
-- chronologique : met à jour le CMP du produit et le coût de chaque vente.
create or replace function public.recompute_cmp(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare
  st numeric;
  cm numeric;
  ev record;
  prod public.products%rowtype;
begin
  select * into prod from public.products where code = p_code;
  if not found then return; end if;
  st := prod.stock_initial;
  select coalesce(pa, 0) into cm from public.product_costs where code = p_code;
  cm := coalesce(cm, 0);
  for ev in
    select 0 as kind, e.date as d, e.created_at as t, e.qte, e.cout_unitaire as cu, null::uuid as sid, true as counted
      from public.entries e where e.code = p_code and e.statut = 'Validée'
    union all
    select 1, s.date, s.created_at, s.qte, null::numeric, s.id, s.valide = 'OUI'
      from public.sales s where s.code = p_code
    order by 2 nulls first, 3, 1
  loop
    if ev.kind = 0 then
      if ev.cu is not null then
        if st <= 0 then cm := ev.cu; else cm := (st * cm + ev.qte * ev.cu) / (st + ev.qte); end if;
      end if;
      st := st + ev.qte;
    else
      update public.sales set cout_unitaire = round(cm, 2)
        where id = ev.sid and cout_unitaire is distinct from round(cm, 2);
      if ev.counted then st := st - ev.qte; end if;
    end if;
  end loop;
  update public.product_costs set cmp = round(cm, 2) where code = p_code;
  if not found then insert into public.product_costs (code, pa, cmp) values (p_code, 0, round(cm, 2)); end if;
end $$;
revoke all on function public.recompute_cmp(text) from public, anon, authenticated;

create or replace function public.trg_recompute_cmp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform public.recompute_cmp(new.code); end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.code is distinct from new.code) then perform public.recompute_cmp(old.code); end if;
  return null;
end $$;
drop trigger if exists entries_cmp on public.entries;
create trigger entries_cmp after insert or delete or update of statut, qte, code, date, cout_unitaire on public.entries
  for each row execute function public.trg_recompute_cmp();
drop trigger if exists sales_cmp on public.sales;
create trigger sales_cmp after insert or delete or update of valide, qte, code, date on public.sales
  for each row execute function public.trg_recompute_cmp();
drop trigger if exists costs_cmp on public.product_costs;
create trigger costs_cmp after update of pa on public.product_costs
  for each row execute function public.trg_recompute_cmp();
drop trigger if exists products_cmp on public.products;
create trigger products_cmp after update of stock_initial on public.products
  for each row execute function public.trg_recompute_cmp();

-- =====================================================================
-- Courses : création / modification (2 h pour un vendeur) et annulation
-- =====================================================================
-- Marché, téléphone du fournisseur (obligatoires) et photo du reçu (Storage, bucket « recus »).
alter table public.courses add column if not exists marche text not null default '';
alter table public.courses add column if not exists fournisseur_tel text not null default '';
alter table public.courses add column if not exists recu_path text;

-- Boutique de la course et de ses entrées (stock par boutique)
alter table public.courses add column if not exists boutique text references public.boutiques(code) on update cascade on delete set null;
alter table public.entries add column if not exists boutique text references public.boutiques(code) on update cascade on delete set null;
create index if not exists entries_boutique_idx on public.entries (boutique, code);

drop function if exists public.save_course(uuid, date, text, numeric, numeric, numeric, text, text, jsonb);
drop function if exists public.save_course(uuid, date, text, numeric, numeric, numeric, text, text, jsonb, text, text, text);
create or replace function public.save_course(
  p_id uuid, p_date date, p_cc text,
  p_frais_retrait numeric, p_frais_transport numeric, p_autres_frais numeric, p_autres_libelle text,
  p_obs text, p_lines jsonb,
  p_marche text, p_fournisseur_tel text, p_recu_path text, p_boutique text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  admin boolean := public.is_admin();
  prof public.profiles%rowtype;
  c public.courses%rowtype;
  cid uuid;
  l jsonb;
  n integer;
  sous_total numeric := 0;
  frais numeric;
  part numeric;
  q numeric;
  pt numeric;
  v_marche text := trim(coalesce(p_marche, ''));
  v_tel text := trim(coalesce(p_fournisseur_tel, ''));
  v_boutique text;
begin
  if not public.is_member() then raise exception 'Compte non autorisé'; end if;
  if not public.can_entrees() then raise exception 'Votre CC n''est pas autorisé à faire des entrées de stock. Demandez à l''administrateur.'; end if;
  select * into prof from public.profiles where id = auth.uid();
  if v_marche = '' then raise exception 'Indiquez le marché de la course'; end if;
  if length(regexp_replace(v_tel, '\D', '', 'g')) < 8 then raise exception 'Indiquez un numéro de téléphone du fournisseur valide (8 chiffres minimum)'; end if;
  if p_recu_path is not null and p_recu_path <> '' and p_recu_path !~ '^courses/[A-Za-z0-9/_.-]+$' then raise exception 'Photo du reçu invalide'; end if;
  n := coalesce(jsonb_array_length(p_lines), 0);
  if n = 0 then raise exception 'Ajoutez au moins un produit à la course'; end if;
  frais := coalesce(p_frais_retrait, 0) + coalesce(p_frais_transport, 0) + coalesce(p_autres_frais, 0);
  if coalesce(p_frais_retrait, 0) < 0 or coalesce(p_frais_transport, 0) < 0 or coalesce(p_autres_frais, 0) < 0 then
    raise exception 'Frais invalides';
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from public.products where code = l ->> 'code') then raise exception 'Produit inconnu : %', l ->> 'code'; end if;
    if coalesce((l ->> 'qte')::numeric, 0) <= 0 then raise exception 'Quantité invalide'; end if;
    if coalesce((l ->> 'prix_total')::numeric, -1) < 0 then raise exception 'Prix total invalide'; end if;
    sous_total := sous_total + (l ->> 'prix_total')::numeric;
  end loop;

  -- Photo du reçu obligatoire pour les vendeurs
  if not admin and p_id is null and coalesce(p_recu_path, '') = '' then
    raise exception 'La photo du reçu est obligatoire';
  end if;
  if not admin and p_id is not null and p_recu_path = '' then
    raise exception 'La photo du reçu est obligatoire';
  end if;
  if not admin and p_id is not null and p_recu_path is null
     and coalesce((select recu_path from public.courses where id = p_id), '') = '' then
    raise exception 'La photo du reçu est obligatoire';
  end if;

  -- Boutique : celle du CC du vendeur ; l'admin peut la choisir (sinon celle du CC choisi).
  if admin then
    v_boutique := coalesce(nullif(p_boutique, ''), (select boutique from public.ccs where code = nullif(p_cc, '')));
  else
    v_boutique := (select boutique from public.ccs where code = prof.cc);
  end if;

  if p_id is null then
    insert into public.courses (date, cc, saisi_par, created_by, frais_retrait, frais_transport, autres_frais, autres_libelle, obs, marche, fournisseur_tel, recu_path, boutique)
    values (
      case when admin then coalesce(p_date, current_date) else current_date end,
      case when admin then nullif(p_cc, '') else prof.cc end,
      coalesce(nullif(prof.nom, ''), prof.email, ''), auth.uid(),
      coalesce(p_frais_retrait, 0), coalesce(p_frais_transport, 0), coalesce(p_autres_frais, 0),
      coalesce(p_autres_libelle, ''), coalesce(p_obs, ''), v_marche, v_tel, nullif(p_recu_path, ''), v_boutique
    ) returning id into cid;
  else
    select * into c from public.courses where id = p_id for update;
    if not found then raise exception 'Course introuvable'; end if;
    if not admin and (c.created_by is distinct from auth.uid() or c.created_at < now() - interval '2 hours') then
      raise exception 'Délai de 2 heures dépassé : seul l''administrateur peut modifier cette course.';
    end if;
    update public.courses set
      date = case when admin then coalesce(p_date, c.date) else c.date end,
      cc = case when admin then nullif(p_cc, '') else c.cc end,
      frais_retrait = coalesce(p_frais_retrait, 0), frais_transport = coalesce(p_frais_transport, 0),
      autres_frais = coalesce(p_autres_frais, 0), autres_libelle = coalesce(p_autres_libelle, ''), obs = coalesce(p_obs, ''),
      marche = v_marche, fournisseur_tel = v_tel,
      recu_path = case when p_recu_path is null then c.recu_path else nullif(p_recu_path, '') end,
      boutique = case when admin then v_boutique else c.boutique end
    where id = p_id;
    delete from public.entries where course_id = p_id;
    cid := p_id;
  end if;

  select * into c from public.courses where id = cid;
  for l in select * from jsonb_array_elements(p_lines) loop
    q := (l ->> 'qte')::numeric;
    pt := (l ->> 'prix_total')::numeric;
    part := case when sous_total > 0 then frais * pt / sous_total else frais / n end;
    insert into public.entries (date, code, qte, statut, obs, cc, saisi_par, created_by, course_id, prix_total, frais_part, cout_unitaire, boutique)
    values (c.date, l ->> 'code', q, c.statut, '', c.cc, c.saisi_par, c.created_by, cid, pt, round(part, 2), round((pt + part) / q, 2), c.boutique);
  end loop;
  return cid;
end $$;
revoke all on function public.save_course(uuid, date, text, numeric, numeric, numeric, text, text, jsonb, text, text, text, text) from public, anon;
grant execute on function public.save_course(uuid, date, text, numeric, numeric, numeric, text, text, jsonb, text, text, text, text) to authenticated;

-- =====================================================================
-- Nouveaux produits créés par les CC (à valider par l'admin)
-- =====================================================================
alter table public.products add column if not exists valide boolean not null default true;
alter table public.products add column if not exists cree_par text not null default '';
alter table public.products add column if not exists cree_par_cc text;
alter table public.products add column if not exists cree_le timestamptz;

create or replace function public.create_product(p_nom text, p_categorie text, p_pv numeric) returns text
language plpgsql security definer set search_path = public as $$
declare
  admin boolean := public.is_admin();
  prof public.profiles%rowtype;
  v_nom text := upper(trim(coalesce(p_nom, '')));
  v_cat text := trim(coalesce(p_categorie, ''));
  existing text;
  n integer;
  v_code text;
begin
  if not public.is_member() then raise exception 'Compte non autorisé'; end if;
  if not public.can_entrees() then raise exception 'Votre CC n''est pas autorisé à faire des entrées de stock. Demandez à l''administrateur.'; end if;
  if length(v_nom) < 2 then raise exception 'Indiquez la désignation du produit'; end if;
  if v_cat = '' then raise exception 'Choisissez la catégorie du produit'; end if;
  if p_pv is null or p_pv <= 0 then raise exception 'Indiquez un prix de vente valide'; end if;
  select code into existing from public.products where upper(trim(nom)) = v_nom limit 1;
  if existing is not null then raise exception 'Ce produit existe déjà : % (%)', v_nom, existing; end if;
  select * into prof from public.profiles where id = auth.uid();
  perform pg_advisory_xact_lock(hashtext('create_product'));
  select coalesce(max((substring(code from '(\d+)$'))::int), 0) + 1 into n from public.products where code ~ '^ART-\d+$';
  v_code := 'ART-' || lpad(n::text, 3, '0');
  insert into public.products (code, nom, categorie, pv, stock_initial, stock_min, valide, cree_par, cree_par_cc, cree_le)
  values (v_code, v_nom, v_cat, p_pv, 0, 5, admin, coalesce(nullif(prof.nom, ''), prof.email, ''), prof.cc, now());
  insert into public.product_costs (code, pa) values (v_code, 0) on conflict (code) do nothing;
  return v_code;
end $$;
revoke all on function public.create_product(text, text, numeric) from public, anon;
grant execute on function public.create_product(text, text, numeric) to authenticated;

-- Photos des reçus : bucket privé, lisible et alimenté par les membres, suppression admin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recus', 'recus', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists recus_select on storage.objects;
create policy recus_select on storage.objects for select to authenticated using (bucket_id = 'recus' and public.is_member());
drop policy if exists recus_insert on storage.objects;
create policy recus_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'recus' and public.can_entrees() and (name like 'courses/%' or name like 'remontees/%'));
drop policy if exists recus_delete on storage.objects;
create policy recus_delete on storage.objects for delete to authenticated using (bucket_id = 'recus' and public.is_admin());

create or replace function public.set_course_statut(p_id uuid, p_statut text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.courses%rowtype;
begin
  if p_statut not in ('Validée', 'Annulée') then raise exception 'Statut invalide'; end if;
  select * into c from public.courses where id = p_id;
  if not found then raise exception 'Course introuvable'; end if;
  if not public.is_admin() and (not public.can_entrees() or c.created_by is distinct from auth.uid() or c.created_at < now() - interval '2 hours') then
    raise exception 'Délai de 2 heures dépassé : seul l''administrateur peut modifier cette course.';
  end if;
  update public.courses set statut = p_statut where id = p_id;
  update public.entries set statut = p_statut where course_id = p_id;
end $$;
revoke all on function public.set_course_statut(uuid, text) from public, anon;
grant execute on function public.set_course_statut(uuid, text) to authenticated;

-- =====================================================================
-- Sécurité (Row Level Security)
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.products enable row level security;
alter table public.product_costs enable row level security;
alter table public.ccs enable row level security;
alter table public.entries enable row level security;
alter table public.sales enable row level security;

-- Profils : chacun voit le sien, l'admin voit et modifie tout.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated using (public.is_admin() and id <> auth.uid());

-- Lecture pour tous les membres, écriture admin.
do $$
declare t text;
begin
  foreach t in array array['settings', 'products', 'ccs'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.is_member())', t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format('create policy %1$s_write on public.%1$s for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Prix d'achat : admin uniquement.
drop policy if exists product_costs_admin on public.product_costs;
create policy product_costs_admin on public.product_costs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Entrées : tous les membres lisent et ajoutent. Un vendeur peut modifier / annuler
-- SES entrées pendant 2 heures ; ensuite seul l'admin peut le faire. Suppression : admin.
drop policy if exists entries_select on public.entries;
create policy entries_select on public.entries for select to authenticated using (public.is_member());
drop policy if exists entries_insert on public.entries;
create policy entries_insert on public.entries for insert to authenticated
  with check (public.can_entrees() and statut = 'Validée' and course_id is null);
drop policy if exists entries_update on public.entries;
create policy entries_update on public.entries for update to authenticated
  using (public.is_admin() or (public.can_entrees() and course_id is null and created_by = auth.uid() and created_at > now() - interval '2 hours'))
  with check (public.is_admin() or (public.can_entrees() and course_id is null and created_by = auth.uid()));

-- Courses : lecture pour les membres ; écriture via save_course() / set_course_statut() ; suppression admin.
alter table public.courses enable row level security;
drop policy if exists courses_select on public.courses;
create policy courses_select on public.courses for select to authenticated using (public.is_member());
drop policy if exists courses_delete on public.courses;
create policy courses_delete on public.courses for delete to authenticated using (public.is_admin());
drop policy if exists entries_delete on public.entries;
create policy entries_delete on public.entries for delete to authenticated using (public.is_admin());

-- Ventes : tous les membres lisent ; création via create_sale() ; modification admin.
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select to authenticated using (public.is_member());
drop policy if exists sales_admin_write on public.sales;
create policy sales_admin_write on public.sales for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Aucun accès anonyme.
revoke all on all tables in schema public from anon;

-- Boutiques : lecture pour les membres, gestion par l'admin.
alter table public.boutiques enable row level security;
drop policy if exists boutiques_select on public.boutiques;
create policy boutiques_select on public.boutiques for select to authenticated using (public.is_member());
drop policy if exists boutiques_write on public.boutiques;
-- Renommer / activer : admin. Créer et supprimer : uniquement via create_boutique() / delete_boutique()
-- qui exigent le mot de passe de l'admin.
drop policy if exists boutiques_update on public.boutiques;
create policy boutiques_update on public.boutiques for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Vérifie le mot de passe du compte connecté (usage interne, non appelable depuis l'application).
create extension if not exists pgcrypto with schema extensions;
create or replace function public.check_my_password(p_password text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  select u.encrypted_password = extensions.crypt(coalesce(p_password, ''), u.encrypted_password) into ok
  from auth.users u where u.id = auth.uid();
  return coalesce(ok, false);
end $$;
revoke all on function public.check_my_password(text) from public, anon, authenticated;

create or replace function public.create_boutique(p_nom text, p_password text) returns text
language plpgsql security definer set search_path = public as $$
declare n integer; v_code text; v_nom text := trim(coalesce(p_nom, ''));
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if not public.check_my_password(p_password) then raise exception 'Mot de passe incorrect'; end if;
  if v_nom = '' then raise exception 'Indiquez le nom de la boutique'; end if;
  if exists (select 1 from public.boutiques where lower(nom) = lower(v_nom)) then raise exception 'Une boutique porte déjà ce nom'; end if;
  select coalesce(max((substring(code from '(\d+)$'))::int), 0) + 1 into n from public.boutiques where code ~ '^B\d+$';
  v_code := 'B' || n;
  insert into public.boutiques (code, nom) values (v_code, v_nom);
  return v_code;
end $$;
revoke all on function public.create_boutique(text, text) from public, anon;
grant execute on function public.create_boutique(text, text) to authenticated;

-- Supprime une boutique et toutes ses données (ventes, courses, entrées) ; ses CC sont désaffectés.
-- Renvoie le bilan et la liste des photos de reçus à effacer du stockage.
create or replace function public.delete_boutique(p_code text, p_password text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; nv int; nc int; ne int; ncc int; photos text[];
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if not public.check_my_password(p_password) then raise exception 'Mot de passe incorrect'; end if;
  if not exists (select 1 from public.boutiques where code = p_code) then raise exception 'Boutique introuvable'; end if;
  if not exists (select 1 from public.boutiques where code <> p_code) then raise exception 'Créez d''abord une autre boutique : il doit toujours en rester au moins une'; end if;
  -- B1 (boutique d'origine / simulation) porte le stock initial repris de l'Excel : il disparaît avec elle.
  -- Le stock initial de la boutique (table stocks_initiaux) disparaît avec elle (suppression en cascade).
  if p_code = 'B1' and not exists (select 1 from public.stocks_initiaux) then update public.products set stock_initial = 0 where stock_initial <> 0; end if;
  select coalesce(array_agg(recu_path) filter (where recu_path is not null), '{}') into photos from public.courses where boutique = p_code;
  delete from public.sales where boutique = p_code; get diagnostics nv = row_count;
  delete from public.courses where boutique = p_code; get diagnostics nc = row_count;
  delete from public.entries where boutique = p_code; get diagnostics ne = row_count;
  update public.ccs set boutique = null where boutique = p_code; get diagnostics ncc = row_count;
  delete from public.boutiques where code = p_code;
  return jsonb_build_object('ventes', nv, 'courses', nc, 'entrees', ne, 'ccs', ncc, 'photos', to_jsonb(photos));
end $$;
revoke all on function public.delete_boutique(text, text) from public, anon;
grant execute on function public.delete_boutique(text, text) to authenticated;

-- Affecte un CC à une boutique (admin). Les ventes passées du CC sans boutique y sont rattachées ;
-- les ventes déjà rattachées à une boutique gardent la leur.
create or replace function public.assign_cc_boutique(p_cc text, p_boutique text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  update public.ccs set boutique = nullif(p_boutique, '') where code = p_cc;
  if nullif(p_boutique, '') is not null then
    update public.sales set boutique = p_boutique where cc = p_cc and boutique is null;
  end if;
end $$;
revoke all on function public.assign_cc_boutique(text, text) from public, anon;
grant execute on function public.assign_cc_boutique(text, text) to authenticated;

-- =====================================================================
-- RH : jours de repos, fiches (admin uniquement) et congés
-- =====================================================================
-- Jours de repos hebdomadaires du CC (1 = lundi … 7 = dimanche)
alter table public.ccs add column if not exists repos smallint[] not null default '{}';

-- Fiche RH confidentielle : visible et modifiable uniquement par l'admin
create table if not exists public.rh_fiches (
  cc text primary key references public.ccs(code) on update cascade on delete cascade,
  telephone text not null default '',
  contact_urgence text not null default '',
  date_embauche date,
  notes text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.rh_fiches enable row level security;
drop policy if exists rh_fiches_admin on public.rh_fiches;
create policy rh_fiches_admin on public.rh_fiches for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Congés : 1 semaine par défaut, prolongeables. Le CC ne voit que les siens ; l'admin gère tout.
create table if not exists public.conges (
  id uuid primary key default gen_random_uuid(),
  cc text not null references public.ccs(code) on update cascade on delete cascade,
  debut date not null,
  fin date not null,
  motif text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (fin >= debut)
);
create index if not exists conges_cc_idx on public.conges (cc, debut);
alter table public.conges enable row level security;
drop policy if exists conges_select on public.conges;
create policy conges_select on public.conges for select to authenticated
  using (public.is_admin() or (public.is_member() and cc = (select p.cc from public.profiles p where p.id = auth.uid())));
drop policy if exists conges_admin on public.conges;
create policy conges_admin on public.conges for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- Charges (loyer, électricité, salaires…) : par boutique ou générales (boutique vide)
-- =====================================================================
create table if not exists public.charges (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  boutique text references public.boutiques(code) on update cascade on delete cascade,
  categorie text not null default 'Autres',
  libelle text not null default '',
  montant numeric not null check (montant > 0),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists charges_date_idx on public.charges (date, boutique);
alter table public.charges enable row level security;
drop policy if exists charges_admin on public.charges;
create policy charges_admin on public.charges for all to authenticated using (public.is_admin()) with check (public.is_admin());
alter table public.charges add column if not exists saisi_par text not null default '';

-- =====================================================================
-- Droits des CC (définis par l'admin dans RH)
--   voir_stock : CC « toutes boutiques » (stock, fonds remontés, dépenses de toutes les boutiques)
--   bobines    : 'non' | 'boutique' (voit sa boutique, déclare les bobines utilisées) | 'gestion' (toutes les boutiques, approvisionnements)
-- =====================================================================
alter table public.ccs add column if not exists bobines text not null default 'boutique';
-- Par défaut chaque CC voit les bobines de sa boutique ; l'admin choisit ceux qui gèrent toutes les boutiques.
alter table public.ccs alter column bobines set default 'boutique';
update public.ccs set bobines = 'boutique' where bobines = 'non';
-- 'boutique' = consultation de sa boutique ; 'saisie' = + saisie des bobines utilisées ; 'gestion' = toutes + approvisionnements
alter table public.ccs drop constraint if exists ccs_bobines_check;
alter table public.ccs add constraint ccs_bobines_check check (bobines in ('non', 'boutique', 'saisie', 'gestion'));

-- CC actif de l'utilisateur connecté (vendeur actif uniquement)
create or replace function public.my_cc() returns public.ccs
language sql stable security definer set search_path = public as $$
  select c.* from public.profiles p join public.ccs c on c.code = p.cc
  where p.id = auth.uid() and p.actif and c.actif limit 1;
$$;
create or replace function public.my_boutique() returns text
language sql stable security definer set search_path = public as $$ select (public.my_cc()).boutique; $$;
create or replace function public.is_global() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or coalesce((public.my_cc()).voir_stock, false);
$$;
create or replace function public.bobines_droit() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then 'gestion' else coalesce((public.my_cc()).bobines, 'non') end;
$$;

-- Dépenses (abonnements Canal+, New World, internet, électricité…) : l'admin et les CC « toutes boutiques »
drop policy if exists charges_global_select on public.charges;
create policy charges_global_select on public.charges for select to authenticated using (public.is_global());
drop policy if exists charges_global_insert on public.charges;
create policy charges_global_insert on public.charges for insert to authenticated
  with check (public.is_global() and boutique is not null and created_by = auth.uid());
drop policy if exists charges_global_delete on public.charges;
create policy charges_global_delete on public.charges for delete to authenticated
  using (public.is_global() and created_by = auth.uid() and created_at > now() - interval '2 hours');

-- Refus d'une demande d'accès : le compte en attente est supprimé ; la personne devra refaire une demande.
-- (ses éventuelles saisies passées sont conservées, sans lien vers le compte)
create or replace function public.refuse_user(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare prof public.profiles%rowtype;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_id = auth.uid() then raise exception 'Vous ne pouvez pas refuser votre propre compte'; end if;
  select * into prof from public.profiles where id = p_id;
  if not found then raise exception 'Utilisateur introuvable'; end if;
  if prof.actif then raise exception 'Ce compte est actif : suspendez-le d''abord'; end if;
  if prof.role = 'admin' then raise exception 'Impossible de refuser un compte administrateur'; end if;
  delete from auth.users where id = p_id;
  return coalesce(prof.email, '');
end $$;
revoke all on function public.refuse_user(uuid) from public, anon;
grant execute on function public.refuse_user(uuid) to authenticated;

-- =====================================================================
-- Stock initial PAR BOUTIQUE (products.stock_initial = total, tenu à jour automatiquement)
-- =====================================================================
create table if not exists public.stocks_initiaux (
  code text not null references public.products(code) on update cascade on delete cascade,
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  qte numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (code, boutique)
);
alter table public.stocks_initiaux enable row level security;
drop policy if exists stocks_initiaux_select on public.stocks_initiaux;
create policy stocks_initiaux_select on public.stocks_initiaux for select to authenticated using (public.is_member());
drop policy if exists stocks_initiaux_admin on public.stocks_initiaux;
create policy stocks_initiaux_admin on public.stocks_initiaux for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.trg_stock_initial_total() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text := coalesce(new.code, old.code);
begin
  update public.products set stock_initial = coalesce((select sum(qte) from public.stocks_initiaux where code = v_code), 0)
  where code = v_code;
  if tg_op = 'UPDATE' and old.code is distinct from new.code then
    update public.products set stock_initial = coalesce((select sum(qte) from public.stocks_initiaux where code = old.code), 0) where code = old.code;
  end if;
  return null;
end $$;
drop trigger if exists stocks_initiaux_total on public.stocks_initiaux;
create trigger stocks_initiaux_total after insert or update or delete on public.stocks_initiaux
  for each row execute function public.trg_stock_initial_total();

-- Reprise : l'ancien stock initial global appartient à la boutique d'origine B1 (si elle existe encore).
insert into public.stocks_initiaux (code, boutique, qte)
select p.code, 'B1', p.stock_initial from public.products p
where p.stock_initial <> 0 and exists (select 1 from public.boutiques where code = 'B1')
  and not exists (select 1 from public.stocks_initiaux s where s.code = p.code)
on conflict do nothing;

-- =====================================================================
-- Mots de passe temporaires (création de compte et réinitialisation par l'admin)
-- =====================================================================
alter table public.profiles add column if not exists must_change_pwd boolean not null default false;

-- L'utilisateur indique qu'il a choisi son nouveau mot de passe
create or replace function public.password_changed() returns void
language sql security definer set search_path = public as $$
  update public.profiles set must_change_pwd = false where id = auth.uid();
$$;
revoke all on function public.password_changed() from public, anon;
grant execute on function public.password_changed() to authenticated;

-- Réinitialisation par l'admin : mot de passe temporaire + déconnexion de ses appareils
create or replace function public.admin_reset_password(p_id uuid, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_email text;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if p_id = auth.uid() then raise exception 'Pour votre propre compte, utilisez « Mot de passe » dans le menu'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Le mot de passe temporaire doit faire au moins 8 caractères'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_id returning email into v_email;
  if v_email is null then raise exception 'Utilisateur introuvable'; end if;
  update public.profiles set must_change_pwd = true where id = p_id;
  begin
    delete from auth.refresh_tokens where user_id::text = p_id::text;
    delete from auth.sessions where user_id = p_id;
  exception when others then null;
  end;
  return v_email;
end $$;
revoke all on function public.admin_reset_password(uuid, text) from public, anon;
grant execute on function public.admin_reset_password(uuid, text) to authenticated;

-- Création d'un compte par l'admin (actif tout de suite, mot de passe temporaire à changer)
create or replace function public.admin_create_user(p_email text, p_nom text, p_password text, p_role text, p_cc text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Adresse e-mail invalide'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Le mot de passe temporaire doit faire au moins 8 caractères'; end if;
  if coalesce(p_role, 'vendeur') not in ('vendeur', 'admin') then raise exception 'Rôle invalide'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then raise exception 'Un compte existe déjà avec cet e-mail'; end if;
  if nullif(p_cc, '') is not null and not exists (select 1 from public.ccs where code = p_cc) then raise exception 'CC inconnu'; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('nom', trim(coalesce(p_nom, ''))), now(), now(),
    '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text, jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', now(), now(), now());
  -- Le profil est créé par le déclencheur handle_new_user ; on l'active directement.
  update public.profiles set actif = true, nom = trim(coalesce(p_nom, '')), role = coalesce(p_role, 'vendeur'),
    cc = nullif(p_cc, ''), must_change_pwd = true where id = v_id;
  return v_id;
end $$;
revoke all on function public.admin_create_user(text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text, text) to authenticated;

-- =====================================================================
-- Remontée des fonds de vente (chaque lundi, pour la semaine lundi → dimanche écoulée)
-- =====================================================================
create table if not exists public.remontees (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  cc text references public.ccs(code) on update cascade on delete set null,
  semaine date not null,                       -- lundi de la semaine couverte
  montant numeric not null check (montant > 0),
  mode text not null default 'Espèces',
  note text not null default '',
  statut text not null default 'Déclarée' check (statut in ('Déclarée', 'Reçue')),
  recu_par text not null default '',
  recu_le timestamptz,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (extract(isodow from semaine) = 1)
);
create index if not exists remontees_idx on public.remontees (boutique, semaine);
-- Photo du reçu de dépôt (mobile money / virement) envoyée par le CC depuis son téléphone
alter table public.remontees add column if not exists recu_path text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'remontees_recu_obligatoire') then
    -- NOT VALID : s'applique aux nouvelles remontées, pas aux anciennes
    alter table public.remontees add constraint remontees_recu_obligatoire
      check (mode = 'Espèces' or coalesce(recu_path, '') <> '') not valid;
  end if;
end $$;
alter table public.remontees enable row level security;
drop policy if exists remontees_select on public.remontees;
create policy remontees_select on public.remontees for select to authenticated
  using (public.is_global() or (public.can_entrees() and boutique = public.my_boutique()));
drop policy if exists remontees_insert on public.remontees;
create policy remontees_insert on public.remontees for insert to authenticated
  with check (public.is_admin() or (public.can_entrees() and boutique = public.my_boutique() and cc = (public.my_cc()).code
    and created_by = auth.uid() and statut = 'Déclarée'));
drop policy if exists remontees_delete on public.remontees;
create policy remontees_delete on public.remontees for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and statut = 'Déclarée' and created_at > now() - interval '2 hours'));
drop policy if exists remontees_admin_update on public.remontees;
create policy remontees_admin_update on public.remontees for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Confirmation de réception des fonds : admin ou CC « toutes boutiques »
-- Répartition d'une remontée validée entre les deux soldes de la boutique :
--   fonds de roulement = prix d'achat (coût moyen) des produits vendus dans la semaine,
--   solde bénéfice     = le reste (la marge).
-- Plusieurs remontées pour une même semaine se partagent le coût d'achat de la semaine.
alter table public.remontees add column if not exists part_roulement numeric not null default 0;
alter table public.remontees add column if not exists part_benefice numeric not null default 0;
create or replace function public.remontee_split(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.remontees%rowtype; v_cout numeric; v_deja numeric; v_roul numeric;
begin
  select * into r from public.remontees where id = p_id;
  if not found then return; end if;
  if r.statut <> 'Reçue' then
    update public.remontees set part_roulement = 0, part_benefice = 0 where id = p_id;
    return;
  end if;
  select coalesce(sum(s.qte * coalesce(s.cout_unitaire, 0)), 0) into v_cout
  from public.sales s left join public.ccs c on c.code = s.cc
  where s.valide = 'OUI' and coalesce(s.boutique, c.boutique) = r.boutique and s.date between r.semaine and r.semaine + 6;
  select coalesce(sum(part_roulement), 0) into v_deja from public.remontees
  where boutique = r.boutique and semaine = r.semaine and statut = 'Reçue' and id <> p_id;
  v_roul := least(r.montant, greatest(v_cout - v_deja, 0));
  update public.remontees set part_roulement = round(v_roul), part_benefice = r.montant - round(v_roul) where id = p_id;
end $$;
revoke all on function public.remontee_split(uuid) from public, anon, authenticated;

-- Validation de la remontée : administrateur uniquement
create or replace function public.set_remontee_recue(p_id uuid, p_recue boolean) returns void
language plpgsql security definer set search_path = public as $$
declare prof public.profiles%rowtype;
begin
  if not public.is_admin() then raise exception 'Seul l''administrateur valide les remontées de fonds'; end if;
  select * into prof from public.profiles where id = auth.uid();
  update public.remontees set
    statut = case when p_recue then 'Reçue' else 'Déclarée' end,
    recu_par = case when p_recue then coalesce(nullif(prof.nom, ''), prof.email, '') else '' end,
    recu_le = case when p_recue then now() else null end
  where id = p_id;
  if not found then raise exception 'Remontée introuvable'; end if;
  perform public.remontee_split(p_id);
end $$;
-- Reprise : répartition des remontées déjà validées
do $$ declare x record; begin
  for x in select id from public.remontees where statut = 'Reçue' and part_roulement = 0 and part_benefice = 0 loop
    perform public.remontee_split(x.id);
  end loop;
end $$;

-- =====================================================================
-- Sécurité des remontées mobile money
--   Le reçu est lu automatiquement chez le CC (n° de transaction, montant, expéditeur, destinataire) ;
--   le serveur refuse un reçu déjà utilisé, un montant différent ou un dépôt sur un autre numéro.
-- =====================================================================
alter table public.settings add column if not exists numero_depot text not null default '';
alter table public.remontees add column if not exists tx_id text;
alter table public.remontees add column if not exists recu_infos jsonb not null default '{}'::jsonb;
alter table public.remontees add column if not exists alerte text not null default '';
create unique index if not exists remontees_tx_unique on public.remontees (tx_id) where tx_id is not null and tx_id <> '';

-- Remontée en espèces : remise à un CC autorisé par l'admin, qui confirme la réception
alter table public.ccs add column if not exists recoit_especes boolean not null default false;
alter table public.remontees add column if not exists cc_receveur text references public.ccs(code) on update cascade on delete set null;
alter table public.remontees add column if not exists reception_confirmee_le timestamptz;
alter table public.remontees add column if not exists reception_confirmee_par text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'remontees_mode_check') then
    -- Nouvelles remontées : Espèces (avec le CC qui reçoit) ou Mobile money
    alter table public.remontees add constraint remontees_mode_check
      check (mode in ('Espèces', 'Mobile money') and (mode <> 'Espèces' or cc_receveur is not null)) not valid;
  end if;
end $$;
-- Le CC qui reçoit voit les remontées qui lui ont été remises (même d'une autre boutique)
drop policy if exists remontees_select on public.remontees;
create policy remontees_select on public.remontees for select to authenticated
  using (public.is_global() or (public.can_entrees() and boutique = public.my_boutique())
    or (cc_receveur is not null and cc_receveur = (public.my_cc()).code));
-- Le CC qui a reçu l'argent en espèces confirme la réception
create or replace function public.confirmer_reception_especes(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.remontees%rowtype; prof public.profiles%rowtype;
begin
  select * into r from public.remontees where id = p_id;
  if not found then raise exception 'Remontée introuvable'; end if;
  if r.cc_receveur is null or r.cc_receveur is distinct from (public.my_cc()).code then
    raise exception 'Seul le CC qui a reçu l''argent peut confirmer la réception';
  end if;
  select * into prof from public.profiles where id = auth.uid();
  update public.remontees set reception_confirmee_le = now(), reception_confirmee_par = coalesce(nullif(prof.nom, ''), prof.email, '')
  where id = p_id and reception_confirmee_le is null;
end $$;
revoke all on function public.confirmer_reception_especes(uuid) from public, anon;
grant execute on function public.confirmer_reception_especes(uuid) to authenticated;

-- =====================================================================
-- Autorisation « Gère les fiches RH » donnée par l'admin à un CC (révocable)
--   Le CC voit l'onglet Fiche CC du menu RH : fiches, jours de repos et congés de tous les CC.
-- =====================================================================
alter table public.ccs add column if not exists gere_rh boolean not null default false;
create or replace function public.is_rh() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or coalesce((public.my_cc()).gere_rh, false);
$$;
drop policy if exists rh_fiches_admin on public.rh_fiches;
drop policy if exists rh_fiches_rh on public.rh_fiches;
create policy rh_fiches_rh on public.rh_fiches for all to authenticated using (public.is_rh()) with check (public.is_rh());
drop policy if exists conges_select on public.conges;
create policy conges_select on public.conges for select to authenticated
  using (public.is_rh() or (public.is_member() and cc = (select p.cc from public.profiles p where p.id = auth.uid())));
drop policy if exists conges_admin on public.conges;
drop policy if exists conges_rh on public.conges;
create policy conges_rh on public.conges for all to authenticated using (public.is_rh()) with check (public.is_rh());
-- Sexe et date de naissance dans la fiche RH (confidentielle)
alter table public.rh_fiches add column if not exists sexe text not null default '';
alter table public.rh_fiches add column if not exists date_naissance date;
-- Anniversaires du jour, visibles par tous les membres : seulement le CC, son nom et son sexe
-- (ni la date de naissance ni l'âge). Un 29 février est fêté le 28 février les autres années.
create or replace function public.anniversaires_du_jour() returns table (cc text, nom text, sexe text)
language sql stable security definer set search_path = public as $$
  select f.cc, coalesce(c.agents -> -1 ->> 'nom', ''), f.sexe
  from public.rh_fiches f join public.ccs c on c.code = f.cc
  where public.is_member() and c.actif and f.date_naissance is not null
    and (to_char(f.date_naissance, 'MM-DD') = to_char(current_date, 'MM-DD')
      or (to_char(f.date_naissance, 'MM-DD') = '02-29' and to_char(current_date, 'MM-DD') = '02-28'
          and extract(day from (date_trunc('year', current_date) + interval '2 months' - interval '1 day')) = 28));
$$;
revoke all on function public.anniversaires_du_jour() from public, anon;
grant execute on function public.anniversaires_du_jour() to authenticated;

-- Notifications sur le téléphone : abandonnées (l'anniversaire s'affiche seulement dans l'application)
drop table if exists public.push_abonnements;

-- Jours de repos d'un CC : admin ou CC « RH »
create or replace function public.set_repos(p_cc text, p_repos smallint[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_rh() then raise exception 'Réservé à l''administrateur et aux CC chargés des fiches RH'; end if;
  update public.ccs set repos = coalesce(p_repos, '{}') where code = p_cc;
  if not found then raise exception 'CC introuvable'; end if;
end $$;
revoke all on function public.set_repos(text, smallint[]) from public, anon;
grant execute on function public.set_repos(text, smallint[]) to authenticated;

-- Contrôles à l'enregistrement d'une remontée (CC) : n° de transaction, montant et destinataire du reçu
create or replace function public.remontees_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_num text; v_dest text; v_mt numeric; v_tel text; v_exp text;
begin
  new.tx_id := nullif(regexp_replace(coalesce(new.tx_id, ''), '\D', '', 'g'), '');
  new.reception_confirmee_le := null; new.reception_confirmee_par := '';
  if new.mode = 'Espèces' then
    -- Le CC qui reçoit doit être autorisé par l'admin, actif, et différent de l'envoyeur
    if not exists (select 1 from public.ccs where code = new.cc_receveur and actif and recoit_especes) then
      raise exception 'Choisissez un CC autorisé à recevoir les remontées en espèces';
    end if;
    if new.cc_receveur = new.cc then raise exception 'Vous ne pouvez pas vous remettre l''argent à vous-même'; end if;
    return new;
  end if;
  if public.is_admin() then return new; end if;
  v_mt := nullif(new.recu_infos ->> 'montant', '')::numeric;
  if v_mt is not null and v_mt <> new.montant then
    raise exception 'Le montant du reçu (% F) ne correspond pas au montant déclaré (% F)', v_mt, new.montant;
  end if;
  select regexp_replace(numero_depot, '\D', '', 'g') into v_num from public.settings where id = 1;
  v_dest := regexp_replace(coalesce(new.recu_infos ->> 'destinataire', ''), '\D', '', 'g');
  if coalesce(v_num, '') <> '' and v_dest <> '' and right(v_num, 4) <> right(v_dest, 4) then
    raise exception 'Ce reçu n''est pas un dépôt sur le numéro de la boutique (****%)', right(v_num, 4);
  end if;
  -- Expéditeur du reçu ≠ numéro enregistré du CC (fiche RH) : on accepte mais on signale à l'admin
  select regexp_replace(coalesce(telephone, ''), '\D', '', 'g') into v_tel from public.rh_fiches where cc = new.cc;
  v_exp := regexp_replace(coalesce(new.recu_infos ->> 'expediteur', ''), '\D', '', 'g');
  if coalesce(v_tel, '') <> '' and v_exp <> '' and right(v_tel, 4) <> right(v_exp, 4) then
    new.alerte := trim(new.alerte || ' Expéditeur du reçu (****' || right(v_exp, 4) || ') différent du numéro du CC (****' || right(v_tel, 4) || ').');
  end if;
  if new.tx_id is null then new.alerte := trim(new.alerte || ' Reçu non lu automatiquement.'); end if;
  return new;
end $$;
drop trigger if exists remontees_before_insert on public.remontees;
create trigger remontees_before_insert before insert on public.remontees for each row execute function public.remontees_before_insert();

-- =====================================================================
-- Crédit télécom (YAS / MOOV) : dotation par boutique, achats de crédit, commissions
--   Chaque boutique reçoit une dotation (20 000 F YAS + 10 000 F MOOV par défaut).
--   Chaque achat de crédit rapporte une commission (5 % par défaut) que le CC verse en fin de mois.
-- =====================================================================
alter table public.boutiques add column if not exists dotation_yas numeric not null default 20000;
alter table public.boutiques add column if not exists dotation_moov numeric not null default 10000;
alter table public.settings add column if not exists taux_yas numeric not null default 5;
alter table public.settings add column if not exists taux_moov numeric not null default 5;
alter table public.ccs add column if not exists credit boolean not null default false;
-- Autorisation donnée par l'admin : reverser la commission en dehors du 1er et du 2 du mois
alter table public.ccs add column if not exists credit_vers boolean not null default false;
create or replace function public.can_credit() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or coalesce((public.my_cc()).credit, false);
$$;

create table if not exists public.credit_achats (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  cc text references public.ccs(code) on update cascade on delete set null,
  date date not null default current_date,
  operateur text not null check (operateur in ('YAS', 'MOOV')),
  montant numeric not null check (montant > 0),
  commission numeric not null default 0,
  reference text not null default '',
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists credit_achats_idx on public.credit_achats (boutique, date);
-- Commission calculée par le serveur selon le taux de l'opérateur
create or replace function public.credit_achats_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_taux numeric;
begin
  select case when new.operateur = 'YAS' then taux_yas else taux_moov end into v_taux from public.settings where id = 1;
  new.commission := round(new.montant * coalesce(v_taux, 5) / 100);
  if not public.is_admin() then
    new.date := least(new.date, current_date);
    if new.date < current_date - 2 then raise exception 'Un achat ne peut pas être saisi plus de 2 jours après'; end if;
  end if;
  return new;
end $$;
drop trigger if exists credit_achats_before on public.credit_achats;
create trigger credit_achats_before before insert or update on public.credit_achats for each row execute function public.credit_achats_before();
alter table public.credit_achats enable row level security;
drop policy if exists credit_achats_select on public.credit_achats;
create policy credit_achats_select on public.credit_achats for select to authenticated
  using (public.is_global() or (public.can_credit() and boutique = public.my_boutique()));
drop policy if exists credit_achats_insert on public.credit_achats;
create policy credit_achats_insert on public.credit_achats for insert to authenticated
  with check (public.is_admin() or (public.can_credit() and boutique = public.my_boutique() and cc = (public.my_cc()).code and created_by = auth.uid()));
drop policy if exists credit_achats_delete on public.credit_achats;
create policy credit_achats_delete on public.credit_achats for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and created_at > now() - interval '2 hours'));

create table if not exists public.credit_versements (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  cc text references public.ccs(code) on update cascade on delete set null,
  mois date not null,                      -- 1er jour du mois de la commission
  montant numeric not null check (montant > 0),
  mode text not null default 'Espèces' check (mode in ('Espèces', 'Mobile money')),
  note text not null default '',
  statut text not null default 'Déclarée' check (statut in ('Déclarée', 'Reçue')),
  recu_par text not null default '',
  recu_le timestamptz,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (extract(day from mois) = 1)
);
alter table public.credit_versements enable row level security;
drop policy if exists credit_vers_select on public.credit_versements;
create policy credit_vers_select on public.credit_versements for select to authenticated
  using (public.is_global() or (public.can_credit() and boutique = public.my_boutique()));
drop policy if exists credit_vers_insert on public.credit_versements;
create policy credit_vers_insert on public.credit_versements for insert to authenticated
  with check (public.is_admin() or (public.can_credit() and boutique = public.my_boutique() and cc = (public.my_cc()).code
    and created_by = auth.uid() and statut = 'Déclarée'));
drop policy if exists credit_vers_delete on public.credit_versements;
create policy credit_vers_delete on public.credit_versements for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and statut = 'Déclarée' and created_at > now() - interval '2 hours'));
-- Clôture du soir : crédit restant sur chaque puce (YAS / MOOV) ; le crédit vendu du jour en est déduit
create table if not exists public.credit_soldes (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  operateur text not null check (operateur in ('YAS', 'MOOV')),
  solde numeric not null check (solde >= 0),
  cc text,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (boutique, date, operateur)
);
alter table public.credit_soldes enable row level security;
-- Tous les CC de la boutique voient le crédit (achats, soldes, commissions) ; seuls les CC autorisés saisissent
drop policy if exists credit_soldes_select on public.credit_soldes;
create policy credit_soldes_select on public.credit_soldes for select to authenticated
  using (public.is_global() or (public.is_member() and boutique = public.my_boutique()));
-- Contrôle du crédit restant (lu sur la puce) : fait chaque soir par un CC de la boutique, une seule fois par jour
-- (aujourd'hui, ou la veille en rattrapage) ; l'admin peut enregistrer n'importe quel jour et corriger.
drop policy if exists credit_soldes_insert on public.credit_soldes;
create policy credit_soldes_insert on public.credit_soldes for insert to authenticated
  with check (public.is_admin() or (public.is_member() and boutique = public.my_boutique() and date between current_date - 1 and current_date and created_by = auth.uid()));
drop policy if exists credit_soldes_update on public.credit_soldes;
create policy credit_soldes_update on public.credit_soldes for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists credit_soldes_delete on public.credit_soldes;
create policy credit_soldes_delete on public.credit_soldes for delete to authenticated using (public.is_admin());

-- Crédit vendu chaque jour (YAS / MOOV), déclaré par un CC de la boutique ; il est déduit du crédit restant
create table if not exists public.credit_ventes (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  operateur text not null check (operateur in ('YAS', 'MOOV')),
  montant numeric not null check (montant >= 0),
  cc text,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (boutique, date, operateur)
);
alter table public.credit_ventes enable row level security;
drop policy if exists credit_ventes_select on public.credit_ventes;
create policy credit_ventes_select on public.credit_ventes for select to authenticated
  using (public.is_global() or (public.is_member() and boutique = public.my_boutique()));
-- Un CC déclare la vente d'aujourd'hui ou l'oubli d'hier, une seule fois (pas de modification : l'admin corrige)
drop policy if exists credit_ventes_insert on public.credit_ventes;
create policy credit_ventes_insert on public.credit_ventes for insert to authenticated
  with check (public.is_admin() or (public.is_member() and boutique = public.my_boutique() and date between current_date - 1 and current_date and created_by = auth.uid()));
drop policy if exists credit_ventes_update on public.credit_ventes;
create policy credit_ventes_update on public.credit_ventes for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists credit_ventes_delete on public.credit_ventes;
create policy credit_ventes_delete on public.credit_ventes for delete to authenticated using (public.is_admin());

-- Le contrôle d'hier doit être fait (règle active à partir des contrôles du 11/11/2026, boutiques déjà actives en crédit)
alter table public.settings add column if not exists credit_seuil numeric not null default 5000;
create or replace function public.credit_hier_manquant(p_boutique text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  return current_date - 1 >= date '2026-11-11'
    and (exists (select 1 from public.credit_soldes where boutique = p_boutique and date < current_date)
         or exists (select 1 from public.credit_achats where boutique = p_boutique and date < current_date))
    and not exists (select 1 from public.credit_soldes where boutique = p_boutique and date = current_date - 1);
end $$;
-- Crédit restant = dernier contrôle + (recharges + commission) faites depuis
create or replace function public.credit_restant(p_boutique text, p_op text) returns numeric
language plpgsql security definer set search_path = public as $$
declare r public.credit_soldes%rowtype;
begin
  select * into r from public.credit_soldes where boutique = p_boutique and operateur = p_op order by date desc, updated_at desc limit 1;
  return coalesce(r.solde, 0) + coalesce((select sum(a.montant + a.commission) from public.credit_achats a
    where a.boutique = p_boutique and a.operateur = p_op
      and (r.id is null or a.date > r.date or (a.date = r.date and a.created_at > r.updated_at))), 0);
end $$;
-- Un CC ne fait le contrôle d'aujourd'hui qu'après celui d'hier
create or replace function public.credit_soldes_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if new.date = current_date and public.credit_hier_manquant(new.boutique) then
    raise exception 'Faites d''abord le contrôle du crédit restant d''hier (oubli)';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists credit_soldes_before on public.credit_soldes;
create trigger credit_soldes_before before insert on public.credit_soldes for each row execute function public.credit_soldes_before();
create or replace function public.credit_ventes_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if new.date = current_date and public.credit_hier_manquant(new.boutique) then
    raise exception 'Déclarez d''abord le crédit vendu hier (oubli) avant celui d''aujourd''hui';
  end if;
  return new;
end $$;
drop trigger if exists credit_ventes_before on public.credit_ventes;
create trigger credit_ventes_before before insert on public.credit_ventes for each row execute function public.credit_ventes_before();
-- Recharge : contrôle d'hier fait, et crédit restant de la puce inférieur au seuil (5 000 par défaut)
create or replace function public.credit_achats_hier() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_r numeric; v_seuil numeric;
begin
  if public.is_admin() then return new; end if;
  if public.credit_hier_manquant(new.boutique) then
    raise exception 'Faites d''abord le contrôle du crédit restant d''hier avant de faire une nouvelle recharge';
  end if;
  select coalesce(credit_seuil, 5000) into v_seuil from public.settings where id = 1;
  v_r := public.credit_restant(new.boutique, new.operateur);
  if v_r >= v_seuil then
    raise exception 'Recharge % impossible : il reste encore % F sur la puce (recharge possible sous % F)', new.operateur, v_r, v_seuil;
  end if;
  return new;
end $$;
drop trigger if exists credit_achats_hier on public.credit_achats;
create trigger credit_achats_hier before insert on public.credit_achats for each row execute function public.credit_achats_hier();

-- ===================== FRIGO (boissons) =====================
-- L'admin fait une course pour le frigo d'une boutique : le TOTAL DE LA COURSE devient le « crédit vente »
-- (valeur_vente = estimation des ventes = prix de vente × quantité, plafond des ventes déclarables).
-- Les CC déclarent chaque jour la vente du frigo, qui est déduite du crédit vente restant.
-- Quand le restant atteint le seuil (5 000 par défaut), une nouvelle course peut être faite.
alter table public.settings add column if not exists frigo_seuil numeric not null default 5000;
-- CC désigné par l'admin pour fixer la dotation de crédit du frigo des boutiques
alter table public.ccs add column if not exists frigo_dotation boolean not null default false;
create or replace function public.can_frigo_dotation() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or coalesce((public.my_cc()).frigo_dotation, false);
$$;
create table if not exists public.frigo_courses (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  valeur_vente numeric not null check (valeur_vente > 0),
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.frigo_courses enable row level security;
drop policy if exists frigo_courses_select on public.frigo_courses;
create policy frigo_courses_select on public.frigo_courses for select to authenticated
  using (public.is_global() or public.can_frigo_dotation() or (public.is_member() and boutique = public.my_boutique()));
drop policy if exists frigo_courses_admin on public.frigo_courses;
create policy frigo_courses_admin on public.frigo_courses for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- Détail (prix d'achat, frais) : administrateur uniquement
create table if not exists public.frigo_courses_details (
  course_id uuid primary key references public.frigo_courses(id) on delete cascade,
  lignes jsonb not null default '[]',
  total_achats numeric not null default 0,
  frais_deplacement numeric not null default 0,
  frais_sachet numeric not null default 0,
  frais_autres numeric not null default 0,
  frais_autres_lib text not null default '',
  total_course numeric not null default 0
);
alter table public.frigo_courses_details enable row level security;
drop policy if exists frigo_details_admin on public.frigo_courses_details;
create policy frigo_details_admin on public.frigo_courses_details for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- Total de la course (= crédit vente), visible par la boutique
alter table public.frigo_courses add column if not exists montant_course numeric not null default 0;
update public.frigo_courses c set montant_course = d.total_course from public.frigo_courses_details d where d.course_id = c.id and c.montant_course = 0;
update public.frigo_courses set montant_course = round(montant_course, 2) where montant_course <> round(montant_course, 2);
update public.frigo_courses_details set total_course = round(total_course, 2), total_achats = round(total_achats, 2) where total_course <> round(total_course, 2) or total_achats <> round(total_achats, 2);
-- Dotation de crédit du frigo : montant fixé par l'admin (ou le CC désigné) pour la prochaine course d'une boutique.
-- La course doit être EXACTEMENT égale à la dotation ; la dotation est alors consommée.
create table if not exists public.frigo_dotations (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  montant numeric not null check (montant > 0),
  statut text not null default 'Ouverte' check (statut in ('Ouverte', 'Utilisée', 'Annulée')),
  course_id uuid,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists frigo_dotation_ouverte on public.frigo_dotations (boutique) where statut = 'Ouverte';
alter table public.frigo_dotations enable row level security;
drop policy if exists frigo_dotations_select on public.frigo_dotations;
create policy frigo_dotations_select on public.frigo_dotations for select to authenticated
  using (public.is_global() or public.can_frigo_dotation() or (public.is_member() and boutique = public.my_boutique()));
create or replace function public.frigo_doter(p_boutique text, p_montant numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; prof public.profiles%rowtype;
begin
  if not public.can_frigo_dotation() then raise exception 'Seul l''administrateur ou le CC désigné peut fixer la dotation'; end if;
  if coalesce(p_montant, 0) <= 0 then raise exception 'Montant de dotation invalide'; end if;
  if exists (select 1 from public.frigo_dotations where boutique = p_boutique and statut = 'Ouverte') then
    raise exception 'Une dotation est déjà en attente de course pour cette boutique (annulez-la d''abord)';
  end if;
  select * into prof from public.profiles where id = auth.uid();
  insert into public.frigo_dotations (boutique, montant, saisi_par) values (p_boutique, round(p_montant, 2), coalesce(nullif(prof.nom, ''), prof.email, ''))
    returning id into v_id;
  return v_id;
end $$;
create or replace function public.frigo_annuler_dotation(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_frigo_dotation() then raise exception 'Seul l''administrateur ou le CC désigné peut annuler la dotation'; end if;
  update public.frigo_dotations set statut = 'Annulée' where id = p_id and statut = 'Ouverte';
  if not found then raise exception 'Dotation introuvable ou déjà utilisée'; end if;
end $$;
revoke all on function public.frigo_doter(text, numeric) from public, anon;
grant execute on function public.frigo_doter(text, numeric) to authenticated;
revoke all on function public.frigo_annuler_dotation(uuid) from public, anon;
grant execute on function public.frigo_annuler_dotation(uuid) to authenticated;
-- Enregistrement d'une course (calculs faits par le serveur) : admin ou CC de la boutique, égale à la dotation ouverte
create or replace function public.frigo_ajouter_course(p_boutique text, p_date date, p_lignes jsonb, p_deplacement numeric, p_sachet numeric, p_autres numeric, p_autres_lib text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_achats numeric := 0; v_vente numeric := 0; l jsonb; prof public.profiles%rowtype; v_dot public.frigo_dotations%rowtype; v_total numeric;
begin
  if not (public.is_admin() or (public.is_member() and p_boutique = public.my_boutique())) then
    raise exception 'Seuls l''administrateur et les CC de la boutique peuvent faire la course du frigo';
  end if;
  if not public.is_admin() then p_date := current_date; end if;
  select * into v_dot from public.frigo_dotations where boutique = p_boutique and statut = 'Ouverte' for update;
  if not found then raise exception 'Aucune dotation de crédit pour ce frigo : l''admin (ou le CC désigné) doit d''abord la fixer'; end if;
  if jsonb_typeof(p_lignes) <> 'array' or jsonb_array_length(p_lignes) = 0 then raise exception 'Ajoutez au moins un produit'; end if;
  for l in select * from jsonb_array_elements(p_lignes) loop
    if coalesce((l->>'qte')::numeric, 0) <= 0 or coalesce((l->>'achat')::numeric, -1) < 0 or coalesce((l->>'vente')::numeric, -1) < 0 or coalesce(trim(l->>'nom'), '') = '' then
      raise exception 'Ligne de produit incomplète';
    end if;
    v_achats := v_achats + (l->>'qte')::numeric * (l->>'achat')::numeric;
    v_vente := v_vente + (l->>'qte')::numeric * (l->>'vente')::numeric;
  end loop;
  if v_vente <= 0 then raise exception 'La valeur de vente doit être positive'; end if;
  v_achats := round(v_achats, 2); v_vente := round(v_vente, 2); -- prix unitaires = total ÷ quantité : on évite les décimales parasites
  v_total := v_achats + greatest(coalesce(p_deplacement, 0), 0) + greatest(coalesce(p_sachet, 0), 0) + greatest(coalesce(p_autres, 0), 0);
  if abs(v_total - v_dot.montant) > 0.5 then
    raise exception 'La course (% F) doit être égale à la dotation de crédit (% F) : crédit non utilisé %', v_total, v_dot.montant, v_dot.montant - v_total;
  end if;
  select * into prof from public.profiles where id = auth.uid();
  insert into public.frigo_courses (boutique, date, valeur_vente, montant_course, saisi_par)
    values (p_boutique, coalesce(p_date, current_date), v_vente,
            v_achats + greatest(coalesce(p_deplacement, 0), 0) + greatest(coalesce(p_sachet, 0), 0) + greatest(coalesce(p_autres, 0), 0),
            coalesce(nullif(prof.nom, ''), prof.email, ''))
    returning id into v_id;
  insert into public.frigo_courses_details (course_id, lignes, total_achats, frais_deplacement, frais_sachet, frais_autres, frais_autres_lib, total_course)
    values (v_id, p_lignes, v_achats, greatest(coalesce(p_deplacement, 0), 0), greatest(coalesce(p_sachet, 0), 0), greatest(coalesce(p_autres, 0), 0), coalesce(p_autres_lib, ''),
            v_achats + greatest(coalesce(p_deplacement, 0), 0) + greatest(coalesce(p_sachet, 0), 0) + greatest(coalesce(p_autres, 0), 0));
  update public.frigo_dotations set statut = 'Utilisée', course_id = v_id where id = v_dot.id;
  return v_id;
end $$;
revoke all on function public.frigo_ajouter_course(text, date, jsonb, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.frigo_ajouter_course(text, date, jsonb, numeric, numeric, numeric, text) to authenticated;

-- Vente du frigo déclarée chaque jour par un CC de la boutique (une par jour ; l'admin corrige)
create table if not exists public.frigo_ventes (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  montant numeric not null check (montant >= 0),
  cc text,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (boutique, date)
);
alter table public.frigo_ventes enable row level security;
drop policy if exists frigo_ventes_select on public.frigo_ventes;
create policy frigo_ventes_select on public.frigo_ventes for select to authenticated
  using (public.is_global() or (public.is_member() and boutique = public.my_boutique()));
drop policy if exists frigo_ventes_insert on public.frigo_ventes;
create policy frigo_ventes_insert on public.frigo_ventes for insert to authenticated
  with check (public.is_admin() or (public.is_member() and boutique = public.my_boutique() and date between current_date - 1 and current_date and created_by = auth.uid()));
drop policy if exists frigo_ventes_update on public.frigo_ventes;
create policy frigo_ventes_update on public.frigo_ventes for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists frigo_ventes_delete on public.frigo_ventes;
create policy frigo_ventes_delete on public.frigo_ventes for delete to authenticated using (public.is_admin());
-- La vente d'hier doit être déclarée (si le frigo avait déjà une course hier ; règle active à partir du 10/11/2026)
create or replace function public.frigo_hier_manquant(p_boutique text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  return current_date - 1 >= date '2026-11-10'
    and exists (select 1 from public.frigo_courses where boutique = p_boutique and date <= current_date - 1)
    and not exists (select 1 from public.frigo_ventes where boutique = p_boutique and date = current_date - 1);
end $$;
create or replace function public.frigo_ventes_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_restant numeric;
begin
  if public.is_admin() then return new; end if;
  if new.date = current_date and public.frigo_hier_manquant(new.boutique) then
    raise exception 'Déclarez d''abord la vente du frigo d''hier (oubli) avant celle d''aujourd''hui';
  end if;
  select coalesce((select sum(valeur_vente) from public.frigo_courses where boutique = new.boutique), 0)
       - coalesce((select sum(montant) from public.frigo_ventes where boutique = new.boutique), 0) into v_restant;
  if new.montant > v_restant then raise exception 'La vente (% F) dépasse le crédit vente restant du frigo (% F)', new.montant, greatest(v_restant, 0); end if;
  return new;
end $$;
drop trigger if exists frigo_ventes_before on public.frigo_ventes;
create trigger frigo_ventes_before before insert on public.frigo_ventes for each row execute function public.frigo_ventes_before();

-- Retraits de l'argent des ventes du frigo : administrateur uniquement
create table if not exists public.frigo_retraits (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  montant numeric not null check (montant > 0),
  note text not null default '',
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.frigo_retraits enable row level security;
drop policy if exists frigo_retraits_admin on public.frigo_retraits;
create policy frigo_retraits_admin on public.frigo_retraits for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Sorties du frigo = ventes faites en CAISSE des produits achetés dans une course du frigo de la boutique.
-- Chaque vente fait baisser le crédit vente restant de son prix d'achat unitaire (hors frais de la course),
-- pris dans la dernière course de la boutique contenant ce produit, faite avant la vente.
create or replace function public.frigo_sorties() returns table (
  sale_id uuid, boutique text, date date, created_at timestamptz, ticket integer, code text, nom text, qte numeric, pu numeric, consomme numeric)
language sql stable security definer set search_path = public as $$
  select s.id, s.boutique, s.date, s.created_at, s.ticket, s.code, s.nom, s.qte, s.pu, round(s.qte * x.cu, 2)
  from public.sales s
  cross join lateral (
    select (l ->> 'achat')::numeric as cu  -- prix d'achat unitaire de la course (total payé ÷ quantité), sans les frais
    from public.frigo_courses c
    join public.frigo_courses_details d on d.course_id = c.id
    cross join lateral jsonb_array_elements(d.lignes) l
    where c.boutique = s.boutique and l ->> 'code' = s.code and c.created_at <= s.created_at
    order by c.created_at desc limit 1) x
  where public.is_member() and s.valide = 'OUI' and s.boutique is not null
    and (public.is_global() or public.can_frigo_dotation() or s.boutique = public.my_boutique());
$$;
revoke all on function public.frigo_sorties() from public, anon;
grant execute on function public.frigo_sorties() to authenticated;
drop policy if exists credit_achats_select on public.credit_achats;
create policy credit_achats_select on public.credit_achats for select to authenticated
  using (public.is_global() or (public.is_member() and boutique = public.my_boutique()));
drop policy if exists credit_vers_select on public.credit_versements;
create policy credit_vers_select on public.credit_versements for select to authenticated
  using (public.is_global() or (public.is_member() and boutique = public.my_boutique()));

-- ---- Anti-fraude crédit ----
-- 1. Référence de transaction obligatoire (CC) et unique pour chaque recharge
create unique index if not exists credit_achats_ref_unique on public.credit_achats (lower(trim(reference))) where trim(reference) <> '';
create or replace function public.credit_achats_ref() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.reference := trim(coalesce(new.reference, ''));
  if not public.is_admin() and length(new.reference) < 4 then
    raise exception 'Indiquez la référence de la transaction (n° de recharge)';
  end if;
  return new;
end $$;
drop trigger if exists credit_achats_ref on public.credit_achats;
create trigger credit_achats_ref before insert on public.credit_achats for each row execute function public.credit_achats_ref();
-- 2. Seul l'admin supprime une recharge (sinon la commission due pourrait être réduite)
drop policy if exists credit_achats_delete on public.credit_achats;
create policy credit_achats_delete on public.credit_achats for delete to authenticated using (public.is_admin());
-- 3. Un versement ne peut pas dépasser la commission encore due par la boutique
create or replace function public.credit_vers_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_du numeric;
begin
  new.mois := date_trunc('month', coalesce(new.mois, current_date))::date;
  if public.is_admin() then return new; end if;
  -- Reversement ouvert aux CC uniquement le 1er et le 2 du mois (heure de Lomé = UTC)
  if extract(day from (now() at time zone 'Africa/Lome')) > 2 and not coalesce((public.my_cc()).credit_vers, false) then
    raise exception 'Le reversement de la commission se fait uniquement le 1er et le 2 de chaque mois';
  end if;
  select coalesce((select sum(commission) from public.credit_achats where boutique = new.boutique), 0)
       - coalesce((select sum(montant) from public.credit_versements where boutique = new.boutique), 0) into v_du;
  if new.montant > v_du then raise exception 'Le versement (% F) dépasse la commission encore due (% F)', new.montant, greatest(v_du, 0); end if;
  return new;
end $$;
drop trigger if exists credit_vers_before on public.credit_versements;
create trigger credit_vers_before before insert on public.credit_versements for each row execute function public.credit_vers_before();

-- Réception de la commission : administrateur uniquement
create or replace function public.set_versement_recu(p_id uuid, p_recu boolean) returns void
language plpgsql security definer set search_path = public as $$
declare prof public.profiles%rowtype;
begin
  if not public.is_admin() then raise exception 'Réservé à l''administrateur'; end if;
  select * into prof from public.profiles where id = auth.uid();
  update public.credit_versements set statut = case when p_recu then 'Reçue' else 'Déclarée' end,
    recu_par = case when p_recu then coalesce(nullif(prof.nom, ''), prof.email, '') else '' end,
    recu_le = case when p_recu then now() else null end
  where id = p_id;
  if not found then raise exception 'Versement introuvable'; end if;
end $$;
revoke all on function public.set_versement_recu(uuid, boolean) from public, anon;
grant execute on function public.set_versement_recu(uuid, boolean) to authenticated;

-- Retraits de l'administrateur sur le solde bénéfice d'une boutique
create table if not exists public.retraits (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  montant numeric not null check (montant > 0),
  note text not null default '',
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.retraits enable row level security;
drop policy if exists retraits_admin on public.retraits;
create policy retraits_admin on public.retraits for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on function public.set_remontee_recue(uuid, boolean) from public, anon;
grant execute on function public.set_remontee_recue(uuid, boolean) to authenticated;

-- =====================================================================
-- Bobines : approvisionnements et bobines utilisées, par boutique
-- =====================================================================
create table if not exists public.bobines_mvts (
  id uuid primary key default gen_random_uuid(),
  boutique text not null references public.boutiques(code) on update cascade on delete cascade,
  date date not null default current_date,
  type text not null check (type in ('Approvisionnement', 'Utilisation')),
  qte integer not null check (qte > 0),
  note text not null default '',
  cc text,
  saisi_par text not null default '',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists bobines_mvts_idx on public.bobines_mvts (boutique, date);
alter table public.bobines_mvts enable row level security;
drop policy if exists bobines_select on public.bobines_mvts;
create policy bobines_select on public.bobines_mvts for select to authenticated
  using (public.bobines_droit() = 'gestion' or (public.bobines_droit() in ('boutique', 'saisie') and boutique = public.my_boutique()));
drop policy if exists bobines_insert on public.bobines_mvts;
create policy bobines_insert on public.bobines_mvts for insert to authenticated
  with check (created_by = auth.uid() and date <= current_date and (public.is_admin()
    or (public.bobines_droit() = 'gestion' and type = 'Approvisionnement')
    or (public.bobines_droit() = 'saisie' and boutique = public.my_boutique() and type = 'Utilisation')));
drop policy if exists bobines_delete on public.bobines_mvts;
create policy bobines_delete on public.bobines_mvts for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and created_at > now() - interval '30 minutes'));

-- Démarrage : une première boutique avec tous les CC existants et leurs ventes.
do $$
begin
  if not exists (select 1 from public.boutiques) then
    insert into public.boutiques (code, nom) values ('B1', 'Boutique 1');
    update public.ccs set boutique = 'B1' where boutique is null;
    update public.sales s set boutique = c.boutique from public.ccs c where s.cc = c.code and s.boutique is null;
  end if;
end $$;

-- Rattrapage : courses et entrées existantes rattachées à la boutique de leur CC,
-- sinon (saisies par l'admin sans CC) à la boutique d'origine B1.
update public.courses co set boutique = c.boutique from public.ccs c where co.cc = c.code and co.boutique is null and c.boutique is not null;
update public.courses set boutique = 'B1' where boutique is null and exists (select 1 from public.boutiques where code = 'B1');
update public.entries e set boutique = co.boutique from public.courses co where e.course_id = co.id and e.boutique is distinct from co.boutique;
update public.entries e set boutique = c.boutique from public.ccs c where e.course_id is null and e.cc = c.code and e.boutique is null and c.boutique is not null;
update public.entries set boutique = 'B1' where boutique is null and exists (select 1 from public.boutiques where code = 'B1');

-- Temps réel : diffuse les nouvelles ventes, entrées et courses aux écrans ouverts
-- (les règles de sécurité ci-dessus s'appliquent aussi à cette diffusion).
do $$
declare t text;
begin
  foreach t in array array['sales', 'entries', 'courses', 'ccs', 'boutiques', 'conges', 'charges', 'remontees', 'bobines_mvts', 'stocks_initiaux', 'retraits', 'credit_achats', 'credit_versements', 'credit_soldes', 'credit_ventes', 'frigo_courses', 'frigo_ventes', 'frigo_retraits', 'frigo_dotations'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Calcule le coût moyen de tous les produits (sans effet si déjà à jour).
select public.recompute_cmp(code) from public.products;
