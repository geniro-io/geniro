# OAuthStatusResponseDto

## Properties

| Name              | Type        | Description                                                   | Notes                  |
| ----------------- | ----------- | ------------------------------------------------------------- | ---------------------- |
| **provider**      | **string**  |                                                               | [default to undefined] |
| **authenticated** | **boolean** | Whether a valid credential exists for this project + provider | [default to undefined] |
| **accountLabel**  | **string**  |                                                               | [default to undefined] |
| **secretName**    | **string**  |                                                               | [default to undefined] |
| **expiresAt**     | **string**  |                                                               | [default to undefined] |

## Example

```typescript
import { OAuthStatusResponseDto } from './api';

const instance: OAuthStatusResponseDto = {
  provider,
  authenticated,
  accountLabel,
  secretName,
  expiresAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
