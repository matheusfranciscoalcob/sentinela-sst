import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const uid = () => crypto.randomUUID();
const localIso = date => { const d = new Date(date); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const today = () => localIso(new Date());
const fmtDate = value => value ? new Intl.DateTimeFormat('pt-BR').format(new Date(`${value}T12:00:00`)) : '—';
const roleLabel = role => role === 'supervisor' ? 'Supervisora de Segurança' : 'Técnico de Segurança';
const statusLabel = { a_fazer: 'A fazer', em_andamento: 'Em andamento', aguardando: 'Aguardando', concluida: 'Concluída' };
const typeLabel = { nao_conformidade: 'Não conformidade', oportunidade: 'Oportunidade de melhoria', avulsa: 'Ação avulsa' };

const state = {
  user: null,
  profile: null,
  sectors: [],
  inspections: [],
  actions: [],
  profiles: [],
  page: 'dashboard',
  calendarDate: new Date(),
  signedUrls: new Map(),
  channel: null,
  reloadTimer: null,
};

const configured = /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_PUBLISHABLE_KEY.includes('%%');
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storageKey: 'alcob-sentinela-sst-auth-v1',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
}) : null;
const db = configured ? supabase.schema('sst') : null;

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('#toastHost').append(element);
  setTimeout(() => element.remove(), 3600);
}

function setBusy(busy, failed = false) {
  const element = $('#syncState');
  element.className = `sync-state${busy ? ' busy' : ''}${failed ? ' error' : ''}`;
  element.textContent = failed ? '● Falha ao sincronizar' : busy ? '● Sincronizando…' : '● Sincronizado';
}

function modal(content, large = false) {
  $('#modalHost').innerHTML = `<div class="modal-backdrop"><div class="modal${large ? ' large' : ''}">${content}</div></div>`;
  $$('[data-close]', $('#modalHost')).forEach(button => button.addEventListener('click', closeModal));
  $('.modal-backdrop').addEventListener('click', event => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
}

function closeModal() { $('#modalHost').innerHTML = ''; }
function sectorById(id) { return state.sectors.find(sector => sector.id === id) || { name: 'Sem setor', color: '#74847f', checklist_items: [] }; }

async function signedUrl(path) {
  if (!path) return '';
  if (state.signedUrls.has(path)) return state.signedUrls.get(path);
  const { data, error } = await supabase.storage.from('sst-safety-evidence').createSignedUrl(path, 3600);
  if (error) return '';
  state.signedUrls.set(path, data.signedUrl);
  return data.signedUrl;
}

async function signedImages(paths = []) {
  const urls = await Promise.all(paths.map(signedUrl));
  return urls.filter(Boolean).map(url => `<img class="thumb" src="${esc(url)}" alt="Evidência da inspeção">`).join('');
}

async function bootstrap() {
  if (!configured) {
    $('#boot').classList.add('hidden');
    $('#configError').classList.remove('hidden');
    return;
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) await enterApp(session.user);
  else showLogin();
  supabase.auth.onAuthStateChange((_event, sessionValue) => {
    if (!sessionValue?.user && !$('#app').classList.contains('hidden')) location.reload();
  });
}

function showLogin() {
  $('#boot').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'Entrando…';
  const { data, error } = await supabase.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
  button.disabled = false;
  button.textContent = 'Entrar';
  if (error) return toast('E-mail ou senha inválidos.', true);
  await enterApp(data.user);
});

async function enterApp(user) {
  state.user = user;
  const { data: profile, error } = await db.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) {
    $('#boot').classList.add('hidden');
    showLogin();
    return toast('Seu perfil ainda não foi liberado. Fale com a supervisão.', true);
  }
  state.profile = profile;
  $('#auth').classList.add('hidden');
  $('#boot').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userName').textContent = profile.full_name;
  $('#userRole').textContent = roleLabel(profile.role);
  $('#avatar').textContent = profile.full_name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  $('#todayText').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date());
  $$('.supervisor-only').forEach(element => element.classList.toggle('hidden', profile.role !== 'supervisor'));
  await loadAll();
  subscribeRealtime();
  navigate('dashboard');
}

