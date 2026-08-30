ALTER TABLE users
    ADD COLUMN admin_role text;

UPDATE users
   SET admin_role = 'READ_ONLY'
 WHERE role = 'ADMIN';

ALTER TABLE users
    ADD CONSTRAINT users_admin_role_check CHECK (
        admin_role IS NULL OR admin_role IN (
            'SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'SECURITY', 'FINANCE', 'READ_ONLY'
        )
    ),
    ADD CONSTRAINT users_admin_role_matches_access_check CHECK (
        (role = 'ADMIN') = (admin_role IS NOT NULL)
    );

CREATE INDEX users_admin_status_created_idx
    ON users (status, created_at DESC);

CREATE INDEX users_admin_created_idx
    ON users (created_at DESC, id);

CREATE INDEX users_admin_role_created_idx
    ON users (admin_role, created_at DESC)
    WHERE admin_role IS NOT NULL;

CREATE INDEX documents_admin_processing_created_idx
    ON documents (processing_status, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX documents_admin_created_idx
    ON documents (created_at DESC, id)
    WHERE deleted_at IS NULL;

CREATE INDEX documents_admin_security_created_idx
    ON documents (security_status, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX processing_jobs_admin_state_created_idx
    ON processing_jobs (state, created_at DESC);

CREATE INDEX processing_jobs_admin_created_idx
    ON processing_jobs (created_at DESC, id);

CREATE INDEX employers_admin_created_idx
    ON employers (created_at DESC, id);

CREATE INDEX employers_admin_name_prefix_idx
    ON employers (lower(name) text_pattern_ops);

CREATE INDEX privacy_operations_admin_status_created_idx
    ON privacy_operations (status, created_at DESC);

CREATE INDEX privacy_operations_admin_created_idx
    ON privacy_operations (created_at DESC, id);

CREATE TABLE admin_audit_events (
    id uuid PRIMARY KEY,
    actor_user_id uuid NOT NULL,
    actor_admin_role text NOT NULL CHECK (actor_admin_role IN (
        'SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'SECURITY', 'FINANCE', 'READ_ONLY'
    )),
    capability text NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    subject_user_id uuid,
    result text NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED')),
    reason_code text CHECK (reason_code IS NULL OR reason_code IN (
        'SUPPORT_REQUEST', 'SECURITY_INCIDENT', 'ABUSE_PREVENTION',
        'USER_REQUEST', 'OPERATIONAL_RECOVERY', 'ROLE_ADMINISTRATION'
    )),
    reference text,
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (capability ~ '^[a-z][a-z0-9_.]{2,79}$'),
    CHECK (action ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    CHECK (resource_type ~ '^[A-Z][A-Z0-9_]{1,79}$'),
    CHECK (reference IS NULL OR (
        length(reference) BETWEEN 3 AND 80
        AND reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
    )),
    CHECK (jsonb_typeof(metadata_no_sensitive) = 'object')
);

CREATE INDEX admin_audit_events_created_idx
    ON admin_audit_events (created_at DESC, id DESC);

CREATE INDEX admin_audit_events_actor_created_idx
    ON admin_audit_events (actor_user_id, created_at DESC);

CREATE INDEX admin_audit_events_subject_created_idx
    ON admin_audit_events (subject_user_id, created_at DESC)
    WHERE subject_user_id IS NOT NULL;

CREATE INDEX admin_audit_events_resource_created_idx
    ON admin_audit_events (resource_type, resource_id, created_at DESC);

CREATE FUNCTION reject_admin_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'admin audit events are append-only';
END;
$$;

CREATE TRIGGER admin_audit_events_append_only
BEFORE UPDATE OR DELETE ON admin_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_event_mutation();

CREATE TRIGGER admin_audit_events_no_truncate
BEFORE TRUNCATE ON admin_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_event_mutation();
