// A local certificate authority and server certificate for --http2.
//
// The CA is kept and reused, so a device or simulator that trusts it once keeps
// trusting new server certificates (a new LAN address only needs a rerun).
// Private keys are written 0600 into a directory that ignores itself in Git.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Apple rejects TLS server certificates valid for more than 825 days; also stay under the public 398-day limit. */
const LEAF_DAYS = 397;
const CA_DAYS = 825;
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface LocalCertOptions {
  /** Output directory; default `.certs` in the working directory. */
  dir?: string;
  /** Extra host names or IP addresses for the server certificate. */
  hosts?: string[];
  /** Include this computer's LAN IPv4 addresses (default true). */
  lan?: boolean;
}
export interface LocalCerts {
  dir: string;
  ca: string;
  caKey: string;
  cert: string;
  key: string;
  subjectAltNames: string[];
  reusedCa: boolean;
}

export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces()))
    for (const entry of entries ?? [])
      if (!entry.internal && entry.family === "IPv4" && !entry.address.startsWith("169.254.")) found.push(entry.address);
  return found;
}

export function subjectAltNames(hosts: string[]): string[] {
  const names = [...new Set(["localhost", "127.0.0.1", "::1", ...hosts].map(value => String(value).trim().toLowerCase().replace(/^\[|\]$/g, "")).filter(Boolean))];
  for (const name of names)
    if (!net.isIP(name) && !HOST_NAME.test(name)) throw new Error(`${name} is not a host name or IP address`);
  return names.map(name => (net.isIP(name) ? "IP:" : "DNS:") + name);
}

function openssl(args: string[]): string {
  try {
    return execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: Buffer };
    if (failure.code === "ENOENT") throw new Error("openssl was not found on PATH; it is needed to create the certificates");
    throw new Error(`openssl ${args[0]} failed: ${String(failure.stderr ?? failure.message).trim()}`);
  }
}

/** Create (or reuse) the CA and issue a fresh server certificate. */
export function createLocalCerts(options: LocalCertOptions = {}): LocalCerts {
  const dir = path.resolve(options.dir ?? ".certs");
  const san = subjectAltNames([...(options.lan === false ? [] : lanAddresses()), ...(options.hosts ?? [])]);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, ".gitignore"), "# Local TLS keys and certificates: never commit.\n*\n");
  const files = { ca: path.join(dir, "ca.pem"), caKey: path.join(dir, "ca.key"), cert: path.join(dir, "server.pem"), key: path.join(dir, "server.key") };
  let reusedCa = fs.existsSync(files.ca) && fs.existsSync(files.caKey);
  if (reusedCa) {
    // A CA that expires before a new server certificate would is replaced.
    try { openssl(["x509", "-in", files.ca, "-noout", "-checkend", String(LEAF_DAYS * 86400)]); }
    catch { reusedCa = false; }
  }
  if (!reusedCa)
    openssl(["req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", String(CA_DAYS),
      "-keyout", files.caKey, "-out", files.ca, "-subj", `/O=hls-dash-live-sim/CN=hls-dash-live-sim local CA ${crypto.randomBytes(4).toString("hex")}`,
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  const csr = path.join(dir, "server.csr"), ext = path.join(dir, "server.ext");
  fs.writeFileSync(ext, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=" + san.join(","),
    "",
  ].join("\n"));
  try {
    openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", files.key, "-out", csr, "-subj", "/O=hls-dash-live-sim/CN=localhost"]);
    openssl(["x509", "-req", "-in", csr, "-CA", files.ca, "-CAkey", files.caKey, "-set_serial", "0x" + crypto.randomBytes(12).toString("hex"),
      "-days", String(LEAF_DAYS), "-sha256", "-extfile", ext, "-out", files.cert]);
  } finally {
    fs.rmSync(csr, { force: true });
    fs.rmSync(ext, { force: true });
  }
  fs.chmodSync(files.caKey, 0o600);
  fs.chmodSync(files.key, 0o600);
  return { ...files, dir, subjectAltNames: san, reusedCa };
}

/** The CLI's report of what was made and what to do next. */
export function describeLocalCerts(made: LocalCerts, cwd = process.cwd()): string {
  const rel = (file: string) => path.relative(cwd, file) || file;
  return [
    `${made.reusedCa ? "Reused" : "Created"} local CA: ${rel(made.ca)} (key ${rel(made.caKey)}; keep it private)`,
    `Server certificate: ${rel(made.cert)} (key ${rel(made.key)}) for ${made.subjectAltNames.join(", ")}`,
    "",
    "Start a session over HTTP/2:",
    `  hls-dash-live-sim livesim start --sim-type hls --low-latency --http2 --tls-cert ${rel(made.cert)} --tls-key ${rel(made.key)}`,
    "",
    "Trust the CA (not the server certificate) where the player runs:",
    `  iOS/tvOS simulator: xcrun simctl keychain <udid|booted> add-root-cert ${rel(made.ca)}`,
    "  Devices: see docs/configuration.md, \"Trusting the CA\"",
  ].join("\n");
}
