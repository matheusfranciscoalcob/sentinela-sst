-- Sentinela SST — módulo isolado dentro do projeto reducoes-alcob.
create schema if not exists sst;
create schema if not exists sst_private;
revoke all on schema sst from public, anon;
revoke all on schema sst_private from public, anon;
grant usage on schema sst to authenticated, service_role;

create table sst.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role text not null default 'technician' check (role in ('technician','supervisor')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sst.sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#0b6b58' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  description text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sst.checklist_items (
  id uuid primary key default gen_random_uuid(),
  sector_id uuid not null references sst.sectors(id) on delete cascade,
  prompt text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create sequence sst.inspection_code_seq;
create table sst.inspections (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('INS-' || lpad(nextval('sst.inspection_code_seq')::text,6,'0')),
  sector_id uuid not null references sst.sectors(id) on delete restrict,
  inspection_date date not null default current_date,
  inspector_id uuid not null references auth.users(id) on delete restrict,
  inspector_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sst.inspection_answers (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references sst.inspections(id) on delete cascade,
  checklist_item_id uuid references sst.checklist_items(id) on delete set null,
  question_snapshot text not null,
  result text not null check (result in ('conforme','nao_conformidade','oportunidade')),
  finding text,
  priority text not null default 'media' check (priority in ('alta','media','baixa')),
  photo_paths text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint finding_required_for_issue check (result='conforme' or nullif(btrim(finding),'') is not null)
);

create table sst.actions (
  id uuid primary key default gen_random_uuid(),
  source_answer_id uuid unique references sst.inspection_answers(id) on delete set null,
  sector_id uuid not null references sst.sectors(id) on delete restrict,
  type text not null default 'avulsa' check (type in ('nao_conformidade','oportunidade','avulsa')),
  what text not null,
  why text not null,
  where_text text not null,
  who_text text not null default 'A definir',
  start_date date,
  due_date date not null default current_date,
  how_text text not null default 'Definir e executar a medida corretiva ou preventiva.',
  how_much text not null default 'A definir',
  priority text not null default 'media' check (priority in ('alta','media','baixa')),
  status text not null default 'a_fazer' check (status in ('a_fazer','em_andamento','aguardando','concluida')),
  photo_paths text[] not null default '{}',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index checklist_items_sector_idx on sst.checklist_items(sector_id,sort_order);
create index inspections_sector_idx on sst.inspections(sector_id);
create index inspections_date_idx on sst.inspections(inspection_date desc);
create index inspections_inspector_idx on sst.inspections(inspector_id);
create index inspection_answers_inspection_idx on sst.inspection_answers(inspection_id);
create index actions_sector_idx on sst.actions(sector_id);
create index actions_status_due_idx on sst.actions(status,due_date);
create index actions_created_by_idx on sst.actions(created_by);

create or replace function sst_private.is_member() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from sst.profiles where id=(select auth.uid()) and active=true);
$$;
create or replace function sst_private.is_supervisor() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from sst.profiles where id=(select auth.uid()) and active=true and role='supervisor');
$$;
revoke execute on function sst_private.is_member() from public,anon;
revoke execute on function sst_private.is_supervisor() from public,anon;
grant usage on schema sst_private to authenticated;
grant execute on function sst_private.is_member() to authenticated;
grant execute on function sst_private.is_supervisor() to authenticated;

create or replace function sst_private.handle_new_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into sst.profiles(id,email,full_name,role) values(
    new.id,coalesce(new.email,''),
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''),split_part(coalesce(new.email,'usuario'),'@',1)),
    case when not exists(select 1 from sst.profiles) then 'supervisor' else 'technician' end
  ) on conflict(id) do nothing;
  return new;
end;
$$;
revoke execute on function sst_private.handle_new_user() from public,anon,authenticated;
create trigger sst_on_auth_user_created after insert on auth.users
for each row execute function sst_private.handle_new_user();

create or replace function sst_private.set_updated_at() returns trigger
language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end; $$;
revoke execute on function sst_private.set_updated_at() from public,anon,authenticated;
create trigger sst_profiles_updated before update on sst.profiles for each row execute function sst_private.set_updated_at();
create trigger sst_sectors_updated before update on sst.sectors for each row execute function sst_private.set_updated_at();
create trigger sst_inspections_updated before update on sst.inspections for each row execute function sst_private.set_updated_at();
create trigger sst_actions_updated before update on sst.actions for each row execute function sst_private.set_updated_at();

