# AgentMemoryApi

All URIs are relative to _http://localhost_

| Method                                            | HTTP request                                | Description |
| ------------------------------------------------- | ------------------------------------------- | ----------- |
| [**deleteMemoryEntry**](#deletememoryentry)       | **DELETE** /api/v1/memory/{namespace}/{key} |             |
| [**getMemoryEntry**](#getmemoryentry)             | **GET** /api/v1/memory/{namespace}/{key}    |             |
| [**listMemoryEntries**](#listmemoryentries)       | **GET** /api/v1/memory/{namespace}          |             |
| [**listMemoryNamespaces**](#listmemorynamespaces) | **GET** /api/v1/memory                      |             |
| [**saveMemoryEntry**](#savememoryentry)           | **PUT** /api/v1/memory                      |             |

# **deleteMemoryEntry**

> deleteMemoryEntry()

### Example

```typescript
import { AgentMemoryApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new AgentMemoryApi(configuration);

let namespace: string; // (default to undefined)
let key: string; // (default to undefined)

const { status, data } = await apiInstance.deleteMemoryEntry(namespace, key);
```

### Parameters

| Name          | Type         | Description | Notes                 |
| ------------- | ------------ | ----------- | --------------------- |
| **namespace** | [**string**] |             | defaults to undefined |
| **key**       | [**string**] |             | defaults to undefined |

### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **204**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getMemoryEntry**

> AgentMemoryEntryDto getMemoryEntry()

### Example

```typescript
import { AgentMemoryApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new AgentMemoryApi(configuration);

let namespace: string; // (default to undefined)
let key: string; // (default to undefined)

const { status, data } = await apiInstance.getMemoryEntry(namespace, key);
```

### Parameters

| Name          | Type         | Description | Notes                 |
| ------------- | ------------ | ----------- | --------------------- |
| **namespace** | [**string**] |             | defaults to undefined |
| **key**       | [**string**] |             | defaults to undefined |

### Return type

**AgentMemoryEntryDto**

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

# **listMemoryEntries**

> Array<AgentMemoryEntryDto> listMemoryEntries()

### Example

```typescript
import { AgentMemoryApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new AgentMemoryApi(configuration);

let namespace: string; // (default to undefined)
let limit: number; // (optional) (default to undefined)
let offset: number; // (optional) (default to undefined)

const { status, data } = await apiInstance.listMemoryEntries(
  namespace,
  limit,
  offset,
);
```

### Parameters

| Name          | Type         | Description | Notes                            |
| ------------- | ------------ | ----------- | -------------------------------- |
| **namespace** | [**string**] |             | defaults to undefined            |
| **limit**     | [**number**] |             | (optional) defaults to undefined |
| **offset**    | [**number**] |             | (optional) defaults to undefined |

### Return type

**Array<AgentMemoryEntryDto>**

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

# **listMemoryNamespaces**

> Array<NamespaceSummaryDto> listMemoryNamespaces()

### Example

```typescript
import { AgentMemoryApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new AgentMemoryApi(configuration);

const { status, data } = await apiInstance.listMemoryNamespaces();
```

### Parameters

This endpoint does not have any parameters.

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

# **saveMemoryEntry**

> AgentMemoryEntryDto saveMemoryEntry(saveEntryBodyDto)

### Example

```typescript
import { AgentMemoryApi, Configuration, SaveEntryBodyDto } from './api';

const configuration = new Configuration();
const apiInstance = new AgentMemoryApi(configuration);

let saveEntryBodyDto: SaveEntryBodyDto; //

const { status, data } = await apiInstance.saveMemoryEntry(saveEntryBodyDto);
```

### Parameters

| Name                 | Type                 | Description | Notes |
| -------------------- | -------------------- | ----------- | ----- |
| **saveEntryBodyDto** | **SaveEntryBodyDto** |             |       |

### Return type

**AgentMemoryEntryDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
