# SystemSettingsResponseDto

## Properties

| Name                         | Type        | Description                                                         | Notes                  |
| ---------------------------- | ----------- | ------------------------------------------------------------------- | ---------------------- |
| **githubAppEnabled**         | **boolean** | Whether the GitHub App integration is configured and available      | [default to undefined] |
| **litellmManagementEnabled** | **boolean** | Whether the LiteLLM model management UI is enabled for the frontend | [default to undefined] |
| **isAdmin**                  | **boolean** | Whether the current user has the admin role                         | [default to undefined] |
| **githubWebhookEnabled**     | **boolean** | Whether the GitHub webhook receiver is configured and available     | [default to undefined] |
| **apiVersion**               | **string**  | Current API server version                                          | [default to undefined] |
| **webVersion**               | **string**  | Current web client version                                          | [default to undefined] |

## Example

```typescript
import { SystemSettingsResponseDto } from './api';

const instance: SystemSettingsResponseDto = {
  githubAppEnabled,
  litellmManagementEnabled,
  isAdmin,
  githubWebhookEnabled,
  apiVersion,
  webVersion,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
