import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const MANAGED_LABEL = "io.hls-dash-live-sim.managed";
export const WORKSPACE_LABEL = "io.hls-dash-live-sim.workspace";
export function workspaceId(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}
export function ownershipArgs(): string[] {
  return [
    "--label",
    `${MANAGED_LABEL}=true`,
    "--label",
    `${WORKSPACE_LABEL}=${workspaceId()}`,
  ];
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
