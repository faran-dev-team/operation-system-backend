const { resolve } = require('node:path');
const { config } = require('dotenv');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

config({ path: resolve(__dirname, '..', '.env') });

function readDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error('DATABASE_URL is missing in .env');
  }
  return value;
}

/** Pilot workspaces used across local and shared development. */
const workspaces = [
  { slug: 'pilot-alpha', name: 'Pilot Alpha' },
  { slug: 'pilot-beta', name: 'Pilot Beta' },
];

/**
 * App users + memberships for RBAC and workspace-switch smoke tests.
 * Supabase Auth users must still be created separately with the same emails.
 *
 * Dual operator memberships let each operator switch Alpha <-> Beta.
 * Admin / reviewer accounts unlock audit logs and view-only UI checks.
 */
const users = [
  {
    email: 'operator.alpha@pilot.local',
    name: 'Alpha Operator',
    memberships: [
      { workspaceSlug: 'pilot-alpha', role: 'operator' },
      { workspaceSlug: 'pilot-beta', role: 'operator' },
    ],
  },
  {
    email: 'operator.beta@pilot.local',
    name: 'Beta Operator',
    memberships: [
      { workspaceSlug: 'pilot-beta', role: 'operator' },
      { workspaceSlug: 'pilot-alpha', role: 'operator' },
    ],
  },
  {
    email: 'admin.alpha@pilot.local',
    name: 'Alpha Admin',
    memberships: [{ workspaceSlug: 'pilot-alpha', role: 'admin' }],
  },
  {
    email: 'admin.beta@pilot.local',
    name: 'Beta Admin',
    memberships: [{ workspaceSlug: 'pilot-beta', role: 'admin' }],
  },
  {
    email: 'reviewer.alpha@pilot.local',
    name: 'Alpha Reviewer',
    memberships: [{ workspaceSlug: 'pilot-alpha', role: 'reviewer' }],
  },
  {
    email: 'reviewer.beta@pilot.local',
    name: 'Beta Reviewer',
    memberships: [{ workspaceSlug: 'pilot-beta', role: 'reviewer' }],
  },
];

async function main() {
  const adapter = new PrismaPg({
    connectionString: readDatabaseUrl(),
  });
  const prisma = new PrismaClient({ adapter });

  const workspaceBySlug = {};

  for (const item of workspaces) {
    const workspace = await prisma.workspace.upsert({
      where: { slug: item.slug },
      update: { name: item.name },
      create: { name: item.name, slug: item.slug },
    });
    workspaceBySlug[item.slug] = workspace;
  }

  for (const account of users) {
    const user = await prisma.user.upsert({
      where: { email: account.email },
      update: { name: account.name },
      create: { email: account.email, name: account.name },
    });

    for (const membership of account.memberships) {
      const workspace = workspaceBySlug[membership.workspaceSlug];
      if (!workspace) {
        throw new Error(`Unknown workspace slug: ${membership.workspaceSlug}`);
      }

      await prisma.membership.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: workspace.id,
            userId: user.id,
          },
        },
        update: { role: membership.role },
        create: {
          workspaceId: workspace.id,
          userId: user.id,
          role: membership.role,
        },
      });
    }
  }

  const [workspaceCount, userCount, membershipCount] = await Promise.all([
    prisma.workspace.count(),
    prisma.user.count(),
    prisma.membership.count(),
  ]);

  await prisma.$disconnect();

  console.log(
    `Seed complete. workspaces=${workspaceCount} users=${userCount} memberships=${membershipCount}`,
  );
  console.log(
    'Pilot emails: operator/admin/reviewer .alpha|.beta @pilot.local (create matching Supabase Auth users to sign in).',
  );
}

main().catch(async (error) => {
  console.error(error.message);
  process.exit(1);
});
