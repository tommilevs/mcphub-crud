export async function ensureSkillProposalSchema(db:{query(sql:string):Promise<unknown>}):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS skill_proposals(
    proposal_id uuid PRIMARY KEY,username text NOT NULL,key_id text,
    source_experience_id uuid NOT NULL,source_revision integer NOT NULL,
    source_snapshot jsonb NOT NULL,markdown text NOT NULL,
    status varchar(16) NOT NULL CHECK(status IN ('draft','approved','retired')),
    revision integer NOT NULL DEFAULT 1,reviewed_by text NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT NOW()
  );CREATE INDEX IF NOT EXISTS skill_proposals_owner_idx ON skill_proposals(username,key_id,reviewed_at DESC);
  CREATE TABLE IF NOT EXISTS skill_proposal_versions(
    proposal_id uuid NOT NULL REFERENCES skill_proposals(proposal_id) ON DELETE CASCADE,
    revision integer NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(proposal_id,revision)
  )`);
}
