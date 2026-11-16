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
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
      transform: { '^.+\\.ts$': swc },
    },
  ],
};
