/**
 * Permission API Factory
 *
 * Creates platform-specific permission API implementations based on platform type.
 * This isolates platform selection logic to the platform layer.
 */

import type { PermissionApi, MattermostPermissionApiConfig, SlackPermissionApiConfig } from './permission-api.js';
import { createMattermostPermissionApi } from './mattermost/permission-api.js';
import { createSlackPermissionApi } from './slack/permission-api.js';

/**
 * Create a permission API instance for the specified platform type
 *
 * @param platformType - The platform type ('mattermost' or 'slack')
 * @param config - Platform-specific configuration object
 */
export function createPermissionApi(
  platformType: string,
  config: MattermostPermissionApiConfig | SlackPermissionApiConfig
): PermissionApi {
  switch (platformType) {
    case 'mattermost':
      return createMattermostPermissionApi(config as MattermostPermissionApiConfig);
    case 'slack':
      return createSlackPermissionApi(config as SlackPermissionApiConfig);
    default:
      throw new Error(`Unsupported platform type: ${platformType}`);
  }
}
