-- Imports a reviewed Laminar JSON catalog into published playbook templates.
create function public.import_playbook_catalog(p_catalog jsonb) returns integer language plpgsql security definer set search_path=public as $$
declare p jsonb; ph jsonb; t jsonb; pb uuid; pv uuid; phase uuid; n integer:=0;
begin
 if not public.is_platform_admin() then raise exception 'not authorised'; end if;
 if p_catalog->>'format' <> 'laminar-playbook-catalog' or (p_catalog->>'formatVersion')::int <> 1 then raise exception 'unsupported catalog'; end if;
 for p in select value from jsonb_array_elements(p_catalog->'playbooks') loop
  insert into public.playbooks(code,name,description) values(p->>'code',p->>'name',p->>'description') on conflict(code) do update set name=excluded.name,description=excluded.description returning id into pb;
  insert into public.playbook_versions(playbook_id,version_number,status,definition,published_at) values(pb,split_part(p->>'version','.',1)::int,'published',p,now()) on conflict(playbook_id,version_number) do nothing returning id into pv;
  if pv is null then select id into pv from public.playbook_versions where playbook_id=pb and version_number=split_part(p->>'version','.',1)::int; else n:=n+1; end if;
  for ph in select value from jsonb_array_elements(p->'phases') loop
   insert into public.playbook_phases(playbook_version_id,stable_key,position,label,title,objective,color) values(pv,ph->>'stableKey',(ph->>'position')::int,ph->>'tag',ph->>'title',ph->>'objective',ph->>'color') on conflict(playbook_version_id,stable_key) do nothing returning id into phase;
   if phase is null then select id into phase from public.playbook_phases where playbook_version_id=pv and stable_key=ph->>'stableKey'; end if;
   for t in select value from jsonb_array_elements(ph->'tasks') loop insert into public.playbook_task_templates(phase_id,stable_key,position,title,guidance,client_action,required_evidence,validation_rules) values(phase,t->>'stableKey',(t->>'position')::int,t->>'title',t->>'guidance',coalesce((t->>'clientAction')::boolean,false),coalesce(t->'requiredEvidence','[]'),coalesce(t->'validationRules','{}')) on conflict(phase_id,stable_key) do nothing; end loop;
  end loop;
 end loop; return n;
end $$;
revoke all on function public.import_playbook_catalog(jsonb) from public;
grant execute on function public.import_playbook_catalog(jsonb) to authenticated;
