create index checklist_items_created_by_idx on sst.checklist_items(created_by);
create index inspection_answers_checklist_item_idx on sst.inspection_answers(checklist_item_id);
create index sectors_created_by_idx on sst.sectors(created_by);