async function loadAll() {
  setBusy(true);
  const [sectorsResult, inspectionsResult, actionsResult, profilesResult] = await Promise.all([
    db.from('sectors').select('*, checklist_items(*)').order('name'),
    db.from('inspections').select('*, sectors(name,color), inspection_answers(*)').order('inspection_date', { ascending: false }),
    db.from('actions').select('*, sectors(name,color)').order('due_date'),
    state.profile.role === 'supervisor' ? db.from('profiles').select('*').order('full_name') : Promise.resolve({ data: [] }),
  ]);
  const error = sectorsResult.error || inspectionsResult.error || actionsResult.error || profilesResult.error;
  if (error) { setBusy(false, true); toast(`Não foi possível carregar os dados: ${error.message}`, true); return; }
  state.sectors = (sectorsResult.data || []).map(sector => ({ ...sector, checklist_items: (sector.checklist_items || []).sort((a, b) => a.sort_order - b.sort_order) }));
  state.inspections = inspectionsResult.data || [];
  state.actions = actionsResult.data || [];
  state.profiles = profilesResult.data || [];
  setBusy(false);
}

function subscribeRealtime() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = supabase.channel('sentinela-changes');
  for (const table of ['sectors', 'checklist_items', 'inspections', 'inspection_answers', 'actions', 'profiles']) {
    state.channel.on('postgres_changes', { event: '*', schema: 'sst', table }, queueReload);
  }
  state.channel.subscribe();
}

function queueReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(async () => { await loadAll(); renderPage(state.page); }, 450);
}

function navigate(page) {
  if ((page === 'admin' || page === 'sectors') && state.profile.role !== 'supervisor') page = 'dashboard';
  state.page = page;
  $$('.page').forEach(element => element.classList.toggle('active', element.id === `page-${page}`));
  $$('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  $('#sidebar').classList.remove('open');
  const titles = { dashboard: 'Painel de segurança', inspections: 'Inspeções', actions: 'Plano de ação 5W2H', kanban: 'Kanban', calendar: 'Calendário de prazos', sectors: 'Setores e formulários', admin: 'Administração' };
  $('#topTitle').textContent = titles[page];
  renderPage(page);
}

function renderPage(page) {
  ({ dashboard: renderDashboard, inspections: renderInspections, actions: renderActions, kanban: renderKanban, calendar: renderCalendar, sectors: renderSectors, admin: renderAdmin }[page] || (() => {}))();
}

function renderDashboard() {
  const open = state.actions.filter(action => action.status !== 'concluida');
  const overdue = open.filter(action => action.due_date < today());
  const monthly = state.inspections.filter(inspection => inspection.inspection_date.slice(0, 7) === today().slice(0, 7));
  $('#stats').innerHTML = [
    ['Inspeções no mês', monthly.length, 'registros realizados', '#dcebe6'],
    ['Ações abertas', open.length, 'itens no plano', '#fff0cb'],
    ['Ações vencidas', overdue.length, 'exigem atenção', '#f8dddd'],
    ['Setores ativos', state.sectors.filter(sector => sector.active).length, 'formulários disponíveis', '#e6e0f1'],
  ].map(item => `<article class="stat" style="--tone:${item[3]}"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></article>`).join('');
  const due = [...open].sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 6);
  $('#dueList').innerHTML = due.length ? due.map(action => {
    const sector = sectorById(action.sector_id);
    return `<div class="mini-item"><i class="dot" style="background:${sector.color}"></i><div><strong>${esc(action.what)}</strong><span>${esc(sector.name)} · ${esc(action.who_text || 'Sem responsável')}</span></div><div class="date-badge"><strong>${action.due_date.slice(8, 10)}</strong><span>${new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(new Date(`${action.due_date}T12:00:00`))}</span></div></div>`;
  }).join('') : empty('Nenhum prazo aberto', 'As próximas ações aparecerão aqui.');
  const done = state.actions.filter(action => action.status === 'concluida').length;
  const percentage = state.actions.length ? Math.round(done / state.actions.length * 100) : 0;
  $('#progressRing').style.setProperty('--progress', `${percentage}%`);
  $('#progressText').textContent = `${percentage}%`;
  $('#progressCaption').textContent = state.actions.length ? `${done} de ${state.actions.length} ações concluídas` : 'O indicador começa com a primeira ação.';
}

