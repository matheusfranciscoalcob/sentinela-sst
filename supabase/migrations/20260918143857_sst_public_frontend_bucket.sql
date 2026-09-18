insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sst-app',
  'sst-app',
  true,
  1048576,
  array['text/html', 'text/css', 'application/javascript', 'text/javascript']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
