-- The original 015 generated payload is retained as a no-op because it never
-- reached production. Seed these authored commercial playbooks atomically.
do $$
declare
  catalog jsonb := jsonb_build_array(
    jsonb_build_object(
      'code', 'business-operations', 'name', 'Business Operations Playbook',
      'description', 'Recurring operational improvement for business systems, lead flow, CRM, reporting, and documented ways of working.',
      'definition', '{"shortName":"BOP","type":"operations","qualification":[{"id":"agreement","label":"Operating agreement active"},{"id":"owner","label":"Client decision maker identified"},{"id":"baseline","label":"Operational baseline captured"},{"id":"cadence","label":"Review cadence agreed"}],"assets":[{"id":"systems-access","name":"Systems Access","category":"Access","required":true,"description":"Approved vault references for operational systems."},{"id":"kpi-baseline","name":"KPI Baseline","category":"Reporting","required":true,"description":"Current lead, conversion, revenue, and service metrics."}],"deliverables":[{"id":"operating-plan","name":"Operating Improvement Plan","description":"Prioritised operating outcomes for the engagement.","clientApprovalRequired":true},{"id":"monthly-review","name":"Monthly Operating Review","description":"Decisions, priorities, capacity, and risks for the period.","clientApprovalRequired":true},{"id":"quarterly-health","name":"Quarterly Systems Health Review","description":"System health, progress, and next-quarter recommendations.","clientApprovalRequired":true}],"training":[{"id":"operating-review","name":"Operating Review","scope":"Using the review cadence to make operating decisions.","competencies":["Can prepare decisions and blockers","Can interpret the capacity report","Can act on agreed priorities"]}],"phases":[{"id":"bop1","tag":"Foundation","title":"Operational Foundation","objective":"Establish a measurable, secure operating baseline.","color":"#1A5FDB","tasks":[{"label":"Confirm operating outcomes and cadence","clientAction":true},{"label":"Capture systems and KPI baseline"},{"label":"Create initial improvement backlog"}]},{"id":"bop2","tag":"Cycle","title":"Recurring Operating Cycle","objective":"Run the agreed improvement work and review the outcome.","color":"#0E8A8A","tasks":[{"label":"Open operating cycle"},{"label":"Complete prioritised system work"},{"label":"Review CRM, lead flow, and reporting"},{"label":"Publish monthly operating review"}]},{"id":"bop3","tag":"Quarterly","title":"Quarterly Improvement Review","objective":"Reassess the roadmap and system health.","color":"#7C3AED","tasks":[{"label":"Complete systems health review"},{"label":"Reprioritise roadmap with client","clientAction":true},{"label":"Close quarter and set next-cycle objectives"}]}]}'::jsonb
    ),
    jsonb_build_object(
      'code', 'digital-presence-operations', 'name', 'Digital Presence Operating Playbook',
      'description', 'Recurring digital-presence management covering content planning, publishing, engagement, platform health, analytics, and client reporting.',
      'definition', '{"shortName":"DPOP","type":"operations","qualification":[{"id":"agreement","label":"Digital presence operating agreement active"},{"id":"platforms","label":"Managed platforms confirmed"},{"id":"brand","label":"Brand and approval process confirmed"},{"id":"cadence","label":"Content and reporting cadence agreed"}],"assets":[{"id":"brand-kit","name":"Current Brand Kit","category":"Brand","required":true,"description":"Approved logo, colours, imagery, and voice guidance."},{"id":"platform-access","name":"Platform Access","category":"Access","required":true,"description":"Secure vault references and delegated account access."}],"deliverables":[{"id":"content-plan","name":"Content Plan","description":"Approved period content plan and production schedule.","clientApprovalRequired":true},{"id":"published-content","name":"Published Content","description":"Published content and source references.","clientApprovalRequired":false},{"id":"monthly-report","name":"Digital Presence Report","description":"Performance, insights, and next-period recommendations.","clientApprovalRequired":true}],"training":[{"id":"content-approval","name":"Content Approval","scope":"Using the content approval process and interpreting reports.","competencies":["Can review and approve content","Can identify business inputs Laminar needs","Can interpret core platform metrics"]}],"phases":[{"id":"dpop1","tag":"Foundation","title":"Operating Foundation","objective":"Confirm managed channels, authority, and reporting baseline.","color":"#1A5FDB","tasks":[{"label":"Confirm platform scope and access","clientAction":true},{"label":"Capture performance baseline"},{"label":"Agree content approval and escalation process","clientAction":true}]},{"id":"dpop2","tag":"Cycle","title":"Content Operating Cycle","objective":"Plan, produce, approve, publish, and learn from a recurring content period.","color":"#1877F2","tasks":[{"label":"Open content cycle and collect business inputs","clientAction":true},{"label":"Create content plan and production queue"},{"label":"Obtain client approvals","clientAction":true},{"label":"Schedule and publish approved content"},{"label":"Monitor engagement and platform health"}]},{"id":"dpop3","tag":"Review","title":"Performance Review","objective":"Report performance and improve the next cycle.","color":"#7C3AED","tasks":[{"label":"Prepare digital presence report"},{"label":"Review results and next priorities with client","clientAction":true},{"label":"Close cycle and carry forward decisions"}]}]}'::jsonb
    ),
    jsonb_build_object(
      'code', 'mobile-app', 'name', 'Mobile App Playbook',
      'description', 'Structured delivery for a mobile product from discovery and validation through build, store release, training, and handoff.',
      'definition', '{"shortName":"MAP","type":"application-delivery","qualification":[{"id":"problem","label":"User problem and success metric defined"},{"id":"owner","label":"Product decision maker identified"},{"id":"budget","label":"Budget and delivery approach confirmed"},{"id":"privacy","label":"Privacy, data, and compliance needs assessed"},{"id":"stores","label":"Release ownership and store accounts confirmed"}],"assets":[{"id":"product-brief","name":"Product Brief","category":"Product","required":true,"description":"Users, jobs, constraints, success measures, and scope."},{"id":"brand-kit","name":"Brand Kit","category":"Brand","required":true,"description":"Approved visual identity and product voice."},{"id":"store-accounts","name":"Store Account References","category":"Access","required":true,"description":"Secure references for Apple and Google release accounts."}],"deliverables":[{"id":"product-spec","name":"Product Specification","description":"Approved scope, flows, requirements, and acceptance criteria.","clientApprovalRequired":true},{"id":"design-system","name":"Mobile Design System","description":"Approved visual and interaction system.","clientApprovalRequired":true},{"id":"release-candidate","name":"Release Candidate","description":"Tested mobile build ready for store submission.","clientApprovalRequired":true},{"id":"store-release","name":"Store Release","description":"Published store release.","clientApprovalRequired":true},{"id":"handoff","name":"Technical Handoff","description":"Repository, environments, release process, and support documentation.","clientApprovalRequired":true}],"training":[{"id":"product-admin","name":"Product Administration","scope":"Operating the delivered product and release/support process.","competencies":["Can access product administration safely","Can identify support and release responsibilities","Can request product changes through the agreed process"]}],"phases":[{"id":"map1","tag":"Discover","title":"Discovery and Validation","objective":"Confirm the product problem, users, and delivery case.","color":"#1A5FDB","tasks":[{"label":"Define user problem and success metrics","clientAction":true},{"label":"Document user flows and product scope"},{"label":"Confirm privacy, data, and integration constraints"}]},{"id":"map2","tag":"Design","title":"Product and Experience Design","objective":"Create an approved, buildable mobile experience.","color":"#7C3AED","tasks":[{"label":"Create information architecture and wireframes"},{"label":"Design key mobile flows and states"},{"label":"Approve product specification and design","clientAction":true}]},{"id":"map3","tag":"Build","title":"Application Build","objective":"Build, integrate, and validate the mobile product.","color":"#0E8A8A","tasks":[{"label":"Set up repository, environments, and release pipeline"},{"label":"Implement priority product flows"},{"label":"Implement approved integrations and analytics"},{"label":"Complete internal quality assurance"}]},{"id":"map4","tag":"Release","title":"Acceptance and Release","objective":"Validate the release candidate and publish safely.","color":"#D97706","tasks":[{"label":"Coordinate client acceptance testing","clientAction":true},{"label":"Resolve release-blocking findings"},{"label":"Prepare store listing and release notes"},{"label":"Submit and publish store release"}]},{"id":"map5","tag":"Handoff","title":"Training and Handoff","objective":"Transfer operational knowledge and establish post-launch support.","color":"#16A34A","tasks":[{"label":"Deliver product administration training","clientAction":true},{"label":"Deliver technical and release handoff"},{"label":"Confirm support and change process","clientAction":true}]}]}'::jsonb
    )
  );
  item jsonb;
  phase jsonb;
  task jsonb;
  phase_position integer;
  task_position integer;
  current_playbook_id uuid;
  current_version_id uuid;
  current_phase_id uuid;