function fillSectorFilter() {
  const current = $('#inspectionSectorFilter').value;
  $('#inspectionSectorFilter').innerHTML = '<option value="">Todos os setores</option>' + state.sectors.map(sector => `<option value="${sector.id}">${esc(sector.name)}</option>`).join('');
  $('#inspectionSectorFilter').value = current;
}

function renderInspections() {
  fillSectorFilter();
  const query = $('#inspectionSearch').value.toLowerCase();
  const filter = $('#inspectionSectorFilter').value;
  const rows = state.inspections.filter(inspection => (!filter || inspection.sector_id === filter) && (!query || [inspection.code, inspection.inspector_name, inspection.sectors?.name].join(' ').toLowerCase().includes(query)));
  $('#inspectionTable').innerHTML = rows.length ? `<table><thead><tr><th>Código</th><th>Data</th><th>Setor</th><th>Inspetor</th><th>Resultado</th><th>Ações geradas</th><th></th></tr></thead><tbody>${rows.map(inspection => {
    const problemCount = inspection.inspection_answers.filter(answer => answer.result !== 'conforme').length;
    return `<tr><td><strong>${esc(inspection.code)}</strong></td><td>${fmtDate(inspection.inspection_date)}</td><td><span class="tag" style="border-left:4px solid ${inspection.sectors?.color || '#74847f'}">${esc(inspection.sectors?.name)}</span></td><td>${esc(inspection.inspector_name)}</td><td><span class="tag ${problemCount ? 'warn' : 'ok'}">${problemCount ? `${problemCount} apontamento(s)` : 'Conforme'}</span></td><td>${problemCount}</td><td><button class="btn small" data-view-inspection="${inspection.id}">Ver</button></td></tr>`;
  }).join('')}</tbody></table>` : empty('Nenhuma inspeção encontrada', 'Inicie uma inspeção para criar o primeiro registro.');
}

function renderActions() {
  const query = $('#actionSearch').value.toLowerCase();
  const status = $('#actionStatusFilter').value;
  const rows = state.actions.filter(action => (!status || action.status === status) && (!query || [action.what, action.who_text, action.sectors?.name].join(' ').toLowerCase().includes(query)));
  $('#actionTable').innerHTML = rows.length ? `<table><thead><tr><th></th><th>Ação / O quê</th><th>Setor</th><th>Responsável</th><th>Prazo</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(action => {
    const late = action.status !== 'concluida' && action.due_date < today();
    return `<tr><td><div class="priority p-${action.priority}"></div></td><td><strong>${esc(action.what)}</strong><br><span class="muted">${esc(typeLabel[action.type] || 'Ação')}</span></td><td><span class="tag" style="border-left:4px solid ${action.sectors?.color || '#74847f'}">${esc(action.sectors?.name)}</span></td><td>${esc(action.who_text || 'A definir')}</td><td><span class="tag ${late ? 'danger' : ''}">${fmtDate(action.due_date)}</span></td><td>${statusLabel[action.status]}</td><td><button class="btn small" data-edit-action="${action.id}">Editar 5W2H</button></td></tr>`;
  }).join('')}</tbody></table>` : empty('Nenhuma ação encontrada', 'Os apontamentos das inspeções aparecem automaticamente aqui.');
}

