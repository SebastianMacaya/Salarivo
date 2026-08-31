ALTER TABLE sessions
    ADD COLUMN device_type text NOT NULL DEFAULT 'UNKNOWN'
        CHECK (device_type IN ('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN')),
    ADD COLUMN browser_family text NOT NULL DEFAULT 'OTHER'
        CHECK (browser_family IN ('CHROME', 'EDGE', 'FIREFOX', 'SAFARI', 'OTHER')),
    ADD COLUMN os_family text NOT NULL DEFAULT 'OTHER'
        CHECK (os_family IN ('WINDOWS', 'MACOS', 'IOS', 'ANDROID', 'LINUX', 'OTHER'));

UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

ALTER TABLE sessions
    ALTER COLUMN last_seen_at SET DEFAULT now(),
    ALTER COLUMN last_seen_at SET NOT NULL;
