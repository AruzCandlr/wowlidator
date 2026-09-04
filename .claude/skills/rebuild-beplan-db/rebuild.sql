-- rebuild-beplan-db — restore the be100 QA baseline in the local replica:
--   Total plans = 75, REIMBURSEMENT_EMPLOYEE_HR = 68, non-reimb = exactly 7.
-- Idempotent + self-correcting: run from ANY starting state after /api/db/seed.
-- Fillers are stamped created_by = 'CNEXT_MOCK' (repo rule: never untagged mock rows).

begin;

-- 1) Non-reimb: keep exactly the 7 QA-baseline plans (rule-heavy ones), drop the rest.
delete from benefit_management.benefit_plan
 where benefit_type <> 'REIMBURSEMENT_EMPLOYEE_HR'
   and benefit_plan_id not in
       ('TH_FAH_001','TH_FAH_002','TH_FAH_003','TH_PAT_001',
        'TH_WED_001','TH_MOB_002','TH_CHI_001');

-- 2) Reimb: top up to 68 by cloning real template rows into numbered series ids.
--    Pool is generated large; LIMIT takes only the deficit, so reruns insert 0.
with tpl(prefix, tpl_id) as (
  values ('TH_MED','TH_MED_001'), ('TH_DEN','TH_DEN_001'), ('TH_CHK','TH_CHK_001'),
         ('TH_GAS','TH_GAS_001'), ('TH_TOL','TH_TOL_001')
), pool as (
  select t.tpl_id, t.prefix || '_' || lpad(g.n::text, 3, '0') as new_id, g.n
  from tpl t cross join generate_series(2, 40) as g(n)
  where not exists (select 1 from benefit_management.benefit_plan x
                    where x.benefit_plan_id = t.prefix || '_' || lpad(g.n::text, 3, '0'))
  order by g.n, t.prefix
)
insert into benefit_management.benefit_plan
  (country, benefit_category, benefit_name, status, benefit_type,
   enrollment_type, claim_period, entitlement_amount_calc_method,
   eligible_claim_day, special_claim_condition_flag, company_code,
   benefit_plan_id, effective_start_date, effective_end_date, created_at, created_by)
select b.country, b.benefit_category,
       jsonb_build_object(
         'benefitNameEn', (b.benefit_name->>'benefitNameEn') || ' Plan ' || p.n,
         'benefitNameTh', (b.benefit_name->>'benefitNameTh') || ' แผน ' || p.n),
       'A', b.benefit_type, b.enrollment_type, b.claim_period,
       b.entitlement_amount_calc_method, b.eligible_claim_day,
       b.special_claim_condition_flag, b.company_code,
       p.new_id, b.effective_start_date, b.effective_end_date, now(), 'CNEXT_MOCK'
from pool p
join benefit_management.benefit_plan b on b.benefit_plan_id = p.tpl_id
limit greatest(0, 68 - (select count(*) from benefit_management.benefit_plan
                         where benefit_type = 'REIMBURSEMENT_EMPLOYEE_HR'));

-- 3) If a previous run overshot, trim newest CNEXT_MOCK fillers back down to 68.
delete from benefit_management.benefit_plan
 where id in (
   select id from benefit_management.benefit_plan
    where benefit_type = 'REIMBURSEMENT_EMPLOYEE_HR' and created_by = 'CNEXT_MOCK'
    order by id desc
    limit greatest(0, (select count(*) from benefit_management.benefit_plan
                        where benefit_type = 'REIMBURSEMENT_EMPLOYEE_HR') - 68));

commit;

-- Verify: must print 75 | 68 | 7.
select count(*) as total,
       count(*) filter (where benefit_type = 'REIMBURSEMENT_EMPLOYEE_HR') as reimb_emp_hr,
       count(*) filter (where benefit_type <> 'REIMBURSEMENT_EMPLOYEE_HR') as non_reimb
from benefit_management.benefit_plan;

-- Verify templates: must return 0 rows. A listed id is a baseline/template plan
-- that is MISSING (hard-deleted via the UI and not re-seeded) — the filler
-- top-up silently skips a missing template's series, so the baseline drifts
-- even though the counts still read 75/68. Fix: POST /api/db/seed, then re-run.
select missing.id as missing_template
from (values ('TH_MED_001'),('TH_DEN_001'),('TH_CHK_001'),('TH_GAS_001'),('TH_TOL_001')) as missing(id)
where not exists (select 1 from benefit_management.benefit_plan p where p.benefit_plan_id = missing.id);
