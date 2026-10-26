import { migrate, resetDatabase } from './migrate.ts';

const command = process.argv[2];
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required');

switch (command) {
  case 'migrate': {
    const applied = await migrate(ownerUrl);
    console.log(
      applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date',
    );
    break;
  }
  case 'seed': {
    const { seedDemo } = await import('./seed/index.ts');
    await seedDemo(ownerUrl);
    break;
  }
  case 'reset': {
    await resetDatabase(ownerUrl);
    await migrate(ownerUrl);
    const { seedDemo } = await import('./seed/index.ts');
    await seedDemo(ownerUrl);
    break;
  }
  default:
    console.error('usage: cli.ts migrate|seed|reset');
    process.exitCode = 1;
}
