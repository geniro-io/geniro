import { useCallback, useEffect, useState } from 'react';

import {
  systemSettingsApi,
  type SystemSettingsDto,
} from '../pages/github-app/types';

export type SystemSettings = SystemSettingsDto;

const DEFAULT_SETTINGS: SystemSettings = {
  githubAppEnabled: false,
  githubWebhookEnabled: false,
  litellmManagementEnabled: false,
  isAdmin: false,
  apiVersion: '',
  webVersion: '',
};

let cachedSettings: SystemSettings | null = null;

export const useSystemSettings = () => {
  const [settings, setSettings] = useState<SystemSettings>(
    cachedSettings ?? DEFAULT_SETTINGS,
  );
  const [loading, setLoading] = useState(!cachedSettings);

  const fetchSettings = useCallback(async () => {
    try {
      const response = await systemSettingsApi.getSettings();
      cachedSettings = response.data;
      setSettings(response.data);
    } catch (error) {
      console.warn('Failed to fetch system settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cachedSettings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot fetch on mount
      fetchSettings();
    }
  }, [fetchSettings]);

  return { settings, loading };
};
