# ThreadStoreApi

All URIs are relative to _http://localhost_

| Method                                | HTTP request                                               | Description |
| ------------------------------------- | ---------------------------------------------------------- | ----------- |
| [**getEntry**](#getentry)             | **GET** /api/v1/threads/{threadId}/store/{namespace}/{key} |             |
| [**listEntries**](#listentries)       | **GET** /api/v1/threads/{threadId}/store/{namespace}       |             |
| [**listNamespaces**](#listnamespaces) | **GET** /api/v1/threads/{threadId}/store                   |             |

# **getEntry**

> ThreadStoreEntryDto getEntry()

### Example

```typescript
import { ThreadStoreApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new ThreadStoreApi(configuration);

let threadId: string; // (default to undefined)
let namespace: string; // (default to undefined)
let key: string; // (default to undefined)

const { status, data } = await apiInstance.getEntry(threadId, namespace, key);
```

### Parameters

| Name          | Type         | Description | Notes                 |
| ------------- | ------------ | ----------- | --------------------- |
| **threadId**  | [**string**] |             | defaults to undefined |
| **namespace** | [**string**] |             | defaults to undefined |
| **key**       | [**string**] |             | defaults to undefined |

### Return type

**ThreadStoreEntryDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listEntries**

> Array<ThreadStoreEntryDto> listEntries()

### Example

```typescript
import { ThreadStoreApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new ThreadStoreApi(configuration);

let threadId: string; // (default to undefined)
let namespace: string; // (default to undefined)
let limit: number; // (optional) (default to undefined)
let offset: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.listEntries(
  threadId,
  namespace,
  limit,
  offset,
);
```

### Parameters

| Name          | Type         | Description | Notes                            |
| ------------- | ------------ | ----------- | -------------------------------- |
| **threadId**  | [**string**] |             | defaults to undefined            |
| **namespace** | [**string**] |             | defaults to undefined            |
| **limit**     | [**number**] |             | (optional) defaults to undefined |
| **offset**    | [**number**] |             | (optional) defaults to undefined |

### Return type

**Array<ThreadStoreEntryDto>**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listNamespaces**

> Array<NamespaceSummaryDto> listNamespaces()

### Example

```typescript
import { ThreadStoreApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new ThreadStoreApi(configuration);

let threadId: string; // (default to undefined)

const { status, data } = await apiInstance.listNamespaces(threadId);
```

### Parameters

| Name         | Type         | Description | Notes                 |
| ------------ | ------------ | ----------- | --------------------- |
| **threadId** | [**string**] |             | defaults to undefined |

### Return type

**Array<NamespaceSummaryDto>**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
