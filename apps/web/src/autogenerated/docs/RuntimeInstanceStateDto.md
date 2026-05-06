# RuntimeInstanceStateDto

## Properties

| Name              | Type       | Description                      | Notes                  |
| ----------------- | ---------- | -------------------------------- | ---------------------- |
| **id**            | **string** | Runtime instance ID              | [default to undefined] |
| **status**        | **string** | Current runtime lifecycle status | [default to undefined] |
| **startingPhase** | **string** |                                  | [default to undefined] |
| **errorCode**     | **string** |                                  | [default to undefined] |
| **lastError**     | **string** |                                  | [default to undefined] |
| **lastUsedAt**    | **string** | Last used timestamp              | [default to undefined] |
| **updatedAt**     | **string** | Last update timestamp            | [default to undefined] |

## Example

```typescript
import { RuntimeInstanceStateDto } from './api';

const instance: RuntimeInstanceStateDto = {
  id,
  status,
  startingPhase,
  errorCode,
  lastError,
  lastUsedAt,
  updatedAt,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
