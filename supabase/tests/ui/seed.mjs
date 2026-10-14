// Seed for the workspace browser tests: two schools, every role, and
// categories in each state (new, used as-is/adapted, in a draft, trashed,
// imported from a published puzzle, one old full-puzzle row). Filler names only.
export const U = {
  OWNER: 'thirth.p@example.edu',   // site owner, no school row
  LEAD: 'john.doe@example.edu',    // CMSRU lead
  ADMIN: 'marcus.t@example.edu',   // CMSRU admin
  FAC: 'dr.lee@example.edu',       // CMSRU faculty
  OTHER: 'aisha.k@example.edu',    // Rowan-Virtua admin
};
export const C = {
  clubbing: '10000000-0000-4000-8000-000000000001',
  hemoptysis: '10000000-0000-4000-8000-000000000002',
  blue: '10000000-0000-4000-8000-000000000003',
  lead: '10000000-0000-4000-8000-000000000004',
  asthma: '10000000-0000-4000-8000-000000000005',
  cheese: '10000000-0000-4000-8000-000000000006',
  spare: '10000000-0000-4000-8000-000000000007',
  oldpuzzle: '10000000-0000-4000-8000-000000000008',
  imported: '10000000-0000-4000-8000-000000000009',
};
export const D = { cmsru: '20000000-0000-4000-9000-000000000001', rv: '20000000-0000-4000-9000-000000000002' };

const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
const clue = (label, zone) => ({ label, zone: zone || 'corkboard', info: { title: label, text: label + ' detail' } });
const cat = (name, labels) => ({ name, explanation: name + ' explained.', items: labels.map((l, i) => clue(l, i === 0 ? 'rack' : 'corkboard')) });

