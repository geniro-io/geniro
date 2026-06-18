# OauthApi

All URIs are relative to _http://localhost_

| Method                    | HTTP request                                | Description |
| ------------------------- | ------------------------------------------- | ----------- |
| [**exchange**](#exchange) | **POST** /api/v1/oauth/credentials/exchange |             |
| [**start**](#start)       | **GET** /api/v1/oauth/{provider}/start      |             |
| [**status**](#status)     | **GET** /api/v1/oauth/{provider}/status     |             |

# **exchange**

> OAuthExchangeResponseDto exchange(oAuthExchangeRequestDto)

### Example

```typescript
import { OauthApi, Configuration, OAuthExchangeRequestDto } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let oAuthExchangeRequestDto: OAuthExchangeRequestDto; //

const { status, data } = await apiInstance.exchange(oAuthExchangeRequestDto);
```

### Parameters

| Name                        | Type                        | Description | Notes |
| --------------------------- | --------------------------- | ----------- | ----- |
| **oAuthExchangeRequestDto** | **OAuthExchangeRequestDto** |             |       |

### Return type

**OAuthExchangeResponseDto**

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

# **start**

> OAuthStartResponseDto start()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let provider: 'linear'; // (default to undefined)
let graphId: string; // (optional) (default to undefined)
let nodeId: string; // (optional) (default to undefined)

const { status, data } = await apiInstance.start(provider, graphId, nodeId);
```

### Parameters

| Name         | Type                                              | Description | Notes                            |
| ------------ | ------------------------------------------------- | ----------- | -------------------------------- |
| **provider** | [**&#39;linear&#39;**]**Array<&#39;linear&#39;>** |             | defaults to undefined            |
| **graphId**  | [**string**]                                      |             | (optional) defaults to undefined |
| **nodeId**   | [**string**]                                      |             | (optional) defaults to undefined |

### Return type

**OAuthStartResponseDto**

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

# **status**

> OAuthStatusResponseDto status()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let provider: 'linear'; // (default to undefined)

const { status, data } = await apiInstance.status(provider);
```

### Parameters

| Name         | Type                                              | Description | Notes                 |
| ------------ | ------------------------------------------------- | ----------- | --------------------- |
| **provider** | [**&#39;linear&#39;**]**Array<&#39;linear&#39;>** |             | defaults to undefined |

### Return type

**OAuthStatusResponseDto**

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
