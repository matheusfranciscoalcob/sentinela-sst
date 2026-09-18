# Sentinela SST

Sistema multiusuário para inspeções de Segurança do Trabalho, ações 5W2H,
kanban e calendário. Este repositório é exclusivo do Sentinela SST.

## Componentes

- `site/`: aplicação estática publicada pelo GitHub Pages.
- `supabase/migrations/`: banco, RLS, gatilhos, bucket privado e setores iniciais.
- `.github/workflows/pages.yml`: publicação automática do site.

## Segurança

- O frontend usa somente a chave publicável do Supabase.
- Todas as tabelas expostas têm RLS.
- Usuários sem perfil ativo não acessam os dados.
- Técnicos realizam inspeções e atualizam ações.
- Supervisoras administram setores, formulários e níveis de acesso.
- As fotos ficam em bucket privado e são exibidas por URLs temporárias.

## Implantação atual

- Banco: projeto Supabase `reducoes-alcob`.
- Isolamento: schemas `sst` e `sst_private`, sem alterações nas tabelas dos
  outros sistemas.
- Arquivos: bucket privado `sst-safety-evidence`.
- Frontend: repositório GitHub exclusivo, publicado pelo GitHub Pages.

As migrations em `supabase/migrations/` são o histórico reproduzível do banco.
A primeira pessoa criada em Authentication depois da migration recebe o perfil
de Supervisora; as seguintes recebem o perfil de Técnica de Segurança.

Nunca coloque a chave `service_role` em `site/config.js` ou no GitHub Pages.
