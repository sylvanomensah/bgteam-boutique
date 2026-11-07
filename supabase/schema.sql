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

-- Renseigne automatiquement l'auteur, son CC et l'heure de saisie ;
-- empêche un vendeur de changer ces informations ou d'antidater une entrée.
create or replace function public.entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare prof public.profiles%rowtype;
begin
  select * into prof from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.saisi_par := coalesce(nullif(prof.nom, ''), prof.email, '');
    if not public.is_admin() then
      new.cc := prof.cc;
      new.date := current_date;
      new.statut := 'Validée';
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
    insert into public.sales (ticket, date, client, code, nom, qte, pu, cc, vendeur, valide, num_client, adresse_client, created_by)
    values (
      t, case when admin then coalesce(p_date, current_date) else current_date end,
      coalesce(nullif(trim(p_client), ''), 'CLIENT COMPTOIR'),
      prod.code, prod.nom, (l ->> 'qte')::numeric,
      case when admin then (l ->> 'pu')::numeric else prod.pv end,
      p_cc, coalesce(p_vendeur, ''), 'OUI', coalesce(p_num_client, ''), coalesce(p_adresse, ''), auth.uid()
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
create policy entries_insert on public.entries for insert to authenticated with check (public.is_member() and statut = 'Validée');
drop policy if exists entries_update on public.entries;
create policy entries_update on public.entries for update to authenticated
  using (public.is_admin() or (public.is_member() and created_by = auth.uid() and created_at > now() - interval '2 hours'))
  with check (public.is_admin() or (public.is_member() and created_by = auth.uid()));
drop policy if exists entries_delete on public.entries;
create policy entries_delete on public.entries for delete to authenticated using (public.is_admin());

-- Ventes : tous les membres lisent ; création via create_sale() ; modification admin.
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select to authenticated using (public.is_member());
drop policy if exists sales_admin_write on public.sales;
create policy sales_admin_write on public.sales for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Aucun accès anonyme.
revoke all on all tables in schema public from anon;
