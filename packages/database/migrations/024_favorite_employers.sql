CREATE TABLE user_favorite_employers (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, employer_id)
);

CREATE INDEX user_favorite_employers_employer_idx
    ON user_favorite_employers (employer_id, user_id);