function renderKanban() {
  const columns = Object.entries(statusLabel);
  $('#kanbanBoard').innerHTML = columns.map(([status, label]) => {
    const cards = state.actions.filter(action => action.status === status);
    return `<section class="kanban-col" data-status="${status}"><div class="kanban-title">${label}<span class="count">${cards.length}</span></div><div class="kanban-stack">${cards.map(action => `<article class="kanban-card" draggable="true" data-action-id="${action.id}" style="--sector:${action.sectors?.color || '#74847f'}"><span class="tag">${esc(action.sectors?.name)}</span><h4>${esc(action.what)}</h4><div class="meta"><span>${esc(action.who_text || 'A definir')}</span><span>${fmtDate(action.due_date)}</span></div></article>`).join('')}</div></section>`;
  }).join('');
  $$('.kanban-card').forEach(card => {
    card.addEventListener('click', () => openAction(state.actions.find(action => action.id === card.dataset.actionId)));
    card.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', card.dataset.actionId); event.stopPropagation(); });
  });
  $$('.kanban-col').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('dragover'); });
    column.addEventListener('dragleave', () => column.classList.remove('dragover'));
    column.addEventListener('drop', async event => {
      event.preventDefault(); column.classList.remove('dragover');
      const id = event.dataTransfer.getData('text/plain');
      const { error } = await db.from('actions').update({ status: column.dataset.status }).eq('id', id);
      if (error) toast(error.message, true); else { const action = state.actions.find(item => item.id === id); if (action) action.status = column.dataset.status; renderKanban(); }
    });
  });
}

function renderCalendar() {
  const year = state.calendarDate.getFullYear();
  const month = state.calendarDate.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  $('#calTitle').textContent = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(first);
  let html = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(name => `<div class="dow">${name}</div>`).join('');
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = localIso(date);
    const events = state.actions.filter(action => action.due_date === key);
    html += `<div class="day ${date.getMonth() !== month ? 'muted-day' : ''} ${key === today() ? 'today' : ''}"><div class="day-num">${date.getDate()}</div>${events.slice(0, 3).map(action => `<div class="cal-event" style="--sector:${action.sectors?.color || '#74847f'}" data-edit-action="${action.id}" title="${esc(action.what)}">${esc(action.what)}</div>`).join('')}${events.length > 3 ? `<div class="muted">+${events.length - 3} ações</div>` : ''}</div>`;
  }
  $('#calendarGrid').innerHTML = html;
}

function renderSectors() {
  const sectors = state.sectors.filter(sector => sector.active);
  $('#sectorGrid').innerHTML = sectors.length ? sectors.map(sector => {
    const inspectionCount = state.inspections.filter(inspection => inspection.sector_id === sector.id).length;
    return `<article class="sector-card" style="--sector:${sector.color}"><div class="sector-body"><h3>${esc(sector.name)}</h3><p>${esc(sector.description || 'Sem descrição')}</p><div class="sector-meta"><span>${sector.checklist_items.filter(item => item.active).length} itens no formulário</span><span>${inspectionCount} inspeções</span></div><div class="row"><button class="btn small grow" data-edit-sector="${sector.id}">Editar formulário</button><button class="btn small" data-inspect-sector="${sector.id}">Inspecionar</button></div></div></article>`;
  }).join('') : empty('Nenhum setor cadastrado', 'Adicione o primeiro setor e monte seu formulário.');
}

function renderAdmin() {
  $('#userList').innerHTML = state.profiles.map(profile => `<div class="mini-item"><div class="avatar">${profile.full_name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</div><div><strong>${esc(profile.full_name)}</strong><span>${esc(profile.email)} · ${roleLabel(profile.role)}</span></div><button class="btn small" data-edit-user="${profile.id}">Editar</button></div>`).join('');
}

