// Installs only this project's prebuilt standalone ZIP on an explicitly selected device.
const path = require('node:path');
const net = require('node:net');
const { rokuDeploy } = require('roku-deploy');
const { XMLParser } = require('fast-xml-parser');
const args = process.argv.slice(2), index = args.indexOf('--device');
const host = args[index + 1];
async function main() {
  if (index < 0 || net.isIP(host) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !args.includes('--replace-dev-channel'))
    throw Error('Usage: node scripts/deploy-roku.cjs --device ROKU_LAN_IP --replace-dev-channel (replaces the sideloaded developer channel)');
  const password = process.env.ROKU_DEV_PASSWORD || process.env.ROKU_PASSWORD;
  if (!password) throw Error('Set ROKU_DEV_PASSWORD in your terminal; credentials are never saved to the project.');
  try {
    await rokuDeploy.publish({ host, username: 'rokudev', password, rootDir: path.resolve(__dirname, '../roku'),
      outDir: path.resolve(__dirname, '../output/roku'), outFile: 'hls-dash-stream-tester',
      autoLaunch: false, failOnCompileError: true, timeout: 30000, logLevel: 'error' });
  } catch { throw Error('Roku installer rejected the native tester; check the developer password and device installer diagnostics.'); }
  const response = await fetch(`http://${host}:8060/query/apps`, { signal: AbortSignal.timeout(5000) });
  const apps = new XMLParser({ ignoreAttributes: false }).parse(await response.text()).apps.app;
  if (!(Array.isArray(apps) ? apps : [apps]).some(a => a['@_id'] === 'dev' && a['#text'] === 'HLS DASH Stream Tester'))
    throw Error('Installer completed but the standalone tester was not found on device.');
  console.log('Installed HLS DASH Stream Tester. Verification launches it separately.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
