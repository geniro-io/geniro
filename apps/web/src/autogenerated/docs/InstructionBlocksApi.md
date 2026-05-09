# InstructionBlocksApi

All URIs are relative to _http://localhost_

| Method                                                  | HTTP request                            | Description |
| ------------------------------------------------------- | --------------------------------------- | ----------- |
| [**getInstructionBlockById**](#getinstructionblockbyid) | **GET** /api/v1/instruction-blocks/{id} |             |
| [**listInstructionBlocks**](#listinstructionblocks)     | **GET** /api/v1/instruction-blocks      |             |

# **getInstructionBlockById**

> InstructionBlockResponseDto getInstructionBlockById()

### Example

```typescript
import { InstructionBlocksApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new InstructionBlocksApi(configuration);

let id: string; // (default to undefined)

const { status, data } = await apiInstance.getInstructionBlockById(id);
```

### Parameters

| Name   | Type         | Description | Notes                 |
| ------ | ------------ | ----------- | --------------------- |
| **id** | [**string**] |             | defaults to undefined |

### Return type

**InstructionBlockResponseDto**

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

# **listInstructionBlocks**

> Array<InstructionBlockResponseDto> listInstructionBlocks()

### Example

```typescript
import { InstructionBlocksApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new InstructionBlocksApi(configuration);

const { status, data } = await apiInstance.listInstructionBlocks();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**Array<InstructionBlockResponseDto>**

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
