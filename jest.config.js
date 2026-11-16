/** @type {import('jest').Config} */
const swc = [
  '@swc/jest',
  {
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
    module: { type: 'commonjs' },
  },
];

module.exports = {
  projects: [
    {
      // No network, no database: runs anywhere with `npm test`.
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
      transform: { '^.+\\.ts$': swc },
    },
    {
      // Real Postgres. Run in band (see the npm script) because the tests share one database.
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
      transform: { '^.+\\.ts$': swc },
      // Recreates and migrates the `ranker_test` database once per run.
      globalSetup: '<rootDir>/test/integration/globalSetup.ts',
    },
  ],
};