create or replace function sst_private.create_action_from_finding() returns trigger
language plpgsql security definer set search_path='' as $$
declare inspection_row sst.inspections%rowtype; sector_name text;
begin
  if new.result='conforme' then return new; end if;
  select * into inspection_row from sst.inspections where id=new.inspection_id;
  select name into sector_name from sst.sectors where id=inspection_row.sector_id;
  insert into sst.actions(source_answer_id,sector_id,type,what,why,where_text,who_text,start_date,due_date,how_text,how_much,priority,status,photo_paths,created_by)
  values(new.id,inspection_row.sector_id,new.result,new.finding,'Apontamento identificado durante a inspeção '||inspection_row.code,sector_name,'A definir',inspection_row.inspection_date,inspection_row.inspection_date,'Definir e executar a medida corretiva ou preventiva.','A definir',new.priority,'a_fazer',new.photo_paths,inspection_row.inspector_id);
  return new;
end;
$$;
revoke execute on function sst_private.create_action_from_finding() from public,anon,authenticated;
create trigger sst_answer_create_action after insert on sst.inspection_answers
for each row execute function sst_private.create_action_from_finding();

create or replace function sst_private.protect_action_identity() returns trigger
language plpgsql set search_path='' as $$
begin new.created_by=old.created_by; new.source_answer_id=old.source_answer_id; return new; end;
$$;
revoke execute on function sst_private.protect_action_identity() from public,anon,authenticated;
create trigger sst_actions_protect_identity before update on sst.actions
for each row execute function sst_private.protect_action_identity();

alter table sst.profiles enable row level security;
alter table sst.sectors enable row level security;
alter table sst.checklist_items enable row level security;
alter table sst.inspections enable row level security;
alter table sst.inspection_answers enable row level security;
alter table sst.actions enable row level security;
revoke all on all tables in schema sst from anon,authenticated;
grant select on all tables in schema sst to authenticated;
grant insert,update,delete on sst.sectors,sst.checklist_items to authenticated;
grant insert,update,delete on sst.inspections,sst.inspection_answers,sst.actions to authenticated;
grant update on sst.profiles to authenticated;
grant usage,select on sequence sst.inspection_code_seq to authenticated;