export async function seed(db) {
  const x = (sql, p) => db.query(sql, p);
  await x(`insert into public.schools (slug, name, status) values ('rvsom', 'Rowan-Virtua SOM', 'active')`);
  await x(`update public.school_settings set comment_default = 'all' where school = 'rvsom'`);
  await x(`insert into public.site_owners (email) values ($1)`, [U.OWNER]);
  await x(`delete from public.members`);
  await x(`insert into public.members (email, school, role, display_name, color) values
    ($1, 'cmsru', 'lead', 'John D.', '#2f7d55'), ($2, 'cmsru', 'admin', 'Marcus T.', '#2e5aa8'),
    ($3, 'cmsru', 'faculty', 'Dr. Lee', '#8a5a00'), ($4, 'rvsom', 'admin', 'Aisha K.', '#a8306f')`, [U.LEAD, U.ADMIN, U.FAC, U.OTHER]);
  const sub = (id, school, name, labels, o = {}) => x(
    `insert into public.submissions (id, created_at, kind, status, suggested_tier, group_name, payload, credit_mode, credit_name, consent,
       receipt_code, school, tags, trashed_by, trashed_at, trash_reason, source, source_ref, used_in, contact_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [id, o.at || ago(1), o.kind || 'category', o.status || 'new', o.tier || 2, name, o.payload || cat(name, labels),
      o.anon ? 'anonymous' : 'named', o.anon ? null : 'John Doe', 'DP-' + id.slice(-4) + '-TEST', school, o.tags || [],
      o.tb || null, o.tb ? ago(o.ta || 1) : null, o.why || null, o.source || 'studio', o.ref || null, o.usedIn || null, o.contact || null]);
  await sub(C.clubbing, 'cmsru', 'Causes of clubbing', ['Lung cancer', 'Bronchiectasis', 'Cyanotic heart disease', 'IBD'], { at: ago(0.5), tags: ['Pulm'], tier: 1, contact: 'student@example.edu' });
  await sub(C.hemoptysis, 'cmsru', 'Causes of hemoptysis', ['TB', 'Bronchiectasis', 'Lung cancer', 'Goodpasture'], { at: ago(12), status: 'used', tags: ['Pulm'], tier: 3 });
  await sub(C.blue, 'cmsru', 'Things that are blue', ['Sky', 'Sea', 'Cyanosis', 'Methylene'], { at: ago(15), status: 'trashed', tb: U.ADMIN, ta: 2, why: 'Not pathology', tags: ['Derm'] });
  await sub(C.lead, 'rvsom', 'Lead poisoning signs', ['Basophilic stippling', 'Burton line', 'Wrist drop', 'Anemia'], { at: ago(3), tags: ['Heme'], tier: 2 });
  await sub(C.asthma, 'cmsru', 'Asthma triggers', ['Dust', 'Cold air', 'Aspirin', 'Exercise'], { at: ago(4), tags: ['Pulm'], tier: 1 });
  await sub(C.cheese, 'rvsom', 'Cheese-related', ['Tyramine', 'Listeria', 'Casein', 'Rennet'], { at: ago(20), anon: true, tags: ['Micro'], tier: 4 });
  await sub(C.spare, 'cmsru', 'Spare category', ['Alpha', 'Beta', 'Gamma', 'Delta'], { at: ago(25), status: 'trashed', tb: U.OTHER, ta: 5 });
  await sub(C.imported, 'cmsru', 'Holes in things', ['Ventricular septal defect', 'Patent foramen ovale', 'Cleft palate', 'Hiatus hernia'],
    { at: ago(30), status: 'used', source: 'published', ref: 'holes-haze-and-old-paint-2026-10-08', tags: ['Cardio'], tier: 2 });
  await x(`alter table public.submissions disable trigger submissions_categories_only`);
  await sub(C.oldpuzzle, 'cmsru', 'Whole old puzzle', [], { at: ago(40), kind: 'puzzle', tier: null,
    payload: { title: 'Whole old puzzle', groups: [cat('Group A', ['A1', 'A2', 'A3', 'A4'])].map((g) => Object.assign(g, { tier: 1 })) } });
  await x(`alter table public.submissions enable trigger submissions_categories_only`);
  // Usage: hemoptysis went out at CMSRU as-is and at Rowan-Virtua adapted.
  await x(`insert into public.category_uses (submission_id, school, puzzle_id, puzzle_date, adapted) values
    ($1, 'cmsru', 'lungs-and-more-2026-10-01', '2026-10-01', false), ($1, 'rvsom', 'rv-week-two-2026-10-05', '2026-10-05', true),
    ($2, 'cmsru', 'holes-haze-and-old-paint-2026-10-08', '2026-10-08', false)`, [C.hemoptysis, C.imported]);
  // One draft per school; each holds a category from the bank.
  await x(`insert into public.drafts (id, title, status, owner_email, school, updated_at) values
    ($1, 'CMSRU next week', 'planning', $3, 'cmsru', now()), ($2, 'RV private draft', 'planning', $4, 'rvsom', now())`, [D.cmsru, D.rv, U.ADMIN, U.OTHER]);
  await x(`insert into public.draft_slots (draft_id, tier, submission_id) values ($1, 3, $3), ($2, 1, $4)`, [D.cmsru, D.rv, C.lead, C.asthma]);
  await x(`insert into public.votes (submission_id, voter_email, school) values
    ($1, $3, 'cmsru'), ($1, $4, 'rvsom'), ($1, $5, 'cmsru'), ($2, $4, 'rvsom')`, [C.clubbing, C.hemoptysis, U.ADMIN, U.OTHER, U.LEAD]);
  await x(`insert into public.comments (target_type, target_id, author_email, body, school, visibility) values
    ('submission', $1, $2, 'CMSRU-only note about clubbing', 'cmsru', 'school'),
    ('submission', $1, $3, 'From RV: love this one', 'rvsom', 'all'),
    ('submission', $1, $3, 'RV private aside', 'rvsom', 'school')`, [C.clubbing, U.ADMIN, U.OTHER]);
  // Sign-in records for the Admin console's "Last sign-in" (Dr. Lee has never signed up).
  await x(`insert into auth.users (email, last_sign_in_at) values ($1, $4), ($2, $5), ($3, $6)`,
    [U.OWNER, U.LEAD, U.ADMIN, ago(0.1), ago(1), ago(3)]);
}
