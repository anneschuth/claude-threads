/**
 * Standalone script to start the Slack mock server
 *
 * Usage:
 *   SLACK_MOCK_PORT=3457 bun run tests/integration/fixtures/slack/start-mock-server.ts
 *
 * The server will run until the process is terminated.
 */

import { SlackMockServer } from './mock-server.js';

const port = parseInt(process.env.SLACK_MOCK_PORT || '3457', 10);
const debug = process.env.DEBUG === '1';

const server = new SlackMockServer({ port, debug });

async function main() {
  await server.start();
  console.log(`Slack mock server started on port ${port}`);
  console.log(`  API URL: ${server.getUrl()}`);
  console.log(`  WebSocket URL: ${server.getWsUrl()}`);
  console.log(`  Bot Token: ${server.getBotToken()}`);
  console.log(`  App Token: ${server.getAppToken()}`);
  console.log(`  Channel ID: ${server.getChannelId()}`);
  console.log('\nPress Ctrl+C to stop the server...');

  // Keep the process running
  process.on('SIGINT', async () => {
    console.log('\nShutting down Slack mock server...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down Slack mock server...');
    await server.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start Slack mock server:', error);
  process.exit(1);
});