async function openInspection(preselectedSectorId = '') {
  const sectors = state.sectors.filter(sector => sector.active && sector.checklist_items.some(item => item.active));
  if (!sectors.length) return toast('Cadastre um setor com checklist antes de inspecionar.', true);
  modal(`<form id="inspectionForm"><div class="modal-head"><h2>Nova inspeção de segurança</h2><button type="button" class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="grid2"><label class="field"><span>Setor</span><select id="inspectionSector" name="sector_id" required>${sectors.map(sector => `<option value="${sector.id}" ${sector.id === preselectedSectorId ? 'selected' : ''}>${esc(sector.name)}</option>`).join('')}</select></label><label class="field"><span>Data</span><input name="inspection_date" type="date" value="${today()}" required></label></div><label class="field"><span>Inspetor</span><input name="inspector_name" value="${esc(state.profile.full_name)}" required></label><div id="checklist"></div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button id="saveInspection" class="btn primary">Finalizar inspeção</button></div></form>`, true);
  const draw = () => {
    const sector = sectorById($('#inspectionSector').value);
    const items = sector.checklist_items.filter(item => item.active);
    $('#checklist').innerHTML = `<div class="notice">Checklist de <strong>${esc(sector.name)}</strong>. Cada apontamento criará uma ação 5W2H automaticamente.</div>` + items.map((item, index) => `<article class="check-item" data-item-id="${item.id}" data-question="${esc(item.prompt)}"><h4>${index + 1}. ${esc(item.prompt)}</h4><div class="status-options"><label><input type="radio" name="result-${item.id}" value="conforme" checked> Conforme</label><label><input type="radio" name="result-${item.id}" value="nao_conformidade"> Não conformidade</label><label><input type="radio" name="result-${item.id}" value="oportunidade"> Oportunidade</label></div><div class="issue-detail hidden"><label class="field"><span>Descrição do apontamento</span><textarea class="finding" placeholder="Descreva a condição encontrada"></textarea></label><div class="grid2"><label class="field"><span>Prioridade</span><select class="priority-select"><option value="alta">Alta</option><option value="media" selected>Média</option><option value="baixa">Baixa</option></select></label><label class="field"><span>Fotos (até 4)</span><input class="photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple></label></div><div class="thumbs"></div></div></article>`).join('');
    $$('.check-item').forEach(card => {
      $$('input[type=radio]', card).forEach(radio => radio.addEventListener('change', () => card.querySelector('.issue-detail').classList.toggle('hidden', radio.value === 'conforme')));
      const input = $('.photo-input', card);
      input.addEventListener('change', () => {
        input._files = [...input.files].slice(0, 4);
        $('.thumbs', card).innerHTML = input._files.map(file => `<img class="thumb" src="${URL.createObjectURL(file)}" alt="Prévia da foto">`).join('');
      });
    });
  };
  $('#inspectionSector').addEventListener('change', draw); draw();
  $('#inspectionForm').addEventListener('submit', saveInspection);
}

