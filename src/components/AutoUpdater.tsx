import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersion, getMaxVersion, shouldSkipVersion } from '../utils/autoUpdater.js';
import { logForDebugging } from '../utils/debug.js';
import { localInstallationExists } from '../utils/localInstaller.js';
import { gt, gte } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function AutoUpdater({
  isUpdating,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    global?: string | null;
    latest?: string | null;
  }>({});
  const [hasLocalInstall, setHasLocalInstall] = useState(false);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  useEffect(() => {
    void localInstallationExists().then(setHasLocalInstall);
  }, []);

  // Skip the npm check while a manual update is in progress.
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      logForDebugging('AutoUpdater: Skipping update check in test/dev environment');
      return;
    }
    const currentVersion = MACRO.VERSION;
    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';
    let latestVersion = await getLatestVersion(channel);

    // Check if max version is set (server-side kill switch for auto-updates)
    const maxVersion = await getMaxVersion();
    if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
      logForDebugging(`AutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latestVersion} to ${maxVersion}`);
      if (gte(currentVersion, maxVersion)) {
        logForDebugging(`AutoUpdater: current version ${currentVersion} is already at or above maxVersion ${maxVersion}, skipping update`);
        setVersions({
          global: currentVersion,
          latest: latestVersion
        });
        return;
      }
      latestVersion = maxVersion;
    }
    setVersions({
      global: currentVersion,
      latest: latestVersion
    });

  // Never auto-install: only notify the user when a newer npm version exists.
  // The user updates manually via /update or npm.
  if (currentVersion && latestVersion && !gte(currentVersion, latestVersion) && !shouldSkipVersion(latestVersion)) {
    logEvent('tengu_update_notification_shown', {
      fromVersion: currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toVersion: latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: no reactive deps
}, []);

  // Initial check
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);
  const updateAvailable = !!versions.global && !!versions.latest && !gte(versions.global, versions.latest);
  if (!autoUpdaterResult?.version && !isUpdating && !updateAvailable) {
    return null;
  }
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          globalVersion: {versions.global} &middot; latestVersion:{' '}
          {versions.latest}
        </Text>}
      {isUpdating ? <>
          <Box>
            <Text color="text" dimColor wrap="truncate">
              Auto-updating…
            </Text>
          </Box>
        </> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            ✓ Update installed · Restart to apply
          </Text>}
      {!isUpdating && !autoUpdaterResult && updateAvailable && <Text color="warning" wrap="truncate">
          Update available: {versions.global} → {versions.latest} · Run <Text bold>/update</Text> or{' '}
          <Text bold>{`npm install -g ${MACRO.PACKAGE_URL}@latest`}</Text>
        </Text>}
      {(autoUpdaterResult?.status === 'install_failed' || autoUpdaterResult?.status === 'no_permissions') && <Text color="error" wrap="truncate">
          ✗ Auto-update failed &middot; Try <Text bold>openclaude doctor</Text> or{' '}
          <Text bold>
            {hasLocalInstall ? `cd ~/.openclaude/local && npm update ${MACRO.PACKAGE_URL}` : `npm i -g ${MACRO.PACKAGE_URL}@latest`}
          </Text>
        </Text>}
    </Box>;
}
