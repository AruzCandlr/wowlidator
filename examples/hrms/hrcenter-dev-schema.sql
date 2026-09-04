CREATE TABLE authentication."SequelizeMeta_authentication" (
  name character varying(255) NOT NULL
);

CREATE TABLE authentication.access_tokens (
  access_token text NOT NULL,
  user_id uuid,
  client_id uuid,
  scope character varying(255),
  issued_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE authentication.authorization_codes (
  code character varying(255) NOT NULL,
  user_id uuid,
  client_id uuid,
  redirect_uri text NOT NULL,
  scope text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255)
);

CREATE TABLE authentication.clients (
  id uuid NOT NULL,
  name character varying(255) NOT NULL,
  client_id character varying(255) NOT NULL,
  client_secret character varying(255) NOT NULL,
  grants character varying(255) NOT NULL,
  scope text,
  redirect_uri text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255)
);

CREATE TABLE authentication.refresh_tokens (
  refresh_token text NOT NULL,
  access_token text NOT NULL,
  issued_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE authentication.users (
  id uuid NOT NULL,
  username character varying(255) NOT NULL,
  password_hash character varying(255) NOT NULL,
  password_salt character varying(255) NOT NULL,
  email character varying(255) NOT NULL,
  is_active boolean DEFAULT true,
  last_login timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255)
);

CREATE TABLE benefit_management.benefit_eligibility_rule (
  id bigint NOT NULL DEFAULT nextval('benefit_management.benefit_eligibility_rule_id_seq'::regclass),
  rule_id character varying(100) NOT NULL,
  rule_name character varying(255) NOT NULL,
  rule_type character varying(10) NOT NULL,
  benefit_plan_id character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  dvt_project character varying(255),
  hiring_date_from date NOT NULL,
  hiring_date_to date NOT NULL,
  effective_type character varying(40) NOT NULL,
  waiting_period integer,
  entitlement_amount numeric(15,2),
  additional_condition jsonb,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_by character varying(255),
  maximum_amount_per_claim numeric(15,2),
  "group" character varying(100) NOT NULL,
  parent_id character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp without time zone,
  business_group_code character varying(40) NOT NULL,
  business_unit_code character varying(40),
  company_code character varying(40),
  job_code_code character varying(40),
  employee_group_code character varying(40) NOT NULL,
  employee_subgroup_code character varying(40),
  pay_grade_code_from character varying(40),
  pay_grade_code_to character varying(40)
);

CREATE TABLE benefit_management.benefit_history_logs (
  id uuid NOT NULL,
  entity_name character varying(100) NOT NULL,
  entity_id character varying(255) NOT NULL,
  action character varying(50) NOT NULL,
  field_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_by character varying(50) NOT NULL,
  applied_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE benefit_management.benefit_hospitals (
  id bigint NOT NULL DEFAULT nextval('benefit_management.benefit_hospitals_id_seq'::regclass),
  hospital_code character varying(255) NOT NULL,
  hospital_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  deleted_at timestamp with time zone
);

CREATE TABLE benefit_management.benefit_import_logs (
  id bigint NOT NULL DEFAULT nextval('benefit_management.benefit_import_logs_id_seq'::regclass),
  import_id uuid NOT NULL,
  import_type character varying(30) NOT NULL,
  target_table character varying(50) NOT NULL,
  file_name character varying(255) NOT NULL,
  file_size integer,
  file_checksum character varying(64),
  idempotency_key character varying(100),
  status character varying(20) NOT NULL,
  error_code character varying(50),
  error_message text,
  has_operator_column boolean NOT NULL DEFAULT false,
  incremental_load boolean NOT NULL DEFAULT false,
  use_locale_format boolean NOT NULL DEFAULT true,
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(50) NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(50) NOT NULL,
  uploaded_at timestamp with time zone,
  completed_at timestamp with time zone
);

CREATE TABLE benefit_management.benefit_plan (
  id integer NOT NULL DEFAULT nextval('benefit_management.benefit_plan_id_seq'::regclass),
  country character varying(2) NOT NULL,
  benefit_category character varying(20) NOT NULL,
  benefit_plan_id character varying(100) NOT NULL,
  benefit_name jsonb NOT NULL,
  status character varying(1) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL,
  benefit_type character varying(50) NOT NULL,
  benefit_sub_type character varying(50),
  main_plan_id character varying(100),
  enrollment_type character varying(10) NOT NULL,
  claim_period character varying(10) NOT NULL,
  entitlement_amount_calc_method character varying(10) NOT NULL,
  eligible_claim_day numeric,
  special_claim_condition jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  company_code jsonb NOT NULL DEFAULT '[]'::jsonb,
  special_claim_condition_flag boolean NOT NULL DEFAULT false,
  "group" character varying(100)
);

CREATE TABLE benefit_management.individual_benefit_plan (
  id integer NOT NULL DEFAULT nextval('benefit_management.individual_benefit_plan_id_seq'::regclass),
  user_id character varying(20) NOT NULL,
  year character varying(4) NOT NULL,
  status character varying(1) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  benefit_plan_id character varying(20) NOT NULL,
  rule_id character varying(20) NOT NULL,
  original_entitlement_amount_before_prorate numeric(15,2) NOT NULL,
  original_entitlement_amount_after_prorate numeric(15,2) NOT NULL,
  accumulate_amount numeric(15,2) NOT NULL DEFAULT 0,
  adjusted_entitlement_amount numeric(15,2) NOT NULL DEFAULT 0,
  final_entitlement_amount numeric(15,2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_by integer,
  reason character varying(100),
  attachments jsonb
);

CREATE TABLE benefit_management.master_hospitals (
  id bigint NOT NULL DEFAULT nextval('benefit_management.master_hospitals_id_seq'::regclass),
  hospital_code character varying(255) NOT NULL,
  hospital_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'system'::character varying,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  deleted_at timestamp with time zone
);

CREATE TABLE camunda.act_ge_bytearray (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  name_ character varying(255),
  deployment_id_ character varying(64),
  bytes_ bytea,
  generated_ boolean,
  tenant_id_ character varying(64),
  type_ integer,
  create_time_ timestamp without time zone,
  root_proc_inst_id_ character varying(64),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_ge_property (
  name_ character varying(64) NOT NULL,
  value_ character varying(300),
  rev_ integer
);

CREATE TABLE camunda.act_ge_schema_log (
  id_ character varying(64) NOT NULL,
  timestamp_ timestamp without time zone,
  version_ character varying(255)
);

CREATE TABLE camunda.act_hi_actinst (
  id_ character varying(64) NOT NULL,
  parent_act_inst_id_ character varying(64),
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64) NOT NULL,
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64) NOT NULL,
  execution_id_ character varying(64) NOT NULL,
  act_id_ character varying(255) NOT NULL,
  task_id_ character varying(64),
  call_proc_inst_id_ character varying(64),
  call_case_inst_id_ character varying(64),
  act_name_ character varying(255),
  act_type_ character varying(255) NOT NULL,
  assignee_ character varying(255),
  start_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  duration_ bigint,
  act_inst_state_ integer,
  sequence_counter_ bigint,
  tenant_id_ character varying(64),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_attachment (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  user_id_ character varying(255),
  name_ character varying(255),
  description_ character varying(4000),
  type_ character varying(255),
  task_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  url_ character varying(4000),
  content_id_ character varying(64),
  tenant_id_ character varying(64),
  create_time_ timestamp without time zone,
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_batch (
  id_ character varying(64) NOT NULL,
  type_ character varying(255),
  total_jobs_ integer,
  jobs_per_seed_ integer,
  invocations_per_job_ integer,
  seed_job_def_id_ character varying(64),
  monitor_job_def_id_ character varying(64),
  batch_job_def_id_ character varying(64),
  tenant_id_ character varying(64),
  create_user_id_ character varying(255),
  start_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  removal_time_ timestamp without time zone,
  exec_start_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_caseactinst (
  id_ character varying(64) NOT NULL,
  parent_act_inst_id_ character varying(64),
  case_def_id_ character varying(64) NOT NULL,
  case_inst_id_ character varying(64) NOT NULL,
  case_act_id_ character varying(255) NOT NULL,
  task_id_ character varying(64),
  call_proc_inst_id_ character varying(64),
  call_case_inst_id_ character varying(64),
  case_act_name_ character varying(255),
  case_act_type_ character varying(255),
  create_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  duration_ bigint,
  state_ integer,
  required_ boolean,
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_hi_caseinst (
  id_ character varying(64) NOT NULL,
  case_inst_id_ character varying(64) NOT NULL,
  business_key_ character varying(255),
  case_def_id_ character varying(64) NOT NULL,
  create_time_ timestamp without time zone NOT NULL,
  close_time_ timestamp without time zone,
  duration_ bigint,
  state_ integer,
  create_user_id_ character varying(255),
  super_case_instance_id_ character varying(64),
  super_process_instance_id_ character varying(64),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_hi_comment (
  id_ character varying(64) NOT NULL,
  type_ character varying(255),
  time_ timestamp without time zone NOT NULL,
  user_id_ character varying(255),
  task_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  action_ character varying(255),
  message_ character varying(4000),
  full_msg_ bytea,
  tenant_id_ character varying(64),
  removal_time_ timestamp without time zone,
  rev_ integer NOT NULL DEFAULT 1
);

CREATE TABLE camunda.act_hi_dec_in (
  id_ character varying(64) NOT NULL,
  dec_inst_id_ character varying(64) NOT NULL,
  clause_id_ character varying(64),
  clause_name_ character varying(255),
  var_type_ character varying(100),
  bytearray_id_ character varying(64),
  double_ double precision,
  long_ bigint,
  text_ character varying(4000),
  text2_ character varying(4000),
  tenant_id_ character varying(64),
  create_time_ timestamp without time zone,
  root_proc_inst_id_ character varying(64),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_dec_out (
  id_ character varying(64) NOT NULL,
  dec_inst_id_ character varying(64) NOT NULL,
  clause_id_ character varying(64),
  clause_name_ character varying(255),
  rule_id_ character varying(64),
  rule_order_ integer,
  var_name_ character varying(255),
  var_type_ character varying(100),
  bytearray_id_ character varying(64),
  double_ double precision,
  long_ bigint,
  text_ character varying(4000),
  text2_ character varying(4000),
  tenant_id_ character varying(64),
  create_time_ timestamp without time zone,
  root_proc_inst_id_ character varying(64),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_decinst (
  id_ character varying(64) NOT NULL,
  dec_def_id_ character varying(64) NOT NULL,
  dec_def_key_ character varying(255) NOT NULL,
  dec_def_name_ character varying(255),
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64),
  proc_inst_id_ character varying(64),
  case_def_key_ character varying(255),
  case_def_id_ character varying(64),
  case_inst_id_ character varying(64),
  act_inst_id_ character varying(64),
  act_id_ character varying(255),
  eval_time_ timestamp without time zone NOT NULL,
  removal_time_ timestamp without time zone,
  collect_value_ double precision,
  user_id_ character varying(255),
  root_dec_inst_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  dec_req_id_ character varying(64),
  dec_req_key_ character varying(255),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_hi_detail (
  id_ character varying(64) NOT NULL,
  type_ character varying(255) NOT NULL,
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  execution_id_ character varying(64),
  case_def_key_ character varying(255),
  case_def_id_ character varying(64),
  case_inst_id_ character varying(64),
  case_execution_id_ character varying(64),
  task_id_ character varying(64),
  act_inst_id_ character varying(64),
  var_inst_id_ character varying(64),
  name_ character varying(255) NOT NULL,
  var_type_ character varying(64),
  rev_ integer,
  time_ timestamp without time zone NOT NULL,
  bytearray_id_ character varying(64),
  double_ double precision,
  long_ bigint,
  text_ character varying(4000),
  text2_ character varying(4000),
  sequence_counter_ bigint,
  tenant_id_ character varying(64),
  operation_id_ character varying(64),
  removal_time_ timestamp without time zone,
  initial_ boolean
);

CREATE TABLE camunda.act_hi_ext_task_log (
  id_ character varying(64) NOT NULL,
  timestamp_ timestamp without time zone NOT NULL,
  ext_task_id_ character varying(64) NOT NULL,
  retries_ integer,
  topic_name_ character varying(255),
  worker_id_ character varying(255),
  priority_ bigint NOT NULL DEFAULT 0,
  error_msg_ character varying(4000),
  error_details_id_ character varying(64),
  act_id_ character varying(255),
  act_inst_id_ character varying(64),
  execution_id_ character varying(64),
  proc_inst_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  proc_def_key_ character varying(255),
  tenant_id_ character varying(64),
  state_ integer,
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_identitylink (
  id_ character varying(64) NOT NULL,
  timestamp_ timestamp without time zone NOT NULL,
  type_ character varying(255),
  user_id_ character varying(255),
  group_id_ character varying(255),
  task_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  operation_type_ character varying(64),
  assigner_id_ character varying(64),
  proc_def_key_ character varying(255),
  tenant_id_ character varying(64),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_incident (
  id_ character varying(64) NOT NULL,
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  execution_id_ character varying(64),
  create_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  incident_msg_ character varying(4000),
  incident_type_ character varying(255) NOT NULL,
  activity_id_ character varying(255),
  failed_activity_id_ character varying(255),
  cause_incident_id_ character varying(64),
  root_cause_incident_id_ character varying(64),
  configuration_ character varying(255),
  history_configuration_ character varying(255),
  incident_state_ integer,
  tenant_id_ character varying(64),
  job_def_id_ character varying(64),
  annotation_ character varying(4000),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_hi_job_log (
  id_ character varying(64) NOT NULL,
  timestamp_ timestamp without time zone NOT NULL,
  job_id_ character varying(64) NOT NULL,
  job_duedate_ timestamp without time zone,
  job_retries_ integer,
  job_priority_ bigint NOT NULL DEFAULT 0,
  job_exception_msg_ character varying(4000),
  job_exception_stack_id_ character varying(64),
  job_state_ integer,
  job_def_id_ character varying(64),
  job_def_type_ character varying(255),
  job_def_configuration_ character varying(255),
  act_id_ character varying(255),
  failed_act_id_ character varying(255),
  execution_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  process_instance_id_ character varying(64),
  process_def_id_ character varying(64),
  process_def_key_ character varying(255),
  deployment_id_ character varying(64),
  sequence_counter_ bigint,
  tenant_id_ character varying(64),
  hostname_ character varying(255),
  removal_time_ timestamp without time zone,
  batch_id_ character varying(64)
);

CREATE TABLE camunda.act_hi_op_log (
  id_ character varying(64) NOT NULL,
  deployment_id_ character varying(64),
  proc_def_id_ character varying(64),
  proc_def_key_ character varying(255),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  execution_id_ character varying(64),
  case_def_id_ character varying(64),
  case_inst_id_ character varying(64),
  case_execution_id_ character varying(64),
  task_id_ character varying(64),
  job_id_ character varying(64),
  job_def_id_ character varying(64),
  batch_id_ character varying(64),
  user_id_ character varying(255),
  timestamp_ timestamp without time zone NOT NULL,
  operation_type_ character varying(64),
  operation_id_ character varying(64),
  entity_type_ character varying(30),
  property_ character varying(64),
  org_value_ character varying(4000),
  new_value_ character varying(4000),
  tenant_id_ character varying(64),
  removal_time_ timestamp without time zone,
  category_ character varying(64),
  external_task_id_ character varying(64),
  annotation_ character varying(4000)
);

CREATE TABLE camunda.act_hi_procinst (
  id_ character varying(64) NOT NULL,
  proc_inst_id_ character varying(64) NOT NULL,
  business_key_ character varying(255),
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64) NOT NULL,
  start_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  removal_time_ timestamp without time zone,
  duration_ bigint,
  start_user_id_ character varying(255),
  start_act_id_ character varying(255),
  end_act_id_ character varying(255),
  super_process_instance_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  super_case_instance_id_ character varying(64),
  case_inst_id_ character varying(64),
  delete_reason_ character varying(4000),
  tenant_id_ character varying(64),
  state_ character varying(255),
  restarted_proc_inst_id_ character varying(64)
);

CREATE TABLE camunda.act_hi_taskinst (
  id_ character varying(64) NOT NULL,
  task_def_key_ character varying(255),
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  execution_id_ character varying(64),
  case_def_key_ character varying(255),
  case_def_id_ character varying(64),
  case_inst_id_ character varying(64),
  case_execution_id_ character varying(64),
  act_inst_id_ character varying(64),
  name_ character varying(255),
  parent_task_id_ character varying(64),
  description_ character varying(4000),
  owner_ character varying(255),
  assignee_ character varying(255),
  start_time_ timestamp without time zone NOT NULL,
  end_time_ timestamp without time zone,
  duration_ bigint,
  delete_reason_ character varying(4000),
  priority_ integer,
  due_date_ timestamp without time zone,
  follow_up_date_ timestamp without time zone,
  tenant_id_ character varying(64),
  removal_time_ timestamp without time zone,
  task_state_ character varying(64)
);

CREATE TABLE camunda.act_hi_varinst (
  id_ character varying(64) NOT NULL,
  proc_def_key_ character varying(255),
  proc_def_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  execution_id_ character varying(64),
  act_inst_id_ character varying(64),
  case_def_key_ character varying(255),
  case_def_id_ character varying(64),
  case_inst_id_ character varying(64),
  case_execution_id_ character varying(64),
  task_id_ character varying(64),
  name_ character varying(255) NOT NULL,
  var_type_ character varying(100),
  create_time_ timestamp without time zone,
  rev_ integer,
  bytearray_id_ character varying(64),
  double_ double precision,
  long_ bigint,
  text_ character varying(4000),
  text2_ character varying(4000),
  tenant_id_ character varying(64),
  state_ character varying(20),
  removal_time_ timestamp without time zone
);

CREATE TABLE camunda.act_id_group (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  name_ character varying(255),
  type_ character varying(255)
);

CREATE TABLE camunda.act_id_info (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  user_id_ character varying(64),
  type_ character varying(64),
  key_ character varying(255),
  value_ character varying(255),
  password_ bytea,
  parent_id_ character varying(255)
);

CREATE TABLE camunda.act_id_membership (
  user_id_ character varying(64) NOT NULL,
  group_id_ character varying(64) NOT NULL
);

CREATE TABLE camunda.act_id_tenant (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  name_ character varying(255)
);

CREATE TABLE camunda.act_id_tenant_member (
  id_ character varying(64) NOT NULL,
  tenant_id_ character varying(64) NOT NULL,
  user_id_ character varying(64),
  group_id_ character varying(64)
);

CREATE TABLE camunda.act_id_user (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  first_ character varying(255),
  last_ character varying(255),
  email_ character varying(255),
  pwd_ character varying(255),
  salt_ character varying(255),
  lock_exp_time_ timestamp without time zone,
  attempts_ integer,
  picture_id_ character varying(64)
);

CREATE TABLE camunda.act_re_camformdef (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  key_ character varying(255) NOT NULL,
  version_ integer NOT NULL,
  deployment_id_ character varying(64),
  resource_name_ character varying(4000),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_re_case_def (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  category_ character varying(255),
  name_ character varying(255),
  key_ character varying(255) NOT NULL,
  version_ integer NOT NULL,
  deployment_id_ character varying(64),
  resource_name_ character varying(4000),
  dgrm_resource_name_ character varying(4000),
  tenant_id_ character varying(64),
  history_ttl_ integer
);

CREATE TABLE camunda.act_re_decision_def (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  category_ character varying(255),
  name_ character varying(255),
  key_ character varying(255) NOT NULL,
  version_ integer NOT NULL,
  deployment_id_ character varying(64),
  resource_name_ character varying(4000),
  dgrm_resource_name_ character varying(4000),
  dec_req_id_ character varying(64),
  dec_req_key_ character varying(255),
  tenant_id_ character varying(64),
  history_ttl_ integer,
  version_tag_ character varying(64)
);

CREATE TABLE camunda.act_re_decision_req_def (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  category_ character varying(255),
  name_ character varying(255),
  key_ character varying(255) NOT NULL,
  version_ integer NOT NULL,
  deployment_id_ character varying(64),
  resource_name_ character varying(4000),
  dgrm_resource_name_ character varying(4000),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_re_deployment (
  id_ character varying(64) NOT NULL,
  name_ character varying(255),
  deploy_time_ timestamp without time zone,
  source_ character varying(255),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_re_procdef (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  category_ character varying(255),
  name_ character varying(255),
  key_ character varying(255) NOT NULL,
  version_ integer NOT NULL,
  deployment_id_ character varying(64),
  resource_name_ character varying(4000),
  dgrm_resource_name_ character varying(4000),
  has_start_form_key_ boolean,
  suspension_state_ integer,
  tenant_id_ character varying(64),
  version_tag_ character varying(64),
  history_ttl_ integer,
  startable_ boolean NOT NULL DEFAULT true
);

CREATE TABLE camunda.act_ru_authorization (
  id_ character varying(64) NOT NULL,
  rev_ integer NOT NULL,
  type_ integer NOT NULL,
  group_id_ character varying(255),
  user_id_ character varying(255),
  resource_type_ integer NOT NULL,
  resource_id_ character varying(255),
  perms_ integer,
  removal_time_ timestamp without time zone,
  root_proc_inst_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_batch (
  id_ character varying(64) NOT NULL,
  rev_ integer NOT NULL,
  type_ character varying(255),
  total_jobs_ integer,
  jobs_created_ integer,
  jobs_per_seed_ integer,
  invocations_per_job_ integer,
  seed_job_def_id_ character varying(64),
  batch_job_def_id_ character varying(64),
  monitor_job_def_id_ character varying(64),
  suspension_state_ integer,
  configuration_ character varying(255),
  tenant_id_ character varying(64),
  create_user_id_ character varying(255),
  start_time_ timestamp without time zone,
  exec_start_time_ timestamp without time zone
);

CREATE TABLE camunda.act_ru_case_execution (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  case_inst_id_ character varying(64),
  super_case_exec_ character varying(64),
  super_exec_ character varying(64),
  business_key_ character varying(255),
  parent_id_ character varying(64),
  case_def_id_ character varying(64),
  act_id_ character varying(255),
  prev_state_ integer,
  current_state_ integer,
  required_ boolean,
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_case_sentry_part (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  case_inst_id_ character varying(64),
  case_exec_id_ character varying(64),
  sentry_id_ character varying(255),
  type_ character varying(255),
  source_case_exec_id_ character varying(64),
  standard_event_ character varying(255),
  source_ character varying(255),
  variable_event_ character varying(255),
  variable_name_ character varying(255),
  satisfied_ boolean,
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_event_subscr (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  event_type_ character varying(255) NOT NULL,
  event_name_ character varying(255),
  execution_id_ character varying(64),
  proc_inst_id_ character varying(64),
  activity_id_ character varying(255),
  configuration_ character varying(255),
  created_ timestamp without time zone NOT NULL,
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_execution (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  root_proc_inst_id_ character varying(64),
  proc_inst_id_ character varying(64),
  business_key_ character varying(255),
  parent_id_ character varying(64),
  proc_def_id_ character varying(64),
  super_exec_ character varying(64),
  super_case_exec_ character varying(64),
  case_inst_id_ character varying(64),
  act_id_ character varying(255),
  act_inst_id_ character varying(64),
  is_active_ boolean,
  is_concurrent_ boolean,
  is_scope_ boolean,
  is_event_scope_ boolean,
  suspension_state_ integer,
  cached_ent_state_ integer,
  sequence_counter_ bigint,
  tenant_id_ character varying(64),
  proc_def_key_ character varying(255)
);

CREATE TABLE camunda.act_ru_ext_task (
  id_ character varying(64) NOT NULL,
  rev_ integer NOT NULL,
  worker_id_ character varying(255),
  topic_name_ character varying(255),
  retries_ integer,
  error_msg_ character varying(4000),
  error_details_id_ character varying(64),
  lock_exp_time_ timestamp without time zone,
  create_time_ timestamp without time zone,
  suspension_state_ integer,
  execution_id_ character varying(64),
  proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  proc_def_key_ character varying(255),
  act_id_ character varying(255),
  act_inst_id_ character varying(64),
  tenant_id_ character varying(64),
  priority_ bigint NOT NULL DEFAULT 0,
  last_failure_log_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_filter (
  id_ character varying(64) NOT NULL,
  rev_ integer NOT NULL,
  resource_type_ character varying(255) NOT NULL,
  name_ character varying(255) NOT NULL,
  owner_ character varying(255),
  query_ text NOT NULL,
  properties_ text
);

CREATE TABLE camunda.act_ru_identitylink (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  group_id_ character varying(255),
  type_ character varying(255),
  user_id_ character varying(255),
  task_id_ character varying(64),
  proc_def_id_ character varying(64),
  tenant_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_incident (
  id_ character varying(64) NOT NULL,
  rev_ integer NOT NULL,
  incident_timestamp_ timestamp without time zone NOT NULL,
  incident_msg_ character varying(4000),
  incident_type_ character varying(255) NOT NULL,
  execution_id_ character varying(64),
  activity_id_ character varying(255),
  failed_activity_id_ character varying(255),
  proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  cause_incident_id_ character varying(64),
  root_cause_incident_id_ character varying(64),
  configuration_ character varying(255),
  tenant_id_ character varying(64),
  job_def_id_ character varying(64),
  annotation_ character varying(4000)
);

CREATE TABLE camunda.act_ru_job (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  type_ character varying(255) NOT NULL,
  lock_exp_time_ timestamp without time zone,
  lock_owner_ character varying(255),
  exclusive_ boolean,
  execution_id_ character varying(64),
  root_proc_inst_id_ character varying(64),
  process_instance_id_ character varying(64),
  process_def_id_ character varying(64),
  process_def_key_ character varying(255),
  retries_ integer,
  exception_stack_id_ character varying(64),
  exception_msg_ character varying(4000),
  failed_act_id_ character varying(255),
  duedate_ timestamp without time zone,
  repeat_ character varying(255),
  repeat_offset_ bigint DEFAULT 0,
  handler_type_ character varying(255),
  handler_cfg_ character varying(4000),
  deployment_id_ character varying(64),
  suspension_state_ integer NOT NULL DEFAULT 1,
  job_def_id_ character varying(64),
  priority_ bigint NOT NULL DEFAULT 0,
  sequence_counter_ bigint,
  tenant_id_ character varying(64),
  create_time_ timestamp without time zone,
  last_failure_log_id_ character varying(64),
  batch_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_jobdef (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  proc_def_id_ character varying(64),
  proc_def_key_ character varying(255),
  act_id_ character varying(255),
  job_type_ character varying(255) NOT NULL,
  job_configuration_ character varying(255),
  suspension_state_ integer,
  job_priority_ bigint,
  tenant_id_ character varying(64),
  deployment_id_ character varying(64)
);

CREATE TABLE camunda.act_ru_meter_log (
  id_ character varying(64) NOT NULL,
  name_ character varying(64) NOT NULL,
  reporter_ character varying(255),
  value_ bigint,
  timestamp_ timestamp without time zone,
  milliseconds_ bigint DEFAULT 0
);

CREATE TABLE camunda.act_ru_task (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  execution_id_ character varying(64),
  proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  case_execution_id_ character varying(64),
  case_inst_id_ character varying(64),
  case_def_id_ character varying(64),
  name_ character varying(255),
  parent_task_id_ character varying(64),
  description_ character varying(4000),
  task_def_key_ character varying(255),
  owner_ character varying(255),
  assignee_ character varying(255),
  delegation_ character varying(64),
  priority_ integer,
  create_time_ timestamp without time zone,
  last_updated_ timestamp without time zone,
  due_date_ timestamp without time zone,
  follow_up_date_ timestamp without time zone,
  suspension_state_ integer,
  tenant_id_ character varying(64),
  task_state_ character varying(64)
);

CREATE TABLE camunda.act_ru_task_meter_log (
  id_ character varying(64) NOT NULL,
  assignee_hash_ bigint,
  timestamp_ timestamp without time zone
);

CREATE TABLE camunda.act_ru_variable (
  id_ character varying(64) NOT NULL,
  rev_ integer,
  type_ character varying(255) NOT NULL,
  name_ character varying(255) NOT NULL,
  execution_id_ character varying(64),
  proc_inst_id_ character varying(64),
  proc_def_id_ character varying(64),
  case_execution_id_ character varying(64),
  case_inst_id_ character varying(64),
  task_id_ character varying(64),
  batch_id_ character varying(64),
  bytearray_id_ character varying(64),
  double_ double precision,
  long_ bigint,
  text_ character varying(4000),
  text2_ character varying(4000),
  var_scope_ character varying(64),
  sequence_counter_ bigint,
  is_concurrent_local_ boolean,
  tenant_id_ character varying(64)
);

CREATE TABLE change_tracking."SequelizeMeta_change_tracking" (
  name character varying(255) NOT NULL
);

CREATE TABLE change_tracking.audit_change_requests (
  id bigint NOT NULL DEFAULT nextval('change_tracking.audit_change_requests_id_seq'::regclass),
  event_id uuid NOT NULL,
  entity_type character varying(100) NOT NULL,
  entity_id character varying(255) NOT NULL,
  page character varying(255),
  section character varying(255),
  action character varying(20) NOT NULL,
  source_module character varying(100) NOT NULL,
  correlation_id character varying(255),
  requested_at timestamp with time zone,
  requested_by character varying(255),
  approved_at timestamp with time zone,
  approved_by character varying(255),
  target_effective_at timestamp with time zone,
  applied_at timestamp with time zone NOT NULL,
  applied_by character varying(255) NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE change_tracking.audit_field_changes (
  id bigint NOT NULL DEFAULT nextval('change_tracking.audit_field_changes_id_seq'::regclass),
  audit_change_request_id bigint NOT NULL,
  field_name character varying(255) NOT NULL,
  old_value text,
  new_value text,
  value_type character varying(20) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE content_management."SequelizeMeta_content_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE content_management.languages (
  id bigint NOT NULL DEFAULT nextval('content_management.languages_id_seq'::regclass),
  code character varying(5) NOT NULL,
  name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE content_management.menu_items (
  id bigint NOT NULL DEFAULT nextval('content_management.menu_items_id_seq'::regclass),
  context character varying(50) NOT NULL,
  code character varying(100) NOT NULL,
  label jsonb NOT NULL,
  icon character varying(100) NOT NULL,
  target_type character varying(20) NOT NULL DEFAULT 'INTERNAL_LINK'::character varying,
  target_value character varying(500) NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  audience_roles jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE content_management.news_updates (
  id bigint NOT NULL DEFAULT nextval('content_management.news_updates_id_seq'::regclass),
  group_id uuid NOT NULL,
  language character varying(5) NOT NULL,
  is_main boolean NOT NULL DEFAULT false,
  title character varying(255) NOT NULL,
  summary text,
  thumbnail_url text,
  category character varying(50),
  content_type character varying(20) NOT NULL,
  external_url text,
  internal_route character varying(500),
  content_blocks jsonb,
  is_active boolean NOT NULL DEFAULT true,
  publish_at timestamp with time zone,
  expires_at timestamp with time zone,
  audience_roles jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE content_management.quick_actions (
  id bigint NOT NULL DEFAULT nextval('content_management.quick_actions_id_seq'::regclass),
  code character varying(100) NOT NULL,
  label jsonb NOT NULL,
  icon character varying(100) NOT NULL,
  target_type character varying(20) NOT NULL,
  target_value text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  audience_roles jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE delegation."SequelizeMeta_delegation" (
  name character varying(255) NOT NULL
);

CREATE TABLE delegation.delegations (
  id bigint NOT NULL DEFAULT nextval('delegation.delegations_id_seq'::regclass),
  delegator_employee_id character varying(15) NOT NULL,
  delegate_employee_id character varying(15) NOT NULL,
  workflow_type character varying(40),
  start_date date NOT NULL,
  end_date date NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center."SequelizeMeta_employee_center" (
  name character varying(255) NOT NULL
);

CREATE TABLE employee_center.employee_info_transaction_requests (
  id bigint NOT NULL DEFAULT nextval('employee_center.employee_info_transaction_requests_id_seq'::regclass),
  request_no character varying(50) NOT NULL,
  person_id character varying(15) NOT NULL,
  employee_id character varying(15) NOT NULL,
  request_type character varying(50),
  request_sub_type character varying(50),
  status character varying(30) DEFAULT 'REQUESTED'::character varying,
  current_data jsonb,
  requested_data jsonb,
  attachments jsonb,
  requested_by character varying(50),
  requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  approval_by character varying(50),
  approval_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  reason text,
  effective_date date,
  camunda_process_instance_id character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_compensation (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_compensation_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_code character varying(40) NOT NULL,
  event_reason_code character varying(40) NOT NULL,
  pay_component_code character varying(255) NOT NULL,
  frequency_code character varying(100),
  currency_code character varying(100),
  amount numeric(18,2),
  note text,
  reason_for_salary_adjust character varying(255) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_compensation_detail (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_compensation_detail_id_seq'::regclass),
  employment_compensation_id bigint NOT NULL,
  seq_number integer NOT NULL,
  reason_for_salary_adjust_id integer NOT NULL,
  amount double precision,
  notes character varying(2000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_cost_distribution (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_cost_distribution_id_seq'::regclass),
  user_id character varying(255) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_cost_distribution_item (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_cost_distribution_item_id_seq'::regclass),
  emp_cost_distribution_id bigint NOT NULL,
  cost_center_id integer NOT NULL,
  percentage numeric,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_cost_distribution_items (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_cost_distribution_items_id_seq'::regclass),
  employment_cost_distribution_code character varying(40) NOT NULL,
  cost_center_code character varying(40) NOT NULL,
  percentage numeric(7,4),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_cost_distributions (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_cost_distributions_id_seq'::regclass),
  employment_cost_distribution_code character varying(40) NOT NULL,
  employee_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_information (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  employee_id character varying(15) NOT NULL,
  is_primary boolean NOT NULL,
  effective_start_date date,
  original_start_date date,
  seniority_date date,
  pass_probation_date_confirm_date date,
  retirement_date date,
  effective_end_date date DEFAULT '9999-12-31'::date,
  pf_service_date date,
  pf_service_end_date date,
  cg_previous_employee_id character varying(15),
  replaced_employee_id character varying(15),
  employee_age_ymd character varying(255),
  dvt_previous_id character varying(255),
  current_business_unit_effective_date date,
  current_job_effective_date date,
  current_position_effective_date date,
  current_jg_effective_date date,
  current_pg_effective_date date,
  current_corporate_title_effective_date date,
  current_store_branch_effective_date date,
  hiring_not_completed boolean,
  is_special_probation boolean NOT NULL DEFAULT false,
  assignment_class character varying(128),
  personal_email character varying(255),
  service_date date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_job (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_job_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  seq_number integer NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_id integer NOT NULL,
  event_reason_id integer NOT NULL,
  is_primary boolean NOT NULL,
  is_concurrent_employment boolean,
  employee_status character varying(32),
  group_id integer NOT NULL,
  country_id integer NOT NULL,
  business_group_id integer NOT NULL,
  business_unit_id integer NOT NULL,
  company_id integer NOT NULL,
  division_id integer NOT NULL,
  department_id integer NOT NULL,
  position_id bigint NOT NULL,
  cost_center_id integer NOT NULL,
  location_id integer,
  work_location_id integer,
  sso_location_id integer,
  zone_id integer,
  pay_grade_id integer,
  job_grade_id integer,
  corporate_title_id integer,
  job_type_id integer,
  job_family_id integer,
  job_code_id integer,
  job_title_id character varying(255),
  employee_group_id integer,
  employee_subgroup_id integer,
  store_size_id integer,
  store_format_id integer,
  band_id integer,
  brand_id integer,
  pay_scale_area_id integer,
  pay_scale_group_id integer,
  pay_scale_level_id integer,
  pay_scale_type_id integer,
  hr_district_id integer,
  manager_id character varying(255),
  contract_type character varying(255),
  is_fulltime_employee boolean,
  fte double precision,
  contract_end_date date,
  policy_profile character varying(20),
  typeof_group_family_employee character varying(255),
  pass_probation character varying(255),
  extened_probation_date date,
  probation_period_end_date date,
  extened_retirement_date date,
  override_current_business_unit_effective_date date,
  override_current_position_effective_date date,
  override_current_job_effective_date date,
  override_current_corporate_title_effective_date date,
  override_current_jg_effective_date date,
  override_current_pg_effective_date date,
  override_current_store_branch_effective_date date,
  working_hour_id integer,
  time_status_id integer,
  ot_flag character varying(100),
  holiday_calendar_id integer,
  work_schedule_id integer,
  leave_quota double precision,
  override_standard_weekly_hours character varying(255),
  typeof_management_program character varying(255),
  dvt_bonding_enddate date,
  dvt_graduation_date date,
  dvt_project character varying(255),
  dvt_partner_university character varying(255),
  dvt_type character varying(80),
  dvt_degree character varying(80),
  dvt_course_of_time character varying(80),
  dvt_academic_year character varying(80),
  dvt_course character varying(255),
  is_scholarship character varying(255),
  terminate_voluntary_involuntary character varying(255),
  reason_for_termination character varying(255),
  additional_information_termination character varying(255),
  ok_to_rehire boolean,
  vn_title character varying(255),
  legacy_job_grade character varying(255),
  sales_admin_mall character varying(255),
  social_insurance character varying(255),
  health_insurance character varying(255),
  unemployment_insurance character varying(255),
  occupational_accident_insurance character varying(255),
  social_insurance_outsidethe_company character varying(255),
  insurance_area character varying(255),
  special_benefit_group character varying(255),
  union_fee character varying(255),
  transfer_from character varying(255),
  transfer_out_to character varying(255),
  band_matching character varying(2),
  point_of_sales character varying(255),
  effective_latest_change boolean,
  attachment character varying(4000),
  attachment_file_name character varying(255),
  attachment_file_size numeric,
  attachment_file_type character varying(5),
  attachment_id character varying(255),
  attachment_mime_type character varying(255),
  attachment_status numeric,
  timezone character varying(128),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_job_relationships (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_job_relationships_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  related_employee_id character varying(15) NOT NULL,
  relationship_type character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_jobs (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_jobs_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  seq_number integer NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_code character varying(40) NOT NULL,
  event_reason_code character varying(40) NOT NULL,
  is_primary boolean NOT NULL,
  is_concurrent_employment boolean,
  employee_status character varying(32),
  group_code character varying(40) NOT NULL,
  country_code character varying(40) NOT NULL,
  business_group_code character varying(40) NOT NULL,
  business_unit_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  department_code character varying(40) NOT NULL,
  position_code character varying(8) NOT NULL,
  cost_center_code character varying(40) NOT NULL,
  store_branch_location_code character varying(40),
  work_location_code character varying(40),
  sso_location_code character varying(40),
  zone_code character varying(40),
  pay_grade_code character varying(40),
  job_grade_code character varying(40),
  corporate_title character varying(255),
  job_type character varying(255),
  job_family_code character varying(40),
  job_code_code character varying(255),
  job_title character varying(255),
  employee_group_code character varying(40),
  employee_subgroup_code character varying(40),
  store_size character varying(255),
  store_format_code character varying(40),
  band character varying(255),
  brand_code character varying(40),
  pay_scale_area_code character varying(40),
  pay_scale_group_code character varying(40),
  pay_scale_level_code character varying(40),
  pay_scale_type_code character varying(40),
  pay_group_code character varying(40) NOT NULL,
  hr_district_code character varying(40),
  manager_id character varying(255),
  contract_type character varying(255),
  is_fulltime_employee boolean,
  fte numeric(6,3),
  contract_end_date date,
  policy_profile character varying(20),
  typeof_group_family_employee character varying(255),
  probation_result character varying(255),
  extended_probation_date date,
  probation_period_end_date date,
  extended_retirement_date date,
  override_current_business_unit_effective_date date,
  override_current_position_effective_date date,
  override_current_job_effective_date date,
  override_current_corporate_title_effective_date date,
  override_current_jg_effective_date date,
  override_current_pg_effective_date date,
  override_current_store_branch_effective_date date,
  time_status_code character varying(40),
  ot_flag boolean,
  holiday_calendar_code character varying(40),
  work_schedule_code character varying(40),
  work_schedule_template_code character varying(40),
  typeof_management_program character varying(255),
  dvt_bonding_enddate date,
  dvt_graduation_date date,
  dvt_project character varying(255),
  dvt_partner_university character varying(255),
  dvt_type character varying(80),
  dvt_degree character varying(80),
  dvt_course_of_time character varying(80),
  dvt_academic_year character varying(80),
  dvt_course character varying(255),
  is_scholarship character varying(255),
  vn_title character varying(255),
  legacy_job_grade character varying(255),
  sales_admin_mall character varying(255),
  social_insurance character varying(255),
  health_insurance character varying(255),
  unemployment_insurance character varying(255),
  occupational_accident_insurance character varying(255),
  social_insurance_outsidethe_company character varying(255),
  insurance_area character varying(255),
  special_benefit_group character varying(255),
  union_fee numeric(18,2),
  transfer_from character varying(255),
  transfer_in_to character varying(255),
  transfer_out_to character varying(255),
  band_matching character varying(2),
  point_of_sales character varying(255),
  effective_latest_change boolean,
  attachments jsonb,
  timezone character varying(128),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  failed_probation_date date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_termination (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_termination_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  user_id character varying(15) NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  reason_for_termination character varying(255),
  ok_to_rehire boolean,
  terminate_voluntary_involuntary character varying(255),
  event_reason_id integer,
  additional_information_termination character varying(255),
  transfer_out_to character varying(255),
  personal_email_resign character varying(255),
  last_date_worked date,
  attachment_id character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_terminations (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_terminations_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  employee_id character varying(15) NOT NULL,
  termination_date date,
  reason_for_termination character varying(255),
  ok_to_rehire boolean,
  terminate_voluntary_involuntary character varying(255),
  event_reason_code character varying(40),
  additional_information text,
  transfer_out_to character varying(255),
  personal_email_resign character varying(255),
  resigned_date date,
  attachments jsonb,
  new_employment_id character varying(15),
  is_active boolean NOT NULL DEFAULT true,
  exit_interview jsonb,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.employment_work_permit (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_work_permit_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  country_id integer NOT NULL,
  document_number character varying(255) NOT NULL,
  document_type character varying(255) NOT NULL,
  issue_date date,
  attachment character varying(4000),
  attachment_file_name character varying(255),
  attachment_file_size numeric,
  attachment_file_type character varying(5),
  attachment_id character varying(255),
  attachment_mime_type character varying(255),
  attachment_status numeric,
  arrival_date_visa date,
  days90_report_visa date,
  expiration_date date,
  notes character varying(4000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.employment_work_permits (
  id bigint NOT NULL DEFAULT nextval('employee_center.employment_work_permits_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  country_code character varying(40) NOT NULL,
  document_number character varying(255) NOT NULL,
  document_type character varying(255) NOT NULL,
  issue_date date,
  attachments jsonb,
  arrival_date_visa date,
  days90_report_visa date,
  expiration_date date,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.master_banks (
  id bigint NOT NULL DEFAULT nextval('employee_center.master_banks_id_seq'::regclass),
  bank_code character varying(100) NOT NULL,
  bank_branch character varying(255),
  country_code character varying(40) NOT NULL,
  bank_name character varying(255) NOT NULL,
  business_identifier_code character varying(255) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  city jsonb,
  postal_code character varying(255),
  bank_key character varying(255),
  street jsonb,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.master_custom_pay_type_assignments (
  id bigint NOT NULL DEFAULT nextval('employee_center.master_custom_pay_type_assignments_id_seq'::regclass),
  custom_pay_type_code character varying(255) NOT NULL,
  country_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.master_custom_pay_types (
  id bigint NOT NULL DEFAULT nextval('employee_center.master_custom_pay_types_id_seq'::regclass),
  custom_pay_type_code character varying(255) NOT NULL,
  custom_pay_type_name jsonb,
  standard_pay_type character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.master_payment_method_assignments (
  id bigint NOT NULL DEFAULT nextval('employee_center.master_payment_method_assignments_id_seq'::regclass),
  payment_method_code character varying(40) NOT NULL,
  country_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.master_payment_methods (
  id bigint NOT NULL DEFAULT nextval('employee_center.master_payment_methods_id_seq'::regclass),
  payment_method_code character varying(40) NOT NULL,
  payment_method_name jsonb,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_achievement (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_achievement_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  attachment integer,
  achieve character varying(255),
  year character varying(255),
  sort_order integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_additional_achievements (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_achievements_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  achieve character varying(255),
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_advanced_information (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_advanced_information_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  group_of_people character varying(255),
  additional_information_name character varying(255),
  description text,
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  additional_information_url character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_assessment_program (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_assessment_program_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  attachment integer,
  program character varying(255),
  result character varying(255),
  year character varying(255),
  sort_order integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_additional_assessment_programs (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_assessment_programs_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  program character varying(255),
  result character varying(255),
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  mbti_strength character varying(255),
  mbti_weakness character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_awards (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_awards_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  sort_order integer,
  additional_information text,
  attachments jsonb,
  award_description text,
  institution character varying(255),
  issue_date date,
  award_name character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_benefits_elections (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_benefits_elections_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  sort_order integer,
  dental_plan character varying(255),
  is_dependent_disabled boolean,
  dependent_gender character varying(255),
  dependent_name character varying(255),
  dependent_national_id character varying(255),
  is_dependent_smoker boolean,
  is_dependent_student boolean,
  health_plan character varying(255),
  relation character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  date_of_birth date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_business_driver_assessments (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_business_driver_assessments_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  driving_profitable_growth character varying(255),
  customer_satisfaction character varying(255),
  organization_excellence character varying(255),
  sustainable_collaboration character varying(255),
  developing_people character varying(255),
  leading_innovation character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_certificates (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_certificates_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  effective_date date,
  expiration_date date,
  sort_order integer,
  attachments jsonb,
  license_country character varying(255),
  license_name character varying(255),
  license_number character varying(255),
  score character varying(255),
  type_of_certificate character varying(255),
  certificate_name character varying(255),
  certificate_description text,
  institution character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_coaching_feedback (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_coaching_feedback_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  identified_date date,
  attachments jsonb,
  comment text,
  external_name character varying(255),
  internal_name character varying(255),
  coach_type character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_coi_approvals (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_coi_approvals_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  approval_id character varying(255),
  approved_date date,
  attachments jsonb,
  business_nature character varying(255),
  business_type character varying(255),
  company_name character varying(255),
  compensation_rate character varying(255),
  position_name character varying(255),
  term character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_communities (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_communities_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  community_name character varying(255),
  role character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_company_assets (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_company_assets_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  received_date date NOT NULL,
  return_due_date date,
  asset_type character varying(255),
  comment text,
  is_returned boolean,
  serial_number character varying(255),
  is_received boolean,
  volume character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_company_loans (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_company_loans_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  additional_information text,
  amount numeric(18,2),
  type_of_loan character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_compensation (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_compensation_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  bonus_total numeric(18,2),
  compa_ratio numeric(7,4),
  salary_before_review numeric(18,2),
  salary_after_review numeric(18,2),
  job_title character varying(255),
  lump_sum numeric(18,2),
  merit character varying(255),
  options integer,
  performance_management_rating character varying(255),
  stock integer,
  stock_grant_date date,
  review_name character varying(255),
  review_end_date date,
  review_start_date date,
  total_compensation numeric(18,2),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_courses (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_courses_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  course_name character varying(255),
  start_date date,
  end_date date,
  institution_name character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_development_goals (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_development_goals_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  category character varying(255),
  competency character varying(255),
  development_goal_description text,
  development_goal_name character varying(255),
  development_goal_id character varying(255),
  expected_outcome character varying(255),
  development_goal_status character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_development_needs (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_development_needs_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  development_need_name character varying(255),
  development_need_description text,
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_disciplinary_actions (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_disciplinary_actions_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  violation_date date,
  appeal_date date,
  attachments jsonb,
  damage_amount numeric(18,2),
  violation_detail text,
  disciplinary_point character varying(255),
  punishment_date date,
  punishment_detail text,
  disciplinary_status character varying(255),
  supervisor character varying(255),
  violation_type character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_e_letter_passwords (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_e_letter_passwords_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  bonus numeric(18,2),
  ceiling numeric(18,2),
  e_letter_password character varying(255),
  new_salary numeric(18,2),
  note text,
  old_salary numeric(18,2),
  pa_grade character varying(255),
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_e_letters (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_e_letters_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  pa_group character varying(255),
  more_information text,
  attachments jsonb,
  performance_year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_employee_benefit_obligations (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_employee_benefit_obligations_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  ebo_amount numeric(18,2),
  comment text,
  ebo_description text,
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_flexible_spending_accounts (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_flexible_spending_accounts_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  available_balance numeric(18,2),
  total_contributions numeric(18,2),
  election_amount numeric(18,2),
  total_funds_out numeric(18,2),
  fsa_plan character varying(255),
  total_repayment numeric(18,2),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_functional_experiences (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_functional_experiences_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  comment text,
  functional_experience character varying(255),
  years_of_experience integer,
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_goodness (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_goodness_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  date_of_recognition date,
  comment text,
  detail text,
  point character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_guarantees (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_guarantees_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  contact_number character varying(255),
  guarantee_type character varying(255),
  guarantor character varying(255),
  warranty_amount numeric(18,2),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_individual_documents (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_individual_documents_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  document_name character varying(255),
  attachments jsonb,
  effective_date date,
  country_code character varying(40),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_languages (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_languages_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  language_certificate character varying(255),
  others character varying(255),
  language character varying(255),
  listening_proficiency character varying(255),
  reading_proficiency character varying(255),
  speaking_proficiency character varying(255),
  writing_proficiency character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_leadership_competencies (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_leadership_competencies_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  driving_for_profitable_growth character varying(255),
  striving_to_meet_customer_satisfaction character varying(255),
  building_organization_excellence character varying(255),
  promoting_sustainable_collaborations_and_partnerships character varying(255),
  developing_people character varying(255),
  leading_innovation character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_leadership_experiences (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_leadership_experiences_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  comment text,
  managed_amount_million numeric(18,2),
  area_of_leadership character varying(255),
  number_of_people_managed integer,
  years_of_experience integer,
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_learning_activities (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_learning_activities_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  planned_start_date date,
  planned_end_date date,
  category character varying(255),
  learning_activity_description text,
  development_objective_id character varying(255),
  learning_activity_id character varying(255),
  learning_completed_date date,
  learning_expected_result character varying(255),
  learning_activity_name character varying(255),
  learning_start_date date,
  learning_status character varying(255),
  status character varying(255),
  topic character varying(255),
  type character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_legal_execution_department (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_legal_execution_department_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  attachments jsonb,
  other_information text,
  execution_case_number character varying(255),
  legal_execution_department_name character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_mobility (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_mobility_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  business_unit_code character varying(40),
  comment text,
  function_experience character varying(255),
  province character varying(255),
  relocate_country_code character varying(40),
  willingness character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_mtma_references (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_mtma_references_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  program character varying(255),
  remark text,
  sponsor character varying(255),
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_ohs_certificates (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_ohs_certificates_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  ohs_certificate_description text,
  comment text,
  certificate_number character varying(255),
  completion_date date,
  course character varying(255),
  institute_id character varying(255),
  institute_name character varying(255),
  training_venue character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_ohs_documents (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_ohs_documents_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  direct_link_url text,
  direct_link_name character varying(255),
  document_number character varying(255),
  inactive_date date,
  labour_department_area character varying(255),
  registration_date date,
  safety_officer_level character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_overall_ratings (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_overall_ratings_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  rating_label character varying(255),
  rating_score character varying(255),
  rating_type character varying(255),
  remark text,
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_performance_assessments (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_performance_assessments_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  sort_order integer,
  destination_role character varying(255),
  has_development_goal boolean,
  has_expected_result boolean,
  function character varying(255),
  more_information text,
  year character varying(4),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_personal_assessment_summaries (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_personal_assessment_summaries_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  sort_order integer,
  improved_side01 character varying(255),
  improved_side02 character varying(255),
  improved_side03 character varying(255),
  positive_side01 character varying(255),
  positive_side02 character varying(255),
  positive_side03 character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_personality_assessment (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_personality_assessment_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  sort_order integer,
  improved_side01 character varying(255),
  improved_side02 character varying(255),
  improved_side03 character varying(255),
  positive_side01 character varying(255),
  positive_side02 character varying(255),
  positive_side03 character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_additional_potential_details (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_potential_details_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  comment text,
  comment_owner character varying(255),
  rating_description character varying(255),
  document_id character varying(255),
  originator character varying(255),
  rating character varying(255),
  section_id character varying(255),
  section_name character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_preferred_next_move (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_preferred_next_move_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  business_unit character varying(255),
  comments character varying(255),
  cust_status character varying(255),
  cust_type character varying(255),
  cust_year character varying(255),
  function character varying(255),
  level character varying(255),
  title character varying(255),
  effective_end_date date DEFAULT '9999-12-31'::date,
  sort_order integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_additional_preferred_next_moves (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_preferred_next_moves_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  business_unit_code character varying(40),
  comment text,
  goal_status character varying(255),
  career_goal_type character varying(255),
  year character varying(4),
  completed_date date,
  function_experience character varying(255),
  level character varying(255),
  destination_role character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_previous_work_history (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_previous_work_history_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  business_type character varying(255),
  comment text,
  function character varying(255),
  employer character varying(255),
  start_date date,
  end_date date,
  is_present_employer boolean,
  start_title character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_product_liability_insurance (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_product_liability_insurance_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  effective_date date,
  bank character varying(255),
  comment text,
  insurance_fee_collector character varying(255),
  insurance_company character varying(255),
  insured_amount numeric(18,2),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_professional_memberships (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_professional_memberships_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  organization character varying(255),
  role character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_promotability (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_promotability_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  function_experience character varying(255),
  level character varying(255),
  timeframe character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_rotation_plans (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_rotation_plans_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date,
  end_date date,
  business_unit_code character varying(40),
  function_experience character varying(255),
  "position" character varying(255),
  remark text,
  rotation_manager character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_salary_histories (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_salary_histories_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  effective_date date,
  changed_amount numeric(18,2),
  salary_history_reason character varying(255),
  salary_amount numeric(18,2),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_scholarships (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_scholarships_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  comment text,
  repayment_end_year character varying(4),
  graduation_year character varying(4),
  scholarship_award_year character varying(4),
  repayment_start_year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_scorecard_development_objectives (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_scorecard_development_objectives_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  development_objective character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_special_assignments (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_special_assignments_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  special_assignment_description text,
  comment text,
  project character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_student_loans (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_student_loans_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  comment text,
  contract_year character varying(4),
  education_level character varying(255),
  academic_year_level character varying(4),
  payment_stop_year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_talent_reference (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_talent_reference_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  cust_attachment integer,
  cust_program character varying(255),
  cust_remark character varying(255),
  cust_sponsor character varying(255),
  cust_year character varying(255),
  sort_order integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_additional_talent_references (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_talent_references_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  attachments jsonb,
  talent_program character varying(255),
  remark text,
  sponsor character varying(255),
  year character varying(4),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_top_strengths (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_top_strengths_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  year character varying(4),
  attachments jsonb,
  strength_name character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_variable_pay_employee_history_data (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_variable_pay_employee_history_data_id_seq'::regclass),
  target_amount numeric(18,2),
  country character varying(255),
  start_date date,
  end_date date,
  job_grade character varying(255),
  location character varying(255),
  salary numeric(18,2),
  target_percent numeric(7,4),
  title character varying(255),
  employee_id character varying(15) NOT NULL,
  variable_pay_program_name character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_work_experiences_within_company (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_work_experiences_within_company_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  store_branch_location_code character varying(40),
  business_unit_code character varying(40),
  company_code character varying(40),
  contract_type character varying(255),
  corporate_title_code character varying(40),
  employee_group_code character varying(40),
  event_code character varying(40),
  division_code character varying(40),
  job_code_code character varying(255),
  job_family_code character varying(40),
  job_grade_code character varying(40),
  job_role character varying(255),
  band_code character varying(40),
  pay_grade_code character varying(40),
  event_reason_code character varying(40),
  supervisor character varying(255),
  work_location_code character varying(40),
  department_code character varying(40),
  position_name character varying(255),
  position_code character varying(8),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_additional_work_experiences_within_company_history (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_additional_work_experiences_within_company_histor_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  start_date date NOT NULL,
  end_date date,
  branch character varying(255),
  company character varying(255),
  corporate_title character varying(255),
  job_grade character varying(255),
  job_name character varying(255),
  function character varying(255),
  pay_grade character varying(255),
  reason character varying(255),
  department character varying(255),
  position_name character varying(255),
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_address (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_address_id_seq'::regclass),
  address_type character varying(30) NOT NULL,
  person_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  floor character varying(255),
  room_number character varying(255),
  building character varying(255),
  village_number character varying(255),
  house_street_number character varying(255),
  village character varying(255),
  alley character varying(255),
  road character varying(255),
  district character varying(255),
  sub_district character varying(255),
  province character varying(255),
  postal_code character varying(255),
  country_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_addresses (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_addresses_id_seq'::regclass),
  address_type character varying(30) NOT NULL,
  person_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  street jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(255),
  country_code character varying(40),
  addressee_name character varying(255),
  note text,
  attachments jsonb,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_config_bank (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_bank_id_seq'::regclass),
  bank_code character varying(100) NOT NULL,
  bank_branch character varying(255),
  bank_country_id integer NOT NULL,
  bank_name character varying(255) NOT NULL,
  business_identifier_code character varying(255) NOT NULL,
  status character(1) NOT NULL,
  city character varying(255),
  postal_code character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_custom_pay_type (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_custom_pay_type_id_seq'::regclass),
  code character varying(255) NOT NULL,
  name_default_value character varying(255),
  name_en_gb character varying(255),
  name_localized character varying(255),
  name_th_th character varying(255),
  name_vi_vn character varying(255),
  standard_pay_type character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_custom_pay_type_assignment (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_custom_pay_type_assignment_id_seq'::regclass),
  custom_pay_type_id bigint NOT NULL,
  country_id integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_payment_information (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_payment_information_id_seq'::regclass),
  payment_information_code character varying(40) NOT NULL,
  employee_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  job_country character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_config_payment_information_detail (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_payment_information_detail_id_seq'::regclass),
  payment_information_id bigint NOT NULL,
  account_number character varying(255) NOT NULL,
  account_owner character varying(255) NOT NULL,
  bank_id bigint NOT NULL,
  currency character varying(255),
  iban character varying(255),
  custom_pay_type_id bigint NOT NULL,
  payment_method_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_payment_information_details (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_payment_information_details_id_seq'::regclass),
  payment_information_code character varying(40) NOT NULL,
  account_number character varying(255) NOT NULL,
  account_owner character varying(255) NOT NULL,
  bank_code character varying(100) NOT NULL,
  currency character varying(255),
  iban character varying(255),
  custom_pay_type_code character varying(255) NOT NULL,
  payment_method_code character varying(40) NOT NULL,
  amount numeric(18,2),
  pay_sequence integer,
  pay_type character varying(128),
  percent numeric(5,2),
  purpose character varying(40),
  receiver_country_code character varying(40),
  sort_code character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  attachments jsonb
);

CREATE TABLE employee_center.person_config_payment_method (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_payment_method_id_seq'::regclass),
  code character varying(40) NOT NULL,
  name_default_value character varying(255),
  name_en_gb character varying(255),
  name_localized character varying(255),
  name_th_th character varying(255),
  name_vi_vn character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_payment_method_assignment (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_payment_method_assignment_id_seq'::regclass),
  payment_method_id bigint NOT NULL,
  country_id integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_position (
  id bigint NOT NULL,
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  effective_status character varying(128),
  name_default_value character varying(255) NOT NULL,
  name_en_gb character varying(255),
  name_localized character varying(255),
  name_th_th character varying(255),
  name_vi_vn character varying(255),
  description character varying(255),
  parent_position_id bigint NOT NULL,
  group_id integer NOT NULL,
  country_id integer NOT NULL,
  business_group_id integer NOT NULL,
  company_id integer NOT NULL,
  business_unit_id integer NOT NULL,
  division_id integer NOT NULL,
  department_id integer NOT NULL,
  cost_center_id integer NOT NULL,
  location_id integer,
  work_location_id integer,
  sso_location_id integer,
  zone_id integer,
  pay_grade_id integer,
  job_type_id integer,
  job_family_id integer,
  job_code_id integer,
  job_level_id integer,
  job_title character varying(255),
  employee_group_id integer,
  employment_subgroup_id integer,
  brand_id integer,
  hr_district_id integer,
  policy_profile_id integer,
  working_hour_id integer NOT NULL,
  time_status_id integer NOT NULL,
  ot_flag character varying(255) NOT NULL,
  holiday_calendar_id integer NOT NULL,
  work_schedule_id integer NOT NULL,
  target_fte numeric,
  vacant boolean,
  regular_temporary character varying(128),
  pay_range character varying(32),
  typeof_management_program character varying(128),
  change_reason character varying(128),
  creation_source character varying(128),
  comment character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_config_position_matrix_relationship (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_config_position_matrix_relationship_id_seq'::regclass),
  position_id bigint NOT NULL,
  effective_start_date date NOT NULL,
  matrix_relationship_type character varying(128) NOT NULL,
  related_position_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_email (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_email_id_seq'::regclass),
  email_type character varying(38) NOT NULL,
  person_id character varying(15) NOT NULL,
  email_address character varying(100) NOT NULL,
  is_primary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_emails (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_emails_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  email_type character varying(100) NOT NULL,
  email_address character varying(100),
  is_primary boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_emergency_contacts (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_emergency_contacts_id_seq'::regclass),
  contact_name character varying(255) NOT NULL,
  person_id character varying(15) NOT NULL,
  relationship character varying(50) NOT NULL,
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  street jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(255),
  country_code character varying(40),
  address_note text,
  is_address_same_as_employee boolean,
  phone_number character varying(100),
  is_primary boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  attachments jsonb
);

CREATE TABLE employee_center.person_formal_education (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_formal_education_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  degree character varying(255),
  university character varying(255),
  other_university character varying(255),
  country_code character varying(40),
  faculty character varying(255),
  major character varying(255),
  other_major character varying(255),
  gpa character varying(15),
  graduated_date date,
  is_primary boolean,
  sort_order integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  attachments jsonb
);

CREATE TABLE employee_center.person_global_info (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_global_info_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  country_id integer NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  spouses_fatherid_number integer,
  spouses_motherid_number integer,
  numberof_children integer,
  dependent_tax_number character varying(255),
  typeof_disability character varying(255),
  disability_certificate_start_date date,
  disability_certificate_end_date date,
  disability_status character varying(255),
  certificateid character varying(255),
  tax_dependent character varying(255),
  deduction_start_date date,
  deduction_end_date date,
  date_learned date,
  generic_date1 date,
  degreeof_challenge integer,
  challenged character varying(255),
  typeof_challenge character varying(255),
  issuing_authority character varying(255),
  reference_number character varying(255),
  vn_race character varying(255),
  religion character varying(255),
  vn_religion character varying(255),
  deceased character varying(2),
  employer character varying(255),
  job_title character varying(255),
  additional_information character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_global_information (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_global_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  country_code character varying(40) NOT NULL,
  attachments jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  spouses_fatherid_number integer,
  spouses_motherid_number integer,
  numberof_children integer,
  typeof_disability character varying(255),
  disability_certificate_start_date date,
  disability_certificate_end_date date,
  disability_status character varying(255),
  certificateid character varying(255),
  tax_dependent character varying(255),
  deduction_start_date date,
  deduction_end_date date,
  date_learned date,
  degreeof_challenge integer,
  challenged character varying(255),
  typeof_challenge character varying(255),
  issuing_authority character varying(255),
  reference_number character varying(255),
  vn_race character varying(255),
  religion character varying(255),
  vn_religion character varying(255),
  deceased character varying(2),
  employer character varying(255),
  job_title character varying(255),
  additional_information text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_information (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_of_birth character varying(100),
  date_of_birth date,
  region_of_birth character varying(100),
  salutation jsonb,
  first_name jsonb,
  middle_name jsonb,
  last_name jsonb,
  other_title character varying(128),
  nickname character varying(128),
  is_foreigner boolean,
  nationality character varying(128),
  gender character varying(50),
  blood_type character varying(255),
  marital_status character varying(50),
  marital_status_since date,
  military_status character varying(255),
  attachments jsonb,
  preferred_language character varying(128),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_national_id (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_national_id_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  card_type_id integer NOT NULL,
  national_id character varying(255) NOT NULL,
  issue_date date,
  expiry_date date,
  vn_issue_place character varying(255),
  country character varying(100),
  is_primary boolean,
  attachment_id character varying(255),
  notes character varying(4000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_national_ids (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_national_ids_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  card_type character varying(255) NOT NULL,
  national_id character varying(255) NOT NULL,
  issue_date date,
  expiry_date date,
  vn_issue_place character varying(255),
  country character varying(100),
  is_primary boolean,
  attachments jsonb,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_performance (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_performance_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  sort_order integer,
  rating_label character varying(100),
  rating_score character varying(15),
  rating_year character varying(4),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_phone (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_phone_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  phone_type character varying(100) NOT NULL,
  phone_number character varying(100) NOT NULL,
  extension character varying(32),
  country_code character varying(32),
  is_primary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_phones (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_phones_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  phone_type character varying(100) NOT NULL,
  phone_number character varying(100) NOT NULL,
  extension character varying(32),
  dial_country_code character varying(32),
  is_primary boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.person_relationship (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_relationship_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  related_person_id character varying(15) NOT NULL,
  relationship_type character varying(128) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  first_name character varying(128),
  last_name character varying(128),
  is_address_same_as_person boolean,
  is_beneficiary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_relationships (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_relationships_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  related_person_id character varying(15),
  relationship_type character varying(128) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  salutation jsonb,
  first_name jsonb,
  middle_name jsonb,
  last_name jsonb,
  is_address_same_as_employee boolean,
  is_beneficiary boolean,
  nationality character varying(255),
  date_of_birth date,
  country_of_birth character varying(100),
  card_type character varying(255),
  national_id character varying(255),
  attachments jsonb,
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  street jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(255),
  country_code character varying(40),
  address_note text,
  phone_number character varying(100),
  is_primary boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  id_country_code character varying(40)
);

CREATE TABLE employee_center.person_social_account (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_social_account_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  domain character varying(100) NOT NULL,
  instant_messaging_id character varying(100),
  url character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_center.person_social_accounts (
  id bigint NOT NULL DEFAULT nextval('employee_center.person_social_accounts_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  domain character varying(100) NOT NULL,
  instant_messaging_id character varying(100),
  url character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.probation_transactions (
  id bigint NOT NULL DEFAULT nextval('employee_center.probation_transactions_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  probation_status character varying(255),
  probation_result character varying(255),
  pass_probation_date timestamp with time zone,
  extend_date timestamp with time zone,
  effective_date timestamp with time zone,
  initiated jsonb,
  manager_approval character varying(255),
  reason_for_failed_probation text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.termination_request_approvals (
  id bigint NOT NULL DEFAULT nextval('employee_center.termination_request_approvals_id_seq'::regclass),
  request_no character varying(50) NOT NULL,
  person_id character varying(15) NOT NULL,
  employee_id character varying(15) NOT NULL,
  request_type character varying(50) NOT NULL,
  request_sub_type character varying(50) NOT NULL,
  initiated jsonb,
  current_approval_step character varying(20),
  status character varying(30) NOT NULL,
  resigned_date date,
  termination_date date,
  reason_for_termination character varying(255),
  ok_to_rehire boolean,
  terminate_voluntary_involuntary character varying(255),
  event_reason_code character varying(40),
  additional_information_termination character varying(255),
  transfer_out_to character varying(255),
  personal_email_resign character varying(255),
  attachments jsonb,
  requested_by character varying(255) NOT NULL,
  requested_at timestamp with time zone,
  last_approval_by character varying(255),
  last_approval_at timestamp with time zone,
  reason text,
  camunda_process_instance_id character varying(100),
  camunda_task_id character varying(100),
  camunda_task_completed_at timestamp with time zone,
  camunda_task_status character varying(30),
  camunda_variables jsonb,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.transaction_new_hire (
  id character varying(36) NOT NULL,
  national_id character varying(20) NOT NULL,
  raw_json jsonb NOT NULL,
  status character varying(30) NOT NULL DEFAULT 'DRAFT'::character varying,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer,
  owner_emp_id character varying(36),
  customer_id character varying(100)
);

CREATE TABLE employee_center.transaction_new_hires (
  transaction_id character varying(40) NOT NULL,
  owner_emp_id character varying(20) NOT NULL,
  status character varying(20) NOT NULL,
  customer_id character varying(20),
  source_data jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_center.transaction_request_approvals (
  id bigint NOT NULL DEFAULT nextval('employee_center.transaction_request_approvals_id_seq'::regclass),
  request_no character varying(50) NOT NULL,
  person_id character varying(15) NOT NULL,
  employee_id character varying(15) NOT NULL,
  request_type character varying(50),
  request_sub_type character varying(50),
  status character varying(30),
  current_data jsonb,
  requested_data jsonb,
  attachments jsonb,
  approval_total_levels integer,
  requester jsonb NOT NULL,
  approvals jsonb NOT NULL,
  assignee jsonb,
  effective_date date,
  camunda_process_instance_id character varying(100),
  camunda_task_id character varying(100),
  camunda_task_completed_at timestamp with time zone,
  camunda_task_status character varying(30),
  camunda_variables jsonb,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation."SequelizeMeta_employee_foundation" (
  name character varying(255) NOT NULL
);

CREATE TABLE employee_foundation.bands (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.bands_id_seq'::regclass),
  band_code character varying(40) NOT NULL,
  band_name jsonb NOT NULL,
  band_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  track_code character varying(40),
  track_name jsonb,
  max_job_grade_code character varying(40),
  min_job_grade_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.brands (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.brands_id_seq'::regclass),
  brand_code character varying(40) NOT NULL,
  brand_name jsonb NOT NULL,
  brand_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  hr_district_code character varying(40),
  brand_barcode character varying(2),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_groups_id_seq'::regclass),
  business_group_name jsonb NOT NULL,
  business_group_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  member_country_code character varying(40) NOT NULL,
  business_group_code character varying(40) NOT NULL,
  policy_profile_code character varying(100),
  head_of_unit character varying(15),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_companies (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_companies_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_divisions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_divisions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_groups_of_standard_function (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_groups_of_standard_function_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  group_of_standard_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_section_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_section_groups_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  section_group_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_standard_functions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_standard_functions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  standard_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_store_formats (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_store_formats_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  store_format_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_sub_functions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_sub_functions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  sub_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_unit_sub_organizations (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_unit_sub_organizations_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  sub_organization_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.business_units (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.business_units_id_seq'::regclass),
  business_unit_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  business_unit_code character varying(40) NOT NULL,
  business_group_code character varying(40),
  policy_profile_code character varying(100),
  business_unit_name jsonb NOT NULL,
  head_of_unit character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.companies (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.companies_id_seq'::regclass),
  company_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  business_group_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  company_name jsonb NOT NULL,
  currency_code character varying(255),
  company_phone_no character varying(255),
  company_tax_id character varying(40),
  country_code character varying(40),
  standard_hours double precision,
  is_active boolean NOT NULL DEFAULT true,
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  road jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(40),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.corporate_title (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.corporate_title_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  policy_profile_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.cost_centers (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.cost_centers_id_seq'::regclass),
  cost_center_code character varying(40) NOT NULL,
  cost_center_name jsonb NOT NULL,
  cost_center_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  company_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.country_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.country_groups_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  group_code character varying(40) NOT NULL,
  group_name jsonb NOT NULL,
  group_description jsonb,
  member_country_code character varying(40) NOT NULL,
  member_country_name jsonb NOT NULL,
  member_country_description jsonb,
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.currencies (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.currencies_id_seq'::regclass),
  currency_code character varying(255) NOT NULL,
  currency_name jsonb NOT NULL,
  currency_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  default_decimals integer,
  symbol character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.departments (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.departments_id_seq'::regclass),
  department_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  department_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  department_name jsonb NOT NULL,
  cost_center_code character varying(40),
  section_group character varying(255),
  sso_location_code character varying(40),
  work_location_code character varying(40),
  store_branch_location_code character varying(40),
  head_of_unit character varying(255),
  section_group_code character varying(40),
  group_of_standard_function_code character varying(40),
  standard_function_code character varying(40),
  sub_function_code character varying(40),
  sub_organization_code character varying(40),
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.divisions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.divisions_id_seq'::regclass),
  division_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  division_code character varying(40) NOT NULL,
  division_name jsonb NOT NULL,
  business_group_code character varying(255),
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.employee_group_employee_subgroups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.employee_group_employee_subgroups_id_seq'::regclass),
  employee_group_code character varying(40) NOT NULL,
  employee_subgroup_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.employee_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.employee_groups_id_seq'::regclass),
  employee_group_code character varying(40) NOT NULL,
  employee_group_name jsonb NOT NULL,
  employee_group_description jsonb,
  country_code character varying(40),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.employee_subgroups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.employee_subgroups_id_seq'::regclass),
  employee_subgroup_code character varying(40) NOT NULL,
  employee_subgroup_name jsonb NOT NULL,
  employee_subgroup_description jsonb,
  country_code character varying(40),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  pay_grade_code character varying(40) NOT NULL,
  subgroup_numeric integer,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.event_reasons (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.event_reasons_id_seq'::regclass),
  event_reason_code character varying(40) NOT NULL,
  event_reason_name jsonb NOT NULL,
  event_reason_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_code character varying(40) NOT NULL,
  version character varying(255),
  employee_status character varying(45),
  payroll_event character varying(4),
  include_in_work_experience boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.events (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.events_id_seq'::regclass),
  event_code character varying(40) NOT NULL,
  event_name jsonb NOT NULL,
  event_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.frequencies (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.frequencies_id_seq'::regclass),
  frequency_code character varying(100) NOT NULL,
  frequency_name jsonb NOT NULL,
  frequency_description jsonb,
  annualization_factor double precision,
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation."group" (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.group_id_seq'::regclass),
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  status character(1) NOT NULL DEFAULT 'A'::bpchar,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.groups_of_standard_functions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.groups_of_standard_functions_id_seq'::regclass),
  groups_of_standard_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  group_of_standard_function_code character varying(40) NOT NULL,
  group_of_standard_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.hr_districts (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.hr_districts_id_seq'::regclass),
  hr_district_code character varying(40) NOT NULL,
  hr_district_name jsonb NOT NULL,
  hr_district_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  hrbp_pg11 character varying(20),
  hrbp_pg14 character varying(20),
  hrbp_pg17 character varying(20),
  hrbp_pg19 character varying(20),
  hrbp_pg7 character varying(20),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.job_catalogs (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.job_catalogs_id_seq'::regclass),
  job_catalog_code character varying(40) NOT NULL,
  job_catalog_name jsonb NOT NULL,
  job_catalog_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  job_catalog character varying(255),
  functional_capability character varying(255),
  job_family_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.job_codes (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.job_codes_id_seq'::regclass),
  job_code_code character varying(255) NOT NULL,
  job_code_name jsonb NOT NULL,
  job_code_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  max_job_grade_code character varying(40),
  min_job_grade_code character varying(40),
  band_code character varying(40),
  job_type character varying(255),
  job_family_code character varying(40),
  job_catalog_code character varying(40),
  salary_structure text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.job_families (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.job_families_id_seq'::regclass),
  job_family_code character varying(40) NOT NULL,
  job_family_name jsonb NOT NULL,
  job_family_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.job_type (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.job_type_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  policy_profile_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.master_countries (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.master_countries_id_seq'::regclass),
  country_name jsonb NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_code character varying(40) NOT NULL,
  numeric_country_code character varying(3),
  territory_code character varying(40),
  currency_code character varying(255),
  two_char_country_code character varying(2),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.national_id_card_type (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.national_id_card_type_id_seq'::regclass),
  card_type_code character varying(10) NOT NULL,
  card_type_name character varying(255) NOT NULL,
  display_format character varying(255),
  regular_exp character varying(255),
  description character varying(2000),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_component_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_component_groups_id_seq'::regclass),
  pay_component_group_code character varying(32) NOT NULL,
  pay_component_group_name jsonb,
  pay_component_group_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  currency_code character varying(255),
  version character varying(255),
  max_fraction_digits integer,
  show_on_comp_ui boolean,
  use_for_comparatio_calc boolean,
  use_for_range_penetration boolean,
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_components (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_components_id_seq'::regclass),
  pay_component_code character varying(255) NOT NULL,
  pay_component_name jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_code character varying(255) NOT NULL,
  currency_code character varying(255),
  frequency_code character varying(100),
  can_override boolean,
  pay_component_type character varying(32),
  pay_component_value numeric(18,2),
  is_earning boolean,
  is_recurring boolean,
  is_active boolean DEFAULT true,
  tax_treatment character varying(32),
  version character varying(255),
  is_display_on_ui boolean,
  is_end_dated_payment boolean,
  max_decimal_place integer,
  component_number integer,
  rate numeric(18,2),
  target boolean,
  unit_of_measure character varying(3),
  pay_component_group_code character varying(255),
  used_for_comp_planning character varying(32),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_grades (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_grades_id_seq'::regclass),
  pay_grade_code character varying(40) NOT NULL,
  pay_grade_name jsonb NOT NULL,
  pay_grade_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  version character varying(255),
  pay_grade_numeric integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_groups_id_seq'::regclass),
  pay_group_code character varying(40) NOT NULL,
  pay_group_name jsonb NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  frequency_code character varying(100),
  earliest_change_date date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_scale_areas (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_scale_areas_id_seq'::regclass),
  pay_scale_area_code character varying(40) NOT NULL,
  pay_scale_area_name jsonb NOT NULL,
  country_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_scale_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_scale_groups_id_seq'::regclass),
  pay_scale_group_code character varying(40) NOT NULL,
  pay_scale_group_name jsonb NOT NULL,
  country_code character varying(40) NOT NULL,
  pay_scale_area_code character varying(40),
  pay_scale_type_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_scale_levels (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_scale_levels_id_seq'::regclass),
  pay_scale_level_code character varying(40) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  pay_scale_level_name jsonb NOT NULL,
  next_pay_scale_level_code character varying(40),
  pay_scale_group_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.pay_scale_types (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.pay_scale_types_id_seq'::regclass),
  pay_scale_type_code character varying(40) NOT NULL,
  pay_scale_type_name jsonb NOT NULL,
  country_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.picking_lists (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.picking_lists_id_seq'::regclass),
  non_unique_code character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  picklist_id character varying(255) NOT NULL,
  picklist_code character varying(100) NOT NULL,
  parent_picklist_code character varying(100),
  label jsonb NOT NULL,
  sort_order integer,
  picklist_status character(1) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.position_matrix_relationships (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.position_matrix_relationships_id_seq'::regclass),
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  matrix_relationship_type character varying(128) NOT NULL,
  related_position_code character varying(8) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.positions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.positions_id_seq'::regclass),
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  position_name jsonb NOT NULL,
  position_description jsonb,
  parent_position_code character varying(8),
  group_code character varying(40) NOT NULL,
  member_country_code character varying(40) NOT NULL,
  business_group_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  business_unit_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  department_code character varying(40) NOT NULL,
  cost_center_code character varying(40) NOT NULL,
  store_branch_location_code character varying(40),
  work_location_code character varying(40),
  sso_location_code character varying(40),
  zone_code character varying(40),
  pay_grade_code character varying(40),
  job_type character varying(255),
  job_family_code character varying(40),
  job_code_code character varying(255),
  job_level character varying(128),
  job_title character varying(255),
  employee_group_code character varying(40),
  employee_subgroup_code character varying(40),
  brand_code character varying(40),
  hr_district_code character varying(40),
  section_group_code character varying(40),
  group_of_standard_function_code character varying(40),
  standard_function_code character varying(40),
  sub_function_code character varying(40),
  sub_organization_code character varying(40),
  policy_profile_code character varying(100),
  change_reason character varying(128),
  comment character varying(255),
  creation_source character varying(128),
  criticality integer,
  holiday_calendar_code character varying(40),
  management_program character varying(128),
  work_schedule_code character varying(40),
  work_schedule_template_code character varying(40),
  incumbent_employee_code character varying(100),
  multiple_incumbents_allowed boolean,
  pay_range character varying(32),
  position_controlled boolean,
  position_criticality character varying(128),
  regular_temporary character varying(128),
  target_fte numeric(6,3),
  type character varying(128),
  vacant boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.section_groups (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.section_groups_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  section_group_code character varying(40) NOT NULL,
  section_group_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  policy_profile_code character varying(100),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.sso_locations (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.sso_locations_id_seq'::regclass),
  sso_location_code character varying(40) NOT NULL,
  sso_location_name jsonb NOT NULL,
  sso_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  company_code character varying(40) NOT NULL,
  internal_code character varying(40),
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.standard_functions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.standard_functions_id_seq'::regclass),
  standard_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  standard_function_code character varying(40) NOT NULL,
  standard_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.store_branch_locations (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.store_branch_locations_id_seq'::regclass),
  store_branch_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  store_branch_location_code character varying(40) NOT NULL,
  store_branch_location_name jsonb NOT NULL,
  address_line1 jsonb,
  apartment jsonb,
  bed_number jsonb,
  address_line2 jsonb,
  address_line3 jsonb,
  apartment2 jsonb,
  second_address_line jsonb,
  town jsonb,
  district jsonb,
  building_number jsonb,
  building jsonb,
  city jsonb,
  country_code character varying(40),
  county jsonb,
  province jsonb,
  state jsonb,
  postal_code character varying(40),
  store_format_code character varying(40),
  store_size character varying(255),
  zone_code character varying(40),
  hr_district_code character varying(40),
  store_type character varying(255),
  region character varying(255),
  ofin character varying(255),
  version character varying(255),
  sso_location_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.store_formats (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.store_formats_id_seq'::regclass),
  store_format_code character varying(40) NOT NULL,
  store_format_name jsonb NOT NULL,
  store_format_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.sub_functions (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.sub_functions_id_seq'::regclass),
  sub_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  sub_function_code character varying(40) NOT NULL,
  sub_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.sub_organizations (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.sub_organizations_id_seq'::regclass),
  sub_organization_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  sub_organization_code character varying(40) NOT NULL,
  sub_organization_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.work_location_geofences (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.work_location_geofences_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  work_location_code character varying(40) NOT NULL,
  geofence_type character varying(20),
  center_latitude numeric(10,6),
  center_longitude numeric(10,6),
  allow_radius_meter integer,
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.work_locations (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.work_locations_id_seq'::regclass),
  work_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  work_location_code character varying(40) NOT NULL,
  work_location_name jsonb NOT NULL,
  country_code character varying(40),
  property character varying(255),
  latitude numeric(11,8),
  longitude numeric(11,8),
  timezone character varying(255),
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  road jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(40),
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_foundation.zones (
  id bigint NOT NULL DEFAULT nextval('employee_foundation.zones_id_seq'::regclass),
  zone_code character varying(40) NOT NULL,
  zone_name jsonb NOT NULL,
  zone_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE employee_management.change_log (
  id bigint NOT NULL DEFAULT nextval('employee_management.change_log_id_seq'::regclass),
  event_uid character varying(36) NOT NULL,
  entity_type character varying(64) NOT NULL,
  entity_id character varying(64) NOT NULL,
  action character varying(16) NOT NULL,
  source_module character varying(64) NOT NULL,
  page character varying(255),
  section character varying(255),
  applied_by character varying(64) NOT NULL,
  applied_at timestamp with time zone NOT NULL,
  field_changes jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE employee_management.consent (
  id bigint NOT NULL DEFAULT nextval('employee_management.consent_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  consent_type character varying(100) NOT NULL,
  consent_status character varying(32) NOT NULL,
  version character varying(20),
  consent_date date,
  channel character varying(50),
  document_ref character varying(255),
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE employee_management.ec_documents (
  id bigint NOT NULL DEFAULT nextval('employee_management.ec_documents_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  document_type character varying(100) NOT NULL,
  document_name character varying(255) NOT NULL,
  storage_ref character varying(500) NOT NULL,
  mime_type character varying(100),
  file_size bigint,
  status character varying(32),
  issued_date date,
  expiry_date date,
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_compensation (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_compensation_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  seq_number integer NOT NULL,
  pay_group_id integer NOT NULL,
  event_id integer NOT NULL,
  event_reason_id integer NOT NULL,
  pay_component_id integer NOT NULL,
  history_potential_bonus_rate character varying(100),
  effective_latest_change boolean,
  frequency character varying(255),
  currency character varying(255),
  total_amount double precision NOT NULL,
  payroll_id character varying(15),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_compensation_detail (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_compensation_detail_id_seq'::regclass),
  employment_compensation_id bigint NOT NULL,
  seq_number integer NOT NULL,
  reason_for_salary_adjust_id integer NOT NULL,
  amount double precision,
  notes character varying(2000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_cost_distribution (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_cost_distribution_id_seq'::regclass),
  user_id character varying(255) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_cost_distribution_item (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_cost_distribution_item_id_seq'::regclass),
  emp_cost_distribution_id bigint NOT NULL,
  cost_center_id integer NOT NULL,
  percentage numeric,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_information (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  user_id character varying(15) NOT NULL,
  is_primary boolean NOT NULL,
  effective_start_date date,
  original_start_date date,
  seniority_date date,
  pass_probation_date_confirm_date date,
  retirement_date date,
  effective_end_date date DEFAULT '9999-12-31'::date,
  last_date_worked date,
  pf_service_date date,
  cg_previous_employee_id character varying(255),
  year_of_service character varying(255),
  employee_age_ymd character varying(255),
  dvt_previous_id character varying(255),
  current_business_unit_effective_date date,
  current_job_effective_date date,
  current_position_effective_date date,
  current_jg_effective_date date,
  current_pg_effective_date date,
  current_corporate_title_effective_date date,
  current_store_branch_effective_date date,
  current_years_in_business_unit character varying(255),
  current_years_in_store_branch character varying(255),
  current_years_in_job character varying(255),
  current_years_in_position character varying(255),
  current_years_in_jg character varying(255),
  current_years_in_pg character varying(255),
  current_years_in_corporate_title character varying(255),
  hiring_not_completed boolean,
  additional_information_termination character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_job (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_job_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  seq_number integer NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_id integer NOT NULL,
  event_reason_id integer NOT NULL,
  is_primary boolean NOT NULL,
  is_concurrent_employment boolean,
  employee_status character varying(32),
  group_id integer NOT NULL,
  country_id integer NOT NULL,
  business_group_id integer NOT NULL,
  business_unit_id integer NOT NULL,
  company_id integer NOT NULL,
  division_id integer NOT NULL,
  department_id integer NOT NULL,
  position_id bigint NOT NULL,
  cost_center_id integer NOT NULL,
  location_id integer,
  work_location_id integer,
  sso_location_id integer,
  zone_id integer,
  pay_grade_id integer,
  job_grade_id integer,
  corporate_title_id integer,
  job_type_id integer,
  job_family_id integer,
  job_code_id integer,
  job_title_id character varying(255),
  employee_group_id integer,
  employee_subgroup_id integer,
  store_size_id integer,
  store_format_id integer,
  band_id integer,
  brand_id integer,
  pay_scale_area_id integer,
  pay_scale_group_id integer,
  pay_scale_level_id integer,
  pay_scale_type_id integer,
  hr_district_id integer,
  manager_id character varying(255),
  contract_type character varying(255),
  is_fulltime_employee boolean,
  fte double precision,
  contract_end_date date,
  policy_profile character varying(20),
  typeof_group_family_employee character varying(255),
  pass_probation character varying(255),
  extened_probation_date date,
  probation_period_end_date date,
  extened_retirement_date date,
  override_current_business_unit_effective_date date,
  override_current_position_effective_date date,
  override_current_job_effective_date date,
  override_current_corporate_title_effective_date date,
  override_current_jg_effective_date date,
  override_current_pg_effective_date date,
  override_current_store_branch_effective_date date,
  working_hour_id integer,
  time_status_id integer,
  ot_flag character varying(100),
  holiday_calendar_id integer,
  work_schedule_id integer,
  leave_quota double precision,
  override_standard_weekly_hours character varying(255),
  typeof_management_program character varying(255),
  dvt_bonding_enddate date,
  dvt_graduation_date date,
  dvt_project character varying(255),
  dvt_partner_university character varying(255),
  dvt_type character varying(80),
  dvt_degree character varying(80),
  dvt_course_of_time character varying(80),
  dvt_academic_year character varying(80),
  dvt_course character varying(255),
  is_scholarship character varying(255),
  terminate_voluntary_involuntary character varying(255),
  reason_for_termination character varying(255),
  additional_information_termination character varying(255),
  ok_to_rehire boolean,
  vn_title character varying(255),
  legacy_job_grade character varying(255),
  sales_admin_mall character varying(255),
  social_insurance character varying(255),
  health_insurance character varying(255),
  unemployment_insurance character varying(255),
  occupational_accident_insurance character varying(255),
  social_insurance_outsidethe_company character varying(255),
  insurance_area character varying(255),
  special_benefit_group character varying(255),
  union_fee character varying(255),
  transfer_from character varying(255),
  transfer_out_to character varying(255),
  band_matching character varying(2),
  point_of_sales character varying(255),
  effective_latest_change boolean,
  attachment character varying(4000),
  attachment_file_name character varying(255),
  attachment_file_size numeric,
  attachment_file_type character varying(5),
  attachment_id character varying(255),
  attachment_mime_type character varying(255),
  attachment_status numeric,
  timezone character varying(128),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_job_relationships (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_job_relationships_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  related_user_id character varying(15) NOT NULL,
  relationship_type character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_termination (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_termination_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  user_id character varying(15) NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  reason_for_termination character varying(255),
  ok_to_rehire boolean,
  terminate_voluntary_involuntary character varying(255),
  event_reason_id integer,
  additional_information_termination character varying(255),
  transfer_out_to character varying(255),
  personal_email_resign character varying(255),
  last_date_worked date,
  attachment_id character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.employment_work_permit (
  id bigint NOT NULL DEFAULT nextval('employee_management.employment_work_permit_id_seq'::regclass),
  user_id character varying(15) NOT NULL,
  country_id integer NOT NULL,
  document_number character varying(255) NOT NULL,
  document_type character varying(255) NOT NULL,
  issue_date date,
  attachment character varying(4000),
  attachment_file_name character varying(255),
  attachment_file_size numeric,
  attachment_file_type character varying(5),
  attachment_id character varying(255),
  attachment_mime_type character varying(255),
  attachment_status numeric,
  arrival_date_visa date,
  days90_report_visa date,
  expiration_date date,
  notes character varying(4000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_address (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_address_id_seq'::regclass),
  address_type character varying(30) NOT NULL,
  person_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  floor character varying(255),
  room_number character varying(255),
  building character varying(255),
  village_number character varying(255),
  house_street_number character varying(255),
  village character varying(255),
  alley character varying(255),
  road character varying(255),
  district character varying(255),
  sub_district character varying(255),
  province character varying(255),
  postal_code character varying(255),
  country_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_config_bank (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_config_bank_id_seq'::regclass),
  bank_code character varying(100) NOT NULL,
  bank_branch character varying(255),
  bank_country_id integer NOT NULL,
  bank_name character varying(255) NOT NULL,
  business_identifier_code character varying(255) NOT NULL,
  status character(1) NOT NULL,
  city character varying(255),
  postal_code character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_config_position (
  id bigint NOT NULL,
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  effective_status character varying(128),
  name_default_value character varying(255) NOT NULL,
  name_en_gb character varying(255),
  name_localized character varying(255),
  name_th_th character varying(255),
  name_vi_vn character varying(255),
  description character varying(255),
  parent_position_id bigint NOT NULL,
  group_id integer NOT NULL,
  country_id integer NOT NULL,
  business_group_id integer NOT NULL,
  company_id integer NOT NULL,
  business_unit_id integer NOT NULL,
  division_id integer NOT NULL,
  department_id integer NOT NULL,
  cost_center_id integer NOT NULL,
  location_id integer,
  work_location_id integer,
  sso_location_id integer,
  zone_id integer,
  pay_grade_id integer,
  job_type_id integer,
  job_family_id integer,
  job_code_id integer,
  job_level_id integer,
  job_title character varying(255),
  employee_group_id integer,
  employment_subgroup_id integer,
  brand_id integer,
  hr_district_id integer,
  policy_profile_id integer,
  working_hour_id integer NOT NULL,
  time_status_id integer NOT NULL,
  ot_flag character varying(255) NOT NULL,
  holiday_calendar_id integer NOT NULL,
  work_schedule_id integer NOT NULL,
  target_fte numeric,
  vacant boolean,
  regular_temporary character varying(128),
  pay_range character varying(32),
  typeof_management_program character varying(128),
  change_reason character varying(128),
  creation_source character varying(128),
  comment character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_email (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_email_id_seq'::regclass),
  email_type character varying(38) NOT NULL,
  person_id character varying(15) NOT NULL,
  email_address character varying(100) NOT NULL,
  is_primary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_emergency_contacts (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_emergency_contacts_id_seq'::regclass),
  contact_name character varying(255) NOT NULL,
  person_id character varying(15) NOT NULL,
  relationship character varying(50) NOT NULL,
  effective_start_date character varying(255) NOT NULL,
  effective_end_date character varying(255),
  house_street_number character varying(255),
  village character varying(255),
  alley character varying(255),
  street character varying(255),
  district character varying(255),
  sub_district character varying(255),
  province character varying(255),
  postal_code character varying(255),
  address_notes character varying(4000),
  address_province character varying(255),
  is_add_same_as_employee boolean,
  phone character varying(255),
  is_primary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer,
  floor character varying(255),
  room_number character varying(255),
  building character varying(255),
  village_number character varying(255)
);

CREATE TABLE employee_management.person_formal_education (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_formal_education_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  degree character varying(255),
  university character varying(255),
  university_other character varying(15),
  country_id integer,
  faculty character varying(15),
  major character varying(255),
  major_other character varying(15),
  gpa character varying(15),
  graduated_date character varying(15),
  is_primary boolean,
  sort_order character varying(15),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_global_info (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_global_info_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  country_id integer NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  spouses_fatherid_number integer,
  spouses_motherid_number integer,
  numberof_children integer,
  dependent_tax_number character varying(255),
  typeof_disability character varying(255),
  disability_certificate_start_date date,
  disability_certificate_end_date date,
  disability_status character varying(255),
  certificateid character varying(255),
  tax_dependent character varying(255),
  deduction_start_date date,
  deduction_end_date date,
  date_learned date,
  generic_date1 date,
  degreeof_challenge integer,
  challenged character varying(255),
  typeof_challenge character varying(255),
  issuing_authority character varying(255),
  reference_number character varying(255),
  vn_race character varying(255),
  religion character varying(255),
  vn_religion character varying(255),
  deceased character varying(2),
  employer character varying(255),
  job_title character varying(255),
  additional_information character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_information (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_of_birth character varying(100),
  age character varying(255),
  date_of_birth date,
  region_of_birth character varying(100),
  salutation_local character varying(255),
  firstname_local character varying(40),
  lastname_local character varying(40),
  middle_name_local character varying(40),
  salutation character varying(128),
  first_name character varying(40),
  middle_name character varying(40),
  last_name character varying(40),
  name_prefix character varying(128),
  preferred_name character varying(128),
  foreigner character varying(255),
  nationality character varying(128),
  gender character varying(2),
  blood_type character varying(255),
  marital_status character varying(50),
  marital_status_since date,
  military_status character varying(255),
  military_status_since date,
  attachment_id character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_national_id (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_national_id_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  card_type_id integer NOT NULL,
  national_id character varying(255) NOT NULL,
  issue_date date,
  expiry_date date,
  vn_issue_place character varying(255),
  country character varying(100),
  is_primary boolean,
  attachment_id character varying(255),
  notes character varying(4000),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_phone (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_phone_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  phone_type character varying(100) NOT NULL,
  phone_number character varying(100) NOT NULL,
  extension character varying(32),
  country_code character varying(32),
  is_primary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE employee_management.person_relationship (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_relationship_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  related_person_id character varying(15),
  relationship_type character varying(128) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  first_name character varying(128),
  last_name character varying(128),
  is_address_same_as_person boolean,
  is_beneficiary boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer,
  salutation character varying(128),
  salutation_local character varying(128),
  firstname_local character varying(128),
  lastname_local character varying(128),
  middle_name_local character varying(128),
  nationality character varying(255),
  date_of_birth date,
  country_of_birth character varying(100),
  card_type_id integer,
  national_id character varying(255),
  attachment_id character varying(255),
  floor character varying(255),
  room_number character varying(255),
  building character varying(255),
  village_number character varying(255),
  house_street_number character varying(255),
  village character varying(255),
  alley character varying(255),
  street character varying(255),
  district character varying(255),
  sub_district character varying(255),
  province character varying(255),
  postal_code character varying(255),
  address_notes character varying(4000),
  address_province character varying(255)
);

CREATE TABLE employee_management.person_social_account (
  id bigint NOT NULL DEFAULT nextval('employee_management.person_social_account_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  domain character varying(100) NOT NULL,
  instant_messaging_id character varying(100),
  url character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by integer NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by integer
);

CREATE TABLE foundation."SequelizeMeta_foundation" (
  name character varying(255) NOT NULL
);

CREATE TABLE foundation.bands (
  id bigint NOT NULL DEFAULT nextval('foundation.bands_id_seq'::regclass),
  band_code character varying(40) NOT NULL,
  band_name jsonb NOT NULL,
  band_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  track_code character varying(40),
  track_name character varying(255),
  max_job_grade_code character varying(40),
  min_job_grade_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.brands (
  id bigint NOT NULL DEFAULT nextval('foundation.brands_id_seq'::regclass),
  brand_code character varying(40) NOT NULL,
  brand_name jsonb NOT NULL,
  brand_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  hr_district_code character varying(40),
  brand_barcode character varying(2),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.business_groups_id_seq'::regclass),
  business_group_name jsonb NOT NULL,
  business_group_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  member_country_code character varying(40) NOT NULL,
  business_group_code character varying(40) NOT NULL,
  policy_profile_code character varying(100),
  head_of_unit character varying(15),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_companies (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_companies_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_divisions (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_divisions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_groups_of_standard_function (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_groups_of_standard_function_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  group_of_standard_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_section_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_section_groups_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  section_group_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_standard_functions (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_standard_functions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  standard_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_store_formats (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_store_formats_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  store_format_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_sub_functions (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_sub_functions_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  sub_function_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_unit_sub_organizations (
  id bigint NOT NULL DEFAULT nextval('foundation.business_unit_sub_organizations_id_seq'::regclass),
  business_unit_code character varying(40) NOT NULL,
  sub_organization_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.business_units (
  id bigint NOT NULL DEFAULT nextval('foundation.business_units_id_seq'::regclass),
  business_unit_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  business_unit_code character varying(40) NOT NULL,
  business_group_code character varying(40),
  policy_profile_code character varying(100),
  business_unit_name jsonb NOT NULL,
  head_of_unit character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.companies (
  id bigint NOT NULL DEFAULT nextval('foundation.companies_id_seq'::regclass),
  company_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  business_group_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  company_name jsonb NOT NULL,
  currency_code character varying(255),
  company_phone_no character varying(255),
  company_tax_id character varying(40),
  country_code character varying(40),
  standard_hours numeric(5,2),
  is_active boolean NOT NULL DEFAULT true,
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  road jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(40),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.corporate_title (
  id bigint NOT NULL DEFAULT nextval('foundation.corporate_title_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  policy_profile_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.cost_centers (
  id bigint NOT NULL DEFAULT nextval('foundation.cost_centers_id_seq'::regclass),
  cost_center_code character varying(40) NOT NULL,
  cost_center_name jsonb NOT NULL,
  cost_center_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  company_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.country_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.country_groups_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  group_code character varying(40) NOT NULL,
  group_name jsonb NOT NULL,
  group_description jsonb,
  member_country_code character varying(40) NOT NULL,
  member_country_name jsonb NOT NULL,
  member_country_description jsonb,
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.currencies (
  id bigint NOT NULL DEFAULT nextval('foundation.currencies_id_seq'::regclass),
  currency_code character varying(255) NOT NULL,
  currency_name jsonb NOT NULL,
  currency_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  default_decimals integer,
  symbol character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.departments (
  id bigint NOT NULL DEFAULT nextval('foundation.departments_id_seq'::regclass),
  department_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  department_code character varying(40) NOT NULL,
  business_unit_code character varying(40),
  division_code character varying(40) NOT NULL,
  department_name jsonb NOT NULL,
  cost_center_code character varying(40),
  section_group character varying(255),
  sso_location_code character varying(40),
  work_location_code character varying(40),
  store_branch_location_code character varying(40),
  head_of_unit character varying(255),
  section_group_code character varying(40),
  group_of_standard_function_code character varying(40),
  standard_function_code character varying(40),
  sub_function_code character varying(40),
  sub_organization_code character varying(40),
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.divisions (
  id bigint NOT NULL DEFAULT nextval('foundation.divisions_id_seq'::regclass),
  division_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  division_code character varying(40) NOT NULL,
  division_name jsonb NOT NULL,
  business_group_code character varying(255),
  policy_profile_code character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.employee_group_employee_subgroups (
  id bigint NOT NULL DEFAULT nextval('foundation.employee_group_employee_subgroups_id_seq'::regclass),
  employee_group_code character varying(40) NOT NULL,
  employee_subgroup_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.employee_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.employee_groups_id_seq'::regclass),
  employee_group_code character varying(40) NOT NULL,
  employee_group_name jsonb NOT NULL,
  employee_group_description jsonb,
  country_code character varying(40),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.employee_subgroups (
  id bigint NOT NULL DEFAULT nextval('foundation.employee_subgroups_id_seq'::regclass),
  employee_subgroup_code character varying(40) NOT NULL,
  employee_subgroup_name jsonb NOT NULL,
  employee_subgroup_description jsonb,
  country_code character varying(40),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  pay_grade_code character varying(40) NOT NULL,
  subgroup_numeric integer,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.event_reasons (
  id bigint NOT NULL DEFAULT nextval('foundation.event_reasons_id_seq'::regclass),
  event_reason_code character varying(40) NOT NULL,
  event_reason_name jsonb NOT NULL,
  event_reason_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_code character varying(40) NOT NULL,
  version character varying(255),
  employee_status character varying(45),
  payroll_event character varying(4),
  include_in_work_experience boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.events (
  id bigint NOT NULL DEFAULT nextval('foundation.events_id_seq'::regclass),
  event_code character varying(40) NOT NULL,
  event_name jsonb NOT NULL,
  event_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.frequencies (
  id bigint NOT NULL DEFAULT nextval('foundation.frequencies_id_seq'::regclass),
  frequency_code character varying(100) NOT NULL,
  frequency_name jsonb NOT NULL,
  frequency_description jsonb,
  annualization_factor numeric(8,5),
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation."group" (
  id bigint NOT NULL DEFAULT nextval('foundation.group_id_seq'::regclass),
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  status character(1) NOT NULL DEFAULT 'A'::bpchar,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.groups_of_standard_functions (
  id bigint NOT NULL DEFAULT nextval('foundation.groups_of_standard_functions_id_seq'::regclass),
  groups_of_standard_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  group_of_standard_function_code character varying(40) NOT NULL,
  group_of_standard_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.hr_districts (
  id bigint NOT NULL DEFAULT nextval('foundation.hr_districts_id_seq'::regclass),
  hr_district_code character varying(40) NOT NULL,
  hr_district_name jsonb NOT NULL,
  hr_district_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  hrbp_pg11 character varying(20),
  hrbp_pg14 character varying(20),
  hrbp_pg17 character varying(20),
  hrbp_pg19 character varying(20),
  hrbp_pg7 character varying(20),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.job_catalogs (
  id bigint NOT NULL DEFAULT nextval('foundation.job_catalogs_id_seq'::regclass),
  job_catalog_code character varying(40) NOT NULL,
  job_catalog_name jsonb NOT NULL,
  job_catalog_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  job_catalog character varying(255),
  functional_capability character varying(255),
  job_family_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.job_codes (
  id bigint NOT NULL DEFAULT nextval('foundation.job_codes_id_seq'::regclass),
  job_code_code character varying(255) NOT NULL,
  job_code_name jsonb NOT NULL,
  job_code_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  max_job_grade_code character varying(40),
  min_job_grade_code character varying(40),
  band_code character varying(40),
  job_type character varying(255),
  job_family_code character varying(40),
  job_catalog_code character varying(40),
  salary_structure text,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.job_families (
  id bigint NOT NULL DEFAULT nextval('foundation.job_families_id_seq'::regclass),
  job_family_code character varying(40) NOT NULL,
  job_family_name jsonb NOT NULL,
  job_family_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.job_type (
  id bigint NOT NULL DEFAULT nextval('foundation.job_type_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  code character varying(40) NOT NULL,
  name character varying(255) NOT NULL,
  description character varying(2000),
  policy_profile_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.master_countries (
  id bigint NOT NULL DEFAULT nextval('foundation.master_countries_id_seq'::regclass),
  country_name jsonb NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_code character varying(40) NOT NULL,
  numeric_country_code character varying(3),
  territory_code character varying(40),
  currency_code character varying(255),
  two_char_country_code character varying(2),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.national_id_card_type (
  id bigint NOT NULL DEFAULT nextval('foundation.national_id_card_type_id_seq'::regclass),
  card_type_code character varying(10) NOT NULL,
  card_type_name character varying(255) NOT NULL,
  display_format character varying(255),
  regular_exp character varying(255),
  description character varying(2000),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_component_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_component_groups_id_seq'::regclass),
  pay_component_group_code character varying(32) NOT NULL,
  pay_component_group_name jsonb,
  pay_component_group_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  currency_code character varying(255),
  version character varying(255),
  max_fraction_digits integer,
  show_on_comp_ui boolean,
  use_for_comparatio_calc boolean,
  use_for_range_penetration boolean,
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_components (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_components_id_seq'::regclass),
  pay_component_code character varying(255) NOT NULL,
  pay_component_name jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  country_code character varying(255) NOT NULL,
  currency_code character varying(255),
  frequency_code character varying(100),
  can_override boolean,
  pay_component_type character varying(32),
  pay_component_value numeric(18,2),
  is_earning boolean,
  is_recurring boolean,
  is_active boolean DEFAULT true,
  tax_treatment character varying(32),
  version character varying(255),
  is_display_on_ui boolean,
  is_end_dated_payment boolean,
  max_decimal_place integer,
  component_number integer,
  rate numeric(18,2),
  target boolean,
  unit_of_measure character varying(3),
  pay_component_group_code character varying(255),
  used_for_comp_planning character varying(32),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_grades (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_grades_id_seq'::regclass),
  pay_grade_code character varying(40) NOT NULL,
  pay_grade_name jsonb NOT NULL,
  pay_grade_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  version character varying(255),
  pay_grade_numeric integer,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_groups_id_seq'::regclass),
  pay_group_code character varying(40) NOT NULL,
  pay_group_name jsonb NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  frequency_code character varying(100),
  earliest_change_date date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_scale_areas (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_scale_areas_id_seq'::regclass),
  pay_scale_area_code character varying(40) NOT NULL,
  pay_scale_area_name jsonb NOT NULL,
  country_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_scale_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_scale_groups_id_seq'::regclass),
  pay_scale_group_code character varying(40) NOT NULL,
  pay_scale_group_name jsonb NOT NULL,
  country_code character varying(40) NOT NULL,
  pay_scale_area_code character varying(40),
  pay_scale_type_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_scale_levels (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_scale_levels_id_seq'::regclass),
  pay_scale_level_code character varying(40) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  pay_scale_level_name jsonb NOT NULL,
  next_pay_scale_level_code character varying(40),
  pay_scale_group_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.pay_scale_types (
  id bigint NOT NULL DEFAULT nextval('foundation.pay_scale_types_id_seq'::regclass),
  pay_scale_type_code character varying(40) NOT NULL,
  pay_scale_type_name jsonb NOT NULL,
  country_code character varying(40) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.picking_lists (
  id bigint NOT NULL DEFAULT nextval('foundation.picking_lists_id_seq'::regclass),
  non_unique_code character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  picklist_id character varying(255) NOT NULL,
  picklist_code character varying(100) NOT NULL,
  parent_picklist_code character varying(100),
  label jsonb NOT NULL,
  sort_order integer,
  picklist_status character(1) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.position_matrix_relationships (
  id bigint NOT NULL DEFAULT nextval('foundation.position_matrix_relationships_id_seq'::regclass),
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  matrix_relationship_type character varying(128) NOT NULL,
  related_position_code character varying(8) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.positions (
  id bigint NOT NULL DEFAULT nextval('foundation.positions_id_seq'::regclass),
  position_code character varying(8) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  position_name jsonb NOT NULL,
  position_description jsonb,
  parent_position_code character varying(8),
  group_code character varying(40) NOT NULL,
  member_country_code character varying(40) NOT NULL,
  business_group_code character varying(40) NOT NULL,
  company_code character varying(40) NOT NULL,
  business_unit_code character varying(40) NOT NULL,
  division_code character varying(40) NOT NULL,
  department_code character varying(40) NOT NULL,
  cost_center_code character varying(40) NOT NULL,
  store_branch_location_code character varying(40),
  work_location_code character varying(40),
  sso_location_code character varying(40),
  zone_code character varying(40),
  pay_grade_code character varying(40),
  job_type character varying(255),
  job_family_code character varying(40),
  job_code_code character varying(255),
  job_level character varying(128),
  job_title character varying(255),
  employee_group_code character varying(40),
  employee_subgroup_code character varying(40),
  brand_code character varying(40),
  hr_district_code character varying(40),
  section_group_code character varying(40),
  group_of_standard_function_code character varying(40),
  standard_function_code character varying(40),
  sub_function_code character varying(40),
  sub_organization_code character varying(40),
  policy_profile_code character varying(100),
  change_reason character varying(128),
  comment character varying(255),
  creation_source character varying(128),
  criticality integer,
  holiday_calendar_code character varying(40),
  management_program character varying(128),
  work_schedule_code character varying(40),
  work_schedule_template_code character varying(40),
  incumbent_employee_code character varying(100),
  multiple_incumbents_allowed boolean,
  pay_range character varying(32),
  position_controlled boolean,
  position_criticality character varying(128),
  regular_temporary character varying(128),
  target_fte numeric(6,3),
  type character varying(128),
  vacant boolean,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.section_groups (
  id bigint NOT NULL DEFAULT nextval('foundation.section_groups_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  section_group_code character varying(40) NOT NULL,
  section_group_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  policy_profile_code character varying(100),
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.sso_locations (
  id bigint NOT NULL DEFAULT nextval('foundation.sso_locations_id_seq'::regclass),
  sso_location_code character varying(40) NOT NULL,
  sso_location_name jsonb NOT NULL,
  sso_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  company_code character varying(40) NOT NULL,
  internal_code character varying(40),
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.standard_functions (
  id bigint NOT NULL DEFAULT nextval('foundation.standard_functions_id_seq'::regclass),
  standard_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  standard_function_code character varying(40) NOT NULL,
  standard_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.store_branch_locations (
  id bigint NOT NULL DEFAULT nextval('foundation.store_branch_locations_id_seq'::regclass),
  store_branch_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  store_branch_location_code character varying(40) NOT NULL,
  store_branch_location_name jsonb NOT NULL,
  address_line1 jsonb,
  apartment jsonb,
  bed_number jsonb,
  address_line2 jsonb,
  address_line3 jsonb,
  apartment2 jsonb,
  second_address_line jsonb,
  town jsonb,
  district jsonb,
  building_number jsonb,
  building jsonb,
  city jsonb,
  country_code character varying(40),
  county jsonb,
  province jsonb,
  state jsonb,
  postal_code character varying(40),
  store_format_code character varying(40),
  store_size character varying(255),
  zone_code character varying(40),
  hr_district_code character varying(40),
  store_type character varying(255),
  region character varying(255),
  ofin character varying(255),
  version character varying(255),
  sso_location_code character varying(40),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.store_formats (
  id bigint NOT NULL DEFAULT nextval('foundation.store_formats_id_seq'::regclass),
  store_format_code character varying(40) NOT NULL,
  store_format_name jsonb NOT NULL,
  store_format_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.sub_functions (
  id bigint NOT NULL DEFAULT nextval('foundation.sub_functions_id_seq'::regclass),
  sub_function_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  sub_function_code character varying(40) NOT NULL,
  sub_function_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.sub_organizations (
  id bigint NOT NULL DEFAULT nextval('foundation.sub_organizations_id_seq'::regclass),
  sub_organization_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  sub_organization_code character varying(40) NOT NULL,
  sub_organization_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.work_location_geofences (
  id bigint NOT NULL DEFAULT nextval('foundation.work_location_geofences_id_seq'::regclass),
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  work_location_code character varying(40) NOT NULL,
  geofence_type character varying(20),
  center_latitude numeric(10,6),
  center_longitude numeric(10,6),
  allow_radius_meter integer,
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.work_locations (
  id bigint NOT NULL DEFAULT nextval('foundation.work_locations_id_seq'::regclass),
  work_location_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  work_location_code character varying(40) NOT NULL,
  work_location_name jsonb NOT NULL,
  country_code character varying(40),
  property character varying(255),
  latitude numeric(11,8),
  longitude numeric(11,8),
  timezone character varying(255),
  floor jsonb,
  room_number jsonb,
  building jsonb,
  village_number jsonb,
  house_street_number jsonb,
  village jsonb,
  alley jsonb,
  road jsonb,
  district jsonb,
  sub_district jsonb,
  province jsonb,
  postal_code character varying(40),
  is_active boolean DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE foundation.zones (
  id bigint NOT NULL DEFAULT nextval('foundation.zones_id_seq'::regclass),
  zone_code character varying(40) NOT NULL,
  zone_name jsonb NOT NULL,
  zone_description jsonb,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  version character varying(255),
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE grim.agent_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  session_id text,
  task_slug text,
  adw_id text,
  adw_step text,
  entry_index integer,
  event_category text NOT NULL,
  event_type text NOT NULL,
  content text,
  payload jsonb DEFAULT '{}'::jsonb,
  summary text,
  "timestamp" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  name text NOT NULL,
  model text NOT NULL,
  system_prompt text,
  working_dir text,
  git_worktree text,
  status text,
  session_id text,
  adw_id text,
  adw_step text,
  input_tokens integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  total_cost numeric(10,4) DEFAULT 0.0000,
  archived boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.ai_developer_workflows (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid,
  adw_name text NOT NULL,
  workflow_type text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'pending'::text,
  current_step text,
  total_steps integer DEFAULT 0,
  completed_steps integer DEFAULT 0,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  duration_seconds integer,
  input_data jsonb DEFAULT '{}'::jsonb,
  output_data jsonb DEFAULT '{}'::jsonb,
  error_message text,
  error_step text,
  error_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.catalogs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  name text NOT NULL,
  source text NOT NULL,
  format text NOT NULL DEFAULT 'markdown'::text,
  content text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.check_collections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.oracle_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL,
  request text NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  fulfillment text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.orchestrator_agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id text,
  system_prompt text,
  status text,
  working_dir text,
  input_tokens integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  total_cost numeric(10,4) DEFAULT 0.0000,
  archived boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.orchestrator_chat (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  orchestrator_agent_id uuid NOT NULL,
  sender_type text NOT NULL,
  receiver_type text NOT NULL,
  message text NOT NULL,
  summary text,
  agent_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE grim.prompts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_id uuid,
  task_slug text,
  author text NOT NULL,
  prompt_text text NOT NULL,
  summary text,
  "timestamp" timestamp with time zone NOT NULL DEFAULT now(),
  session_id text
);

CREATE TABLE grim.regression_chain_steps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  chain_id uuid NOT NULL,
  step_index integer NOT NULL,
  claim text NOT NULL,
  command_template text NOT NULL,
  produces jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_exit_code integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.regression_chains (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  scope text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source_verification_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.regression_checks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  scope text NOT NULL,
  claim text NOT NULL,
  command text NOT NULL,
  expected_exit_code integer,
  source_verification_id uuid,
  active boolean NOT NULL DEFAULT true,
  last_run_at timestamp with time zone,
  last_verdict text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  flow_path text
);

CREATE TABLE grim.system_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  file_path text,
  adw_id text,
  adw_step text,
  level text NOT NULL,
  message text NOT NULL,
  summary text,
  metadata jsonb DEFAULT '{}'::jsonb,
  "timestamp" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.verification_checks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL,
  check_index integer NOT NULL DEFAULT 0,
  claim text NOT NULL,
  command text,
  exit_code integer,
  output_excerpt text,
  verdict text NOT NULL,
  evidence_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.verification_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  frequency text NOT NULL,
  at_time time without time zone,
  timezone text NOT NULL DEFAULT 'UTC'::text,
  status text NOT NULL DEFAULT 'active'::text,
  next_run_at timestamp with time zone,
  last_run_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE grim.verifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  orchestrator_agent_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  verified_agent_id uuid,
  task_slug text,
  session_id text,
  status text NOT NULL,
  confidence text NOT NULL,
  summary text,
  sections jsonb NOT NULL DEFAULT '{}'::jsonb,
  pass_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  oracle_unavailable_count integer NOT NULL DEFAULT 0,
  refused_count integer NOT NULL DEFAULT 0,
  loop_count integer,
  raw_report text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  blocked_count integer NOT NULL DEFAULT 0
);

CREATE TABLE notification."SequelizeMeta_notification" (
  name character varying(255) NOT NULL
);

CREATE TABLE notification.notification_history (
  id bigint NOT NULL DEFAULT nextval('notification.notification_history_id_seq'::regclass),
  event_id uuid NOT NULL,
  template_code character varying(100) NOT NULL,
  recipient_employee_id bigint NOT NULL,
  channel character varying(20) NOT NULL,
  status character varying(30) NOT NULL,
  provider_response text,
  source_module character varying(100) NOT NULL,
  correlation_id character varying(255),
  attempted_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notification.notification_templates (
  id bigint NOT NULL DEFAULT nextval('notification.notification_templates_id_seq'::regclass),
  code character varying(100) NOT NULL,
  name jsonb NOT NULL,
  channels jsonb NOT NULL,
  category character varying(50),
  content jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255)
);

CREATE TABLE notification.notifications (
  id bigint NOT NULL DEFAULT nextval('notification.notifications_id_seq'::regclass),
  employee_id bigint NOT NULL,
  template_code character varying(100) NOT NULL,
  category character varying(50),
  title text NOT NULL,
  body text,
  deeplink text,
  status character varying(20) NOT NULL DEFAULT 'UNREAD'::character varying,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255),
  read_at timestamp with time zone,
  deleted_at timestamp with time zone
);

CREATE TABLE payroll.approval_requests (
  id integer NOT NULL,
  entity_type character varying NOT NULL,
  entity_id integer NOT NULL,
  action_requested character varying NOT NULL,
  status character varying NOT NULL DEFAULT 'PENDING'::character varying,
  requested_by integer NOT NULL,
  assigned_to integer,
  request_note text,
  decision_note text,
  decided_by integer,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  decided_at timestamp with time zone,
  expires_at timestamp with time zone
);

CREATE TABLE payroll.audit_log (
  id integer NOT NULL,
  entity_type character varying NOT NULL,
  entity_id integer NOT NULL,
  action character varying NOT NULL,
  old_values jsonb,
  new_values jsonb,
  changed_by integer,
  changed_by_email character varying,
  ip_address character varying,
  performed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.bank_transfer_files (
  id integer NOT NULL,
  for_period character varying NOT NULL,
  file_format character varying NOT NULL,
  file_name character varying NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  currency character varying NOT NULL DEFAULT 'THB'::character varying,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  transmitted_at timestamp with time zone,
  company_code character varying(10),
  payroll_area_code character varying(10),
  bank_code character varying(10),
  batch_reference character varying(50),
  transmitted_by character varying(255)
);

CREATE TABLE payroll.control_records (
  id integer NOT NULL,
  period_number integer NOT NULL,
  period_year integer NOT NULL,
  period_key character varying NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  payment_date date NOT NULL,
  earliest_retro_period date,
  status payroll.control_record_status NOT NULL DEFAULT 'RELEASED_FOR_PAYROLL'::payroll.control_record_status,
  locked_by integer,
  status_changed_at timestamp with time zone,
  status_changed_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(10),
  payroll_area_code character varying(10) NOT NULL
);

CREATE TABLE payroll.employee_leave_entries (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  leave_date date NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  duration numeric(15,2) NOT NULL,
  duration_base60 numeric(15,2) NOT NULL,
  unit_code character varying(10) NOT NULL,
  leave_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  created_by character varying(255) NOT NULL,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll.employee_retro_entries (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  period_key character varying(7) NOT NULL,
  wage_type character varying(10) NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  synced_at timestamp with time zone,
  company_code character varying(25) NOT NULL,
  original_period character varying(7) NOT NULL
);

CREATE TABLE payroll.employee_time_entries (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  period_key character varying(7) NOT NULL,
  ot_hours numeric(6,2) NOT NULL DEFAULT 0,
  ot_rate numeric(10,2) NOT NULL DEFAULT 0,
  synced_at timestamp with time zone,
  company_code character varying(25) NOT NULL,
  wage_type character varying(10) NOT NULL
);

CREATE TABLE payroll.employees (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  synced_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL,
  pvd_enrolled boolean NOT NULL DEFAULT true
);

CREATE TABLE payroll.hr_core_sync_errors (
  id integer NOT NULL,
  run_id integer NOT NULL,
  entity text NOT NULL,
  message text NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.hr_core_sync_runs (
  id integer NOT NULL,
  triggered_by text NOT NULL,
  status text NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  duration_ms integer,
  employees_synced integer DEFAULT 0,
  employees_failed integer DEFAULT 0,
  assignments_synced integer DEFAULT 0,
  assignments_failed integer DEFAULT 0,
  notes text
);

CREATE TABLE payroll.integration_jobs (
  id integer NOT NULL,
  job_type payroll.job_type NOT NULL,
  source_system character varying NOT NULL DEFAULT 'HR_CORE'::character varying,
  status payroll.job_status NOT NULL DEFAULT 'PENDING'::payroll.job_status,
  period_key character varying,
  records_synced integer NOT NULL DEFAULT 0,
  records_failed integer NOT NULL DEFAULT 0,
  error_message text,
  triggered_by integer,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.manual_wage_adjustments (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  period_key text NOT NULL,
  wage_type text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'THB'::text,
  description text,
  source text NOT NULL DEFAULT 'MANUAL'::text,
  payroll_run_id integer,
  created_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL
);

CREATE TABLE payroll.notifications (
  id integer NOT NULL,
  user_id integer NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id integer,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.off_cycle_requests (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  run_type text NOT NULL,
  period_key text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'::text,
  requested_by integer,
  approved_by integer,
  requested_at timestamp with time zone NOT NULL DEFAULT now(),
  decided_at timestamp with time zone,
  company_code character varying(25) NOT NULL,
  payroll_area_code character varying(10)
);

CREATE TABLE payroll.payroll_result_items (
  id integer NOT NULL,
  payroll_result_id integer NOT NULL,
  sub_table character varying NOT NULL DEFAULT 'RT'::character varying,
  wage_type character varying NOT NULL,
  wage_type_description character varying NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  quantity numeric,
  currency character varying NOT NULL DEFAULT 'THB'::character varying,
  origin_indicator character varying,
  cost_center character varying,
  gl_account character varying,
  sort_order integer NOT NULL DEFAULT 0,
  is_taxable boolean,
  tax_type_code character varying(10),
  original_period character varying(7)
);

CREATE TABLE payroll.payroll_result_tax_accum (
  id integer NOT NULL DEFAULT nextval('payroll.payroll_result_tax_accum_id_seq'::regclass),
  payroll_result_id integer NOT NULL,
  regular_taxable numeric(18,2) NOT NULL DEFAULT 0,
  irregular_taxable numeric(18,2) NOT NULL DEFAULT 0,
  tax_withheld numeric(18,2) NOT NULL DEFAULT 0,
  deductions numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.payroll_results (
  id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  for_period character varying NOT NULL,
  in_period character varying NOT NULL,
  run_type character varying NOT NULL,
  sequence_number integer NOT NULL DEFAULT 1,
  status character varying NOT NULL DEFAULT 'CLEAN'::character varying,
  is_latest boolean NOT NULL DEFAULT true,
  has_retro boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  is_simulation boolean NOT NULL DEFAULT false,
  company_code character varying(25) NOT NULL
);

CREATE TABLE payroll.payroll_run_logs (
  id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  employee_code character varying(25),
  level character varying NOT NULL,
  sequence integer NOT NULL DEFAULT 0,
  parent_id integer,
  status character varying NOT NULL DEFAULT 'OK'::character varying,
  function_name character varying,
  message text NOT NULL,
  suggested_fix text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25)
);

CREATE TABLE payroll.payroll_runs (
  id integer NOT NULL,
  control_record_id integer,
  period_key character varying NOT NULL,
  for_period character varying NOT NULL,
  in_period character varying NOT NULL,
  payment_date date,
  run_type payroll.run_type NOT NULL DEFAULT 'S'::payroll.run_type,
  is_simulation boolean NOT NULL DEFAULT true,
  status payroll.run_status NOT NULL DEFAULT 'PENDING'::payroll.run_status,
  total_employees integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  log_level integer NOT NULL DEFAULT 2,
  schema_name character varying,
  executed_by integer,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(10),
  payroll_area_code character varying(10) NOT NULL,
  persist_step smallint NOT NULL DEFAULT 0,
  run_scope character varying(10) NOT NULL DEFAULT 'AREA'::character varying,
  scope_employee_codes text[]
);

CREATE TABLE payroll.payroll_ytd_opening_balances (
  id integer NOT NULL DEFAULT nextval('payroll.payroll_ytd_opening_balances_id_seq'::regclass),
  employee_code character varying(25) NOT NULL,
  tax_year integer NOT NULL,
  ytd_regular_taxable numeric(18,2) NOT NULL DEFAULT 0,
  ytd_irregular_taxable numeric(18,2) NOT NULL DEFAULT 0,
  ytd_tax_withheld numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL,
  ytd_social_security numeric(18,2) NOT NULL DEFAULT 0,
  ytd_provident_fund numeric(18,2) NOT NULL DEFAULT 0
);

CREATE TABLE payroll.payslip_form_templates (
  id integer NOT NULL,
  name character varying NOT NULL,
  description character varying,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer,
  updated_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.payslips (
  id integer NOT NULL,
  payroll_result_id integer,
  employee_code character varying(25) NOT NULL,
  for_period character varying NOT NULL,
  form_name character varying NOT NULL DEFAULT 'STANDARD'::character varying,
  file_path character varying,
  file_format character varying NOT NULL DEFAULT 'PDF'::character varying,
  distribution_status character varying NOT NULL DEFAULT 'PENDING'::character varying,
  generated_at timestamp with time zone,
  distributed_at timestamp with time zone,
  generated_by integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL
);

CREATE TABLE payroll.posting_batches (
  id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  for_period character varying NOT NULL,
  is_simulation boolean NOT NULL DEFAULT true,
  batch_status character varying NOT NULL DEFAULT 'DRAFT'::character varying,
  fi_document_number character varying,
  total_debit numeric NOT NULL DEFAULT 0,
  total_credit numeric NOT NULL DEFAULT 0,
  currency character varying NOT NULL DEFAULT 'THB'::character varying,
  created_by integer,
  released_by integer,
  created_at timestamp with time zone DEFAULT now(),
  released_at timestamp with time zone,
  reversed_at timestamp with time zone,
  reversed_by integer,
  reversal_reason text
);

CREATE TABLE payroll.posting_lines (
  id integer NOT NULL,
  posting_batch_id integer NOT NULL,
  gl_account character varying NOT NULL,
  cost_center character varying,
  debit_credit character varying NOT NULL,
  amount numeric NOT NULL,
  currency character varying NOT NULL DEFAULT 'THB'::character varying,
  wage_type character varying,
  symbolic_account character varying,
  employee_code character varying(25),
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  company_code character varying(25)
);

CREATE TABLE payroll.retro_results (
  id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  original_period character varying NOT NULL,
  current_period character varying NOT NULL,
  original_result_id integer,
  adjusted_result_id integer,
  delta_amount numeric NOT NULL DEFAULT 0,
  delta_currency character varying NOT NULL DEFAULT 'THB'::character varying,
  carried_forward boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  wage_type character varying,
  company_code character varying(25) NOT NULL
);

CREATE TABLE payroll.run_employee_results (
  id integer NOT NULL,
  payroll_run_id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  status payroll.employee_run_status NOT NULL DEFAULT 'CLEAN'::payroll.employee_run_status,
  error_code character varying,
  error_message text,
  has_retro boolean NOT NULL DEFAULT false,
  processed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL
);

CREATE TABLE payroll.schema_migrations (
  version text NOT NULL,
  applied_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll.user_roles (
  id integer NOT NULL,
  user_id integer NOT NULL,
  role payroll.user_role NOT NULL,
  assigned_by integer,
  assigned_at timestamp with time zone NOT NULL DEFAULT now(),
  payroll_area_code character varying(10)
);

CREATE TABLE payroll.users (
  id integer NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  full_name text,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE payroll_config.bank_file_format (
  file_format_code character varying(20) NOT NULL,
  bank_country_code character varying(2),
  bank_code character varying(10),
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_by character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_config.company (
  company_code character varying(25) NOT NULL,
  country_code character varying(5) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.company_bank_account (
  id integer NOT NULL DEFAULT nextval('payroll_config.company_bank_account_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  bank_country_code character varying(2) NOT NULL,
  bank_code character varying(10) NOT NULL,
  file_format_code character varying(20),
  account_number character varying(20) NOT NULL,
  account_name jsonb NOT NULL,
  bank_assigned_company_id character varying(20),
  bank_product_code character varying(20),
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_by character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_config.company_branch (
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.company_branch_profile (
  id integer NOT NULL DEFAULT nextval('payroll_config.company_branch_profile_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  social_security_location_code character varying(25),
  branch_name jsonb NOT NULL,
  description character varying(255),
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.company_profile (
  id integer NOT NULL DEFAULT nextval('payroll_config.company_profile_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  country_code character varying(5) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  company_name jsonb NOT NULL,
  company_short_name jsonb NOT NULL,
  currency_code character varying(3) NOT NULL,
  company_tax_id character varying(50) NOT NULL,
  address jsonb NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.company_social_security_location (
  id integer NOT NULL DEFAULT nextval('payroll_config.company_social_security_location_id_seq'::regclass),
  social_security_location_code character varying(25) NOT NULL,
  social_security_location_name jsonb NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  company_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.country (
  country_code character varying(5) NOT NULL,
  country_name jsonb
);

CREATE TABLE payroll_config.employee_group (
  employee_group_id integer NOT NULL DEFAULT nextval('payroll_config.employee_group_employee_group_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_group_code character varying(25) NOT NULL,
  employee_group_name character varying(255) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.employee_group_mapping (
  id integer NOT NULL DEFAULT nextval('payroll_config.employee_group_mapping_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_group_code character varying(25) NOT NULL,
  employee_subgroup_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.employee_subgroup (
  employee_subgroup_id integer NOT NULL DEFAULT nextval('payroll_config.employee_subgroup_employee_subgroup_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_subgroup_code character varying(25) NOT NULL,
  employee_subgroup_name character varying(255) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.employee_type (
  employee_type_id integer NOT NULL DEFAULT nextval('payroll_config.employee_type_employee_type_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_type_code character varying(25) NOT NULL,
  employee_type_name character varying(255) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.employee_type_group (
  employee_type_group_id integer NOT NULL DEFAULT nextval('payroll_config.employee_type_group_employee_type_group_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_group_code character varying(25) NOT NULL,
  employee_subgroup_code character varying(25) NOT NULL,
  employee_type_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.fund_plan (
  fund_plan_id integer NOT NULL DEFAULT nextval('payroll_config.fund_plan_fund_plan_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  fund_plan_code character varying(25) NOT NULL,
  fund_plan_name character varying(255) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.fund_profile (
  fund_profile_id integer NOT NULL DEFAULT nextval('payroll_config.fund_profile_fund_profile_id_seq'::regclass),
  fund_profile_code character varying(25) NOT NULL,
  fund_name character varying(255) NOT NULL,
  fund_account_number character varying(25) NOT NULL,
  company_code character varying(25) NOT NULL,
  country_code character varying(5) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.fund_rate (
  fund_rate_id integer NOT NULL DEFAULT nextval('payroll_config.fund_rate_fund_rate_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  country_code character varying(5) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  employee_group_code character varying(25) NOT NULL,
  employee_subgroup_code character varying(25) NOT NULL,
  service_year_from integer NOT NULL,
  service_year_to integer NOT NULL,
  employee_contribution_rate numeric(6,4) NOT NULL,
  employer_contribution_rate numeric(6,4) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.fund_type (
  fund_type_id integer NOT NULL DEFAULT nextval('payroll_config.fund_type_fund_type_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  fund_type_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.leave_full_month (
  leave_full_month_id integer NOT NULL DEFAULT nextval('payroll_config.leave_full_month_leave_full_month_id_seq'::regclass),
  leave_code character varying(10) NOT NULL,
  leave_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.pay_frequency (
  pay_frequency_code character varying(5) NOT NULL,
  name character varying(10) NOT NULL
);

CREATE TABLE payroll_config.payday_rule (
  payday_rule_id integer NOT NULL DEFAULT nextval('payroll_config.payday_rule_payday_rule_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  payday_rule_code character varying(10) NOT NULL,
  payday_rule_name character varying(100) NOT NULL,
  payday_day integer,
  is_end_of_month boolean NOT NULL DEFAULT false,
  is_backward boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.payroll_area (
  payroll_area_id integer NOT NULL DEFAULT nextval('payroll_config.payroll_area_payroll_area_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  payroll_area_code character varying(10) NOT NULL,
  payroll_area_name character varying(100),
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  employee_type_code character varying(25) NOT NULL,
  period_pattern_code character varying(5) NOT NULL,
  payday_rule_code character varying(10) NOT NULL,
  status character varying(1) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.payroll_area_company (
  payroll_area_company_id integer NOT NULL DEFAULT nextval('payroll_config.payroll_area_company_payroll_area_company_id_seq'::regclass),
  payroll_area_id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.payroll_period (
  payroll_period_id integer NOT NULL DEFAULT nextval('payroll_config.payroll_period_payroll_period_id_seq'::regclass),
  period_description character varying(255),
  payroll_area_id integer NOT NULL,
  country_code character varying(5) NOT NULL,
  period_type_code character varying(50) NOT NULL,
  payroll_year integer NOT NULL,
  payroll_month integer NOT NULL,
  period_sequence integer NOT NULL,
  payment_date date NOT NULL,
  retroactive_period_id integer,
  payroll_period_from date,
  payroll_period_to date,
  time_period_from date,
  time_period_to date,
  leave_form_period_from date,
  leave_form_period_to date,
  status character varying(1) NOT NULL,
  base_day integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.period_pattern (
  period_pattern_id integer NOT NULL DEFAULT nextval('payroll_config.period_pattern_period_pattern_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  period_type_code character varying(50) NOT NULL,
  period_pattern_code character varying(5) NOT NULL,
  period_pattern_name character varying(100),
  payroll_from_day integer NOT NULL,
  payroll_from_month_offset integer NOT NULL,
  payroll_to_day integer NOT NULL,
  payroll_to_month_offset integer NOT NULL,
  time_from_day integer,
  time_from_month_offset integer,
  time_to_day integer,
  time_to_month_offset integer,
  leave_form_from_day integer,
  leave_form_from_month_offset integer,
  leave_form_to_day integer,
  leave_form_to_month_offset integer,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.period_type (
  period_type_id integer NOT NULL DEFAULT nextval('payroll_config.period_type_period_type_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  period_type_code character varying(50) NOT NULL,
  period_type_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.round_method (
  round_method_id integer NOT NULL DEFAULT nextval('payroll_config.round_method_round_method_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  round_method_code character varying(5) NOT NULL,
  round_method_name character varying(100) NOT NULL,
  description character varying(255),
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.severance_expense_deduction (
  expense_deduction_id integer NOT NULL DEFAULT nextval('payroll_config.severance_expense_deduction_expense_deduction_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  deduction_code character varying(10) NOT NULL,
  deduction_type character varying(25) NOT NULL,
  yearly_deduction_amount numeric(15,2) NOT NULL,
  percent_deduction numeric(6,2) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.severance_pay_master (
  pay_id integer NOT NULL DEFAULT nextval('payroll_config.severance_pay_master_pay_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  severance_pay_code character varying(10) NOT NULL,
  severance_pay_name character varying(255) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.severance_pay_rate (
  pay_rate_id integer NOT NULL DEFAULT nextval('payroll_config.severance_pay_rate_pay_rate_id_seq'::regclass),
  pay_id integer NOT NULL,
  sequence_number integer NOT NULL,
  minimum_service_days integer,
  service_year_from numeric(5,2) NOT NULL,
  service_year_to numeric(5,2) NOT NULL,
  pay_day integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.severance_tax_exemption (
  tax_exemption_id integer NOT NULL DEFAULT nextval('payroll_config.severance_tax_exemption_tax_exemption_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_exemption_code character varying(10) NOT NULL,
  tax_exemption_type character varying(25) NOT NULL,
  salary_day_limit integer NOT NULL,
  max_amount numeric(15,2) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.social_security_base_amount (
  id integer NOT NULL DEFAULT nextval('payroll_config.social_security_base_amount_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  minimum_base_amount numeric(15,2),
  maximum_base_amount numeric(15,2),
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.social_security_branch_rate (
  id integer NOT NULL DEFAULT nextval('payroll_config.social_security_branch_rate_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  employee_rate numeric(6,4),
  employer_rate numeric(6,4),
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.social_security_branch_registration (
  id integer NOT NULL DEFAULT nextval('payroll_config.social_security_branch_registration_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  social_security_branch_number character varying(25) NOT NULL,
  employer_account_number character varying(255) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  address jsonb,
  branch_registration_code character varying(25),
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.social_security_eligibility_rule (
  id bigint NOT NULL DEFAULT nextval('payroll_config.social_security_eligibility_rule_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  employee_group_code character varying(25) NOT NULL,
  employee_subgroup_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  is_eligible boolean NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.sso_branch_groups (
  id integer NOT NULL DEFAULT nextval('payroll_config.sso_branch_groups_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  social_security_branch_number character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_branch (
  company_code character varying(25) NOT NULL,
  tax_branch_code character varying(25) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_branch_mapping (
  tax_branch_mapping_id integer NOT NULL DEFAULT nextval('payroll_config.tax_branch_mapping_tax_branch_mapping_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  branch_code character varying(25) NOT NULL,
  tax_branch_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_branch_registration (
  tax_registration_id integer NOT NULL DEFAULT nextval('payroll_config.tax_branch_registration_tax_registration_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  tax_branch_code character varying(25) NOT NULL,
  tax_branch_name character varying(255) NOT NULL,
  tax_account_number character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  address jsonb NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_control_group (
  tax_control_group_id integer NOT NULL DEFAULT nextval('payroll_config.tax_control_group_tax_control_group_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_control_group_code character varying(25) NOT NULL,
  tax_control_group_name character varying(255) NOT NULL,
  max_amount numeric(15,2),
  tax_limit_method_code character varying(1),
  limit_percent numeric(6,4),
  tax_limit_base_code character varying(5),
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_deduction_group (
  tax_deduction_group_id integer NOT NULL DEFAULT nextval('payroll_config.tax_deduction_group_tax_deduction_group_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_deduction_group_code character varying(25) NOT NULL,
  tax_deduction_group_name character varying(255) NOT NULL,
  sequence_number integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_deduction_master (
  tax_deduction_master_id integer NOT NULL DEFAULT nextval('payroll_config.tax_deduction_master_tax_deduction_master_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_year integer NOT NULL,
  tax_deduction_code character varying(25) NOT NULL,
  tax_deduction_name jsonb NOT NULL,
  tax_deduction_group_code character varying(25) NOT NULL,
  tax_deduction_subgroup_code character varying(25) NOT NULL,
  max_amount numeric(15,2),
  tax_limit_method_code character varying(1) NOT NULL,
  limit_percent numeric(6,4),
  tax_limit_base_code character varying(5),
  tax_control_group_code character varying(25),
  is_per_person boolean NOT NULL DEFAULT false,
  deduction_multiplier numeric(6,2) NOT NULL DEFAULT 1,
  sequence_number integer NOT NULL,
  remark character varying(500),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_deduction_subgroup (
  tax_deduction_subgroup_id integer NOT NULL DEFAULT nextval('payroll_config.tax_deduction_subgroup_tax_deduction_subgroup_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_deduction_group_code character varying(25) NOT NULL,
  tax_deduction_subgroup_code character varying(25) NOT NULL,
  tax_deduction_subgroup_name character varying(255) NOT NULL,
  sequence_number integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_expense (
  id integer NOT NULL DEFAULT nextval('payroll_config.tax_expense_id_seq'::regclass),
  tax_rate_master_id integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  expense_percent numeric(5,2) NOT NULL,
  expense_max_amount numeric(15,2) NOT NULL,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_grs_types (
  tax_grs_code character varying(2) NOT NULL,
  tax_grs_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_config.tax_limit_base (
  tax_limit_base_code character varying(5) NOT NULL,
  country_code character varying(5) NOT NULL,
  tax_limit_base_name character varying(255) NOT NULL
);

CREATE TABLE payroll_config.tax_limit_method (
  tax_limit_method_code character varying(1) NOT NULL,
  country_code character varying(5) NOT NULL,
  tax_limit_method_name character varying(100) NOT NULL
);

CREATE TABLE payroll_config.tax_rate_master (
  tax_rate_master_id integer NOT NULL DEFAULT nextval('payroll_config.tax_rate_master_tax_rate_master_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  tax_rate_tiers jsonb NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.tax_type (
  tax_type_id integer NOT NULL DEFAULT nextval('payroll_config.tax_type_tax_type_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  tax_type_code character varying(10) NOT NULL,
  tax_type_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type (
  wage_type_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_wage_type_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  wage_type_name jsonb NOT NULL,
  wage_type_group_code character varying(10) NOT NULL,
  wage_type_subgroup_code character varying(10) NOT NULL,
  wage_type_category_code character varying(10) NOT NULL,
  wage_type_frequency_code character varying(5) NOT NULL,
  round_method_code character varying(5) NOT NULL,
  tax_type_code character varying(10),
  is_taxable boolean NOT NULL DEFAULT false,
  is_gross_up_tax boolean NOT NULL DEFAULT false,
  tax_grs_code character varying(2),
  is_social_security_basis boolean NOT NULL DEFAULT false,
  is_prorate boolean NOT NULL DEFAULT false,
  is_retroactive boolean NOT NULL DEFAULT false,
  status character varying(1) NOT NULL DEFAULT 'D'::character varying,
  multiplier numeric(10,4),
  deduction_priority_group character varying(5),
  deduction_priority_sequence integer,
  source_pay_code character varying(10),
  pay_flag character varying(10),
  pvf_flag boolean NOT NULL DEFAULT false,
  ewf_flag boolean NOT NULL DEFAULT false,
  ejip_flag boolean NOT NULL DEFAULT false,
  phil_flag boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255),
  show_payslip boolean NOT NULL DEFAULT false,
  payslip_code character varying(5)
);

CREATE TABLE payroll_config.wage_type_category (
  wage_type_category_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_category_wage_type_category_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_category_code character varying(10) NOT NULL,
  wage_type_category_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type_frequency (
  wage_type_frequency_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_frequency_wage_type_frequency_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_frequency_code character varying(5) NOT NULL,
  wage_type_frequency_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type_fund_assignment (
  fund_assignment_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_fund_assignment_fund_assignment_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type_gl_mapping (
  id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_gl_mapping_id_seq'::regclass),
  wage_type character varying NOT NULL,
  description character varying NOT NULL,
  category character varying NOT NULL,
  dr_account character varying NOT NULL,
  dr_description character varying NOT NULL,
  dr_symbolic character varying NOT NULL,
  cr_account character varying NOT NULL,
  cr_description character varying NOT NULL,
  cr_symbolic character varying NOT NULL,
  cost_center character varying,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by integer,
  created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  wage_type_id integer
);

CREATE TABLE payroll_config.wage_type_group (
  wage_type_group_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_group_wage_type_group_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_group_code character varying(10) NOT NULL,
  wage_type_group_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type_pay_period (
  wage_type_pay_period_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_pay_period_wage_type_pay_period_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  period_type_code character varying(50) NOT NULL,
  wage_type_group_code character varying(10) NOT NULL,
  wage_type_frequency_code character varying(5) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_config.wage_type_payslip_mapping (
  id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_payslip_mapping_id_seq'::regclass),
  payslip_code character varying(5) NOT NULL,
  payslip_text character varying(255) NOT NULL
);

CREATE TABLE payroll_config.wage_type_subgroup (
  wage_type_subgroup_id integer NOT NULL DEFAULT nextval('payroll_config.wage_type_subgroup_wage_type_subgroup_id_seq'::regclass),
  country_code character varying(5) NOT NULL,
  wage_type_subgroup_code character varying(10) NOT NULL,
  wage_type_subgroup_name character varying(100) NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp without time zone,
  updated_by character varying(255)
);

CREATE TABLE payroll_entry.employee_additional_payments (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  wage_type text NOT NULL,
  wage_type_text text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'THB'::text,
  payment_period date NOT NULL,
  entry_date date NOT NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  qty numeric,
  company_code character varying(25) NOT NULL,
  payment_flag character varying(1) NOT NULL DEFAULT 'N'::character varying,
  remark character varying(255)
);

CREATE TABLE payroll_entry.employee_basic_pay (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  wage_type text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'THB'::text,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL,
  pay_frequency_code character varying(5)
);

CREATE TABLE payroll_entry.employee_recurring_entries (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  wage_type text NOT NULL,
  wage_type_text text NOT NULL,
  entry_type text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'THB'::text,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  company_code character varying(25) NOT NULL,
  pay_frequency_code character varying(5),
  remark character varying(255)
);

CREATE TABLE payroll_maintain.bank_profile (
  id integer NOT NULL,
  country_code character varying(2) NOT NULL,
  bank_code character varying(10) NOT NULL,
  bank_name jsonb NOT NULL,
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_address (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL,
  address jsonb NOT NULL,
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_bank_payment (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL,
  payment_method_code character varying(1),
  pay_type character varying(100),
  bank_country_code character varying(2),
  bank_code character varying(10),
  account_number character varying(15),
  account_name character varying(100),
  currency character varying(3),
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_cost_distribution (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL,
  items jsonb NOT NULL,
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_fund_data (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  country_code character varying(5) NOT NULL,
  fund_type_code character varying(10) NOT NULL,
  fund_profile_code character varying(25),
  fund_plan_code character varying(25),
  fund_number character varying(20),
  fund_apply_date date NOT NULL,
  fund_status character varying(1) NOT NULL,
  fund_close_date date,
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_fund_rate (
  id integer NOT NULL,
  employee_code character varying(25) NOT NULL,
  employee_fund_id integer NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  employee_contribute_type character varying(1) NOT NULL,
  employee_contribute_rate numeric(5,2),
  employee_contribute_amount numeric(15,2),
  employer_contribute_type character varying(1) NOT NULL,
  employer_contribute_rate numeric(5,2),
  employer_contribute_amount numeric(15,2),
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_job_history (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  is_primary boolean NOT NULL DEFAULT true,
  department_code character varying(10),
  department_name jsonb,
  branch_code character varying(25),
  division_code character varying(10),
  division_name jsonb,
  position_code character varying(10),
  position_name jsonb,
  cost_center character varying(20),
  employee_group_code character varying(25),
  employee_subgroup_code character varying(25),
  daily_work_hour numeric(5,2),
  payroll_area_code character varying(10),
  employee_status character varying(10) NOT NULL,
  event_code character varying(40),
  event_name jsonb,
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by character varying(255) NOT NULL DEFAULT 'system'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by character varying(255),
  work_location_code character varying(20),
  work_location_name jsonb,
  work_location_description jsonb,
  partner_university_code character varying(10)
);

CREATE TABLE payroll_maintain.employee_loan_data (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  loan_type_id integer NOT NULL,
  loan_contract_no character varying(50),
  loan_reason character varying(500),
  wage_type_code character varying(25),
  loan_start_date date NOT NULL,
  loan_amount numeric(15,2) NOT NULL,
  loan_balance numeric(15,2) NOT NULL,
  installment_amount numeric(15,2) NOT NULL,
  installment_count integer NOT NULL,
  first_deduct_date date NOT NULL,
  last_deduct_date date NOT NULL,
  loan_branch_code character varying(25),
  loan_cost_center character varying(20),
  loan_status character varying(1) NOT NULL,
  close_date date,
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_loan_payment (
  id integer NOT NULL,
  employee_loan_id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  pay_date date NOT NULL,
  period_key character varying(7),
  payment_amount numeric(15,2) NOT NULL,
  payment_type_code character varying(4),
  is_auto boolean NOT NULL DEFAULT false,
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_payroll_status (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  employee_status character varying(1) NOT NULL,
  payroll_inactive_date date,
  retro_active_date date,
  is_payroll_run boolean NOT NULL,
  is_payment boolean NOT NULL,
  remark character varying(500),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_profile (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  prefix_name jsonb,
  first_name jsonb NOT NULL,
  last_name jsonb NOT NULL,
  middle_name jsonb,
  date_of_birth date,
  nationality character varying(100),
  gender character varying(5),
  tax_number character varying(25),
  is_foreigner boolean NOT NULL DEFAULT false,
  hire_date date NOT NULL,
  terminate_date date,
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by character varying(255) NOT NULL DEFAULT 'system'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_social_security_rate (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  social_security_number character varying(20),
  social_security_employee_rate numeric(5,2) NOT NULL,
  social_security_employer_rate numeric(5,2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.employee_tax_deduction (
  id integer NOT NULL,
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  spouse_status_code character varying(1),
  is_claiming_spouse_allowance boolean,
  is_disabled boolean,
  is_father_allowance boolean,
  is_mother_allowance boolean,
  is_spouse_father_allowance boolean,
  is_spouse_mother_allowance boolean,
  father_health_ins_amount numeric(15,2),
  mother_health_ins_amount numeric(15,2),
  spouse_father_health_ins_amount numeric(15,2),
  spouse_mother_health_ins_amount numeric(15,2),
  no_child_before_2018 integer,
  no_child_after_2018 integer,
  disabled_depend_count integer,
  life_ins_amount numeric(15,2),
  health_ins_amount numeric(15,2),
  spouse_life_ins_amount numeric(15,2),
  annuity_ins_amount numeric(15,2),
  rmf_amount numeric(15,2),
  thai_esg_amount numeric(15,2),
  mortgage_interest_amount numeric(15,2),
  education_donation_amount numeric(15,2),
  sports_donation_amount numeric(15,2),
  other_donation_amount numeric(15,2),
  source_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.loan_type (
  id integer NOT NULL,
  loan_type_code character varying(25) NOT NULL,
  loan_type_name jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_maintain.payment_method (
  payment_method_code character varying(1) NOT NULL,
  payment_method_name character varying(100) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL DEFAULT 'SYSTEM'::character varying,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE payroll_permissions.permission_roles (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.permission_roles_id_seq'::regclass),
  name character varying NOT NULL,
  description character varying,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_permissions.permissions (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.permissions_id_seq'::regclass),
  permission_role_id integer NOT NULL,
  module character varying NOT NULL,
  resource character varying NOT NULL,
  can_view boolean NOT NULL DEFAULT true,
  can_create boolean NOT NULL DEFAULT false,
  can_update boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  can_delete boolean NOT NULL DEFAULT false
);

CREATE TABLE payroll_permissions.role_assignments (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.role_assignments_id_seq'::regclass),
  granted_to_user_grant_group_id integer NOT NULL,
  permission_role_id integer NOT NULL,
  target_group_id integer NOT NULL,
  expires_at timestamp without time zone,
  is_active boolean NOT NULL DEFAULT true,
  assigned_by integer,
  assigned_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_permissions.target_group_payroll_areas (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.target_group_payroll_areas_id_seq'::regclass),
  target_group_id integer NOT NULL,
  payroll_area_code character varying(10) NOT NULL
);

CREATE TABLE payroll_permissions.target_groups (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.target_groups_id_seq'::regclass),
  name character varying NOT NULL,
  description character varying,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_permissions.user_grant_group_members (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.user_grant_group_members_id_seq'::regclass),
  user_grant_group_id integer NOT NULL,
  user_id integer NOT NULL,
  added_by integer,
  added_at timestamp without time zone
);

CREATE TABLE payroll_permissions.user_grant_groups (
  id integer NOT NULL DEFAULT nextval('payroll_permissions.user_grant_groups_id_seq'::regclass),
  name character varying NOT NULL,
  description character varying,
  created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_report.bis50_batch_failures (
  id bigint NOT NULL DEFAULT nextval('payroll_report.bis50_batch_failures_id_seq'::regclass),
  batch_id character varying(50) NOT NULL,
  employee_code character varying(50) NOT NULL,
  locale character varying(2) NOT NULL,
  error text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_report.bis50_batch_runs (
  id bigint NOT NULL DEFAULT nextval('payroll_report.bis50_batch_runs_id_seq'::regclass),
  batch_id character varying(50) NOT NULL,
  tax_year integer NOT NULL,
  locales jsonb NOT NULL,
  payroll_areas jsonb,
  total integer NOT NULL,
  state character varying(20) NOT NULL DEFAULT 'RUNNING'::character varying,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_report.bis50_documents (
  id bigint NOT NULL DEFAULT nextval('payroll_report.bis50_documents_id_seq'::regclass),
  employee_code character varying(50) NOT NULL,
  national_id character varying(20) NOT NULL,
  payroll_area character varying(255) NOT NULL,
  tax_year integer NOT NULL,
  locale character varying(2) NOT NULL,
  format character varying(10) NOT NULL DEFAULT 'pdf'::character varying,
  storage_key character varying(255),
  status character varying(20) NOT NULL DEFAULT 'ready'::character varying,
  superseded_at timestamp with time zone,
  generated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  batch_id character varying(50),
  company_code character varying(25)
);

CREATE TABLE payroll_report.payslip_batch_failures (
  id bigint NOT NULL DEFAULT nextval('payroll_report.payslip_batch_failures_id_seq'::regclass),
  batch_run_id character varying(50) NOT NULL,
  employee_code character varying(50) NOT NULL,
  error text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll_report.payslip_batch_runs (
  id bigint NOT NULL DEFAULT nextval('payroll_report.payslip_batch_runs_id_seq'::regclass),
  batch_run_id character varying(50) NOT NULL,
  payroll_area character varying(255) NOT NULL,
  period character varying(10) NOT NULL,
  total integer NOT NULL,
  state character varying(20) NOT NULL DEFAULT 'RUNNING'::character varying,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  employee_codes jsonb
);

CREATE TABLE payroll_report.payslip_documents (
  id bigint NOT NULL DEFAULT nextval('payroll_report.payslip_documents_id_seq'::regclass),
  employee_code character varying(50) NOT NULL,
  period character varying(10) NOT NULL,
  batch_run_id character varying(50) NOT NULL,
  storage_key character varying(255),
  status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  superseded_at timestamp with time zone,
  generated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  company_code character varying(25) NOT NULL DEFAULT ''::character varying,
  file_name character varying(255)
);

CREATE TABLE public."SequelizeData_benefit_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_benefit_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_employee_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_payroll" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_payroll_report" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_time_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE public."SequelizeMeta_workflow_service" (
  name character varying(255) NOT NULL
);

CREATE TABLE public.benefit_history_logs (
  id uuid NOT NULL,
  entity_name character varying(100) NOT NULL,
  entity_id character varying(255) NOT NULL,
  action character varying(50) NOT NULL,
  field_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_by character varying(50) NOT NULL,
  applied_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE time_management."SequelizeMeta_time_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE time_management.allowance (
  allowance_id bigint NOT NULL DEFAULT nextval('time_management.allowance_allowance_id_seq'::regclass),
  allowance_code character varying(25) NOT NULL,
  allowance_name character varying(200) NOT NULL,
  py_wage_type character varying(25) NOT NULL,
  business_group_id integer,
  business_unit_id integer,
  employee_group_id integer,
  employee_subgroup_id integer,
  personal_grade_from integer,
  personal_grade_to integer,
  eligibility_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  workday_min_hour numeric(8,2),
  day_off_min_hour numeric(8,2),
  max_late_hour numeric(8,2),
  max_late_count integer,
  max_not_work_hour numeric(8,2),
  max_not_work_count integer,
  leave_annual_max numeric(8,2),
  leave_annual_deduct numeric(8,2),
  leave_other_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  leave_other_max numeric(8,2),
  leave_other_deduct numeric(8,2),
  work_month_min_day integer,
  evaluated_frequency character varying(25) NOT NULL DEFAULT 'DAILY'::character varying,
  is_send_to_payroll boolean NOT NULL DEFAULT false,
  rate_amount numeric(12,2),
  is_shift_allowance boolean NOT NULL DEFAULT false,
  is_paid_for_time_correction boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.allowance_result (
  allowance_result_id bigint NOT NULL DEFAULT nextval('time_management.allowance_result_allowance_result_id_seq'::regclass),
  timesheet_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  work_date date NOT NULL,
  allowance_code character varying(50) NOT NULL,
  py_wage_type character varying(25) NOT NULL,
  rate_amount numeric(12,2),
  payroll_paid_flag character varying(25),
  is_locked boolean NOT NULL DEFAULT false,
  payroll_export_batch_id character varying(100),
  payroll_exported_at timestamp with time zone,
  calculation_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.annual_leave_quota_mapping (
  id bigint NOT NULL DEFAULT nextval('time_management.annual_leave_quota_mapping_id_seq'::regclass),
  leave_code character varying(25) NOT NULL DEFAULT 'ANNUAL_LEAVE'::character varying,
  personal_grade_from_number integer NOT NULL,
  personal_grade_to_number integer NOT NULL,
  hire_start_date_from date,
  hire_start_date_before date,
  year_of_service integer NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date NOT NULL DEFAULT '1900-01-01'::date,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  leave_quota numeric(5,1),
  business_group_code character varying(50),
  business_unit_code character varying(50),
  personal_grade_from character varying(25),
  personal_grade_to character varying(25),
  personal_grade_from_code character varying(25),
  personal_grade_to_code character varying(25),
  employee_group_code character varying(50),
  employee_subgroup_code character varying(50),
  contract_type_code character varying(50),
  year_of_service_unit character varying(10)
);

CREATE TABLE time_management.approval_step (
  id bigint NOT NULL DEFAULT nextval('time_management.approval_step_id_seq'::regclass),
  task_type character varying(30) NOT NULL,
  source_id bigint NOT NULL,
  sequence smallint NOT NULL,
  role character varying(30) NOT NULL,
  approver_id character varying(20) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE time_management.employee_time_info (
  id bigint NOT NULL DEFAULT nextval('time_management.employee_time_info_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL,
  event_type character varying(50) NOT NULL,
  employee_status character varying(50) NOT NULL,
  first_name character varying(100),
  middle_name character varying(100),
  last_name character varying(100),
  date_of_birth date,
  gender_code character varying(25),
  marital_status_code character varying(25),
  is_primary_flag boolean NOT NULL,
  contract_type character varying(50),
  hire_date date,
  seniority_date date,
  resign_date date,
  pass_probation_date date,
  pass_probation_flag boolean,
  group_code character varying(50),
  country_code character varying(50),
  business_group_code character varying(50),
  company_code character varying(50),
  business_unit_code character varying(50),
  division_code character varying(50),
  department_code character varying(50),
  position_code character varying(50),
  branch_code character varying(50),
  employee_group_code character varying(50),
  employee_group_number integer,
  employee_subgroup_code character varying(50),
  employee_subgroup_number integer,
  personal_grade_code character varying(50),
  store_type_code character varying(50),
  store_format_code character varying(50),
  year_of_service integer,
  year_of_service_for_annual_leave integer,
  year_of_service_day integer,
  year_of_service_hour integer,
  mobile_clock_eligible_id integer,
  is_mobile_clock_eligible boolean,
  holiday_calendar_id integer NOT NULL,
  holiday_calendar_code character varying(50),
  work_schedule_id integer NOT NULL,
  work_schedule_code character varying(50),
  working_hour_per_day integer NOT NULL,
  working_hour_per_week integer NOT NULL,
  working_day_per_week integer NOT NULL,
  break_hour_per_day integer NOT NULL,
  work_schedule_template_id integer NOT NULL,
  time_status_id integer NOT NULL,
  time_status_code character varying(50),
  time_status_flex_shift_start time without time zone,
  time_status_flex_shift_end time without time zone,
  is_time_status_exemp boolean,
  time_attendance_policy_id integer NOT NULL,
  tolerance_minute integer,
  late_threshold_minute integer,
  late_stat_begin_minute integer,
  late_deduct_begin_minute integer,
  not_work_threshold_minute integer,
  not_work_stat_begin_minute integer,
  not_work_deduct_begin_minute integer,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  ot_flag boolean
);

CREATE TABLE time_management.employment_information (
  id bigint NOT NULL DEFAULT nextval('time_management.employment_information_id_seq'::regclass),
  person_id character varying(15) NOT NULL,
  user_id character varying(20) NOT NULL,
  is_primary boolean NOT NULL,
  effective_start_date date,
  original_start_date date,
  seniority_date date,
  pass_probation_date_confirm_date date,
  retirement_date date,
  effective_end_date date DEFAULT '9999-12-31'::date,
  last_date_worked date,
  pf_service_date date,
  cg_previous_employee_id character varying(255),
  year_of_service character varying(255),
  employee_age_ymd character varying(255),
  dvt_previous_id character varying(255),
  current_business_unit_effective_date date,
  current_job_effective_date date,
  current_position_effective_date date,
  current_jg_effective_date date,
  current_pg_effective_date date,
  current_corporate_title_effective_date date,
  current_store_branch_effective_date date,
  current_years_in_business_unit character varying(255),
  current_years_in_store_branch character varying(255),
  current_years_in_job character varying(255),
  current_years_in_position character varying(255),
  current_years_in_jg character varying(255),
  current_years_in_pg character varying(255),
  current_years_in_corporate_title character varying(255),
  hiring_not_completed boolean,
  additional_information_termination character varying(255),
  is_special_probation boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.employment_job (
  emp_job_id bigint NOT NULL DEFAULT nextval('time_management.employment_job_emp_job_id_seq'::regclass),
  user_id character varying(20) NOT NULL,
  effective_start_date date NOT NULL,
  seq_number integer NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  event_id integer NOT NULL,
  event_reason_id integer NOT NULL,
  is_primary boolean NOT NULL,
  is_concurrent_employment boolean,
  employee_status character varying(32),
  group_id integer NOT NULL,
  country_id integer NOT NULL,
  business_group_id integer NOT NULL,
  business_unit_id integer NOT NULL,
  company_id integer NOT NULL,
  division_id integer NOT NULL,
  department_id integer NOT NULL,
  position_id integer NOT NULL,
  cost_center_id integer NOT NULL,
  location_id integer,
  work_location_id integer,
  sso_location_id integer,
  zone_id integer,
  pay_grade_id integer,
  job_grade_id integer,
  corporate_title_id integer,
  job_type_id integer,
  job_family_id integer,
  job_code_id integer,
  job_title_id character varying(255),
  employee_group_id integer,
  employee_subgroup_id integer,
  store_size_id integer,
  store_format_id integer,
  band_id integer,
  brand_id integer,
  pay_scale_area_id integer,
  pay_scale_group_id integer,
  pay_scale_level_id integer,
  pay_scale_type_id integer,
  hr_district_id integer,
  manager_id character varying(20),
  contract_type character varying(255),
  is_fulltime_employee boolean,
  fte double precision,
  contract_end_date date,
  policy_profile character varying(20),
  typeof_group_family_employee character varying(255),
  pass_probation character varying(255),
  extened_probation_date date,
  probation_period_end_date date,
  extened_retirement_date date,
  override_current_business_unit_effective_date date,
  override_current_position_effective_date date,
  override_current_job_effective_date date,
  override_current_corporate_title_effective_date date,
  override_current_jg_effective_date date,
  override_current_pg_effective_date date,
  override_current_store_branch_effective_date date,
  working_hour_id integer,
  time_status_id integer,
  holiday_calendar_id integer,
  work_schedule_id integer,
  leave_quota double precision,
  override_standard_weekly_hours character varying(255),
  typeof_management_program character varying(255),
  dvt_bonding_enddate date,
  dvt_graduation_date date,
  dvt_project character varying(255),
  dvt_partner_university character varying(255),
  dvt_type character varying(80),
  dvt_degree character varying(80),
  dvt_course_of_time character varying(80),
  dvt_academic_year character varying(80),
  dvt_course character varying(255),
  is_scholarship character varying(255),
  terminate_voluntary_involuntary character varying(255),
  reason_for_termination character varying(255),
  additional_information_termination character varying(255),
  ok_to_rehire character varying(255),
  vn_title character varying(255),
  legacy_job_grade character varying(255),
  sales_admin_mall character varying(255),
  social_insurance character varying(255),
  health_insurance character varying(255),
  unemployment_insurance character varying(255),
  occupational_accident_insurance character varying(255),
  social_insurance_outsidethe_company character varying(255),
  insurance_area character varying(255),
  special_benefit_group character varying(255),
  union_fee character varying(255),
  transfer_from character varying(255),
  transfer_out_to character varying(255),
  band_matching character varying(2),
  point_of_sales character varying(255),
  effective_latest_change boolean,
  attachment character varying(4000),
  attachment_file_name character varying(255),
  attachment_file_size numeric,
  attachment_file_type character varying(5),
  attachment_id character varying(255),
  attachment_mime_type character varying(255),
  attachment_status numeric,
  timezone character varying(128),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.employment_job_relationships (
  id bigint NOT NULL DEFAULT nextval('time_management.employment_job_relationships_id_seq'::regclass),
  user_id character varying(20) NOT NULL,
  related_user_id character varying(20) NOT NULL,
  relationship_type character varying(100) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.holiday_calendar (
  holiday_calendar_id integer NOT NULL DEFAULT nextval('time_management.holiday_calendar_holiday_calendar_id_seq'::regclass),
  holiday_calendar_code character varying(25) NOT NULL,
  holiday_calendar_name character varying(100) NOT NULL,
  country_code character(3) NOT NULL DEFAULT 'THA'::bpchar,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.holiday_calendar_date (
  calendar_date_id integer NOT NULL DEFAULT nextval('time_management.holiday_calendar_date_calendar_date_id_seq'::regclass),
  holiday_calendar_id integer NOT NULL,
  holiday_date date NOT NULL,
  holiday_name jsonb NOT NULL,
  holiday_type character varying(20) NOT NULL DEFAULT 'PUBLIC'::character varying,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  deleted_at timestamp with time zone,
  is_enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE time_management.leave_balance_carry_forward (
  leave_balance_carry_forward_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_carry_forward_leave_balance_carry_forward_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_quota numeric(7,2) NOT NULL DEFAULT 0,
  leave_adjustment numeric(7,2) DEFAULT 0,
  leave_usages numeric(7,2) DEFAULT 0,
  leave_pending numeric(7,2) DEFAULT 0,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  leave_year integer NOT NULL,
  expire_date date NOT NULL,
  leave_available numeric(7,2) DEFAULT (((leave_quota + COALESCE(leave_adjustment, (0)::numeric)) - COALESCE(leave_usages, (0)::numeric)) - COALESCE(leave_pending, (0)::numeric))
);

CREATE TABLE time_management.leave_balance_carry_forward_transaction (
  leave_balance_carry_forward_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_carry_forward_t_leave_balance_carry_forward_t_seq'::regclass),
  leave_balance_carry_forward_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  transaction_id bigint,
  transaction_status character varying(50) NOT NULL,
  transaction_date date NOT NULL,
  transaction_type character varying(100) NOT NULL,
  transaction_datasource character varying(100) NOT NULL,
  remark text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.leave_balance_event (
  leave_balance_event_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_event_leave_balance_event_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_quota numeric(7,2) NOT NULL DEFAULT 0,
  leave_adjustment numeric(7,2) DEFAULT 0,
  leave_usages numeric(7,2) DEFAULT 0,
  leave_pending numeric(7,2) DEFAULT 0,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  leave_event_type_id bigint,
  leave_event_code character varying(100),
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date,
  effective_end_date date,
  leave_available numeric(7,2) DEFAULT (((leave_quota + COALESCE(leave_adjustment, (0)::numeric)) - COALESCE(leave_usages, (0)::numeric)) - COALESCE(leave_pending, (0)::numeric))
);

CREATE TABLE time_management.leave_balance_event_transaction (
  leave_balance_event_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_event_transacti_leave_balance_event_transacti_seq'::regclass),
  leave_balance_event_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  transaction_id bigint,
  transaction_status character varying(50) NOT NULL,
  transaction_date date NOT NULL,
  transaction_type character varying(100) NOT NULL,
  transaction_datasource character varying(100) NOT NULL,
  remark text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.leave_balance_onetime (
  leave_balance_onetime_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_onetime_leave_balance_onetime_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_quota numeric(7,2) NOT NULL DEFAULT 0,
  leave_adjustment numeric(7,2) DEFAULT 0,
  leave_usages numeric(7,2) DEFAULT 0,
  leave_pending numeric(7,2) DEFAULT 0,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date,
  effective_end_date date,
  leave_available numeric(7,2) DEFAULT (((leave_quota + COALESCE(leave_adjustment, (0)::numeric)) - COALESCE(leave_usages, (0)::numeric)) - COALESCE(leave_pending, (0)::numeric))
);

CREATE TABLE time_management.leave_balance_onetime_transaction (
  leave_balance_onetime_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_onetime_transac_leave_balance_onetime_transac_seq'::regclass),
  leave_balance_onetime_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  transaction_id bigint,
  transaction_status character varying(50) NOT NULL,
  transaction_date date NOT NULL,
  transaction_type character varying(100) NOT NULL,
  transaction_datasource character varying(100) NOT NULL,
  remark text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.leave_balance_seed_staging (
  leave_balance_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_seed_staging_leave_balance_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(20) NOT NULL,
  leave_name character varying(255) NOT NULL,
  leave_cycle character varying(25) NOT NULL,
  balance_type character varying(25) NOT NULL DEFAULT 'YEARLY'::character varying,
  balance_year integer,
  is_current boolean NOT NULL DEFAULT true,
  leave_initial_balance numeric(7,2),
  leave_override numeric(7,2),
  leave_usages numeric(7,2),
  leave_pending numeric(7,2),
  leave_available numeric(7,2),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  source_cycle character varying(25),
  source_balance_id bigint,
  leave_event_type_id bigint,
  leave_event_code character varying(100),
  expire_date date
);

CREATE TABLE time_management.leave_balance_transaction (
  leave_balance_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_transaction_leave_balance_transaction_id_seq'::regclass),
  leave_balance_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  pay_code character varying(50),
  leave_code character varying(20) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  is_leave_carry boolean NOT NULL DEFAULT false,
  leave_carry_from date,
  leave_carry_to date,
  transaction_id integer,
  transaction_date date NOT NULL,
  transaction_type character varying(100),
  transaction_datasource character varying(100),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  reason character varying(255),
  leave_request_id bigint
);

CREATE TABLE time_management.leave_balance_yearly (
  leave_balance_yearly_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_yearly_leave_balance_yearly_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_quota numeric(7,2) NOT NULL DEFAULT 0,
  leave_adjustment numeric(7,2) DEFAULT 0,
  leave_usages numeric(7,2) DEFAULT 0,
  leave_pending numeric(7,2) DEFAULT 0,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  leave_year integer NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date,
  effective_end_date date,
  leave_available numeric(7,2) DEFAULT (((leave_quota + COALESCE(leave_adjustment, (0)::numeric)) - COALESCE(leave_usages, (0)::numeric)) - COALESCE(leave_pending, (0)::numeric))
);

CREATE TABLE time_management.leave_balance_yearly_transaction (
  leave_balance_yearly_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_balance_yearly_transact_leave_balance_yearly_transact_seq'::regclass),
  leave_balance_yearly_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  transaction_id bigint,
  transaction_status character varying(50) NOT NULL,
  transaction_date date NOT NULL,
  transaction_type character varying(100) NOT NULL,
  transaction_datasource character varying(100) NOT NULL,
  remark text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.leave_eligibility_rule (
  id bigint NOT NULL DEFAULT nextval('time_management.leave_eligibility_rule_id_seq'::regclass),
  leave_code character varying(10) NOT NULL,
  personal_grade_from_number integer,
  personal_grade_to_number integer,
  contract_type_code character varying(25),
  marital_status_code character varying(25),
  gender_code character varying(25),
  year_of_service integer,
  year_of_service_unit character varying(25),
  is_new_hire boolean NOT NULL DEFAULT false,
  is_pass_probation boolean NOT NULL DEFAULT false,
  leave_prorate_year character varying(25),
  leave_quota numeric(5,1),
  is_annual_leave boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date NOT NULL DEFAULT '1900-01-01'::date,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  holiday_calendar_code character varying(25),
  hire_before_month_day character varying(10),
  business_group_code character varying(50),
  business_unit_code character varying(50),
  employee_group_code character varying(50),
  employee_subgroup_code character varying(50),
  personal_grade_from character varying(25),
  personal_grade_to character varying(25),
  personal_grade_from_code character varying(25),
  personal_grade_to_code character varying(25)
);

CREATE TABLE time_management.leave_event_balance (
  leave_event_balance_id bigint NOT NULL DEFAULT nextval('time_management.leave_event_balance_leave_event_balance_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(20) NOT NULL,
  leave_name character varying(255) NOT NULL,
  leave_event_type_id bigint,
  leave_event_code character varying(100),
  leave_cycle character varying(25) NOT NULL DEFAULT 'PER_EVENT'::character varying,
  leave_initial_balance numeric(7,2),
  leave_override numeric(7,2),
  leave_usages numeric(7,2),
  leave_pending numeric(7,2),
  leave_available numeric(7,2),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.leave_event_balance_transaction (
  leave_event_balance_transaction_id bigint NOT NULL DEFAULT nextval('time_management.leave_event_balance_transacti_leave_event_balance_transacti_seq'::regclass),
  leave_event_balance_id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  pay_code character varying(50),
  leave_code character varying(20) NOT NULL,
  leave_credit numeric(7,2),
  leave_debit numeric(7,2),
  leave_balance numeric(7,2),
  transaction_id integer,
  transaction_date date NOT NULL,
  transaction_type character varying(100),
  transaction_datasource character varying(100),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  reason character varying(255),
  leave_request_id bigint
);

CREATE TABLE time_management.leave_event_type (
  id bigint NOT NULL DEFAULT nextval('time_management.leave_event_type_id_seq'::regclass),
  leave_code character varying(50) NOT NULL,
  event_type_code character varying(100) NOT NULL,
  event_type_name jsonb NOT NULL,
  description text,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.leave_request (
  leave_request_id bigint NOT NULL DEFAULT nextval('time_management.leave_request_leave_request_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  leave_code character varying(50) NOT NULL,
  leave_date_from date NOT NULL,
  leave_date_to date NOT NULL,
  leave_time_start character varying(5),
  leave_time_end character varying(5),
  is_full_day_leave boolean NOT NULL DEFAULT false,
  request_number character varying(25),
  request_date date NOT NULL,
  request_reason character varying(255),
  request_status character varying(20),
  is_maternity_leave boolean,
  maternity_child_number integer,
  remark text,
  attach_file_path character varying(255),
  is_amendment_flag boolean,
  amendment_reason character varying(255),
  prev_leave_date_from date,
  prev_leave_date_to date,
  prev_leave_time_start character varying(5),
  prev_leave_time_end character varying(5),
  workflow_id integer,
  approver_id character varying(20),
  approve_date date,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.leave_request_attachments (
  id bigint NOT NULL,
  leave_request_id bigint NOT NULL,
  storage_provider character varying(32) NOT NULL,
  object_key character varying(512) NOT NULL,
  original_filename character varying(255) NOT NULL,
  content_type character varying(127) NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_by character varying(20) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.leave_request_decisions (
  id bigint NOT NULL,
  leave_request_id bigint NOT NULL,
  sequence smallint NOT NULL,
  approver_role character varying(20) NOT NULL,
  approver_id character varying(20) NOT NULL,
  decision character varying(20) NOT NULL,
  remark text,
  decided_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.leave_request_detail (
  leave_request_detail_id bigint NOT NULL DEFAULT nextval('time_management.leave_request_detail_leave_request_detail_id_seq'::regclass),
  leave_request_id bigint NOT NULL,
  leave_date date NOT NULL,
  leave_time_start time without time zone NOT NULL,
  leave_time_end time without time zone NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  day_unit character varying(20)
);

CREATE TABLE time_management.leave_requests (
  id bigint NOT NULL,
  employee_id character varying(20) NOT NULL,
  leave_type_id bigint NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  start_day_unit character varying(20) NOT NULL DEFAULT 'FULL_DAY'::character varying,
  end_day_unit character varying(20) NOT NULL DEFAULT 'FULL_DAY'::character varying,
  total_days numeric(5,2) NOT NULL,
  status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  reason text,
  camunda_process_execution_id character varying(64),
  approved_by character varying(20),
  approved_at timestamp with time zone,
  decision_remark text,
  created_by bigint,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  leave_event_type_id bigint,
  workflow_start_status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  workflow_start_attempts integer NOT NULL DEFAULT 0,
  workflow_start_last_attempt_at timestamp with time zone,
  workflow_start_last_error_code character varying(64),
  pregnancy_sequence integer,
  start_time time without time zone,
  end_time time without time zone,
  cancel_requested_by character varying(50),
  cancel_requested_at timestamp with time zone,
  cancel_reason character varying(500)
);

CREATE TABLE time_management.leave_result (
  id bigint NOT NULL DEFAULT nextval('time_management.leave_result_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  duration numeric(15,2) NOT NULL,
  duration_base60 numeric(15,2) NOT NULL,
  unit_code character varying(10) NOT NULL,
  payroll_period_code character varying(20) NOT NULL,
  is_adjustment boolean NOT NULL DEFAULT false,
  source_payroll_period_code character varying(20),
  leave_date date NOT NULL,
  leave_code character varying(25) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone,
  updated_by character varying(255)
);

CREATE TABLE time_management.leave_types (
  id bigint NOT NULL,
  code character varying(10) NOT NULL,
  name jsonb NOT NULL,
  leave_cycle character varying(20) NOT NULL,
  entitlement_trigger character varying(20) NOT NULL DEFAULT 'NEW_HIRE'::character varying,
  min_service character varying(10),
  requestable_by character varying(10) NOT NULL DEFAULT 'EMPLOYEE'::character varying,
  is_paid boolean NOT NULL DEFAULT true,
  pay_percent numeric(5,2),
  day_count_basis character varying(20) NOT NULL,
  min_per_request_days numeric(3,1) NOT NULL DEFAULT 1,
  max_per_request_days numeric(4,1),
  document_rule character varying(20) NOT NULL DEFAULT 'NONE'::character varying,
  document_min_days numeric(4,1),
  gender character varying(10),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  deleted_at timestamp with time zone,
  document_min_files integer,
  leave_minimum integer,
  leave_minimum_unit character varying(1),
  pay_code character varying(50),
  leave_maximum_unit character varying(10)
);

CREATE TABLE time_management.mobile_clock_eligibility_rule (
  id bigint NOT NULL DEFAULT nextval('time_management.mobile_clock_eligibility_rule_id_seq'::regclass),
  policy_code character varying(50) NOT NULL,
  policy_name character varying(255),
  business_unit_code character varying(50),
  company_code character varying(50),
  branch_code character varying(50),
  division_code character varying(50),
  department_code character varying(50),
  employee_id character varying(50),
  time_status_code character varying(25),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.ot_request (
  id bigint NOT NULL DEFAULT nextval('time_management.ot_request_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  request_number character varying(25),
  request_date date NOT NULL,
  request_reason character varying(255),
  request_status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  workflow_id character varying(64),
  approver_id character varying(20),
  approve_date timestamp with time zone,
  remark text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  pay_code character varying(30),
  work_date date,
  start_time time without time zone,
  end_time time without time zone,
  total_ot_hour numeric(8,2),
  is_amendment_flag boolean NOT NULL DEFAULT false,
  amendment_reason character varying(255),
  prev_work_date date,
  prev_start_time time without time zone,
  prev_end_time time without time zone,
  prev_total_ot_hour numeric(8,2),
  workflow_start_status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  workflow_start_attempts integer NOT NULL DEFAULT 0,
  workflow_start_last_attempt_at timestamp with time zone,
  workflow_start_last_error_code character varying(64),
  prev_details jsonb,
  cancellation_reason character varying(255),
  cancelled_at timestamp with time zone,
  cancelled_by character varying(20),
  approval_period character varying(20) NOT NULL DEFAULT 'CURRENT'::character varying,
  requires_upper_manager boolean NOT NULL DEFAULT false,
  direct_manager_pay_grade integer,
  attachment_count integer NOT NULL DEFAULT 0,
  cancellation_requested_at timestamp with time zone
);

CREATE TABLE time_management.ot_request_attachment (
  id bigint NOT NULL DEFAULT nextval('time_management.ot_request_attachment_id_seq'::regclass),
  overtime_request_id bigint NOT NULL,
  storage_provider character varying(32) NOT NULL,
  object_key character varying(512) NOT NULL,
  original_filename character varying(255) NOT NULL,
  content_type character varying(127) NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_by character varying(20) NOT NULL,
  content bytea,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.ot_request_decision (
  id bigint NOT NULL DEFAULT nextval('time_management.ot_request_decision_id_seq'::regclass),
  overtime_request_id bigint NOT NULL,
  role character varying(30) NOT NULL,
  decision character varying(20) NOT NULL,
  approver_id character varying(20) NOT NULL,
  comment character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.ot_request_detail (
  id bigint NOT NULL DEFAULT nextval('time_management.ot_request_detail_id_seq'::regclass),
  ot_request_id bigint NOT NULL,
  work_date date NOT NULL,
  ot_time_start time without time zone NOT NULL,
  ot_time_end time without time zone NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.pay_code (
  id bigint NOT NULL DEFAULT nextval('time_management.pay_code_id_seq'::regclass),
  pay_type character varying(50) NOT NULL,
  pay_code character varying(50) NOT NULL,
  payroll_code character varying(25),
  description character varying(255),
  is_paid boolean,
  is_timesheet_enabled boolean,
  is_result_enabled boolean,
  is_request_enabled boolean,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.pay_code_wage_type_map (
  id bigint NOT NULL DEFAULT nextval('time_management.pay_code_wage_type_map_id_seq'::regclass),
  pay_type character varying(50) NOT NULL,
  pay_code character varying(50) NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  unit_code character varying(10) NOT NULL DEFAULT 'HOUR'::character varying,
  is_mock boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.shift_allowance_condition (
  shift_allowance_condition_id bigint NOT NULL DEFAULT nextval('time_management.shift_allowance_condition_shift_allowance_condition_id_seq'::regclass),
  allowance_id bigint NOT NULL,
  sequence_number integer NOT NULL,
  branch_code character varying(50),
  store_format_code character varying(50),
  shift_in_range_start time without time zone NOT NULL,
  shift_in_range_end time without time zone NOT NULL,
  shift_out_range_start time without time zone NOT NULL,
  shift_out_range_end time without time zone NOT NULL,
  rate_amount numeric(12,2) NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.time_attendance_policy (
  id bigint NOT NULL DEFAULT nextval('time_management.time_attendance_policy_id_seq'::regclass),
  business_unit_code character varying(50) NOT NULL,
  tolerance_minute integer,
  late_threshold_minute integer,
  late_stat_begin_minute integer,
  late_deduct_begin_minute integer,
  not_work_threshold_minute integer,
  not_work_stat_begin_minute integer,
  not_work_deduct_begin_minute integer,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.time_clock_events (
  employee_id character varying(15) NOT NULL,
  punch_type character varying(20) NOT NULL,
  source_type character varying(20) NOT NULL,
  source_name character varying(64),
  server_received_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  device_captured_at timestamp with time zone,
  was_offline boolean NOT NULL DEFAULT false,
  synced_at timestamp with time zone,
  auth_method character varying(20),
  gps_latitude numeric(9,6),
  gps_longitude numeric(9,6),
  gps_accuracy_m numeric(7,1),
  is_mock_location boolean,
  device_id character varying(128),
  ip_address character varying(45),
  client_app_version character varying(32),
  raw_payload jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  id bigint NOT NULL DEFAULT nextval('time_management.time_clock_events_id_seq'::regclass)
);

CREATE TABLE time_management.time_clock_pair (
  time_clock_pair_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_clock_timesheet_clock_id_seq'::regclass),
  timesheet_detail_id bigint NOT NULL,
  pay_code character varying(40) NOT NULL DEFAULT 'CLOCK'::character varying,
  start_datetime timestamp with time zone,
  end_datetime timestamp with time zone,
  total_hour numeric(5,2),
  source_type character varying(20) NOT NULL DEFAULT 'DEVICE'::character varying,
  device_id character varying(50),
  mobile_latitude numeric(10,7),
  mobile_longitude numeric(10,7),
  mobile_work_location_code character varying(25),
  mobile_is_valid boolean,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.time_correction (
  time_correction_id bigint NOT NULL DEFAULT nextval('time_management.time_correction_time_correction_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  workflow_id character varying(64),
  approver_id character varying(20),
  approve_date timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  approval_period character varying(20),
  requires_upper_manager boolean NOT NULL DEFAULT false,
  workflow_start_status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  workflow_start_attempts integer NOT NULL DEFAULT 0,
  workflow_start_last_attempt_at timestamp with time zone,
  workflow_start_last_error_code character varying(64),
  cancellation_reason character varying(255),
  cancelled_at timestamp with time zone,
  cancelled_by character varying(20),
  request_number character varying(25),
  request_date date,
  request_status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  prev_request_date date,
  remark character varying(255)
);

CREATE TABLE time_management.time_correction_decisions (
  id bigint NOT NULL DEFAULT nextval('time_management.time_correction_decisions_id_seq'::regclass),
  time_correction_id bigint NOT NULL,
  sequence smallint NOT NULL,
  approver_role character varying(20) NOT NULL,
  approver_id character varying(20) NOT NULL,
  decision character varying(20) NOT NULL,
  remark text,
  decided_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.time_correction_detail (
  time_correction_detail_id bigint NOT NULL DEFAULT nextval('time_management.time_correction_detail_time_correction_detail_id_seq'::regclass),
  time_correction_id bigint NOT NULL,
  work_date date NOT NULL,
  work_time_start time without time zone,
  work_time_end time without time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  pay_code character varying(50) NOT NULL,
  work_time_in time without time zone,
  work_time_out time without time zone,
  request_reason character varying(255),
  is_amendment_flag boolean,
  amendment_reason character varying(255),
  prev_work_date date,
  prev_work_schedule_id integer,
  prev_request_reason character varying(255),
  prev_amendment_date date
);

CREATE TABLE time_management.time_result (
  id bigint NOT NULL DEFAULT nextval('time_management.time_result_id_seq'::regclass),
  company_code character varying(25) NOT NULL,
  employee_code character varying(25) NOT NULL,
  wage_type_code character varying(10) NOT NULL,
  duration numeric(15,2) NOT NULL,
  duration_base60 numeric(15,2) NOT NULL,
  unit_code character varying(10) NOT NULL,
  payroll_period_code character varying(20) NOT NULL,
  is_adjustment boolean NOT NULL DEFAULT false,
  source_payroll_period_code character varying(20),
  entry_date date NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255) NOT NULL,
  updated_at timestamp with time zone,
  updated_by character varying(255)
);

CREATE TABLE time_management.time_status_mapping (
  time_status_mapping_id bigint NOT NULL DEFAULT nextval('time_management.time_status_mapping_time_status_mapping_id_seq'::regclass),
  business_unit_code character varying(50),
  employee_group_code character varying(50),
  employee_subgroup_from character varying(50),
  employee_subgroup_from_number integer,
  employee_subgroup_to character varying(50),
  employee_subgroup_to_number integer,
  company_code character varying(50),
  branch_code character varying(50),
  department_code character varying(50),
  position_code character varying(50),
  time_status_code character varying(10) NOT NULL,
  ot_flag boolean NOT NULL DEFAULT false,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.time_status_master (
  time_status_master_id bigint NOT NULL DEFAULT nextval('time_management.time_status_master_time_status_master_id_seq'::regclass),
  time_status_code character varying(10) NOT NULL,
  time_status_name character varying(100) NOT NULL,
  is_attendance_required boolean NOT NULL,
  is_tardy_required boolean NOT NULL,
  is_early_out_required boolean NOT NULL,
  is_absent_in_required boolean NOT NULL,
  is_pay_deduction_required boolean NOT NULL,
  is_flex_time boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  description character varying(500),
  is_late_absent_calculate boolean NOT NULL DEFAULT true
);

CREATE TABLE time_management.timesheet (
  timesheet_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_timesheet_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  time_period_id bigint NOT NULL,
  time_period_code character varying(50),
  payroll_period_code character varying(50) NOT NULL,
  period_start_date date NOT NULL,
  period_end_date date NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  status character varying(20) NOT NULL DEFAULT 'OPEN'::character varying,
  generated_at timestamp with time zone,
  approved_at timestamp with time zone,
  locked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.timesheet_adjustment (
  timesheet_adjustment_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_adjustment_timesheet_adjustment_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  original_payroll_period character varying(20) NOT NULL,
  adjustment_payroll_period character varying(20) NOT NULL,
  remark text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.timesheet_adjustment_detail (
  timesheet_adjustment_detail_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_adjustment_detail_timesheet_adjustment_detail_id_seq'::regclass),
  timesheet_adjustment_id bigint NOT NULL,
  pay_code character varying(30),
  original_quantity numeric(10,2),
  adjusted_quantity numeric(10,2),
  delta_quantity numeric(10,2),
  remark text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.timesheet_audit (
  id bigint NOT NULL DEFAULT nextval('time_management.timesheet_audit_id_seq'::regclass),
  timesheet_id bigint,
  user_id character varying(20),
  add_update_delete character varying(50),
  what_change text,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.timesheet_detail (
  timesheet_detail_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_detail_timesheet_detail_id_seq'::regclass),
  timesheet_id bigint NOT NULL,
  payroll_area_code character varying(50),
  company_code character varying(50),
  work_date date NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  day_type character varying(20),
  shift_assignment_id bigint,
  shift_code character varying(30),
  work_schedule_template_code character varying(30),
  planned_start_time time without time zone,
  planned_end_time time without time zone,
  break_start_time time without time zone,
  break_end_time time without time zone,
  planned_work_hour numeric(5,2),
  is_cross_midnight boolean NOT NULL DEFAULT false,
  planned_start_datetime timestamp with time zone,
  planned_end_datetime timestamp with time zone,
  holiday_calendar_id bigint,
  holiday_calendar_code character varying(30),
  holiday_name jsonb,
  is_holiday boolean NOT NULL DEFAULT false,
  calculation_status character varying(20),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  time_status_code character varying(10),
  requires_clocking boolean,
  counts_tardy boolean,
  counts_early boolean,
  counts_absent_in boolean,
  deducts boolean,
  is_flex boolean,
  flex_shift_start time without time zone,
  flex_shift_end time without time zone,
  late_threshold_minute integer,
  working_hour_per_day numeric(5,2)
);

CREATE TABLE time_management.timesheet_detail_transaction (
  timesheet_detail_transaction_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_detail_transaction_timesheet_detail_transaction_i_seq'::regclass),
  timesheet_detail_id bigint NOT NULL,
  transaction_id character varying(100),
  transaction_source character varying(50) NOT NULL,
  pay_code character varying(50) NOT NULL,
  pay_type character varying(50) NOT NULL,
  work_date date,
  time_start time without time zone NOT NULL,
  time_end time without time zone NOT NULL,
  is_read_only boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.timesheet_result (
  timesheet_result_id bigint NOT NULL DEFAULT nextval('time_management.timesheet_result_timesheet_result_id_seq'::regclass),
  timesheet_detail_id bigint NOT NULL,
  pay_code character varying(20) NOT NULL,
  earning_code character varying(20),
  actual_hours_py numeric(5,2),
  actual_hours integer,
  actual_minute integer,
  planned_hours_py numeric(5,2) NOT NULL,
  planned_hours integer NOT NULL,
  planned_minute integer NOT NULL DEFAULT 0,
  allowance_payroll_flag boolean NOT NULL DEFAULT false,
  allowance_amount numeric(12,2),
  calculation_version integer NOT NULL DEFAULT 1,
  calculated_at timestamp with time zone,
  status character varying(50) NOT NULL DEFAULT 'VALID'::character varying,
  warning_message_code character varying(50),
  warning_message_name jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE time_management.work_schedule (
  work_schedule_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_work_schedule_id_seq'::regclass),
  work_schedule_code character varying(25) NOT NULL,
  work_schedule_name jsonb NOT NULL,
  hours_per_day numeric(4,2) NOT NULL,
  break_hours numeric(4,2) NOT NULL DEFAULT 0,
  working_days_per_week numeric(3,1) NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  working_hour_per_week numeric(6,2),
  working_hour_per_month numeric(6,2),
  working_hour_per_year numeric(6,2),
  break_hour_per_day numeric(6,2),
  country_code character varying(10)
);

CREATE TABLE time_management.work_schedule_assignment (
  work_schedule_assignment_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_assignment_work_schedule_assignment_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  work_schedule_template_id bigint NOT NULL,
  effective_start_date date NOT NULL,
  effective_end_date date,
  source character varying(10) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_default_mapping (
  work_schedule_default_mapping_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_default_mapping_work_schedule_default_mapping_seq'::regclass),
  position_code character varying(50),
  department_code character varying(50),
  business_unit_code character varying(50),
  work_schedule_template_id bigint NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_shift (
  work_schedule_shift_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_shift_work_schedule_shift_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  work_date date NOT NULL,
  is_work_day boolean NOT NULL,
  start_time time without time zone,
  end_time time without time zone,
  break_start time without time zone,
  break_end time without time zone,
  shift_code character varying(50),
  source_template_day_id bigint,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  is_holiday boolean NOT NULL DEFAULT false,
  holiday_name jsonb
);

CREATE TABLE time_management.work_schedule_shift_assignment (
  shift_assignment_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_shift_assignment_shift_assignment_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  work_date date NOT NULL,
  pay_code character varying(50) NOT NULL,
  shift_time_start time without time zone NOT NULL,
  shift_time_end time without time zone NOT NULL,
  planned_hours integer NOT NULL,
  work_schedule_template_id integer,
  work_schedule_template_detail_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_shift_upload (
  id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_shift_upload_id_seq'::regclass),
  employee_id character varying(15) NOT NULL,
  work_date date NOT NULL,
  pay_code character varying(50) NOT NULL,
  shift_time_start time without time zone NOT NULL,
  shift_time_end time without time zone NOT NULL,
  planned_hours integer NOT NULL,
  upload_work_date character varying(20) NOT NULL,
  upload_pay_code character varying(50) NOT NULL,
  upload_shift_time_start character varying(20) NOT NULL,
  upload_shift_time_end character varying(20) NOT NULL,
  upload_planned_hours character varying(20) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_template (
  work_schedule_template_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_template_work_schedule_template_id_seq'::regclass),
  work_schedule_id bigint NOT NULL,
  template_code character varying(50) NOT NULL,
  template_name character varying(100),
  is_default boolean NOT NULL DEFAULT false,
  is_flex_time boolean NOT NULL DEFAULT false,
  range_start time without time zone,
  range_end time without time zone,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_template_assignment (
  template_assignment_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_template_assignment_template_assignment_id_seq'::regclass),
  employee_id character varying(20) NOT NULL,
  work_schedule_template_id integer,
  is_enabled boolean NOT NULL DEFAULT true,
  effective_start_date date NOT NULL DEFAULT '1900-01-01'::date,
  effective_end_date date NOT NULL DEFAULT '9999-12-31'::date,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint
);

CREATE TABLE time_management.work_schedule_template_day (
  work_schedule_template_day_id bigint NOT NULL DEFAULT nextval('time_management.work_schedule_template_day_work_schedule_template_day_id_seq'::regclass),
  work_schedule_template_id bigint NOT NULL,
  day_of_week smallint NOT NULL,
  is_work_day boolean NOT NULL DEFAULT true,
  start_time time without time zone,
  end_time time without time zone,
  break_start time without time zone,
  break_end time without time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by bigint,
  work_plan_hour numeric(5,2),
  break_hour numeric(5,2),
  is_cross_midnight boolean
);

CREATE TABLE todo."SequelizeMeta_todo" (
  name character varying(255) NOT NULL
);

CREATE TABLE todo.todo_history (
  id bigint NOT NULL DEFAULT nextval('todo.todo_history_id_seq'::regclass),
  todo_id bigint NOT NULL,
  from_status character varying(20),
  to_status character varying(20) NOT NULL,
  trigger character varying(50) NOT NULL,
  triggered_by character varying(255),
  event_id uuid,
  evidence jsonb,
  changed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE todo.todo_templates (
  id bigint NOT NULL DEFAULT nextval('todo.todo_templates_id_seq'::regclass),
  code character varying(100) NOT NULL,
  name jsonb NOT NULL,
  category character varying(50),
  action_mode character varying(20) NOT NULL,
  action_type character varying(50),
  is_dismissable boolean NOT NULL DEFAULT true,
  channels jsonb NOT NULL,
  content jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_by character varying(255)
);

CREATE TABLE todo.todos (
  id bigint NOT NULL DEFAULT nextval('todo.todos_id_seq'::regclass),
  employee_id bigint NOT NULL,
  template_code character varying(100) NOT NULL,
  category character varying(50),
  title text NOT NULL,
  body text,
  deeplink text,
  action_mode character varying(20) NOT NULL,
  action_type character varying(50),
  action_ref_id character varying(255),
  action_source_module character varying(100),
  is_dismissable boolean NOT NULL DEFAULT true,
  status character varying(20) NOT NULL DEFAULT 'PENDING_ACTION'::character varying,
  due_at timestamp with time zone,
  completed_at timestamp with time zone,
  completed_via character varying(20),
  completed_event_id uuid,
  dismissed_at timestamp with time zone,
  dismissed_by character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255),
  deleted_at timestamp with time zone
);

CREATE TABLE user_management."SequelizeMeta_user_management" (
  name character varying(255) NOT NULL
);

CREATE TABLE user_management.grant_group_permissions (
  id bigint NOT NULL DEFAULT nextval('user_management.grant_group_permissions_id_seq'::regclass),
  grant_group_id bigint NOT NULL,
  permission_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.grant_groups (
  id bigint NOT NULL DEFAULT nextval('user_management.grant_groups_id_seq'::regclass),
  code character varying(100) NOT NULL,
  name jsonb NOT NULL,
  description jsonb,
  visibility_policy jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.permissions (
  id bigint NOT NULL DEFAULT nextval('user_management.permissions_id_seq'::regclass),
  code character varying(150) NOT NULL,
  name jsonb NOT NULL,
  description jsonb,
  module character varying(100),
  section character varying(100),
  sub_section character varying(100),
  action character varying(100),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.target_groups (
  id bigint NOT NULL DEFAULT nextval('user_management.target_groups_id_seq'::regclass),
  code character varying(100) NOT NULL,
  name jsonb NOT NULL,
  description jsonb,
  type character varying(20) NOT NULL,
  dynamic_scope character varying(30),
  condition jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.user_group_grants (
  id bigint NOT NULL DEFAULT nextval('user_management.user_group_grants_id_seq'::regclass),
  user_group_id bigint NOT NULL,
  grant_group_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.user_group_members (
  id bigint NOT NULL DEFAULT nextval('user_management.user_group_members_id_seq'::regclass),
  user_group_id bigint NOT NULL,
  member_type character varying(20) NOT NULL DEFAULT 'EMPLOYEE'::character varying,
  employee_id character varying(15),
  population_code character varying(40),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.user_group_targets (
  id bigint NOT NULL DEFAULT nextval('user_management.user_group_targets_id_seq'::regclass),
  user_group_id bigint NOT NULL,
  target_group_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE user_management.user_groups (
  id bigint NOT NULL DEFAULT nextval('user_management.user_groups_id_seq'::regclass),
  code character varying(100) NOT NULL,
  name jsonb NOT NULL,
  description jsonb,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by character varying(255),
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by character varying(255)
);

CREATE TABLE workflow_service.wf_approver_assignment (
  id uuid NOT NULL,
  step_instance_id uuid NOT NULL,
  approver_user_id character varying(255),
  resolution_priority character varying(20) NOT NULL,
  resolution_rule character varying(50) NOT NULL,
  resolved_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by character varying(255) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_service.wf_assignment_history (
  id uuid NOT NULL,
  step_instance_id uuid NOT NULL,
  from_user_id character varying(255),
  to_user_id character varying(255),
  resolution_priority character varying(20) NOT NULL,
  reason character varying(500),
  actor_user_id character varying(255),
  changed_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_service.wf_process_definition (
  id uuid NOT NULL,
  camunda_process_key character varying(100) NOT NULL,
  "desc" character varying(255) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by character varying(255),
  updated_by character varying(255),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  camunda_deployment_id character varying(255)
);

CREATE TABLE workflow_service.wf_process_instance (
  id uuid NOT NULL,
  process_def_id uuid NOT NULL,
  camunda_process_instance_id character varying(64) NOT NULL,
  requester_id character varying(255) NOT NULL,
  business_ref_type character varying(50),
  business_ref_id character varying(64),
  status character varying(20) NOT NULL DEFAULT 'ACTIVE'::character varying,
  started_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  process_variables jsonb
);

CREATE TABLE workflow_service.wf_process_step_definition (
  id uuid NOT NULL,
  process_def_id uuid NOT NULL,
  step_key character varying(100) NOT NULL,
  "desc" character varying(255) NOT NULL,
  explicit_user_id character varying(255),
  position_code character varying(50),
  preferred_user_id character varying(255),
  hops_above_requester integer,
  no_approver_policy character varying(20) NOT NULL DEFAULT 'STOP'::character varying,
  camunda_task_key character varying(100) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_service.wf_step_action_history (
  id uuid NOT NULL,
  step_instance_id uuid NOT NULL,
  action_type character varying(20) NOT NULL,
  actor_user_id character varying(255),
  ip_address character varying(45),
  correlation_id character varying(64),
  actioned_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  variables jsonb
);

CREATE TABLE workflow_service.wf_step_instance (
  id uuid NOT NULL,
  process_instance_id uuid NOT NULL,
  step_def_id uuid,
  camunda_task_id character varying(64),
  assignee_user_id character varying(255),
  status character varying(20) NOT NULL DEFAULT 'PENDING'::character varying,
  claimed_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  priority integer,
  due_date timestamp with time zone,
  follow_up_date timestamp with time zone,
  name character varying(255),
  description text,
  task_definition_key character varying(255),
  latest_user_task_input jsonb
);

CREATE TABLE workflow_service.wf_user (
  id uuid NOT NULL,
  email character varying(255) NOT NULL,
  password_hash character varying(255) NOT NULL,
  first_name character varying(100) NOT NULL,
  last_name character varying(100) NOT NULL,
  role character varying(50) NOT NULL DEFAULT 'employee'::character varying,
  status character varying(20) NOT NULL DEFAULT 'ACTIVE'::character varying,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE workflow_service.wf_workflow_audit_trail (
  id uuid NOT NULL,
  process_instance_id uuid NOT NULL,
  step_instance_id uuid,
  action character varying(50) NOT NULL,
  actor_user_id character varying(255),
  before_state jsonb,
  after_state jsonb,
  correlation_id character varying(64),
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE authentication."SequelizeMeta_authentication" ADD CONSTRAINT "SequelizeMeta_authentication_pkey" PRIMARY KEY (name);
ALTER TABLE authentication.access_tokens ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (access_token);
ALTER TABLE authentication.access_tokens ADD CONSTRAINT access_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES authentication.clients(id) ON DELETE CASCADE;
ALTER TABLE authentication.access_tokens ADD CONSTRAINT access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES authentication.users(id) ON DELETE CASCADE;
ALTER TABLE authentication.authorization_codes ADD CONSTRAINT authorization_codes_pkey PRIMARY KEY (code);
ALTER TABLE authentication.authorization_codes ADD CONSTRAINT authorization_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES authentication.clients(id) ON DELETE CASCADE;
ALTER TABLE authentication.authorization_codes ADD CONSTRAINT authorization_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES authentication.users(id) ON DELETE CASCADE;
ALTER TABLE authentication.clients ADD CONSTRAINT clients_pkey PRIMARY KEY (id);
ALTER TABLE authentication.clients ADD CONSTRAINT clients_client_id_key UNIQUE (client_id);
ALTER TABLE authentication.refresh_tokens ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (refresh_token);
ALTER TABLE authentication.refresh_tokens ADD CONSTRAINT refresh_tokens_access_token_fkey FOREIGN KEY (access_token) REFERENCES authentication.access_tokens(access_token) ON DELETE CASCADE;
ALTER TABLE authentication.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE authentication.users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE authentication.users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE benefit_management.benefit_eligibility_rule ADD CONSTRAINT benefit_eligibility_rule_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.benefit_history_logs ADD CONSTRAINT benefit_history_logs_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.benefit_hospitals ADD CONSTRAINT benefit_hospitals_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.benefit_import_logs ADD CONSTRAINT benefit_import_logs_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.benefit_plan ADD CONSTRAINT benefit_plan_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.individual_benefit_plan ADD CONSTRAINT individual_benefit_plan_pkey PRIMARY KEY (id);
ALTER TABLE benefit_management.master_hospitals ADD CONSTRAINT master_hospitals_pkey PRIMARY KEY (id);
ALTER TABLE camunda.act_ge_bytearray ADD CONSTRAINT act_ge_bytearray_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ge_bytearray ADD CONSTRAINT act_fk_bytearr_depl FOREIGN KEY (deployment_id_) REFERENCES camunda.act_re_deployment(id_);
ALTER TABLE camunda.act_ge_property ADD CONSTRAINT act_ge_property_pkey PRIMARY KEY (name_);
ALTER TABLE camunda.act_ge_schema_log ADD CONSTRAINT act_ge_schema_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_actinst ADD CONSTRAINT act_hi_actinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_attachment ADD CONSTRAINT act_hi_attachment_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_batch ADD CONSTRAINT act_hi_batch_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_caseactinst ADD CONSTRAINT act_hi_caseactinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_caseinst ADD CONSTRAINT act_hi_caseinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_caseinst ADD CONSTRAINT act_hi_caseinst_case_inst_id__key UNIQUE (case_inst_id_);
ALTER TABLE camunda.act_hi_comment ADD CONSTRAINT act_hi_comment_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_dec_in ADD CONSTRAINT act_hi_dec_in_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_dec_out ADD CONSTRAINT act_hi_dec_out_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_decinst ADD CONSTRAINT act_hi_decinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_detail ADD CONSTRAINT act_hi_detail_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_ext_task_log ADD CONSTRAINT act_hi_ext_task_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_identitylink ADD CONSTRAINT act_hi_identitylink_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_incident ADD CONSTRAINT act_hi_incident_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_job_log ADD CONSTRAINT act_hi_job_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_op_log ADD CONSTRAINT act_hi_op_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_procinst ADD CONSTRAINT act_hi_procinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_procinst ADD CONSTRAINT act_hi_procinst_proc_inst_id__key UNIQUE (proc_inst_id_);
ALTER TABLE camunda.act_hi_taskinst ADD CONSTRAINT act_hi_taskinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_hi_varinst ADD CONSTRAINT act_hi_varinst_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_id_group ADD CONSTRAINT act_id_group_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_id_info ADD CONSTRAINT act_id_info_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_id_membership ADD CONSTRAINT act_id_membership_pkey PRIMARY KEY (user_id_, group_id_);
ALTER TABLE camunda.act_id_membership ADD CONSTRAINT act_fk_memb_group FOREIGN KEY (group_id_) REFERENCES camunda.act_id_group(id_);
ALTER TABLE camunda.act_id_membership ADD CONSTRAINT act_fk_memb_user FOREIGN KEY (user_id_) REFERENCES camunda.act_id_user(id_);
ALTER TABLE camunda.act_id_tenant ADD CONSTRAINT act_id_tenant_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_id_tenant_member_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_uniq_tenant_memb_group UNIQUE (tenant_id_, group_id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_uniq_tenant_memb_user UNIQUE (tenant_id_, user_id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_fk_tenant_memb FOREIGN KEY (tenant_id_) REFERENCES camunda.act_id_tenant(id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_fk_tenant_memb_group FOREIGN KEY (group_id_) REFERENCES camunda.act_id_group(id_);
ALTER TABLE camunda.act_id_tenant_member ADD CONSTRAINT act_fk_tenant_memb_user FOREIGN KEY (user_id_) REFERENCES camunda.act_id_user(id_);
ALTER TABLE camunda.act_id_user ADD CONSTRAINT act_id_user_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_camformdef ADD CONSTRAINT act_re_camformdef_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_case_def ADD CONSTRAINT act_re_case_def_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_decision_def ADD CONSTRAINT act_re_decision_def_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_decision_def ADD CONSTRAINT act_fk_dec_req FOREIGN KEY (dec_req_id_) REFERENCES camunda.act_re_decision_req_def(id_);
ALTER TABLE camunda.act_re_decision_req_def ADD CONSTRAINT act_re_decision_req_def_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_deployment ADD CONSTRAINT act_re_deployment_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_re_procdef ADD CONSTRAINT act_re_procdef_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_authorization ADD CONSTRAINT act_ru_authorization_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_authorization ADD CONSTRAINT act_uniq_auth_group UNIQUE (type_, group_id_, resource_type_, resource_id_);
ALTER TABLE camunda.act_ru_authorization ADD CONSTRAINT act_uniq_auth_user UNIQUE (type_, user_id_, resource_type_, resource_id_);
ALTER TABLE camunda.act_ru_batch ADD CONSTRAINT act_ru_batch_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_batch ADD CONSTRAINT act_fk_batch_job_def FOREIGN KEY (batch_job_def_id_) REFERENCES camunda.act_ru_jobdef(id_);
ALTER TABLE camunda.act_ru_batch ADD CONSTRAINT act_fk_batch_monitor_job_def FOREIGN KEY (monitor_job_def_id_) REFERENCES camunda.act_ru_jobdef(id_);
ALTER TABLE camunda.act_ru_batch ADD CONSTRAINT act_fk_batch_seed_job_def FOREIGN KEY (seed_job_def_id_) REFERENCES camunda.act_ru_jobdef(id_);
ALTER TABLE camunda.act_ru_case_execution ADD CONSTRAINT act_ru_case_execution_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_case_execution ADD CONSTRAINT act_fk_case_exe_case_def FOREIGN KEY (case_def_id_) REFERENCES camunda.act_re_case_def(id_);
ALTER TABLE camunda.act_ru_case_execution ADD CONSTRAINT act_fk_case_exe_case_inst FOREIGN KEY (case_inst_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_case_execution ADD CONSTRAINT act_fk_case_exe_parent FOREIGN KEY (parent_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_case_sentry_part ADD CONSTRAINT act_ru_case_sentry_part_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_case_sentry_part ADD CONSTRAINT act_fk_case_sentry_case_exec FOREIGN KEY (case_exec_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_case_sentry_part ADD CONSTRAINT act_fk_case_sentry_case_inst FOREIGN KEY (case_inst_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_event_subscr ADD CONSTRAINT act_ru_event_subscr_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_event_subscr ADD CONSTRAINT act_fk_event_exec FOREIGN KEY (execution_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_execution ADD CONSTRAINT act_ru_execution_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_execution ADD CONSTRAINT act_fk_exe_parent FOREIGN KEY (parent_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_execution ADD CONSTRAINT act_fk_exe_procdef FOREIGN KEY (proc_def_id_) REFERENCES camunda.act_re_procdef(id_);
ALTER TABLE camunda.act_ru_execution ADD CONSTRAINT act_fk_exe_procinst FOREIGN KEY (proc_inst_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_execution ADD CONSTRAINT act_fk_exe_super FOREIGN KEY (super_exec_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_ext_task ADD CONSTRAINT act_ru_ext_task_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_ext_task ADD CONSTRAINT act_fk_ext_task_error_details FOREIGN KEY (error_details_id_) REFERENCES camunda.act_ge_bytearray(id_);
ALTER TABLE camunda.act_ru_ext_task ADD CONSTRAINT act_fk_ext_task_exe FOREIGN KEY (execution_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_filter ADD CONSTRAINT act_ru_filter_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_identitylink ADD CONSTRAINT act_ru_identitylink_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_identitylink ADD CONSTRAINT act_fk_athrz_procedef FOREIGN KEY (proc_def_id_) REFERENCES camunda.act_re_procdef(id_);
ALTER TABLE camunda.act_ru_identitylink ADD CONSTRAINT act_fk_tskass_task FOREIGN KEY (task_id_) REFERENCES camunda.act_ru_task(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_ru_incident_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_cause FOREIGN KEY (cause_incident_id_) REFERENCES camunda.act_ru_incident(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_exe FOREIGN KEY (execution_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_job_def FOREIGN KEY (job_def_id_) REFERENCES camunda.act_ru_jobdef(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_procdef FOREIGN KEY (proc_def_id_) REFERENCES camunda.act_re_procdef(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_procinst FOREIGN KEY (proc_inst_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_incident ADD CONSTRAINT act_fk_inc_rcause FOREIGN KEY (root_cause_incident_id_) REFERENCES camunda.act_ru_incident(id_);
ALTER TABLE camunda.act_ru_job ADD CONSTRAINT act_ru_job_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_job ADD CONSTRAINT act_fk_job_exception FOREIGN KEY (exception_stack_id_) REFERENCES camunda.act_ge_bytearray(id_);
ALTER TABLE camunda.act_ru_jobdef ADD CONSTRAINT act_ru_jobdef_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_meter_log ADD CONSTRAINT act_ru_meter_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_ru_task_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_fk_task_case_def FOREIGN KEY (case_def_id_) REFERENCES camunda.act_re_case_def(id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_fk_task_case_exe FOREIGN KEY (case_execution_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_fk_task_exe FOREIGN KEY (execution_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_fk_task_procdef FOREIGN KEY (proc_def_id_) REFERENCES camunda.act_re_procdef(id_);
ALTER TABLE camunda.act_ru_task ADD CONSTRAINT act_fk_task_procinst FOREIGN KEY (proc_inst_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_task_meter_log ADD CONSTRAINT act_ru_task_meter_log_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_ru_variable_pkey PRIMARY KEY (id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_uniq_variable UNIQUE (var_scope_, name_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_batch FOREIGN KEY (batch_id_) REFERENCES camunda.act_ru_batch(id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_bytearray FOREIGN KEY (bytearray_id_) REFERENCES camunda.act_ge_bytearray(id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_case_exe FOREIGN KEY (case_execution_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_case_inst FOREIGN KEY (case_inst_id_) REFERENCES camunda.act_ru_case_execution(id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_exe FOREIGN KEY (execution_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE camunda.act_ru_variable ADD CONSTRAINT act_fk_var_procinst FOREIGN KEY (proc_inst_id_) REFERENCES camunda.act_ru_execution(id_);
ALTER TABLE change_tracking."SequelizeMeta_change_tracking" ADD CONSTRAINT "SequelizeMeta_change_tracking_pkey" PRIMARY KEY (name);
ALTER TABLE change_tracking.audit_change_requests ADD CONSTRAINT audit_change_requests_pkey PRIMARY KEY (id);
ALTER TABLE change_tracking.audit_change_requests ADD CONSTRAINT audit_change_requests_event_id_key UNIQUE (event_id);
ALTER TABLE change_tracking.audit_field_changes ADD CONSTRAINT audit_field_changes_pkey PRIMARY KEY (id);
ALTER TABLE change_tracking.audit_field_changes ADD CONSTRAINT audit_field_changes_audit_change_request_id_fkey FOREIGN KEY (audit_change_request_id) REFERENCES change_tracking.audit_change_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE content_management."SequelizeMeta_content_management" ADD CONSTRAINT "SequelizeMeta_content_management_pkey" PRIMARY KEY (name);
ALTER TABLE content_management.languages ADD CONSTRAINT languages_pkey PRIMARY KEY (id);
ALTER TABLE content_management.languages ADD CONSTRAINT languages_code_ux UNIQUE (code);
ALTER TABLE content_management.menu_items ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);
ALTER TABLE content_management.news_updates ADD CONSTRAINT news_updates_pkey PRIMARY KEY (id);
ALTER TABLE content_management.news_updates ADD CONSTRAINT news_updates_content_type_ck CHECK (((((content_type)::text = 'EXTERNAL_LINK'::text) AND (external_url IS NOT NULL) AND (internal_route IS NULL) AND (content_blocks IS NULL)) OR (((content_type)::text = 'INTERNAL_LINK'::text) AND (internal_route IS NOT NULL) AND (external_url IS NULL) AND (content_blocks IS NULL)) OR (((content_type)::text = 'CONTENT_PAGE'::text) AND (content_blocks IS NOT NULL) AND (external_url IS NULL) AND (internal_route IS NULL))));
ALTER TABLE content_management.news_updates ADD CONSTRAINT news_updates_expiry_ck CHECK (((publish_at IS NULL) OR (expires_at IS NULL) OR (expires_at > publish_at)));
ALTER TABLE content_management.news_updates ADD CONSTRAINT news_updates_language_fkey FOREIGN KEY (language) REFERENCES content_management.languages(code) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE content_management.quick_actions ADD CONSTRAINT quick_actions_pkey PRIMARY KEY (id);
ALTER TABLE delegation."SequelizeMeta_delegation" ADD CONSTRAINT "SequelizeMeta_delegation_pkey" PRIMARY KEY (name);
ALTER TABLE delegation.delegations ADD CONSTRAINT delegations_pkey PRIMARY KEY (id);
ALTER TABLE employee_center."SequelizeMeta_employee_center" ADD CONSTRAINT "SequelizeMeta_employee_center_pkey" PRIMARY KEY (name);
ALTER TABLE employee_center.employee_info_transaction_requests ADD CONSTRAINT employee_info_transaction_requests_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_compensation ADD CONSTRAINT employment_compensation_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_compensation_detail ADD CONSTRAINT employment_compensation_detail_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_cost_distribution ADD CONSTRAINT employment_cost_distribution_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_cost_distribution_item ADD CONSTRAINT employment_cost_distribution_item_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_cost_distribution_items ADD CONSTRAINT employment_cost_distribution_items_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_cost_distributions ADD CONSTRAINT employment_cost_distributions_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_information ADD CONSTRAINT employment_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_job ADD CONSTRAINT employment_job_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_job_relationships ADD CONSTRAINT employment_job_relationships_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_jobs ADD CONSTRAINT employment_jobs_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_termination ADD CONSTRAINT employment_termination_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_terminations ADD CONSTRAINT employment_terminations_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_work_permit ADD CONSTRAINT employment_work_permit_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.employment_work_permits ADD CONSTRAINT employment_work_permits_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.master_banks ADD CONSTRAINT master_banks_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.master_custom_pay_type_assignments ADD CONSTRAINT master_custom_pay_type_assignments_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.master_custom_pay_types ADD CONSTRAINT master_custom_pay_types_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.master_payment_method_assignments ADD CONSTRAINT master_payment_method_assignments_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.master_payment_methods ADD CONSTRAINT master_payment_methods_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_achievement ADD CONSTRAINT person_additional_achievement_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_achievements ADD CONSTRAINT person_additional_achievements_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_advanced_information ADD CONSTRAINT person_additional_advanced_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_assessment_program ADD CONSTRAINT person_additional_assessment_program_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_assessment_programs ADD CONSTRAINT person_additional_assessment_programs_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_awards ADD CONSTRAINT person_additional_awards_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_benefits_elections ADD CONSTRAINT person_additional_benefits_elections_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_business_driver_assessments ADD CONSTRAINT person_additional_business_driver_assessments_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_certificates ADD CONSTRAINT person_additional_certificates_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_coaching_feedback ADD CONSTRAINT person_additional_coaching_feedback_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_coi_approvals ADD CONSTRAINT person_additional_coi_approvals_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_communities ADD CONSTRAINT person_additional_communities_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_company_assets ADD CONSTRAINT person_additional_company_assets_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_company_loans ADD CONSTRAINT person_additional_company_loans_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_compensation ADD CONSTRAINT person_additional_compensation_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_courses ADD CONSTRAINT person_additional_courses_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_development_goals ADD CONSTRAINT person_additional_development_goals_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_development_needs ADD CONSTRAINT person_additional_development_needs_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_disciplinary_actions ADD CONSTRAINT person_additional_disciplinary_actions_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_e_letter_passwords ADD CONSTRAINT person_additional_e_letter_passwords_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_e_letters ADD CONSTRAINT person_additional_e_letters_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_employee_benefit_obligations ADD CONSTRAINT person_additional_employee_benefit_obligations_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_flexible_spending_accounts ADD CONSTRAINT person_additional_flexible_spending_accounts_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_functional_experiences ADD CONSTRAINT person_additional_functional_experiences_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_goodness ADD CONSTRAINT person_additional_goodness_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_guarantees ADD CONSTRAINT person_additional_guarantees_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_individual_documents ADD CONSTRAINT person_additional_individual_documents_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_languages ADD CONSTRAINT person_additional_languages_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_leadership_competencies ADD CONSTRAINT person_additional_leadership_competencies_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_leadership_experiences ADD CONSTRAINT person_additional_leadership_experiences_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_learning_activities ADD CONSTRAINT person_additional_learning_activities_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_legal_execution_department ADD CONSTRAINT person_additional_legal_execution_department_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_mobility ADD CONSTRAINT person_additional_mobility_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_mtma_references ADD CONSTRAINT person_additional_mtma_references_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_ohs_certificates ADD CONSTRAINT person_additional_ohs_certificates_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_ohs_documents ADD CONSTRAINT person_additional_ohs_documents_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_overall_ratings ADD CONSTRAINT person_additional_overall_ratings_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_performance_assessments ADD CONSTRAINT person_additional_performance_assessments_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_personal_assessment_summaries ADD CONSTRAINT person_additional_personal_assessment_summaries_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_personality_assessment ADD CONSTRAINT person_additional_personality_assessment_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_potential_details ADD CONSTRAINT person_additional_potential_details_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_preferred_next_move ADD CONSTRAINT person_additional_preferred_next_move_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_preferred_next_moves ADD CONSTRAINT person_additional_preferred_next_moves_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_previous_work_history ADD CONSTRAINT person_additional_previous_work_history_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_product_liability_insurance ADD CONSTRAINT person_additional_product_liability_insurance_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_professional_memberships ADD CONSTRAINT person_additional_professional_memberships_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_promotability ADD CONSTRAINT person_additional_promotability_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_rotation_plans ADD CONSTRAINT person_additional_rotation_plans_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_salary_histories ADD CONSTRAINT person_additional_salary_histories_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_scholarships ADD CONSTRAINT person_additional_scholarships_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_scorecard_development_objectives ADD CONSTRAINT person_additional_scorecard_development_objectives_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_special_assignments ADD CONSTRAINT person_additional_special_assignments_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_student_loans ADD CONSTRAINT person_additional_student_loans_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_talent_reference ADD CONSTRAINT person_additional_talent_reference_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_talent_references ADD CONSTRAINT person_additional_talent_references_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_top_strengths ADD CONSTRAINT person_additional_top_strengths_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_variable_pay_employee_history_data ADD CONSTRAINT person_additional_variable_pay_employee_history_data_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_work_experiences_within_company ADD CONSTRAINT person_additional_work_experiences_within_company_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_additional_work_experiences_within_company_history ADD CONSTRAINT person_additional_work_experiences_within_company_history_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_address ADD CONSTRAINT person_address_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_addresses ADD CONSTRAINT person_addresses_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_bank ADD CONSTRAINT person_config_bank_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_custom_pay_type ADD CONSTRAINT person_config_custom_pay_type_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_custom_pay_type_assignment ADD CONSTRAINT person_config_custom_pay_type_assignment_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_payment_information ADD CONSTRAINT person_config_payment_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_payment_information_detail ADD CONSTRAINT person_config_payment_information_detail_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_payment_information_details ADD CONSTRAINT person_config_payment_information_details_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_payment_method ADD CONSTRAINT person_config_payment_method_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_payment_method_assignment ADD CONSTRAINT person_config_payment_method_assignment_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_position ADD CONSTRAINT person_config_position_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_config_position_matrix_relationship ADD CONSTRAINT person_config_position_matrix_relationship_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_email ADD CONSTRAINT person_email_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_emails ADD CONSTRAINT person_emails_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_emergency_contacts ADD CONSTRAINT person_emergency_contacts_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_formal_education ADD CONSTRAINT person_formal_education_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_global_info ADD CONSTRAINT person_global_info_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_global_information ADD CONSTRAINT person_global_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_information ADD CONSTRAINT person_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_national_id ADD CONSTRAINT person_national_id_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_national_ids ADD CONSTRAINT person_national_ids_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_performance ADD CONSTRAINT person_performance_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_phone ADD CONSTRAINT person_phone_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_phones ADD CONSTRAINT person_phones_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_relationship ADD CONSTRAINT person_relationship_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_relationships ADD CONSTRAINT person_relationships_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_social_account ADD CONSTRAINT person_social_account_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.person_social_accounts ADD CONSTRAINT person_social_accounts_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.probation_transactions ADD CONSTRAINT probation_transactions_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.termination_request_approvals ADD CONSTRAINT termination_request_approvals_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.transaction_new_hire ADD CONSTRAINT transaction_new_hire_pkey PRIMARY KEY (id);
ALTER TABLE employee_center.transaction_new_hire ADD CONSTRAINT uniq_transaction_new_hire_national_id UNIQUE (national_id);
ALTER TABLE employee_center.transaction_new_hires ADD CONSTRAINT transaction_new_hires_pkey PRIMARY KEY (transaction_id);
ALTER TABLE employee_center.transaction_request_approvals ADD CONSTRAINT transaction_request_approvals_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation."SequelizeMeta_employee_foundation" ADD CONSTRAINT "SequelizeMeta_employee_foundation_pkey" PRIMARY KEY (name);
ALTER TABLE employee_foundation.bands ADD CONSTRAINT bands_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.bands ADD CONSTRAINT bands_band_code_key UNIQUE (band_code);
ALTER TABLE employee_foundation.brands ADD CONSTRAINT brands_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.brands ADD CONSTRAINT brands_brand_code_key UNIQUE (brand_code);
ALTER TABLE employee_foundation.business_groups ADD CONSTRAINT business_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_groups ADD CONSTRAINT business_groups_business_group_code_key UNIQUE (business_group_code);
ALTER TABLE employee_foundation.business_unit_companies ADD CONSTRAINT business_unit_companies_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_divisions ADD CONSTRAINT business_unit_divisions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_groups_of_standard_function ADD CONSTRAINT business_unit_groups_of_standard_function_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_section_groups ADD CONSTRAINT business_unit_section_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_standard_functions ADD CONSTRAINT business_unit_standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_store_formats ADD CONSTRAINT business_unit_store_formats_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_sub_functions ADD CONSTRAINT business_unit_sub_functions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_unit_sub_organizations ADD CONSTRAINT business_unit_sub_organizations_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_units ADD CONSTRAINT business_units_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.business_units ADD CONSTRAINT uq_business_units_code_effective_start_date UNIQUE (business_unit_code, effective_start_date);
ALTER TABLE employee_foundation.companies ADD CONSTRAINT companies_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.companies ADD CONSTRAINT uq_companies_code_effective_start_date UNIQUE (company_code, effective_start_date);
ALTER TABLE employee_foundation.corporate_title ADD CONSTRAINT corporate_title_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.corporate_title ADD CONSTRAINT corporate_title_code_key UNIQUE (code);
ALTER TABLE employee_foundation.cost_centers ADD CONSTRAINT cost_centers_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.cost_centers ADD CONSTRAINT uq_cost_centers_code_effective_start_date UNIQUE (cost_center_code, effective_start_date);
ALTER TABLE employee_foundation.country_groups ADD CONSTRAINT country_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.currencies ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.currencies ADD CONSTRAINT currencies_currency_code_key UNIQUE (currency_code);
ALTER TABLE employee_foundation.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.departments ADD CONSTRAINT uq_departments_code_effective_start_date UNIQUE (department_code, effective_start_date);
ALTER TABLE employee_foundation.divisions ADD CONSTRAINT divisions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.divisions ADD CONSTRAINT uq_divisions_code_effective_start_date UNIQUE (division_code, effective_start_date);
ALTER TABLE employee_foundation.employee_group_employee_subgroups ADD CONSTRAINT employee_group_employee_subgroups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.employee_groups ADD CONSTRAINT employee_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.employee_groups ADD CONSTRAINT employee_groups_employee_group_code_key UNIQUE (employee_group_code);
ALTER TABLE employee_foundation.employee_subgroups ADD CONSTRAINT employee_subgroups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.employee_subgroups ADD CONSTRAINT employee_subgroups_employee_subgroup_code_key UNIQUE (employee_subgroup_code);
ALTER TABLE employee_foundation.event_reasons ADD CONSTRAINT event_reasons_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.event_reasons ADD CONSTRAINT uq_event_reasons_code_effective_start_date UNIQUE (event_reason_code, effective_start_date);
ALTER TABLE employee_foundation.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.events ADD CONSTRAINT events_event_code_key UNIQUE (event_code);
ALTER TABLE employee_foundation.frequencies ADD CONSTRAINT frequencies_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.frequencies ADD CONSTRAINT frequencies_frequency_code_key UNIQUE (frequency_code);
ALTER TABLE employee_foundation."group" ADD CONSTRAINT group_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation."group" ADD CONSTRAINT group_code_key UNIQUE (code);
ALTER TABLE employee_foundation.groups_of_standard_functions ADD CONSTRAINT groups_of_standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.groups_of_standard_functions ADD CONSTRAINT uq_groups_of_standard_functions_code_effective_start_date UNIQUE (group_of_standard_function_code, effective_start_date);
ALTER TABLE employee_foundation.hr_districts ADD CONSTRAINT hr_districts_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.hr_districts ADD CONSTRAINT hr_districts_hr_district_code_key UNIQUE (hr_district_code);
ALTER TABLE employee_foundation.job_catalogs ADD CONSTRAINT job_catalogs_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.job_catalogs ADD CONSTRAINT job_catalogs_job_catalog_code_key UNIQUE (job_catalog_code);
ALTER TABLE employee_foundation.job_codes ADD CONSTRAINT job_codes_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.job_codes ADD CONSTRAINT uq_job_codes_code_effective_start_date UNIQUE (job_code_code, effective_start_date);
ALTER TABLE employee_foundation.job_families ADD CONSTRAINT job_families_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.job_families ADD CONSTRAINT job_families_job_family_code_key UNIQUE (job_family_code);
ALTER TABLE employee_foundation.job_type ADD CONSTRAINT job_type_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.job_type ADD CONSTRAINT job_type_code_key UNIQUE (code);
ALTER TABLE employee_foundation.master_countries ADD CONSTRAINT master_countries_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.master_countries ADD CONSTRAINT master_countries_country_code_key UNIQUE (country_code);
ALTER TABLE employee_foundation.national_id_card_type ADD CONSTRAINT national_id_card_type_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.national_id_card_type ADD CONSTRAINT national_id_card_type_card_type_code_key UNIQUE (card_type_code);
ALTER TABLE employee_foundation.pay_component_groups ADD CONSTRAINT pay_component_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_component_groups ADD CONSTRAINT pay_component_groups_pay_component_group_code_key UNIQUE (pay_component_group_code);
ALTER TABLE employee_foundation.pay_components ADD CONSTRAINT pay_components_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_components ADD CONSTRAINT pay_components_pay_component_code_key UNIQUE (pay_component_code);
ALTER TABLE employee_foundation.pay_grades ADD CONSTRAINT pay_grades_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_grades ADD CONSTRAINT pay_grades_pay_grade_code_key UNIQUE (pay_grade_code);
ALTER TABLE employee_foundation.pay_groups ADD CONSTRAINT pay_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_groups ADD CONSTRAINT uq_pay_groups_code_effective_start_date UNIQUE (pay_group_code, effective_start_date);
ALTER TABLE employee_foundation.pay_scale_areas ADD CONSTRAINT pay_scale_areas_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_scale_areas ADD CONSTRAINT pay_scale_areas_pay_scale_area_code_key UNIQUE (pay_scale_area_code);
ALTER TABLE employee_foundation.pay_scale_groups ADD CONSTRAINT pay_scale_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_scale_groups ADD CONSTRAINT pay_scale_groups_pay_scale_group_code_key UNIQUE (pay_scale_group_code);
ALTER TABLE employee_foundation.pay_scale_levels ADD CONSTRAINT pay_scale_levels_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_scale_levels ADD CONSTRAINT pay_scale_levels_pay_scale_level_code_key UNIQUE (pay_scale_level_code);
ALTER TABLE employee_foundation.pay_scale_types ADD CONSTRAINT pay_scale_types_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.pay_scale_types ADD CONSTRAINT pay_scale_types_pay_scale_type_code_key UNIQUE (pay_scale_type_code);
ALTER TABLE employee_foundation.picking_lists ADD CONSTRAINT picking_lists_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.position_matrix_relationships ADD CONSTRAINT position_matrix_relationships_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.positions ADD CONSTRAINT positions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.section_groups ADD CONSTRAINT section_groups_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.section_groups ADD CONSTRAINT section_groups_section_group_code_key UNIQUE (section_group_code);
ALTER TABLE employee_foundation.sso_locations ADD CONSTRAINT sso_locations_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.sso_locations ADD CONSTRAINT sso_locations_sso_location_code_key UNIQUE (sso_location_code);
ALTER TABLE employee_foundation.standard_functions ADD CONSTRAINT standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.standard_functions ADD CONSTRAINT standard_functions_standard_function_code_key UNIQUE (standard_function_code);
ALTER TABLE employee_foundation.store_branch_locations ADD CONSTRAINT store_branch_locations_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.store_branch_locations ADD CONSTRAINT uq_store_branch_locations_code_effective_start_date UNIQUE (store_branch_location_code, effective_start_date);
ALTER TABLE employee_foundation.store_formats ADD CONSTRAINT store_formats_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.store_formats ADD CONSTRAINT store_formats_store_format_code_key UNIQUE (store_format_code);
ALTER TABLE employee_foundation.sub_functions ADD CONSTRAINT sub_functions_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.sub_functions ADD CONSTRAINT sub_functions_sub_function_code_key UNIQUE (sub_function_code);
ALTER TABLE employee_foundation.sub_organizations ADD CONSTRAINT sub_organizations_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.sub_organizations ADD CONSTRAINT sub_organizations_sub_organization_code_key UNIQUE (sub_organization_code);
ALTER TABLE employee_foundation.work_location_geofences ADD CONSTRAINT work_location_geofences_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.work_locations ADD CONSTRAINT work_locations_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.work_locations ADD CONSTRAINT uq_work_locations_code_effective_start_date UNIQUE (work_location_code, effective_start_date);
ALTER TABLE employee_foundation.zones ADD CONSTRAINT zones_pkey PRIMARY KEY (id);
ALTER TABLE employee_foundation.zones ADD CONSTRAINT zones_zone_code_key UNIQUE (zone_code);
ALTER TABLE employee_management.change_log ADD CONSTRAINT change_log_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.consent ADD CONSTRAINT consent_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.ec_documents ADD CONSTRAINT ec_documents_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_compensation ADD CONSTRAINT employment_compensation_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_compensation_detail ADD CONSTRAINT employment_compensation_detail_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_cost_distribution ADD CONSTRAINT employment_cost_distribution_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_cost_distribution_item ADD CONSTRAINT employment_cost_distribution_item_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_information ADD CONSTRAINT employment_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_information ADD CONSTRAINT emp_employment_key UNIQUE (person_id, user_id);
ALTER TABLE employee_management.employment_job ADD CONSTRAINT employment_job_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_job_relationships ADD CONSTRAINT employment_job_relationships_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_termination ADD CONSTRAINT employment_termination_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.employment_work_permit ADD CONSTRAINT employment_work_permit_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_address ADD CONSTRAINT person_address_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_config_bank ADD CONSTRAINT person_config_bank_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_config_position ADD CONSTRAINT person_config_position_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_email ADD CONSTRAINT person_email_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_emergency_contacts ADD CONSTRAINT person_emergency_contacts_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_emergency_contacts ADD CONSTRAINT per_emergency_contacts_key UNIQUE (contact_name, person_id, relationship, effective_start_date);
ALTER TABLE employee_management.person_formal_education ADD CONSTRAINT person_formal_education_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_global_info ADD CONSTRAINT person_global_info_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_information ADD CONSTRAINT person_information_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_national_id ADD CONSTRAINT person_national_id_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_phone ADD CONSTRAINT person_phone_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_relationship ADD CONSTRAINT person_relationship_pkey PRIMARY KEY (id);
ALTER TABLE employee_management.person_relationship ADD CONSTRAINT per_person_relationship_key UNIQUE (person_id, related_person_id, relationship_type, effective_start_date);
ALTER TABLE employee_management.person_social_account ADD CONSTRAINT person_social_account_pkey PRIMARY KEY (id);
ALTER TABLE foundation."SequelizeMeta_foundation" ADD CONSTRAINT "SequelizeMeta_foundation_pkey" PRIMARY KEY (name);
ALTER TABLE foundation.bands ADD CONSTRAINT bands_pkey PRIMARY KEY (id);
ALTER TABLE foundation.bands ADD CONSTRAINT bands_band_code_key UNIQUE (band_code);
ALTER TABLE foundation.brands ADD CONSTRAINT brands_pkey PRIMARY KEY (id);
ALTER TABLE foundation.brands ADD CONSTRAINT brands_brand_code_key UNIQUE (brand_code);
ALTER TABLE foundation.business_groups ADD CONSTRAINT business_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_groups ADD CONSTRAINT business_groups_business_group_code_key UNIQUE (business_group_code);
ALTER TABLE foundation.business_unit_companies ADD CONSTRAINT business_unit_companies_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_divisions ADD CONSTRAINT business_unit_divisions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_groups_of_standard_function ADD CONSTRAINT business_unit_groups_of_standard_function_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_section_groups ADD CONSTRAINT business_unit_section_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_standard_functions ADD CONSTRAINT business_unit_standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_store_formats ADD CONSTRAINT business_unit_store_formats_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_sub_functions ADD CONSTRAINT business_unit_sub_functions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_unit_sub_organizations ADD CONSTRAINT business_unit_sub_organizations_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_units ADD CONSTRAINT business_units_pkey PRIMARY KEY (id);
ALTER TABLE foundation.business_units ADD CONSTRAINT uq_business_units_code_effective_start_date UNIQUE (business_unit_code, effective_start_date);
ALTER TABLE foundation.companies ADD CONSTRAINT companies_pkey PRIMARY KEY (id);
ALTER TABLE foundation.companies ADD CONSTRAINT uq_companies_code_effective_start_date UNIQUE (company_code, effective_start_date);
ALTER TABLE foundation.corporate_title ADD CONSTRAINT corporate_title_pkey PRIMARY KEY (id);
ALTER TABLE foundation.corporate_title ADD CONSTRAINT corporate_title_code_key UNIQUE (code);
ALTER TABLE foundation.cost_centers ADD CONSTRAINT cost_centers_pkey PRIMARY KEY (id);
ALTER TABLE foundation.cost_centers ADD CONSTRAINT uq_cost_centers_code_effective_start_date UNIQUE (cost_center_code, effective_start_date);
ALTER TABLE foundation.country_groups ADD CONSTRAINT country_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.currencies ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);
ALTER TABLE foundation.currencies ADD CONSTRAINT currencies_currency_code_key UNIQUE (currency_code);
ALTER TABLE foundation.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE foundation.departments ADD CONSTRAINT uq_departments_code_effective_start_date UNIQUE (department_code, effective_start_date);
ALTER TABLE foundation.divisions ADD CONSTRAINT divisions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.divisions ADD CONSTRAINT uq_divisions_code_effective_start_date UNIQUE (division_code, effective_start_date);
ALTER TABLE foundation.employee_group_employee_subgroups ADD CONSTRAINT employee_group_employee_subgroups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.employee_groups ADD CONSTRAINT employee_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.employee_groups ADD CONSTRAINT employee_groups_employee_group_code_key UNIQUE (employee_group_code);
ALTER TABLE foundation.employee_subgroups ADD CONSTRAINT employee_subgroups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.employee_subgroups ADD CONSTRAINT employee_subgroups_employee_subgroup_code_key UNIQUE (employee_subgroup_code);
ALTER TABLE foundation.event_reasons ADD CONSTRAINT event_reasons_pkey PRIMARY KEY (id);
ALTER TABLE foundation.event_reasons ADD CONSTRAINT uq_event_reasons_code_effective_start_date UNIQUE (event_reason_code, effective_start_date);
ALTER TABLE foundation.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE foundation.events ADD CONSTRAINT events_event_code_key UNIQUE (event_code);
ALTER TABLE foundation.frequencies ADD CONSTRAINT frequencies_pkey PRIMARY KEY (id);
ALTER TABLE foundation.frequencies ADD CONSTRAINT frequencies_frequency_code_key UNIQUE (frequency_code);
ALTER TABLE foundation."group" ADD CONSTRAINT group_pkey PRIMARY KEY (id);
ALTER TABLE foundation."group" ADD CONSTRAINT group_code_key UNIQUE (code);
ALTER TABLE foundation.groups_of_standard_functions ADD CONSTRAINT groups_of_standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.groups_of_standard_functions ADD CONSTRAINT uq_groups_of_standard_functions_code_effective_start_date UNIQUE (group_of_standard_function_code, effective_start_date);
ALTER TABLE foundation.hr_districts ADD CONSTRAINT hr_districts_pkey PRIMARY KEY (id);
ALTER TABLE foundation.hr_districts ADD CONSTRAINT hr_districts_hr_district_code_key UNIQUE (hr_district_code);
ALTER TABLE foundation.job_catalogs ADD CONSTRAINT job_catalogs_pkey PRIMARY KEY (id);
ALTER TABLE foundation.job_catalogs ADD CONSTRAINT job_catalogs_job_catalog_code_key UNIQUE (job_catalog_code);
ALTER TABLE foundation.job_codes ADD CONSTRAINT job_codes_pkey PRIMARY KEY (id);
ALTER TABLE foundation.job_codes ADD CONSTRAINT uq_job_codes_code_effective_start_date UNIQUE (job_code_code, effective_start_date);
ALTER TABLE foundation.job_families ADD CONSTRAINT job_families_pkey PRIMARY KEY (id);
ALTER TABLE foundation.job_families ADD CONSTRAINT job_families_job_family_code_key UNIQUE (job_family_code);
ALTER TABLE foundation.job_type ADD CONSTRAINT job_type_pkey PRIMARY KEY (id);
ALTER TABLE foundation.job_type ADD CONSTRAINT job_type_code_key UNIQUE (code);
ALTER TABLE foundation.master_countries ADD CONSTRAINT master_countries_pkey PRIMARY KEY (id);
ALTER TABLE foundation.master_countries ADD CONSTRAINT master_countries_country_code_key UNIQUE (country_code);
ALTER TABLE foundation.national_id_card_type ADD CONSTRAINT national_id_card_type_pkey PRIMARY KEY (id);
ALTER TABLE foundation.national_id_card_type ADD CONSTRAINT national_id_card_type_card_type_code_key UNIQUE (card_type_code);
ALTER TABLE foundation.pay_component_groups ADD CONSTRAINT pay_component_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_component_groups ADD CONSTRAINT pay_component_groups_pay_component_group_code_key UNIQUE (pay_component_group_code);
ALTER TABLE foundation.pay_components ADD CONSTRAINT pay_components_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_components ADD CONSTRAINT pay_components_pay_component_code_key UNIQUE (pay_component_code);
ALTER TABLE foundation.pay_grades ADD CONSTRAINT pay_grades_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_grades ADD CONSTRAINT pay_grades_pay_grade_code_key UNIQUE (pay_grade_code);
ALTER TABLE foundation.pay_groups ADD CONSTRAINT pay_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_groups ADD CONSTRAINT uq_pay_groups_code_effective_start_date UNIQUE (pay_group_code, effective_start_date);
ALTER TABLE foundation.pay_scale_areas ADD CONSTRAINT pay_scale_areas_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_scale_areas ADD CONSTRAINT pay_scale_areas_pay_scale_area_code_key UNIQUE (pay_scale_area_code);
ALTER TABLE foundation.pay_scale_groups ADD CONSTRAINT pay_scale_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_scale_groups ADD CONSTRAINT pay_scale_groups_pay_scale_group_code_key UNIQUE (pay_scale_group_code);
ALTER TABLE foundation.pay_scale_levels ADD CONSTRAINT pay_scale_levels_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_scale_levels ADD CONSTRAINT pay_scale_levels_pay_scale_level_code_key UNIQUE (pay_scale_level_code);
ALTER TABLE foundation.pay_scale_types ADD CONSTRAINT pay_scale_types_pkey PRIMARY KEY (id);
ALTER TABLE foundation.pay_scale_types ADD CONSTRAINT pay_scale_types_pay_scale_type_code_key UNIQUE (pay_scale_type_code);
ALTER TABLE foundation.picking_lists ADD CONSTRAINT picking_lists_pkey PRIMARY KEY (id);
ALTER TABLE foundation.position_matrix_relationships ADD CONSTRAINT position_matrix_relationships_pkey PRIMARY KEY (id);
ALTER TABLE foundation.positions ADD CONSTRAINT positions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.section_groups ADD CONSTRAINT section_groups_pkey PRIMARY KEY (id);
ALTER TABLE foundation.section_groups ADD CONSTRAINT section_groups_section_group_code_key UNIQUE (section_group_code);
ALTER TABLE foundation.sso_locations ADD CONSTRAINT sso_locations_pkey PRIMARY KEY (id);
ALTER TABLE foundation.sso_locations ADD CONSTRAINT sso_locations_sso_location_code_key UNIQUE (sso_location_code);
ALTER TABLE foundation.standard_functions ADD CONSTRAINT standard_functions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.standard_functions ADD CONSTRAINT standard_functions_standard_function_code_key UNIQUE (standard_function_code);
ALTER TABLE foundation.store_branch_locations ADD CONSTRAINT store_branch_locations_pkey PRIMARY KEY (id);
ALTER TABLE foundation.store_branch_locations ADD CONSTRAINT uq_store_branch_locations_code_effective_start_date UNIQUE (store_branch_location_code, effective_start_date);
ALTER TABLE foundation.store_formats ADD CONSTRAINT store_formats_pkey PRIMARY KEY (id);
ALTER TABLE foundation.store_formats ADD CONSTRAINT store_formats_store_format_code_key UNIQUE (store_format_code);
ALTER TABLE foundation.sub_functions ADD CONSTRAINT sub_functions_pkey PRIMARY KEY (id);
ALTER TABLE foundation.sub_functions ADD CONSTRAINT sub_functions_sub_function_code_key UNIQUE (sub_function_code);
ALTER TABLE foundation.sub_organizations ADD CONSTRAINT sub_organizations_pkey PRIMARY KEY (id);
ALTER TABLE foundation.sub_organizations ADD CONSTRAINT sub_organizations_sub_organization_code_key UNIQUE (sub_organization_code);
ALTER TABLE foundation.work_location_geofences ADD CONSTRAINT work_location_geofences_pkey PRIMARY KEY (id);
ALTER TABLE foundation.work_locations ADD CONSTRAINT work_locations_pkey PRIMARY KEY (id);
ALTER TABLE foundation.work_locations ADD CONSTRAINT uq_work_locations_code_effective_start_date UNIQUE (work_location_code, effective_start_date);
ALTER TABLE foundation.zones ADD CONSTRAINT zones_pkey PRIMARY KEY (id);
ALTER TABLE foundation.zones ADD CONSTRAINT zones_zone_code_key UNIQUE (zone_code);
ALTER TABLE grim.agent_logs ADD CONSTRAINT agent_logs_pkey PRIMARY KEY (id);
ALTER TABLE grim.agent_logs ADD CONSTRAINT agent_logs_event_category_check CHECK ((event_category = ANY (ARRAY['hook'::text, 'response'::text, 'adw_step'::text])));
ALTER TABLE grim.agent_logs ADD CONSTRAINT agent_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES grim.agents(id) ON DELETE CASCADE;
ALTER TABLE grim.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
ALTER TABLE grim.agents ADD CONSTRAINT unique_agent_name_per_orchestrator UNIQUE (orchestrator_agent_id, name);
ALTER TABLE grim.agents ADD CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'executing'::text, 'waiting'::text, 'blocked'::text, 'complete'::text])));
ALTER TABLE grim.agents ADD CONSTRAINT agents_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.ai_developer_workflows ADD CONSTRAINT ai_developer_workflows_pkey PRIMARY KEY (id);
ALTER TABLE grim.ai_developer_workflows ADD CONSTRAINT ai_developer_workflows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE grim.ai_developer_workflows ADD CONSTRAINT ai_developer_workflows_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.catalogs ADD CONSTRAINT catalogs_pkey PRIMARY KEY (id);
ALTER TABLE grim.catalogs ADD CONSTRAINT catalogs_source_check CHECK ((source = ANY (ARRAY['qa_catalog'::text, 'user_feedback'::text])));
ALTER TABLE grim.catalogs ADD CONSTRAINT catalogs_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.check_collections ADD CONSTRAINT check_collections_pkey PRIMARY KEY (id);
ALTER TABLE grim.check_collections ADD CONSTRAINT check_collections_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.oracle_requests ADD CONSTRAINT oracle_requests_pkey PRIMARY KEY (id);
ALTER TABLE grim.oracle_requests ADD CONSTRAINT oracle_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fulfilled'::text, 'dismissed'::text])));
ALTER TABLE grim.oracle_requests ADD CONSTRAINT oracle_requests_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES grim.verifications(id) ON DELETE CASCADE;
ALTER TABLE grim.orchestrator_agents ADD CONSTRAINT orchestrator_agents_pkey PRIMARY KEY (id);
ALTER TABLE grim.orchestrator_agents ADD CONSTRAINT orchestrator_agents_session_id_key UNIQUE (session_id);
ALTER TABLE grim.orchestrator_agents ADD CONSTRAINT orchestrator_agents_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'executing'::text, 'waiting'::text, 'blocked'::text, 'complete'::text])));
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT orchestrator_chat_pkey PRIMARY KEY (id);
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT agent_id_required_for_agents CHECK ((((sender_type = 'agent'::text) OR (receiver_type = 'agent'::text)) = (agent_id IS NOT NULL)));
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT orchestrator_chat_receiver_type_check CHECK ((receiver_type = ANY (ARRAY['user'::text, 'orchestrator'::text, 'agent'::text])));
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT orchestrator_chat_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'orchestrator'::text, 'agent'::text])));
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT orchestrator_chat_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES grim.agents(id) ON DELETE CASCADE;
ALTER TABLE grim.orchestrator_chat ADD CONSTRAINT orchestrator_chat_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.prompts ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);
ALTER TABLE grim.prompts ADD CONSTRAINT prompts_author_check CHECK ((author = ANY (ARRAY['engineer'::text, 'orchestrator_agent'::text])));
ALTER TABLE grim.prompts ADD CONSTRAINT prompts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES grim.agents(id) ON DELETE CASCADE;
ALTER TABLE grim.regression_chain_steps ADD CONSTRAINT regression_chain_steps_pkey PRIMARY KEY (id);
ALTER TABLE grim.regression_chain_steps ADD CONSTRAINT regression_chain_steps_unique_index UNIQUE (chain_id, step_index);
ALTER TABLE grim.regression_chain_steps ADD CONSTRAINT regression_chain_steps_chain_id_fkey FOREIGN KEY (chain_id) REFERENCES grim.regression_chains(id) ON DELETE CASCADE;
ALTER TABLE grim.regression_chains ADD CONSTRAINT regression_chains_pkey PRIMARY KEY (id);
ALTER TABLE grim.regression_chains ADD CONSTRAINT regression_chains_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.regression_chains ADD CONSTRAINT regression_chains_source_verification_id_fkey FOREIGN KEY (source_verification_id) REFERENCES grim.verifications(id) ON DELETE SET NULL;
ALTER TABLE grim.regression_checks ADD CONSTRAINT regression_checks_pkey PRIMARY KEY (id);
ALTER TABLE grim.regression_checks ADD CONSTRAINT regression_checks_last_verdict_check CHECK (((last_verdict IS NULL) OR (last_verdict = ANY (ARRAY['PASS'::text, 'FAIL'::text, 'ORACLE_UNAVAILABLE'::text, 'REFUSED'::text, 'BLOCKED'::text]))));
ALTER TABLE grim.regression_checks ADD CONSTRAINT regression_checks_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE grim.regression_checks ADD CONSTRAINT regression_checks_source_verification_id_fkey FOREIGN KEY (source_verification_id) REFERENCES grim.verifications(id) ON DELETE SET NULL;
ALTER TABLE grim.system_logs ADD CONSTRAINT system_logs_pkey PRIMARY KEY (id);
ALTER TABLE grim.system_logs ADD CONSTRAINT system_logs_level_check CHECK ((level = ANY (ARRAY['DEBUG'::text, 'INFO'::text, 'WARNING'::text, 'ERROR'::text])));
ALTER TABLE grim.verification_checks ADD CONSTRAINT verification_checks_pkey PRIMARY KEY (id);
ALTER TABLE grim.verification_checks ADD CONSTRAINT verification_checks_verdict_check CHECK ((verdict = ANY (ARRAY['PASS'::text, 'FAIL'::text, 'ORACLE_UNAVAILABLE'::text, 'REFUSED'::text, 'BLOCKED'::text])));
ALTER TABLE grim.verification_checks ADD CONSTRAINT verification_checks_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES grim.verifications(id) ON DELETE CASCADE;
ALTER TABLE grim.verification_schedules ADD CONSTRAINT verification_schedules_pkey PRIMARY KEY (id);
ALTER TABLE grim.verification_schedules ADD CONSTRAINT verification_schedules_frequency_check CHECK ((frequency = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekly'::text, 'monthly'::text])));
ALTER TABLE grim.verification_schedules ADD CONSTRAINT verification_schedules_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'finished'::text])));
ALTER TABLE grim.verification_schedules ADD CONSTRAINT verification_schedules_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES grim.check_collections(id) ON DELETE CASCADE;
ALTER TABLE grim.verifications ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);
ALTER TABLE grim.verifications ADD CONSTRAINT verifications_confidence_check CHECK ((confidence = ANY (ARRAY['PERFECT'::text, 'VERIFIED'::text, 'PARTIAL'::text, 'FEEDBACK'::text, 'FAILED'::text])));
ALTER TABLE grim.verifications ADD CONSTRAINT verifications_status_check CHECK ((status = ANY (ARRAY['verified'::text, 'failed'::text, 'unsure'::text])));
ALTER TABLE grim.verifications ADD CONSTRAINT verifications_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES grim.agents(id) ON DELETE CASCADE;
ALTER TABLE grim.verifications ADD CONSTRAINT verifications_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES grim.orchestrator_agents(id) ON DELETE CASCADE;
ALTER TABLE notification."SequelizeMeta_notification" ADD CONSTRAINT "SequelizeMeta_notification_pkey" PRIMARY KEY (name);
ALTER TABLE notification.notification_history ADD CONSTRAINT notification_history_pkey PRIMARY KEY (id);
ALTER TABLE notification.notification_templates ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);
ALTER TABLE notification.notification_templates ADD CONSTRAINT notification_templates_code_key UNIQUE (code);
ALTER TABLE notification.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE payroll.approval_requests ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);
ALTER TABLE payroll.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE payroll.bank_transfer_files ADD CONSTRAINT bank_transfer_files_pkey PRIMARY KEY (id);
ALTER TABLE payroll.control_records ADD CONSTRAINT control_records_pkey PRIMARY KEY (id);
ALTER TABLE payroll.control_records ADD CONSTRAINT control_records_payroll_area_code_period_key_key UNIQUE (payroll_area_code, period_key);
ALTER TABLE payroll.control_records ADD CONSTRAINT control_records_company_code_fkey FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll.control_records ADD CONSTRAINT control_records_payroll_area_code_fkey FOREIGN KEY (payroll_area_code) REFERENCES payroll_config.payroll_area(payroll_area_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll.employee_leave_entries ADD CONSTRAINT pk_employee_leave_entries PRIMARY KEY (id);
ALTER TABLE payroll.employee_leave_entries ADD CONSTRAINT uq_employee_leave_entries UNIQUE (company_code, employee_code, leave_date, leave_code, wage_type_code);
ALTER TABLE payroll.employee_leave_entries ADD CONSTRAINT employee_leave_entries_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll.employee_retro_entries ADD CONSTRAINT uq_emp_retro_entries_key UNIQUE (company_code, employee_code, period_key, wage_type, original_period);
ALTER TABLE payroll.employee_retro_entries ADD CONSTRAINT employee_retro_entries_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll.employee_time_entries ADD CONSTRAINT employee_time_entries_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll.employees ADD CONSTRAINT employees_pkey PRIMARY KEY (id);
ALTER TABLE payroll.employees ADD CONSTRAINT employees_employee_code_key UNIQUE (company_code, employee_code);
ALTER TABLE payroll.hr_core_sync_errors ADD CONSTRAINT hr_core_sync_errors_pkey PRIMARY KEY (id);
ALTER TABLE payroll.hr_core_sync_errors ADD CONSTRAINT hr_core_sync_errors_entity_check CHECK ((entity = ANY (ARRAY['employees'::text, 'assignments'::text])));
ALTER TABLE payroll.hr_core_sync_errors ADD CONSTRAINT hr_core_sync_errors_run_id_fkey FOREIGN KEY (run_id) REFERENCES payroll.hr_core_sync_runs(id) ON DELETE CASCADE;
ALTER TABLE payroll.hr_core_sync_runs ADD CONSTRAINT hr_core_sync_runs_pkey PRIMARY KEY (id);
ALTER TABLE payroll.hr_core_sync_runs ADD CONSTRAINT hr_core_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])));
ALTER TABLE payroll.hr_core_sync_runs ADD CONSTRAINT hr_core_sync_runs_triggered_by_check CHECK ((triggered_by = ANY (ARRAY['scheduler'::text, 'manual'::text])));
ALTER TABLE payroll.integration_jobs ADD CONSTRAINT integration_jobs_pkey PRIMARY KEY (id);
ALTER TABLE payroll.manual_wage_adjustments ADD CONSTRAINT manual_wage_adjustments_pkey PRIMARY KEY (id);
ALTER TABLE payroll.manual_wage_adjustments ADD CONSTRAINT manual_wage_adjustments_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.manual_wage_adjustments ADD CONSTRAINT manual_wage_adjustments_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id);
ALTER TABLE payroll.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE payroll.notifications ADD CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['JOB_FAILED'::text, 'JOB_COMPLETED'::text, 'APPROVAL_NEEDED'::text, 'DEADLINE'::text, 'ERROR_THRESHOLD'::text])));
ALTER TABLE payroll.off_cycle_requests ADD CONSTRAINT off_cycle_requests_pkey PRIMARY KEY (id);
ALTER TABLE payroll.off_cycle_requests ADD CONSTRAINT off_cycle_requests_run_type_check CHECK ((run_type = ANY (ARRAY['BONUS'::text, 'CORRECTION'::text, 'SUPPLEMENTARY'::text, 'OTHER'::text])));
ALTER TABLE payroll.off_cycle_requests ADD CONSTRAINT off_cycle_requests_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'COMPLETED'::text])));
ALTER TABLE payroll.off_cycle_requests ADD CONSTRAINT off_cycle_requests_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.off_cycle_requests ADD CONSTRAINT off_cycle_requests_payroll_area_code_fkey FOREIGN KEY (payroll_area_code) REFERENCES payroll_config.payroll_area(payroll_area_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll.payroll_result_items ADD CONSTRAINT payroll_result_items_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_result_items ADD CONSTRAINT payroll_result_items_payroll_result_id_fkey FOREIGN KEY (payroll_result_id) REFERENCES payroll.payroll_results(id) ON DELETE CASCADE;
ALTER TABLE payroll.payroll_result_tax_accum ADD CONSTRAINT payroll_result_tax_accum_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_result_tax_accum ADD CONSTRAINT payroll_result_tax_accum_payroll_result_id_key UNIQUE (payroll_result_id);
ALTER TABLE payroll.payroll_result_tax_accum ADD CONSTRAINT payroll_result_tax_accum_payroll_result_id_fkey FOREIGN KEY (payroll_result_id) REFERENCES payroll.payroll_results(id) ON DELETE CASCADE;
ALTER TABLE payroll.payroll_results ADD CONSTRAINT payroll_results_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_results ADD CONSTRAINT payroll_results_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.payroll_results ADD CONSTRAINT payroll_results_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id) ON DELETE CASCADE;
ALTER TABLE payroll.payroll_run_logs ADD CONSTRAINT payroll_run_logs_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_run_logs ADD CONSTRAINT payroll_run_logs_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.payroll_run_logs ADD CONSTRAINT payroll_run_logs_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES payroll.payroll_run_logs(id);
ALTER TABLE payroll.payroll_run_logs ADD CONSTRAINT payroll_run_logs_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id) ON DELETE CASCADE;
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT ck_payroll_runs_run_scope CHECK (((run_scope)::text = ANY ((ARRAY['AREA'::character varying, 'INCLUDE'::character varying, 'EXCLUDE'::character varying])::text[])));
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT ck_payroll_runs_scope_codes CHECK ((((run_scope)::text = 'AREA'::text) = (scope_employee_codes IS NULL)));
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT payroll_runs_company_code_fkey FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT payroll_runs_control_record_id_fkey FOREIGN KEY (control_record_id) REFERENCES payroll.control_records(id);
ALTER TABLE payroll.payroll_runs ADD CONSTRAINT payroll_runs_payroll_area_code_fkey FOREIGN KEY (payroll_area_code) REFERENCES payroll_config.payroll_area(payroll_area_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll.payroll_ytd_opening_balances ADD CONSTRAINT payroll_ytd_opening_balances_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payroll_ytd_opening_balances ADD CONSTRAINT uq_ytd_opening_emp_year UNIQUE (employee_code, tax_year);
ALTER TABLE payroll.payslip_form_templates ADD CONSTRAINT payslip_form_templates_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payslip_form_templates ADD CONSTRAINT payslip_form_templates_name_key UNIQUE (name);
ALTER TABLE payroll.payslips ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);
ALTER TABLE payroll.payslips ADD CONSTRAINT payslips_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.payslips ADD CONSTRAINT payslips_payroll_result_id_fkey FOREIGN KEY (payroll_result_id) REFERENCES payroll.payroll_results(id) ON DELETE CASCADE;
ALTER TABLE payroll.posting_batches ADD CONSTRAINT posting_batches_pkey PRIMARY KEY (id);
ALTER TABLE payroll.posting_batches ADD CONSTRAINT posting_batches_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id);
ALTER TABLE payroll.posting_lines ADD CONSTRAINT posting_lines_pkey PRIMARY KEY (id);
ALTER TABLE payroll.posting_lines ADD CONSTRAINT posting_lines_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.posting_lines ADD CONSTRAINT posting_lines_posting_batch_id_fkey FOREIGN KEY (posting_batch_id) REFERENCES payroll.posting_batches(id) ON DELETE CASCADE;
ALTER TABLE payroll.retro_results ADD CONSTRAINT retro_results_pkey PRIMARY KEY (id);
ALTER TABLE payroll.retro_results ADD CONSTRAINT retro_results_adjusted_result_id_fkey FOREIGN KEY (adjusted_result_id) REFERENCES payroll.payroll_results(id) ON DELETE CASCADE;
ALTER TABLE payroll.retro_results ADD CONSTRAINT retro_results_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.retro_results ADD CONSTRAINT retro_results_original_result_id_fkey FOREIGN KEY (original_result_id) REFERENCES payroll.payroll_results(id) ON DELETE CASCADE;
ALTER TABLE payroll.retro_results ADD CONSTRAINT retro_results_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id) ON DELETE CASCADE;
ALTER TABLE payroll.run_employee_results ADD CONSTRAINT run_employee_results_pkey PRIMARY KEY (id);
ALTER TABLE payroll.run_employee_results ADD CONSTRAINT run_employee_results_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll.run_employee_results ADD CONSTRAINT run_employee_results_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll.payroll_runs(id) ON DELETE CASCADE;
ALTER TABLE payroll.schema_migrations ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);
ALTER TABLE payroll.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE payroll.user_roles ADD CONSTRAINT user_roles_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES payroll.users(id);
ALTER TABLE payroll.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES payroll.users(id) ON DELETE CASCADE;
ALTER TABLE payroll.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE payroll.users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE payroll.users ADD CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['OFFICER'::text, 'ADMIN'::text, 'AUDITOR'::text])));
ALTER TABLE payroll_config.bank_file_format ADD CONSTRAINT bank_file_format_pkey PRIMARY KEY (file_format_code);
ALTER TABLE payroll_config.company ADD CONSTRAINT pk_company PRIMARY KEY (company_code);
ALTER TABLE payroll_config.company ADD CONSTRAINT fk_company_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.company_bank_account ADD CONSTRAINT company_bank_account_pkey PRIMARY KEY (id);
ALTER TABLE payroll_config.company_bank_account ADD CONSTRAINT company_bank_account_file_format_code_fkey FOREIGN KEY (file_format_code) REFERENCES payroll_config.bank_file_format(file_format_code);
ALTER TABLE payroll_config.company_branch ADD CONSTRAINT pk_company_branch PRIMARY KEY (company_code, branch_code);
ALTER TABLE payroll_config.company_branch ADD CONSTRAINT fk_company_branch_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.company_branch_profile ADD CONSTRAINT pk_company_branch_profile PRIMARY KEY (id);
ALTER TABLE payroll_config.company_branch_profile ADD CONSTRAINT uq_company_branch_profile UNIQUE (company_code, branch_code, effective_start_date);
ALTER TABLE payroll_config.company_branch_profile ADD CONSTRAINT fk_company_branch_profile_branch FOREIGN KEY (company_code, branch_code) REFERENCES payroll_config.company_branch(company_code, branch_code);
ALTER TABLE payroll_config.company_profile ADD CONSTRAINT pk_company_profile PRIMARY KEY (id);
ALTER TABLE payroll_config.company_profile ADD CONSTRAINT uq_company_profile_code_date UNIQUE (company_code, effective_start_date);
ALTER TABLE payroll_config.company_profile ADD CONSTRAINT fk_company_profile_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.company_profile ADD CONSTRAINT fk_company_profile_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.company_social_security_location ADD CONSTRAINT pk_company_ss_location PRIMARY KEY (id);
ALTER TABLE payroll_config.company_social_security_location ADD CONSTRAINT uq_company_ss_location UNIQUE (company_code, social_security_location_code, effective_start_date);
ALTER TABLE payroll_config.company_social_security_location ADD CONSTRAINT fk_company_ss_location_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.country ADD CONSTRAINT pk_country PRIMARY KEY (country_code);
ALTER TABLE payroll_config.employee_group ADD CONSTRAINT pk_employee_group PRIMARY KEY (employee_group_id);
ALTER TABLE payroll_config.employee_group ADD CONSTRAINT uq_employee_group_code UNIQUE (country_code, employee_group_code);
ALTER TABLE payroll_config.employee_group ADD CONSTRAINT fk_employee_group_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.employee_group_mapping ADD CONSTRAINT pk_employee_group_mapping PRIMARY KEY (id);
ALTER TABLE payroll_config.employee_group_mapping ADD CONSTRAINT uq_employee_group_mapping UNIQUE (country_code, employee_group_code, employee_subgroup_code);
ALTER TABLE payroll_config.employee_group_mapping ADD CONSTRAINT fk_egm_group FOREIGN KEY (country_code, employee_group_code) REFERENCES payroll_config.employee_group(country_code, employee_group_code);
ALTER TABLE payroll_config.employee_group_mapping ADD CONSTRAINT fk_egm_subgroup FOREIGN KEY (country_code, employee_subgroup_code) REFERENCES payroll_config.employee_subgroup(country_code, employee_subgroup_code);
ALTER TABLE payroll_config.employee_subgroup ADD CONSTRAINT pk_employee_subgroup PRIMARY KEY (employee_subgroup_id);
ALTER TABLE payroll_config.employee_subgroup ADD CONSTRAINT uq_employee_subgroup_code UNIQUE (country_code, employee_subgroup_code);
ALTER TABLE payroll_config.employee_subgroup ADD CONSTRAINT fk_employee_subgroup_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.employee_type ADD CONSTRAINT pk_employee_type PRIMARY KEY (employee_type_id);
ALTER TABLE payroll_config.employee_type ADD CONSTRAINT uq_employee_type_code UNIQUE (country_code, employee_type_code);
ALTER TABLE payroll_config.employee_type ADD CONSTRAINT fk_employee_type_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.employee_type_group ADD CONSTRAINT pk_employee_type_group PRIMARY KEY (employee_type_group_id);
ALTER TABLE payroll_config.employee_type_group ADD CONSTRAINT uq_employee_type_group UNIQUE (country_code, employee_group_code, employee_subgroup_code, employee_type_code);
ALTER TABLE payroll_config.employee_type_group ADD CONSTRAINT fk_etg_mapping FOREIGN KEY (country_code, employee_group_code, employee_subgroup_code) REFERENCES payroll_config.employee_group_mapping(country_code, employee_group_code, employee_subgroup_code);
ALTER TABLE payroll_config.employee_type_group ADD CONSTRAINT fk_etg_type FOREIGN KEY (country_code, employee_type_code) REFERENCES payroll_config.employee_type(country_code, employee_type_code);
ALTER TABLE payroll_config.fund_plan ADD CONSTRAINT pk_fund_plan PRIMARY KEY (fund_plan_id);
ALTER TABLE payroll_config.fund_plan ADD CONSTRAINT uq_fund_plan_type_code UNIQUE (country_code, fund_type_code, fund_plan_code);
ALTER TABLE payroll_config.fund_plan ADD CONSTRAINT fk_fund_plan_type FOREIGN KEY (country_code, fund_type_code) REFERENCES payroll_config.fund_type(country_code, fund_type_code);
ALTER TABLE payroll_config.fund_profile ADD CONSTRAINT pk_fund_profile PRIMARY KEY (fund_profile_id);
ALTER TABLE payroll_config.fund_profile ADD CONSTRAINT uq_fund_profile_per_company UNIQUE (company_code, fund_type_code, effective_start_date);
ALTER TABLE payroll_config.fund_profile ADD CONSTRAINT fk_fund_profile_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.fund_profile ADD CONSTRAINT fk_fund_profile_type FOREIGN KEY (country_code, fund_type_code) REFERENCES payroll_config.fund_type(country_code, fund_type_code);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT pk_fund_rate PRIMARY KEY (fund_rate_id);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT uq_fund_rate UNIQUE (company_code, fund_type_code, employee_group_code, employee_subgroup_code, service_year_from, effective_start_date);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT fk_fund_rate_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT fk_fund_rate_group FOREIGN KEY (country_code, employee_group_code) REFERENCES payroll_config.employee_group(country_code, employee_group_code);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT fk_fund_rate_subgroup FOREIGN KEY (country_code, employee_subgroup_code) REFERENCES payroll_config.employee_subgroup(country_code, employee_subgroup_code);
ALTER TABLE payroll_config.fund_rate ADD CONSTRAINT fk_fund_rate_type FOREIGN KEY (country_code, fund_type_code) REFERENCES payroll_config.fund_type(country_code, fund_type_code);
ALTER TABLE payroll_config.fund_type ADD CONSTRAINT pk_fund_type PRIMARY KEY (fund_type_id);
ALTER TABLE payroll_config.fund_type ADD CONSTRAINT uq_fund_type_per_country UNIQUE (country_code, fund_type_code);
ALTER TABLE payroll_config.fund_type ADD CONSTRAINT fk_fund_type_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.leave_full_month ADD CONSTRAINT pk_leave_full_month PRIMARY KEY (leave_full_month_id);
ALTER TABLE payroll_config.leave_full_month ADD CONSTRAINT uq_leave_full_month_code UNIQUE (leave_code);
ALTER TABLE payroll_config.pay_frequency ADD CONSTRAINT pk_pay_frequency PRIMARY KEY (pay_frequency_code);
ALTER TABLE payroll_config.payday_rule ADD CONSTRAINT pk_payday_rule PRIMARY KEY (payday_rule_id);
ALTER TABLE payroll_config.payday_rule ADD CONSTRAINT uq_payday_rule_code UNIQUE (country_code, payday_rule_code);
ALTER TABLE payroll_config.payday_rule ADD CONSTRAINT fk_payday_rule_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.payroll_area ADD CONSTRAINT pk_payroll_area PRIMARY KEY (payroll_area_id);
ALTER TABLE payroll_config.payroll_area ADD CONSTRAINT uq_payroll_area_code UNIQUE (payroll_area_code);
ALTER TABLE payroll_config.payroll_area ADD CONSTRAINT fk_payroll_area_emp_type FOREIGN KEY (country_code, employee_type_code) REFERENCES payroll_config.employee_type(country_code, employee_type_code);
ALTER TABLE payroll_config.payroll_area ADD CONSTRAINT fk_payroll_area_payday_rule FOREIGN KEY (country_code, payday_rule_code) REFERENCES payroll_config.payday_rule(country_code, payday_rule_code);
ALTER TABLE payroll_config.payroll_area ADD CONSTRAINT fk_payroll_area_period_pattern FOREIGN KEY (country_code, period_pattern_code) REFERENCES payroll_config.period_pattern(country_code, period_pattern_code);
ALTER TABLE payroll_config.payroll_area_company ADD CONSTRAINT pk_payroll_area_company PRIMARY KEY (payroll_area_company_id);
ALTER TABLE payroll_config.payroll_area_company ADD CONSTRAINT uq_payroll_area_company UNIQUE (payroll_area_id, company_code);
ALTER TABLE payroll_config.payroll_area_company ADD CONSTRAINT fk_pac_area FOREIGN KEY (payroll_area_id) REFERENCES payroll_config.payroll_area(payroll_area_id);
ALTER TABLE payroll_config.payroll_area_company ADD CONSTRAINT fk_pac_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.payroll_period ADD CONSTRAINT pk_payroll_period PRIMARY KEY (payroll_period_id);
ALTER TABLE payroll_config.payroll_period ADD CONSTRAINT uq_payroll_period_sequence UNIQUE (payroll_area_id, payroll_year, payroll_month, period_sequence);
ALTER TABLE payroll_config.payroll_period ADD CONSTRAINT fk_payroll_period_area FOREIGN KEY (payroll_area_id) REFERENCES payroll_config.payroll_area(payroll_area_id);
ALTER TABLE payroll_config.payroll_period ADD CONSTRAINT fk_payroll_period_retro FOREIGN KEY (retroactive_period_id) REFERENCES payroll_config.payroll_period(payroll_period_id);
ALTER TABLE payroll_config.payroll_period ADD CONSTRAINT fk_payroll_period_type FOREIGN KEY (country_code, period_type_code) REFERENCES payroll_config.period_type(country_code, period_type_code);
ALTER TABLE payroll_config.period_pattern ADD CONSTRAINT pk_period_pattern PRIMARY KEY (period_pattern_id);
ALTER TABLE payroll_config.period_pattern ADD CONSTRAINT uq_period_pattern_code UNIQUE (country_code, period_pattern_code);
ALTER TABLE payroll_config.period_pattern ADD CONSTRAINT fk_period_pattern_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.period_pattern ADD CONSTRAINT fk_period_pattern_type FOREIGN KEY (country_code, period_type_code) REFERENCES payroll_config.period_type(country_code, period_type_code);
ALTER TABLE payroll_config.period_type ADD CONSTRAINT pk_period_type PRIMARY KEY (period_type_id);
ALTER TABLE payroll_config.period_type ADD CONSTRAINT uq_period_type_per_country UNIQUE (country_code, period_type_code);
ALTER TABLE payroll_config.period_type ADD CONSTRAINT fk_period_type_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.round_method ADD CONSTRAINT pk_round_method PRIMARY KEY (round_method_id);
ALTER TABLE payroll_config.round_method ADD CONSTRAINT uq_round_method_per_country UNIQUE (country_code, round_method_code);
ALTER TABLE payroll_config.round_method ADD CONSTRAINT fk_round_method_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.severance_expense_deduction ADD CONSTRAINT pk_severance_expense_deduction PRIMARY KEY (expense_deduction_id);
ALTER TABLE payroll_config.severance_expense_deduction ADD CONSTRAINT uq_severance_expense_period UNIQUE (country_code, deduction_code, effective_start_date);
ALTER TABLE payroll_config.severance_expense_deduction ADD CONSTRAINT fk_severance_expense_deduction_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.severance_pay_master ADD CONSTRAINT pk_severance_pay_master PRIMARY KEY (pay_id);
ALTER TABLE payroll_config.severance_pay_master ADD CONSTRAINT uq_severance_pay_period UNIQUE (country_code, severance_pay_code, effective_start_date);
ALTER TABLE payroll_config.severance_pay_master ADD CONSTRAINT fk_severance_pay_master_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.severance_pay_rate ADD CONSTRAINT pk_severance_pay_rate PRIMARY KEY (pay_rate_id);
ALTER TABLE payroll_config.severance_pay_rate ADD CONSTRAINT uq_severance_rate_seq UNIQUE (pay_id, sequence_number);
ALTER TABLE payroll_config.severance_pay_rate ADD CONSTRAINT uq_severance_rate_year_from UNIQUE (pay_id, service_year_from);
ALTER TABLE payroll_config.severance_pay_rate ADD CONSTRAINT fk_severance_pay_rate_master FOREIGN KEY (pay_id) REFERENCES payroll_config.severance_pay_master(pay_id);
ALTER TABLE payroll_config.severance_tax_exemption ADD CONSTRAINT pk_severance_tax_exemption PRIMARY KEY (tax_exemption_id);
ALTER TABLE payroll_config.severance_tax_exemption ADD CONSTRAINT uq_severance_tax_exemption_period UNIQUE (country_code, tax_exemption_code, effective_start_date);
ALTER TABLE payroll_config.severance_tax_exemption ADD CONSTRAINT fk_severance_tax_exemption_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.social_security_base_amount ADD CONSTRAINT pk_sso_base_amount PRIMARY KEY (id);
ALTER TABLE payroll_config.social_security_base_amount ADD CONSTRAINT uq_sso_base_amount UNIQUE (country_code, effective_start_date);
ALTER TABLE payroll_config.social_security_base_amount ADD CONSTRAINT fk_sso_base_amount_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.social_security_branch_rate ADD CONSTRAINT pk_sso_branch_rate PRIMARY KEY (id);
ALTER TABLE payroll_config.social_security_branch_rate ADD CONSTRAINT uq_sso_branch_rate UNIQUE (company_code, branch_code, effective_start_date);
ALTER TABLE payroll_config.social_security_branch_rate ADD CONSTRAINT fk_sso_branch_rate_branch FOREIGN KEY (company_code, branch_code) REFERENCES payroll_config.company_branch(company_code, branch_code);
ALTER TABLE payroll_config.social_security_branch_registration ADD CONSTRAINT pk_sso_branch_reg PRIMARY KEY (id);
ALTER TABLE payroll_config.social_security_branch_registration ADD CONSTRAINT uq_sso_branch_reg UNIQUE (company_code, branch_code, effective_start_date);
ALTER TABLE payroll_config.social_security_branch_registration ADD CONSTRAINT fk_sso_branch_reg_branch FOREIGN KEY (company_code, branch_code) REFERENCES payroll_config.company_branch(company_code, branch_code);
ALTER TABLE payroll_config.social_security_eligibility_rule ADD CONSTRAINT pk_sso_eligible_rule PRIMARY KEY (id);
ALTER TABLE payroll_config.social_security_eligibility_rule ADD CONSTRAINT uq_sso_eligible_rule UNIQUE (country_code, employee_group_code, employee_subgroup_code, effective_start_date);
ALTER TABLE payroll_config.social_security_eligibility_rule ADD CONSTRAINT fk_sso_eligible_mapping FOREIGN KEY (country_code, employee_group_code, employee_subgroup_code) REFERENCES payroll_config.employee_group_mapping(country_code, employee_group_code, employee_subgroup_code);
ALTER TABLE payroll_config.sso_branch_groups ADD CONSTRAINT pk_sso_branch_groups PRIMARY KEY (id);
ALTER TABLE payroll_config.sso_branch_groups ADD CONSTRAINT uq_sso_branch_groups UNIQUE (company_code, branch_code, social_security_branch_number, effective_start_date);
ALTER TABLE payroll_config.sso_branch_groups ADD CONSTRAINT fk_sso_branch_groups_branch FOREIGN KEY (company_code, branch_code) REFERENCES payroll_config.company_branch(company_code, branch_code);
ALTER TABLE payroll_config.tax_branch ADD CONSTRAINT pk_tax_branch PRIMARY KEY (company_code, tax_branch_code);
ALTER TABLE payroll_config.tax_branch ADD CONSTRAINT fk_tax_branch_company FOREIGN KEY (company_code) REFERENCES payroll_config.company(company_code);
ALTER TABLE payroll_config.tax_branch_mapping ADD CONSTRAINT pk_tax_branch_mapping PRIMARY KEY (tax_branch_mapping_id);
ALTER TABLE payroll_config.tax_branch_mapping ADD CONSTRAINT uq_tax_branch_mapping_period UNIQUE (company_code, branch_code, effective_start_date);
ALTER TABLE payroll_config.tax_branch_mapping ADD CONSTRAINT fk_tbm_branch FOREIGN KEY (company_code, branch_code) REFERENCES payroll_config.company_branch(company_code, branch_code);
ALTER TABLE payroll_config.tax_branch_mapping ADD CONSTRAINT fk_tbm_tax_branch FOREIGN KEY (company_code, tax_branch_code) REFERENCES payroll_config.tax_branch(company_code, tax_branch_code);
ALTER TABLE payroll_config.tax_branch_registration ADD CONSTRAINT pk_tax_branch_registration PRIMARY KEY (tax_registration_id);
ALTER TABLE payroll_config.tax_branch_registration ADD CONSTRAINT uq_tax_branch_registration UNIQUE (company_code, tax_branch_code, effective_start_date);
ALTER TABLE payroll_config.tax_branch_registration ADD CONSTRAINT fk_tax_branch_reg_branch FOREIGN KEY (company_code, tax_branch_code) REFERENCES payroll_config.tax_branch(company_code, tax_branch_code);
ALTER TABLE payroll_config.tax_control_group ADD CONSTRAINT pk_tax_control_group PRIMARY KEY (tax_control_group_id);
ALTER TABLE payroll_config.tax_control_group ADD CONSTRAINT uq_tax_control_group_per_country UNIQUE (country_code, tax_control_group_code);
ALTER TABLE payroll_config.tax_control_group ADD CONSTRAINT fk_tcg_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_control_group ADD CONSTRAINT fk_tcg_limit_base FOREIGN KEY (tax_limit_base_code) REFERENCES payroll_config.tax_limit_base(tax_limit_base_code);
ALTER TABLE payroll_config.tax_control_group ADD CONSTRAINT fk_tcg_limit_method FOREIGN KEY (tax_limit_method_code) REFERENCES payroll_config.tax_limit_method(tax_limit_method_code);
ALTER TABLE payroll_config.tax_deduction_group ADD CONSTRAINT pk_tax_deduction_group PRIMARY KEY (tax_deduction_group_id);
ALTER TABLE payroll_config.tax_deduction_group ADD CONSTRAINT uq_tax_deduction_group_per_country UNIQUE (country_code, tax_deduction_group_code);
ALTER TABLE payroll_config.tax_deduction_group ADD CONSTRAINT fk_tax_deduction_group_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT pk_tax_deduction_master PRIMARY KEY (tax_deduction_master_id);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT uq_tax_deduction_per_year UNIQUE (country_code, tax_year, tax_deduction_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_control_group FOREIGN KEY (country_code, tax_control_group_code) REFERENCES payroll_config.tax_control_group(country_code, tax_control_group_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_group FOREIGN KEY (country_code, tax_deduction_group_code) REFERENCES payroll_config.tax_deduction_group(country_code, tax_deduction_group_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_limit_base FOREIGN KEY (tax_limit_base_code) REFERENCES payroll_config.tax_limit_base(tax_limit_base_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_limit_method FOREIGN KEY (tax_limit_method_code) REFERENCES payroll_config.tax_limit_method(tax_limit_method_code);
ALTER TABLE payroll_config.tax_deduction_master ADD CONSTRAINT fk_tdm_subgroup FOREIGN KEY (country_code, tax_deduction_group_code, tax_deduction_subgroup_code) REFERENCES payroll_config.tax_deduction_subgroup(country_code, tax_deduction_group_code, tax_deduction_subgroup_code);
ALTER TABLE payroll_config.tax_deduction_subgroup ADD CONSTRAINT pk_tax_deduction_subgroup PRIMARY KEY (tax_deduction_subgroup_id);
ALTER TABLE payroll_config.tax_deduction_subgroup ADD CONSTRAINT uq_tax_deduction_subgroup UNIQUE (country_code, tax_deduction_group_code, tax_deduction_subgroup_code);
ALTER TABLE payroll_config.tax_deduction_subgroup ADD CONSTRAINT fk_tds_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_deduction_subgroup ADD CONSTRAINT fk_tds_group FOREIGN KEY (country_code, tax_deduction_group_code) REFERENCES payroll_config.tax_deduction_group(country_code, tax_deduction_group_code);
ALTER TABLE payroll_config.tax_expense ADD CONSTRAINT pk_tax_expense PRIMARY KEY (id);
ALTER TABLE payroll_config.tax_expense ADD CONSTRAINT uq_tax_expense_master_period UNIQUE (tax_rate_master_id, effective_start_date);
ALTER TABLE payroll_config.tax_expense ADD CONSTRAINT fk_tax_expense_master FOREIGN KEY (tax_rate_master_id) REFERENCES payroll_config.tax_rate_master(tax_rate_master_id);
ALTER TABLE payroll_config.tax_grs_types ADD CONSTRAINT pk_tax_grs_types PRIMARY KEY (tax_grs_code);
ALTER TABLE payroll_config.tax_limit_base ADD CONSTRAINT pk_tax_limit_base PRIMARY KEY (tax_limit_base_code);
ALTER TABLE payroll_config.tax_limit_base ADD CONSTRAINT fk_tax_limit_base_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_limit_method ADD CONSTRAINT pk_tax_limit_method PRIMARY KEY (tax_limit_method_code);
ALTER TABLE payroll_config.tax_limit_method ADD CONSTRAINT fk_tax_limit_method_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_rate_master ADD CONSTRAINT pk_tax_rate_master PRIMARY KEY (tax_rate_master_id);
ALTER TABLE payroll_config.tax_rate_master ADD CONSTRAINT uq_tax_rate_per_country_period UNIQUE (country_code, effective_start_date);
ALTER TABLE payroll_config.tax_rate_master ADD CONSTRAINT fk_tax_rate_master_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.tax_type ADD CONSTRAINT pk_tax_type PRIMARY KEY (tax_type_id);
ALTER TABLE payroll_config.tax_type ADD CONSTRAINT uq_tax_type_per_country UNIQUE (country_code, tax_type_code);
ALTER TABLE payroll_config.tax_type ADD CONSTRAINT fk_tax_type_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT pk_wage_type PRIMARY KEY (wage_type_id);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT uq_wage_type_per_country UNIQUE (country_code, wage_type_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_category FOREIGN KEY (country_code, wage_type_category_code) REFERENCES payroll_config.wage_type_category(country_code, wage_type_category_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_frequency FOREIGN KEY (country_code, wage_type_frequency_code) REFERENCES payroll_config.wage_type_frequency(country_code, wage_type_frequency_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_group FOREIGN KEY (country_code, wage_type_group_code) REFERENCES payroll_config.wage_type_group(country_code, wage_type_group_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_grs FOREIGN KEY (tax_grs_code) REFERENCES payroll_config.tax_grs_types(tax_grs_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_payslip_code FOREIGN KEY (payslip_code) REFERENCES payroll_config.wage_type_payslip_mapping(payslip_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_round_method FOREIGN KEY (country_code, round_method_code) REFERENCES payroll_config.round_method(country_code, round_method_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_subgroup FOREIGN KEY (country_code, wage_type_subgroup_code) REFERENCES payroll_config.wage_type_subgroup(country_code, wage_type_subgroup_code);
ALTER TABLE payroll_config.wage_type ADD CONSTRAINT fk_wage_type_tax_type FOREIGN KEY (country_code, tax_type_code) REFERENCES payroll_config.tax_type(country_code, tax_type_code);
ALTER TABLE payroll_config.wage_type_category ADD CONSTRAINT pk_wage_type_category PRIMARY KEY (wage_type_category_id);
ALTER TABLE payroll_config.wage_type_category ADD CONSTRAINT uq_wage_type_category_per_country UNIQUE (country_code, wage_type_category_code);
ALTER TABLE payroll_config.wage_type_category ADD CONSTRAINT fk_wage_type_category_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.wage_type_frequency ADD CONSTRAINT pk_wage_type_frequency PRIMARY KEY (wage_type_frequency_id);
ALTER TABLE payroll_config.wage_type_frequency ADD CONSTRAINT uq_wage_type_frequency_per_country UNIQUE (country_code, wage_type_frequency_code);
ALTER TABLE payroll_config.wage_type_frequency ADD CONSTRAINT fk_wage_type_frequency_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.wage_type_fund_assignment ADD CONSTRAINT pk_wage_type_fund_assignment PRIMARY KEY (fund_assignment_id);
ALTER TABLE payroll_config.wage_type_fund_assignment ADD CONSTRAINT uq_wage_type_fund_assignment UNIQUE (country_code, wage_type_code, fund_type_code);
ALTER TABLE payroll_config.wage_type_fund_assignment ADD CONSTRAINT fk_wtfa_fund_type FOREIGN KEY (country_code, fund_type_code) REFERENCES payroll_config.fund_type(country_code, fund_type_code);
ALTER TABLE payroll_config.wage_type_fund_assignment ADD CONSTRAINT fk_wtfa_wage_type FOREIGN KEY (country_code, wage_type_code) REFERENCES payroll_config.wage_type(country_code, wage_type_code);
ALTER TABLE payroll_config.wage_type_gl_mapping ADD CONSTRAINT pk_wage_type_gl_mapping PRIMARY KEY (id);
ALTER TABLE payroll_config.wage_type_group ADD CONSTRAINT pk_wage_type_group PRIMARY KEY (wage_type_group_id);
ALTER TABLE payroll_config.wage_type_group ADD CONSTRAINT uq_wage_type_group_per_country UNIQUE (country_code, wage_type_group_code);
ALTER TABLE payroll_config.wage_type_group ADD CONSTRAINT fk_wage_type_group_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_config.wage_type_pay_period ADD CONSTRAINT pk_wage_type_pay_period PRIMARY KEY (wage_type_pay_period_id);
ALTER TABLE payroll_config.wage_type_pay_period ADD CONSTRAINT uq_wage_type_pay_period UNIQUE (country_code, period_type_code, wage_type_group_code, wage_type_frequency_code);
ALTER TABLE payroll_config.wage_type_pay_period ADD CONSTRAINT fk_wtpp_period_type FOREIGN KEY (country_code, period_type_code) REFERENCES payroll_config.period_type(country_code, period_type_code);
ALTER TABLE payroll_config.wage_type_pay_period ADD CONSTRAINT fk_wtpp_wage_type_frequency FOREIGN KEY (country_code, wage_type_frequency_code) REFERENCES payroll_config.wage_type_frequency(country_code, wage_type_frequency_code);
ALTER TABLE payroll_config.wage_type_pay_period ADD CONSTRAINT fk_wtpp_wage_type_group FOREIGN KEY (country_code, wage_type_group_code) REFERENCES payroll_config.wage_type_group(country_code, wage_type_group_code);
ALTER TABLE payroll_config.wage_type_payslip_mapping ADD CONSTRAINT pk_wage_type_payslip_mapping PRIMARY KEY (id);
ALTER TABLE payroll_config.wage_type_payslip_mapping ADD CONSTRAINT uq_wage_type_payslip_mapping_code UNIQUE (payslip_code);
ALTER TABLE payroll_config.wage_type_subgroup ADD CONSTRAINT pk_wage_type_subgroup PRIMARY KEY (wage_type_subgroup_id);
ALTER TABLE payroll_config.wage_type_subgroup ADD CONSTRAINT uq_wage_type_subgroup_per_country UNIQUE (country_code, wage_type_subgroup_code);
ALTER TABLE payroll_config.wage_type_subgroup ADD CONSTRAINT fk_wage_type_subgroup_country FOREIGN KEY (country_code) REFERENCES payroll_config.country(country_code);
ALTER TABLE payroll_entry.employee_additional_payments ADD CONSTRAINT employee_additional_payments_pkey PRIMARY KEY (id);
ALTER TABLE payroll_entry.employee_additional_payments ADD CONSTRAINT uq_emp_additional_company_code_period_entry_wt UNIQUE (company_code, employee_code, payment_period, entry_date, wage_type);
ALTER TABLE payroll_entry.employee_additional_payments ADD CONSTRAINT employee_additional_payments_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll_entry.employee_basic_pay ADD CONSTRAINT employee_basic_pay_pkey PRIMARY KEY (id);
ALTER TABLE payroll_entry.employee_basic_pay ADD CONSTRAINT uq_emp_basic_pay_company_code_wt_date UNIQUE (company_code, employee_code, wage_type, valid_from);
ALTER TABLE payroll_entry.employee_basic_pay ADD CONSTRAINT employee_basic_pay_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll_entry.employee_basic_pay ADD CONSTRAINT fk_basic_pay_pay_frequency FOREIGN KEY (pay_frequency_code) REFERENCES payroll_config.pay_frequency(pay_frequency_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll_entry.employee_recurring_entries ADD CONSTRAINT employee_recurring_entries_pkey PRIMARY KEY (id);
ALTER TABLE payroll_entry.employee_recurring_entries ADD CONSTRAINT uq_emp_recurring_company_code_wt_date UNIQUE (company_code, employee_code, wage_type, valid_from);
ALTER TABLE payroll_entry.employee_recurring_entries ADD CONSTRAINT employee_recurring_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['payment'::text, 'deduction'::text])));
ALTER TABLE payroll_entry.employee_recurring_entries ADD CONSTRAINT employee_recurring_entries_employee_code_fkey FOREIGN KEY (company_code, employee_code) REFERENCES payroll.employees(company_code, employee_code) ON DELETE CASCADE;
ALTER TABLE payroll_entry.employee_recurring_entries ADD CONSTRAINT fk_recurring_pay_frequency FOREIGN KEY (pay_frequency_code) REFERENCES payroll_config.pay_frequency(pay_frequency_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.bank_profile ADD CONSTRAINT pk_bank_profile PRIMARY KEY (id);
ALTER TABLE payroll_maintain.bank_profile ADD CONSTRAINT uq_bank_profile_country_bank UNIQUE (country_code, bank_code);
ALTER TABLE payroll_maintain.employee_address ADD CONSTRAINT pk_employee_address PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_address ADD CONSTRAINT uq_employee_address UNIQUE (company_code, employee_code, effective_start_date);
ALTER TABLE payroll_maintain.employee_address ADD CONSTRAINT ck_employee_address_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_address ADD CONSTRAINT fk_employee_address_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT pk_employee_bank_payment PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT uq_employee_bank_payment UNIQUE (company_code, employee_code, effective_start_date);
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT ck_employee_bank_payment_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT fk_employee_bank_payment_bank FOREIGN KEY (bank_country_code, bank_code) REFERENCES payroll_maintain.bank_profile(country_code, bank_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT fk_employee_bank_payment_method FOREIGN KEY (payment_method_code) REFERENCES payroll_maintain.payment_method(payment_method_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_bank_payment ADD CONSTRAINT fk_employee_bank_payment_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_cost_distribution ADD CONSTRAINT pk_employee_cost_distribution PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_cost_distribution ADD CONSTRAINT uq_employee_cost_distribution UNIQUE (company_code, employee_code, effective_start_date);
ALTER TABLE payroll_maintain.employee_cost_distribution ADD CONSTRAINT ck_employee_cost_distribution_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_cost_distribution ADD CONSTRAINT fk_employee_cost_distribution_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_fund_data ADD CONSTRAINT pk_employee_fund_data PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_fund_data ADD CONSTRAINT uq_employee_fund_data UNIQUE (company_code, employee_code, effective_start_date, fund_type_code);
ALTER TABLE payroll_maintain.employee_fund_data ADD CONSTRAINT ck_employee_fund_data_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_fund_data ADD CONSTRAINT fk_employee_fund_data_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_fund_rate ADD CONSTRAINT pk_employee_fund_rate PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_fund_rate ADD CONSTRAINT uq_employee_fund_rate UNIQUE (employee_code, employee_fund_id, effective_start_date);
ALTER TABLE payroll_maintain.employee_fund_rate ADD CONSTRAINT ck_employee_fund_rate_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_fund_rate ADD CONSTRAINT fk_employee_fund_rate_fund FOREIGN KEY (employee_fund_id) REFERENCES payroll_maintain.employee_fund_data(id) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_job_history ADD CONSTRAINT employee_job_history_pkey PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_job_history ADD CONSTRAINT uq_employee_job_history UNIQUE (company_code, employee_code, effective_start_date, is_primary);
ALTER TABLE payroll_maintain.employee_job_history ADD CONSTRAINT ck_employee_job_history_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_job_history ADD CONSTRAINT ck_employee_job_history_status CHECK (((employee_status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying, 'TERMINATED'::character varying])::text[])));
ALTER TABLE payroll_maintain.employee_job_history ADD CONSTRAINT fk_employee_job_history_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT pk_employee_loan_data PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT ck_employee_loan_data_amount CHECK (((loan_amount >= (0)::numeric) AND (installment_amount >= (0)::numeric)));
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT ck_employee_loan_data_dates CHECK ((last_deduct_date >= first_deduct_date));
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT ck_employee_loan_data_status CHECK (((loan_status)::text = ANY ((ARRAY['A'::character varying, 'C'::character varying, 'S'::character varying])::text[])));
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT fk_employee_loan_data_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_loan_data ADD CONSTRAINT fk_employee_loan_data_type FOREIGN KEY (loan_type_id) REFERENCES payroll_maintain.loan_type(id) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_loan_payment ADD CONSTRAINT pk_employee_loan_payment PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_loan_payment ADD CONSTRAINT ck_employee_loan_payment_amount CHECK ((payment_amount > (0)::numeric));
ALTER TABLE payroll_maintain.employee_loan_payment ADD CONSTRAINT fk_employee_loan_payment_loan FOREIGN KEY (employee_loan_id) REFERENCES payroll_maintain.employee_loan_data(id) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_payroll_status ADD CONSTRAINT pk_employee_payroll_status PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_payroll_status ADD CONSTRAINT uq_employee_payroll_status UNIQUE (company_code, employee_code);
ALTER TABLE payroll_maintain.employee_payroll_status ADD CONSTRAINT fk_employee_payroll_status_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_profile ADD CONSTRAINT employee_profile_pkey PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_profile ADD CONSTRAINT uq_employee_profile UNIQUE (company_code, employee_code);
ALTER TABLE payroll_maintain.employee_social_security_rate ADD CONSTRAINT pk_employee_social_security_rate PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_social_security_rate ADD CONSTRAINT uq_employee_social_security_rate UNIQUE (company_code, employee_code, effective_start_date);
ALTER TABLE payroll_maintain.employee_social_security_rate ADD CONSTRAINT ck_employee_ssr_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_social_security_rate ADD CONSTRAINT fk_employee_ssr_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.employee_tax_deduction ADD CONSTRAINT pk_employee_tax_deduction PRIMARY KEY (id);
ALTER TABLE payroll_maintain.employee_tax_deduction ADD CONSTRAINT uq_employee_tax_deduction UNIQUE (company_code, employee_code, effective_start_date);
ALTER TABLE payroll_maintain.employee_tax_deduction ADD CONSTRAINT ck_employee_tax_deduction_counts CHECK ((((no_child_before_2018 IS NULL) OR (no_child_before_2018 > 0)) AND ((no_child_after_2018 IS NULL) OR (no_child_after_2018 > 0)) AND ((disabled_depend_count IS NULL) OR (disabled_depend_count > 0))));
ALTER TABLE payroll_maintain.employee_tax_deduction ADD CONSTRAINT ck_employee_tax_deduction_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE payroll_maintain.employee_tax_deduction ADD CONSTRAINT fk_employee_tax_deduction_profile FOREIGN KEY (company_code, employee_code) REFERENCES payroll_maintain.employee_profile(company_code, employee_code) ON DELETE RESTRICT;
ALTER TABLE payroll_maintain.loan_type ADD CONSTRAINT pk_loan_type PRIMARY KEY (id);
ALTER TABLE payroll_maintain.loan_type ADD CONSTRAINT uq_loan_type_code UNIQUE (loan_type_code);
ALTER TABLE payroll_maintain.payment_method ADD CONSTRAINT pk_payment_method PRIMARY KEY (payment_method_code);
ALTER TABLE payroll_permissions.permission_roles ADD CONSTRAINT permission_roles_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.permission_roles ADD CONSTRAINT permission_roles_name_key UNIQUE (name);
ALTER TABLE payroll_permissions.permissions ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.permissions ADD CONSTRAINT permissions_permission_role_id_module_resource_key UNIQUE (permission_role_id, module, resource);
ALTER TABLE payroll_permissions.permissions ADD CONSTRAINT permissions_permission_role_id_fkey FOREIGN KEY (permission_role_id) REFERENCES payroll_permissions.permission_roles(id);
ALTER TABLE payroll_permissions.role_assignments ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.role_assignments ADD CONSTRAINT role_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES payroll.users(id);
ALTER TABLE payroll_permissions.role_assignments ADD CONSTRAINT role_assignments_granted_to_user_grant_group_id_fkey FOREIGN KEY (granted_to_user_grant_group_id) REFERENCES payroll_permissions.user_grant_groups(id);
ALTER TABLE payroll_permissions.role_assignments ADD CONSTRAINT role_assignments_permission_role_id_fkey FOREIGN KEY (permission_role_id) REFERENCES payroll_permissions.permission_roles(id);
ALTER TABLE payroll_permissions.role_assignments ADD CONSTRAINT role_assignments_target_group_id_fkey FOREIGN KEY (target_group_id) REFERENCES payroll_permissions.target_groups(id);
ALTER TABLE payroll_permissions.target_group_payroll_areas ADD CONSTRAINT target_group_payroll_areas_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.target_group_payroll_areas ADD CONSTRAINT target_group_payroll_areas_payroll_area_code_key UNIQUE (payroll_area_code);
ALTER TABLE payroll_permissions.target_group_payroll_areas ADD CONSTRAINT target_group_payroll_areas_payroll_area_code_fkey FOREIGN KEY (payroll_area_code) REFERENCES payroll_config.payroll_area(payroll_area_code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE payroll_permissions.target_group_payroll_areas ADD CONSTRAINT target_group_payroll_areas_target_group_id_fkey FOREIGN KEY (target_group_id) REFERENCES payroll_permissions.target_groups(id);
ALTER TABLE payroll_permissions.target_groups ADD CONSTRAINT target_groups_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.target_groups ADD CONSTRAINT target_groups_name_key UNIQUE (name);
ALTER TABLE payroll_permissions.user_grant_group_members ADD CONSTRAINT user_grant_group_members_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.user_grant_group_members ADD CONSTRAINT user_grant_group_members_user_id_key UNIQUE (user_id);
ALTER TABLE payroll_permissions.user_grant_group_members ADD CONSTRAINT user_grant_group_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES payroll.users(id);
ALTER TABLE payroll_permissions.user_grant_group_members ADD CONSTRAINT user_grant_group_members_user_grant_group_id_fkey FOREIGN KEY (user_grant_group_id) REFERENCES payroll_permissions.user_grant_groups(id);
ALTER TABLE payroll_permissions.user_grant_group_members ADD CONSTRAINT user_grant_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES payroll.users(id);
ALTER TABLE payroll_permissions.user_grant_groups ADD CONSTRAINT user_grant_groups_pkey PRIMARY KEY (id);
ALTER TABLE payroll_permissions.user_grant_groups ADD CONSTRAINT user_grant_groups_name_key UNIQUE (name);
ALTER TABLE payroll_report.bis50_batch_failures ADD CONSTRAINT bis50_batch_failures_pkey PRIMARY KEY (id);
ALTER TABLE payroll_report.bis50_batch_runs ADD CONSTRAINT bis50_batch_runs_pkey PRIMARY KEY (id);
ALTER TABLE payroll_report.bis50_documents ADD CONSTRAINT bis50_documents_pkey PRIMARY KEY (id);
ALTER TABLE payroll_report.payslip_batch_failures ADD CONSTRAINT payslip_batch_failures_pkey PRIMARY KEY (id);
ALTER TABLE payroll_report.payslip_batch_runs ADD CONSTRAINT payslip_batch_runs_pkey PRIMARY KEY (id);
ALTER TABLE payroll_report.payslip_documents ADD CONSTRAINT payslip_documents_pkey PRIMARY KEY (id);
ALTER TABLE public."SequelizeData_benefit_management" ADD CONSTRAINT "SequelizeData_benefit_management_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_benefit_management" ADD CONSTRAINT "SequelizeMeta_benefit_management_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_employee_management" ADD CONSTRAINT "SequelizeMeta_employee_management_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_payroll" ADD CONSTRAINT "SequelizeMeta_payroll_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_payroll_report" ADD CONSTRAINT "SequelizeMeta_payroll_report_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_time_management" ADD CONSTRAINT "SequelizeMeta_time_management_pkey" PRIMARY KEY (name);
ALTER TABLE public."SequelizeMeta_workflow_service" ADD CONSTRAINT "SequelizeMeta_workflow_service_pkey" PRIMARY KEY (name);
ALTER TABLE public.benefit_history_logs ADD CONSTRAINT benefit_history_logs_pkey PRIMARY KEY (id);
ALTER TABLE time_management."SequelizeMeta_time_management" ADD CONSTRAINT "SequelizeMeta_time_management_pkey" PRIMARY KEY (name);
ALTER TABLE time_management.allowance ADD CONSTRAINT allowance_pkey PRIMARY KEY (allowance_id);
ALTER TABLE time_management.allowance ADD CONSTRAINT allowance_allowance_code_key UNIQUE (allowance_code);
ALTER TABLE time_management.allowance_result ADD CONSTRAINT allowance_result_pkey PRIMARY KEY (allowance_result_id);
ALTER TABLE time_management.allowance_result ADD CONSTRAINT allowance_result_unq UNIQUE (employee_id, work_date, allowance_code);
ALTER TABLE time_management.annual_leave_quota_mapping ADD CONSTRAINT annual_leave_quota_mapping_pkey PRIMARY KEY (id);
ALTER TABLE time_management.annual_leave_quota_mapping ADD CONSTRAINT ck_annual_leave_quota_mapping_effective_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE time_management.approval_step ADD CONSTRAINT approval_step_pkey PRIMARY KEY (id);
ALTER TABLE time_management.employee_time_info ADD CONSTRAINT employee_time_info_pkey PRIMARY KEY (id);
ALTER TABLE time_management.employment_information ADD CONSTRAINT employment_information_pkey PRIMARY KEY (id);
ALTER TABLE time_management.employment_job ADD CONSTRAINT employment_job_pkey PRIMARY KEY (emp_job_id);
ALTER TABLE time_management.employment_job_relationships ADD CONSTRAINT employment_job_relationships_pkey PRIMARY KEY (id);
ALTER TABLE time_management.holiday_calendar ADD CONSTRAINT holiday_calendar_pkey PRIMARY KEY (holiday_calendar_id);
ALTER TABLE time_management.holiday_calendar_date ADD CONSTRAINT holiday_calendar_date_pkey PRIMARY KEY (calendar_date_id);
ALTER TABLE time_management.holiday_calendar_date ADD CONSTRAINT holiday_calendar_date_holiday_calendar_id_fkey FOREIGN KEY (holiday_calendar_id) REFERENCES time_management.holiday_calendar(holiday_calendar_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.leave_balance_carry_forward ADD CONSTRAINT leave_balance_carry_forward_pkey PRIMARY KEY (leave_balance_carry_forward_id);
ALTER TABLE time_management.leave_balance_carry_forward_transaction ADD CONSTRAINT leave_balance_carry_forward_transaction_pkey PRIMARY KEY (leave_balance_carry_forward_transaction_id);
ALTER TABLE time_management.leave_balance_carry_forward_transaction ADD CONSTRAINT leave_balance_carry_forward_t_leave_balance_carry_forward__fkey FOREIGN KEY (leave_balance_carry_forward_id) REFERENCES time_management.leave_balance_carry_forward(leave_balance_carry_forward_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_balance_event ADD CONSTRAINT leave_balance_event_pkey PRIMARY KEY (leave_balance_event_id);
ALTER TABLE time_management.leave_balance_event ADD CONSTRAINT leave_balance_event_leave_event_type_id_fkey FOREIGN KEY (leave_event_type_id) REFERENCES time_management.leave_event_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.leave_balance_event_transaction ADD CONSTRAINT leave_balance_event_transaction_pkey PRIMARY KEY (leave_balance_event_transaction_id);
ALTER TABLE time_management.leave_balance_event_transaction ADD CONSTRAINT leave_balance_event_transaction_leave_balance_event_id_fkey FOREIGN KEY (leave_balance_event_id) REFERENCES time_management.leave_balance_event(leave_balance_event_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_balance_onetime ADD CONSTRAINT leave_balance_onetime_pkey PRIMARY KEY (leave_balance_onetime_id);
ALTER TABLE time_management.leave_balance_onetime_transaction ADD CONSTRAINT leave_balance_onetime_transaction_pkey PRIMARY KEY (leave_balance_onetime_transaction_id);
ALTER TABLE time_management.leave_balance_onetime_transaction ADD CONSTRAINT leave_balance_onetime_transaction_leave_balance_onetime_id_fkey FOREIGN KEY (leave_balance_onetime_id) REFERENCES time_management.leave_balance_onetime(leave_balance_onetime_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_balance_seed_staging ADD CONSTRAINT leave_balance_seed_staging_pkey PRIMARY KEY (leave_balance_id);
ALTER TABLE time_management.leave_balance_transaction ADD CONSTRAINT leave_balance_transaction_pkey PRIMARY KEY (leave_balance_transaction_id);
ALTER TABLE time_management.leave_balance_yearly ADD CONSTRAINT leave_balance_yearly_pkey PRIMARY KEY (leave_balance_yearly_id);
ALTER TABLE time_management.leave_balance_yearly_transaction ADD CONSTRAINT leave_balance_yearly_transaction_pkey PRIMARY KEY (leave_balance_yearly_transaction_id);
ALTER TABLE time_management.leave_balance_yearly_transaction ADD CONSTRAINT leave_balance_yearly_transaction_leave_balance_yearly_id_fkey FOREIGN KEY (leave_balance_yearly_id) REFERENCES time_management.leave_balance_yearly(leave_balance_yearly_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_eligibility_rule ADD CONSTRAINT leave_eligibility_rule_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_eligibility_rule ADD CONSTRAINT ck_leave_eligibility_rule_effective_dates CHECK ((effective_end_date >= effective_start_date));
ALTER TABLE time_management.leave_event_balance ADD CONSTRAINT leave_event_balance_pkey PRIMARY KEY (leave_event_balance_id);
ALTER TABLE time_management.leave_event_balance ADD CONSTRAINT leave_event_balance_leave_event_type_id_fkey FOREIGN KEY (leave_event_type_id) REFERENCES time_management.leave_event_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.leave_event_balance_transaction ADD CONSTRAINT leave_event_balance_transaction_pkey PRIMARY KEY (leave_event_balance_transaction_id);
ALTER TABLE time_management.leave_event_balance_transaction ADD CONSTRAINT leave_event_balance_transaction_leave_event_balance_id_fkey FOREIGN KEY (leave_event_balance_id) REFERENCES time_management.leave_event_balance(leave_event_balance_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_event_type ADD CONSTRAINT leave_event_type_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_request ADD CONSTRAINT leave_request_pkey PRIMARY KEY (leave_request_id);
ALTER TABLE time_management.leave_request_attachments ADD CONSTRAINT leave_request_attachments_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_request_decisions ADD CONSTRAINT leave_request_decisions_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_request_detail ADD CONSTRAINT leave_request_detail_pkey PRIMARY KEY (leave_request_detail_id);
ALTER TABLE time_management.leave_request_detail ADD CONSTRAINT leave_request_detail_leave_request_id_fkey FOREIGN KEY (leave_request_id) REFERENCES time_management.leave_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.leave_requests ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_requests ADD CONSTRAINT leave_requests_leave_event_type_id_fkey FOREIGN KEY (leave_event_type_id) REFERENCES time_management.leave_event_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.leave_result ADD CONSTRAINT leave_result_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_types ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);
ALTER TABLE time_management.leave_types ADD CONSTRAINT ck_leave_types_document_min_files_range CHECK (((document_min_files IS NULL) OR ((document_min_files >= 1) AND (document_min_files <= 5))));
ALTER TABLE time_management.leave_types ADD CONSTRAINT ck_leave_types_document_rule_shape CHECK (((((document_rule)::text = 'NONE'::text) AND (document_min_files IS NULL)) OR (((document_rule)::text = ANY ((ARRAY['ALWAYS'::character varying, 'OVER_DAYS'::character varying])::text[])) AND (document_min_files IS NOT NULL))));
ALTER TABLE time_management.mobile_clock_eligibility_rule ADD CONSTRAINT mobile_clock_eligibility_rule_pkey PRIMARY KEY (id);
ALTER TABLE time_management.ot_request ADD CONSTRAINT ot_request_pkey PRIMARY KEY (id);
ALTER TABLE time_management.ot_request ADD CONSTRAINT uq_ot_request_request_number UNIQUE (request_number);
ALTER TABLE time_management.ot_request_attachment ADD CONSTRAINT ot_request_attachment_pkey PRIMARY KEY (id);
ALTER TABLE time_management.ot_request_attachment ADD CONSTRAINT ot_request_attachment_overtime_request_id_fkey FOREIGN KEY (overtime_request_id) REFERENCES time_management.ot_request(id) ON DELETE CASCADE;
ALTER TABLE time_management.ot_request_decision ADD CONSTRAINT ot_request_decision_pkey PRIMARY KEY (id);
ALTER TABLE time_management.ot_request_decision ADD CONSTRAINT ot_request_decision_request_role_unq UNIQUE (overtime_request_id, role);
ALTER TABLE time_management.ot_request_decision ADD CONSTRAINT ot_request_decision_overtime_request_id_fkey FOREIGN KEY (overtime_request_id) REFERENCES time_management.ot_request(id) ON DELETE CASCADE;
ALTER TABLE time_management.ot_request_detail ADD CONSTRAINT ot_request_detail_pkey PRIMARY KEY (id);
ALTER TABLE time_management.ot_request_detail ADD CONSTRAINT ot_request_detail_request_date_unq UNIQUE (ot_request_id, work_date, ot_time_start);
ALTER TABLE time_management.ot_request_detail ADD CONSTRAINT ot_request_detail_ot_request_id_fkey FOREIGN KEY (ot_request_id) REFERENCES time_management.ot_request(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.pay_code ADD CONSTRAINT pay_code_pkey PRIMARY KEY (id);
ALTER TABLE time_management.pay_code_wage_type_map ADD CONSTRAINT pay_code_wage_type_map_pkey PRIMARY KEY (id);
ALTER TABLE time_management.shift_allowance_condition ADD CONSTRAINT shift_allowance_condition_pkey PRIMARY KEY (shift_allowance_condition_id);
ALTER TABLE time_management.shift_allowance_condition ADD CONSTRAINT shift_allowance_condition_unq UNIQUE (allowance_id, sequence_number);
ALTER TABLE time_management.shift_allowance_condition ADD CONSTRAINT shift_allowance_condition_allowance_id_fkey FOREIGN KEY (allowance_id) REFERENCES time_management.allowance(allowance_id) ON DELETE CASCADE;
ALTER TABLE time_management.time_attendance_policy ADD CONSTRAINT time_attendance_policy_pkey PRIMARY KEY (id);
ALTER TABLE time_management.time_clock_events ADD CONSTRAINT time_clock_events_pkey PRIMARY KEY (id);
ALTER TABLE time_management.time_clock_pair ADD CONSTRAINT timesheet_clock_pkey PRIMARY KEY (time_clock_pair_id);
ALTER TABLE time_management.time_clock_pair ADD CONSTRAINT timesheet_clock_timesheet_detail_id_fkey FOREIGN KEY (timesheet_detail_id) REFERENCES time_management.timesheet_detail(timesheet_detail_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.time_correction ADD CONSTRAINT time_correction_pkey PRIMARY KEY (time_correction_id);
ALTER TABLE time_management.time_correction ADD CONSTRAINT uq_time_correction_request_number UNIQUE (request_number);
ALTER TABLE time_management.time_correction_decisions ADD CONSTRAINT time_correction_decisions_pkey PRIMARY KEY (id);
ALTER TABLE time_management.time_correction_decisions ADD CONSTRAINT time_correction_decisions_time_correction_id_fkey FOREIGN KEY (time_correction_id) REFERENCES time_management.time_correction(time_correction_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.time_correction_detail ADD CONSTRAINT time_correction_detail_pkey PRIMARY KEY (time_correction_detail_id);
ALTER TABLE time_management.time_correction_detail ADD CONSTRAINT time_correction_detail_time_correction_id_fkey FOREIGN KEY (time_correction_id) REFERENCES time_management.time_correction(time_correction_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.time_result ADD CONSTRAINT time_result_pkey PRIMARY KEY (id);
ALTER TABLE time_management.time_status_mapping ADD CONSTRAINT time_status_mapping_pkey PRIMARY KEY (time_status_mapping_id);
ALTER TABLE time_management.time_status_mapping ADD CONSTRAINT time_status_mapping_time_status_code_fkey FOREIGN KEY (time_status_code) REFERENCES time_management.time_status_master(time_status_code) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.time_status_master ADD CONSTRAINT time_status_master_pkey PRIMARY KEY (time_status_master_id);
ALTER TABLE time_management.time_status_master ADD CONSTRAINT uq_time_status_master_code UNIQUE (time_status_code);
ALTER TABLE time_management.timesheet ADD CONSTRAINT timesheet_pkey PRIMARY KEY (timesheet_id);
ALTER TABLE time_management.timesheet_adjustment ADD CONSTRAINT timesheet_adjustment_pkey PRIMARY KEY (timesheet_adjustment_id);
ALTER TABLE time_management.timesheet_adjustment_detail ADD CONSTRAINT timesheet_adjustment_detail_pkey PRIMARY KEY (timesheet_adjustment_detail_id);
ALTER TABLE time_management.timesheet_adjustment_detail ADD CONSTRAINT timesheet_adjustment_detail_timesheet_adjustment_id_fkey FOREIGN KEY (timesheet_adjustment_id) REFERENCES time_management.timesheet_adjustment(timesheet_adjustment_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.timesheet_audit ADD CONSTRAINT timesheet_audit_pkey PRIMARY KEY (id);
ALTER TABLE time_management.timesheet_detail ADD CONSTRAINT timesheet_detail_pkey PRIMARY KEY (timesheet_detail_id);
ALTER TABLE time_management.timesheet_detail ADD CONSTRAINT timesheet_detail_timesheet_id_fkey FOREIGN KEY (timesheet_id) REFERENCES time_management.timesheet(timesheet_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.timesheet_detail_transaction ADD CONSTRAINT timesheet_detail_transaction_pkey PRIMARY KEY (timesheet_detail_transaction_id);
ALTER TABLE time_management.timesheet_detail_transaction ADD CONSTRAINT timesheet_detail_transaction_timesheet_detail_id_fkey FOREIGN KEY (timesheet_detail_id) REFERENCES time_management.timesheet_detail(timesheet_detail_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.timesheet_result ADD CONSTRAINT timesheet_result_pkey PRIMARY KEY (timesheet_result_id);
ALTER TABLE time_management.timesheet_result ADD CONSTRAINT timesheet_result_timesheet_detail_id_fkey FOREIGN KEY (timesheet_detail_id) REFERENCES time_management.timesheet_detail(timesheet_detail_id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE time_management.work_schedule ADD CONSTRAINT work_schedule_pkey PRIMARY KEY (work_schedule_id);
ALTER TABLE time_management.work_schedule_assignment ADD CONSTRAINT work_schedule_assignment_pkey PRIMARY KEY (work_schedule_assignment_id);
ALTER TABLE time_management.work_schedule_assignment ADD CONSTRAINT work_schedule_assignment_work_schedule_template_id_fkey FOREIGN KEY (work_schedule_template_id) REFERENCES time_management.work_schedule_template(work_schedule_template_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.work_schedule_default_mapping ADD CONSTRAINT work_schedule_default_mapping_pkey PRIMARY KEY (work_schedule_default_mapping_id);
ALTER TABLE time_management.work_schedule_default_mapping ADD CONSTRAINT work_schedule_default_mapping_work_schedule_template_id_fkey FOREIGN KEY (work_schedule_template_id) REFERENCES time_management.work_schedule_template(work_schedule_template_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.work_schedule_shift ADD CONSTRAINT work_schedule_shift_pkey PRIMARY KEY (work_schedule_shift_id);
ALTER TABLE time_management.work_schedule_shift ADD CONSTRAINT work_schedule_shift_source_template_day_id_fkey FOREIGN KEY (source_template_day_id) REFERENCES time_management.work_schedule_template_day(work_schedule_template_day_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.work_schedule_shift_assignment ADD CONSTRAINT work_schedule_shift_assignment_pkey PRIMARY KEY (shift_assignment_id);
ALTER TABLE time_management.work_schedule_shift_upload ADD CONSTRAINT work_schedule_shift_upload_pkey PRIMARY KEY (id);
ALTER TABLE time_management.work_schedule_template ADD CONSTRAINT work_schedule_template_pkey PRIMARY KEY (work_schedule_template_id);
ALTER TABLE time_management.work_schedule_template ADD CONSTRAINT work_schedule_template_work_schedule_id_fkey FOREIGN KEY (work_schedule_id) REFERENCES time_management.work_schedule(work_schedule_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE time_management.work_schedule_template_assignment ADD CONSTRAINT work_schedule_template_assignment_pkey PRIMARY KEY (template_assignment_id);
ALTER TABLE time_management.work_schedule_template_day ADD CONSTRAINT work_schedule_template_day_pkey PRIMARY KEY (work_schedule_template_day_id);
ALTER TABLE time_management.work_schedule_template_day ADD CONSTRAINT work_schedule_template_day_work_schedule_template_id_fkey FOREIGN KEY (work_schedule_template_id) REFERENCES time_management.work_schedule_template(work_schedule_template_id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE todo."SequelizeMeta_todo" ADD CONSTRAINT "SequelizeMeta_todo_pkey" PRIMARY KEY (name);
ALTER TABLE todo.todo_history ADD CONSTRAINT todo_history_pkey PRIMARY KEY (id);
ALTER TABLE todo.todo_history ADD CONSTRAINT todo_history_todo_id_fkey FOREIGN KEY (todo_id) REFERENCES todo.todos(id);
ALTER TABLE todo.todo_templates ADD CONSTRAINT todo_templates_pkey PRIMARY KEY (id);
ALTER TABLE todo.todos ADD CONSTRAINT todos_pkey PRIMARY KEY (id);
ALTER TABLE user_management."SequelizeMeta_user_management" ADD CONSTRAINT "SequelizeMeta_user_management_pkey" PRIMARY KEY (name);
ALTER TABLE user_management.grant_group_permissions ADD CONSTRAINT grant_group_permissions_pkey PRIMARY KEY (id);
ALTER TABLE user_management.grant_group_permissions ADD CONSTRAINT grant_group_permissions_ux UNIQUE (grant_group_id, permission_id);
ALTER TABLE user_management.grant_group_permissions ADD CONSTRAINT grant_group_permissions_grant_group_id_fkey FOREIGN KEY (grant_group_id) REFERENCES user_management.grant_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE user_management.grant_group_permissions ADD CONSTRAINT grant_group_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES user_management.permissions(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE user_management.grant_groups ADD CONSTRAINT grant_groups_pkey PRIMARY KEY (id);
ALTER TABLE user_management.grant_groups ADD CONSTRAINT grant_groups_code_ux UNIQUE (code);
ALTER TABLE user_management.permissions ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
ALTER TABLE user_management.permissions ADD CONSTRAINT permissions_code_ux UNIQUE (code);
ALTER TABLE user_management.target_groups ADD CONSTRAINT target_groups_pkey PRIMARY KEY (id);
ALTER TABLE user_management.target_groups ADD CONSTRAINT target_groups_code_ux UNIQUE (code);
ALTER TABLE user_management.user_group_grants ADD CONSTRAINT user_group_grants_pkey PRIMARY KEY (id);
ALTER TABLE user_management.user_group_grants ADD CONSTRAINT user_group_grants_ux UNIQUE (user_group_id, grant_group_id);
ALTER TABLE user_management.user_group_grants ADD CONSTRAINT user_group_grants_grant_group_id_fkey FOREIGN KEY (grant_group_id) REFERENCES user_management.grant_groups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE user_management.user_group_grants ADD CONSTRAINT user_group_grants_user_group_id_fkey FOREIGN KEY (user_group_id) REFERENCES user_management.user_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE user_management.user_group_members ADD CONSTRAINT user_group_members_pkey PRIMARY KEY (id);
ALTER TABLE user_management.user_group_members ADD CONSTRAINT user_group_members_identity_ck CHECK (((((member_type)::text = 'EMPLOYEE'::text) AND (employee_id IS NOT NULL) AND (population_code IS NULL)) OR (((member_type)::text = 'POPULATION'::text) AND (population_code IS NOT NULL) AND (employee_id IS NULL))));
ALTER TABLE user_management.user_group_members ADD CONSTRAINT user_group_members_user_group_id_fkey FOREIGN KEY (user_group_id) REFERENCES user_management.user_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE user_management.user_group_targets ADD CONSTRAINT user_group_targets_pkey PRIMARY KEY (id);
ALTER TABLE user_management.user_group_targets ADD CONSTRAINT user_group_targets_ux UNIQUE (user_group_id, target_group_id);
ALTER TABLE user_management.user_group_targets ADD CONSTRAINT user_group_targets_target_group_id_fkey FOREIGN KEY (target_group_id) REFERENCES user_management.target_groups(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE user_management.user_group_targets ADD CONSTRAINT user_group_targets_user_group_id_fkey FOREIGN KEY (user_group_id) REFERENCES user_management.user_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE user_management.user_groups ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);
ALTER TABLE user_management.user_groups ADD CONSTRAINT user_groups_code_ux UNIQUE (code);
ALTER TABLE workflow_service.wf_approver_assignment ADD CONSTRAINT wf_approver_assignment_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_approver_assignment ADD CONSTRAINT wf_approver_assignment_step_instance_id_key UNIQUE (step_instance_id);
ALTER TABLE workflow_service.wf_approver_assignment ADD CONSTRAINT chk_wf_aa_resolution_priority CHECK (((resolution_priority)::text = ANY ((ARRAY['EXPLICIT_USER'::character varying, 'POSITION'::character varying, 'HIGHER_LEVEL'::character varying, 'NONE'::character varying])::text[])));
ALTER TABLE workflow_service.wf_approver_assignment ADD CONSTRAINT chk_wf_aa_resolution_rule CHECK (((resolution_rule)::text = ANY ((ARRAY['EXPLICIT_USER'::character varying, 'POSITION_PREFERRED_USER'::character varying, 'POSITION_FIRST_ACTIVE'::character varying, 'HIGHER_LEVEL'::character varying, 'NONE'::character varying])::text[])));
ALTER TABLE workflow_service.wf_approver_assignment ADD CONSTRAINT wf_approver_assignment_step_instance_id_fkey FOREIGN KEY (step_instance_id) REFERENCES workflow_service.wf_step_instance(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_assignment_history ADD CONSTRAINT wf_assignment_history_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_assignment_history ADD CONSTRAINT wf_assignment_history_step_instance_id_fkey FOREIGN KEY (step_instance_id) REFERENCES workflow_service.wf_step_instance(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_process_definition ADD CONSTRAINT wf_process_definition_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_process_definition ADD CONSTRAINT wf_process_definition_camunda_process_key_key UNIQUE (camunda_process_key);
ALTER TABLE workflow_service.wf_process_instance ADD CONSTRAINT wf_process_instance_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_process_instance ADD CONSTRAINT wf_process_instance_camunda_process_instance_id_key UNIQUE (camunda_process_instance_id);
ALTER TABLE workflow_service.wf_process_instance ADD CONSTRAINT "workflow_service.wf_process_instance_status_ck" CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'COMPLETED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying, 'BLOCKED'::character varying])::text[])));
ALTER TABLE workflow_service.wf_process_instance ADD CONSTRAINT wf_process_instance_process_def_id_fkey FOREIGN KEY (process_def_id) REFERENCES workflow_service.wf_process_definition(id);
ALTER TABLE workflow_service.wf_process_step_definition ADD CONSTRAINT wf_process_step_definition_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_process_step_definition ADD CONSTRAINT "workflow_service.wf_process_step_definition_process_def_id_step" UNIQUE (process_def_id, step_key);
ALTER TABLE workflow_service.wf_process_step_definition ADD CONSTRAINT "workflow_service.wf_process_step_definition_no_approver_policy_" CHECK (((no_approver_policy)::text = ANY ((ARRAY['STOP'::character varying, 'AUTO'::character varying, 'NOTIFY_EVENT'::character varying])::text[])));
ALTER TABLE workflow_service.wf_process_step_definition ADD CONSTRAINT wf_process_step_definition_process_def_id_fkey FOREIGN KEY (process_def_id) REFERENCES workflow_service.wf_process_definition(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_step_action_history ADD CONSTRAINT wf_step_action_history_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_step_action_history ADD CONSTRAINT chk_wf_sah_action_type CHECK (((action_type)::text = ANY ((ARRAY['CLAIMED'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'COMPLETED'::character varying, 'DELEGATED'::character varying, 'AUTO_APPROVED'::character varying, 'NOTIFY_ONLY'::character varying, 'UNCLAIMED'::character varying, 'CANCELLED'::character varying])::text[])));
ALTER TABLE workflow_service.wf_step_action_history ADD CONSTRAINT wf_step_action_history_step_instance_id_fkey FOREIGN KEY (step_instance_id) REFERENCES workflow_service.wf_step_instance(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_step_instance ADD CONSTRAINT wf_step_instance_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_step_instance ADD CONSTRAINT wf_step_instance_camunda_task_id_key UNIQUE (camunda_task_id);
ALTER TABLE workflow_service.wf_step_instance ADD CONSTRAINT chk_wf_si_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'CLAIMED'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'COMPLETED'::character varying, 'AUTO_APPROVED'::character varying, 'NOTIFIED'::character varying, 'BLOCKED'::character varying, 'CANCELLED'::character varying])::text[])));
ALTER TABLE workflow_service.wf_step_instance ADD CONSTRAINT wf_step_instance_process_instance_id_fkey FOREIGN KEY (process_instance_id) REFERENCES workflow_service.wf_process_instance(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_step_instance ADD CONSTRAINT wf_step_instance_step_def_id_fkey FOREIGN KEY (step_def_id) REFERENCES workflow_service.wf_process_step_definition(id);
ALTER TABLE workflow_service.wf_user ADD CONSTRAINT wf_user_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_user ADD CONSTRAINT wf_user_email_key UNIQUE (email);
ALTER TABLE workflow_service.wf_workflow_audit_trail ADD CONSTRAINT wf_workflow_audit_trail_pkey PRIMARY KEY (id);
ALTER TABLE workflow_service.wf_workflow_audit_trail ADD CONSTRAINT chk_wf_at_action CHECK (((action)::text = ANY ((ARRAY['STARTED'::character varying, 'STEP_ASSIGNED'::character varying, 'STEP_ACTION'::character varying, 'STEP_REASSIGNED'::character varying, 'NO_APPROVER_POLICY_APPLIED'::character varying, 'COMPLETED'::character varying, 'REJECTED'::character varying, 'CANCELLED'::character varying, 'BLOCKED'::character varying, 'RECONCILED'::character varying])::text[])));
ALTER TABLE workflow_service.wf_workflow_audit_trail ADD CONSTRAINT wf_workflow_audit_trail_process_instance_id_fkey FOREIGN KEY (process_instance_id) REFERENCES workflow_service.wf_process_instance(id) ON DELETE CASCADE;
ALTER TABLE workflow_service.wf_workflow_audit_trail ADD CONSTRAINT wf_workflow_audit_trail_step_instance_id_fkey FOREIGN KEY (step_instance_id) REFERENCES workflow_service.wf_step_instance(id) ON DELETE SET NULL;
CREATE INDEX idx_benefit_eligibility_rule_plan_rule ON benefit_management.benefit_eligibility_rule USING btree (benefit_plan_id, rule_id);
CREATE INDEX idx_benefit_eligibility_rule_employee_group_code ON benefit_management.benefit_eligibility_rule USING btree (employee_group_code);
CREATE INDEX idx_benefit_eligibility_rule_benefit_plan_id ON benefit_management.benefit_eligibility_rule USING btree (benefit_plan_id);
CREATE INDEX idx_benefit_eligibility_rule_rule_id ON benefit_management.benefit_eligibility_rule USING btree (rule_id);
CREATE INDEX idx_benefit_eligibility_rule_rule_type ON benefit_management.benefit_eligibility_rule USING btree (rule_type);
CREATE INDEX idx_benefit_eligibility_rule_business_group_code ON benefit_management.benefit_eligibility_rule USING btree (business_group_code);
CREATE INDEX idx_benefit_eligibility_rule_business_unit_code ON benefit_management.benefit_eligibility_rule USING btree (business_unit_code);
CREATE INDEX benefit_history_logs_entity_name_entity_id ON benefit_management.benefit_history_logs USING btree (entity_name, entity_id);
CREATE INDEX idx_benefit_hospitals_hospital_code ON benefit_management.benefit_hospitals USING btree (hospital_code);
CREATE INDEX idx_benefit_hospitals_is_active ON benefit_management.benefit_hospitals USING btree (is_active);
CREATE INDEX idx_benefit_import_logs_type_status ON benefit_management.benefit_import_logs USING btree (import_type, status);
CREATE UNIQUE INDEX uq_benefit_import_logs_idempotency_key ON benefit_management.benefit_import_logs USING btree (idempotency_key);
CREATE UNIQUE INDEX uq_benefit_import_logs_import_id ON benefit_management.benefit_import_logs USING btree (import_id);
CREATE INDEX idx_benefit_plans_effective_end_date ON benefit_management.benefit_plan USING btree (effective_end_date);
CREATE INDEX idx_benefit_plans_benefit_type ON benefit_management.benefit_plan USING btree (benefit_type);
CREATE INDEX idx_benefit_plans_effective_start_date ON benefit_management.benefit_plan USING btree (effective_start_date);
CREATE INDEX idx_benefit_plans_country ON benefit_management.benefit_plan USING btree (country);
CREATE INDEX idx_benefit_plans_status ON benefit_management.benefit_plan USING btree (status);
CREATE INDEX idx_benefit_plans_benefit_plan_id ON benefit_management.benefit_plan USING btree (benefit_plan_id);
CREATE INDEX idx_benefit_plans_benefit_category ON benefit_management.benefit_plan USING btree (benefit_category);
CREATE INDEX idx_individual_benefit_plan_benefit_plan_id ON benefit_management.individual_benefit_plan USING btree (benefit_plan_id);
CREATE INDEX idx_individual_benefit_plan_effective_end_date ON benefit_management.individual_benefit_plan USING btree (effective_end_date);
CREATE UNIQUE INDEX uq_individual_benefit_plan_key ON benefit_management.individual_benefit_plan USING btree (user_id, year, benefit_plan_id, rule_id);
CREATE INDEX idx_individual_benefit_plan_effective_start_date ON benefit_management.individual_benefit_plan USING btree (effective_start_date);
CREATE INDEX idx_individual_benefit_plan_year ON benefit_management.individual_benefit_plan USING btree (year);
CREATE INDEX idx_individual_benefit_plan_rule_id ON benefit_management.individual_benefit_plan USING btree (rule_id);
CREATE INDEX idx_individual_benefit_plan_user_id ON benefit_management.individual_benefit_plan USING btree (user_id);
CREATE INDEX idx_individual_benefit_plan_status ON benefit_management.individual_benefit_plan USING btree (status);
CREATE INDEX idx_master_hospitals_is_active ON benefit_management.master_hospitals USING btree (is_active);
CREATE INDEX idx_master_hospitals_hospital_code ON benefit_management.master_hospitals USING btree (hospital_code);
CREATE INDEX act_idx_bytearray_name ON camunda.act_ge_bytearray USING btree (name_);
CREATE INDEX act_idx_bytearray_rm_time ON camunda.act_ge_bytearray USING btree (removal_time_);
CREATE INDEX act_idx_bytearray_root_pi ON camunda.act_ge_bytearray USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_bytear_depl ON camunda.act_ge_bytearray USING btree (deployment_id_);
CREATE INDEX act_idx_hi_act_inst_stats ON camunda.act_hi_actinst USING btree (proc_def_id_, proc_inst_id_, act_id_, end_time_, act_inst_state_);
CREATE INDEX act_idx_hi_ai_pdefid_end_time ON camunda.act_hi_actinst USING btree (proc_def_id_, end_time_);
CREATE INDEX act_idx_hi_act_inst_start_end ON camunda.act_hi_actinst USING btree (start_time_, end_time_);
CREATE INDEX act_idx_hi_act_inst_tenant_id ON camunda.act_hi_actinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_act_inst_procinst ON camunda.act_hi_actinst USING btree (proc_inst_id_, act_id_);
CREATE INDEX act_idx_hi_act_inst_end ON camunda.act_hi_actinst USING btree (end_time_);
CREATE INDEX act_idx_hi_actinst_root_pi ON camunda.act_hi_actinst USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_act_inst_comp ON camunda.act_hi_actinst USING btree (execution_id_, act_id_, end_time_, id_);
CREATE INDEX act_idx_hi_act_inst_proc_def_key ON camunda.act_hi_actinst USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_act_inst_rm_time ON camunda.act_hi_actinst USING btree (removal_time_);
CREATE INDEX act_idx_hi_attachment_root_pi ON camunda.act_hi_attachment USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_attachment_content ON camunda.act_hi_attachment USING btree (content_id_);
CREATE INDEX act_idx_hi_attachment_rm_time ON camunda.act_hi_attachment USING btree (removal_time_);
CREATE INDEX act_idx_hi_attachment_task ON camunda.act_hi_attachment USING btree (task_id_);
CREATE INDEX act_idx_hi_attachment_procinst ON camunda.act_hi_attachment USING btree (proc_inst_id_);
CREATE INDEX act_hi_bat_rm_time ON camunda.act_hi_batch USING btree (removal_time_);
CREATE INDEX act_idx_hi_cas_a_i_comp ON camunda.act_hi_caseactinst USING btree (case_act_id_, end_time_, id_);
CREATE INDEX act_idx_hi_cas_a_i_tenant_id ON camunda.act_hi_caseactinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_cas_a_i_create ON camunda.act_hi_caseactinst USING btree (create_time_);
CREATE INDEX act_idx_hi_cas_a_i_end ON camunda.act_hi_caseactinst USING btree (end_time_);
CREATE INDEX act_idx_hi_cas_i_tenant_id ON camunda.act_hi_caseinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_cas_i_buskey ON camunda.act_hi_caseinst USING btree (business_key_);
CREATE INDEX act_idx_hi_cas_i_close ON camunda.act_hi_caseinst USING btree (close_time_);
CREATE INDEX act_idx_hi_comment_root_pi ON camunda.act_hi_comment USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_comment_procinst ON camunda.act_hi_comment USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_comment_task ON camunda.act_hi_comment USING btree (task_id_);
CREATE INDEX act_idx_hi_comment_rm_time ON camunda.act_hi_comment USING btree (removal_time_);
CREATE INDEX act_idx_hi_dec_in_root_pi ON camunda.act_hi_dec_in USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_dec_in_inst ON camunda.act_hi_dec_in USING btree (dec_inst_id_);
CREATE INDEX act_idx_hi_dec_in_rm_time ON camunda.act_hi_dec_in USING btree (removal_time_);
CREATE INDEX act_idx_hi_dec_in_clause ON camunda.act_hi_dec_in USING btree (dec_inst_id_, clause_id_);
CREATE INDEX act_idx_hi_dec_out_inst ON camunda.act_hi_dec_out USING btree (dec_inst_id_);
CREATE INDEX act_idx_hi_dec_out_rule ON camunda.act_hi_dec_out USING btree (rule_order_, clause_id_);
CREATE INDEX act_idx_hi_dec_out_root_pi ON camunda.act_hi_dec_out USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_dec_out_rm_time ON camunda.act_hi_dec_out USING btree (removal_time_);
CREATE INDEX act_idx_hi_dec_inst_act_inst ON camunda.act_hi_decinst USING btree (act_inst_id_);
CREATE INDEX act_idx_hi_dec_inst_ci ON camunda.act_hi_decinst USING btree (case_inst_id_);
CREATE INDEX act_idx_hi_dec_inst_tenant_id ON camunda.act_hi_decinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_dec_inst_root_id ON camunda.act_hi_decinst USING btree (root_dec_inst_id_);
CREATE INDEX act_idx_hi_dec_inst_act ON camunda.act_hi_decinst USING btree (act_id_);
CREATE INDEX act_idx_hi_dec_inst_pi ON camunda.act_hi_decinst USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_dec_inst_time ON camunda.act_hi_decinst USING btree (eval_time_);
CREATE INDEX act_idx_hi_dec_inst_rm_time ON camunda.act_hi_decinst USING btree (removal_time_);
CREATE INDEX act_idx_hi_dec_inst_key ON camunda.act_hi_decinst USING btree (dec_def_key_);
CREATE INDEX act_idx_hi_dec_inst_root_pi ON camunda.act_hi_decinst USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_dec_inst_req_key ON camunda.act_hi_decinst USING btree (dec_req_key_);
CREATE INDEX act_idx_hi_dec_inst_id ON camunda.act_hi_decinst USING btree (dec_def_id_);
CREATE INDEX act_idx_hi_dec_inst_req_id ON camunda.act_hi_decinst USING btree (dec_req_id_);
CREATE INDEX act_idx_hi_detail_name ON camunda.act_hi_detail USING btree (name_);
CREATE INDEX act_idx_hi_detail_time ON camunda.act_hi_detail USING btree (time_);
CREATE INDEX act_idx_hi_detail_task_bytear ON camunda.act_hi_detail USING btree (bytearray_id_, task_id_);
CREATE INDEX act_idx_hi_detail_task_id ON camunda.act_hi_detail USING btree (task_id_);
CREATE INDEX act_idx_hi_detail_root_pi ON camunda.act_hi_detail USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_detail_act_inst ON camunda.act_hi_detail USING btree (act_inst_id_);
CREATE INDEX act_idx_hi_detail_bytear ON camunda.act_hi_detail USING btree (bytearray_id_);
CREATE INDEX act_idx_hi_detail_rm_time ON camunda.act_hi_detail USING btree (removal_time_);
CREATE INDEX act_idx_hi_detail_case_exec ON camunda.act_hi_detail USING btree (case_execution_id_);
CREATE INDEX act_idx_hi_detail_tenant_id ON camunda.act_hi_detail USING btree (tenant_id_);
CREATE INDEX act_idx_hi_detail_proc_inst ON camunda.act_hi_detail USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_detail_var_inst_id ON camunda.act_hi_detail USING btree (var_inst_id_);
CREATE INDEX act_idx_hi_detail_case_inst ON camunda.act_hi_detail USING btree (case_inst_id_);
CREATE INDEX act_idx_hi_detail_proc_def_key ON camunda.act_hi_detail USING btree (proc_def_key_);
CREATE INDEX act_hi_ext_task_log_proc_def_key ON camunda.act_hi_ext_task_log USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_exttasklog_errordet ON camunda.act_hi_ext_task_log USING btree (error_details_id_);
CREATE INDEX act_hi_ext_task_log_root_pi ON camunda.act_hi_ext_task_log USING btree (root_proc_inst_id_);
CREATE INDEX act_hi_ext_task_log_procinst ON camunda.act_hi_ext_task_log USING btree (proc_inst_id_);
CREATE INDEX act_hi_ext_task_log_rm_time ON camunda.act_hi_ext_task_log USING btree (removal_time_);
CREATE INDEX act_hi_ext_task_log_procdef ON camunda.act_hi_ext_task_log USING btree (proc_def_id_);
CREATE INDEX act_hi_ext_task_log_tenant_id ON camunda.act_hi_ext_task_log USING btree (tenant_id_);
CREATE INDEX act_idx_hi_ident_link_task ON camunda.act_hi_identitylink USING btree (task_id_);
CREATE INDEX act_idx_hi_ident_lnk_tenant_id ON camunda.act_hi_identitylink USING btree (tenant_id_);
CREATE INDEX act_idx_hi_ident_lnk_user ON camunda.act_hi_identitylink USING btree (user_id_);
CREATE INDEX act_idx_hi_ident_lnk_group ON camunda.act_hi_identitylink USING btree (group_id_);
CREATE INDEX act_idx_hi_ident_lnk_root_pi ON camunda.act_hi_identitylink USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_ident_lnk_proc_def_key ON camunda.act_hi_identitylink USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_ident_link_rm_time ON camunda.act_hi_identitylink USING btree (removal_time_);
CREATE INDEX act_idx_hi_ident_lnk_timestamp ON camunda.act_hi_identitylink USING btree (timestamp_);
CREATE INDEX act_idx_hi_incident_create_time ON camunda.act_hi_incident USING btree (create_time_);
CREATE INDEX act_idx_hi_incident_root_pi ON camunda.act_hi_incident USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_incident_rm_time ON camunda.act_hi_incident USING btree (removal_time_);
CREATE INDEX act_idx_hi_incident_procinst ON camunda.act_hi_incident USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_incident_proc_def_key ON camunda.act_hi_incident USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_incident_end_time ON camunda.act_hi_incident USING btree (end_time_);
CREATE INDEX act_idx_hi_incident_tenant_id ON camunda.act_hi_incident USING btree (tenant_id_);
CREATE INDEX act_idx_hi_job_log_proc_def_key ON camunda.act_hi_job_log USING btree (process_def_key_);
CREATE INDEX act_idx_hi_job_log_ex_stack ON camunda.act_hi_job_log USING btree (job_exception_stack_id_);
CREATE INDEX act_idx_hi_job_log_job_conf ON camunda.act_hi_job_log USING btree (job_def_configuration_);
CREATE INDEX act_idx_hi_job_log_tenant_id ON camunda.act_hi_job_log USING btree (tenant_id_);
CREATE INDEX act_idx_hi_job_log_procdef ON camunda.act_hi_job_log USING btree (process_def_id_);
CREATE INDEX act_idx_hi_job_log_procinst ON camunda.act_hi_job_log USING btree (process_instance_id_);
CREATE INDEX act_idx_hi_job_log_root_pi ON camunda.act_hi_job_log USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_job_log_rm_time ON camunda.act_hi_job_log USING btree (removal_time_);
CREATE INDEX act_idx_hi_job_log_job_def_id ON camunda.act_hi_job_log USING btree (job_def_id_);
CREATE INDEX act_idx_hi_op_log_task ON camunda.act_hi_op_log USING btree (task_id_);
CREATE INDEX act_idx_hi_op_log_user_id ON camunda.act_hi_op_log USING btree (user_id_);
CREATE INDEX act_idx_hi_op_log_rm_time ON camunda.act_hi_op_log USING btree (removal_time_);
CREATE INDEX act_idx_hi_op_log_procdef ON camunda.act_hi_op_log USING btree (proc_def_id_);
CREATE INDEX act_idx_hi_op_log_root_pi ON camunda.act_hi_op_log USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_op_log_op_type ON camunda.act_hi_op_log USING btree (operation_type_);
CREATE INDEX act_idx_hi_op_log_timestamp ON camunda.act_hi_op_log USING btree (timestamp_);
CREATE INDEX act_idx_hi_op_log_entity_type ON camunda.act_hi_op_log USING btree (entity_type_);
CREATE INDEX act_idx_hi_op_log_procinst ON camunda.act_hi_op_log USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_pro_i_buskey ON camunda.act_hi_procinst USING btree (business_key_);
CREATE INDEX act_idx_hi_pro_inst_proc_time ON camunda.act_hi_procinst USING btree (start_time_, end_time_);
CREATE INDEX act_idx_hi_pro_rst_pro_inst_id ON camunda.act_hi_procinst USING btree (restarted_proc_inst_id_);
CREATE INDEX act_idx_hi_pro_inst_root_pi ON camunda.act_hi_procinst USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_pro_inst_rm_time ON camunda.act_hi_procinst USING btree (removal_time_);
CREATE INDEX act_idx_hi_pro_inst_tenant_id ON camunda.act_hi_procinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_pro_inst_proc_def_key ON camunda.act_hi_procinst USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_pro_inst_end ON camunda.act_hi_procinst USING btree (end_time_);
CREATE INDEX act_idx_hi_pi_pdefid_end_time ON camunda.act_hi_procinst USING btree (proc_def_id_, end_time_);
CREATE INDEX act_idx_hi_task_inst_end ON camunda.act_hi_taskinst USING btree (end_time_);
CREATE INDEX act_idx_hi_taskinstid_procinst ON camunda.act_hi_taskinst USING btree (id_, proc_inst_id_);
CREATE INDEX act_idx_hi_task_inst_rm_time ON camunda.act_hi_taskinst USING btree (removal_time_);
CREATE INDEX act_idx_hi_task_inst_proc_def_key ON camunda.act_hi_taskinst USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_taskinst_root_pi ON camunda.act_hi_taskinst USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_taskinst_procinst ON camunda.act_hi_taskinst USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_task_inst_start ON camunda.act_hi_taskinst USING btree (start_time_);
CREATE INDEX act_idx_hi_task_inst_tenant_id ON camunda.act_hi_taskinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_varinst_act_inst_id ON camunda.act_hi_varinst USING btree (act_inst_id_);
CREATE INDEX act_idx_hi_var_inst_proc_def_key ON camunda.act_hi_varinst USING btree (proc_def_key_);
CREATE INDEX act_idx_hi_casevar_case_inst ON camunda.act_hi_varinst USING btree (case_inst_id_);
CREATE INDEX act_idx_hi_varinst_root_pi ON camunda.act_hi_varinst USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_hi_varinst_name ON camunda.act_hi_varinst USING btree (name_);
CREATE INDEX act_idx_hi_var_inst_tenant_id ON camunda.act_hi_varinst USING btree (tenant_id_);
CREATE INDEX act_idx_hi_varinst_rm_time ON camunda.act_hi_varinst USING btree (removal_time_);
CREATE INDEX act_idx_hi_procvar_proc_inst ON camunda.act_hi_varinst USING btree (proc_inst_id_);
CREATE INDEX act_idx_hi_procvar_name_type ON camunda.act_hi_varinst USING btree (name_, var_type_);
CREATE INDEX act_idx_hi_varinst_bytear ON camunda.act_hi_varinst USING btree (bytearray_id_);
CREATE INDEX act_idx_hi_var_pi_name_type ON camunda.act_hi_varinst USING btree (proc_inst_id_, name_, var_type_);
CREATE INDEX act_idx_memb_user ON camunda.act_id_membership USING btree (user_id_);
CREATE INDEX act_idx_memb_group ON camunda.act_id_membership USING btree (group_id_);
CREATE INDEX act_idx_tenant_memb_group ON camunda.act_id_tenant_member USING btree (group_id_);
CREATE INDEX act_idx_tenant_memb_user ON camunda.act_id_tenant_member USING btree (user_id_);
CREATE INDEX act_idx_tenant_memb ON camunda.act_id_tenant_member USING btree (tenant_id_);
CREATE INDEX act_idx_case_def_tenant_id ON camunda.act_re_case_def USING btree (tenant_id_);
CREATE INDEX act_idx_dec_def_req_id ON camunda.act_re_decision_def USING btree (dec_req_id_);
CREATE INDEX act_idx_dec_def_tenant_id ON camunda.act_re_decision_def USING btree (tenant_id_);
CREATE INDEX act_idx_dec_req_def_tenant_id ON camunda.act_re_decision_req_def USING btree (tenant_id_);
CREATE INDEX act_idx_deployment_name ON camunda.act_re_deployment USING btree (name_);
CREATE INDEX act_idx_deployment_tenant_id ON camunda.act_re_deployment USING btree (tenant_id_);
CREATE INDEX act_idx_procdef_ver_tag ON camunda.act_re_procdef USING btree (version_tag_);
CREATE INDEX act_idx_procdef_tenant_id ON camunda.act_re_procdef USING btree (tenant_id_);
CREATE INDEX act_idx_procdef_deployment_id ON camunda.act_re_procdef USING btree (deployment_id_);
CREATE INDEX act_idx_auth_resource_id ON camunda.act_ru_authorization USING btree (resource_id_);
CREATE INDEX act_idx_auth_rm_time ON camunda.act_ru_authorization USING btree (removal_time_);
CREATE INDEX act_idx_auth_root_pi ON camunda.act_ru_authorization USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_auth_group_id ON camunda.act_ru_authorization USING btree (group_id_);
CREATE INDEX act_idx_batch_job_def ON camunda.act_ru_batch USING btree (batch_job_def_id_);
CREATE INDEX act_idx_batch_seed_job_def ON camunda.act_ru_batch USING btree (seed_job_def_id_);
CREATE INDEX act_idx_batch_monitor_job_def ON camunda.act_ru_batch USING btree (monitor_job_def_id_);
CREATE INDEX act_idx_case_exec_tenant_id ON camunda.act_ru_case_execution USING btree (tenant_id_);
CREATE INDEX act_idx_case_exe_case_inst ON camunda.act_ru_case_execution USING btree (case_inst_id_);
CREATE INDEX act_idx_case_exe_parent ON camunda.act_ru_case_execution USING btree (parent_id_);
CREATE INDEX act_idx_case_exec_buskey ON camunda.act_ru_case_execution USING btree (business_key_);
CREATE INDEX act_idx_case_exe_case_def ON camunda.act_ru_case_execution USING btree (case_def_id_);
CREATE INDEX act_idx_case_sentry_case_inst ON camunda.act_ru_case_sentry_part USING btree (case_inst_id_);
CREATE INDEX act_idx_case_sentry_case_exec ON camunda.act_ru_case_sentry_part USING btree (case_exec_id_);
CREATE INDEX act_idx_event_subscr_tenant_id ON camunda.act_ru_event_subscr USING btree (tenant_id_);
CREATE INDEX act_idx_event_subscr ON camunda.act_ru_event_subscr USING btree (execution_id_);
CREATE INDEX act_idx_event_subscr_config_ ON camunda.act_ru_event_subscr USING btree (configuration_);
CREATE INDEX act_idx_event_subscr_evt_name ON camunda.act_ru_event_subscr USING btree (event_name_);
CREATE INDEX act_idx_exe_procdef ON camunda.act_ru_execution USING btree (proc_def_id_);
CREATE INDEX act_idx_exe_super ON camunda.act_ru_execution USING btree (super_exec_);
CREATE INDEX act_idx_exe_root_pi ON camunda.act_ru_execution USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_exec_tenant_id ON camunda.act_ru_execution USING btree (tenant_id_);
CREATE INDEX act_idx_exe_procinst ON camunda.act_ru_execution USING btree (proc_inst_id_);
CREATE INDEX act_idx_exe_parent ON camunda.act_ru_execution USING btree (parent_id_);
CREATE INDEX act_idx_exec_buskey ON camunda.act_ru_execution USING btree (business_key_);
CREATE INDEX act_idx_ext_task_tenant_id ON camunda.act_ru_ext_task USING btree (tenant_id_);
CREATE INDEX act_idx_ext_task_exec ON camunda.act_ru_ext_task USING btree (execution_id_);
CREATE INDEX act_idx_ext_task_err_details ON camunda.act_ru_ext_task USING btree (error_details_id_);
CREATE INDEX act_idx_ext_task_topic ON camunda.act_ru_ext_task USING btree (topic_name_);
CREATE INDEX act_idx_ext_task_priority ON camunda.act_ru_ext_task USING btree (priority_);
CREATE INDEX act_idx_tskass_task ON camunda.act_ru_identitylink USING btree (task_id_);
CREATE INDEX act_idx_athrz_procedef ON camunda.act_ru_identitylink USING btree (proc_def_id_);
CREATE INDEX act_idx_ident_lnk_user ON camunda.act_ru_identitylink USING btree (user_id_);
CREATE INDEX act_idx_ident_lnk_group ON camunda.act_ru_identitylink USING btree (group_id_);
CREATE INDEX act_idx_inc_configuration ON camunda.act_ru_incident USING btree (configuration_);
CREATE INDEX act_idx_inc_procinstid ON camunda.act_ru_incident USING btree (proc_inst_id_);
CREATE INDEX act_idx_inc_procdefid ON camunda.act_ru_incident USING btree (proc_def_id_);
CREATE INDEX act_idx_inc_job_def ON camunda.act_ru_incident USING btree (job_def_id_);
CREATE INDEX act_idx_inc_tenant_id ON camunda.act_ru_incident USING btree (tenant_id_);
CREATE INDEX act_idx_inc_causeincid ON camunda.act_ru_incident USING btree (cause_incident_id_);
CREATE INDEX act_idx_inc_exid ON camunda.act_ru_incident USING btree (execution_id_);
CREATE INDEX act_idx_inc_rootcauseincid ON camunda.act_ru_incident USING btree (root_cause_incident_id_);
CREATE INDEX act_idx_job_tenant_id ON camunda.act_ru_job USING btree (tenant_id_);
CREATE INDEX act_idx_job_execution_id ON camunda.act_ru_job USING btree (execution_id_);
CREATE INDEX act_idx_job_procinst ON camunda.act_ru_job USING btree (process_instance_id_);
CREATE INDEX act_idx_job_handler_type ON camunda.act_ru_job USING btree (handler_type_);
CREATE INDEX act_idx_job_handler ON camunda.act_ru_job USING btree (handler_type_, handler_cfg_);
CREATE INDEX act_idx_job_exception ON camunda.act_ru_job USING btree (exception_stack_id_);
CREATE INDEX act_idx_job_job_def_id ON camunda.act_ru_job USING btree (job_def_id_);
CREATE INDEX act_idx_job_root_procinst ON camunda.act_ru_job USING btree (root_proc_inst_id_);
CREATE INDEX act_idx_jobdef_tenant_id ON camunda.act_ru_jobdef USING btree (tenant_id_);
CREATE INDEX act_idx_jobdef_proc_def_id ON camunda.act_ru_jobdef USING btree (proc_def_id_);
CREATE INDEX act_idx_meter_log_name_ms ON camunda.act_ru_meter_log USING btree (name_, milliseconds_);
CREATE INDEX act_idx_meter_log_report ON camunda.act_ru_meter_log USING btree (name_, reporter_, milliseconds_);
CREATE INDEX act_idx_meter_log_ms ON camunda.act_ru_meter_log USING btree (milliseconds_);
CREATE INDEX act_idx_meter_log ON camunda.act_ru_meter_log USING btree (name_, timestamp_);
CREATE INDEX act_idx_meter_log_time ON camunda.act_ru_meter_log USING btree (timestamp_);
CREATE INDEX act_idx_task_case_def_id ON camunda.act_ru_task USING btree (case_def_id_);
CREATE INDEX act_idx_task_last_updated ON camunda.act_ru_task USING btree (last_updated_);
CREATE INDEX act_idx_task_owner ON camunda.act_ru_task USING btree (owner_);
CREATE INDEX act_idx_task_procinst ON camunda.act_ru_task USING btree (proc_inst_id_);
CREATE INDEX act_idx_task_case_exec ON camunda.act_ru_task USING btree (case_execution_id_);
CREATE INDEX act_idx_task_assignee ON camunda.act_ru_task USING btree (assignee_);
CREATE INDEX act_idx_task_procdef ON camunda.act_ru_task USING btree (proc_def_id_);
CREATE INDEX act_idx_task_create ON camunda.act_ru_task USING btree (create_time_);
CREATE INDEX act_idx_task_tenant_id ON camunda.act_ru_task USING btree (tenant_id_);
CREATE INDEX act_idx_task_exec ON camunda.act_ru_task USING btree (execution_id_);
CREATE INDEX act_idx_task_meter_log_time ON camunda.act_ru_task_meter_log USING btree (timestamp_);
CREATE INDEX act_idx_var_procinst ON camunda.act_ru_variable USING btree (proc_inst_id_);
CREATE INDEX act_idx_variable_tenant_id ON camunda.act_ru_variable USING btree (tenant_id_);
CREATE INDEX act_idx_var_case_inst_id ON camunda.act_ru_variable USING btree (case_inst_id_);
CREATE INDEX act_idx_batch_id ON camunda.act_ru_variable USING btree (batch_id_);
CREATE INDEX act_idx_variable_task_name_type ON camunda.act_ru_variable USING btree (task_id_, name_, type_);
CREATE INDEX act_idx_variable_task_id ON camunda.act_ru_variable USING btree (task_id_);
CREATE INDEX act_idx_var_exe ON camunda.act_ru_variable USING btree (execution_id_);
CREATE INDEX act_idx_var_case_exe ON camunda.act_ru_variable USING btree (case_execution_id_);
CREATE INDEX act_idx_var_bytearray ON camunda.act_ru_variable USING btree (bytearray_id_);
CREATE INDEX idx_requests_source_module ON change_tracking.audit_change_requests USING btree (source_module, applied_at);
CREATE INDEX idx_requests_applied_by ON change_tracking.audit_change_requests USING btree (applied_by);
CREATE INDEX idx_requests_requested_by ON change_tracking.audit_change_requests USING btree (requested_by);
CREATE INDEX idx_requests_entity_history ON change_tracking.audit_change_requests USING btree (entity_type, entity_id, applied_at);
CREATE INDEX idx_requests_approved_by ON change_tracking.audit_change_requests USING btree (approved_by);
CREATE INDEX idx_requests_applied_at ON change_tracking.audit_change_requests USING btree (applied_at);
CREATE INDEX idx_field_changes_request_id ON change_tracking.audit_field_changes USING btree (audit_change_request_id);
CREATE INDEX idx_field_changes_field_name ON change_tracking.audit_field_changes USING btree (field_name, created_at);
CREATE UNIQUE INDEX languages_is_default_ux ON content_management.languages USING btree (is_default) WHERE (is_default = true);
CREATE INDEX languages_active_order_ix ON content_management.languages USING btree (is_active, display_order);
CREATE INDEX menu_items_audience_gin ON content_management.menu_items USING gin (audience_roles);
CREATE UNIQUE INDEX menu_items_context_code_lower_ux ON content_management.menu_items USING btree (context, lower((code)::text));
CREATE INDEX menu_items_context_active_order_ix ON content_management.menu_items USING btree (context, is_active, display_order);
CREATE INDEX news_updates_audience_gin ON content_management.news_updates USING gin (audience_roles);
CREATE UNIQUE INDEX news_updates_group_language_ux ON content_management.news_updates USING btree (group_id, language);
CREATE INDEX news_updates_expires_ix ON content_management.news_updates USING btree (expires_at) WHERE (expires_at IS NOT NULL);
CREATE INDEX news_updates_detail_ix ON content_management.news_updates USING btree (group_id, is_main DESC, language);
CREATE UNIQUE INDEX news_updates_group_main_ux ON content_management.news_updates USING btree (group_id) WHERE (is_main = true);
CREATE INDEX news_updates_list_ix ON content_management.news_updates USING btree (language, is_active, publish_at DESC);
CREATE INDEX quick_actions_audience_gin ON content_management.quick_actions USING gin (audience_roles);
CREATE INDEX quick_actions_active_order_ix ON content_management.quick_actions USING btree (is_active, display_order);
CREATE UNIQUE INDEX quick_actions_code_lower_ux ON content_management.quick_actions USING btree (lower((code)::text));
CREATE INDEX delegations_delegator_period_ix ON delegation.delegations USING btree (delegator_employee_id, start_date, end_date) WHERE (deleted_at IS NULL);
CREATE INDEX employee_info_transaction_requests_camunda_process_instance_id ON employee_center.employee_info_transaction_requests USING hash (camunda_process_instance_id);
CREATE INDEX employee_info_transaction_requests_duplicate_key_idx ON employee_center.employee_info_transaction_requests USING btree (person_id, request_sub_type, effective_date);
CREATE INDEX idx_transaction_new_hire_owner_emp_id ON employee_center.transaction_new_hire USING btree (owner_emp_id);
CREATE INDEX idx_transaction_new_hire_customer_id ON employee_center.transaction_new_hire USING btree (customer_id);
CREATE INDEX idx_change_log_applied_at ON employee_management.change_log USING btree (applied_at);
CREATE INDEX idx_change_log_entity ON employee_management.change_log USING btree (entity_type, entity_id);
CREATE INDEX idx_agent_logs_agent_id ON grim.agent_logs USING btree (agent_id);
CREATE INDEX idx_agent_logs_category ON grim.agent_logs USING btree (event_category);
CREATE INDEX idx_agent_logs_category_type ON grim.agent_logs USING btree (event_category, event_type);
CREATE INDEX idx_agent_logs_session ON grim.agent_logs USING btree (session_id) WHERE (session_id IS NOT NULL);
CREATE INDEX idx_agent_logs_agent_time ON grim.agent_logs USING btree (agent_id, "timestamp" DESC);
CREATE INDEX idx_agent_logs_type ON grim.agent_logs USING btree (event_type);
CREATE INDEX idx_agent_logs_task_slug ON grim.agent_logs USING btree (task_slug) WHERE (task_slug IS NOT NULL);
CREATE INDEX idx_agent_logs_adw_id ON grim.agent_logs USING btree (adw_id) WHERE (adw_id IS NOT NULL);
CREATE INDEX idx_agent_logs_task_index ON grim.agent_logs USING btree (task_slug, entry_index) WHERE (task_slug IS NOT NULL);
CREATE INDEX idx_agent_logs_adw_step ON grim.agent_logs USING btree (adw_step) WHERE (adw_step IS NOT NULL);
CREATE INDEX idx_agent_logs_timestamp ON grim.agent_logs USING btree ("timestamp" DESC);
CREATE INDEX idx_agents_name ON grim.agents USING btree (name);
CREATE INDEX idx_agents_status ON grim.agents USING btree (status);
CREATE INDEX idx_agents_archived ON grim.agents USING btree (archived);
CREATE INDEX idx_agents_updated_at ON grim.agents USING btree (updated_at DESC);
CREATE INDEX idx_adw_active ON grim.ai_developer_workflows USING btree (orchestrator_agent_id, status) WHERE (status = ANY (ARRAY['pending'::text, 'in_progress'::text]));
CREATE INDEX idx_adw_orchestrator ON grim.ai_developer_workflows USING btree (orchestrator_agent_id);
CREATE INDEX idx_adw_workflow_type ON grim.ai_developer_workflows USING btree (workflow_type);
CREATE INDEX idx_adw_status ON grim.ai_developer_workflows USING btree (status);
CREATE INDEX idx_adw_created ON grim.ai_developer_workflows USING btree (created_at DESC);
CREATE UNIQUE INDEX idx_catalogs_orch_name ON grim.catalogs USING btree (orchestrator_agent_id, name);
CREATE INDEX idx_catalogs_orch_active ON grim.catalogs USING btree (orchestrator_agent_id, active);
CREATE INDEX idx_check_collections_orchestrator ON grim.check_collections USING btree (orchestrator_agent_id);
CREATE UNIQUE INDEX idx_check_collections_active_name ON grim.check_collections USING btree (orchestrator_agent_id, name) WHERE active;
CREATE INDEX idx_oracle_requests_status ON grim.oracle_requests USING btree (status);
CREATE INDEX idx_orchestrator_agents_status ON grim.orchestrator_agents USING btree (status);
CREATE INDEX idx_orchestrator_agents_updated_at ON grim.orchestrator_agents USING btree (updated_at DESC);
CREATE INDEX idx_orchestrator_chat_orch_created ON grim.orchestrator_chat USING btree (orchestrator_agent_id, created_at DESC);
CREATE INDEX idx_orchestrator_chat_agent_id ON grim.orchestrator_chat USING btree (agent_id);
CREATE INDEX idx_orchestrator_chat_orch_id ON grim.orchestrator_chat USING btree (orchestrator_agent_id);
CREATE INDEX idx_orchestrator_chat_agent_created ON grim.orchestrator_chat USING btree (agent_id, created_at DESC);
CREATE INDEX idx_orchestrator_chat_receiver_type ON grim.orchestrator_chat USING btree (receiver_type);
CREATE INDEX idx_orchestrator_chat_sender_type ON grim.orchestrator_chat USING btree (sender_type);
CREATE INDEX idx_prompts_author ON grim.prompts USING btree (author);
CREATE INDEX idx_prompts_task_slug ON grim.prompts USING btree (task_slug) WHERE (task_slug IS NOT NULL);
CREATE INDEX idx_prompts_timestamp ON grim.prompts USING btree ("timestamp" DESC);
CREATE INDEX idx_prompts_agent_id ON grim.prompts USING btree (agent_id);
CREATE INDEX idx_regression_chain_steps_chain ON grim.regression_chain_steps USING btree (chain_id);
CREATE INDEX idx_regression_chains_active ON grim.regression_chains USING btree (active);
CREATE UNIQUE INDEX idx_regression_chains_active_name ON grim.regression_chains USING btree (orchestrator_agent_id, scope, name) WHERE active;
CREATE INDEX idx_regression_chains_orchestrator_scope ON grim.regression_chains USING btree (orchestrator_agent_id, scope);
CREATE UNIQUE INDEX idx_regression_checks_active_command ON grim.regression_checks USING btree (orchestrator_agent_id, scope, md5(command)) WHERE active;
CREATE INDEX idx_regression_checks_active ON grim.regression_checks USING btree (active);
CREATE INDEX idx_regression_checks_runtime_flow ON grim.regression_checks USING btree (orchestrator_agent_id, scope) WHERE ((flow_path IS NOT NULL) AND active);
CREATE INDEX idx_regression_checks_orchestrator_scope ON grim.regression_checks USING btree (orchestrator_agent_id, scope);
CREATE INDEX idx_system_logs_timestamp ON grim.system_logs USING btree ("timestamp" DESC);
CREATE INDEX idx_system_logs_adw_id ON grim.system_logs USING btree (adw_id) WHERE (adw_id IS NOT NULL);
CREATE INDEX idx_system_logs_adw_step ON grim.system_logs USING btree (adw_step) WHERE (adw_step IS NOT NULL);
CREATE INDEX idx_system_logs_level ON grim.system_logs USING btree (level);
CREATE INDEX idx_verification_checks_verification ON grim.verification_checks USING btree (verification_id);
CREATE INDEX idx_verification_checks_verdict ON grim.verification_checks USING btree (verdict);
CREATE INDEX idx_verification_schedules_collection ON grim.verification_schedules USING btree (collection_id);
CREATE INDEX idx_verification_schedules_due ON grim.verification_schedules USING btree (status, next_run_at);
CREATE INDEX idx_verifications_task_slug ON grim.verifications USING btree (task_slug) WHERE (task_slug IS NOT NULL);
CREATE INDEX idx_verifications_builder_task ON grim.verifications USING btree (verified_agent_id, ((metadata ->> 'builder_task_slug'::text)));
CREATE INDEX idx_verifications_orchestrator ON grim.verifications USING btree (orchestrator_agent_id);
CREATE INDEX idx_verifications_status ON grim.verifications USING btree (status);
CREATE INDEX idx_verifications_created ON grim.verifications USING btree (created_at DESC);
CREATE INDEX idx_verifications_agent ON grim.verifications USING btree (agent_id);
CREATE INDEX notification_history_event_id ON notification.notification_history USING btree (event_id);
CREATE INDEX notification_history_template_code_status_attempted_at ON notification.notification_history USING btree (template_code, status, attempted_at);
CREATE INDEX notification_history_recipient_employee_id_attempted_at ON notification.notification_history USING btree (recipient_employee_id, attempted_at);
CREATE INDEX notification_templates_is_active ON notification.notification_templates USING btree (is_active);
CREATE UNIQUE INDEX notification_templates_code ON notification.notification_templates USING btree (code);
CREATE INDEX notifications_employee_id_category ON notification.notifications USING btree (employee_id, category);
CREATE INDEX notifications_employee_id_status_created_at ON notification.notifications USING btree (employee_id, status, created_at);
CREATE INDEX notifications_deleted_at ON notification.notifications USING btree (deleted_at);
CREATE INDEX idx_audit_log_created ON payroll.audit_log USING btree (performed_at DESC);
CREATE INDEX idx_audit_log_entity ON payroll.audit_log USING btree (entity_type, entity_id);
CREATE INDEX idx_bank_transfer_files_company_period ON payroll.bank_transfer_files USING btree (company_code, for_period);
CREATE INDEX idx_bank_transfer_files_area_period ON payroll.bank_transfer_files USING btree (payroll_area_code, for_period);
CREATE INDEX idx_emp_leave_entries_emp_date ON payroll.employee_leave_entries USING btree (company_code, employee_code, leave_date);
CREATE INDEX idx_emp_retro_entries_emp_period ON payroll.employee_retro_entries USING btree (employee_code, period_key);
CREATE INDEX idx_emp_time_entries_emp_period_wt ON payroll.employee_time_entries USING btree (employee_code, period_key, wage_type);
CREATE INDEX idx_emp_time_entries_emp_period ON payroll.employee_time_entries USING btree (employee_code, period_key);
CREATE INDEX idx_payroll_result_items_result ON payroll.payroll_result_items USING btree (payroll_result_id);
CREATE INDEX idx_payroll_result_items_subtable ON payroll.payroll_result_items USING btree (payroll_result_id, sub_table);
CREATE INDEX idx_payroll_results_emp_period ON payroll.payroll_results USING btree (employee_code, for_period, is_latest);
CREATE INDEX idx_payroll_results_simulation ON payroll.payroll_results USING btree (payroll_run_id) WHERE (is_simulation = true);
CREATE INDEX idx_payroll_results_run_latest ON payroll.payroll_results USING btree (payroll_run_id, is_latest);
CREATE INDEX idx_payroll_run_logs_run_created ON payroll.payroll_run_logs USING btree (payroll_run_id, created_at);
CREATE INDEX idx_payroll_run_logs_level ON payroll.payroll_run_logs USING btree (payroll_run_id, level, status);
CREATE INDEX idx_payroll_runs_status ON payroll.payroll_runs USING btree (status);
CREATE INDEX idx_payslips_emp_period ON payroll.payslips USING btree (employee_code, for_period);
CREATE INDEX idx_posting_lines_batch ON payroll.posting_lines USING btree (posting_batch_id, sort_order);
CREATE INDEX idx_user_roles_user ON payroll.user_roles USING btree (user_id);
CREATE INDEX idx_users_email ON payroll.users USING btree (email);
CREATE INDEX idx_company_bank_account_lookup ON payroll_config.company_bank_account USING btree (company_code);
CREATE UNIQUE INDEX uq_company_bank_account_format ON payroll_config.company_bank_account USING btree (company_code, file_format_code, effective_start_date) WHERE (file_format_code IS NOT NULL);
CREATE UNIQUE INDEX uq_company_bank_account_default_by_bank ON payroll_config.company_bank_account USING btree (company_code, bank_country_code, bank_code, effective_start_date) WHERE (file_format_code IS NULL);
CREATE UNIQUE INDEX uq_company_bank_account_default ON payroll_config.company_bank_account USING btree (company_code, effective_start_date) WHERE (file_format_code IS NULL);
CREATE INDEX idx_tdm_control_group ON payroll_config.tax_deduction_master USING btree (country_code, tax_control_group_code);
CREATE INDEX idx_tdm_group ON payroll_config.tax_deduction_master USING btree (country_code, tax_deduction_group_code);
CREATE INDEX idx_tdm_subgroup ON payroll_config.tax_deduction_master USING btree (country_code, tax_deduction_subgroup_code);
CREATE INDEX idx_wage_type_group ON payroll_config.wage_type USING btree (country_code, wage_type_group_code);
CREATE INDEX idx_wage_type_tax_type ON payroll_config.wage_type USING btree (country_code, tax_type_code);
CREATE INDEX idx_wage_type_category ON payroll_config.wage_type USING btree (country_code, wage_type_category_code);
CREATE INDEX idx_employee_address_emp ON payroll_maintain.employee_address USING btree (company_code, employee_code);
CREATE INDEX idx_employee_bank_payment_emp ON payroll_maintain.employee_bank_payment USING btree (company_code, employee_code);
CREATE INDEX idx_employee_cost_distribution_emp ON payroll_maintain.employee_cost_distribution USING btree (company_code, employee_code);
CREATE INDEX idx_employee_fund_data_emp ON payroll_maintain.employee_fund_data USING btree (company_code, employee_code);
CREATE INDEX idx_employee_job_history_area ON payroll_maintain.employee_job_history USING btree (payroll_area_code, effective_start_date DESC);
CREATE UNIQUE INDEX uq_employee_loan_active_wage_type ON payroll_maintain.employee_loan_data USING btree (company_code, employee_code, wage_type_code) WHERE (((loan_status)::text = 'A'::text) AND (wage_type_code IS NOT NULL));
CREATE INDEX idx_employee_loan_data_emp ON payroll_maintain.employee_loan_data USING btree (company_code, employee_code);
CREATE UNIQUE INDEX uq_employee_loan_payment_auto_period ON payroll_maintain.employee_loan_payment USING btree (employee_loan_id, period_key) WHERE ((is_auto = true) AND (period_key IS NOT NULL));
CREATE INDEX idx_employee_loan_payment_emp ON payroll_maintain.employee_loan_payment USING btree (company_code, employee_code);
CREATE INDEX idx_employee_payroll_status_emp ON payroll_maintain.employee_payroll_status USING btree (company_code, employee_code);
CREATE INDEX idx_employee_ssr_emp ON payroll_maintain.employee_social_security_rate USING btree (company_code, employee_code);
CREATE INDEX idx_employee_tax_deduction_emp ON payroll_maintain.employee_tax_deduction USING btree (company_code, employee_code);
CREATE INDEX ix_target_group_payroll_areas_target_group_id ON payroll_permissions.target_group_payroll_areas USING btree (target_group_id);
CREATE INDEX bis50_batch_failures_batch_id ON payroll_report.bis50_batch_failures USING btree (batch_id);
CREATE UNIQUE INDEX bis50_batch_runs_batch_id ON payroll_report.bis50_batch_runs USING btree (batch_id);
CREATE INDEX bis50_documents_employee_code ON payroll_report.bis50_documents USING btree (employee_code);
CREATE UNIQUE INDEX bis50_documents_employee_tax_year_locale_current ON payroll_report.bis50_documents USING btree (employee_code, tax_year, locale) WHERE (superseded_at IS NULL);
CREATE INDEX bis50_documents_company_code ON payroll_report.bis50_documents USING btree (company_code);
CREATE INDEX bis50_documents_batch_id ON payroll_report.bis50_documents USING btree (batch_id);
CREATE INDEX bis50_documents_national_id ON payroll_report.bis50_documents USING btree (national_id);
CREATE INDEX payslip_batch_failures_batch_run_id ON payroll_report.payslip_batch_failures USING btree (batch_run_id);
CREATE UNIQUE INDEX payslip_batch_runs_batch_run_id ON payroll_report.payslip_batch_runs USING btree (batch_run_id);
CREATE UNIQUE INDEX payslip_documents_employee_code_period_current ON payroll_report.payslip_documents USING btree (employee_code, period) WHERE (superseded_at IS NULL);
CREATE INDEX payslip_documents_batch_run_id ON payroll_report.payslip_documents USING btree (batch_run_id);
CREATE INDEX payslip_documents_employee_code_period ON payroll_report.payslip_documents USING btree (employee_code, period);
CREATE UNIQUE INDEX payslip_documents_company_employee_period_current ON payroll_report.payslip_documents USING btree (company_code, employee_code, period) WHERE (superseded_at IS NULL);
CREATE UNIQUE INDEX pg_toast_1213_index ON pg_toast.pg_toast_1213 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_1247_index ON pg_toast.pg_toast_1247 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_1255_index ON pg_toast.pg_toast_1255 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_1262_index ON pg_toast.pg_toast_1262 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_14118_index ON pg_toast.pg_toast_14118 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_14123_index ON pg_toast.pg_toast_14123 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_14128_index ON pg_toast.pg_toast_14128 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_14133_index ON pg_toast.pg_toast_14133 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_1417_index ON pg_toast.pg_toast_1417 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_1418_index ON pg_toast.pg_toast_1418 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2328_index ON pg_toast.pg_toast_2328 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2396_index ON pg_toast.pg_toast_2396 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2600_index ON pg_toast.pg_toast_2600 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2604_index ON pg_toast.pg_toast_2604 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2606_index ON pg_toast.pg_toast_2606 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2609_index ON pg_toast.pg_toast_2609 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2610_index ON pg_toast.pg_toast_2610 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2612_index ON pg_toast.pg_toast_2612 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2615_index ON pg_toast.pg_toast_2615 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2618_index ON pg_toast.pg_toast_2618 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2619_index ON pg_toast.pg_toast_2619 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2620_index ON pg_toast.pg_toast_2620 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_2964_index ON pg_toast.pg_toast_2964 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3079_index ON pg_toast.pg_toast_3079 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3118_index ON pg_toast.pg_toast_3118 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3256_index ON pg_toast.pg_toast_3256 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294783_index ON pg_toast.pg_toast_3294783 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294797_index ON pg_toast.pg_toast_3294797 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294805_index ON pg_toast.pg_toast_3294805 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294813_index ON pg_toast.pg_toast_3294813 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294827_index ON pg_toast.pg_toast_3294827 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294836_index ON pg_toast.pg_toast_3294836 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294848_index ON pg_toast.pg_toast_3294848 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294858_index ON pg_toast.pg_toast_3294858 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294866_index ON pg_toast.pg_toast_3294866 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294874_index ON pg_toast.pg_toast_3294874 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294884_index ON pg_toast.pg_toast_3294884 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294894_index ON pg_toast.pg_toast_3294894 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294905_index ON pg_toast.pg_toast_3294905 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294916_index ON pg_toast.pg_toast_3294916 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294942_index ON pg_toast.pg_toast_3294942 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3294953_index ON pg_toast.pg_toast_3294953 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295178_index ON pg_toast.pg_toast_3295178 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295191_index ON pg_toast.pg_toast_3295191 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295205_index ON pg_toast.pg_toast_3295205 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295214_index ON pg_toast.pg_toast_3295214 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295223_index ON pg_toast.pg_toast_3295223 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295234_index ON pg_toast.pg_toast_3295234 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295243_index ON pg_toast.pg_toast_3295243 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295254_index ON pg_toast.pg_toast_3295254 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295262_index ON pg_toast.pg_toast_3295262 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295271_index ON pg_toast.pg_toast_3295271 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295281_index ON pg_toast.pg_toast_3295281 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295293_index ON pg_toast.pg_toast_3295293 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295302_index ON pg_toast.pg_toast_3295302 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295416_index ON pg_toast.pg_toast_3295416 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295431_index ON pg_toast.pg_toast_3295431 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295439_index ON pg_toast.pg_toast_3295439 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295494_index ON pg_toast.pg_toast_3295494 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295504_index ON pg_toast.pg_toast_3295504 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295512_index ON pg_toast.pg_toast_3295512 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295577_index ON pg_toast.pg_toast_3295577 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295590_index ON pg_toast.pg_toast_3295590 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295609_index ON pg_toast.pg_toast_3295609 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295619_index ON pg_toast.pg_toast_3295619 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295637_index ON pg_toast.pg_toast_3295637 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295648_index ON pg_toast.pg_toast_3295648 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3295657_index ON pg_toast.pg_toast_3295657 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3297922_index ON pg_toast.pg_toast_3297922 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3297953_index ON pg_toast.pg_toast_3297953 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299461_index ON pg_toast.pg_toast_3299461 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299501_index ON pg_toast.pg_toast_3299501 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299519_index ON pg_toast.pg_toast_3299519 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299549_index ON pg_toast.pg_toast_3299549 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299566_index ON pg_toast.pg_toast_3299566 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299584_index ON pg_toast.pg_toast_3299584 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299615_index ON pg_toast.pg_toast_3299615 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299632_index ON pg_toast.pg_toast_3299632 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299693_index ON pg_toast.pg_toast_3299693 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299710_index ON pg_toast.pg_toast_3299710 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299728_index ON pg_toast.pg_toast_3299728 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299745_index ON pg_toast.pg_toast_3299745 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299763_index ON pg_toast.pg_toast_3299763 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299778_index ON pg_toast.pg_toast_3299778 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299796_index ON pg_toast.pg_toast_3299796 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299814_index ON pg_toast.pg_toast_3299814 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299853_index ON pg_toast.pg_toast_3299853 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299870_index ON pg_toast.pg_toast_3299870 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299895_index ON pg_toast.pg_toast_3299895 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299916_index ON pg_toast.pg_toast_3299916 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299935_index ON pg_toast.pg_toast_3299935 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299956_index ON pg_toast.pg_toast_3299956 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299973_index ON pg_toast.pg_toast_3299973 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3299997_index ON pg_toast.pg_toast_3299997 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300028_index ON pg_toast.pg_toast_3300028 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300066_index ON pg_toast.pg_toast_3300066 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300101_index ON pg_toast.pg_toast_3300101 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300140_index ON pg_toast.pg_toast_3300140 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300160_index ON pg_toast.pg_toast_3300160 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300186_index ON pg_toast.pg_toast_3300186 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300213_index ON pg_toast.pg_toast_3300213 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300241_index ON pg_toast.pg_toast_3300241 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300266_index ON pg_toast.pg_toast_3300266 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300284_index ON pg_toast.pg_toast_3300284 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300303_index ON pg_toast.pg_toast_3300303 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3300327_index ON pg_toast.pg_toast_3300327 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311307_index ON pg_toast.pg_toast_3311307 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311322_index ON pg_toast.pg_toast_3311322 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311334_index ON pg_toast.pg_toast_3311334 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311390_index ON pg_toast.pg_toast_3311390 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311449_index ON pg_toast.pg_toast_3311449 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311468_index ON pg_toast.pg_toast_3311468 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311513_index ON pg_toast.pg_toast_3311513 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311564_index ON pg_toast.pg_toast_3311564 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311640_index ON pg_toast.pg_toast_3311640 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311653_index ON pg_toast.pg_toast_3311653 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311670_index ON pg_toast.pg_toast_3311670 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311699_index ON pg_toast.pg_toast_3311699 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311716_index ON pg_toast.pg_toast_3311716 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311731_index ON pg_toast.pg_toast_3311731 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311807_index ON pg_toast.pg_toast_3311807 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311843_index ON pg_toast.pg_toast_3311843 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311865_index ON pg_toast.pg_toast_3311865 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311881_index ON pg_toast.pg_toast_3311881 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311929_index ON pg_toast.pg_toast_3311929 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311947_index ON pg_toast.pg_toast_3311947 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3311986_index ON pg_toast.pg_toast_3311986 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3312006_index ON pg_toast.pg_toast_3312006 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3312021_index ON pg_toast.pg_toast_3312021 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3312051_index ON pg_toast.pg_toast_3312051 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3312380_index ON pg_toast.pg_toast_3312380 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313278_index ON pg_toast.pg_toast_3313278 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313343_index ON pg_toast.pg_toast_3313343 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313369_index ON pg_toast.pg_toast_3313369 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313395_index ON pg_toast.pg_toast_3313395 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313423_index ON pg_toast.pg_toast_3313423 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313840_index ON pg_toast.pg_toast_3313840 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313870_index ON pg_toast.pg_toast_3313870 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313903_index ON pg_toast.pg_toast_3313903 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313929_index ON pg_toast.pg_toast_3313929 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313956_index ON pg_toast.pg_toast_3313956 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3313997_index ON pg_toast.pg_toast_3313997 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314022_index ON pg_toast.pg_toast_3314022 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314137_index ON pg_toast.pg_toast_3314137 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314158_index ON pg_toast.pg_toast_3314158 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314194_index ON pg_toast.pg_toast_3314194 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314235_index ON pg_toast.pg_toast_3314235 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314255_index ON pg_toast.pg_toast_3314255 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314274_index ON pg_toast.pg_toast_3314274 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314376_index ON pg_toast.pg_toast_3314376 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314402_index ON pg_toast.pg_toast_3314402 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3314442_index ON pg_toast.pg_toast_3314442 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315019_index ON pg_toast.pg_toast_3315019 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315027_index ON pg_toast.pg_toast_3315027 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315045_index ON pg_toast.pg_toast_3315045 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315063_index ON pg_toast.pg_toast_3315063 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315093_index ON pg_toast.pg_toast_3315093 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315129_index ON pg_toast.pg_toast_3315129 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315156_index ON pg_toast.pg_toast_3315156 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315183_index ON pg_toast.pg_toast_3315183 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315207_index ON pg_toast.pg_toast_3315207 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315231_index ON pg_toast.pg_toast_3315231 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315255_index ON pg_toast.pg_toast_3315255 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315279_index ON pg_toast.pg_toast_3315279 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315303_index ON pg_toast.pg_toast_3315303 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315327_index ON pg_toast.pg_toast_3315327 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315414_index ON pg_toast.pg_toast_3315414 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315439_index ON pg_toast.pg_toast_3315439 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315463_index ON pg_toast.pg_toast_3315463 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315487_index ON pg_toast.pg_toast_3315487 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315516_index ON pg_toast.pg_toast_3315516 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315542_index ON pg_toast.pg_toast_3315542 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315572_index ON pg_toast.pg_toast_3315572 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315596_index ON pg_toast.pg_toast_3315596 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315621_index ON pg_toast.pg_toast_3315621 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315656_index ON pg_toast.pg_toast_3315656 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315704_index ON pg_toast.pg_toast_3315704 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315733_index ON pg_toast.pg_toast_3315733 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315758_index ON pg_toast.pg_toast_3315758 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315786_index ON pg_toast.pg_toast_3315786 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315812_index ON pg_toast.pg_toast_3315812 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315840_index ON pg_toast.pg_toast_3315840 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315867_index ON pg_toast.pg_toast_3315867 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315896_index ON pg_toast.pg_toast_3315896 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315928_index ON pg_toast.pg_toast_3315928 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3315954_index ON pg_toast.pg_toast_3315954 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316005_index ON pg_toast.pg_toast_3316005 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316039_index ON pg_toast.pg_toast_3316039 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316064_index ON pg_toast.pg_toast_3316064 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316095_index ON pg_toast.pg_toast_3316095 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316158_index ON pg_toast.pg_toast_3316158 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316182_index ON pg_toast.pg_toast_3316182 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316215_index ON pg_toast.pg_toast_3316215 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316243_index ON pg_toast.pg_toast_3316243 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316283_index ON pg_toast.pg_toast_3316283 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316311_index ON pg_toast.pg_toast_3316311 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316351_index ON pg_toast.pg_toast_3316351 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316386_index ON pg_toast.pg_toast_3316386 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316411_index ON pg_toast.pg_toast_3316411 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316438_index ON pg_toast.pg_toast_3316438 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316466_index ON pg_toast.pg_toast_3316466 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316495_index ON pg_toast.pg_toast_3316495 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316591_index ON pg_toast.pg_toast_3316591 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316616_index ON pg_toast.pg_toast_3316616 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316642_index ON pg_toast.pg_toast_3316642 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316674_index ON pg_toast.pg_toast_3316674 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316698_index ON pg_toast.pg_toast_3316698 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316720_index ON pg_toast.pg_toast_3316720 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316744_index ON pg_toast.pg_toast_3316744 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316799_index ON pg_toast.pg_toast_3316799 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316843_index ON pg_toast.pg_toast_3316843 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3316945_index ON pg_toast.pg_toast_3316945 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3319760_index ON pg_toast.pg_toast_3319760 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3319784_index ON pg_toast.pg_toast_3319784 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320558_index ON pg_toast.pg_toast_3320558 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320574_index ON pg_toast.pg_toast_3320574 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320594_index ON pg_toast.pg_toast_3320594 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320623_index ON pg_toast.pg_toast_3320623 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320661_index ON pg_toast.pg_toast_3320661 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320699_index ON pg_toast.pg_toast_3320699 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320725_index ON pg_toast.pg_toast_3320725 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320750_index ON pg_toast.pg_toast_3320750 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320770_index ON pg_toast.pg_toast_3320770 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320790_index ON pg_toast.pg_toast_3320790 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320818_index ON pg_toast.pg_toast_3320818 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320839_index ON pg_toast.pg_toast_3320839 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320862_index ON pg_toast.pg_toast_3320862 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320890_index ON pg_toast.pg_toast_3320890 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320918_index ON pg_toast.pg_toast_3320918 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320956_index ON pg_toast.pg_toast_3320956 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3320984_index ON pg_toast.pg_toast_3320984 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321017_index ON pg_toast.pg_toast_3321017 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321047_index ON pg_toast.pg_toast_3321047 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321079_index ON pg_toast.pg_toast_3321079 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321109_index ON pg_toast.pg_toast_3321109 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321130_index ON pg_toast.pg_toast_3321130 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321171_index ON pg_toast.pg_toast_3321171 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321330_index ON pg_toast.pg_toast_3321330 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321381_index ON pg_toast.pg_toast_3321381 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3321446_index ON pg_toast.pg_toast_3321446 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3324603_index ON pg_toast.pg_toast_3324603 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3325185_index ON pg_toast.pg_toast_3325185 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3325536_index ON pg_toast.pg_toast_3325536 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326720_index ON pg_toast.pg_toast_3326720 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326742_index ON pg_toast.pg_toast_3326742 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326765_index ON pg_toast.pg_toast_3326765 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326785_index ON pg_toast.pg_toast_3326785 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326807_index ON pg_toast.pg_toast_3326807 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326829_index ON pg_toast.pg_toast_3326829 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326851_index ON pg_toast.pg_toast_3326851 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326873_index ON pg_toast.pg_toast_3326873 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326895_index ON pg_toast.pg_toast_3326895 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326917_index ON pg_toast.pg_toast_3326917 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326939_index ON pg_toast.pg_toast_3326939 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326961_index ON pg_toast.pg_toast_3326961 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3326983_index ON pg_toast.pg_toast_3326983 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327005_index ON pg_toast.pg_toast_3327005 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327027_index ON pg_toast.pg_toast_3327027 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327049_index ON pg_toast.pg_toast_3327049 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327071_index ON pg_toast.pg_toast_3327071 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327093_index ON pg_toast.pg_toast_3327093 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327116_index ON pg_toast.pg_toast_3327116 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327136_index ON pg_toast.pg_toast_3327136 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327157_index ON pg_toast.pg_toast_3327157 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327179_index ON pg_toast.pg_toast_3327179 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327200_index ON pg_toast.pg_toast_3327200 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327243_index ON pg_toast.pg_toast_3327243 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327265_index ON pg_toast.pg_toast_3327265 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327288_index ON pg_toast.pg_toast_3327288 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327311_index ON pg_toast.pg_toast_3327311 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327333_index ON pg_toast.pg_toast_3327333 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327355_index ON pg_toast.pg_toast_3327355 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327376_index ON pg_toast.pg_toast_3327376 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327394_index ON pg_toast.pg_toast_3327394 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327417_index ON pg_toast.pg_toast_3327417 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327439_index ON pg_toast.pg_toast_3327439 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327461_index ON pg_toast.pg_toast_3327461 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327482_index ON pg_toast.pg_toast_3327482 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327526_index ON pg_toast.pg_toast_3327526 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327549_index ON pg_toast.pg_toast_3327549 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327567_index ON pg_toast.pg_toast_3327567 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327585_index ON pg_toast.pg_toast_3327585 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327603_index ON pg_toast.pg_toast_3327603 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327621_index ON pg_toast.pg_toast_3327621 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327639_index ON pg_toast.pg_toast_3327639 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327657_index ON pg_toast.pg_toast_3327657 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327675_index ON pg_toast.pg_toast_3327675 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327693_index ON pg_toast.pg_toast_3327693 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327711_index ON pg_toast.pg_toast_3327711 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327731_index ON pg_toast.pg_toast_3327731 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327775_index ON pg_toast.pg_toast_3327775 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3327797_index ON pg_toast.pg_toast_3327797 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328033_index ON pg_toast.pg_toast_3328033 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328056_index ON pg_toast.pg_toast_3328056 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328103_index ON pg_toast.pg_toast_3328103 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328392_index ON pg_toast.pg_toast_3328392 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328416_index ON pg_toast.pg_toast_3328416 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328437_index ON pg_toast.pg_toast_3328437 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328457_index ON pg_toast.pg_toast_3328457 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3328508_index ON pg_toast.pg_toast_3328508 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3329119_index ON pg_toast.pg_toast_3329119 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3329136_index ON pg_toast.pg_toast_3329136 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3329166_index ON pg_toast.pg_toast_3329166 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3329210_index ON pg_toast.pg_toast_3329210 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3329332_index ON pg_toast.pg_toast_3329332 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3330861_index ON pg_toast.pg_toast_3330861 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3330889_index ON pg_toast.pg_toast_3330889 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334279_index ON pg_toast.pg_toast_3334279 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334298_index ON pg_toast.pg_toast_3334298 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334320_index ON pg_toast.pg_toast_3334320 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334339_index ON pg_toast.pg_toast_3334339 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334357_index ON pg_toast.pg_toast_3334357 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334376_index ON pg_toast.pg_toast_3334376 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334396_index ON pg_toast.pg_toast_3334396 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334415_index ON pg_toast.pg_toast_3334415 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334435_index ON pg_toast.pg_toast_3334435 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334455_index ON pg_toast.pg_toast_3334455 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334472_index ON pg_toast.pg_toast_3334472 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334505_index ON pg_toast.pg_toast_3334505 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334528_index ON pg_toast.pg_toast_3334528 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334549_index ON pg_toast.pg_toast_3334549 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334567_index ON pg_toast.pg_toast_3334567 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334587_index ON pg_toast.pg_toast_3334587 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334607_index ON pg_toast.pg_toast_3334607 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334624_index ON pg_toast.pg_toast_3334624 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334642_index ON pg_toast.pg_toast_3334642 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334660_index ON pg_toast.pg_toast_3334660 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334683_index ON pg_toast.pg_toast_3334683 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334703_index ON pg_toast.pg_toast_3334703 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334720_index ON pg_toast.pg_toast_3334720 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334738_index ON pg_toast.pg_toast_3334738 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334755_index ON pg_toast.pg_toast_3334755 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334773_index ON pg_toast.pg_toast_3334773 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334793_index ON pg_toast.pg_toast_3334793 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334815_index ON pg_toast.pg_toast_3334815 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334832_index ON pg_toast.pg_toast_3334832 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334849_index ON pg_toast.pg_toast_3334849 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334867_index ON pg_toast.pg_toast_3334867 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334884_index ON pg_toast.pg_toast_3334884 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334901_index ON pg_toast.pg_toast_3334901 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334919_index ON pg_toast.pg_toast_3334919 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334936_index ON pg_toast.pg_toast_3334936 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334953_index ON pg_toast.pg_toast_3334953 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334970_index ON pg_toast.pg_toast_3334970 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3334987_index ON pg_toast.pg_toast_3334987 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335004_index ON pg_toast.pg_toast_3335004 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335021_index ON pg_toast.pg_toast_3335021 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335038_index ON pg_toast.pg_toast_3335038 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335055_index ON pg_toast.pg_toast_3335055 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335072_index ON pg_toast.pg_toast_3335072 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335089_index ON pg_toast.pg_toast_3335089 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335106_index ON pg_toast.pg_toast_3335106 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335123_index ON pg_toast.pg_toast_3335123 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335140_index ON pg_toast.pg_toast_3335140 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335157_index ON pg_toast.pg_toast_3335157 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335175_index ON pg_toast.pg_toast_3335175 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335193_index ON pg_toast.pg_toast_3335193 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335210_index ON pg_toast.pg_toast_3335210 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335227_index ON pg_toast.pg_toast_3335227 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335244_index ON pg_toast.pg_toast_3335244 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335261_index ON pg_toast.pg_toast_3335261 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335278_index ON pg_toast.pg_toast_3335278 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335295_index ON pg_toast.pg_toast_3335295 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335312_index ON pg_toast.pg_toast_3335312 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335330_index ON pg_toast.pg_toast_3335330 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335347_index ON pg_toast.pg_toast_3335347 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335364_index ON pg_toast.pg_toast_3335364 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335381_index ON pg_toast.pg_toast_3335381 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335398_index ON pg_toast.pg_toast_3335398 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335415_index ON pg_toast.pg_toast_3335415 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335432_index ON pg_toast.pg_toast_3335432 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335449_index ON pg_toast.pg_toast_3335449 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335467_index ON pg_toast.pg_toast_3335467 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335484_index ON pg_toast.pg_toast_3335484 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335501_index ON pg_toast.pg_toast_3335501 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335518_index ON pg_toast.pg_toast_3335518 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335535_index ON pg_toast.pg_toast_3335535 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335552_index ON pg_toast.pg_toast_3335552 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335569_index ON pg_toast.pg_toast_3335569 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335587_index ON pg_toast.pg_toast_3335587 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335604_index ON pg_toast.pg_toast_3335604 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335621_index ON pg_toast.pg_toast_3335621 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335638_index ON pg_toast.pg_toast_3335638 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335655_index ON pg_toast.pg_toast_3335655 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335672_index ON pg_toast.pg_toast_3335672 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335690_index ON pg_toast.pg_toast_3335690 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335707_index ON pg_toast.pg_toast_3335707 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335724_index ON pg_toast.pg_toast_3335724 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335741_index ON pg_toast.pg_toast_3335741 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335758_index ON pg_toast.pg_toast_3335758 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335780_index ON pg_toast.pg_toast_3335780 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335801_index ON pg_toast.pg_toast_3335801 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335830_index ON pg_toast.pg_toast_3335830 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335849_index ON pg_toast.pg_toast_3335849 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335870_index ON pg_toast.pg_toast_3335870 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335914_index ON pg_toast.pg_toast_3335914 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335951_index ON pg_toast.pg_toast_3335951 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3335987_index ON pg_toast.pg_toast_3335987 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336037_index ON pg_toast.pg_toast_3336037 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336066_index ON pg_toast.pg_toast_3336066 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336101_index ON pg_toast.pg_toast_3336101 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336128_index ON pg_toast.pg_toast_3336128 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336166_index ON pg_toast.pg_toast_3336166 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336200_index ON pg_toast.pg_toast_3336200 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336232_index ON pg_toast.pg_toast_3336232 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336261_index ON pg_toast.pg_toast_3336261 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336593_index ON pg_toast.pg_toast_3336593 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336621_index ON pg_toast.pg_toast_3336621 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336653_index ON pg_toast.pg_toast_3336653 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336681_index ON pg_toast.pg_toast_3336681 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336779_index ON pg_toast.pg_toast_3336779 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3336812_index ON pg_toast.pg_toast_3336812 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337435_index ON pg_toast.pg_toast_3337435 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337457_index ON pg_toast.pg_toast_3337457 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337480_index ON pg_toast.pg_toast_3337480 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337500_index ON pg_toast.pg_toast_3337500 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337522_index ON pg_toast.pg_toast_3337522 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337544_index ON pg_toast.pg_toast_3337544 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337566_index ON pg_toast.pg_toast_3337566 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337588_index ON pg_toast.pg_toast_3337588 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337610_index ON pg_toast.pg_toast_3337610 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337632_index ON pg_toast.pg_toast_3337632 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337654_index ON pg_toast.pg_toast_3337654 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337676_index ON pg_toast.pg_toast_3337676 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337698_index ON pg_toast.pg_toast_3337698 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337720_index ON pg_toast.pg_toast_3337720 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337743_index ON pg_toast.pg_toast_3337743 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337765_index ON pg_toast.pg_toast_3337765 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337787_index ON pg_toast.pg_toast_3337787 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337809_index ON pg_toast.pg_toast_3337809 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337832_index ON pg_toast.pg_toast_3337832 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337852_index ON pg_toast.pg_toast_3337852 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337873_index ON pg_toast.pg_toast_3337873 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337895_index ON pg_toast.pg_toast_3337895 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337916_index ON pg_toast.pg_toast_3337916 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337936_index ON pg_toast.pg_toast_3337936 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337959_index ON pg_toast.pg_toast_3337959 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3337981_index ON pg_toast.pg_toast_3337981 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338004_index ON pg_toast.pg_toast_3338004 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338027_index ON pg_toast.pg_toast_3338027 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338049_index ON pg_toast.pg_toast_3338049 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338071_index ON pg_toast.pg_toast_3338071 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338092_index ON pg_toast.pg_toast_3338092 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338110_index ON pg_toast.pg_toast_3338110 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338133_index ON pg_toast.pg_toast_3338133 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338155_index ON pg_toast.pg_toast_3338155 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338177_index ON pg_toast.pg_toast_3338177 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338198_index ON pg_toast.pg_toast_3338198 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338220_index ON pg_toast.pg_toast_3338220 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338242_index ON pg_toast.pg_toast_3338242 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338265_index ON pg_toast.pg_toast_3338265 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338283_index ON pg_toast.pg_toast_3338283 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338301_index ON pg_toast.pg_toast_3338301 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338319_index ON pg_toast.pg_toast_3338319 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338337_index ON pg_toast.pg_toast_3338337 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338355_index ON pg_toast.pg_toast_3338355 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338373_index ON pg_toast.pg_toast_3338373 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338391_index ON pg_toast.pg_toast_3338391 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338409_index ON pg_toast.pg_toast_3338409 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338427_index ON pg_toast.pg_toast_3338427 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338447_index ON pg_toast.pg_toast_3338447 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338469_index ON pg_toast.pg_toast_3338469 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338491_index ON pg_toast.pg_toast_3338491 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338513_index ON pg_toast.pg_toast_3338513 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338535_index ON pg_toast.pg_toast_3338535 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338579_index ON pg_toast.pg_toast_3338579 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338607_index ON pg_toast.pg_toast_3338607 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338628_index ON pg_toast.pg_toast_3338628 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338658_index ON pg_toast.pg_toast_3338658 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338675_index ON pg_toast.pg_toast_3338675 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338693_index ON pg_toast.pg_toast_3338693 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338724_index ON pg_toast.pg_toast_3338724 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338785_index ON pg_toast.pg_toast_3338785 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338802_index ON pg_toast.pg_toast_3338802 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338837_index ON pg_toast.pg_toast_3338837 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338855_index ON pg_toast.pg_toast_3338855 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338875_index ON pg_toast.pg_toast_3338875 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338908_index ON pg_toast.pg_toast_3338908 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338923_index ON pg_toast.pg_toast_3338923 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338937_index ON pg_toast.pg_toast_3338937 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3338968_index ON pg_toast.pg_toast_3338968 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339013_index ON pg_toast.pg_toast_3339013 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339028_index ON pg_toast.pg_toast_3339028 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339043_index ON pg_toast.pg_toast_3339043 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339058_index ON pg_toast.pg_toast_3339058 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339073_index ON pg_toast.pg_toast_3339073 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339094_index ON pg_toast.pg_toast_3339094 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339219_index ON pg_toast.pg_toast_3339219 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339242_index ON pg_toast.pg_toast_3339242 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339264_index ON pg_toast.pg_toast_3339264 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339292_index ON pg_toast.pg_toast_3339292 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339349_index ON pg_toast.pg_toast_3339349 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339376_index ON pg_toast.pg_toast_3339376 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339403_index ON pg_toast.pg_toast_3339403 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339430_index ON pg_toast.pg_toast_3339430 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339482_index ON pg_toast.pg_toast_3339482 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3339928_index ON pg_toast.pg_toast_3339928 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3340319_index ON pg_toast.pg_toast_3340319 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3340339_index ON pg_toast.pg_toast_3340339 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3340513_index ON pg_toast.pg_toast_3340513 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3341838_index ON pg_toast.pg_toast_3341838 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342025_index ON pg_toast.pg_toast_3342025 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342040_index ON pg_toast.pg_toast_3342040 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342075_index ON pg_toast.pg_toast_3342075 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342096_index ON pg_toast.pg_toast_3342096 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342116_index ON pg_toast.pg_toast_3342116 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342134_index ON pg_toast.pg_toast_3342134 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342161_index ON pg_toast.pg_toast_3342161 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3342183_index ON pg_toast.pg_toast_3342183 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3350_index ON pg_toast.pg_toast_3350 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3381_index ON pg_toast.pg_toast_3381 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3394_index ON pg_toast.pg_toast_3394 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3429_index ON pg_toast.pg_toast_3429 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3456_index ON pg_toast.pg_toast_3456 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3466_index ON pg_toast.pg_toast_3466 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3592_index ON pg_toast.pg_toast_3592 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3596_index ON pg_toast.pg_toast_3596 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_3600_index ON pg_toast.pg_toast_3600 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_6100_index ON pg_toast.pg_toast_6100 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_6106_index ON pg_toast.pg_toast_6106 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_6243_index ON pg_toast.pg_toast_6243 USING btree (chunk_id, chunk_seq);
CREATE UNIQUE INDEX pg_toast_826_index ON pg_toast.pg_toast_826 USING btree (chunk_id, chunk_seq);
CREATE INDEX benefit_history_logs_entity_name_entity_id ON public.benefit_history_logs USING btree (entity_name, entity_id);
CREATE INDEX allowance_result_employee_lock_date_idx ON time_management.allowance_result USING btree (employee_id, is_locked, work_date);
CREATE INDEX allowance_result_timesheet_date_idx ON time_management.allowance_result USING btree (timesheet_id, work_date);
CREATE UNIQUE INDEX ux_annual_leave_quota_mapping_scope ON time_management.annual_leave_quota_mapping USING btree (business_group_code, business_unit_code, personal_grade_from_number, personal_grade_to_number, effective_start_date, hire_start_date_from, year_of_service);
CREATE UNIQUE INDEX ux_approval_step_source_sequence ON time_management.approval_step USING btree (task_type, source_id, sequence);
CREATE INDEX ix_approval_step_approver ON time_management.approval_step USING btree (approver_id, task_type);
CREATE UNIQUE INDEX ux_employee_time_info_employee_id ON time_management.employee_time_info USING btree (employee_id);
CREATE UNIQUE INDEX ux_employee_time_info_employee_effective ON time_management.employee_time_info USING btree (employee_id, effective_start_date);
CREATE INDEX idx_employment_information_user_effective_dates ON time_management.employment_information USING btree (user_id, effective_start_date, effective_end_date);
CREATE INDEX idx_employment_information_user_id ON time_management.employment_information USING btree (user_id);
CREATE INDEX idx_employment_information_person_id ON time_management.employment_information USING btree (person_id);
CREATE INDEX idx_employment_information_active_primary_scan ON time_management.employment_information USING btree (effective_start_date, effective_end_date, user_id, id) WHERE (is_primary = true);
CREATE UNIQUE INDEX ux_employment_job_user_effective_sequence ON time_management.employment_job USING btree (user_id, effective_start_date, seq_number);
CREATE INDEX idx_employment_job_manager_id ON time_management.employment_job USING btree (manager_id);
CREATE INDEX idx_employment_job_user_effective_dates ON time_management.employment_job USING btree (user_id, effective_start_date, effective_end_date);
CREATE INDEX idx_employment_job_relationships_related_user_id ON time_management.employment_job_relationships USING btree (related_user_id);
CREATE INDEX idx_employment_job_relationships_user_type_dates ON time_management.employment_job_relationships USING btree (user_id, relationship_type, effective_start_date, effective_end_date);
CREATE UNIQUE INDEX ux_holiday_calendar_code ON time_management.holiday_calendar USING btree (holiday_calendar_code);
CREATE UNIQUE INDEX ux_holiday_calendar_date ON time_management.holiday_calendar_date USING btree (holiday_calendar_id, holiday_date) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX ux_leave_balance_carry_forward_scope ON time_management.leave_balance_carry_forward USING btree (employee_id, leave_code, leave_year, expire_date);
CREATE INDEX ix_leave_balance_carry_forward_expiry ON time_management.leave_balance_carry_forward USING btree (employee_id, leave_code, expire_date);
CREATE INDEX ix_leave_balance_carry_forward_transaction_balance ON time_management.leave_balance_carry_forward_transaction USING btree (leave_balance_carry_forward_id, transaction_date);
CREATE INDEX ix_leave_balance_carry_forward_transaction_request ON time_management.leave_balance_carry_forward_transaction USING btree (transaction_id);
CREATE INDEX ix_leave_balance_carry_forward_transaction_scope ON time_management.leave_balance_carry_forward_transaction USING btree (employee_id, leave_code, transaction_date);
CREATE UNIQUE INDEX ux_leave_balance_event_scope_pooled ON time_management.leave_balance_event USING btree (employee_id, leave_code) WHERE (leave_event_type_id IS NULL);
CREATE UNIQUE INDEX ux_leave_balance_event_scope ON time_management.leave_balance_event USING btree (employee_id, leave_code, leave_event_type_id) WHERE (leave_event_type_id IS NOT NULL);
CREATE INDEX ix_leave_balance_event_transaction_scope ON time_management.leave_balance_event_transaction USING btree (employee_id, leave_code, transaction_date);
CREATE INDEX ix_leave_balance_event_transaction_request ON time_management.leave_balance_event_transaction USING btree (transaction_id);
CREATE INDEX ix_leave_balance_event_transaction_balance ON time_management.leave_balance_event_transaction USING btree (leave_balance_event_id, transaction_date);
CREATE UNIQUE INDEX ux_leave_balance_onetime_scope ON time_management.leave_balance_onetime USING btree (employee_id, leave_code);
CREATE INDEX ix_leave_balance_onetime_transaction_request ON time_management.leave_balance_onetime_transaction USING btree (transaction_id);
CREATE INDEX ix_leave_balance_onetime_transaction_scope ON time_management.leave_balance_onetime_transaction USING btree (employee_id, leave_code, transaction_date);
CREATE INDEX ix_leave_balance_onetime_transaction_balance ON time_management.leave_balance_onetime_transaction USING btree (leave_balance_onetime_id, transaction_date);
CREATE INDEX ix_leave_balance_seed_staging_employee_leave_code ON time_management.leave_balance_seed_staging USING btree (employee_id, leave_code);
CREATE INDEX ix_leave_balance_transaction_employee_leave_code ON time_management.leave_balance_transaction USING btree (employee_id, leave_code);
CREATE INDEX ix_leave_balance_transaction_leave_request_id ON time_management.leave_balance_transaction USING btree (leave_request_id);
CREATE INDEX ix_leave_balance_transaction_balance_date ON time_management.leave_balance_transaction USING btree (leave_balance_id, transaction_date);
CREATE UNIQUE INDEX ux_leave_balance_yearly_scope ON time_management.leave_balance_yearly USING btree (employee_id, leave_code, leave_year);
CREATE UNIQUE INDEX ux_leave_balance_yearly_one_enabled ON time_management.leave_balance_yearly USING btree (employee_id, leave_code) WHERE is_enabled;
CREATE INDEX ix_leave_balance_yearly_transaction_scope ON time_management.leave_balance_yearly_transaction USING btree (employee_id, leave_code, transaction_date);
CREATE INDEX ix_leave_balance_yearly_transaction_request ON time_management.leave_balance_yearly_transaction USING btree (transaction_id);
CREATE INDEX ix_leave_balance_yearly_transaction_balance ON time_management.leave_balance_yearly_transaction USING btree (leave_balance_yearly_id, transaction_date);
CREATE UNIQUE INDEX ux_leave_eligibility_rule_scope ON time_management.leave_eligibility_rule USING btree (leave_code, business_group_code, business_unit_code, employee_group_code, employee_subgroup_code, personal_grade_from_number, personal_grade_to_number, contract_type_code, effective_start_date);
CREATE INDEX ix_leave_eligibility_rule_leave_code ON time_management.leave_eligibility_rule USING btree (leave_code, is_enabled);
CREATE INDEX ix_leave_event_balance_event_type ON time_management.leave_event_balance USING btree (leave_event_type_id);
CREATE UNIQUE INDEX ux_leave_event_balance_employee_leave_event ON time_management.leave_event_balance USING btree (employee_id, leave_code, leave_event_type_id);
CREATE INDEX ix_leave_event_balance_transaction_balance_date ON time_management.leave_event_balance_transaction USING btree (leave_event_balance_id, transaction_date);
CREATE INDEX ix_leave_event_balance_transaction_employee_leave_code ON time_management.leave_event_balance_transaction USING btree (employee_id, leave_code);
CREATE INDEX ix_leave_event_balance_transaction_leave_request_id ON time_management.leave_event_balance_transaction USING btree (leave_request_id);
CREATE UNIQUE INDEX ux_leave_event_type_code_event ON time_management.leave_event_type USING btree (leave_code, event_type_code);
CREATE INDEX leave_request_employee_id ON time_management.leave_request USING btree (employee_id);
CREATE INDEX leave_request_request_status ON time_management.leave_request USING btree (request_status);
CREATE INDEX leave_request_request_number ON time_management.leave_request USING btree (request_number);
CREATE INDEX leave_request_attachments_leave_request_id ON time_management.leave_request_attachments USING btree (leave_request_id);
CREATE UNIQUE INDEX leave_request_attachments_object_key ON time_management.leave_request_attachments USING btree (object_key);
CREATE INDEX leave_request_decisions_leave_request_id ON time_management.leave_request_decisions USING btree (leave_request_id);
CREATE UNIQUE INDEX leave_request_decisions_leave_request_id_sequence ON time_management.leave_request_decisions USING btree (leave_request_id, sequence);
CREATE INDEX leave_requests_employee_id_status ON time_management.leave_requests USING btree (employee_id, status);
CREATE INDEX leave_requests_camunda_process_execution_id ON time_management.leave_requests USING btree (camunda_process_execution_id);
CREATE INDEX leave_requests_employee_id_start_date ON time_management.leave_requests USING btree (employee_id, start_date);
CREATE INDEX ix_leave_requests_workflow_start_status ON time_management.leave_requests USING btree (workflow_start_status);
CREATE INDEX ix_leave_requests_leave_event_type_id ON time_management.leave_requests USING btree (leave_event_type_id);
CREATE INDEX leave_requests_leave_type_id ON time_management.leave_requests USING btree (leave_type_id);
CREATE INDEX ix_leave_result_employee_leave_date ON time_management.leave_result USING btree (employee_code, leave_date);
CREATE INDEX ix_leave_result_company_period ON time_management.leave_result USING btree (company_code, payroll_period_code);
CREATE UNIQUE INDEX uq_leave_result ON time_management.leave_result USING btree (company_code, employee_code, leave_date, wage_type_code, leave_code, payroll_period_code);
CREATE UNIQUE INDEX ux_leave_types_code ON time_management.leave_types USING btree (code) WHERE (deleted_at IS NULL);
CREATE INDEX ix_mobile_clock_eligibility_rule_policy_code ON time_management.mobile_clock_eligibility_rule USING btree (policy_code);
CREATE INDEX ot_request_request_number ON time_management.ot_request USING btree (request_number);
CREATE INDEX ot_request_employee_id ON time_management.ot_request USING btree (employee_id);
CREATE INDEX ot_request_request_status ON time_management.ot_request USING btree (request_status);
CREATE INDEX ot_request_employee_status_idx ON time_management.ot_request USING btree (employee_id, request_status);
CREATE INDEX ot_request_attachment_request_idx ON time_management.ot_request_attachment USING btree (overtime_request_id);
CREATE INDEX ot_request_detail_work_date_idx ON time_management.ot_request_detail USING btree (work_date);
CREATE INDEX ix_pay_code_pay_type ON time_management.pay_code USING btree (pay_type);
CREATE UNIQUE INDEX ux_pay_code_type_code ON time_management.pay_code USING btree (pay_type, pay_code);
CREATE UNIQUE INDEX uq_pay_code_wage_type_map ON time_management.pay_code_wage_type_map USING btree (pay_type, pay_code);
CREATE INDEX ix_pay_code_wage_type_map_is_mock ON time_management.pay_code_wage_type_map USING btree (is_mock);
CREATE UNIQUE INDEX ux_time_attendance_policy_business_unit ON time_management.time_attendance_policy USING btree (business_unit_code);
CREATE INDEX ix_clock_emp_time ON time_management.time_clock_events USING btree (employee_id, server_received_at);
CREATE INDEX ix_clock_time ON time_management.time_clock_events USING btree (server_received_at);
CREATE UNIQUE INDEX uq_time_clock_pair_detail_start ON time_management.time_clock_pair USING btree (timesheet_detail_id, start_datetime);
CREATE INDEX time_correction_request_status ON time_management.time_correction USING btree (request_status);
CREATE INDEX ix_time_correction_workflow_start_status ON time_management.time_correction USING btree (workflow_start_status);
CREATE INDEX time_correction_employee_id ON time_management.time_correction USING btree (employee_id);
CREATE INDEX ix_time_correction_workflow_id ON time_management.time_correction USING btree (workflow_id);
CREATE UNIQUE INDEX uq_time_correction_decision_step ON time_management.time_correction_decisions USING btree (time_correction_id, sequence);
CREATE INDEX ix_time_result_employee_entry_date ON time_management.time_result USING btree (employee_code, entry_date);
CREATE UNIQUE INDEX uq_time_result ON time_management.time_result USING btree (company_code, employee_code, entry_date, wage_type_code, payroll_period_code);
CREATE INDEX ix_time_result_company_period ON time_management.time_result USING btree (company_code, payroll_period_code);
CREATE INDEX ix_time_status_mapping_group_bu ON time_management.time_status_mapping USING btree (employee_group_code, business_unit_code);
CREATE INDEX ix_timesheet_payroll_period ON time_management.timesheet USING btree (payroll_period_code);
CREATE UNIQUE INDEX uq_timesheet_employee_payroll_period ON time_management.timesheet USING btree (employee_id, payroll_period_code);
CREATE INDEX ix_timesheet_status ON time_management.timesheet USING btree (status);
CREATE INDEX ix_timesheet_adjustment_paying_period ON time_management.timesheet_adjustment USING btree (employee_id, adjustment_payroll_period);
CREATE UNIQUE INDEX uq_timesheet_adjustment_detail_pay_code ON time_management.timesheet_adjustment_detail USING btree (timesheet_adjustment_id, pay_code);
CREATE INDEX ix_timesheet_audit_timesheet_id ON time_management.timesheet_audit USING btree (timesheet_id);
CREATE INDEX ix_timesheet_detail_work_date ON time_management.timesheet_detail USING btree (work_date);
CREATE INDEX ix_timesheet_detail_payroll_area ON time_management.timesheet_detail USING btree (payroll_area_code);
CREATE UNIQUE INDEX uq_timesheet_detail_sheet_date_version ON time_management.timesheet_detail USING btree (timesheet_id, work_date, version_no);
CREATE INDEX ix_tdt_detail_id ON time_management.timesheet_detail_transaction USING btree (timesheet_detail_id);
CREATE UNIQUE INDEX uq_timesheet_result_detail_pay_code ON time_management.timesheet_result USING btree (timesheet_detail_id, pay_code);
CREATE INDEX ix_timesheet_result_pay_code ON time_management.timesheet_result USING btree (pay_code);
CREATE UNIQUE INDEX ux_work_schedule_code ON time_management.work_schedule USING btree (work_schedule_code);
CREATE INDEX ix_work_schedule_assignment_emp_start ON time_management.work_schedule_assignment USING btree (employee_id, effective_start_date);
CREATE INDEX ix_work_schedule_default_mapping_enabled ON time_management.work_schedule_default_mapping USING btree (is_enabled);
CREATE UNIQUE INDEX ux_work_schedule_shift_emp_date ON time_management.work_schedule_shift USING btree (employee_id, work_date);
CREATE UNIQUE INDEX ux_work_schedule_shift_assignment_employee_work_date ON time_management.work_schedule_shift_assignment USING btree (employee_id, work_date);
CREATE UNIQUE INDEX ux_work_schedule_shift_upload_employee_work_date ON time_management.work_schedule_shift_upload USING btree (employee_id, work_date);
CREATE UNIQUE INDEX ux_work_schedule_template_code ON time_management.work_schedule_template USING btree (work_schedule_id, template_code);
CREATE UNIQUE INDEX ux_work_schedule_template_default ON time_management.work_schedule_template USING btree (work_schedule_id) WHERE (is_default = true);
CREATE UNIQUE INDEX ux_work_schedule_template_assignment_employee_template_start ON time_management.work_schedule_template_assignment USING btree (employee_id, work_schedule_template_id, effective_start_date);
CREATE UNIQUE INDEX ux_work_schedule_template_day_dow ON time_management.work_schedule_template_day USING btree (work_schedule_template_id, day_of_week);
CREATE INDEX todo_history_event_id_not_null ON todo.todo_history USING btree (event_id) WHERE (event_id IS NOT NULL);
CREATE INDEX todo_history_todo_id_changed_at ON todo.todo_history USING btree (todo_id, changed_at DESC);
CREATE UNIQUE INDEX todo_templates_code_unique ON todo.todo_templates USING btree (code);
CREATE INDEX todo_templates_is_active ON todo.todo_templates USING btree (is_active);
CREATE INDEX todos_due_at ON todo.todos USING btree (due_at) WHERE (((status)::text = 'PENDING_ACTION'::text) AND (deleted_at IS NULL));
CREATE INDEX todos_employee_id_status_created_at ON todo.todos USING btree (employee_id, status, created_at DESC);
CREATE INDEX todos_action_source_module_action_ref_id_employee_id ON todo.todos USING btree (action_source_module, action_ref_id, employee_id) WHERE ((status)::text = 'PENDING_ACTION'::text);
CREATE INDEX todos_employee_id_category ON todo.todos USING btree (employee_id, category);
CREATE INDEX user_group_members_population_code_ix ON user_management.user_group_members USING btree (population_code) WHERE ((member_type)::text = 'POPULATION'::text);
CREATE UNIQUE INDEX user_group_members_population_ux ON user_management.user_group_members USING btree (user_group_id, population_code) WHERE ((member_type)::text = 'POPULATION'::text);
CREATE UNIQUE INDEX user_group_members_employee_ux ON user_management.user_group_members USING btree (user_group_id, employee_id) WHERE ((member_type)::text = 'EMPLOYEE'::text);
CREATE INDEX user_group_members_employee_id_ix ON user_management.user_group_members USING btree (employee_id) WHERE ((member_type)::text = 'EMPLOYEE'::text);
CREATE UNIQUE INDEX user_groups_is_default_ux ON user_management.user_groups USING btree (is_default) WHERE (is_default = true);
CREATE INDEX idx_wf_ah_by_step ON workflow_service.wf_assignment_history USING btree (step_instance_id, changed_at DESC);
CREATE INDEX idx_wf_pi_requester ON workflow_service.wf_process_instance USING btree (requester_id, status, started_at);
CREATE INDEX idx_wf_pi_business_ref ON workflow_service.wf_process_instance USING btree (business_ref_type, business_ref_id);
CREATE INDEX idx_wf_sah_by_step ON workflow_service.wf_step_action_history USING btree (step_instance_id, actioned_at DESC);
CREATE INDEX idx_wf_si_inbox ON workflow_service.wf_step_instance USING btree (assignee_user_id, status);
CREATE INDEX idx_wf_si_by_instance ON workflow_service.wf_step_instance USING btree (process_instance_id, status);
CREATE INDEX idx_wf_user_status ON workflow_service.wf_user USING btree (status);
CREATE UNIQUE INDEX idx_wf_user_email ON workflow_service.wf_user USING btree (email);
CREATE INDEX idx_wf_at_by_instance ON workflow_service.wf_workflow_audit_trail USING btree (process_instance_id, created_at);
