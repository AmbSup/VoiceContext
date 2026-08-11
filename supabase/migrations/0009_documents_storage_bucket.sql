-- Storage bucket for uploaded documents (see CONTEXT.md "Segmentation
-- Engine" / docs/implementation-plan.md Phase 5: "Dokumenten-Upload ...
-- als gleichwertige Inputs zur Segmentation/Extraction-Pipeline"). Private
-- bucket — objects are never served publicly, only read back by their
-- owner via a signed URL.
--
-- Object path convention: `${context_space_id}/${uuid}-${file_name}` — the
-- leading context_space_id folder is what the RLS policy below checks
-- against, reusing the same private.user_context_space_ids() helper as
-- every other "member access" policy (see 0008_fix_rls_recursion.sql).

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "member access" on storage.objects for all
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (select private.user_context_space_ids())
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1]::uuid in (select private.user_context_space_ids())
  );
