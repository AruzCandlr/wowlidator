-- Read-only evidence queries, HRCenter-SIT (schema employee_center). Probe first name: __PROBE__
-- Q1 identity + employment
select pi.first_name->>'en_GB' as first_name_en, pi.last_name->>'en_GB' as last_name_en, pi.salutation->>'en_GB' as salutation, pi.gender, pi.nationality, pi.date_of_birth,
       ei.employee_id, ei.effective_start_date, ei.hiring_not_completed, ei.created_at
from employee_center.person_information pi
join employee_center.employment_information ei on ei.person_id = pi.person_id
where pi.first_name->>'en_GB' = '__PROBE__' order by ei.created_at desc;
-- Q2 job record
select ej.employee_id, ej.effective_start_date, ej.event_reason_code, ej.employee_status, ej.employee_group_code,
       ej.employee_subgroup_code, ej.business_group_code, ej.business_unit_code, ej.company_code, ej.division_code,
       ej.department_code, ej.position_code, ej.cost_center_code, ej.store_branch_location_code, ej.work_location_code,
       ej.sso_location_code, ej.job_code_code, ej.policy_profile
from employee_center.employment_jobs ej
where ej.employee_id in (select ei.employee_id from employee_center.employment_information ei
  join employee_center.person_information pi on pi.person_id = ei.person_id where pi.first_name->>'en_GB' = '__PROBE__');
-- Q3 home address
select pa.address_type, pa.province, pa.district, pa.sub_district, pa.postal_code, pa.house_street_number
from employee_center.person_addresses pa
where pa.person_id in (select person_id from employee_center.person_information where first_name->>'en_GB' = '__PROBE__');
-- Q4 probation
select pt.employee_id, pt.probation_status, pt.effective_date, pt.pass_probation_date
from employee_center.probation_transactions pt
where pt.employee_id in (select ei.employee_id from employee_center.employment_information ei
  join employee_center.person_information pi on pi.person_id = ei.person_id where pi.first_name->>'en_GB' = '__PROBE__');
-- Q5 counts
select (select count(*) from employee_center.person_information) as person_information_rows,
       (select count(*) from employee_center.employment_jobs) as employment_jobs_rows,
       (select count(*) from employee_center.transaction_new_hires) as transaction_new_hires_rows;
