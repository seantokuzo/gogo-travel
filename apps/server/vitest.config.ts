import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // T-S3.3 (R-test-6): ONE Postgres testcontainer per run; DB suites clone
    // per-suite databases off its migrated template (src/test/suite-db.ts).
    // This is what retired the `--no-file-parallelism` workaround (QUEUE P1):
    // files run parallel again without wedging the Docker daemon.
    globalSetup: ["./src/test/global-setup.ts"],
  },
});
