import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

export const MANAGED_LABEL = "io.hls-dash-live-sim.managed";
export const WORKSPACE_LABEL = "io.hls-dash-live-sim.workspace";
export const OWNER_PID_LABEL = "io.hls-dash-live-sim.owner-pid";
export const OWNER_HOST_LABEL = "io.hls-dash-live-sim.owner-host";
export function workspaceId(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}
export function ownershipArgs(): string[] {
  return [
    "--label",
    `${MANAGED_LABEL}=true`,
    "--label",
    `${WORKSPACE_LABEL}=${workspaceId()}`,
    "--label",
    `${OWNER_PID_LABEL}=${process.pid}`,
    "--label",
    `${OWNER_HOST_LABEL}=${os.hostname()}`,
  ];
}
/** An orphan is this workspace's container on this host whose recorded
 * supervising process no longer exists. Unlabelled or foreign ones are not. */
export function orphanedOwner(labels: Record<string, string> = {}, alive: (pid: number) => boolean = processAlive): boolean {
  const pid = Number(labels[OWNER_PID_LABEL]);
  return labels[MANAGED_LABEL] === "true" && labels[WORKSPACE_LABEL] === workspaceId() &&
    labels[OWNER_HOST_LABEL] === os.hostname() && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid);
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function assertOwnedContainer(name: string, docker = "docker"): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
    throw new Error("Invalid container name");
  let container;
  try {
    container = JSON.parse(
      execFileSync(docker, ["inspect", name], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    )[0];
  } catch (error) {
    if (
      /No such (object|container)/i.test(
        String((error as { stderr?: unknown }).stderr),
      )
    )
      return false;
    throw new Error(
      "Could not inspect container ownership; ensure Docker is running",
    );
  }
  const labels = container.Config?.Labels ?? {};
  if (
    labels[MANAGED_LABEL] !== "true" ||
    labels[WORKSPACE_LABEL] !== workspaceId()
  )
    throw new Error(
      `Container ${name} is not owned by this workspace; it was left untouched`,
    );
  return true;
}
