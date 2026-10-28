#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { StreamTemplate } from './support-tools/stream-templates.js';
import { portNumber, bindHost } from './support-tools/safe-http.js';

yargs(hideBin(process.argv))
  .parserConfiguration({ 'populate--': true })
  .scriptName('hls-dash-live-sim')
  .usage('$0 <command> [options]')
  .version('0.1.0')
  .option('verbose', { type: 'boolean', default: false, global: true })
  .command(
    'fault-control',
    'Start the fault injection control web UI for HLS/DASH simulators',
    yargs => yargs
      .option('port', { type: 'number', description: 'Port for the control server', default: 19090 })
      .option('host', { type: 'string', description: 'Bind address; LAN access requires a control token', default: '127.0.0.1' })
      .option('control-token', { type: 'string', description: 'Token required for LAN control API access (env HLS_DASH_CONTROL_TOKEN)' })
      .option('fault-config', { type: 'string', description: 'Path to fault injection configuration JSON' })
      .option('fault-profile', { type: 'string', description: 'Fault profile name to apply on startup' })
      .strict(),
    async args => {
      if (args.verbose) {
        process.env.STANDALONE_VERBOSE = '1';
        process.env.STANDALONE_UPDATER_VERBOSE = '1';
      }
      try {
        const { startFaultServer } = await import('./support-tools/live-stream-fault-server.js');
        await startFaultServer({
          port: args.port as number | undefined,
          host: args.host as string | undefined,
          configPath: args['fault-config'] as string | undefined,
          profile: args['fault-profile'] as string | undefined,
          controlToken: args['control-token'] as string | undefined
        });
      } catch (err) {
        console.error('❌ Failed to start fault-control server:', err);
        process.exit(1);
      }
    }
  )
  .command(
    'livesim [action]',
    'Start/stop/view logs of HLS or DASH live simulators (auto-detects from manifest URL)',
    yargs => yargs
      .positional('action', {
        type: 'string',
        choices: ['start', 'stop', 'logs'] as const,
        default: 'start',
        describe: 'Action to perform (default: start)'
      })
      .option('manifestUrl', { alias: 'manifest-url', type: 'string', description: 'Remote manifest URL used to auto-detect simulator type (.m3u8 => HLS, .mpd => DASH)' })
      .option('sim-type', { type: 'string', choices: ['dash', 'hls'] as const, describe: 'Explicit simulator selection (defaults to HLS if not provided)' })
      .option('image', { type: 'string', description: 'Docker image tag/path (defaults vary by simulator)' })
      .option('port', { type: 'number', description: 'Host port for simulator (defaults to 8899 for HLS, 8888 for DASH)' })
      .option('host', { type: 'string', default: '127.0.0.1', description: 'Bind address; use 0.0.0.0 explicitly for LAN streaming' })
      .option('allow-origin', { type: 'array', string: true, description: 'Additional permitted proxy origin; credentials remain scoped to the manifest origin' })
      .option('vodroot', { type: 'string', description: 'Host folder for VoD/assets (mounted for the selected simulator)' })
      .option('source', { type: 'string', description: 'HLS: Relative MP4 path under vodroot to serve (e.g. samples/bbb.mp4)' })
      .option('persist-repdata', { type: 'boolean', description: 'DASH: Mount ~/.hls-dash-live-sim/livesim2/repdata to /repdata and pass --repdataroot=/repdata' })
      .option('repdataDir', { type: 'string', description: 'DASH: Override host repdata directory' })
      .option('detach', { type: 'boolean', description: 'Run simulator detached', default: false })
      .option('name', { type: 'string', description: 'Container name (defaults vary by simulator)' })
      .option('asset', { type: 'string', description: 'DASH: Local livesim2 asset to use when generating URLs' })
      .option('open', { type: 'boolean', description: 'Open simulator UI/root after start' })
      .option('pull', { type: 'boolean', description: 'Pull Docker image if missing', default: true })
      .option('force-pull', { type: 'boolean', description: 'Force pull Docker image even if cached' })
      .option('proxy', { type: 'boolean', description: 'HLS: Proxy remote HLS instead of local MP4 serving' })
      .option('dummy-content', { type: 'boolean', description: 'HLS: Serve bundled sample segments instead of remote media', default: true })
      .option('preserve-manifest', { type: 'boolean', description: 'Preserve remote manifest structure when proxying (defaults to true when --manifestUrl is supplied)' })
      .option('auth-token', { type: 'string', description: 'Bearer token for manifest authentication' })
      .option('auth-header', { type: 'string', description: 'Custom authorization header (format: "Header-Name: value")' })
      .option('auth-file', { type: 'string', description: 'Path to JSON file containing auth headers' })
      .option('fault-proxy', { type: 'boolean', description: 'DASH: Enable node fault proxy when detached', default: true })
      .option('fault-config', { type: 'string', description: 'Path to fault injection configuration JSON (.hls-dash-faults.json by default)' })
      .option('fault-profile', { type: 'string', description: 'Fault profile name to apply on startup' })
      .option('showManifest', { type: 'boolean', description: 'Display the generated manifest after starting the simulator', default: false })
      .option('periods', { type: 'number', description: 'DASH: Number of periods to generate (default: 1)' })
      .option('period-durations', { type: 'string', description: 'DASH: Comma-separated durations in seconds for each period (e.g., "60,120,180")' })
      .strict(),
    async args => {
      if (args.verbose) {
        process.env.STANDALONE_VERBOSE = '1';
        process.env.STANDALONE_UPDATER_VERBOSE = '1';
      }
      try {
        const action = args.action as 'start' | 'stop' | 'logs';
        const manifestUrl = args.manifestUrl as string | undefined;
        const explicitType = args['sim-type'] as 'dash' | 'hls' | undefined;
        const nameArg = args.name as string | undefined;
        const preserveManifestRaw = args['preserve-manifest'] as boolean | undefined;
        const preserveManifestResolved = preserveManifestRaw !== undefined ? preserveManifestRaw : Boolean(manifestUrl);

        const determineSimType = (): 'dash' | 'hls' => {
          if (explicitType) return explicitType;
          if (manifestUrl) {
            const normalized = manifestUrl.split('?')[0].toLowerCase();
            if (normalized.endsWith('.mpd') || manifestUrl.toLowerCase().includes('.mpd')) {
              return 'dash';
            }
            if (normalized.endsWith('.m3u8') || manifestUrl.toLowerCase().includes('.m3u8')) {
              return 'hls';
            }
          }
          if (nameArg) {
            const lowerName = nameArg.toLowerCase();
            if (lowerName.includes('livesim2') || lowerName.includes('dash')) {
              return 'dash';
            }
            if (lowerName.includes('hls')) {
              return 'hls';
            }
          }
          if (typeof args.source === 'string') {
            return 'hls';
          }
          if (typeof args.asset === 'string') {
            return 'dash';
          }
          if (typeof args.proxy === 'boolean') {
            return 'hls';
          }
          if (typeof args['persist-repdata'] === 'boolean' || typeof args.repdataDir === 'string') {
            return 'dash';
          }
          return 'hls';
        };

        const simType = determineSimType();

        if (simType === 'dash') {
          const { startLivesim2, stopLivesim2, logsLivesim2 } = await import('./support-tools/dash-sim-runner.js');
          switch (action) {
            case 'start': {
              const argvRest = (args['--'] as unknown[] | undefined) ?? [];
              const extraArgs = argvRest.map(String);

              // Parse period-durations string to array
              let periodDurations: number[] | undefined;
              const periodDurationsStr = args['period-durations'] as string | undefined;
              if (periodDurationsStr) {
                periodDurations = periodDurationsStr
                  .split(',')
                  .map(s => s.trim())
                  .filter(s => s.length > 0)
                  .map(s => {
                    const num = Number(s);
                    if (isNaN(num) || num <= 0) {
                      throw new Error(`Invalid period duration: "${s}". Must be a positive number.`);
                    }
                    return num;
                  });
              }

              await startLivesim2({
                host: args.host as string,
                image: args.image as string | undefined,
                port: args.port as number | undefined,
                vodroot: args.vodroot as string | undefined,
                persistRepdata: args['persist-repdata'] as boolean | undefined,
                repdataDir: args.repdataDir as string | undefined,
                detach: args.detach as boolean | undefined,
                name: nameArg,
                asset: args.asset as string | undefined,
                open: args.open as boolean | undefined,
                noPull: args.pull === false,
                forcePull: args['force-pull'] as boolean | undefined,
                extraArgs,
                manifestUrl,
                authToken: args['auth-token'] as string | undefined,
                authHeader: args['auth-header'] as string | undefined,
                authFile: args['auth-file'] as string | undefined,
                preserveManifest: preserveManifestResolved,
                faultProxy: args['fault-proxy'] as boolean | undefined,
                faultConfigPath: args['fault-config'] as string | undefined,
                faultProfile: args['fault-profile'] as string | undefined,
                periodCount: args.periods as number | undefined,
                periodDurations,
              });

              // Display manifest if requested
              if (args.showManifest) {
                await displayManifestAfterStart(simType, args.port as number | undefined, args.asset as string | undefined);
              }
              break;
            }
            case 'stop':
              await stopLivesim2({ name: nameArg });
              break;
            case 'logs':
              await logsLivesim2({ name: nameArg });
              break;
          }
        } else {
          const { startHlsim, stopHlsim, logsHlsim } = await import('./support-tools/hls-sim-runner.js');
          switch (action) {
            case 'start':
              await startHlsim({
                host: args.host as string,
                allowedOrigins: args['allow-origin'] as string[],
                image: args.image as string | undefined,
                port: args.port as number | undefined,
                vodroot: args.vodroot as string | undefined,
                source: args.source as string | undefined,
                detach: args.detach as boolean | undefined,
                name: nameArg,
                open: args.open as boolean | undefined,
                noPull: args.pull === false,
                forcePull: args['force-pull'] as boolean | undefined,
                manifestUrl,
                proxy: args.proxy as boolean | undefined,
                dummyContent: args['dummy-content'] as boolean | undefined,
                preserveManifest: preserveManifestResolved,
                authToken: args['auth-token'] as string | undefined,
                authHeader: args['auth-header'] as string | undefined,
                authFile: args['auth-file'] as string | undefined,
                faultConfigPath: args['fault-config'] as string | undefined,
                faultProfile: args['fault-profile'] as string | undefined,
              });

              // Display manifest if requested
              if (args.showManifest) {
                await displayManifestAfterStart(simType, args.port as number | undefined, args.asset as string | undefined);
              }
              break;
            case 'stop':
              await stopHlsim({ name: nameArg });
              break;
            case 'logs':
              await logsHlsim({ name: nameArg });
              break;
          }
        }
      } catch (err) {
        console.error('❌ Failed to execute livesim command:', err);
        process.exit(1);
      }
    }
  )
  .command(
    'create-manifest-template <url>',
    'Create a reusable stream template by analyzing a live manifest/playlist URL',
    yargs => yargs
      .positional('url', {
        type: 'string',
        describe: 'Manifest or playlist URL to analyze'
      })
      .option('name', { type: 'string', describe: 'Name for the generated template' })
      .option('auth-token', { type: 'string', description: 'Bearer token for manifest authentication' })
      .option('auth-header', { type: 'string', description: 'Custom authorization header' })
      .option('auth-file', { type: 'string', description: 'Path to auth config file' }),
    async args => {
      const { createTemplateFromUrl, saveTemplate } = await import('./support-tools/stream-templates.js');

      try {
        const template = await createTemplateFromUrl({
          url: args.url as string,
          name: args.name as string,
          authToken: args['auth-token'] as string,
          authHeader: args['auth-header'] as string,
          authFile: args['auth-file'] as string
        });

        const templateName = args.name || template.name;
        saveTemplate(templateName, template);

        console.log(`🎭 Template "${templateName}" created successfully!`);
        console.log(`📝 Description: ${template.description}`);
        console.log(`🎬 Protocol: ${template.asset ? 'DASH' : 'HLS'}`);
        console.log(`📊 Bitrates: ${template.bitrateLadder.join(', ')} kbps`);
        console.log(`⏱️  Segment duration: ${template.segmentDuration}ms`);
        console.log(`🎵 Content type: ${template.contentType}`);
        console.log(`🎯 SCTE-35 cues: ${template.hasSCTE35 ? 'Enabled' : 'Disabled'}`);
        if (template.asset) {
          console.log(`🎪 DASH asset: ${template.asset}`);
        }
        if (template.hlsSource) {
          console.log(`🎞️  HLS source: ${template.hlsSource}`);
        }

        console.info(`\n🚀 Use with: hls-dash-live-sim dummy-stream ${templateName}`);

      } catch (error) {
        console.error('❌ Failed to create template:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }
  )
  .command(
    'list-manifest-templates',
    'List all available stream templates',
    () => {},
    async () => {
      const { listTemplates } = await import('./support-tools/stream-templates.js');

      console.info('📋 Available Templates:\n');

      const templates = listTemplates();
      for (const { name, template } of templates) {
        const type = template.isDynamic ? '🔄 Dynamic' : '📄 Predefined';
        console.info(`${type} ${name}`);
        console.info(`   ${template.description}`);
        console.info(`   Bitrates: ${template.bitrateLadder.length} levels`);
        console.info(`   Segment: ${template.segmentDuration}ms`);
        if (template.sourceUrl) {
          console.info(`   Source: ${template.sourceUrl}`);
        }
        console.info('');
      }
    }
  )
  .command(
    'dummy-stream <template>',
    'Start a dummy live stream using a template',
    yargs => yargs
      .positional('template', {
        type: 'string',
        describe: 'Template name to use'
      })
      .option('port', { type: 'number' })
      .option('detach', { type: 'boolean', default: true })
      .option('sim-type', { type: 'string', choices: ['dash', 'hls'] as const, describe: 'Force simulator type' })
      .option('showManifest', { type: 'boolean', description: 'Display the generated manifest after starting the simulator', default: false }),
    async args => {
      const { getTemplate } = await import('./support-tools/stream-templates.js');

      const template = getTemplate(args.template as string);
      if (!template) {
        console.error(`❌ Template "${args.template}" not found.`);
        console.error('Run "hls-dash-live-sim list-manifest-templates" to see available templates.');
        process.exit(1);
      }

      // Log template details
      console.log(`🎭 Using template: ${template.name}`);
      console.log(`📝 Description: ${template.description}`);
      console.log(`🎬 Protocol: ${args['sim-type'] || 'auto-detect'}`);
      console.log(`📊 Bitrates: ${template.bitrateLadder.join(', ')} kbps`);
      console.log(`⏱️  Segment duration: ${template.segmentDuration}ms`);
      console.log(`🎵 Content type: ${template.contentType}`);
      console.log(`🎯 SCTE-35 cues: ${template.hasSCTE35 ? 'Enabled' : 'Disabled'}`);
      if (template.asset) {
        console.log(`🎪 DASH asset: ${template.asset}`);
      }
      if (template.hlsSource) {
        console.log(`🎞️  HLS source: ${template.hlsSource}`);
      }
      console.log('');

      // Start stream using template
      await startStreamFromTemplate(template, {
        port: args.port as number,
        detach: args.detach as boolean,
        simType: args['sim-type'] as 'dash' | 'hls',
        showManifest: args.showManifest as boolean
      });
    }
  )
  // Convenience aliases for predefined templates
  .command(
    'sports-stream',
    'Start sports stream (HLS by default)',
    yargs => yargs
      .option('sim-type', { choices: ['hls', 'dash'], default: 'hls' })
      .option('detach', { type: 'boolean', default: true })
      .option('port', { type: 'number', default: 8899 })
      .option('showManifest', { type: 'boolean', default: false }),
    args => runTemplate('sports', {
      simType: args['sim-type'] as 'dash' | 'hls',
      detach: args.detach,
      port: args.port,
      showManifest: args.showManifest
    })
  )
  .command(
    'news-stream',
    'Start news stream (HLS by default)',
    yargs => yargs
      .option('sim-type', { choices: ['hls', 'dash'], default: 'hls' })
      .option('detach', { type: 'boolean', default: true })
      .option('port', { type: 'number', default: 8899 })
      .option('showManifest', { type: 'boolean', default: false }),
    args => runTemplate('news', {
      simType: args['sim-type'] as 'dash' | 'hls',
      detach: args.detach,
      port: args.port,
      showManifest: args.showManifest
    })
  )
  .command(
    'ott-stream',
    'Start OTT stream (HLS by default)',
    yargs => yargs
      .option('sim-type', { choices: ['hls', 'dash'], default: 'hls' })
      .option('detach', { type: 'boolean', default: true })
      .option('port', { type: 'number', default: 8899 })
      .option('showManifest', { type: 'boolean', default: false }),
    args => runTemplate('ott', {
      simType: args['sim-type'] as 'dash' | 'hls',
      detach: args.detach,
      port: args.port,
      showManifest: args.showManifest
    })
  )
  .command(
    'mobile-stream',
    'Start mobile stream (HLS by default)',
    yargs => yargs
      .option('sim-type', { choices: ['hls', 'dash'], default: 'hls' })
      .option('detach', { type: 'boolean', default: true })
      .option('port', { type: 'number', default: 8899 })
      .option('showManifest', { type: 'boolean', default: false }),
    args => runTemplate('mobile', {
      simType: args['sim-type'] as 'dash' | 'hls',
      detach: args.detach,
      port: args.port,
      showManifest: args.showManifest
    })
  )
  .command(
    'low-latency-stream',
    'Start low latency stream (HLS by default)',
    yargs => yargs
      .option('sim-type', { choices: ['hls', 'dash'], default: 'hls' })
      .option('detach', { type: 'boolean', default: true })
      .option('port', { type: 'number', default: 8899 })
      .option('showManifest', { type: 'boolean', default: false }),
    args => runTemplate('low-latency', {
      simType: args['sim-type'] as 'dash' | 'hls',
      detach: args.detach,
      port: args.port,
      showManifest: args.showManifest
    })
  )

  .help('help', 'View help information about this tool.')
  .check(args => {
    if (args.port !== undefined) portNumber(args.port as number);
    if (args.host !== undefined) bindHost(args.host as string);
    if (args.periods !== undefined && (!Number.isInteger(args.periods) || Number(args.periods) < 1 || Number(args.periods) > 60)) throw new Error('periods must be an integer between 1 and 60');
    return true;
  })
  .demandCommand(1)
  .strict()
  .parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

// Helper function for displaying manifest after simulator starts
async function displayManifestAfterStart(simType: 'dash' | 'hls', port?: number, asset?: string) {
  // Wait for simulator to be ready
  console.log('⏳ Waiting for simulator to be ready...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Determine manifest URL
  const manifestUrl = simType === 'dash'
    ? `http://localhost:${port || 8888}/livesim2/${asset || 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17'}/stream.mpd`
    : `http://localhost:${port || 8899}/proxy.m3u8`;

  console.log(`📄 Fetching manifest from: ${manifestUrl}`);

  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const manifestContent = await response.text();

    console.log('\n' + '='.repeat(80));
    console.log(`📋 GENERATED ${simType.toUpperCase()} MANIFEST`);
    console.log('='.repeat(80));
    console.log(manifestContent);
    console.log('='.repeat(80));
    console.log(`✅ Manifest displayed successfully (${manifestContent.length} characters)`);

  } catch (fetchError) {
    console.error('❌ Failed to fetch manifest:', fetchError instanceof Error ? fetchError.message : String(fetchError));
    console.log('💡 Make sure the simulator started successfully and is accessible on the specified port.');
  }
}

// Helper functions for template commands
async function runTemplate(name: string, options: TemplateStartOptions = {}) {
  const { getTemplate } = await import('./support-tools/stream-templates.js');
  const template = getTemplate(name);
  if (!template) {
    console.error(`Template "${name}" not found`);
    process.exit(1);
  }

  // Log template details
  console.log(`🎭 Using template: ${template.name}`);
  console.log(`📝 Description: ${template.description}`);
  console.log(`🎬 Protocol: ${options.simType || 'hls'}`);
  console.log(`📊 Bitrates: ${template.bitrateLadder.join(', ')} kbps`);
  console.log(`⏱️  Segment duration: ${template.segmentDuration}ms`);
  console.log(`🎵 Content type: ${template.contentType}`);
  console.log(`🎯 SCTE-35 cues: ${template.hasSCTE35 ? 'Enabled' : 'Disabled'}`);
  if (template.asset) {
    console.log(`🎪 DASH asset: ${template.asset}`);
  }
  if (template.hlsSource) {
    console.log(`🎞️  HLS source: ${template.hlsSource}`);
  }
  console.log('');

  // Set HLS as default instead of DASH
  const finalOptions: TemplateStartOptions = { simType: 'hls', ...options };
  await startStreamFromTemplate(template, finalOptions);
}

interface TemplateStartOptions {
  simType?: 'dash' | 'hls';
  port?: number;
  detach?: boolean;
  showManifest?: boolean;
}

async function startStreamFromTemplate(template: StreamTemplate, options: TemplateStartOptions) {
  // Convert template to livesim options and start
  const simType = options.simType || 'hls';

  // Call the appropriate simulator directly
  try {
    const nameArg = `template-${template.name.toLowerCase().replace(/\s+/g, '-')}`;

    if (simType === 'dash') {
      const { startLivesim2 } = await import('./support-tools/dash-sim-runner.js');

      // Create mock MPDInfo from stored template data to avoid re-analysis
      let mockMpdInfo: {
        url: string;
        representations: Array<{
          id: string;
          bandwidth: number;
        }>;
        segmentDuration?: number;
        timescale?: number;
        startNumber?: number;
        type: 'static' | 'dynamic';
        hasSCTE35?: boolean;
      } | undefined = undefined;

      if (template.bitrateLadder && template.bitrateLadder.length > 0) {
        mockMpdInfo = {
          url: template.sourceUrl || 'template://' + template.name,
          representations: template.bitrateLadder.map((bitrate: number, index: number) => ({
            id: `rep-${index}`,
            bandwidth: bitrate
          })),
          segmentDuration: template.segmentDuration / 1000, // Convert back to seconds
          timescale: template.timescale,
          startNumber: template.startNumber,
          type: 'dynamic' as const,
          hasSCTE35: template.hasSCTE35
        };
      }

      await startLivesim2({
        image: undefined,
        port: options.port || 8888,
        asset: template.asset,
        detach: options.detach !== false,
        name: nameArg,
        open: false,
        manifestUrl: template.sourceUrl, // Use template's source URL for preservation
        mpdInfo: mockMpdInfo, // Use stored template data instead of re-analyzing
        preserveManifest: !!template.sourceUrl, // Enable preservation if template has source URL
        faultProxy: true,
        faultConfigPath: undefined,
        faultProfile: undefined
      });
    } else if (simType === 'hls') {
      const { startHlsim } = await import('./support-tools/hls-sim-runner.js');
      await startHlsim({
        image: undefined,
        port: options.port || 8899,
        vodroot: undefined,
        source: template.hlsSource || 'samples/bbb.mp4', // Default HLS source
        detach: options.detach !== false,
        name: nameArg,
        open: false,
        noPull: true, // Don't try to pull potentially non-existent images
        forcePull: undefined,
        manifestUrl: undefined,
        proxy: true,
        dummyContent: true, // Use bundled sample content from /assets/hls-sample
        preserveManifest: false,
        authToken: undefined,
        authHeader: undefined,
        authFile: undefined,
        faultConfigPath: undefined,
        faultProfile: undefined
      });
    } else {
      throw new Error(`Unsupported simulator type: ${simType}. Use 'dash' or 'hls'.`);
    }

    // Display manifest if requested
    if (options.showManifest) {
      await displayManifestAfterStart(simType, options.port, template.asset);
    }
  } catch (error) {
    console.error('❌ Failed to start template stream:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
