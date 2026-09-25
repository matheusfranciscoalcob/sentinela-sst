-- Permite que técnicas(os) editem somente as próprias inspeções e que
-- supervisoras editem qualquer inspeção, sem alterar registros existentes.
drop policy if exists sst_inspections_update on sst.inspections;
create policy sst_inspections_update on sst.inspections
for update to authenticated
using (
  (select sst_private.is_supervisor())
  or inspector_id = (select auth.uid())
)
with check (
  (select sst_private.is_supervisor())
  or inspector_id = (select auth.uid())
);

drop policy if exists sst_answers_update on sst.inspection_answers;
create policy sst_answers_update on sst.inspection_answers
for update to authenticated
using (
  (select sst_private.is_supervisor())
  or exists (
    select 1
    from sst.inspections i
    where i.id = inspection_id
      and i.inspector_id = (select auth.uid())
  )
)
with check (
  (select sst_private.is_supervisor())
  or exists (
    select 1
    from sst.inspections i
    where i.id = inspection_id
      and i.inspector_id = (select auth.uid())
  )
);

-- Identidade e vínculo da inspeção não podem ser trocados durante uma edição.
create or replace function sst_private.protect_inspection_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.id = old.id;
  new.code = old.code;
  new.sector_id = old.sector_id;
  new.inspector_id = old.inspector_id;
  new.created_at = old.created_at;
  return new;
end;
$$;
revoke execute on function sst_private.protect_inspection_identity() from public, anon, authenticated;

drop trigger if exists sst_inspections_protect_identity on sst.inspections;
create trigger sst_inspections_protect_identity
before update on sst.inspections
for each row execute function sst_private.protect_inspection_identity();

-- Sincroniza somente os campos originados pela constatação. Campos 5W2H já
-- personalizados são preservados. Ações não são excluídas quando um item volta
-- a ficar conforme, mantendo a rastreabilidade do plano de ação.
create or replace function sst_private.sync_action_from_finding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inspection_row sst.inspections%rowtype;
  sector_name text;
begin
  if new.result = 'conforme' then
    return new;
  end if;

  update sst.actions a
  set
    type = new.result,
    what = case when a.what is not distinct from old.finding then new.finding else a.what end,
    priority = case when a.priority = old.priority then new.priority else a.priority end,
    photo_paths = new.photo_paths
  where a.source_answer_id = new.id;

  if not found then
    select * into inspection_row from sst.inspections where id = new.inspection_id;
    select name into sector_name from sst.sectors where id = inspection_row.sector_id;

    insert into sst.actions(
      source_answer_id, sector_id, type, what, why, where_text, who_text,
      start_date, due_date, how_text, how_much, priority, status, photo_paths,
      created_by
    ) values (
      new.id, inspection_row.sector_id, new.result, new.finding,
      'Apontamento identificado durante a inspeção ' || inspection_row.code,
      sector_name, 'A definir', inspection_row.inspection_date,
      inspection_row.inspection_date,
      'Definir e executar a medida corretiva ou preventiva.', 'A definir',
      new.priority, 'a_fazer', new.photo_paths, inspection_row.inspector_id
    );
  end if;

  return new;
end;
$$;
revoke execute on function sst_private.sync_action_from_finding() from public, anon, authenticated;

drop trigger if exists sst_answer_sync_action on sst.inspection_answers;
create trigger sst_answer_sync_action
after update of result, finding, priority, photo_paths on sst.inspection_answers
for each row execute function sst_private.sync_action_from_finding();

-- Uma única chamada atualiza cabeçalho e respostas na mesma transação.
create or replace function sst.update_inspection(
  p_inspection_id uuid,
  p_inspection_date date,
  p_inspector_name text,
  p_answers jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  answer jsonb;
  updated_count integer := 0;
  expected_count integer := jsonb_array_length(p_answers);
begin
  if nullif(btrim(p_inspector_name), '') is null then
    raise exception 'O nome do inspetor é obrigatório.';
  end if;

  update sst.inspections
  set inspection_date = p_inspection_date,
      inspector_name = btrim(p_inspector_name)
  where id = p_inspection_id;

  if not found then
    raise exception 'Inspeção não encontrada ou sem permissão para editar.';
  end if;

  for answer in select value from jsonb_array_elements(p_answers)
  loop
    update sst.inspection_answers
    set result = answer->>'result',
        finding = nullif(btrim(answer->>'finding'), ''),
        priority = answer->>'priority',
        photo_paths = array(
          select jsonb_array_elements_text(coalesce(answer->'photo_paths', '[]'::jsonb))
        )
    where id = (answer->>'id')::uuid
      and inspection_id = p_inspection_id;

    if found then
      updated_count := updated_count + 1;
    end if;
  end loop;

  if updated_count <> expected_count then
    raise exception 'Uma ou mais respostas não pertencem a esta inspeção.';
  end if;
end;
$$;

revoke all on function sst.update_inspection(uuid, date, text, jsonb) from public, anon;
grant execute on function sst.update_inspection(uuid, date, text, jsonb) to authenticated;
