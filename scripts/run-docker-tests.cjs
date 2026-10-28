const { spawnSync } = require("node:child_process");
const result = spawnSync(
  process.execPath,
  ["--test", "test/dash-docker.test.cjs"],
  { stdio: "inherit", env: { ...process.env, RUN_DOCKER_TESTS: "1" } },
);
process.exitCode = result.status ?? 1;
