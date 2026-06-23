# SystemSettingsResponseDto

## Properties

| Name                         | Type        | Description                                                                                                                                                     | Notes                  |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **githubAppEnabled**         | **boolean** | Whether the GitHub App is configured (all GITHUB*APP*\* env vars set) — the literal App config, independent of the active auth mode                             | [default to undefined] |
| **githubAuthMode**           | **string**  | Deployment-wide GitHub auth mode: \&quot;github_app\&quot; uses the GitHub App, \&quot;pat\&quot; uses a configured personal access token instead               | [default to undefined] |
| **githubAvailable**          | **boolean** | Whether GitHub operations are available in this deployment — App configured (app mode) or a PAT configured (pat mode)                                           | [default to undefined] |
| **githubAppInstallable**     | **boolean** | Whether the GitHub App install/authorize UI should be shown — true only in app mode with the App configured; false in pat mode (configured-but-not-installable) | [default to undefined] |
| **litellmManagementEnabled** | **boolean** | Whether the LiteLLM model management UI is enabled for the frontend                                                                                             | [default to undefined] |
| **isAdmin**                  | **boolean** | Whether the current user has the admin role                                                                                                                     | [default to undefined] |
| **githubWebhookEnabled**     | **boolean** | Whether the GitHub webhook receiver is configured and available                                                                                                 | [default to undefined] |
| **apiVersion**               | **string**  | Current API server version                                                                                                                                      | [default to undefined] |
| **webVersion**               | **string**  | Current web client version                                                                                                                                      | [default to undefined] |

## Example

```typescript
import { SystemSettingsResponseDto } from './api';

const instance: SystemSettingsResponseDto = {
  githubAppEnabled,
  githubAuthMode,
  githubAvailable,
  githubAppInstallable,
  litellmManagementEnabled,
  isAdmin,
  githubWebhookEnabled,
  apiVersion,
  webVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
