ALTER TABLE upload_sessions
    ADD COLUMN upload_marker_etag text;

ALTER TABLE upload_sessions
    ADD CONSTRAINT upload_sessions_marker_etag_check
    CHECK (
        upload_marker_etag IS NULL
        OR (
            length(upload_marker_etag) BETWEEN 1 AND 128
            AND upload_marker_etag !~ '[[:cntrl:]]'
        )
    );
