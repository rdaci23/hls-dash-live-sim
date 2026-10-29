const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, ["--test", "test/control-ui.test.cjs"], {
  stdio: "inherit", env: { ...process.env, RUN_UI_TESTS: "1" },
});
process.exitCode = result.status ?? 1;
