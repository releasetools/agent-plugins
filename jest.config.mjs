/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  clearMocks: true,
  // Both, because the plugin's tests came from a TypeScript repository and the
  // marketplace tooling is plain JS with no types to strip.
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.mjs"],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // swc strips the types and emits ESM. It does not type-check, so the test
    // script runs tsc first - the half of ts-jest worth keeping.
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: { parser: { syntax: "typescript" }, target: "es2022" },
        module: { type: "es6" },
      },
    ],
  },
};