async function uploadInspectionPhotos(inspectionId, itemId, files) {
  const paths = [];
  for (const file of files) {
    if (file.size > 6 * 1024 * 1024) throw new Error(`A foto ${file.name} ultrapassa 6 MB.`);
    const extension = (file.name.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const path = `${state.user.id}/${inspectionId}/${itemId}/${uid()}.${extension}`;
    const { error } = await supabase.storage.from('sst-safety-evidence').upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

async function saveInspection(event) {
  event.preventDefault();
  const cards = $$('.check-item');
  for (const card of cards) {
    const result = $('input[type=radio]:checked', card).value;
    if (result !== 'conforme' && !$('.finding', card).value.trim()) return toast('Descreva todos os apontamentos.', true);
  }
  const button = $('#saveInspection'); button.disabled = true; button.textContent = 'Salvando…'; setBusy(true);
  try {
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const { data: inspection, error: inspectionError } = await db.from('inspections').insert({ sector_id: form.sector_id, inspection_date: form.inspection_date, inspector_id: state.user.id, inspector_name: form.inspector_name.trim() }).select().single();
    if (inspectionError) throw inspectionError;
    const answers = [];
    for (const card of cards) {
      const itemId = card.dataset.itemId;
      const result = $(`input[name="result-${itemId}"]:checked`, card).value;
      const photoPaths = result === 'conforme' ? [] : await uploadInspectionPhotos(inspection.id, itemId, $('.photo-input', card)._files || []);
      answers.push({ inspection_id: inspection.id, checklist_item_id: itemId, question_snapshot: card.dataset.question, result, finding: result === 'conforme' ? null : $('.finding', card).value.trim(), priority: result === 'conforme' ? 'media' : $('.priority-select', card).value, photo_paths: photoPaths });
    }
    const { error: answersError } = await db.from('inspection_answers').insert(answers);
    if (answersError) throw answersError;
    closeModal(); await loadAll(); navigate('actions'); toast('Inspeção salva e ações criadas automaticamente.');
  } catch (error) { toast(`Não foi possível salvar: ${error.message}`, true); setBusy(false, true); button.disabled = false; button.textContent = 'Finalizar inspeção'; }
}

async function viewInspection(id) {
  const inspection = state.inspections.find(item => item.id === id);
  if (!inspection) return;
  const answers = await Promise.all(inspection.inspection_answers.map(async (answer, index) => `<article class="check-item"><h4>${index + 1}. ${esc(answer.question_snapshot)}</h4><span class="tag ${answer.result === 'conforme' ? 'ok' : answer.result === 'nao_conformidade' ? 'danger' : 'warn'}">${answer.result === 'conforme' ? 'Conforme' : typeLabel[answer.result]}</span>${answer.finding ? `<p>${esc(answer.finding)}</p>` : ''}<div class="thumbs">${await signedImages(answer.photo_paths)}</div></article>`));
  modal(`<div class="modal-head"><h2>${esc(inspection.code)} · ${esc(inspection.sectors?.name)}</h2><button class="icon-btn" data-close>×</button></div><div class="modal-body"><p class="notice"><strong>${fmtDate(inspection.inspection_date)}</strong> · Inspetor: ${esc(inspection.inspector_name)}</p>${answers.join('')}</div><div class="modal-foot"><button class="btn" data-close>Fechar</button></div>`, true);
}

async function openAction(action = null) {
  const editing = Boolean(action);
  const current = action || {};
  const photos = editing ? await signedImages(current.photo_paths) : '';
  modal(`<form id="actionForm"><div class="modal-head"><h2>${editing ? 'Editar ação 5W2H' : 'Nova ação 5W2H'}</h2><button type="button" class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="grid2"><label class="field"><span>Setor</span><select name="sector_id" required>${state.sectors.filter(sector => sector.active).map(sector => `<option value="${sector.id}" ${sector.id === current.sector_id ? 'selected' : ''}>${esc(sector.name)}</option>`).join('')}</select></label><label class="field"><span>Tipo</span><select name="type"><option value="nao_conformidade" ${current.type === 'nao_conformidade' ? 'selected' : ''}>Não conformidade</option><option value="oportunidade" ${current.type === 'oportunidade' ? 'selected' : ''}>Oportunidade</option><option value="avulsa" ${current.type === 'avulsa' || !current.type ? 'selected' : ''}>Ação avulsa</option></select></label></div><label class="field"><span>O quê será feito?</span><textarea name="what" required>${esc(current.what || '')}</textarea></label><label class="field"><span>Por quê?</span><textarea name="why" required>${esc(current.why || '')}</textarea></label><div class="grid2"><label class="field"><span>Onde?</span><input name="where_text" value="${esc(current.where_text || '')}" required></label><label class="field"><span>Quem será responsável?</span><input name="who_text" value="${esc(current.who_text || '')}" required></label></div><div class="grid3"><label class="field"><span>Quando iniciar?</span><input name="start_date" type="date" value="${esc(current.start_date || today())}"></label><label class="field"><span>Prazo final</span><input name="due_date" type="date" value="${esc(current.due_date || today())}" required></label><label class="field"><span>Prioridade</span><select name="priority"><option value="alta" ${current.priority === 'alta' ? 'selected' : ''}>Alta</option><option value="media" ${current.priority === 'media' || !current.priority ? 'selected' : ''}>Média</option><option value="baixa" ${current.priority === 'baixa' ? 'selected' : ''}>Baixa</option></select></label></div><label class="field"><span>Como será feito?</span><textarea name="how_text" required>${esc(current.how_text || '')}</textarea></label><div class="grid2"><label class="field"><span>Quanto custará?</span><input name="how_much" value="${esc(current.how_much || 'A definir')}"></label><label class="field"><span>Status</span><select name="status">${Object.entries(statusLabel).map(([value, label]) => `<option value="${value}" ${current.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>${photos ? `<label class="field"><span>Evidências da inspeção</span><div class="thumbs">${photos}</div></label>` : ''}</div><div class="modal-foot">${editing && state.profile.role === 'supervisor' ? '<button type="button" id="deleteAction" class="btn danger">Excluir</button>' : ''}<button type="button" class="btn" data-close>Cancelar</button><button id="saveAction" class="btn primary">Salvar ação</button></div></form>`, true);
  $('#actionForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('#saveAction').disabled = true;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const query = editing ? db.from('actions').update(values).eq('id', current.id) : db.from('actions').insert({ ...values, created_by: state.user.id, photo_paths: [] });
    const { error } = await query;
    if (error) { $('#saveAction').disabled = false; return toast(error.message, true); }
    closeModal(); await loadAll(); renderPage(state.page); toast('Ação salva.');
  });
  if ($('#deleteAction')) $('#deleteAction').addEventListener('click', async () => {
    if (!confirm('Excluir esta ação do plano?')) return;
    const { error } = await db.from('actions').delete().eq('id', current.id);
    if (error) return toast(error.message, true);
    closeModal(); await loadAll(); renderPage(state.page); toast('Ação excluída.');
  });
}

function openSector(sector = null) {
  const editing = Boolean(sector);
  let items = (sector?.checklist_items || []).filter(item => item.active).map(item => item.prompt);
  modal(`<form id="sectorForm"><div class="modal-head"><h2>${editing ? 'Editar setor' : 'Novo setor'}</h2><button type="button" class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="grid2"><label class="field"><span>Nome do setor</span><input name="name" value="${esc(sector?.name || '')}" required></label><label class="field"><span>Cor do setor</span><input name="color" type="color" value="${esc(sector?.color || '#0b6b58')}" style="height:46px"></label></div><label class="field"><span>Descrição</span><input name="description" value="${esc(sector?.description || '')}"></label><div class="panel-head"><h3>Itens do formulário</h3><button type="button" id="addQuestion" class="btn small">+ Item</button></div><div id="formItems" class="form-list"></div></div><div class="modal-foot">${editing ? '<button type="button" id="archiveSector" class="btn danger">Arquivar</button>' : ''}<button type="button" class="btn" data-close>Cancelar</button><button id="saveSector" class="btn primary">Salvar setor</button></div></form>`);
  const draw = () => {
    $('#formItems').innerHTML = items.length ? items.map((item, index) => `<div class="form-row"><span>⋮⋮</span><input data-question="${index}" value="${esc(item)}" aria-label="Item ${index + 1}"><button type="button" class="icon-btn" data-delete-question="${index}">×</button></div>`).join('') : empty('Formulário vazio', 'Adicione pelo menos uma pergunta.');
    $$('[data-question]').forEach(input => input.addEventListener('input', () => { items[Number(input.dataset.question)] = input.value; }));
    $$('[data-delete-question]').forEach(button => button.addEventListener('click', () => { items.splice(Number(button.dataset.deleteQuestion), 1); draw(); }));
  };
  $('#addQuestion').addEventListener('click', () => { items.push(''); draw(); $$('[data-question]').at(-1)?.focus(); }); draw();
  $('#sectorForm').addEventListener('submit', async event => {
    event.preventDefault();
    const cleanItems = items.map(item => item.trim()).filter(Boolean);
    if (!cleanItems.length) return toast('Inclua pelo menos um item no formulário.', true);
    $('#saveSector').disabled = true;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      let sectorId = sector?.id;
      if (editing) {
        const { error } = await db.from('sectors').update(values).eq('id', sectorId); if (error) throw error;
        const { error: deleteError } = await db.from('checklist_items').delete().eq('sector_id', sectorId); if (deleteError) throw deleteError;
      } else {
        const { data, error } = await db.from('sectors').insert({ ...values, created_by: state.user.id }).select().single(); if (error) throw error; sectorId = data.id;
      }
      const { error: itemError } = await db.from('checklist_items').insert(cleanItems.map((prompt, index) => ({ sector_id: sectorId, prompt, sort_order: index + 1, created_by: state.user.id }))); if (itemError) throw itemError;
      closeModal(); await loadAll(); renderSectors(); toast('Setor e formulário salvos.');
    } catch (error) { $('#saveSector').disabled = false; toast(error.message, true); }
  });
  if ($('#archiveSector')) $('#archiveSector').addEventListener('click', async () => {
    if (!confirm('Arquivar este setor? Os registros anteriores serão preservados.')) return;
    const { error } = await db.from('sectors').update({ active: false }).eq('id', sector.id);
    if (error) return toast(error.message, true);
    closeModal(); await loadAll(); renderSectors();
  });
}

function openUser(profile) {
  modal(`<form id="userForm"><div class="modal-head"><h2>Editar usuário</h2><button type="button" class="icon-btn" data-close>×</button></div><div class="modal-body"><label class="field"><span>Nome</span><input name="full_name" value="${esc(profile.full_name)}" required></label><label class="field"><span>E-mail</span><input value="${esc(profile.email)}" disabled></label><label class="field"><span>Nível de acesso</span><select name="role"><option value="technician" ${profile.role === 'technician' ? 'selected' : ''}>Técnico de Segurança</option><option value="supervisor" ${profile.role === 'supervisor' ? 'selected' : ''}>Supervisora de Segurança</option></select></label></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar usuário</button></div></form>`);
  $('#userForm').addEventListener('submit', async event => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    const { error } = await db.from('profiles').update(values).eq('id', profile.id);
    if (error) return toast(error.message, true);
    closeModal(); await loadAll(); renderAdmin(); toast('Usuário atualizado.');
  });
}

function empty(title, text) { return `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`; }

$('#nav').addEventListener('click', event => { const button = event.target.closest('[data-page]'); if (button) navigate(button.dataset.page); });
document.addEventListener('click', event => {
  const page = event.target.closest('[data-page-link]'); if (page) navigate(page.dataset.pageLink);
  const inspection = event.target.closest('[data-view-inspection]'); if (inspection) viewInspection(inspection.dataset.viewInspection);
  const action = event.target.closest('[data-edit-action]'); if (action) openAction(state.actions.find(item => item.id === action.dataset.editAction));
  const sector = event.target.closest('[data-edit-sector]'); if (sector) openSector(sectorById(sector.dataset.editSector));
  const inspect = event.target.closest('[data-inspect-sector]'); if (inspect) openInspection(inspect.dataset.inspectSector);
  const user = event.target.closest('[data-edit-user]'); if (user) openUser(state.profiles.find(item => item.id === user.dataset.editUser));
});
$$('[data-open-inspection]').forEach(button => button.addEventListener('click', () => openInspection()));
$$('[data-new-action]').forEach(button => button.addEventListener('click', () => openAction()));
$('#newSectorBtn').addEventListener('click', () => openSector());
$('#inspectionSearch').addEventListener('input', renderInspections);
$('#inspectionSectorFilter').addEventListener('change', renderInspections);
$('#actionSearch').addEventListener('input', renderActions);
$('#actionStatusFilter').addEventListener('change', renderActions);
$('#prevMonth').addEventListener('click', () => { state.calendarDate.setMonth(state.calendarDate.getMonth() - 1); renderCalendar(); });
$('#nextMonth').addEventListener('click', () => { state.calendarDate.setMonth(state.calendarDate.getMonth() + 1); renderCalendar(); });
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#logoutBtn').addEventListener('click', async () => { await supabase.auth.signOut({ scope: 'local' }); location.reload(); });

bootstrap().catch(error => { $('#boot').classList.add('hidden'); $('#configError').classList.remove('hidden'); console.error(error); });