create policy sst_profiles_select on sst.profiles for select to authenticated using(id=(select auth.uid()) or (select sst_private.is_supervisor()));
create policy sst_profiles_update on sst.profiles for update to authenticated using((select sst_private.is_supervisor())) with check((select sst_private.is_supervisor()));
create policy sst_sectors_select on sst.sectors for select to authenticated using((select sst_private.is_member()));
create policy sst_sectors_insert on sst.sectors for insert to authenticated with check((select sst_private.is_supervisor()) and created_by=(select auth.uid()));
create policy sst_sectors_update on sst.sectors for update to authenticated using((select sst_private.is_supervisor())) with check((select sst_private.is_supervisor()));
create policy sst_sectors_delete on sst.sectors for delete to authenticated using((select sst_private.is_supervisor()));
create policy sst_checklist_select on sst.checklist_items for select to authenticated using((select sst_private.is_member()));
create policy sst_checklist_insert on sst.checklist_items for insert to authenticated with check((select sst_private.is_supervisor()) and created_by=(select auth.uid()));
create policy sst_checklist_update on sst.checklist_items for update to authenticated using((select sst_private.is_supervisor())) with check((select sst_private.is_supervisor()));
create policy sst_checklist_delete on sst.checklist_items for delete to authenticated using((select sst_private.is_supervisor()));
create policy sst_inspections_select on sst.inspections for select to authenticated using((select sst_private.is_member()));
create policy sst_inspections_insert on sst.inspections for insert to authenticated with check((select sst_private.is_member()) and inspector_id=(select auth.uid()));
create policy sst_inspections_update on sst.inspections for update to authenticated using((select sst_private.is_supervisor())) with check((select sst_private.is_supervisor()));
create policy sst_inspections_delete on sst.inspections for delete to authenticated using((select sst_private.is_supervisor()));
create policy sst_answers_select on sst.inspection_answers for select to authenticated using((select sst_private.is_member()));
create policy sst_answers_insert on sst.inspection_answers for insert to authenticated with check((select sst_private.is_member()) and exists(select 1 from sst.inspections i where i.id=inspection_id and i.inspector_id=(select auth.uid())));
create policy sst_answers_update on sst.inspection_answers for update to authenticated using((select sst_private.is_supervisor())) with check((select sst_private.is_supervisor()));
create policy sst_answers_delete on sst.inspection_answers for delete to authenticated using((select sst_private.is_supervisor()));
create policy sst_actions_select on sst.actions for select to authenticated using((select sst_private.is_member()));
create policy sst_actions_insert on sst.actions for insert to authenticated with check((select sst_private.is_member()) and created_by=(select auth.uid()));
create policy sst_actions_update on sst.actions for update to authenticated using((select sst_private.is_member())) with check((select sst_private.is_member()));
create policy sst_actions_delete on sst.actions for delete to authenticated using((select sst_private.is_supervisor()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sst-safety-evidence','sst-safety-evidence',false,6291456,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy sst_evidence_select on storage.objects for select to authenticated
using(bucket_id='sst-safety-evidence' and (select sst_private.is_member()));
create policy sst_evidence_insert on storage.objects for insert to authenticated
with check(bucket_id='sst-safety-evidence' and (select sst_private.is_member()) and (storage.foldername(name))[1]=(select auth.uid())::text);

alter publication supabase_realtime add table sst.profiles;
alter publication supabase_realtime add table sst.sectors;
alter publication supabase_realtime add table sst.checklist_items;
alter publication supabase_realtime add table sst.inspections;
alter publication supabase_realtime add table sst.inspection_answers;
alter publication supabase_realtime add table sst.actions;

insert into sst.sectors(id,name,color,description) values
('10000000-0000-0000-0000-000000000001','Produção','#D65B45','Linhas e células produtivas'),
('10000000-0000-0000-0000-000000000002','Manutenção','#4C78A8','Oficina e intervenções técnicas'),
('10000000-0000-0000-0000-000000000003','Logística','#F2A541','Armazém, docas e movimentação'),
('10000000-0000-0000-0000-000000000004','Administrativo','#6C8E5E','Escritórios e áreas de apoio'),
('10000000-0000-0000-0000-000000000005','Utilidades','#8A63A8','Caldeiras, compressores e energia');
insert into sst.checklist_items(sector_id,prompt,sort_order) values
('10000000-0000-0000-0000-000000000001','Máquinas possuem proteções instaladas e íntegras?',1),
('10000000-0000-0000-0000-000000000001','Corredores e rotas de fuga estão desobstruídos?',2),
('10000000-0000-0000-0000-000000000001','Colaboradores utilizam os EPIs definidos para a atividade?',3),
('10000000-0000-0000-0000-000000000001','Há ordem e limpeza nos postos de trabalho?',4),
('10000000-0000-0000-0000-000000000002','Ferramentas e equipamentos estão em condições seguras?',1),
('10000000-0000-0000-0000-000000000002','Bloqueio e etiquetagem são aplicados nas intervenções?',2),
('10000000-0000-0000-0000-000000000002','Produtos químicos estão identificados e armazenados corretamente?',3),
('10000000-0000-0000-0000-000000000002','Extintores e acessos de emergência estão livres?',4),
('10000000-0000-0000-0000-000000000003','Rotas de pedestres estão sinalizadas e respeitadas?',1),
('10000000-0000-0000-0000-000000000003','Empilhadeiras apresentam checklist diário válido?',2),
('10000000-0000-0000-0000-000000000003','Materiais estão empilhados de forma estável?',3),
('10000000-0000-0000-0000-000000000003','Docas possuem proteção contra quedas?',4),
('10000000-0000-0000-0000-000000000004','Postos de trabalho estão ergonomicamente ajustados?',1),
('10000000-0000-0000-0000-000000000004','Cabos e tomadas não apresentam risco?',2),
('10000000-0000-0000-0000-000000000004','Rotas de fuga e sinalização estão visíveis?',3),
('10000000-0000-0000-0000-000000000004','Ambiente está organizado e sem obstáculos?',4),
('10000000-0000-0000-0000-000000000005','Equipamentos possuem inspeções legais válidas?',1),
('10000000-0000-0000-0000-000000000005','Painéis elétricos estão fechados, identificados e desobstruídos?',2),
('10000000-0000-0000-0000-000000000005','Vazamentos e ruídos anormais foram verificados?',3),
('10000000-0000-0000-0000-000000000005','Acesso é restrito a pessoas autorizadas?',4);