begin
  for item in select value from jsonb_array_elements(catalog) loop
    insert into public.playbooks (code, name, description)
    values (item ->> 'code', item ->> 'name', item ->> 'description')
    on conflict (code) do update set name = excluded.name, description = excluded.description
    returning id into current_playbook_id;

    insert into public.playbook_versions (playbook_id, version_number, status, definition, published_at)
    values (current_playbook_id, 1, 'published', item -> 'definition', now())
    on conflict (playbook_id, version_number) do update
      set definition = excluded.definition, status = 'published', published_at = coalesce(public.playbook_versions.published_at, now())
    returning id into current_version_id;

    phase_position := 0;
    for phase in select value from jsonb_array_elements(item -> 'definition' -> 'phases') loop
      phase_position := phase_position + 1;
      insert into public.playbook_phases (playbook_version_id, stable_key, position, label, title, objective, color)
      values (current_version_id, phase ->> 'id', phase_position, coalesce(phase ->> 'tag', 'Phase ' || phase_position), phase ->> 'title', phase ->> 'objective', phase ->> 'color')
      on conflict (playbook_version_id, stable_key) do update set position = excluded.position, label = excluded.label, title = excluded.title, objective = excluded.objective, color = excluded.color
      returning id into current_phase_id;

      task_position := 0;
      for task in select value from jsonb_array_elements(phase -> 'tasks') loop
        task_position := task_position + 1;
        insert into public.playbook_task_templates (phase_id, stable_key, position, title, guidance, client_action, required_evidence, validation_rules)
        values (current_phase_id, (phase ->> 'id') || '-' || (task_position - 1), task_position, task ->> 'label', task ->> 'hint', coalesce((task ->> 'clientAction')::boolean, false), '[]'::jsonb, '{}'::jsonb)
        on conflict (phase_id, stable_key) do update set position = excluded.position, title = excluded.title, guidance = excluded.guidance, client_action = excluded.client_action;
      end loop;
    end loop;
  end loop;
end;
$$;
