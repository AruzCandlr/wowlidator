--
-- PostgreSQL database dump (excerpt, pg_dump 16.2)
--

CREATE TABLE public.users (
    id uuid NOT NULL PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending (a, quoted)' NOT NULL,
    total numeric(10,2) NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES public.users (id)
);

CREATE INDEX orders_status_idx ON public.orders (status);

CREATE TABLE public.audit_log (
    id bigint NOT NULL PRIMARY KEY,
    entity text NOT NULL,
    payload jsonb,
    at timestamp DEFAULT now()
);
